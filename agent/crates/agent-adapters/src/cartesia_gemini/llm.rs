use std::{
    collections::{BTreeSet, VecDeque},
    fmt,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, RETRY_AFTER};
use serde_json::{json, Value};
use tokio::time::timeout;

use agent_domain::{
    AnswerEvaluator, BrainError, BrainFailureClass, BrainFailureStage, BrainProviderFailure,
    BrainProviderFailureParts, CriterionAssessment, EvaluationDecision, EvaluationError,
    EvaluationRequest, ToolResult,
};

use super::constants::{
    DEFAULT_GEMINI_BASE_URL, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_THINKING_LEVEL,
};
use super::{
    brain_failure, provider_diagnostic_metadata, ProviderDiagnostic, ProviderDiagnosticCode,
    ProviderStageLabel, MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES,
};

const TRUSTED_SOURCE_CONTEXT_FUNCTION: &str = "trusted_source_context";
const DEFAULT_GEMINI_RETRY_AFTER_MS: u64 = 1_000;
const MAX_GEMINI_ERROR_BODY_BYTES: usize = 16 * 1024;
/// The largest single SSE record the incremental decoder will hold. A provider
/// that never closes a record cannot make the adapter buffer without bound.
const MAX_GEMINI_SSE_EVENT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
}

impl ThinkingLevel {
    pub fn parse(value: impl AsRef<str>) -> Option<Self> {
        match value.as_ref().trim().to_ascii_uppercase().as_str() {
            "MINIMAL" => Some(Self::Minimal),
            "LOW" => Some(Self::Low),
            "MEDIUM" => Some(Self::Medium),
            "HIGH" => Some(Self::High),
            _ => None,
        }
    }

    pub fn as_api_str(&self) -> &'static str {
        match self {
            Self::Minimal => "MINIMAL",
            Self::Low => "LOW",
            Self::Medium => "MEDIUM",
            Self::High => "HIGH",
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct GeminiConfig {
    pub api_key: String,
    pub model_id: String,
    pub fallback_model_ids: Vec<String>,
    pub base_url: String,
    pub thinking_level: Option<ThinkingLevel>,
    pub system_instruction: String,
    pub stage_timeout: Duration,
}

impl fmt::Debug for GeminiConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeminiConfig")
            .field("api_key", &"<redacted>")
            .field("model_id", &self.model_id)
            .field("fallback_model_ids", &self.fallback_model_ids)
            .field("base_url", &self.base_url)
            .field("thinking_level", &self.thinking_level)
            .field("system_instruction", &self.system_instruction)
            .field("stage_timeout", &self.stage_timeout)
            .finish()
    }
}

impl Default for GeminiConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            model_id: DEFAULT_GEMINI_MODEL.to_owned(),
            fallback_model_ids: Vec::new(),
            base_url: DEFAULT_GEMINI_BASE_URL.to_owned(),
            thinking_level: ThinkingLevel::parse(DEFAULT_GEMINI_THINKING_LEVEL),
            system_instruction: viva_system_instruction(),
            stage_timeout: Duration::from_secs(9),
        }
    }
}

impl GeminiConfig {
    pub fn stream_url(&self) -> String {
        format!(
            "{}/{}:streamGenerateContent?alt=sse",
            self.base_url.trim_end_matches('/'),
            self.model_id
        )
    }

    pub fn supports_thinking_config(&self) -> bool {
        self.model_id.starts_with("gemini-3") || self.model_id.contains("/gemini-3")
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GeminiConversation {
    contents: Vec<Value>,
}

impl GeminiConversation {
    pub fn snapshot(&self) -> Vec<Value> {
        self.contents.clone()
    }

    pub fn push_user_text(&mut self, text: impl Into<String>) {
        self.contents.push(json!({
            "role": "user",
            "parts": [{ "text": text.into() }],
        }));
    }

    pub fn push_user_text_with_source_context(&mut self, text: impl Into<String>, context: Value) {
        let call_id = format!("trusted-source-context-{}", self.contents.len());
        self.contents.push(json!({
            "role": "model",
            "parts": [{
                "functionCall": {
                    "id": call_id,
                    "name": TRUSTED_SOURCE_CONTEXT_FUNCTION,
                    "args": {},
                }
            }],
        }));
        self.contents.push(json!({
            "role": "user",
            "parts": [{
                "functionResponse": {
                    "id": call_id,
                    "name": TRUSTED_SOURCE_CONTEXT_FUNCTION,
                    "response": context,
                }
            }],
        }));
        self.push_user_text(text);
    }

    pub fn push_model_text(&mut self, text: impl Into<String>) {
        let text = text.into();
        if text.trim().is_empty() {
            return;
        }
        self.contents.push(json!({
            "role": "model",
            "parts": [{ "text": text }],
        }));
    }

    pub fn push_function_response(&mut self, result: &ToolResult) {
        let mut function_response = serde_json::Map::new();
        if let Some(call_id) = result.proposal.call_id() {
            function_response.insert("id".to_owned(), Value::String(call_id.to_owned()));
        }
        function_response.insert(
            "name".to_owned(),
            Value::String(result.proposal.name().to_owned()),
        );
        function_response.insert("response".to_owned(), json!({ "result": result.result }));
        self.contents.push(json!({
            "role": "user",
            "parts": [{
                "functionResponse": Value::Object(function_response),
            }],
        }));
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GeminiStreamEvent {
    ModelPart {
        text: Option<String>,
        part: Value,
    },
    FunctionCall {
        id: String,
        name: String,
        args: Value,
        part: Value,
    },
    Error(#[allow(dead_code)] String),
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    FallbackActivated {
        from_model: String,
        to_model: String,
        reason: String,
        failure: Option<BrainProviderFailure>,
    },
}

#[derive(Debug)]
pub(crate) struct GeminiStreamAttemptFailure {
    pub(crate) events: Vec<GeminiStreamEvent>,
    pub(crate) error: BrainError,
}

pub(crate) struct GeminiStreamRequest {
    pub(crate) url: String,
    pub(crate) api_key: String,
    pub(crate) body: Value,
}

impl GeminiStreamRequest {
    fn new(config: &GeminiConfig, body: Value) -> Result<Self, BrainError> {
        let api_key = config.api_key.trim();
        if api_key.is_empty() {
            return Err(gemini_stage_failure(
                config,
                BrainFailureClass::ProviderAuthFailure,
                BrainFailureStage::ProviderAuth,
                false,
                Duration::ZERO,
                "error_kind=missing_api_key",
            ));
        }

        Ok(Self {
            url: config.stream_url(),
            api_key: api_key.to_owned(),
            body,
        })
    }
}

/// The success path's body: bytes as the provider produces them, never a
/// buffered `String`.
pub(crate) type GeminiByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, ()>> + Send>>;

/// The decoded provider events, delivered as each SSE record completes.
pub(crate) type GeminiEventStream =
    Pin<Box<dyn Stream<Item = Result<GeminiStreamEvent, BrainError>> + Send>>;

/// `ADAPTER-05`: a 2xx body is a stream. Only a non-2xx error body is read into
/// memory, and only within [`MAX_GEMINI_ERROR_BODY_BYTES`].
pub(crate) enum GeminiResponseBody {
    Bounded(String),
    Stream(GeminiByteStream),
}

impl GeminiResponseBody {
    /// The already-read error body, or an empty string for a streaming body.
    /// Diagnostics only ever inspect bounded error bodies.
    fn bounded(&self) -> &str {
        match self {
            Self::Bounded(body) => body.as_str(),
            Self::Stream(_) => "",
        }
    }
}

impl fmt::Debug for GeminiResponseBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bounded(_) => formatter.write_str("GeminiResponseBody::Bounded(<redacted>)"),
            Self::Stream(_) => formatter.write_str("GeminiResponseBody::Stream"),
        }
    }
}

#[derive(Debug)]
pub(crate) struct GeminiSseResponse {
    pub(crate) status: u16,
    pub(crate) body: GeminiResponseBody,
    pub(crate) retry_after: Option<String>,
    pub(crate) reset_after: Option<String>,
}

impl GeminiSseResponse {
    #[cfg(test)]
    pub(crate) fn ok(body: String) -> Self {
        Self {
            status: 200,
            body: GeminiResponseBody::Stream(Box::pin(futures_util::stream::once(async move {
                Ok(Bytes::from(body.into_bytes()))
            }))),
            retry_after: None,
            reset_after: None,
        }
    }
}

/// A bounded incremental SSE decoder.
///
/// Records end at a blank line; CRLF and LF boundaries are both accepted. An
/// incomplete record — including an incomplete UTF-8 sequence, which can never
/// contain a record separator — is preserved across chunk boundaries.
#[derive(Default)]
struct GeminiSseDecoder {
    buffer: Vec<u8>,
}

impl GeminiSseDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<(), ()> {
        if self.buffer.len().saturating_add(chunk.len()) > MAX_GEMINI_SSE_EVENT_BYTES {
            return Err(());
        }
        self.buffer.extend_from_slice(chunk);
        Ok(())
    }

    fn next_record(&mut self) -> Option<String> {
        let (end, separator) = self.record_boundary()?;
        let record = self.buffer.drain(..end + separator).collect::<Vec<_>>();
        Some(String::from_utf8_lossy(&record[..end]).into_owned())
    }

    fn record_boundary(&self) -> Option<(usize, usize)> {
        for (index, byte) in self.buffer.iter().enumerate() {
            if *byte != b'\r' && *byte != b'\n' {
                continue;
            }
            if self.buffer[index..].starts_with(b"\r\n\r\n") {
                return Some((index, 4));
            }
            if self.buffer[index..].starts_with(b"\n\n") {
                return Some((index, 2));
            }
        }
        None
    }

    /// Whatever a provider left unterminated when the body ended.
    fn finish(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let record = std::mem::take(&mut self.buffer);
        Some(String::from_utf8_lossy(&record).into_owned())
    }
}

#[async_trait]
pub(crate) trait GeminiSseClient: Send + Sync {
    async fn stream(&self, request: GeminiStreamRequest) -> Result<GeminiSseResponse, BrainError>;
}

#[cfg(test)]
pub(crate) async fn stream_gemini_with_client<C>(
    client: &C,
    config: &GeminiConfig,
    request: Value,
) -> Result<Vec<GeminiStreamEvent>, BrainError>
where
    C: GeminiSseClient,
{
    stream_gemini_attempt_events_collected(client, config, request)
        .await
        .map_err(|failure| failure.error)
}

/// Drain the incremental stream into the whole-response shape the pre-streaming
/// characterization tests were written against.
///
/// A failure the provider only reveals part-way through the body arrives here
/// with the events that preceded it, exactly as an up-front failure used to.
#[cfg(test)]
pub(crate) async fn stream_gemini_attempt_events_collected<C>(
    client: &C,
    config: &GeminiConfig,
    request: Value,
) -> Result<Vec<GeminiStreamEvent>, GeminiStreamAttemptFailure>
where
    C: GeminiSseClient,
{
    let mut stream = stream_gemini_with_client_attempt_events(client, config, request).await?;
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(event) => events.push(event),
            Err(error) => return Err(GeminiStreamAttemptFailure { events, error }),
        }
    }
    Ok(events)
}

/// Stream one Gemini generation, with the bounded primary/fallback policy.
///
/// `ADAPTER-05`: the returned stream yields each parsed event as its SSE record
/// completes. Fallback activations that happened before the successful attempt
/// are delivered first, so a consumer sees the same order it always did without
/// the body ever being buffered.
pub(crate) async fn stream_gemini_with_client_attempt_events<C>(
    client: &C,
    config: &GeminiConfig,
    request: Value,
) -> Result<GeminiEventStream, GeminiStreamAttemptFailure>
where
    C: GeminiSseClient,
{
    let attempts = gemini_stream_attempts(config);
    let mut attempt_events = Vec::new();
    let stage_deadline = Instant::now() + config.stage_timeout;
    for (index, attempt_config) in attempts.iter().enumerate() {
        let remaining = match stage_deadline.checked_duration_since(Instant::now()) {
            Some(remaining) => remaining,
            None if index > 0 => {
                return Err(gemini_attempt_failure(
                    &attempt_events,
                    gemini_timeout_stage_failure(attempt_config, config.stage_timeout),
                ));
            }
            None => {
                return Err(gemini_attempt_failure(
                    &attempt_events,
                    gemini_generation_stage_timeout(attempt_config),
                ));
            }
        };
        let stream_request = GeminiStreamRequest::new(
            attempt_config,
            gemini_attempt_request(attempt_config, &request),
        )
        .map_err(|error| gemini_attempt_failure(&attempt_events, error))?;
        let started = Instant::now();
        let response = match timeout(remaining, client.stream(stream_request)).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) if index > 0 => {
                return Err(gemini_attempt_failure(
                    &attempt_events,
                    gemini_transport_stage_failure(attempt_config, &error, started.elapsed()),
                ))
            }
            Ok(Err(error)) => {
                return Err(gemini_attempt_failure(
                    &attempt_events,
                    sanitize_gemini_stream_error(error),
                ))
            }
            Err(_) if index > 0 => {
                return Err(gemini_attempt_failure(
                    &attempt_events,
                    gemini_timeout_stage_failure(attempt_config, remaining),
                ))
            }
            Err(_) => {
                return Err(gemini_attempt_failure(
                    &attempt_events,
                    gemini_generation_stage_timeout(attempt_config),
                ))
            }
        };
        if response.status == 429 {
            let error =
                gemini_rate_limit_stage_failure(attempt_config, &response, started.elapsed());
            if index + 1 < attempts.len() {
                let next_attempt = &attempts[index + 1];
                attempt_events.push(GeminiStreamEvent::FallbackActivated {
                    from_model: attempt_config.model_id.clone(),
                    to_model: next_attempt.model_id.clone(),
                    reason: if index == 0 {
                        "primary_429".to_owned()
                    } else {
                        "fallback_429".to_owned()
                    },
                    failure: brain_provider_failure(&error),
                });
                continue;
            }
            return Err(gemini_attempt_failure(&attempt_events, error));
        }
        if !(200..300).contains(&response.status) {
            if index > 0 {
                return Err(gemini_attempt_failure(
                    &attempt_events,
                    gemini_status_stage_failure(attempt_config, &response, started.elapsed()),
                ));
            }
            return Err(gemini_attempt_failure(
                &attempt_events,
                sanitized_gemini_http_status_error(attempt_config, response.status),
            ));
        }
        // A body that yields no event at all is only knowable at EOF, so the
        // empty-stream classification lives inside the stream itself.
        return Ok(gemini_event_stream(GeminiStreamState {
            prelude: attempt_events.into_iter().collect(),
            body: match response.body {
                GeminiResponseBody::Stream(body) => Some(body),
                GeminiResponseBody::Bounded(_) => None,
            },
            decoder: GeminiSseDecoder::default(),
            pending: VecDeque::new(),
            produced: false,
            body_done: false,
            finished: false,
            config: attempt_config.clone(),
            started,
        }));
    }
    // Every attempt returns or continues, and the primary attempt always
    // exists, so the loop cannot fall through with attempts remaining.
    Err(gemini_attempt_failure(
        &attempt_events,
        gemini_stage_failure(
            config,
            BrainFailureClass::MalformedStream,
            BrainFailureStage::Gemini,
            false,
            Duration::ZERO,
            "error_kind=no_configured_model_attempts",
        ),
    ))
}

