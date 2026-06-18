use std::fmt;

use serde_json::{json, Value};

use agent_domain::ToolResult;

use super::constants::{
    DEFAULT_GEMINI_BASE_URL, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_THINKING_LEVEL,
};

const TRUSTED_SOURCE_CONTEXT_FUNCTION: &str = "trusted_source_context";

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

fn parse_gemini_value(value: &Value) -> Vec<GeminiStreamEvent> {
    if let Some(error) = value.pointer("/error/message").and_then(Value::as_str) {
        return vec![GeminiStreamEvent::Error(error.to_owned())];
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
    use serde_json::json;

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
}
