use std::{
    fmt,
    time::{Duration, Instant, SystemTime},
};

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, RETRY_AFTER};
use serde_json::{json, Value};
use tokio::time::timeout;

use agent_domain::{
    BrainError, BrainProviderFailure, BrainProviderFailureParts, TerminalSessionReason, ToolResult,
};

use super::constants::{
    DEFAULT_GEMINI_BASE_URL, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_THINKING_LEVEL,
};

const TRUSTED_SOURCE_CONTEXT_FUNCTION: &str = "trusted_source_context";
const DEFAULT_GEMINI_RETRY_AFTER_MS: u64 = 1_000;
const GEMINI_ERROR_BODY_READ_TIMEOUT: Duration = Duration::from_millis(250);

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
    Error(String),
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
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
            return Err(BrainError::MissingApiKey);
        }

        Ok(Self {
            url: config.stream_url(),
            api_key: api_key.to_owned(),
            body,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GeminiSseResponse {
    pub(crate) status: u16,
    pub(crate) body: String,
    pub(crate) retry_after: Option<String>,
    pub(crate) reset_after: Option<String>,
}

impl GeminiSseResponse {
    #[cfg(test)]
    pub(crate) fn ok(body: String) -> Self {
        Self {
            status: 200,
            body,
            retry_after: None,
            reset_after: None,
        }
    }
}

#[async_trait]
pub(crate) trait GeminiSseClient: Send + Sync {
    async fn stream(&self, request: GeminiStreamRequest) -> Result<GeminiSseResponse, BrainError>;
}

pub(crate) async fn stream_gemini_with_client<C>(
    client: &C,
    config: &GeminiConfig,
    request: Value,
) -> Result<Vec<GeminiStreamEvent>, BrainError>
where
    C: GeminiSseClient,
{
    let stream_request = GeminiStreamRequest::new(config, request)?;
    let started = Instant::now();
    let response = timeout(config.stage_timeout, client.stream(stream_request))
        .await
        .map_err(|_| BrainError::Connection("Gemini generation stage timeout".to_owned()))?
        .map_err(sanitize_gemini_stream_error)?;
    if response.status == 429 {
        return Err(gemini_rate_limit_stage_failure(
            config,
            &response,
            started.elapsed(),
        ));
    }
    if !(200..300).contains(&response.status) {
        return Err(sanitized_gemini_http_status_error(response.status));
    }
    if response.body.trim().is_empty() {
        return Err(BrainError::Protocol(
            "Gemini stream returned no events".to_owned(),
        ));
    }
    Ok(parse_gemini_sse_stream(&response.body))
}

fn sanitize_gemini_stream_error(error: BrainError) -> BrainError {
    match error {
        BrainError::Connection(message) | BrainError::Protocol(message) => {
            if let Some(status) = sanitized_gemini_http_status(&message) {
                return BrainError::Protocol(format!(
                    "Gemini stream request failed with status {status}"
                ));
            }
            BrainError::Connection("Gemini stream request failed".to_owned())
        }
        BrainError::MissingApiKey => BrainError::MissingApiKey,
        BrainError::StageFailure(failure) => BrainError::StageFailure(failure),
    }
}

fn sanitized_gemini_http_status(message: &str) -> Option<u16> {
    let normalized = message.to_ascii_lowercase();
    [401_u16, 403_u16, 429_u16].into_iter().find(|status| {
        let status = status.to_string();
        normalized.contains(&format!("status {status}"))
            || normalized.contains(&format!("status: {status}"))
            || normalized.contains(&format!("status={status}"))
    })
}

fn sanitized_gemini_http_status_error(status: u16) -> BrainError {
    if matches!(status, 401 | 403) {
        BrainError::Protocol(format!("Gemini stream request failed with status {status}"))
    } else {
        BrainError::Connection("Gemini stream request failed".to_owned())
    }
}

pub(crate) async fn stream_gemini_http(
    config: &GeminiConfig,
    request: Value,
) -> Result<Vec<GeminiStreamEvent>, BrainError> {
    stream_gemini_with_client(&ReqwestGeminiSseClient::default(), config, request).await
}

#[derive(Clone, Default)]
struct ReqwestGeminiSseClient {
    client: reqwest::Client,
}

#[async_trait]
impl GeminiSseClient for ReqwestGeminiSseClient {
    async fn stream(&self, request: GeminiStreamRequest) -> Result<GeminiSseResponse, BrainError> {
        let api_key = HeaderValue::from_str(&request.api_key)
            .map_err(|_| BrainError::Protocol("invalid Gemini API key header value".to_owned()))?;
        let response = self
            .client
            .post(&request.url)
            .header("x-goog-api-key", api_key)
            .header(CONTENT_TYPE, "application/json")
            .json(&request.body)
            .send()
            .await
            .map_err(|_| BrainError::Connection("Gemini stream request failed".to_owned()))?;
        let status = response.status().as_u16();
        let retry_after = header_value(response.headers(), RETRY_AFTER.as_str());
        let reset_after = reset_header_value(response.headers());
        let body = response_text(status, response).await;
        gemini_sse_response_from_http_parts(status, retry_after, reset_after, body)
    }
}

async fn response_text(status: u16, response: reqwest::Response) -> Result<String, ()> {
    if (200..300).contains(&status) {
        return response.text().await.map_err(|_| ());
    }
    match timeout(GEMINI_ERROR_BODY_READ_TIMEOUT, response.text()).await {
        Ok(Ok(body)) => Ok(body),
        Ok(Err(_)) | Err(_) => Err(()),
    }
}

fn gemini_sse_response_from_http_parts(
    status: u16,
    retry_after: Option<String>,
    reset_after: Option<String>,
    body: Result<String, ()>,
) -> Result<GeminiSseResponse, BrainError> {
    let body = match body {
        Ok(body) => body,
        Err(()) if !(200..300).contains(&status) => String::new(),
        Err(()) => {
            return Err(BrainError::Connection(
                "Gemini stream response read failed".to_owned(),
            ));
        }
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
    BrainError::StageFailure(Box::new(BrainProviderFailure::new(
        BrainProviderFailureParts {
            failure_class: "quota_rate_failure".to_owned(),
            stage: "gemini".to_owned(),
            terminal_reason: TerminalSessionReason::ProviderRateLimited,
            retry_eligible: true,
            latency_ms: latency.as_millis().try_into().unwrap_or(u64::MAX),
            provider: "gemini".to_owned(),
            model: config.model_id.clone(),
            metadata: gemini_rate_limit_metadata(response),
        },
    )))
}

fn gemini_rate_limit_metadata(response: &GeminiSseResponse) -> String {
    let retry_hint = retry_after_hint(response.retry_after.as_deref(), &response.body);
    let reset_hint = response
        .reset_after
        .as_deref()
        .and_then(sanitized_reset_hint)
        .unwrap_or_else(|| "none".to_owned());
    format!(
        "reset_hint={} retry_after_ms={} retry_after_source={} http_status=429 body_status={} budget_state=unknown deploy_sha=unknown",
        reset_hint,
        retry_hint.retry_after_ms,
        retry_hint.source,
        sanitized_body_status(&response.body),
    )
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

fn sanitized_body_status(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/status")
                .and_then(Value::as_str)
                .map(|status| {
                    status
                        .to_ascii_lowercase()
                        .chars()
                        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
                        .take(64)
                        .collect::<String>()
                })
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_owned())
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
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use serde_json::json;

    use agent_domain::BrainError;

    use super::*;

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
            api_key: "local-fixture".to_owned(),
            base_url: "https://generativelanguage.googleapis.com/v1beta/models".to_owned(),
            model_id: "gemini-3.5-flash".to_owned(),
            ..GeminiConfig::default()
        };
        let body = json!({
            "contents": [],
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
        assert_eq!(capture.api_key.as_deref(), Some("local-fixture"));
        assert_eq!(capture.body.as_ref(), Some(&body));
        assert!(!capture.url.as_ref().unwrap().contains("local-fixture"));
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
        .unwrap_err()
        .to_string();

        assert!(error.contains("Gemini stream request failed"));
        assert!(!error.contains(unsafe_marker));
        assert!(!error.contains("local-fixture"));
    }

    #[tokio::test]
    async fn streaming_transport_preserves_safe_http_status_failures() {
        let unsafe_marker = "UNSAFE_STATUS_MARKER";
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Error(format!(
                "Gemini stream request failed with status 401 after {unsafe_marker}"
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
        .unwrap_err()
        .to_string();

        assert!(error.contains("Gemini stream request failed with status 401"));
        assert!(!error.contains(unsafe_marker));
        assert!(!error.contains("local-fixture"));
    }

    #[tokio::test]
    async fn streaming_transport_redacts_unclassified_http_status_failures() {
        let unsafe_marker = "UNSAFE_STATUS_MARKER";
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Error(format!(
                "Gemini stream request failed with status 503 after {unsafe_marker}"
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
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "brain connection failed: Gemini stream request failed"
        );
        assert!(!error.contains("503"));
        assert!(!error.contains(unsafe_marker));
        assert!(!error.contains("local-fixture"));
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
        .unwrap_err()
        .to_string();

        assert!(error.contains("Gemini generation stage timeout"));
        assert!(!error.contains(unsafe_marker));
        assert!(!error.contains("local-fixture"));
    }

    #[tokio::test]
    async fn streaming_transport_maps_429_retry_after_to_sanitized_stage_failure() {
        let raw_body = r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"UNSAFE_429_BODY_MARKER"}}"#;
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(GeminiSseResponse {
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

        let BrainError::StageFailure(failure) = error else {
            panic!("expected Gemini 429 stage failure");
        };
        assert_eq!(failure.failure_class, "quota_rate_failure");
        assert_eq!(
            failure.terminal_reason,
            agent_domain::TerminalSessionReason::ProviderRateLimited
        );
        assert_eq!(failure.provider, "gemini");
        assert_eq!(failure.model, "gemini-35-flash");
        assert!(failure.metadata.contains("http_status=429"));
        assert!(failure.metadata.contains("retry_after_ms=7000"));
        assert!(failure
            .metadata
            .contains("retry_after_source=retry_after_delta"));
        assert!(failure.metadata.contains("reset_hint=2030-01-01T00:00:00Z"));
        assert!(failure.metadata.contains("body_status=resource_exhausted"));
        assert!(failure.metadata.contains("budget_state=unknown"));
        assert!(!failure.metadata.contains("UNSAFE_429_BODY_MARKER"));
        assert!(!failure.to_string().contains("UNSAFE_429_BODY_MARKER"));
    }

    #[tokio::test]
    async fn streaming_transport_429_without_valid_retry_after_uses_sanitized_default() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(GeminiSseResponse {
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

        let BrainError::StageFailure(failure) = error else {
            panic!("expected Gemini 429 stage failure");
        };
        assert_eq!(failure.failure_class, "quota_rate_failure");
        assert!(failure.metadata.contains("retry_after_ms=1000"));
        assert!(failure.metadata.contains("retry_after_source=default"));
        assert!(!failure.metadata.contains("UNSAFE_DEFAULT_BODY_MARKER"));
        assert!(!failure.metadata.contains("not a retry hint"));
    }

    #[tokio::test]
    async fn streaming_transport_429_uses_sanitized_retry_info_body_when_header_missing() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(GeminiSseResponse {
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

        let BrainError::StageFailure(failure) = error else {
            panic!("expected Gemini 429 stage failure");
        };
        assert!(failure.metadata.contains("retry_after_ms=30000"));
        assert!(failure
            .metadata
            .contains("retry_after_source=body_retry_info"));
        assert!(failure.metadata.contains("body_status=resource_exhausted"));
        assert!(!failure.metadata.contains("RetryInfo"));
        assert!(!failure.metadata.contains("retryDelay"));
    }

    #[tokio::test]
    async fn streaming_transport_429_parses_fractional_retry_info_body_delay() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(GeminiSseResponse {
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

        let BrainError::StageFailure(failure) = error else {
            panic!("expected Gemini 429 stage failure");
        };
        assert!(failure.metadata.contains("retry_after_ms=1500"));
        assert!(failure
            .metadata
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
            response: RecordingGeminiResponse::Response(GeminiSseResponse {
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

        let BrainError::StageFailure(failure) = error else {
            panic!("expected Gemini 429 stage failure");
        };
        assert!(failure.metadata.contains("retry_after_ms=120000"));
        assert!(failure
            .metadata
            .contains("retry_after_source=body_retry_text"));
        assert!(!failure.metadata.contains("fixture retry"));
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
            response: RecordingGeminiResponse::Response(GeminiSseResponse {
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

        let BrainError::StageFailure(failure) = error else {
            panic!("expected Gemini 429 stage failure");
        };
        assert!(failure.metadata.contains("reset_hint=none"));
        assert!(!failure.metadata.contains("quota-account-abc123"));
    }

    #[tokio::test]
    async fn streaming_transport_429_accepts_relative_ratelimit_reset_hint() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(GeminiSseResponse {
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

        let BrainError::StageFailure(failure) = error else {
            panic!("expected Gemini 429 stage failure");
        };
        assert!(failure.metadata.contains("reset_hint=relative_ms=30000"));
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

        let BrainError::StageFailure(failure) = error else {
            panic!("expected Gemini 429 stage failure");
        };
        assert_eq!(failure.failure_class, "quota_rate_failure");
        assert_eq!(
            failure.terminal_reason,
            agent_domain::TerminalSessionReason::ProviderRateLimited
        );
        assert_eq!(failure.latency_ms, 42);
        assert!(failure.metadata.contains("retry_after_ms=5000"));
        assert!(failure.metadata.contains("reset_hint=2030-01-01T00:00:00Z"));
        assert!(failure.metadata.contains("body_status=unknown"));
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
            assert_eq!(response.body, "");
        }
    }

    #[test]
    fn success_body_read_failure_remains_connection_failure() {
        let error = gemini_sse_response_from_http_parts(200, None, None, Err(())).unwrap_err();

        assert!(matches!(error, BrainError::Connection(_)));
    }

    #[tokio::test]
    async fn streaming_transport_503_redacts_unclassified_status_and_body() {
        let client = RecordingGeminiSseClient {
            capture: Arc::new(Mutex::new(GeminiRequestCapture::default())),
            response: RecordingGeminiResponse::Response(GeminiSseResponse {
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
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "brain connection failed: Gemini stream request failed"
        );
        assert!(!error.contains("503"));
        assert!(!error.contains("UNSAFE_503_BODY_MARKER"));
        assert!(!error.contains("local-fixture"));
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

    struct DelayedGeminiSseClient;

    #[derive(Clone)]
    enum RecordingGeminiResponse {
        Body(String),
        Response(GeminiSseResponse),
        Error(String),
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
                RecordingGeminiResponse::Body(body) => Ok(GeminiSseResponse::ok(body.clone())),
                RecordingGeminiResponse::Response(response) => Ok(response.clone()),
                RecordingGeminiResponse::Error(message) => {
                    Err(BrainError::Connection(message.clone()))
                }
            }
        }
    }

    #[async_trait]
    impl GeminiSseClient for DelayedGeminiSseClient {
        async fn stream(
            &self,
            _request: GeminiStreamRequest,
        ) -> Result<GeminiSseResponse, BrainError> {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(GeminiSseResponse::ok(
                r#"data: {"candidates":[{"content":{"parts":[{"text":"too late"}]}}]}"#.to_owned(),
            ))
        }
    }
}