struct GeminiStreamState {
    prelude: VecDeque<GeminiStreamEvent>,
    body: Option<GeminiByteStream>,
    decoder: GeminiSseDecoder,
    pending: VecDeque<GeminiStreamEvent>,
    produced: bool,
    body_done: bool,
    finished: bool,
    config: GeminiConfig,
    started: Instant,
}

fn gemini_event_stream(state: GeminiStreamState) -> GeminiEventStream {
    Box::pin(futures_util::stream::unfold(
        state,
        |mut state| async move {
            loop {
                if state.finished {
                    return None;
                }
                if let Some(event) = state.prelude.pop_front() {
                    return Some((Ok(event), state));
                }
                if let Some(event) = state.pending.pop_front() {
                    state.produced = true;
                    return Some((Ok(event), state));
                }
                if state.body_done {
                    state.finished = true;
                    if !state.produced {
                        let failure = gemini_empty_stream_stage_failure(
                            &state.config,
                            state.started.elapsed(),
                        );
                        return Some((Err(failure), state));
                    }
                    return None;
                }
                let Some(body) = state.body.as_mut() else {
                    state.body_done = true;
                    continue;
                };
                match body.next().await {
                    Some(Ok(chunk)) => {
                        if state.decoder.push(&chunk).is_err() {
                            state.finished = true;
                            let failure = gemini_stage_failure(
                                &state.config,
                                BrainFailureClass::MalformedStream,
                                BrainFailureStage::Gemini,
                                false,
                                state.started.elapsed(),
                                "error_kind=sse_event_too_large",
                            );
                            return Some((Err(failure), state));
                        }
                        while let Some(record) = state.decoder.next_record() {
                            state.pending.extend(parse_gemini_sse_stream(&record));
                        }
                    }
                    Some(Err(())) => {
                        state.finished = true;
                        let failure =
                            gemini_body_read_failure(&state.config, state.started.elapsed());
                        return Some((Err(failure), state));
                    }
                    None => {
                        state.body = None;
                        if let Some(record) = state.decoder.finish() {
                            state.pending.extend(parse_gemini_sse_stream(&record));
                        }
                        state.body_done = true;
                    }
                }
            }
        },
    ))
}

fn gemini_body_read_failure(config: &GeminiConfig, latency: Duration) -> BrainError {
    gemini_stage_failure(
        config,
        BrainFailureClass::NetworkDisconnect,
        BrainFailureStage::Transport,
        true,
        latency,
        "error_kind=response_read_failed",
    )
}

fn gemini_attempt_failure(
    events: &[GeminiStreamEvent],
    error: BrainError,
) -> GeminiStreamAttemptFailure {
    GeminiStreamAttemptFailure {
        events: events.to_vec(),
        error,
    }
}

fn brain_provider_failure(error: &BrainError) -> Option<BrainProviderFailure> {
    Some(error.failure().clone())
}

fn gemini_generation_stage_timeout(config: &GeminiConfig) -> BrainError {
    gemini_stage_failure(
        config,
        BrainFailureClass::Timeout,
        BrainFailureStage::Gemini,
        true,
        Duration::ZERO,
        "error_kind=generation_stage_timeout",
    )
}

fn gemini_attempt_request(config: &GeminiConfig, request: &Value) -> Value {
    let mut request = request.clone();
    if let Some(thinking_level) = &config.thinking_level {
        if config.supports_thinking_config() {
            upsert_gemini_thinking_config(&mut request, thinking_level);
            return request;
        }
    }
    remove_gemini_thinking_config(&mut request);
    request
}

fn upsert_gemini_thinking_config(request: &mut Value, thinking_level: &ThinkingLevel) {
    let Some(request_object) = request.as_object_mut() else {
        return;
    };
    let generation_config = request_object
        .entry("generationConfig".to_owned())
        .or_insert_with(|| json!({}));
    if !generation_config.is_object() {
        *generation_config = json!({});
    }
    if let Some(generation_config) = generation_config.as_object_mut() {
        generation_config.insert(
            "thinkingConfig".to_owned(),
            json!({
                "thinkingLevel": thinking_level.as_api_str(),
            }),
        );
    }
}

fn remove_gemini_thinking_config(request: &mut Value) {
    let Some(generation_config) = request
        .get_mut("generationConfig")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    generation_config.remove("thinkingConfig");
    if generation_config.is_empty() {
        request
            .as_object_mut()
            .map(|object| object.remove("generationConfig"));
    }
}

fn gemini_stream_attempts(config: &GeminiConfig) -> Vec<GeminiConfig> {
    let mut attempts = Vec::with_capacity(config.fallback_model_ids.len() + 1);
    attempts.push(config.clone());
    for model_id in &config.fallback_model_ids {
        let mut fallback = config.clone();
        fallback.model_id = model_id.clone();
        fallback.fallback_model_ids.clear();
        attempts.push(fallback);
    }
    attempts
}

/// The transport already classified what it observed, so the primary attempt
/// keeps that classification instead of re-deriving one from a message. Plan 06
/// removed the untyped variants this used to parse.
fn sanitize_gemini_stream_error(error: BrainError) -> BrainError {
    error
}

fn sanitized_gemini_http_status_error(config: &GeminiConfig, status: u16) -> BrainError {
    gemini_status_stage_failure(
        config,
        &GeminiSseResponse {
            status,
            body: GeminiResponseBody::Bounded(String::new()),
            retry_after: None,
            reset_after: None,
        },
        Duration::ZERO,
    )
}

pub(crate) async fn stream_gemini_http_with_attempt_events(
    client: &ReqwestGeminiSseClient,
    config: &GeminiConfig,
    request: Value,
) -> Result<GeminiEventStream, GeminiStreamAttemptFailure> {
    stream_gemini_with_client_attempt_events(client, config, request).await
}

/// The HTTP client every Gemini call in one process shares.
///
/// `ADAPTER-04`: `reqwest::Client` owns the connection pool, so constructing one
/// per call discards every keep-alive connection. The pool is built once and
/// handed to both the streaming tool loop and the provider-backed evaluator.
#[derive(Clone, Debug, Default)]
pub(crate) struct ReqwestGeminiSseClient {
    client: reqwest::Client,
}

impl ReqwestGeminiSseClient {
    /// One shared pool. There is deliberately no per-call constructor.
    pub(crate) fn shared() -> Self {
        Self::default()
    }
}

#[async_trait]
impl GeminiSseClient for ReqwestGeminiSseClient {
    async fn stream(&self, request: GeminiStreamRequest) -> Result<GeminiSseResponse, BrainError> {
        // An unusable credential is a provider-auth failure at the auth stage:
        // it is never retried as a transport blip, and no key byte travels.
        let api_key = HeaderValue::from_str(&request.api_key).map_err(|_| {
            brain_failure(BrainProviderFailureParts {
                failure_class: BrainFailureClass::ProviderAuthFailure,
                stage: BrainFailureStage::ProviderAuth,
                retry_eligible: false,
                latency_ms: 0,
                provider: "gemini".to_owned(),
                model: "gemini".to_owned(),
                metadata: gemini_stage_metadata("error_kind=invalid_api_key_header"),
            })
        })?;
        let response = self
            .client
            .post(&request.url)
            .header("x-goog-api-key", api_key)
            .header(CONTENT_TYPE, "application/json")
            .json(&request.body)
            .send()
            .await
            .map_err(|_| gemini_client_failure("error_kind=request_failed"))?;
        let status = response.status().as_u16();
        let retry_after = header_value(response.headers(), RETRY_AFTER.as_str());
        let reset_after = reset_header_value(response.headers());
        let body = gemini_response_body(status, response).await;
        gemini_sse_response_from_http_parts(status, retry_after, reset_after, body)
    }
}

fn gemini_client_failure(metadata: &'static str) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class: BrainFailureClass::NetworkDisconnect,
        stage: BrainFailureStage::Transport,
        retry_eligible: true,
        latency_ms: 0,
        provider: "gemini".to_owned(),
        model: "gemini".to_owned(),
        metadata: gemini_stage_metadata(metadata),
    })
}

/// `ADAPTER-05`: a success body becomes a byte stream and is never buffered; a
/// non-2xx error body stays bounded so its diagnostics can be classified.
async fn gemini_response_body(
    status: u16,
    response: reqwest::Response,
) -> Result<GeminiResponseBody, ()> {
    if (200..300).contains(&status) {
        return Ok(GeminiResponseBody::Stream(Box::pin(
            response.bytes_stream().map(|chunk| chunk.map_err(|_| ())),
        )));
    }
    bounded_response_text(response, MAX_GEMINI_ERROR_BODY_BYTES)
        .await
        .map(GeminiResponseBody::Bounded)
}

async fn bounded_response_text(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, ()> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| ())
}

fn gemini_sse_response_from_http_parts(
    status: u16,
    retry_after: Option<String>,
    reset_after: Option<String>,
    body: Result<GeminiResponseBody, ()>,
) -> Result<GeminiSseResponse, BrainError> {
    let body = match body {
        Ok(body) => body,
        Err(()) if !(200..300).contains(&status) => GeminiResponseBody::Bounded(String::new()),
        Err(()) => return Err(gemini_client_failure("error_kind=response_read_failed")),
    };
    Ok(GeminiSseResponse {
        status,
        body,
        retry_after,
        reset_after,
    })
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn reset_header_value(headers: &HeaderMap) -> Option<String> {
    [
        "x-ratelimit-reset",
        "x-rate-limit-reset",
        "ratelimit-reset",
        "x-goog-quota-reset",
    ]
    .into_iter()
    .find_map(|name| header_value(headers, name))
}

fn gemini_rate_limit_stage_failure(
    config: &GeminiConfig,
    response: &GeminiSseResponse,
    latency: Duration,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class: BrainFailureClass::QuotaRateFailure,
        stage: BrainFailureStage::Gemini,
        retry_eligible: true,
        latency_ms: latency.as_millis().try_into().unwrap_or(u64::MAX),
        provider: "gemini".to_owned(),
        model: config.model_id.clone(),
        metadata: gemini_rate_limit_metadata(response),
    })
}

/// The HTTP status is the classifier. `401`/`403` are provider-auth failures and
/// are never retried; the rest follow the typed policy the status itself implies.
fn gemini_status_stage_failure(
    config: &GeminiConfig,
    response: &GeminiSseResponse,
    latency: Duration,
) -> BrainError {
    let failure_class = match response.status {
        401 | 403 => BrainFailureClass::ProviderAuthFailure,
        429 => BrainFailureClass::QuotaRateFailure,
        408 | 504 => BrainFailureClass::Timeout,
        500..=599 => BrainFailureClass::NetworkDisconnect,
        _ => BrainFailureClass::MalformedStream,
    };
    let retry_eligible = response.status == 408 || response.status == 429 || response.status >= 500;
    brain_failure(BrainProviderFailureParts {
        failure_class,
        stage: BrainFailureStage::Gemini,
        retry_eligible,
        latency_ms: latency.as_millis().try_into().unwrap_or(u64::MAX),
        provider: "gemini".to_owned(),
        model: config.model_id.clone(),
        metadata: gemini_status_metadata(response, retry_eligible),
    })
}

/// `ADAPTER-06`: which allowlisted diagnostic code an HTTP status maps to. The
/// set is closed; an unrecognized status collapses to `gemini_http_rejected`.
fn gemini_http_diagnostic_code(status: u16) -> ProviderDiagnosticCode {
    match status {
        401 | 403 => ProviderDiagnosticCode::GeminiHttpAuth,
        429 => ProviderDiagnosticCode::GeminiHttpRateLimited,
        _ => ProviderDiagnosticCode::GeminiHttpRejected,
    }
}

fn gemini_timeout_stage_failure(config: &GeminiConfig, latency: Duration) -> BrainError {
    gemini_stage_failure(
        config,
        BrainFailureClass::Timeout,
        BrainFailureStage::Gemini,
        true,
        latency,
        "error_kind=deadline_elapsed",
    )
}

fn gemini_empty_stream_stage_failure(config: &GeminiConfig, latency: Duration) -> BrainError {
    gemini_stage_failure(
        config,
        BrainFailureClass::MalformedStream,
        BrainFailureStage::Gemini,
        true,
        latency,
        "error_kind=empty_stream",
    )
}

/// A fallback attempt keeps the classification the transport chose and adopts
/// the fallback model plus the elapsed latency. Nothing re-reads a message.
fn gemini_transport_stage_failure(
    config: &GeminiConfig,
    error: &BrainError,
    latency: Duration,
) -> BrainError {
    let failure = error.failure();
    brain_failure(BrainProviderFailureParts {
        failure_class: failure.failure_class(),
        stage: failure.stage(),
        retry_eligible: failure.retry_eligible(),
        latency_ms: latency.as_millis().try_into().unwrap_or(u64::MAX),
        provider: "gemini".to_owned(),
        model: config.model_id.clone(),
        metadata: failure.metadata().to_owned(),
    })
}

fn gemini_stage_failure(
    config: &GeminiConfig,
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    retry_eligible: bool,
    latency: Duration,
    metadata: &'static str,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class,
        stage,
        retry_eligible,
        latency_ms: latency.as_millis().try_into().unwrap_or(u64::MAX),
        provider: "gemini".to_owned(),
        model: config.model_id.clone(),
        metadata: gemini_stage_metadata(metadata),
    })
}

/// Every Gemini failure names its typed stage with the same canonical key the
/// Cartesia stages use, so one observability query covers all three.
fn gemini_stage_metadata(error_kind: &'static str) -> String {
    format!("stage={} {error_kind}", ProviderStageLabel::Gemini.as_str())
}

/// A non-429 HTTP refusal: the shared bounded diagnostic plus the one closed
/// canonical status token the provider's own error envelope names.
fn gemini_status_metadata(response: &GeminiSseResponse, retry_eligible: bool) -> String {
    let diagnostic =
        ProviderDiagnostic::new(gemini_http_diagnostic_code(response.status), retry_eligible)
            .with_http_status(response.status);
    let retry_hint = retry_after_hint(response.retry_after.as_deref(), response.body.bounded());
    let metadata = format!(
        "{} retry_after_ms={} retry_after_source={} body_status={}",
        provider_diagnostic_metadata(&diagnostic),
        retry_hint.retry_after_ms,
        retry_hint.source,
        sanitized_body_status(response.body.bounded()),
    );
    debug_assert!(metadata.len() <= MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES);
    metadata
}

/// A 429 additionally carries the operational backoff hints
/// `docs/provider-failure-observability.md` groups on. Every one of them is a
/// bounded integer or a closed adapter-chosen token; no provider byte survives.
fn gemini_rate_limit_metadata(response: &GeminiSseResponse) -> String {
    let retry_hint = retry_after_hint(response.retry_after.as_deref(), response.body.bounded());
    let reset_hint = response
        .reset_after
        .as_deref()
        .and_then(sanitized_reset_hint)
        .unwrap_or_else(|| "none".to_owned());
    let diagnostic = ProviderDiagnostic::new(ProviderDiagnosticCode::GeminiHttpRateLimited, true)
        .with_http_status(429);
    let metadata = format!(
        "{} reset_hint={} retry_after_ms={} retry_after_source={} body_status={}",
        provider_diagnostic_metadata(&diagnostic),
        reset_hint,
        retry_hint.retry_after_ms,
        retry_hint.source,
        sanitized_body_status(response.body.bounded()),
    );
    debug_assert!(metadata.len() <= MAX_PROVIDER_DIAGNOSTIC_METADATA_BYTES);
    metadata
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RetryAfterHint {
    retry_after_ms: u64,
    source: &'static str,
}

fn retry_after_hint(header_value: Option<&str>, body: &str) -> RetryAfterHint {
    let header_hint = retry_after_header_hint(header_value);
    if header_hint.source != "default" {
        return header_hint;
    }
    body_retry_after_hint(body).unwrap_or(header_hint)
}

fn retry_after_header_hint(value: Option<&str>) -> RetryAfterHint {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return default_retry_after_hint();
    };
    if let Ok(seconds) = value.parse::<u64>() {
        return RetryAfterHint {
            retry_after_ms: seconds.saturating_mul(1_000),
            source: "retry_after_delta",
        };
    }
    if let Ok(date) = httpdate::parse_http_date(value) {
        let delta = date.duration_since(SystemTime::now()).unwrap_or_default();
        return RetryAfterHint {
            retry_after_ms: delta.as_millis().try_into().unwrap_or(u64::MAX),
            source: "retry_after_http_date",
        };
    }
    default_retry_after_hint()
}

fn body_retry_after_hint(body: &str) -> Option<RetryAfterHint> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    retry_info_body_hint(&value).or_else(|| retry_text_body_hint(&value))
}

fn retry_info_body_hint(value: &Value) -> Option<RetryAfterHint> {
    let details = value.pointer("/error/details")?.as_array()?;
    details.iter().find_map(|detail| {
        let detail_type = detail.get("@type")?.as_str()?;
        if !detail_type.contains("google.rpc.RetryInfo") {
            return None;
        }
        let retry_delay = detail.get("retryDelay")?.as_str()?;
        retry_delay_ms(retry_delay).map(|retry_after_ms| RetryAfterHint {
            retry_after_ms,
            source: "body_retry_info",
        })
    })
}

fn retry_text_body_hint(value: &Value) -> Option<RetryAfterHint> {
    let message = value.pointer("/error/message")?.as_str()?;
    simple_retry_text_ms(message).map(|retry_after_ms| RetryAfterHint {
        retry_after_ms,
        source: "body_retry_text",
    })
}

fn retry_delay_ms(value: &str) -> Option<u64> {
    let duration = value.trim().strip_suffix('s')?;
    let (seconds, fractional_nanos) = match duration.split_once('.') {
        Some((seconds, fractional)) => {
            if fractional.is_empty()
                || fractional.len() > 9
                || !fractional
                    .chars()
                    .all(|character| character.is_ascii_digit())
            {
                return None;
            }
            let padded = format!("{fractional:0<9}");
            (seconds, padded.parse::<u64>().ok()?)
        }
        None => (duration, 0),
    };
    if seconds.is_empty() || !seconds.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let fractional_ms = fractional_nanos.saturating_add(999_999) / 1_000_000;
    seconds
        .parse::<u64>()
        .ok()?
        .checked_mul(1_000)?
        .checked_add(fractional_ms)
}

fn simple_retry_text_ms(value: &str) -> Option<u64> {
    let normalized = value.to_ascii_lowercase();
    let words = normalized
        .split_whitespace()
        .map(trim_retry_text_token)
        .collect::<Vec<_>>();
    for window in words.windows(4) {
        if window[0] == "retry" && matches!(window[1], "in" | "after") {
            let Some(amount) = window[2].parse::<u64>().ok() else {
                continue;
            };
            let unit = window[3];
            let multiplier = match unit {
                "s" | "sec" | "secs" | "second" | "seconds" => 1_000,
                "m" | "min" | "mins" | "minute" | "minutes" => 60_000,
                _ => continue,
            };
            return amount.checked_mul(multiplier);
        }
    }
    None
}

fn trim_retry_text_token(value: &str) -> &str {
    value.trim_matches(|character: char| !character.is_ascii_alphanumeric())
}

fn default_retry_after_hint() -> RetryAfterHint {
    RetryAfterHint {
        retry_after_ms: DEFAULT_GEMINI_RETRY_AFTER_MS,
        source: "default",
    }
}

fn sanitized_reset_hint(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(value) = rfc3339_utc_reset_hint(value) {
        return Some(value);
    }
    if let Some(value) = epoch_reset_hint(value) {
        return Some(value);
    }
    httpdate::parse_http_date(value)
        .ok()
        .filter(|value| reset_time_in_supported_range(*value))
        .map(httpdate::fmt_http_date)
        .map(|value| value.replace(' ', "_"))
}

fn rfc3339_utc_reset_hint(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() != "2030-01-01T00:00:00Z".len()
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'Z'
    {
        return None;
    }
    let year = value[0..4].parse::<u16>().ok()?;
    let month = value[5..7].parse::<u8>().ok()?;
    let day = value[8..10].parse::<u8>().ok()?;
    let hour = value[11..13].parse::<u8>().ok()?;
    let minute = value[14..16].parse::<u8>().ok()?;
    let second = value[17..19].parse::<u8>().ok()?;
    if !(2020..=2100).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    Some(value.to_owned())
}

fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u16) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn epoch_reset_hint(value: &str) -> Option<String> {
    if !value.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let timestamp = value.parse::<u64>().ok()?;
    if (1..=9).contains(&value.len()) {
        return timestamp
            .checked_mul(1_000)
            .filter(|millis| *millis <= 86_400_000)
            .map(|millis| format!("relative_ms={millis}"));
    }
    let millis = match value.len() {
        10 => timestamp.checked_mul(1_000)?,
        13 => timestamp,
        _ => return None,
    };
    if reset_epoch_millis_in_supported_range(millis) {
        Some(format!("epoch_ms={millis}"))
    } else {
        None
    }
}

fn reset_time_in_supported_range(value: SystemTime) -> bool {
    value
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .is_some_and(reset_epoch_millis_in_supported_range)
}

fn reset_epoch_millis_in_supported_range(millis: u64) -> bool {
    const MIN_RESET_EPOCH_MS: u64 = 1_600_000_000_000;
    const MAX_RESET_EPOCH_MS: u64 = 4_102_444_800_000;
    (MIN_RESET_EPOCH_MS..=MAX_RESET_EPOCH_MS).contains(&millis)
}

/// The closed set of canonical `google.rpc.Code` status names.
///
/// `ADAPTER-06`: the provider authors this token, so it is matched against a
/// fixed table rather than sanitized in place. Anything the table does not name
/// — including a hostile status crafted to smuggle bytes into observability —
/// collapses to `unknown`, so no provider-controlled byte reaches metadata.
const GEMINI_CANONICAL_BODY_STATUSES: [&str; 17] = [
    "ok",
    "cancelled",
    "unknown",
    "invalid_argument",
    "deadline_exceeded",
    "not_found",
    "already_exists",
    "permission_denied",
    "resource_exhausted",
    "failed_precondition",
    "aborted",
    "out_of_range",
    "unimplemented",
    "internal",
    "unavailable",
    "data_loss",
    "unauthenticated",
];

fn sanitized_body_status(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            let status = value
                .pointer("/error/status")
                .and_then(Value::as_str)?
                .to_ascii_lowercase();
            GEMINI_CANONICAL_BODY_STATUSES
                .into_iter()
                .find(|canonical| *canonical == status)
        })
        .unwrap_or("unknown")
        .to_owned()
}

pub fn gemini_request(config: &GeminiConfig, contents: Vec<Value>, tools: &[Value]) -> Value {
    let mut request = json!({
        "contents": contents,
        "systemInstruction": {
            "parts": [{ "text": config.system_instruction }],
        },
    });

    if let Some(thinking_level) = &config.thinking_level {
        if config.supports_thinking_config() {
            request["generationConfig"] = json!({
                "thinkingConfig": {
                    "thinkingLevel": thinking_level.as_api_str(),
                },
            });
        }
    }

    let mut declarations = gemini_function_declarations(tools);
    if request["contents"]
        .as_array()
        .into_iter()
        .flatten()
        .any(content_has_trusted_source_context_response)
        && !declarations.iter().any(|declaration| {
            declaration.get("name").and_then(Value::as_str) == Some(TRUSTED_SOURCE_CONTEXT_FUNCTION)
        })
    {
        declarations.push(trusted_source_context_declaration());
    }

    if !declarations.is_empty() {
        request["tools"] = json!([{ "functionDeclarations": declarations }]);
        request["toolConfig"] = json!({
            "functionCallingConfig": {
                "mode": "AUTO",
            },
        });
    }

    request
}

pub fn parse_gemini_sse_line(line: &str) -> Vec<GeminiStreamEvent> {
    let Some(data) = line.trim().strip_prefix("data:") else {
        return Vec::new();
    };
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return vec![GeminiStreamEvent::Error(
            "invalid Gemini SSE JSON".to_owned(),
        )];
    };
    parse_gemini_value(&value)
}

pub fn parse_gemini_sse_stream(text: &str) -> Vec<GeminiStreamEvent> {
    text.lines().flat_map(parse_gemini_sse_line).collect()
}

fn parse_gemini_value(value: &Value) -> Vec<GeminiStreamEvent> {
    if value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .is_some()
    {
        return vec![GeminiStreamEvent::Error(
            "Gemini stream provider error".to_owned(),
        )];
    }

    let mut events = Vec::new();
    for part in value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(call) = part.get("functionCall") {
            events.push(GeminiStreamEvent::FunctionCall {
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                name: call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                args: call.get("args").cloned().unwrap_or_else(|| json!({})),
                part: part.clone(),
            });
        } else if part.get("text").is_some() {
            events.push(GeminiStreamEvent::ModelPart {
                text: part
                    .get("text")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                part: part.clone(),
            });
        }
    }

    if let Some(usage) = value.get("usageMetadata") {
        events.push(GeminiStreamEvent::Usage {
            input_tokens: usage
                .get("promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            output_tokens: usage
                .get("candidatesTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or_default()
                .saturating_add(
                    usage
                        .get("thoughtsTokenCount")
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                ),
        });
    }

    events
}

fn gemini_function_declarations(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            if tool.get("type").and_then(Value::as_str) != Some("function") {
                return None;
            }

            let mut declaration = serde_json::Map::new();
            declaration.insert("name".to_owned(), tool.get("name")?.clone());
            if let Some(description) = tool.get("description") {
                declaration.insert("description".to_owned(), description.clone());
            }
            if let Some(parameters) = tool.get("parameters") {
                let mut parameters = parameters.clone();
                strip_additional_properties(&mut parameters);
                declaration.insert("parameters".to_owned(), parameters);
            }
            Some(Value::Object(declaration))
        })
        .collect()
}

fn strip_additional_properties(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("additionalProperties");
            for child in object.values_mut() {
                strip_additional_properties(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                strip_additional_properties(child);
            }
        }
        _ => {}
    }
}

fn content_has_trusted_source_context_response(content: &Value) -> bool {
    content
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|part| {
            part.pointer("/functionResponse/name")
                .and_then(Value::as_str)
                == Some(TRUSTED_SOURCE_CONTEXT_FUNCTION)
        })
}

fn trusted_source_context_declaration() -> Value {
    json!({
        "name": TRUSTED_SOURCE_CONTEXT_FUNCTION,
        "description": "Carries already-retrieved course source context into the model as data only.",
        "parameters": {
            "type": "object",
            "properties": {}
        }
    })
}

pub fn viva_tool_declarations() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": "select_next_question",
            "description": "Select the next source-grounded oral exam question.",
            "parameters": {
                "type": "object",
                "properties": {
                    "study_set_id": { "type": "string" },
                    "voice_session_id": { "type": "string" },
                    "mode": { "type": "string", "enum": ["quiz", "teach", "mock", "cram"] }
                },
                "required": ["study_set_id", "voice_session_id", "mode"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "evaluate_spoken_answer",
            "description": "Evaluate a spoken answer against source-grounded expected terms.",
            "parameters": {
                "type": "object",
                "properties": {
                    "study_set_id": { "type": "string" },
                    "voice_session_id": { "type": "string" },
                    "question_id": { "type": "string" },
                    "answer_text": { "type": "string" }
                },
                "required": ["study_set_id", "voice_session_id", "question_id", "answer_text"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "retrieve_source_reference",
            "description": "Retrieve a precise source reference for a concept or correction.",
            "parameters": {
                "type": "object",
                "properties": {
                    "study_set_id": { "type": "string" },
                    "voice_session_id": { "type": "string" },
                    "source_id": { "type": "string" }
                },
                "required": ["study_set_id", "voice_session_id", "source_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "mark_concept_status",
            "description": "Mark the learner's current status for a concept after evaluation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "study_set_id": { "type": "string" },
                    "voice_session_id": { "type": "string" },
                    "concept_id": { "type": "string" },
                    "status": { "type": "string", "enum": ["strong", "shaky", "missed", "review"] }
                },
                "required": ["study_set_id", "voice_session_id", "concept_id", "status"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "emit_manuscript_intent",
            "description": "Emit a bounded Listening Manuscript intent for the active response. Use only semantic register, emphasis, and stable concept/source/marginalia anchors; never emit markup, coordinates, colors, CSS, drawing commands, or other render instructions.",
            "parameters": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string", "enum": ["scene_intent"] },
                            "register": { "type": "string", "enum": ["examining", "reflecting", "correcting", "sourcing", "recapping"] },
                            "emphasis": { "type": "string", "enum": ["quiet", "measured", "marked"] }
                        },
                        "required": ["type", "register", "emphasis"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string", "enum": ["entity_intent"] },
                            "entity_id": { "type": "string" },
                            "entity_kind": { "type": "string", "enum": ["concept", "source"] },
                            "register": { "type": "string", "enum": ["examining", "reflecting", "correcting", "sourcing", "recapping"] },
                            "emphasis": { "type": "string", "enum": ["quiet", "measured", "marked"] }
                        },
                        "required": ["type", "entity_id", "entity_kind", "register", "emphasis"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string", "enum": ["marginalia_intent"] },
                            "marginalia_id": { "type": "string" },
                            "anchor_entity_id": { "type": "string" },
                            "register": { "type": "string", "enum": ["examining", "reflecting", "correcting", "sourcing", "recapping"] },
                            "emphasis": { "type": "string", "enum": ["quiet", "measured", "marked"] }
                        },
                        "required": ["type", "marginalia_id", "anchor_entity_id", "register", "emphasis"],
                        "additionalProperties": false
                    }
                ]
            }
        }),
        json!({
            "type": "function",
            "name": "build_session_recap",
            "description": "Build the learner-facing recap after a voice session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "study_set_id": { "type": "string" },
                    "voice_session_id": { "type": "string" }
                },
                "required": ["study_set_id", "voice_session_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "challenge_correction",
            "description": "Challenge or re-check a correction against source-grounded course material.",
            "parameters": {
                "type": "object",
                "properties": {
                    "study_set_id": { "type": "string" },
                    "voice_session_id": { "type": "string" },
                    "source_id": { "type": "string" },
                    "document_id": { "type": "string" },
                    "span": { "type": "string" },
                    "excerpt": { "type": "string" },
                    "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
                    "retrieval_reason": { "type": "string" },
                    "correction_id": { "type": "string" },
                    "challenge_text": { "type": "string" }
                },
                "required": ["study_set_id", "voice_session_id", "source_id", "document_id", "span", "excerpt", "confidence", "retrieval_reason", "correction_id", "challenge_text"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "schedule_review_item",
            "description": "Record a concept verdict for later spaced review; @viva/core computes visible due dates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "study_set_id": { "type": "string" },
                    "voice_session_id": { "type": "string" },
                    "concept_id": { "type": "string" },
                    "status": { "type": "string", "enum": ["strong", "shaky", "missed", "review"] }
                },
                "required": ["study_set_id", "voice_session_id", "concept_id", "status"],
                "additionalProperties": false
            }
        }),
    ]
}

fn viva_system_instruction() -> String {
    "You are Viva, a source-grounded oral study coach. Ask concise spoken questions, wait for the learner's answer, evaluate against retrieved course materials, cite source context when correcting, and never invent unsupported course facts.".to_owned()
}

#[cfg(test)]
mod streaming_tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use bytes::Bytes;
    use futures_util::StreamExt;
    use serde_json::json;
    use tokio::time::{timeout, Duration};

    use super::*;

    const SAFE_RESPONSE_RECORD: &str =
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"first safe response\"}]}}]}\n\n";

    /// A latch a test can open once. Awaiting it is cancel-safe, so a `select!`
    /// arm may drop the wait without losing the release.
    struct Latch {
        permits: tokio::sync::Semaphore,
    }

    impl Latch {
        fn closed() -> Self {
            Self {
                permits: tokio::sync::Semaphore::new(0),
            }
        }

        fn open(&self) {
            self.permits.add_permits(1);
        }

        async fn wait(&self) {
            // The permit is returned when it drops, so the latch stays open.
            let _permit = self.permits.acquire().await.expect("the latch is alive");
        }
    }

    /// A body that yields its chunks, then blocks before EOF until released.
    fn blocking_body(
        chunks: Vec<&'static str>,
        eof: Arc<Latch>,
        reached_eof: Arc<AtomicBool>,
    ) -> GeminiByteStream {
        let state = (
            chunks
                .into_iter()
                .collect::<std::collections::VecDeque<_>>(),
            eof,
            reached_eof,
            false,
        );
        Box::pin(futures_util::stream::unfold(
            state,
            |(mut chunks, eof, reached_eof, done)| async move {
                if done {
                    return None;
                }
                if let Some(chunk) = chunks.pop_front() {
                    return Some((
                        Ok(Bytes::from_static(chunk.as_bytes())),
                        (chunks, eof, reached_eof, false),
                    ));
                }
                eof.wait().await;
                reached_eof.store(true, Ordering::SeqCst);
                None
            },
        ))
    }

    struct StreamingBodyClient {
        body: std::sync::Mutex<Option<GeminiByteStream>>,
    }

    #[async_trait]
    impl GeminiSseClient for StreamingBodyClient {
        async fn stream(
            &self,
            _request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            Ok(GeminiSseResponse {
                status: 200,
                body: GeminiResponseBody::Stream(
                    self.body
                        .lock()
                        .expect("body lock poisoned")
                        .take()
                        .expect("the client is used once"),
                ),
                retry_after: None,
                reset_after: None,
            })
        }
    }

    fn streaming_config() -> GeminiConfig {
        GeminiConfig {
            api_key: "gemini-test-key".to_owned(),
            ..GeminiConfig::default()
        }
    }

    #[tokio::test]
    async fn gemini_sse_emits_first_event_before_http_body_eof() {
        let eof = Arc::new(Latch::closed());
        let reached_eof = Arc::new(AtomicBool::new(false));
        let client = StreamingBodyClient {
            body: std::sync::Mutex::new(Some(blocking_body(
                vec![SAFE_RESPONSE_RECORD],
                Arc::clone(&eof),
                Arc::clone(&reached_eof),
            ))),
        };

        let mut stream =
            stream_gemini_with_client_attempt_events(&client, &streaming_config(), json!({}))
                .await
                .expect("the response streams");
        let first = timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("the first event must arrive while the body is still open")
            .expect("the stream yields an event")
            .expect("the event parses");

        assert!(
            !reached_eof.load(Ordering::SeqCst),
            "the body must still be open when the first event is delivered"
        );
        assert!(
            matches!(&first, GeminiStreamEvent::ModelPart { text: Some(text), .. } if text == "first safe response"),
            "{first:?}"
        );

        eof.open();
        assert!(timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("the stream ends after EOF")
            .is_none());
        assert!(reached_eof.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn split_sse_records_are_reassembled_without_buffering_the_body() {
        // One record, delivered one byte at a time across arbitrary boundaries.
        let chunks = SAFE_RESPONSE_RECORD
            .as_bytes()
            .iter()
            .map(|byte| {
                let owned: &'static str = Box::leak(
                    String::from_utf8(vec![*byte])
                        .expect("ASCII")
                        .into_boxed_str(),
                );
                owned
            })
            .collect::<Vec<_>>();
        let eof = Arc::new(Latch::closed());
        eof.open();
        let client = StreamingBodyClient {
            body: std::sync::Mutex::new(Some(blocking_body(
                chunks,
                eof,
                Arc::new(AtomicBool::new(false)),
            ))),
        };

        let stream =
            stream_gemini_with_client_attempt_events(&client, &streaming_config(), json!({}))
                .await
                .expect("the response streams");
        let events = timeout(Duration::from_secs(2), stream.collect::<Vec<_>>())
            .await
            .expect("the split record is reassembled")
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .expect("every event parses");

        assert_eq!(events.len(), 1, "{events:?}");
        assert!(
            matches!(&events[0], GeminiStreamEvent::ModelPart { text: Some(text), .. } if text == "first safe response"),
            "{events:?}"
        );
    }

    #[tokio::test]
    async fn split_invalid_sse_json_is_one_typed_malformed_stream_failure() {
        // The provider's raw body is hostile and split across chunk boundaries.
        let eof = Arc::new(Latch::closed());
        eof.open();
        let client = StreamingBodyClient {
            body: std::sync::Mutex::new(Some(blocking_body(
                vec![
                    "data: {\"candidates\": [{\"content\": \"leaked-prompt-marker",
                    "-and-transcript\"",
                    "\n\n",
                ],
                eof,
                Arc::new(AtomicBool::new(false)),
            ))),
        };

        let stream =
            stream_gemini_with_client_attempt_events(&client, &streaming_config(), json!({}))
                .await
                .expect("the response streams");
        let events = timeout(Duration::from_secs(2), stream.collect::<Vec<_>>())
            .await
            .expect("the malformed record is decided without buffering the body");

        let rendered = format!("{events:?}");
        assert!(
            !rendered.contains("leaked-prompt-marker-and-transcript"),
            "no raw body text may survive a malformed stream: {rendered}"
        );
        let errors = events
            .iter()
            .filter(|event| matches!(event, Ok(GeminiStreamEvent::Error(_))) || event.is_err())
            .count();
        assert_eq!(
            errors, 1,
            "exactly one typed malformed-stream failure: {events:?}"
        );
    }
}

#[cfg(test)]
mod tests {
    /// One scripted provider response, as data.
    ///
    /// `ADAPTER-05` made a 2xx body a stream, which is neither `Clone` nor
    /// `Sync`; a scripted client therefore stores the parts and builds a fresh
    /// response for every call.
    #[derive(Clone)]
    struct RecordedResponse {
        status: u16,
        body: String,
        retry_after: Option<String>,
        reset_after: Option<String>,
    }

    impl RecordedResponse {
        fn ok(body: String) -> Self {
            Self {
                status: 200,
                body,
                retry_after: None,
                reset_after: None,
            }
        }

        fn build(&self) -> GeminiSseResponse {
            let body = self.body.clone();
            GeminiSseResponse {
                status: self.status,
                body: if (200..300).contains(&self.status) {
                    GeminiResponseBody::Stream(Box::pin(futures_util::stream::once(async move {
                        Ok(bytes::Bytes::from(body.into_bytes()))
                    })))
                } else {
                    GeminiResponseBody::Bounded(body)
                },
                retry_after: self.retry_after.clone(),
                reset_after: self.reset_after.clone(),
            }
        }
    }

    use agent_domain::TerminalSessionReason;

    /// A scripted transport fault carrying the classification a real transport
    /// would have chosen. The hostile marker stays out of it by construction.
    fn fixture_transport_failure() -> BrainError {
        brain_failure(BrainProviderFailureParts {
            failure_class: BrainFailureClass::NetworkDisconnect,
            stage: BrainFailureStage::Transport,
            retry_eligible: true,
            latency_ms: 0,
            provider: "gemini".to_owned(),
            model: "gemini".to_owned(),
            metadata: "error_kind=request_failed".to_owned(),
        })
    }

    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use axum::{http::StatusCode, routing::post, Router};
    use serde_json::json;

    use agent_domain::BrainError;

    use super::*;

    fn assert_fallback_activation(
        event: &GeminiStreamEvent,
        from_model: &str,
        to_model: &str,
        reason: &str,
        retry_after_ms: u64,
    ) {
        let GeminiStreamEvent::FallbackActivated {
            from_model: actual_from,
            to_model: actual_to,
            reason: actual_reason,
            failure,
        } = event
        else {
            panic!("expected fallback activation, got {event:?}");
        };
        assert_eq!(actual_from, from_model);
        assert_eq!(actual_to, to_model);
        assert_eq!(actual_reason, reason);
        let failure = failure
            .as_ref()
            .expect("fallback activation carries originating provider failure");
        assert_eq!(failure.failure_class(), BrainFailureClass::QuotaRateFailure);
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderRateLimited
        );
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), from_model.replace('.', ""));
        assert!(failure
            .metadata()
            .contains(&format!("retry_after_ms={retry_after_ms}")));
    }

    #[test]
    fn normalizes_thinking_level_and_omits_for_older_models() {
        let config = GeminiConfig {
            thinking_level: ThinkingLevel::parse("low"),
            ..GeminiConfig::default()
        };

        let request = gemini_request(&config, vec![], &[]);
        assert_eq!(
            request["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "LOW"
        );

        let older_model = GeminiConfig {
            model_id: "gemini-2.5-flash".to_owned(),
            thinking_level: ThinkingLevel::parse("low"),
            ..GeminiConfig::default()
        };
        let request = gemini_request(&older_model, vec![], &[]);
        assert!(request.get("generationConfig").is_none());
    }

    #[test]
    fn builds_viva_tool_schema_without_additional_properties() {
        let request = gemini_request(
            &GeminiConfig::default(),
            vec![json!({ "role": "user", "parts": [{ "text": "quiz me" }] })],
            &viva_tool_declarations(),
        );

        assert_eq!(
            request["tools"][0]["functionDeclarations"][0]["name"],
            "select_next_question"
        );
        assert!(request["tools"][0]["functionDeclarations"][0]["parameters"]
            .get("additionalProperties")
            .is_none());
        assert_eq!(
            request["toolConfig"]["functionCallingConfig"]["mode"],
            "AUTO"
        );
    }

    #[test]
    fn parses_text_function_call_and_usage_from_sse() {
        let events = parse_gemini_sse_line(
            r#"data: {"candidates":[{"content":{"parts":[{"text":"Explain "},{"functionCall":{"id":"call-1","name":"retrieve_source_reference","args":{"source_id":"src-1"}}}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":7,"thoughtsTokenCount":3}}"#,
        );

        assert_eq!(
            events,
            vec![
                GeminiStreamEvent::ModelPart {
                    text: Some("Explain ".to_owned()),
                    part: json!({ "text": "Explain " }),
                },
                GeminiStreamEvent::FunctionCall {
                    id: "call-1".to_owned(),
                    name: "retrieve_source_reference".to_owned(),
                    args: json!({ "source_id": "src-1" }),
                    part: json!({
                        "functionCall": {
                            "id": "call-1",
                            "name": "retrieve_source_reference",
                            "args": { "source_id": "src-1" }
                        }
                    }),
                },
                GeminiStreamEvent::Usage {
                    input_tokens: 12,
                    output_tokens: 10,
                },
            ]
        );
    }

    #[test]
    fn parses_multiline_gemini_sse_stream() {
        let events = parse_gemini_sse_stream(
            r#"event: message
data: {"candidates":[{"content":{"parts":[{"text":"Good."}]}}]}

data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call-2","name":"mark_concept_status","args":{"concept_id":"atp","status":"strong"}}}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":6}}

data: [DONE]
"#,
        );

        assert_eq!(
            events,
            vec![
                GeminiStreamEvent::ModelPart {
                    text: Some("Good.".to_owned()),
                    part: json!({ "text": "Good." }),
                },
                GeminiStreamEvent::FunctionCall {
                    id: "call-2".to_owned(),
                    name: "mark_concept_status".to_owned(),
                    args: json!({ "concept_id": "atp", "status": "strong" }),
                    part: json!({
                        "functionCall": {
                            "id": "call-2",
                            "name": "mark_concept_status",
                            "args": { "concept_id": "atp", "status": "strong" }
                        }
                    }),
                },
                GeminiStreamEvent::Usage {
                    input_tokens: 4,
                    output_tokens: 6,
                },
            ]
        );
    }

    #[tokio::test]
    async fn streaming_transport_uses_configured_auth_and_parses_sse_without_network() {
        let capture = Arc::new(Mutex::new(GeminiRequestCapture::default()));
        let client = RecordingGeminiSseClient {
            capture: capture.clone(),
            response: RecordingGeminiResponse::Body(
                r#"data: {"candidates":[{"content":{"parts":[{"text":"Continue."}]}}]}"#.to_owned(),
            ),
        };
        let config = GeminiConfig {
            api_key: "gemini-test-key".to_owned(),
            base_url: "https://generativelanguage.googleapis.com/v1beta/models".to_owned(),
            model_id: "gemini-3.5-flash".to_owned(),
            ..GeminiConfig::default()
        };
        let body = json!({
            "contents": [{ "role": "user", "parts": [{ "text": "do not log this answer" }] }],
        });
        let mut expected_body = body.clone();
        expected_body["generationConfig"] = json!({
            "thinkingConfig": {
                "thinkingLevel": "LOW",
            },
        });

        let events = stream_gemini_with_client(&client, &config, body.clone())
            .await
            .unwrap();

        assert_eq!(
            events,
            vec![GeminiStreamEvent::ModelPart {
                text: Some("Continue.".to_owned()),
                part: json!({ "text": "Continue." }),
            }]
        );
        let capture = capture.lock().expect("capture lock poisoned");
        assert_eq!(
            capture.url.as_deref(),
            Some("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse")
        );
        assert_eq!(capture.api_key.as_deref(), Some("gemini-test-key"));
        assert_eq!(capture.body.as_ref(), Some(&expected_body));
        assert!(!capture.url.as_ref().unwrap().contains("gemini-test-key"));
    }

    #[tokio::test]
    async fn streaming_transport_sanitizes_provider_and_client_failures() {
        let unsafe_marker = "UNSAFE_PROVIDER_MARKER";
        let provider_error_events = parse_gemini_sse_stream(&format!(
            r#"data: {{"error":{{"message":"provider included {unsafe_marker}"}}}}"#
        ));

        assert_eq!(
            provider_error_events,
            vec![GeminiStreamEvent::Error(
                "Gemini stream provider error".to_owned()
            )]
        );

        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Error(format!(
                "network failure after {unsafe_marker}"
            )),
        };
        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        // The transport classified what it observed; nothing downstream re-reads
        // a message, so the provider's own words never enter the failure.
        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert_eq!(failure.stage(), BrainFailureStage::Transport);
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains(unsafe_marker));
        assert!(!rendered.contains("local-fixture"));
    }

    /// The status is the classifier, and only its integer survives. The body a
    /// provider sent with it is dropped whole.
    #[tokio::test]
    async fn streaming_transport_preserves_safe_http_status_failures() {
        let unsafe_marker = "UNSAFE_STATUS_MARKER";
        for (status, expected) in [
            (401_u16, BrainFailureClass::ProviderAuthFailure),
            (403, BrainFailureClass::ProviderAuthFailure),
            (404, BrainFailureClass::MalformedStream),
            (429, BrainFailureClass::QuotaRateFailure),
        ] {
            let client = RecordingGeminiSseClient {
                capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
                response: RecordingGeminiResponse::Response(RecordedResponse {
                    status,
                    body: format!(r#"{{"error":{{"message":"{unsafe_marker}"}}}}"#),
                    retry_after: None,
                    reset_after: None,
                }),
            };

            let error = stream_gemini_with_client(
                &client,
                &GeminiConfig {
                    api_key: "local-fixture".to_owned(),
                    ..GeminiConfig::default()
                },
                json!({ "contents": [] }),
            )
            .await
            .unwrap_err();
            let failure = error.failure();

            assert_eq!(failure.failure_class(), expected, "status {status}");
            assert_eq!(failure.stage(), BrainFailureStage::Gemini);
            assert!(failure
                .metadata()
                .contains(&format!("http_status={status}")));
            assert_eq!(
                failure.retry_eligible(),
                status == 429,
                "status {status} retry policy"
            );
            let rendered = format!("{error} {failure:?}");
            assert!(!rendered.contains(unsafe_marker));
            assert!(!rendered.contains("local-fixture"));
        }
    }

    #[tokio::test]
    async fn streaming_transport_redacts_unclassified_http_status_failures() {
        let unsafe_marker = "UNSAFE_STATUS_MARKER";
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 503,
                body: format!(r#"{{"error":{{"message":"{unsafe_marker}"}}}}"#),
                retry_after: None,
                reset_after: None,
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert!(failure.metadata().contains("http_status=503"));
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains(unsafe_marker));
        assert!(!rendered.contains("local-fixture"));
    }

    #[tokio::test]
    async fn streaming_transport_times_out_without_leaking_request_markers() {
        let client = DelayedGeminiSseClient;
        let config = GeminiConfig {
            api_key: "local-fixture".to_owned(),
            stage_timeout: Duration::from_millis(5),
            ..GeminiConfig::default()
        };
        let unsafe_marker = "UNSAFE_TIMEOUT_MARKER";

        let error = stream_gemini_with_client(
            &client,
            &config,
            json!({ "contents": [{ "parts": [{ "text": unsafe_marker }] }] }),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(failure.stage(), BrainFailureStage::Gemini);
        assert_eq!(
            failure.metadata(),
            "stage=gemini error_kind=generation_stage_timeout"
        );
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains(unsafe_marker));
        assert!(!rendered.contains("local-fixture"));
    }

    #[tokio::test]
    async fn streaming_transport_maps_429_retry_after_to_sanitized_stage_failure() {
        let raw_body = r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"UNSAFE_429_BODY_MARKER"}}"#;
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 429,
                body: raw_body.to_owned(),
                retry_after: Some("7".to_owned()),
                reset_after: Some("2030-01-01T00:00:00Z".to_owned()),
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                model_id: "gemini-3.5-flash".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert_eq!(failure.failure_class(), BrainFailureClass::QuotaRateFailure);
        assert_eq!(
            failure.terminal_reason(),
            agent_domain::TerminalSessionReason::ProviderRateLimited
        );
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-35-flash");
        assert!(failure.metadata().contains("http_status=429"));
        assert!(failure.metadata().contains("retry_after_ms=7000"));
        assert!(failure
            .metadata()
            .contains("retry_after_source=retry_after_delta"));
        assert!(failure
            .metadata()
            .contains("reset_hint=2030-01-01T00:00:00Z"));
        assert!(failure
            .metadata()
            .contains("body_status=resource_exhausted"));
        // `ADAPTER-06`: the two constant filler keys are gone and the closed
        // diagnostic code replaces them; the operational backoff hints stay.
        assert!(failure
            .metadata()
            .contains("error_kind=gemini_http_rate_limited"));
        assert!(failure.metadata().contains("retry_eligible=true"));
        assert!(!failure.metadata().contains("budget_state="));
        assert!(!failure.metadata().contains("deploy_sha="));
        assert!(!failure.metadata().contains("UNSAFE_429_BODY_MARKER"));
        assert!(!failure.to_string().contains("UNSAFE_429_BODY_MARKER"));
    }

    #[tokio::test]
    async fn streaming_transport_429_without_valid_retry_after_uses_sanitized_default() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 429,
                body:
                    r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"UNSAFE_DEFAULT_BODY_MARKER"}}"#
                        .to_owned(),
                retry_after: Some("not a retry hint".to_owned()),
                reset_after: None,
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert_eq!(failure.failure_class(), BrainFailureClass::QuotaRateFailure);
        assert!(failure.metadata().contains("retry_after_ms=1000"));
        assert!(failure.metadata().contains("retry_after_source=default"));
        assert!(!failure.metadata().contains("UNSAFE_DEFAULT_BODY_MARKER"));
        assert!(!failure.metadata().contains("not a retry hint"));
    }

    #[tokio::test]
    async fn streaming_transport_429_uses_sanitized_retry_info_body_when_header_missing() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 429,
                body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}"#
                    .to_owned(),
                retry_after: None,
                reset_after: None,
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert!(failure.metadata().contains("retry_after_ms=30000"));
        assert!(failure
            .metadata()
            .contains("retry_after_source=body_retry_info"));
        assert!(failure
            .metadata()
            .contains("body_status=resource_exhausted"));
        assert!(!failure.metadata().contains("RetryInfo"));
        assert!(!failure.metadata().contains("retryDelay"));
    }

    // -----------------------------------------------------------------
    // Task 6 (`ADAPTER-06`): every live Gemini HTTP failure exposes only its
    // typed source, stage, numeric status, retry eligibility, and one
    // allowlisted diagnostic code. No provider body, prompt, audio, token, URL,
    // or query survives anywhere it can be read.
    // -----------------------------------------------------------------

    /// Unique per-source markers. Every one of them is injected into a real
    /// provider response and asserted absent from every rendering of the
    /// resulting failure.
    const GEMINI_BODY_MARKER: &str = "marker-gemini-raw-body-b31";
    const GEMINI_PROMPT_MARKER: &str = "marker-gemini-prompt-b32";
    const GEMINI_AUDIO_MARKER: &str = "marker-gemini-audio-base64-b33";
    const GEMINI_TOKEN_MARKER: &str = "marker-gemini-bearer-token-b34";
    const GEMINI_URL_MARKER: &str = "marker-gemini-url-b35";
    const GEMINI_QUERY_MARKER: &str = "marker-gemini-query-b36";
    const GEMINI_TRANSCRIPT_MARKER: &str = "marker-gemini-transcript-b37";

    fn gemini_leak_markers() -> [&'static str; 7] {
        [
            GEMINI_BODY_MARKER,
            GEMINI_PROMPT_MARKER,
            GEMINI_AUDIO_MARKER,
            GEMINI_TOKEN_MARKER,
            GEMINI_URL_MARKER,
            GEMINI_QUERY_MARKER,
            GEMINI_TRANSCRIPT_MARKER,
        ]
    }

    fn hostile_gemini_error_body(status_token: &str) -> String {
        format!(
            r#"{{"error":{{"code":429,"status":"{status_token}","message":"{GEMINI_BODY_MARKER} {GEMINI_PROMPT_MARKER} {GEMINI_AUDIO_MARKER} {GEMINI_TOKEN_MARKER} {GEMINI_URL_MARKER} {GEMINI_QUERY_MARKER} {GEMINI_TRANSCRIPT_MARKER}"}}}}"#
        )
    }

    fn assert_no_gemini_marker(rendered: &str) {
        for marker in gemini_leak_markers() {
            assert!(
                !rendered.contains(marker),
                "provider marker {marker} survived into: {rendered}"
            );
        }
    }

    fn rendered_failure(failure: &agent_domain::BrainProviderFailure) -> String {
        format!(
            "{failure} {failure:?} {}",
            serde_json::to_string(failure).expect("a typed failure serializes")
        )
    }

    #[tokio::test]
    async fn invalid_gemini_header_is_nonretryable_provider_auth_failure() {
        // A key `HeaderValue` rejects can never reach the wire, so it is an auth
        // misconfiguration, never a retryable transport blip.
        let config = GeminiConfig {
            api_key: format!("{GEMINI_TOKEN_MARKER}\u{7f}\u{1}"),
            ..GeminiConfig::default()
        };
        let request = GeminiStreamRequest::new(&config, json!({ "contents": [] }))
            .expect("a non-empty key builds a request");
        let error = ReqwestGeminiSseClient::shared()
            .stream(request)
            .await
            .expect_err("an unusable credential cannot be sent");
        let failure = error.failure();

        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::ProviderAuthFailure
        );
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderAuthFailed
        );
        assert!(!failure.retry_eligible(), "{failure:?}");
        assert_eq!(failure.provider(), "gemini");
        assert!(
            failure.metadata().contains("stage=gemini"),
            "the typed Gemini stage must survive: {failure:?}"
        );
        assert_no_gemini_marker(&rendered_failure(failure));

        // The same taxonomy has to come out of a real 401 and a real 403, with
        // exactly one attempt and the allowlisted auth diagnostic code.
        for status in [401_u16, 403] {
            let attempts = Arc::new(Mutex::new(0_u32));
            let counted = attempts.clone();
            let app = Router::new().fallback(post(move || {
                let counted = counted.clone();
                async move {
                    *counted.lock().expect("attempt counter poisoned") += 1;
                    (
                        StatusCode::from_u16(status).unwrap(),
                        [("content-type", "application/json")],
                        hostile_gemini_error_body("PERMISSION_DENIED"),
                    )
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind local Gemini auth-status server");
            let base_url = format!("http://{}/v1beta/models", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                axum::serve(listener, app)
                    .await
                    .expect("serve local Gemini auth-status response");
            });

            let error = stream_gemini_attempt_events_collected(
                &ReqwestGeminiSseClient::shared(),
                &GeminiConfig {
                    api_key: "local-fixture".to_owned(),
                    base_url,
                    fallback_model_ids: Vec::new(),
                    ..GeminiConfig::default()
                },
                json!({ "contents": [] }),
            )
            .await
            .expect_err("an auth status is terminal")
            .error;
            server.abort();

            let failure = error.failure();
            assert_eq!(
                failure.failure_class(),
                BrainFailureClass::ProviderAuthFailure,
                "status {status}: {failure:?}"
            );
            assert_eq!(failure.stage(), BrainFailureStage::Gemini);
            assert!(!failure.retry_eligible(), "status {status}: {failure:?}");
            assert!(
                failure
                    .metadata()
                    .contains(&format!("http_status={status}")),
                "status {status}: {failure:?}"
            );
            assert!(
                failure.metadata().contains("error_kind=gemini_http_auth"),
                "status {status} must carry the allowlisted auth diagnostic code: {failure:?}"
            );
            assert_eq!(
                *attempts.lock().expect("attempt counter poisoned"),
                1,
                "an auth failure is never retried"
            );
            assert_no_gemini_marker(&rendered_failure(failure));
        }
    }

    #[tokio::test]
    async fn gemini_primary_and_fallback_http_diagnostics_are_bounded_and_redacted() {
        // The primary attempt is refused with an oversized hostile body, which
        // proves the bound; the fallback attempt is refused with a small hostile
        // body whose provider-authored status token proves the allowlist.
        let oversized = format!(
            r#"{{"error":{{"code":429,"status":"{GEMINI_BODY_MARKER}-oversize","message":"{}"}}}}"#,
            format!("{GEMINI_BODY_MARKER} {GEMINI_PROMPT_MARKER} {GEMINI_AUDIO_MARKER} {GEMINI_TOKEN_MARKER} {GEMINI_URL_MARKER} {GEMINI_QUERY_MARKER} {GEMINI_TRANSCRIPT_MARKER} ").repeat(2_048)
        );
        assert!(oversized.len() > 256 * 1024);
        let small = hostile_gemini_error_body(&format!("{GEMINI_BODY_MARKER}_status"));
        let app = Router::new().fallback(post(move |uri: axum::http::Uri| {
            let oversized = oversized.clone();
            let small = small.clone();
            async move {
                if uri.path().contains("gemini-3.5-flash") {
                    (
                        StatusCode::FORBIDDEN,
                        [("content-type", "application/json")],
                        small,
                    )
                } else {
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [("content-type", "application/json")],
                        oversized,
                    )
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local Gemini diagnostics server");
        let base_url = format!(
            "http://{}/v1beta/{GEMINI_URL_MARKER}/models",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve local Gemini diagnostics response");
        });

        let attempt_failure = stream_gemini_attempt_events_collected(
            &ReqwestGeminiSseClient::shared(),
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                base_url,
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "role": "user", "parts": [{ "text": GEMINI_PROMPT_MARKER }] }] }),
        )
        .await
        .expect_err("both attempts are refused");
        server.abort();

        // The fallback happened, and its own event is bounded too.
        let fallback = attempt_failure
            .events
            .iter()
            .find(|event| matches!(event, GeminiStreamEvent::FallbackActivated { .. }))
            .expect("the primary 429 activates the fallback");
        let GeminiStreamEvent::FallbackActivated {
            from_model,
            to_model,
            failure: fallback_failure,
            ..
        } = fallback
        else {
            unreachable!("matched above");
        };
        assert_eq!(from_model, "gemini-3.5-pro");
        assert_eq!(to_model, "gemini-3.5-flash");
        let fallback_failure = fallback_failure
            .as_ref()
            .expect("a fallback activation carries its originating failure");
        assert_eq!(
            fallback_failure.failure_class(),
            BrainFailureClass::QuotaRateFailure
        );
        assert!(fallback_failure.retry_eligible());
        assert!(
            fallback_failure.metadata().contains("http_status=429"),
            "{fallback_failure:?}"
        );
        assert!(
            fallback_failure
                .metadata()
                .contains("error_kind=gemini_http_rate_limited"),
            "the primary 429 must carry the allowlisted rate-limit code: {fallback_failure:?}"
        );
        assert!(
            fallback_failure.metadata().len() <= 240,
            "metadata must stay bounded: {fallback_failure:?}"
        );
        assert_no_gemini_marker(&rendered_failure(fallback_failure));
        assert_no_gemini_marker(&format!("{fallback:?}"));

        // The terminal failure is attributed to the model that actually ran.
        let failure = attempt_failure.error.failure();
        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::ProviderAuthFailure,
            "{failure:?}"
        );
        assert_eq!(failure.stage(), BrainFailureStage::Gemini);
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-35-flash");
        assert!(!failure.retry_eligible(), "{failure:?}");
        assert!(
            failure.metadata().contains("http_status=403"),
            "{failure:?}"
        );
        assert!(
            failure.metadata().contains("error_kind=gemini_http_auth"),
            "the fallback 403 must carry the allowlisted auth code: {failure:?}"
        );
        assert!(
            failure.metadata().len() <= 240,
            "metadata must stay bounded: {failure:?}"
        );
        assert_no_gemini_marker(&rendered_failure(failure));
    }

    #[tokio::test]
    async fn reqwest_stream_transport_429_reads_body_retry_info_when_header_missing() {
        let raw_body = r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}],"message":"UNSAFE_REQWEST_429_BODY_MARKER"}}"#;
        let app = Router::new().fallback(post(move || async move {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("content-type", "application/json")],
                raw_body,
            )
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local Gemini test server");
        let base_url = format!("http://{}/v1beta/models", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve local Gemini test response");
        });

        let error = stream_gemini_attempt_events_collected(
            &ReqwestGeminiSseClient::shared(),
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                model_id: "gemini-3.5-flash".to_owned(),
                base_url,
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err()
        .error;
        server.abort();

        let failure = error.failure();
        assert!(failure.metadata().contains("http_status=429"));
        assert!(failure.metadata().contains("retry_after_ms=30000"));
        assert!(failure
            .metadata()
            .contains("retry_after_source=body_retry_info"));
        assert!(failure
            .metadata()
            .contains("body_status=resource_exhausted"));
        assert!(!failure
            .metadata()
            .contains("UNSAFE_REQWEST_429_BODY_MARKER"));
        assert!(!failure
            .to_string()
            .contains("UNSAFE_REQWEST_429_BODY_MARKER"));
    }

    #[tokio::test]
    async fn reqwest_stream_transport_429_caps_error_body_and_preserves_headers() {
        let app = Router::new().fallback(post(|| async move {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [
                    ("content-type", "application/json"),
                    ("retry-after", "5"),
                    ("x-ratelimit-reset", "30"),
                ],
                format!(
                    r#"{{"error":{{"code":429,"status":"RESOURCE_EXHAUSTED","message":"{}"}}}}"#,
                    "UNSAFE_OVERSIZED_429_BODY_MARKER".repeat(512)
                ),
            )
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local Gemini oversized-body test server");
        let base_url = format!("http://{}/v1beta/models", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve local Gemini oversized-body test response");
        });

        let error = stream_gemini_attempt_events_collected(
            &ReqwestGeminiSseClient::shared(),
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                base_url,
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err()
        .error;
        server.abort();

        let failure = error.failure();
        assert!(failure.metadata().contains("http_status=429"));
        assert!(failure.metadata().contains("retry_after_ms=5000"));
        assert!(failure
            .metadata()
            .contains("retry_after_source=retry_after_delta"));
        assert!(failure.metadata().contains("reset_hint=relative_ms=30000"));
        assert!(failure.metadata().contains("body_status=unknown"));
        assert!(!failure
            .metadata()
            .contains("UNSAFE_OVERSIZED_429_BODY_MARKER"));
        assert!(!failure
            .to_string()
            .contains("UNSAFE_OVERSIZED_429_BODY_MARKER"));
    }

    #[tokio::test]
    async fn streaming_transport_429_parses_fractional_retry_info_body_delay() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 429,
                body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"1.500s"}]}}"#
                    .to_owned(),
                retry_after: None,
                reset_after: None,
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert!(failure.metadata().contains("retry_after_ms=1500"));
        assert!(failure
            .metadata()
            .contains("retry_after_source=body_retry_info"));
    }

    #[test]
    fn retry_after_header_wins_over_body_retry_info() {
        let body = r#"{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}"#;

        let hint = retry_after_hint(Some("7"), body);

        assert_eq!(hint.retry_after_ms, 7_000);
        assert_eq!(hint.source, "retry_after_delta");
    }

    #[test]
    fn invalid_retry_after_header_falls_back_to_body_retry_info() {
        let body = r#"{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}"#;

        let hint = retry_after_hint(Some("not a retry hint"), body);

        assert_eq!(hint.retry_after_ms, 30_000);
        assert_eq!(hint.source, "body_retry_info");
    }

    #[tokio::test]
    async fn streaming_transport_429_uses_sanitized_retry_text_body_when_header_missing() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 429,
                body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"fixture retry in 2 minutes"}}"#
                    .to_owned(),
                retry_after: None,
                reset_after: None,
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert!(failure.metadata().contains("retry_after_ms=120000"));
        assert!(failure
            .metadata()
            .contains("retry_after_source=body_retry_text"));
        assert!(!failure.metadata().contains("fixture retry"));
    }

    #[test]
    fn retry_text_body_hint_scans_past_unparseable_retry_words() {
        let body =
            r#"{"error":{"message":"fixture retry in about two minutes; retry in 2 minutes"}}"#;

        let hint = retry_after_hint(None, body);

        assert_eq!(hint.retry_after_ms, 120_000);
        assert_eq!(hint.source, "body_retry_text");
    }

    #[tokio::test]
    async fn streaming_transport_429_omits_non_time_reset_hint() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 429,
                body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                retry_after: Some("3".to_owned()),
                reset_after: Some("quota-account-abc123".to_owned()),
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert!(failure.metadata().contains("reset_hint=none"));
        assert!(!failure.metadata().contains("quota-account-abc123"));
    }

    #[tokio::test]
    async fn streaming_transport_429_accepts_relative_ratelimit_reset_hint() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 429,
                body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                retry_after: Some("3".to_owned()),
                reset_after: Some("30".to_owned()),
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert!(failure.metadata().contains("reset_hint=relative_ms=30000"));
    }

    #[test]
    fn gemini_429_body_read_failure_preserves_rate_limit_metadata() {
        let response = gemini_sse_response_from_http_parts(
            429,
            Some("5".to_owned()),
            Some("2030-01-01T00:00:00Z".to_owned()),
            Err(()),
        )
        .expect("429 body read failures should still carry status and headers");

        let error = gemini_rate_limit_stage_failure(
            &GeminiConfig {
                model_id: "gemini-3.5-flash".to_owned(),
                ..GeminiConfig::default()
            },
            &response,
            Duration::from_millis(42),
        );

        let failure = error.failure();
        assert_eq!(failure.failure_class(), BrainFailureClass::QuotaRateFailure);
        assert_eq!(
            failure.terminal_reason(),
            agent_domain::TerminalSessionReason::ProviderRateLimited
        );
        assert_eq!(failure.latency_ms(), 42);
        assert!(failure.metadata().contains("retry_after_ms=5000"));
        assert!(failure
            .metadata()
            .contains("reset_hint=2030-01-01T00:00:00Z"));
        assert!(failure.metadata().contains("body_status=unknown"));
    }

    #[test]
    fn non_success_body_read_failures_preserve_status_headers() {
        for status in [401_u16, 403, 503] {
            let response = gemini_sse_response_from_http_parts(
                status,
                Some("5".to_owned()),
                Some("2030-01-01T00:00:00Z".to_owned()),
                Err(()),
            )
            .expect("non-success body read failures should still carry status and headers");

            assert_eq!(response.status, status);
            assert_eq!(response.retry_after.as_deref(), Some("5"));
            assert_eq!(
                response.reset_after.as_deref(),
                Some("2030-01-01T00:00:00Z")
            );
            assert_eq!(response.body.bounded(), "");
        }
    }

    #[test]
    fn success_body_read_failure_remains_a_typed_transport_failure() {
        let error = gemini_sse_response_from_http_parts(200, None, None, Err(())).unwrap_err();
        let failure = error.failure();

        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert_eq!(failure.stage(), BrainFailureStage::Transport);
        assert_eq!(
            failure.metadata(),
            "stage=gemini error_kind=response_read_failed"
        );
    }

    #[tokio::test]
    async fn streaming_transport_falls_back_to_second_gemini_model_after_primary_429() {
        let client = SequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                RecordedResponse {
                    status: 429,
                    body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"raw primary body"}}"#
                        .to_owned(),
                    retry_after: Some("3".to_owned()),
                    reset_after: None,
                },
                RecordedResponse::ok(
                    r#"data: {"candidates":[{"content":{"parts":[{"text":"fallback feedback"}]}}]}"#
                        .to_owned(),
                ),
            ])),
        };

        let events = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "raw prompt" }] }] }),
        )
        .await
        .expect("fallback model succeeds");

        assert_fallback_activation(
            &events[0],
            "gemini-3.5-pro",
            "gemini-3.5-flash",
            "primary_429",
            3_000,
        );
        assert!(events.iter().any(|event| matches!(
            event,
            GeminiStreamEvent::ModelPart {
                text: Some(text),
                ..
            } if text == "fallback feedback"
        )));
        let captures = client.captures.lock().expect("capture lock poisoned");
        assert_eq!(captures.len(), 2);
        assert!(captures[0]
            .url
            .as_deref()
            .expect("primary request url")
            .contains("gemini-3.5-pro"));
        assert!(captures[1]
            .url
            .as_deref()
            .expect("fallback request url")
            .contains("gemini-3.5-flash"));
        assert!(!format!("{events:?}").contains("raw primary body"));
        assert!(!format!("{events:?}").contains("raw prompt"));
    }

    #[tokio::test]
    async fn streaming_transport_rebuilds_fallback_body_for_attempt_model_capabilities() {
        let primary_config = GeminiConfig {
            api_key: "gemini-test-key".to_owned(),
            model_id: "gemini-3.5-pro".to_owned(),
            fallback_model_ids: vec!["gemini-2.5-flash".to_owned()],
            thinking_level: ThinkingLevel::parse("low"),
            ..GeminiConfig::default()
        };
        let request = gemini_request(
            &primary_config,
            vec![json!({ "role": "user", "parts": [{ "text": "fixture-redacted-input" }] })],
            &[],
        );
        assert!(request
            .pointer("/generationConfig/thinkingConfig")
            .is_some());
        let client = SequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                RecordedResponse {
                    status: 429,
                    body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                    retry_after: Some("3".to_owned()),
                    reset_after: None,
                },
                RecordedResponse::ok(
                    r#"data: {"candidates":[{"content":{"parts":[{"text":"fixture-fallback-ok"}]}}]}"#
                        .to_owned(),
                ),
            ])),
        };

        stream_gemini_with_client(&client, &primary_config, request)
            .await
            .expect("fallback model succeeds");

        let captures = client.captures.lock().expect("capture lock poisoned");
        assert_eq!(captures.len(), 2);
        assert!(captures[0]
            .body
            .as_ref()
            .expect("primary body")
            .pointer("/generationConfig/thinkingConfig")
            .is_some());
        assert!(captures[1]
            .body
            .as_ref()
            .expect("fallback body")
            .pointer("/generationConfig/thinkingConfig")
            .is_none());
    }

    #[tokio::test]
    async fn streaming_transport_reapplies_thinking_config_for_upgraded_fallback() {
        let primary_config = GeminiConfig {
            api_key: "gemini-test-key".to_owned(),
            model_id: "gemini-2.5-flash".to_owned(),
            fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
            thinking_level: ThinkingLevel::parse("low"),
            ..GeminiConfig::default()
        };
        let request = gemini_request(
            &primary_config,
            vec![json!({ "role": "user", "parts": [{ "text": "fixture-redacted-input" }] })],
            &[],
        );
        assert!(request
            .pointer("/generationConfig/thinkingConfig")
            .is_none());
        let client = SequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                RecordedResponse {
                    status: 429,
                    body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                    retry_after: Some("2".to_owned()),
                    reset_after: None,
                },
                RecordedResponse::ok(
                    r#"data: {"candidates":[{"content":{"parts":[{"text":"fixture-fallback-ok"}]}}]}"#
                        .to_owned(),
                ),
            ])),
        };

        stream_gemini_with_client(&client, &primary_config, request)
            .await
            .expect("upgraded fallback model succeeds");

        let captures = client.captures.lock().expect("capture lock poisoned");
        assert_eq!(captures.len(), 2);
        assert!(captures[0]
            .body
            .as_ref()
            .expect("primary body")
            .pointer("/generationConfig/thinkingConfig")
            .is_none());
        assert_eq!(
            captures[1]
                .body
                .as_ref()
                .expect("fallback body")
                .pointer("/generationConfig/thinkingConfig/thinkingLevel"),
            Some(&json!("LOW"))
        );
    }

    #[tokio::test]
    async fn streaming_transport_shares_stage_deadline_across_fallback_attempts() {
        let client = DelayedSequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                (
                    Duration::from_millis(40),
                    RecordedResponse {
                        status: 429,
                        body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                        retry_after: Some("1".to_owned()),
                        reset_after: None,
                    },
                ),
                (
                    Duration::from_millis(40),
                    RecordedResponse::ok(
                        r#"data: {"candidates":[{"content":{"parts":[{"text":"fixture-late"}]}}]}"#
                            .to_owned(),
                    ),
                ),
            ])),
        };
        let started = std::time::Instant::now();

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                stage_timeout: Duration::from_millis(60),
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "fixture-redacted-input" }] }] }),
        )
        .await
        .unwrap_err();

        assert!(started.elapsed() < Duration::from_millis(120));
        let failure = error.failure();
        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(
            failure.terminal_reason(),
            agent_domain::TerminalSessionReason::ProviderTimeout
        );
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-35-flash");
        assert_eq!(
            client.captures.lock().expect("capture lock poisoned").len(),
            2
        );
    }

    #[tokio::test]
    async fn streaming_transport_attributes_fallback_status_failure_to_attempt_model() {
        let client = SequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                RecordedResponse {
                    status: 429,
                    body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                    retry_after: Some("1".to_owned()),
                    reset_after: None,
                },
                RecordedResponse {
                    status: 503,
                    body: r#"{"error":{"status":"UNAVAILABLE"}}"#.to_owned(),
                    retry_after: Some("5".to_owned()),
                    reset_after: None,
                },
            ])),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-2.5-flash".to_owned()],
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "fixture-redacted-input" }] }] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderNetworkDisconnect
        );
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-25-flash");
        assert!(failure.metadata().contains("http_status=503"));
        assert!(failure.metadata().contains("body_status=unavailable"));
        assert!(!failure.to_string().contains("fixture-redacted-input"));
    }

    #[tokio::test]
    async fn streaming_transport_reports_fallback_activation_before_fallback_status_failure() {
        let client = SequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                RecordedResponse {
                    status: 429,
                    body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                    retry_after: Some("1".to_owned()),
                    reset_after: None,
                },
                RecordedResponse {
                    status: 503,
                    body: r#"{"error":{"status":"UNAVAILABLE"}}"#.to_owned(),
                    retry_after: Some("5".to_owned()),
                    reset_after: None,
                },
            ])),
        };

        let failure = stream_gemini_attempt_events_collected(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-2.5-flash".to_owned()],
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "fixture-redacted-input" }] }] }),
        )
        .await
        .unwrap_err();

        assert_eq!(failure.events.len(), 1);
        assert_fallback_activation(
            &failure.events[0],
            "gemini-3.5-pro",
            "gemini-2.5-flash",
            "primary_429",
            1_000,
        );
        let stage_failure = failure.error.failure();
        assert_eq!(
            stage_failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert_eq!(
            stage_failure.terminal_reason(),
            TerminalSessionReason::ProviderNetworkDisconnect
        );
        assert_eq!(stage_failure.model(), "gemini-25-flash");
        assert!(!stage_failure.to_string().contains("fixture-redacted-input"));
    }

    #[tokio::test]
    async fn streaming_transport_attributes_fallback_empty_response_to_attempt_model() {
        let client = SequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                RecordedResponse {
                    status: 429,
                    body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                    retry_after: Some("1".to_owned()),
                    reset_after: None,
                },
                RecordedResponse::ok("   ".to_owned()),
            ])),
        };

        let failure = stream_gemini_attempt_events_collected(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-2.5-flash".to_owned()],
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "fixture-redacted-input" }] }] }),
        )
        .await
        .unwrap_err();

        assert_eq!(failure.events.len(), 1);
        assert_fallback_activation(
            &failure.events[0],
            "gemini-3.5-pro",
            "gemini-2.5-flash",
            "primary_429",
            1_000,
        );
        let stage_failure = failure.error.failure();
        assert_eq!(
            stage_failure.failure_class(),
            BrainFailureClass::MalformedStream
        );
        assert_eq!(stage_failure.provider(), "gemini");
        assert_eq!(stage_failure.model(), "gemini-25-flash");
        assert!(stage_failure.metadata().contains("error_kind=empty_stream"));
        assert!(!stage_failure.to_string().contains("fixture-redacted-input"));
    }

    #[tokio::test]
    async fn streaming_transport_rejects_fallback_streams_with_no_parsed_events() {
        let client = SequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                RecordedResponse {
                    status: 429,
                    body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                    retry_after: Some("1".to_owned()),
                    reset_after: None,
                },
                RecordedResponse::ok("data: [DONE]\n\n".to_owned()),
            ])),
        };

        let failure = stream_gemini_attempt_events_collected(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-2.5-flash".to_owned()],
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "fixture-redacted-input" }] }] }),
        )
        .await
        .unwrap_err();

        assert_eq!(failure.events.len(), 1);
        assert_fallback_activation(
            &failure.events[0],
            "gemini-3.5-pro",
            "gemini-2.5-flash",
            "primary_429",
            1_000,
        );
        let stage_failure = failure.error.failure();
        assert_eq!(
            stage_failure.failure_class(),
            BrainFailureClass::MalformedStream
        );
        assert_eq!(stage_failure.provider(), "gemini");
        assert_eq!(stage_failure.model(), "gemini-25-flash");
        assert!(stage_failure.metadata().contains("error_kind=empty_stream"));
    }

    #[tokio::test]
    async fn streaming_transport_attributes_fallback_timeout_to_attempt_model() {
        let client = DelayedSequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                (
                    Duration::from_millis(1),
                    RecordedResponse {
                        status: 429,
                        body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                        retry_after: Some("1".to_owned()),
                        reset_after: None,
                    },
                ),
                (
                    Duration::from_millis(100),
                    RecordedResponse::ok(
                        r#"data: {"candidates":[{"content":{"parts":[{"text":"fixture-late"}]}}]}"#
                            .to_owned(),
                    ),
                ),
            ])),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                stage_timeout: Duration::from_millis(20),
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "fixture-redacted-input" }] }] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(
            failure.terminal_reason(),
            agent_domain::TerminalSessionReason::ProviderTimeout
        );
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-35-flash");
        assert!(failure.retry_eligible());
        assert!(!failure.to_string().contains("fixture-redacted-input"));
    }

    #[tokio::test]
    async fn streaming_transport_attributes_expired_fallback_deadline_to_attempt_model() {
        let client = BlockingRateLimitGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            delay: Duration::from_millis(5),
        };

        let failure = stream_gemini_attempt_events_collected(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-3.5-flash".to_owned()],
                stage_timeout: Duration::from_millis(1),
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "fixture-redacted-input" }] }] }),
        )
        .await
        .unwrap_err();

        assert_eq!(failure.events.len(), 1);
        assert_fallback_activation(
            &failure.events[0],
            "gemini-3.5-pro",
            "gemini-3.5-flash",
            "primary_429",
            1_000,
        );
        assert_eq!(
            client.captures.lock().expect("capture lock poisoned").len(),
            1,
            "fallback request should not be sent after the shared deadline expires"
        );
        let failure = failure.error.failure();
        assert_eq!(failure.failure_class(), BrainFailureClass::Timeout);
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-35-flash");
        assert!(failure.retry_eligible());
        assert!(!failure.to_string().contains("fixture-redacted-input"));
    }

    #[tokio::test]
    async fn streaming_transport_attributes_fallback_client_error_to_attempt_model() {
        let client = FallibleSequencedGeminiSseClient {
            captures: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                Ok(RecordedResponse {
                    status: 429,
                    body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                    retry_after: Some("1".to_owned()),
                    reset_after: None,
                }),
                Err(fixture_transport_failure()),
            ])),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                model_id: "gemini-3.5-pro".to_owned(),
                fallback_model_ids: vec!["gemini-2.5-flash".to_owned()],
                ..GeminiConfig::default()
            },
            json!({ "contents": [{ "parts": [{ "text": "fixture-redacted-input" }] }] }),
        )
        .await
        .unwrap_err();

        let failure = error.failure();
        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert_eq!(failure.provider(), "gemini");
        assert_eq!(failure.model(), "gemini-25-flash");
        assert!(failure.retry_eligible());
        assert!(!failure.to_string().contains("fixture-redacted-input"));
    }

    #[tokio::test]
    async fn streaming_transport_503_redacts_unclassified_status_and_body() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 503,
                body: r#"{"error":{"message":"UNSAFE_503_BODY_MARKER"}}"#.to_owned(),
                retry_after: Some("5".to_owned()),
                reset_after: None,
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(
            failure.failure_class(),
            BrainFailureClass::NetworkDisconnect
        );
        assert!(failure.metadata().contains("http_status=503"));
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("UNSAFE_503_BODY_MARKER"));
        assert!(!rendered.contains("local-fixture"));
    }

    #[tokio::test]
    async fn streaming_transport_404_preserves_protocol_status_and_redacts_body() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(RecordedResponse {
                status: 404,
                body: r#"{"error":{"message":"UNSAFE_404_BODY_MARKER"}}"#.to_owned(),
                retry_after: None,
                reset_after: None,
            }),
        };

        let error = stream_gemini_with_client(
            &client,
            &GeminiConfig {
                api_key: "local-fixture".to_owned(),
                ..GeminiConfig::default()
            },
            json!({ "contents": [] }),
        )
        .await
        .unwrap_err();
        let failure = error.failure();

        assert_eq!(failure.failure_class(), BrainFailureClass::MalformedStream);
        assert!(failure.metadata().contains("http_status=404"));
        assert!(!failure.retry_eligible());
        let rendered = format!("{error} {failure:?}");
        assert!(!rendered.contains("UNSAFE_404_BODY_MARKER"));
        assert!(!rendered.contains("local-fixture"));
    }

    #[test]
    fn retry_after_http_date_is_parsed_as_sanitized_backoff_hint() {
        let future = SystemTime::now() + Duration::from_secs(60);
        let header = httpdate::fmt_http_date(future);
        let hint = retry_after_hint(Some(&header), "");

        assert_eq!(hint.source, "retry_after_http_date");
        assert!(hint.retry_after_ms > 0);
    }

    #[test]
    fn reset_hint_rejects_invalid_or_out_of_range_dates() {
        assert_eq!(sanitized_reset_hint("2030-02-31T00:00:00Z"), None);

        let out_of_range_http_date =
            httpdate::fmt_http_date(std::time::UNIX_EPOCH + Duration::from_secs(4_102_444_801));
        assert_eq!(sanitized_reset_hint(&out_of_range_http_date), None);
    }

    #[derive(Default)]
    struct GeminiRequestCapture {
        url: Option<String>,
        api_key: Option<String>,
        body: Option<Value>,
    }

    struct RecordingGeminiSseClient {
        capture: Arc<Mutex<GeminiRequestCapture>>,
        response: RecordingGeminiResponse,
    }

    struct SequencedGeminiSseClient {
        captures: Arc<Mutex<Vec<GeminiRequestCapture>>>,
        responses: Arc<Mutex<Vec<RecordedResponse>>>,
    }

    struct DelayedSequencedGeminiSseClient {
        captures: Arc<Mutex<Vec<GeminiRequestCapture>>>,
        responses: Arc<Mutex<Vec<(Duration, RecordedResponse)>>>,
    }

    struct BlockingRateLimitGeminiSseClient {
        captures: Arc<Mutex<Vec<GeminiRequestCapture>>>,
        delay: Duration,
    }

    struct FallibleSequencedGeminiSseClient {
        captures: Arc<Mutex<Vec<GeminiRequestCapture>>>,
        responses: Arc<Mutex<Vec<Result<RecordedResponse, BrainError>>>>,
    }

    struct DelayedGeminiSseClient;

    #[derive(Clone)]
    enum RecordingGeminiResponse {
        Body(String),
        Response(RecordedResponse),
        Error(#[allow(dead_code)] String),
    }

    #[async_trait]
    impl GeminiSseClient for RecordingGeminiSseClient {
        async fn stream(
            &self,
            request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            let mut capture = self.capture.lock().expect("capture lock poisoned");
            capture.url = Some(request.url);
            capture.api_key = Some(request.api_key);
            capture.body = Some(request.body);
            drop(capture);
            match &self.response {
                RecordingGeminiResponse::Body(body) => {
                    Ok(RecordedResponse::ok(body.clone()).build())
                }
                RecordingGeminiResponse::Response(response) => Ok(response.build()),
                RecordingGeminiResponse::Error(_) => Err(fixture_transport_failure()),
            }
        }
    }

    #[async_trait]
    impl GeminiSseClient for SequencedGeminiSseClient {
        async fn stream(
            &self,
            request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            self.captures
                .lock()
                .expect("captures lock poisoned")
                .push(GeminiRequestCapture {
                    url: Some(request.url),
                    api_key: Some(request.api_key),
                    body: Some(request.body),
                });
            Ok(self
                .responses
                .lock()
                .expect("responses lock poisoned")
                .remove(0)
                .build())
        }
    }

    #[async_trait]
    impl GeminiSseClient for FallibleSequencedGeminiSseClient {
        async fn stream(
            &self,
            request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            self.captures
                .lock()
                .expect("captures lock poisoned")
                .push(GeminiRequestCapture {
                    url: Some(request.url),
                    api_key: Some(request.api_key),
                    body: Some(request.body),
                });
            self.responses
                .lock()
                .expect("responses lock poisoned")
                .remove(0)
                .map(|response| response.build())
        }
    }

    #[async_trait]
    impl GeminiSseClient for BlockingRateLimitGeminiSseClient {
        async fn stream(
            &self,
            request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            self.captures
                .lock()
                .expect("captures lock poisoned")
                .push(GeminiRequestCapture {
                    url: Some(request.url),
                    api_key: Some(request.api_key),
                    body: Some(request.body),
                });
            std::thread::sleep(self.delay);
            Ok(RecordedResponse {
                status: 429,
                body: r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                retry_after: Some("1".to_owned()),
                reset_after: None,
            }
            .build())
        }
    }

    #[async_trait]
    impl GeminiSseClient for DelayedSequencedGeminiSseClient {
        async fn stream(
            &self,
            request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            self.captures
                .lock()
                .expect("captures lock poisoned")
                .push(GeminiRequestCapture {
                    url: Some(request.url),
                    api_key: Some(request.api_key),
                    body: Some(request.body),
                });
            let (delay, response) = self
                .responses
                .lock()
                .expect("responses lock poisoned")
                .remove(0);
            tokio::time::sleep(delay).await;
            Ok(response.build())
        }
    }

    #[async_trait]
    impl GeminiSseClient for DelayedGeminiSseClient {
        async fn stream(
            &self,
            _request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(RecordedResponse::ok(
                r#"data: {"candidates":[{"content":{"parts":[{"text":"too late"}]}}]}"#.to_owned(),
            )
            .build())
        }
    }
}

/// The instruction the provider-backed evaluator is bound by.
///
/// It asks for criterion-level verdicts and nothing else. There is deliberately
/// no place in the schema for a label, a score, a status, a concept, a due date,
/// or a recap: `LEARN-002` derives every one of those on the server from the
/// verdicts below, and a payload that volunteers one is refused rather than
/// mapped or ignored.
const VIVA_EVALUATION_INSTRUCTION: &str = concat!(
    "You are a criterion checker. The user message is one JSON EvaluationRequest. ",
    "Reply with one JSON object and no prose. Either ",
    r#"{"kind":"evaluated","assessments":[{"criterion_id":<id from the rubric>,"#,
    r#""assessment":"satisfied"|"contradicted"|"not_demonstrated","confidence":<0..1>}],"#,
    r#""concise_feedback":<one short sentence>,"retry_prompt":<one short sentence or null>} "#,
    "with exactly one assessment per rubric criterion, or ",
    r#"{"kind":"deferred","reason":"insufficient_semantic_evidence"|"contradictory_evidence","#,
    r#""can_retry_same_question":true}. "#,
    "Never include a label, grade, score, status, concept, review date, or any other field.",
);

/// The live [`AnswerEvaluator`] (`ADAPTER-01`).
///
/// It moves the model's criterion verdicts across the wire and stops there. It
/// derives no `EvaluationLabel`, no confidence aggregate, no concept status, no
/// schedule, and no recap; the Plan 04 executor owns every one of those, binds
/// the verdicts to the authorized rubric, and decides what is persisted. Every
/// unusable provider answer becomes a typed [`EvaluationError`], which the
/// executor turns into a persisted deferral.
pub(crate) struct GeminiAnswerEvaluator {
    client: Arc<dyn GeminiSseClient>,
    config: GeminiConfig,
}

impl GeminiAnswerEvaluator {
    /// The live composition, on the session's shared HTTP connection pool.
    ///
    /// `ADAPTER-04`: the evaluator and the streaming tool loop are two uses of
    /// the same Gemini endpoint, so they share one pool. Evaluator semantics are
    /// unchanged by where the connection comes from.
    pub(crate) fn live(config: &GeminiConfig, client: Arc<ReqwestGeminiSseClient>) -> Self {
        Self {
            client,
            config: config.clone(),
        }
    }

    /// The injectable seam this lane already owned.
    #[cfg(test)]
    pub(crate) fn with_client(client: Arc<dyn GeminiSseClient>, config: GeminiConfig) -> Self {
        Self { client, config }
    }
}

#[async_trait]
impl AnswerEvaluator for GeminiAnswerEvaluator {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationDecision, EvaluationError> {
        let stream_request =
            GeminiStreamRequest::new(&self.config, gemini_evaluation_request_body(request))
                .map_err(|_| EvaluationError::Unavailable)?;
        let response = timeout(
            self.config.stage_timeout,
            self.client.stream(stream_request),
        )
        .await
        .map_err(|_| EvaluationError::Timeout)?
        .map_err(|_| EvaluationError::Unavailable)?;
        if !(200..300).contains(&response.status) {
            return Err(EvaluationError::Unavailable);
        }
        parse_gemini_evaluation_decision(
            &gemini_evaluation_model_text(response.body).await?,
            &request.question.rubric,
        )
    }
}

/// Only Plan 04's server-bound `EvaluationRequest` crosses the wire.
fn gemini_evaluation_request_body(request: &EvaluationRequest) -> Value {
    let payload = serde_json::to_value(request).unwrap_or(Value::Null);
    json!({
        "systemInstruction": { "parts": [{ "text": VIVA_EVALUATION_INSTRUCTION }] },
        "contents": [{ "role": "user", "parts": [{ "text": payload.to_string() }] }],
        "generationConfig": { "responseMimeType": "application/json" },
    })
}

/// The evaluator's answer is one bounded JSON object, not speech, so its text
/// is collected — within an explicit bound — rather than spoken incrementally.
async fn gemini_evaluation_model_text(body: GeminiResponseBody) -> Result<String, EvaluationError> {
    let mut text = String::new();
    match body {
        GeminiResponseBody::Bounded(bounded) => {
            push_bounded_model_text(&mut text, &gemini_stream_model_text(&bounded))?;
        }
        GeminiResponseBody::Stream(mut stream) => {
            let mut decoder = GeminiSseDecoder::default();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|()| EvaluationError::Unavailable)?;
                decoder
                    .push(&chunk)
                    .map_err(|()| EvaluationError::MalformedResponse)?;
                while let Some(record) = decoder.next_record() {
                    push_bounded_model_text(&mut text, &gemini_stream_model_text(&record))?;
                }
            }
            if let Some(record) = decoder.finish() {
                push_bounded_model_text(&mut text, &gemini_stream_model_text(&record))?;
            }
        }
    }
    Ok(text)
}

fn push_bounded_model_text(text: &mut String, part: &str) -> Result<(), EvaluationError> {
    if text.len().saturating_add(part.len()) > MAX_GEMINI_SSE_EVENT_BYTES {
        return Err(EvaluationError::MalformedResponse);
    }
    text.push_str(part);
    Ok(())
}

fn gemini_stream_model_text(body: &str) -> String {
    parse_gemini_sse_stream(body)
        .into_iter()
        .filter_map(|event| match event {
            GeminiStreamEvent::ModelPart { text, .. } => text,
            _ => None,
        })
        .collect()
}

fn parse_gemini_evaluation_decision(
    text: &str,
    rubric: &agent_domain::EvaluationRubricV1,
) -> Result<EvaluationDecision, EvaluationError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(EvaluationError::MalformedResponse);
    }
    let value: Value =
        serde_json::from_str(trimmed).map_err(|_| EvaluationError::MalformedResponse)?;
    // A provider-supplied label is refused outright. Being overruled in silence
    // would teach the caller nothing, and mapping it would hand the model the
    // one derivation `viva.semantic-rubric.v1` reserves for the server.
    if value.get("label").is_some() {
        return Err(EvaluationError::ContractViolation);
    }
    let decision: EvaluationDecision =
        serde_json::from_value(value).map_err(|_| EvaluationError::MalformedResponse)?;
    if let EvaluationDecision::Evaluated {
        assessments,
        concise_feedback,
        ..
    } = &decision
    {
        validate_gemini_assessments(assessments, rubric)?;
        if concise_feedback.trim().is_empty() {
            return Err(EvaluationError::ContractViolation);
        }
    }
    Ok(decision)
}

/// Exactly one finite in-range verdict per authorized criterion. Equal
/// cardinality plus equal id sets is precisely "assessed once each", so a
/// duplicate, an unknown id, and a missing criterion are all caught here rather
/// than becoming a partial grade downstream.
fn validate_gemini_assessments(
    assessments: &[CriterionAssessment],
    rubric: &agent_domain::EvaluationRubricV1,
) -> Result<(), EvaluationError> {
    let rubric_ids = rubric
        .criteria
        .iter()
        .map(|criterion| criterion.criterion_id.as_str())
        .collect::<BTreeSet<_>>();
    let assessed_ids = assessments
        .iter()
        .map(|assessment| assessment.criterion_id.as_str())
        .collect::<BTreeSet<_>>();
    if assessments.is_empty()
        || assessments.len() != rubric.criteria.len()
        || assessed_ids != rubric_ids
    {
        return Err(EvaluationError::ContractViolation);
    }
    if assessments.iter().any(|assessment| {
        !assessment.confidence.is_finite() || !(0.0..=1.0).contains(&assessment.confidence)
    }) {
        return Err(EvaluationError::ContractViolation);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Task 1 (`ADAPTER-01`): the live provider-backed `AnswerEvaluator`. It carries
// the model's criterion verdicts across the wire and nothing else — no label,
// no grade, no status, no concept, no schedule, no recap.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod live_evaluator_tests {
    use std::sync::{Arc, Mutex};

    use agent_domain::{
        AnswerEvaluator, CriterionAssessmentKind, EvaluationDecision, EvaluationDeferralReason,
        EvaluationError, EvaluationRequest, EvaluationRubricV1, RubricCriterionV1,
        SourceConfidence, StudyQuestion, StudySourceReference,
    };
    use serde_json::json;

    use super::*;

    #[derive(Clone, Default)]
    struct RecordingEvaluatorClient {
        requests: Arc<Mutex<Vec<Value>>>,
        responses: Arc<Mutex<Vec<Result<String, ()>>>>,
    }

    impl RecordingEvaluatorClient {
        fn scripted(body: &str) -> Self {
            let client = Self::default();
            client
                .responses
                .lock()
                .expect("response lock poisoned")
                .push(Ok(body.to_owned()));
            client
        }

        fn requests(&self) -> Vec<Value> {
            self.requests.lock().expect("request lock poisoned").clone()
        }
    }

    #[async_trait]
    impl GeminiSseClient for RecordingEvaluatorClient {
        async fn stream(
            &self,
            request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            self.requests
                .lock()
                .expect("request lock poisoned")
                .push(request.body.clone());
            let next = self
                .responses
                .lock()
                .expect("response lock poisoned")
                .pop()
                .unwrap_or(Ok(String::new()));
            match next {
                Ok(body) => Ok(GeminiSseResponse::ok(body)),
                Err(()) => Err(BrainError::from_failure(BrainProviderFailure::new(
                    BrainProviderFailureParts {
                        failure_class: agent_domain::BrainFailureClass::NetworkDisconnect,
                        stage: agent_domain::BrainFailureStage::Gemini,
                        retry_eligible: true,
                        latency_ms: 1,
                        provider: "gemini".to_owned(),
                        model: "gemini-test-model".to_owned(),
                        metadata: "error_kind=network_disconnect".to_owned(),
                    },
                ))),
            }
        }
    }

    fn evaluator_rubric() -> EvaluationRubricV1 {
        EvaluationRubricV1 {
            policy_version: agent_domain::learning_outcome::VIVA_SEMANTIC_RUBRIC_POLICY_VERSION
                .to_owned(),
            criteria: vec![
                RubricCriterionV1 {
                    criterion_id: "crit-one".to_owned(),
                    concept_id: "concept-one".to_owned(),
                    claim: "The first claim.".to_owned(),
                    source_id: "src-one".to_owned(),
                    required: true,
                },
                RubricCriterionV1 {
                    criterion_id: "crit-two".to_owned(),
                    concept_id: "concept-one".to_owned(),
                    claim: "The second claim.".to_owned(),
                    source_id: "src-one".to_owned(),
                    required: false,
                },
            ],
        }
    }

    fn evaluation_request() -> EvaluationRequest {
        EvaluationRequest {
            response_id: "response-1".to_owned(),
            question: StudyQuestion {
                question_id: "q-1".to_owned(),
                concept_id: "concept-one".to_owned(),
                prompt: "State the two claims.".to_owned(),
                expected_terms: Vec::new(),
                follow_up: "Say the second claim.".to_owned(),
                rubric: evaluator_rubric(),
                source: StudySourceReference {
                    source_id: "src-one".to_owned(),
                    document_id: "doc-1".to_owned(),
                    span: "page:1".to_owned(),
                    excerpt: "the bound claim".to_owned(),
                    confidence: SourceConfidence::High,
                    retrieval_reason: "server-bound rubric source".to_owned(),
                },
            },
            answer_text: "the learner answer".to_owned(),
            transcript_confidence: Some(0.88),
        }
    }

    fn sse_body(payload: Value) -> String {
        let text = payload.to_string();
        format!(
            "data: {}\n\n",
            json!({ "candidates": [{ "content": { "parts": [{ "text": text }] } }] })
        )
    }

    fn evaluator(client: RecordingEvaluatorClient) -> GeminiAnswerEvaluator {
        GeminiAnswerEvaluator::with_client(
            Arc::new(client),
            GeminiConfig {
                api_key: "gemini-test-key".to_owned(),
                ..GeminiConfig::default()
            },
        )
    }

    #[tokio::test]
    async fn live_gemini_evaluator_returns_typed_model_decisions_without_grading() {
        let request = evaluation_request();

        let evaluated_client = RecordingEvaluatorClient::scripted(&sse_body(json!({
            "kind": "evaluated",
            "assessments": [
                { "criterion_id": "crit-one", "assessment": "satisfied", "confidence": 0.91 },
                { "criterion_id": "crit-two", "assessment": "not_demonstrated", "confidence": 0.72 },
            ],
            "concise_feedback": "The first claim held; the second was not shown.",
            "retry_prompt": null,
        })));
        let decision = evaluator(evaluated_client.clone())
            .evaluate(&request)
            .await
            .expect("an evaluated decision deserializes");
        let EvaluationDecision::Evaluated {
            assessments,
            concise_feedback,
            retry_prompt,
        } = decision
        else {
            panic!("expected an evaluated decision");
        };
        assert_eq!(assessments.len(), 2);
        assert_eq!(assessments[0].criterion_id, "crit-one");
        assert_eq!(
            assessments[0].assessment,
            CriterionAssessmentKind::Satisfied
        );
        assert_eq!(assessments[1].criterion_id, "crit-two");
        assert_eq!(
            assessments[1].assessment,
            CriterionAssessmentKind::NotDemonstrated
        );
        assert_eq!(
            concise_feedback,
            "The first claim held; the second was not shown."
        );
        assert_eq!(retry_prompt, None);

        // Only Plan 04's server-bound `EvaluationRequest` crosses the wire.
        let requests = evaluated_client.requests();
        assert_eq!(requests.len(), 1);
        let serialized = requests[0].to_string();
        let bound: EvaluationRequest =
            serde_json::from_str(&serde_json::to_string(&request).expect("request serializes"))
                .expect("round trip");
        assert_eq!(bound.response_id, request.response_id);
        assert!(serialized.contains("crit-one"));
        assert!(serialized.contains(&request.answer_text));

        let deferred_client = RecordingEvaluatorClient::scripted(&sse_body(json!({
            "kind": "deferred",
            "reason": "insufficient_semantic_evidence",
            "can_retry_same_question": true,
        })));
        let decision = evaluator(deferred_client)
            .evaluate(&request)
            .await
            .expect("a deferred decision deserializes");
        assert_eq!(
            decision,
            EvaluationDecision::Deferred {
                reason: EvaluationDeferralReason::InsufficientSemanticEvidence,
                can_retry_same_question: true,
            }
        );

        // Malformed, empty, incomplete-criteria and non-finite payloads are all
        // typed evaluator errors; none of them becomes a grade here.
        for (body, expected) in [
            (
                "data: not json\n\n".to_owned(),
                EvaluationError::MalformedResponse,
            ),
            (String::new(), EvaluationError::MalformedResponse),
            (
                sse_body(json!({
                    "kind": "evaluated",
                    "assessments": [
                        { "criterion_id": "crit-one", "assessment": "satisfied", "confidence": 0.91 },
                    ],
                    "concise_feedback": "only one criterion",
                    "retry_prompt": null,
                })),
                EvaluationError::ContractViolation,
            ),
            (
                sse_body(json!({
                    "kind": "evaluated",
                    "assessments": [
                        { "criterion_id": "crit-one", "assessment": "satisfied", "confidence": 0.91 },
                        { "criterion_id": "crit-one", "assessment": "satisfied", "confidence": 0.91 },
                    ],
                    "concise_feedback": "duplicate criterion",
                    "retry_prompt": null,
                })),
                EvaluationError::ContractViolation,
            ),
            (
                sse_body(json!({
                    "kind": "evaluated",
                    "assessments": [
                        { "criterion_id": "crit-one", "assessment": "satisfied", "confidence": 2.5 },
                        { "criterion_id": "crit-two", "assessment": "satisfied", "confidence": 0.7 },
                    ],
                    "concise_feedback": "non-finite range",
                    "retry_prompt": null,
                })),
                EvaluationError::ContractViolation,
            ),
            (
                sse_body(json!({
                    "kind": "evaluated",
                    "assessments": [
                        { "criterion_id": "crit-unknown", "assessment": "satisfied", "confidence": 0.9 },
                        { "criterion_id": "crit-two", "assessment": "satisfied", "confidence": 0.9 },
                    ],
                    "concise_feedback": "unknown criterion",
                    "retry_prompt": null,
                })),
                EvaluationError::ContractViolation,
            ),
        ] {
            let error = evaluator(RecordingEvaluatorClient::scripted(&body))
                .evaluate(&request)
                .await
                .expect_err("invalid provider output is a typed evaluator error");
            assert_eq!(error, expected, "body: {body}");
        }
    }

    #[tokio::test]
    async fn live_gemini_evaluator_rejects_provider_supplied_label() {
        let request = evaluation_request();
        for label in [
            "strong",
            "mostly_correct",
            "partially_correct",
            "vague",
            "wrong",
            "insufficient_evidence",
        ] {
            let body = sse_body(json!({
                "kind": "evaluated",
                "label": label,
                "assessments": [
                    { "criterion_id": "crit-one", "assessment": "satisfied", "confidence": 0.91 },
                    { "criterion_id": "crit-two", "assessment": "satisfied", "confidence": 0.9 },
                ],
                "concise_feedback": "an otherwise valid payload",
                "retry_prompt": null,
            }));
            let error = evaluator(RecordingEvaluatorClient::scripted(&body))
                .evaluate(&request)
                .await
                .expect_err("a provider-supplied label is rejected, never mapped or ignored");
            assert_eq!(
                error,
                EvaluationError::ContractViolation,
                "label `{label}` must be refused"
            );
        }
    }
}
