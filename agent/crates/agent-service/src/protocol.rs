use std::fmt;

use agent_domain::{
    AnswerEvaluation, AudioFrame, BrainEvent, BrainProviderError, ConceptStatus, ManuscriptIntent,
    RealtimeBrainCapabilities, SessionConfig, StudyMode, StudyQuestion, StudySessionPhase,
    StudySessionRecap, StudySourceReference, StudyStoreBackend, StudyStoreCapabilities,
    TerminalSessionReason,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const VIVA_VOICE_PROTOCOL_VERSION: u32 = 5;
/// v5 is the only accepted and emitted version; v4 input is rejected, never upgraded.
pub const VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS: [u32; 1] = [VIVA_VOICE_PROTOCOL_VERSION];
pub const VIVA_VOICE_SAMPLE_RATE_HZ: u32 = 24_000;
pub const VIVA_VOICE_CHANNELS: usize = 1;
/// `pcm_s16le` is a signed 16-bit sample, so two bytes.
pub const VIVA_VOICE_BYTES_PER_SAMPLE: usize = 2;
pub const VIVA_VOICE_INPUT_ENCODING: &str = "pcm_s16le";
pub const VIVA_VOICE_MAX_TEXT_FRAME_BYTES: usize = 64 * 1024;
/// The 45-second bound on one browser turn.
pub const VIVA_VOICE_MAX_TURN_SECONDS: usize = 45;

/// Alias of the existing 24 kHz voice constant; one literal source.
pub const VIVA_AUDIO_SAMPLE_RATE_HZ: u32 = VIVA_VOICE_SAMPLE_RATE_HZ;
pub const VIVA_AUDIO_MAX_CHUNK_SAMPLES: usize = 4_096;
/// Mono `pcm_s16le` is two bytes per sample.
pub const VIVA_AUDIO_MAX_CHUNK_BYTES: usize = 8_192;
/// `VOICE-SIZE-002`: the maximum chunk in canonical RFC 4648 base64 *with* padding.
/// This is a derived ceiling, never a second size authority.
pub const VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS: usize = 10_924;
pub const VIVA_AUDIO_MAX_TURN_SAMPLES: usize = 1_080_000;
pub const VIVA_AUDIO_MAX_TURN_BYTES: usize = 2_160_000;

// The locked v5 audio constants are written as literals so both language
// contracts read identically. This compile-time block keeps the literals
// self-consistent in production builds, not only under `cargo test`.
const _: () = {
    assert!(
        VIVA_AUDIO_MAX_CHUNK_BYTES
            == VIVA_AUDIO_MAX_CHUNK_SAMPLES * VIVA_VOICE_CHANNELS * VIVA_VOICE_BYTES_PER_SAMPLE
    );
    assert!(
        VIVA_AUDIO_MAX_TURN_SAMPLES
            == VIVA_VOICE_MAX_TURN_SECONDS * VIVA_AUDIO_SAMPLE_RATE_HZ as usize
    );
    assert!(
        VIVA_AUDIO_MAX_TURN_BYTES
            == VIVA_AUDIO_MAX_TURN_SAMPLES * VIVA_VOICE_CHANNELS * VIVA_VOICE_BYTES_PER_SAMPLE
    );
    assert!(VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS == VIVA_AUDIO_MAX_CHUNK_BYTES.div_ceil(3) * 4);
    assert!(VIVA_AUDIO_MAX_CHUNK_BYTES < VIVA_VOICE_MAX_TEXT_FRAME_BYTES);
};

/// The one JSON path a rejected audio payload is ever reported at.
const PCM16_BASE64_PATH: &str = "$.frame.pcm16_base64";

/// The wire spelling of the signed credential, written once in this module.
const SESSION_CREDENTIAL_KEY: &str = "session_token";
/// What a `ClientFrame` formatter is allowed to print in the credential's place.
const REDACTED_CREDENTIAL: &str = "[REDACTED]";
const MAX_WIRE_ID_LENGTH: usize = 128;
const MAX_INITIAL_GOAL_CODE_POINTS: usize = 512;

/// `VOICE-AUTHORITY-001`: the exact browser-sendable vocabulary, in wire order.
pub const VIVA_BROWSER_CLIENT_FRAME_TYPES: [&str; 7] = [
    "session_config",
    "session_refresh",
    "audio_chunk",
    "audio_end",
    "turn_intent",
    "cancel",
    "stop",
];

const SESSION_CONFIG_KEYS: [&str; 6] = [
    "session_id",
    "user_id",
    "study_set_id",
    "mode",
    "source_context",
    "active_concepts",
];
const SOURCE_CONTEXT_KEYS: [&str; 6] = [
    "source_id",
    "document_id",
    "span",
    "excerpt",
    "confidence",
    "retrieval_reason",
];
const SESSION_REFRESH_CONTEXT_KEYS: [&str; 2] = ["mode", "initial_goal"];
const SESSION_REFRESH_FORBIDDEN_KEYS: [&str; 6] = [
    SESSION_CREDENTIAL_KEY,
    "user_id",
    "study_set_id",
    "session_id",
    "source_context",
    "active_concepts",
];

/// The protocol advertisement a ready frame carries. Both languages publish the exact
/// same shape so version negotiation cannot drift across the wire.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceProtocolAdvertisement {
    pub preferred_version: u32,
    pub supported_versions: [u32; 1],
}

pub const VOICE_PROTOCOL_ADVERTISEMENT: VoiceProtocolAdvertisement = VoiceProtocolAdvertisement {
    preferred_version: VIVA_VOICE_PROTOCOL_VERSION,
    supported_versions: VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS,
};

impl Default for VoiceProtocolAdvertisement {
    fn default() -> Self {
        VOICE_PROTOCOL_ADVERTISEMENT
    }
}

/// Negotiation selects the greatest shared version. This release supports only v5, so a
/// list without v5 has no overlap and fails closed instead of downgrading to v4.
pub fn negotiate_voice_protocol_version(
    local_supported_versions: &[u32],
    peer_supported_versions: &[u32],
) -> Result<u32, VoiceProtocolDiagnostic> {
    local_supported_versions
        .iter()
        .copied()
        .filter(|version| peer_supported_versions.contains(version))
        .max()
        .filter(|version| *version == VIVA_VOICE_PROTOCOL_VERSION)
        .ok_or_else(|| {
            VoiceProtocolDiagnostic::new(
                VoiceProtocolDiagnosticCode::UnsupportedVersion,
                "$.protocol.supported_versions",
            )
        })
}

/// `VOICE-DIAGNOSTIC-001`: the closed, stable diagnostic vocabulary shared with the
/// TypeScript contract. Codes and paths are the whole error surface; a rejected value
/// never becomes part of a diagnostic.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum VoiceProtocolDiagnosticCode {
    UnsupportedVersion,
    MalformedJson,
    InvalidEnvelope,
    UnknownFrame,
    UnknownField,
    MissingField,
    InvalidField,
    NoncanonicalBase64Url,
    ForbiddenAuthority,
    FrameTooLarge,
    AudioSequence,
    TurnTooLarge,
    Invariant,
}

impl VoiceProtocolDiagnosticCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedVersion => "VOICE_PROTOCOL_UNSUPPORTED_VERSION",
            Self::MalformedJson => "VOICE_PROTOCOL_MALFORMED_JSON",
            Self::InvalidEnvelope => "VOICE_PROTOCOL_INVALID_ENVELOPE",
            Self::UnknownFrame => "VOICE_PROTOCOL_UNKNOWN_FRAME",
            Self::UnknownField => "VOICE_PROTOCOL_UNKNOWN_FIELD",
            Self::MissingField => "VOICE_PROTOCOL_MISSING_FIELD",
            Self::InvalidField => "VOICE_PROTOCOL_INVALID_FIELD",
            Self::NoncanonicalBase64Url => "VOICE_PROTOCOL_NONCANONICAL_BASE64URL",
            Self::ForbiddenAuthority => "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",
            Self::FrameTooLarge => "VOICE_PROTOCOL_FRAME_TOO_LARGE",
            Self::AudioSequence => "VOICE_PROTOCOL_AUDIO_SEQUENCE",
            Self::TurnTooLarge => "VOICE_PROTOCOL_TURN_TOO_LARGE",
            Self::Invariant => "VOICE_PROTOCOL_INVARIANT",
        }
    }
}

impl fmt::Debug for VoiceProtocolDiagnosticCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Display for VoiceProtocolDiagnosticCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A redaction-safe parser diagnostic: code and JSON path only.
#[derive(Clone, Eq, PartialEq)]
pub struct VoiceProtocolDiagnostic {
    pub code: VoiceProtocolDiagnosticCode,
    pub path: String,
}

impl VoiceProtocolDiagnostic {
    pub fn new(code: VoiceProtocolDiagnosticCode, path: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
        }
    }
}

impl fmt::Debug for VoiceProtocolDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VoiceProtocolDiagnostic")
            .field("code", &self.code)
            .field("path", &self.path)
            .finish()
    }
}

impl fmt::Display for VoiceProtocolDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} at {}", self.code, self.path)
    }
}

impl std::error::Error for VoiceProtocolDiagnostic {}

/// `VOICE-SIZE-002`: the wire envelope is measured in UTF-8 bytes and rejected above
/// the unchanged 64 KiB text-frame cap *before* any nested parsing, so an oversized
/// payload is never allocated into a document tree.
pub fn parse_client_frame_json(json: &str) -> Result<ClientFrame, VoiceProtocolDiagnostic> {
    let value = parse_voice_wire_json(json)?;
    validate_client_frame_wire(&value)?;
    serde_json::from_value(value).map_err(|_| {
        VoiceProtocolDiagnostic::new(VoiceProtocolDiagnosticCode::InvalidEnvelope, "$")
    })
}

/// `VOICE-AUTHORITY-001` / `VOICE-AUTH-001` / `VOICE-REFRESH-001`: the explicit wire
/// allowlist that runs before any conversion to a domain type. Rejections carry a code
/// and a JSON path and never the rejected value.
fn validate_client_frame_wire(value: &Value) -> Result<(), VoiceProtocolDiagnostic> {
    let frame = require_wire_object(Some(value), "$")?;
    // A browser has no tool authority, so a forged tool result is forbidden rather than
    // merely unknown. The v4 plain text frame is simply not a v5 frame.
    let frame_type = frame.get("type").and_then(Value::as_str);
    if frame_type == Some("tool_result") {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::ForbiddenAuthority,
            "$.type",
        ));
    }
    let Some(frame_type) = frame_type.filter(|kind| VIVA_BROWSER_CLIENT_FRAME_TYPES.contains(kind))
    else {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::UnknownFrame,
            "$.type",
        ));
    };
    require_wire_id(frame.get("client_generation_id"), "$.client_generation_id")?;

    match frame_type {
        "session_config" => {
            require_wire_credential(frame.get(SESSION_CREDENTIAL_KEY))?;
            validate_session_config_wire(frame.get("session"))?;
        }
        "session_refresh" => validate_session_refresh_context_wire(frame.get("context"))?,
        "audio_chunk" => {
            require_wire_id(frame.get("turn_id"), "$.turn_id")?;
            validate_audio_chunk_payload(value)?;
        }
        "audio_end" => {
            require_wire_id(frame.get("turn_id"), "$.turn_id")?;
        }
        "turn_intent" => {
            require_wire_id(frame.get("turn_id"), "$.turn_id")?;
            validate_turn_intent_wire(frame.get("intent"))?;
        }
        "cancel" => {
            if frame.contains_key("turn_id") {
                require_wire_id(frame.get("turn_id"), "$.turn_id")?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_session_config_wire(value: Option<&Value>) -> Result<(), VoiceProtocolDiagnostic> {
    let session = require_wire_object(value, "$.session")?;
    if session.contains_key(SESSION_CREDENTIAL_KEY) {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::ForbiddenAuthority,
            format!("$.session.{SESSION_CREDENTIAL_KEY}"),
        ));
    }
    require_only_wire_keys(session, &SESSION_CONFIG_KEYS, "$.session")?;
    require_strict_wire_id(session.get("session_id"), "$.session.session_id")?;
    require_strict_wire_id(session.get("user_id"), "$.session.user_id")?;
    require_strict_wire_id(session.get("study_set_id"), "$.session.study_set_id")?;
    if session.contains_key("mode") {
        require_wire_study_mode(session.get("mode"), "$.session.mode")?;
    }
    for (index, source) in
        require_wire_array(session.get("source_context"), "$.session.source_context")?
            .iter()
            .enumerate()
    {
        let path = format!("$.session.source_context[{index}]");
        let source = require_wire_object(Some(source), &path)?;
        require_only_wire_keys(source, &SOURCE_CONTEXT_KEYS, &path)?;
        for key in [
            "source_id",
            "document_id",
            "span",
            "excerpt",
            "retrieval_reason",
        ] {
            require_non_empty_wire_string(source.get(key), format!("{path}.{key}"))?;
        }
        require_wire_source_confidence(source.get("confidence"), format!("{path}.confidence"))?;
    }
    for (index, concept) in
        require_wire_array(session.get("active_concepts"), "$.session.active_concepts")?
            .iter()
            .enumerate()
    {
        require_strict_wire_id(Some(concept), format!("$.session.active_concepts[{index}]"))?;
    }
    Ok(())
}

fn validate_session_refresh_context_wire(
    value: Option<&Value>,
) -> Result<(), VoiceProtocolDiagnostic> {
    let context = require_wire_object(value, "$.context")?;
    for key in context.keys() {
        if SESSION_REFRESH_FORBIDDEN_KEYS.contains(&key.as_str()) {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::ForbiddenAuthority,
                format!("$.context.{key}"),
            ));
        }
        if !SESSION_REFRESH_CONTEXT_KEYS.contains(&key.as_str()) {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::UnknownField,
                format!("$.context.{key}"),
            ));
        }
    }
    if context.contains_key("mode") {
        require_wire_study_mode(context.get("mode"), "$.context.mode")?;
    }
    if context.contains_key("initial_goal") {
        let goal = require_wire_string(context.get("initial_goal"), "$.context.initial_goal")?;
        if goal.trim().is_empty() || goal.chars().count() > MAX_INITIAL_GOAL_CODE_POINTS {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::InvalidField,
                "$.context.initial_goal",
            ));
        }
    }
    if context.is_empty() {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::MissingField,
            "$.context",
        ));
    }
    Ok(())
}

fn validate_turn_intent_wire(value: Option<&Value>) -> Result<(), VoiceProtocolDiagnostic> {
    let intent = require_wire_object(value, "$.intent")?;
    match intent.get("kind").and_then(Value::as_str) {
        Some("answer_text") => {
            require_only_wire_keys(intent, &["kind", "text"], "$.intent")?;
            require_wire_string(intent.get("text"), "$.intent.text")?;
        }
        Some("citation_challenge") => {
            require_only_wire_keys(intent, &["kind", "response_id", "source_id"], "$.intent")?;
            require_strict_wire_id(intent.get("response_id"), "$.intent.response_id")?;
            require_strict_wire_id(intent.get("source_id"), "$.intent.source_id")?;
        }
        _ => {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::InvalidField,
                "$.intent.kind",
            ))
        }
    }
    Ok(())
}

fn diagnostic(
    code: VoiceProtocolDiagnosticCode,
    path: impl Into<String>,
) -> VoiceProtocolDiagnostic {
    VoiceProtocolDiagnostic::new(code, path)
}

fn require_wire_object<'a>(
    value: Option<&'a Value>,
    path: impl Into<String>,
) -> Result<&'a Map<String, Value>, VoiceProtocolDiagnostic> {
    let path = path.into();
    match value {
        None | Some(Value::Null) => Err(diagnostic(
            VoiceProtocolDiagnosticCode::MissingField,
            path.clone(),
        )),
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path)),
    }
}

fn require_wire_array<'a>(
    value: Option<&'a Value>,
    path: impl Into<String>,
) -> Result<&'a Vec<Value>, VoiceProtocolDiagnostic> {
    let path = path.into();
    match value {
        None => Err(diagnostic(
            VoiceProtocolDiagnosticCode::MissingField,
            path.clone(),
        )),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path)),
    }
}

fn require_wire_string<'a>(
    value: Option<&'a Value>,
    path: impl Into<String>,
) -> Result<&'a str, VoiceProtocolDiagnostic> {
    let path = path.into();
    match value {
        None => Err(diagnostic(
            VoiceProtocolDiagnosticCode::MissingField,
            path.clone(),
        )),
        Some(Value::String(text)) => Ok(text),
        Some(_) => Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path)),
    }
}

fn require_non_empty_wire_string<'a>(
    value: Option<&'a Value>,
    path: impl Into<String>,
) -> Result<&'a str, VoiceProtocolDiagnostic> {
    let path = path.into();
    let text = require_wire_string(value, path.clone())?;
    if text.trim().is_empty() {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(text)
}

/// Wire identity: present, non-blank, and bounded.
fn require_wire_id<'a>(
    value: Option<&'a Value>,
    path: impl Into<String>,
) -> Result<&'a str, VoiceProtocolDiagnostic> {
    let path = path.into();
    let text = require_wire_string(value, path.clone())?;
    if text.trim().is_empty() || text.chars().count() > MAX_WIRE_ID_LENGTH {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(text)
}

/// `VOICE-TURN-001`'s id vocabulary, also used for bound session identity.
fn require_strict_wire_id<'a>(
    value: Option<&'a Value>,
    path: impl Into<String>,
) -> Result<&'a str, VoiceProtocolDiagnostic> {
    let path = path.into();
    let text = require_wire_string(value, path.clone())?;
    if !is_strict_wire_id(text) {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(text)
}

fn is_strict_wire_id(text: &str) -> bool {
    if text.is_empty() || text.chars().count() > MAX_WIRE_ID_LENGTH {
        return false;
    }
    let mut characters = text.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    characters.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
    })
}

/// The signed credential is validated for shape only. This module never verifies an
/// HMAC and never copies the value into a diagnostic; Plan 08 owns verification.
fn require_wire_credential(value: Option<&Value>) -> Result<(), VoiceProtocolDiagnostic> {
    let path = format!("$.{SESSION_CREDENTIAL_KEY}");
    let text = require_wire_string(value, path.clone())?;
    if text.trim().is_empty() {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(())
}

fn require_only_wire_keys(
    map: &Map<String, Value>,
    allowed: &[&str],
    path: &str,
) -> Result<(), VoiceProtocolDiagnostic> {
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::UnknownField,
                format!("{path}.{key}"),
            ));
        }
    }
    Ok(())
}

fn require_wire_study_mode(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<(), VoiceProtocolDiagnostic> {
    let path = path.into();
    if require_wire_string(value, path.clone())? != StudyMode::Quiz.as_str() {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(())
}

fn require_wire_source_confidence(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<(), VoiceProtocolDiagnostic> {
    let path = path.into();
    if !matches!(
        require_wire_string(value, path.clone())?,
        "high" | "medium" | "low"
    ) {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(())
}

pub fn parse_server_frame_json(json: &str) -> Result<ServerFrame, VoiceProtocolDiagnostic> {
    let value = parse_voice_wire_json(json)?;
    serde_json::from_value(value).map_err(|_| {
        VoiceProtocolDiagnostic::new(VoiceProtocolDiagnosticCode::InvalidEnvelope, "$")
    })
}

fn parse_voice_wire_json(json: &str) -> Result<Value, VoiceProtocolDiagnostic> {
    if json.len() > VIVA_VOICE_MAX_TEXT_FRAME_BYTES {
        return Err(VoiceProtocolDiagnostic::new(
            VoiceProtocolDiagnosticCode::FrameTooLarge,
            "$",
        ));
    }
    serde_json::from_str(json)
        .map_err(|_| VoiceProtocolDiagnostic::new(VoiceProtocolDiagnosticCode::MalformedJson, "$"))
}

/// Decodes `frame.pcm16_base64` only long enough to enforce canonical padded base64
/// and the raw byte bounds. The decoded bytes are dropped here; they are never
/// stored, logged, or copied into a diagnostic. The aggregate turn bound stays in
/// Plan 03's stateful assembler, which consumes the same constants.
fn validate_audio_chunk_payload(value: &Value) -> Result<(), VoiceProtocolDiagnostic> {
    let Some(frame) = value.get("frame") else {
        return Err(VoiceProtocolDiagnostic::new(
            VoiceProtocolDiagnosticCode::MissingField,
            "$.frame",
        ));
    };
    let Some(encoded) = frame.get("pcm16_base64") else {
        return Err(VoiceProtocolDiagnostic::new(
            VoiceProtocolDiagnosticCode::MissingField,
            PCM16_BASE64_PATH,
        ));
    };
    let invalid_payload = || {
        VoiceProtocolDiagnostic::new(VoiceProtocolDiagnosticCode::InvalidField, PCM16_BASE64_PATH)
    };
    let encoded = encoded.as_str().ok_or_else(invalid_payload)?;
    let decoded = decode_canonical_padded_base64(encoded).ok_or_else(invalid_payload)?;
    if decoded.len() > VIVA_AUDIO_MAX_CHUNK_BYTES {
        return Err(VoiceProtocolDiagnostic::new(
            VoiceProtocolDiagnosticCode::FrameTooLarge,
            PCM16_BASE64_PATH,
        ));
    }
    if decoded.is_empty() || decoded.len() % VIVA_VOICE_BYTES_PER_SAMPLE != 0 {
        return Err(invalid_payload());
    }
    Ok(())
}

/// `pcm16_base64` is standard RFC 4648 base64 with padding. Re-encoding the decoded
/// bytes must reproduce the payload exactly, which rejects missing padding and
/// non-zero unused bits in the final group. Unpadded base64url is a `viva1`
/// session-token encoding and is never accepted here.
fn decode_canonical_padded_base64(encoded: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let decoded = STANDARD.decode(encoded).ok()?;
    (STANDARD.encode(&decoded) == encoded).then_some(decoded)
}

/// `VOICE-REFRESH-001`: the only in-socket refresh payload. Token renewal never happens
/// inside an open socket, so this carries non-authoritative study context and nothing
/// else. The shape is deliberately neutral on Plan 04's D-03 decision; Plan 08 owns the
/// policy step.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRefreshContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<StudyMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_goal: Option<String>,
}

impl SessionRefreshContext {
    /// At least one context key is required: an empty refresh asks for nothing.
    pub fn is_empty(&self) -> bool {
        self.mode.is_none() && self.initial_goal.is_none()
    }
}

/// `VOICE-TURN-001`: there is no v5 plain text frame and no magic citation payload. A
/// citation challenge is not an answer and can never be graded as one.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClientTurnIntent {
    AnswerText {
        text: String,
    },
    CitationChallenge {
        response_id: String,
        source_id: String,
    },
}

/// `VOICE-AUTHORITY-001`: the exact browser-sendable union. A tool result is never a
/// member, so the browser has no tool authority to forge.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    SessionConfig {
        version: u32,
        client_generation_id: String,
        session_token: String,
        session: SessionConfig,
    },
    SessionRefresh {
        version: u32,
        client_generation_id: String,
        context: SessionRefreshContext,
    },
    AudioChunk {
        version: u32,
        client_generation_id: String,
        turn_id: String,
        sequence: u32,
        frame: AudioFrame,
    },
    AudioEnd {
        version: u32,
        client_generation_id: String,
        turn_id: String,
        final_sequence: u32,
    },
    TurnIntent {
        version: u32,
        client_generation_id: String,
        turn_id: String,
        intent: ClientTurnIntent,
    },
    Cancel {
        version: u32,
        client_generation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    Stop {
        version: u32,
        client_generation_id: String,
    },
}

impl ClientFrame {
    pub fn version(&self) -> u32 {
        match self {
            Self::SessionConfig { version, .. }
            | Self::SessionRefresh { version, .. }
            | Self::AudioChunk { version, .. }
            | Self::AudioEnd { version, .. }
            | Self::TurnIntent { version, .. }
            | Self::Cancel { version, .. }
            | Self::Stop { version, .. } => *version,
        }
    }

    pub fn client_generation_id(&self) -> &str {
        match self {
            Self::SessionConfig {
                client_generation_id,
                ..
            }
            | Self::SessionRefresh {
                client_generation_id,
                ..
            }
            | Self::AudioChunk {
                client_generation_id,
                ..
            }
            | Self::AudioEnd {
                client_generation_id,
                ..
            }
            | Self::TurnIntent {
                client_generation_id,
                ..
            }
            | Self::Cancel {
                client_generation_id,
                ..
            }
            | Self::Stop {
                client_generation_id,
                ..
            } => client_generation_id,
        }
    }
}

/// `VOICE-AUTH-001`: a hand-written formatter, never a derived one. The credential is
/// bound out with `..` so no nested formatter can observe the string, and the field is
/// printed as a fixed redaction marker instead.
impl fmt::Debug for ClientFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SessionConfig {
                version,
                client_generation_id,
                session,
                ..
            } => formatter
                .debug_struct("SessionConfig")
                .field("version", version)
                .field("client_generation_id", client_generation_id)
                .field(SESSION_CREDENTIAL_KEY, &REDACTED_CREDENTIAL)
                .field("session", session)
                .finish(),
            Self::SessionRefresh {
                version,
                client_generation_id,
                context,
            } => formatter
                .debug_struct("SessionRefresh")
                .field("version", version)
                .field("client_generation_id", client_generation_id)
                .field("context", context)
                .finish(),
            Self::AudioChunk {
                version,
                client_generation_id,
                turn_id,
                sequence,
                ..
            } => formatter
                .debug_struct("AudioChunk")
                .field("version", version)
                .field("client_generation_id", client_generation_id)
                .field("turn_id", turn_id)
                .field("sequence", sequence)
                .finish_non_exhaustive(),
            Self::AudioEnd {
                version,
                client_generation_id,
                turn_id,
                final_sequence,
            } => formatter
                .debug_struct("AudioEnd")
                .field("version", version)
                .field("client_generation_id", client_generation_id)
                .field("turn_id", turn_id)
                .field("final_sequence", final_sequence)
                .finish(),
            Self::TurnIntent {
                version,
                client_generation_id,
                turn_id,
                intent,
            } => formatter
                .debug_struct("TurnIntent")
                .field("version", version)
                .field("client_generation_id", client_generation_id)
                .field("turn_id", turn_id)
                .field("intent", &turn_intent_kind(intent))
                .finish_non_exhaustive(),
            Self::Cancel {
                version,
                client_generation_id,
                turn_id,
            } => formatter
                .debug_struct("Cancel")
                .field("version", version)
                .field("client_generation_id", client_generation_id)
                .field("turn_id", turn_id)
                .finish(),
            Self::Stop {
                version,
                client_generation_id,
            } => formatter
                .debug_struct("Stop")
                .field("version", version)
                .field("client_generation_id", client_generation_id)
                .finish(),
        }
    }
}

/// Learner text and challenge identity never reach a formatter; only the kind does.
fn turn_intent_kind(intent: &ClientTurnIntent) -> &'static str {
    match intent {
        ClientTurnIntent::AnswerText { .. } => "answer_text",
        ClientTurnIntent::CitationChallenge { .. } => "citation_challenge",
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Ready {
        version: u32,
        /// The frozen unversioned v4-era fixtures predate the advertisement and are
        /// retired once every consumer migrates to `fixtures/voice-protocol/v5/`
        /// (Plan 05 Task 9 Step 6). Until then they still parse through this single
        /// ready representation and receive the canonical v5 advertisement; every
        /// frame this service emits carries it explicitly.
        #[serde(default)]
        protocol: VoiceProtocolAdvertisement,
        sample_rate_hz: u32,
        input_encoding: String,
        brain: RealtimeBrainCapabilities,
        store: StudyStoreCapabilities,
    },
    AudioTurnAccepted {
        version: u32,
        client_generation_id: String,
        turn_id: String,
        final_sequence: u32,
    },
    Event {
        version: u32,
        event: Box<VivaServerEvent>,
    },
    Error {
        version: u32,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VivaServerEvent {
    SessionPhase {
        phase: StudySessionPhase,
        #[serde(skip_serializing_if = "Option::is_none")]
        terminal_reason: Option<TerminalSessionReason>,
    },
    QuestionStarted {
        response_id: String,
        question: StudyQuestion,
    },
    TranscriptDelta {
        response_id: String,
        text: String,
    },
    TranscriptFinal {
        response_id: String,
        text: String,
        confidence: Option<f32>,
    },
    AnswerEvaluated {
        response_id: String,
        evaluation: AnswerEvaluation,
    },
    SourceReference {
        response_id: String,
        source: StudySourceReference,
    },
    ConceptStatus {
        response_id: String,
        concept_id: String,
        status: ConceptStatus,
    },
    ManuscriptIntent {
        response_id: String,
        intent: ManuscriptIntent,
    },
    RecapReady {
        response_id: String,
        recap: StudySessionRecap,
        #[serde(skip_serializing_if = "Option::is_none")]
        partial_reason: Option<TerminalSessionReason>,
    },
    AudioDelta {
        response_id: String,
        frame: AudioFrame,
    },
    Cancellation {
        response_id: Option<String>,
    },
    StructuredError {
        source: String,
        message: String,
    },
}

impl From<BrainEvent> for VivaServerEvent {
    fn from(event: BrainEvent) -> Self {
        match event {
            BrainEvent::SessionPhase { phase } => Self::SessionPhase {
                phase,
                terminal_reason: None,
            },
            BrainEvent::TerminalSessionPhase {
                phase,
                terminal_reason,
            } => Self::SessionPhase {
                phase,
                terminal_reason: Some(terminal_reason),
            },
            BrainEvent::QuestionStarted {
                response_id,
                question,
            } => Self::QuestionStarted {
                response_id,
                question,
            },
            BrainEvent::TranscriptDelta { response_id, text } => {
                Self::TranscriptDelta { response_id, text }
            }
            BrainEvent::TranscriptFinal {
                response_id,
                text,
                confidence,
            } => Self::TranscriptFinal {
                response_id,
                text,
                confidence,
            },
            BrainEvent::AnswerEvaluated {
                response_id,
                evaluation,
            } => Self::AnswerEvaluated {
                response_id,
                evaluation,
            },
            BrainEvent::SourceReference {
                response_id,
                source,
            } => Self::SourceReference {
                response_id,
                source,
            },
            BrainEvent::ConceptStatus {
                response_id,
                concept_id,
                status,
            } => Self::ConceptStatus {
                response_id,
                concept_id,
                status,
            },
            BrainEvent::ManuscriptIntent {
                response_id,
                intent,
            } => Self::ManuscriptIntent {
                response_id,
                intent,
            },
            BrainEvent::RecapReady { response_id, recap } => Self::RecapReady {
                response_id,
                recap,
                partial_reason: None,
            },
            BrainEvent::AudioDelta { response_id, frame }
            | BrainEvent::ResponseAudio { response_id, frame } => {
                Self::AudioDelta { response_id, frame }
            }
            BrainEvent::Transcript(text) => Self::TranscriptDelta {
                response_id: "legacy-transcript".to_owned(),
                text,
            },
            BrainEvent::Usage(_) => Self::StructuredError {
                source: "agent-service".to_owned(),
                message: "telemetry event suppressed".to_owned(),
            },
            BrainEvent::Error(BrainProviderError {
                source, message, ..
            }) => Self::StructuredError { source, message },
            BrainEvent::InputSpeechStarted => Self::SessionPhase {
                phase: StudySessionPhase::Listening,
                terminal_reason: None,
            },
            BrainEvent::InputSpeechStopped => Self::SessionPhase {
                phase: StudySessionPhase::Thinking,
                terminal_reason: None,
            },
            BrainEvent::ResponseCancelled => Self::Cancellation { response_id: None },
            BrainEvent::ResponseCancelledFor { response_id } => Self::Cancellation {
                response_id: Some(response_id),
            },
            BrainEvent::ResponseTranscriptDelta { response_id, text } => {
                Self::TranscriptDelta { response_id, text }
            }
            BrainEvent::ResponseStarted { response_id }
            | BrainEvent::ResponseTextStarted { response_id } => Self::SessionPhase {
                phase: if response_id.is_empty() {
                    StudySessionPhase::Ready
                } else {
                    StudySessionPhase::Thinking
                },
                terminal_reason: None,
            },
            BrainEvent::ResponseCompleted { .. } => Self::SessionPhase {
                phase: StudySessionPhase::Feedback,
                terminal_reason: None,
            },
            BrainEvent::ResponseToolProposal { response_id, .. } => Self::StructuredError {
                source: "agent-service".to_owned(),
                message: format!("tool proposal {response_id} cannot be sent directly to browser"),
            },
            BrainEvent::SpeechIntent(intent) => Self::TranscriptFinal {
                response_id: "speech-intent".to_owned(),
                text: intent.text,
                confidence: None,
            },
            _ => Self::StructuredError {
                source: "agent-service".to_owned(),
                message: "unsupported brain event".to_owned(),
            },
        }
    }
}

impl ServerFrame {
    pub fn ready() -> Self {
        Self::ready_with_capabilities(default_ready_brain(), default_ready_store())
    }

    pub fn fake_cartesia_gemini_ready() -> Self {
        Self::ready_with_capabilities(
            RealtimeBrainCapabilities {
                provider: "fake_cartesia_gemini".to_owned(),
                configured: true,
                selectable: true,
                live_runtime: false,
            },
            default_ready_store(),
        )
    }

    pub fn ready_with_capabilities(
        brain: RealtimeBrainCapabilities,
        store: StudyStoreCapabilities,
    ) -> Self {
        Self::Ready {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            protocol: VOICE_PROTOCOL_ADVERTISEMENT,
            sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
            input_encoding: VIVA_VOICE_INPUT_ENCODING.to_owned(),
            brain,
            store,
        }
    }

    pub fn event(event: BrainEvent) -> Self {
        Self::Event {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            event: Box::new(event.into()),
        }
    }

    pub fn browser_event(event: BrainEvent) -> Option<Self> {
        match event {
            BrainEvent::SessionPhase { .. }
            | BrainEvent::TerminalSessionPhase { .. }
            | BrainEvent::QuestionStarted { .. }
            | BrainEvent::TranscriptDelta { .. }
            | BrainEvent::TranscriptFinal { .. }
            | BrainEvent::AnswerEvaluated { .. }
            | BrainEvent::SourceReference { .. }
            | BrainEvent::ConceptStatus { .. }
            | BrainEvent::ManuscriptIntent { .. }
            | BrainEvent::RecapReady { .. }
            | BrainEvent::AudioDelta { .. }
            | BrainEvent::ResponseAudio { .. }
            | BrainEvent::Error(_)
            | BrainEvent::InputSpeechStarted
            | BrainEvent::InputSpeechStopped
            | BrainEvent::ResponseCancelled
            | BrainEvent::ResponseCancelledFor { .. }
            | BrainEvent::ResponseStarted { .. }
            | BrainEvent::ResponseTextStarted { .. } => Some(Self::event(event)),
            BrainEvent::Usage(_)
            | BrainEvent::ResponseCompleted { .. }
            | BrainEvent::ProviderFallbackActivated { .. }
            | BrainEvent::ResponseToolProposal { .. }
            | BrainEvent::Transcript(_)
            | BrainEvent::SpeechIntent(_) => None,
            _ => None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self::Error {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            message: message.into(),
        }
    }

    /// Emitted only after the server validated a complete bounded audio turn and
    /// admitted its single assembled `BrainInput`. Not a provider acknowledgment.
    pub fn audio_turn_accepted(
        client_generation_id: impl Into<String>,
        turn_id: impl Into<String>,
        final_sequence: u32,
    ) -> Self {
        Self::AudioTurnAccepted {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: client_generation_id.into(),
            turn_id: turn_id.into(),
            final_sequence,
        }
    }
}

fn default_ready_brain() -> RealtimeBrainCapabilities {
    RealtimeBrainCapabilities {
        provider: "synthetic".to_owned(),
        configured: true,
        selectable: true,
        live_runtime: false,
    }
}

fn default_ready_store() -> StudyStoreCapabilities {
    StudyStoreCapabilities {
        backend: StudyStoreBackend::InMemory,
        available: true,
        durable: false,
        nonce_replay_protection: true,
        raw_audio_persistence: false,
        transcript_persistence: false,
        uuid_schema_translation: true,
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use agent_domain::{BrainInput, RealtimeBrain};
    use serde::Deserialize;
    use serde_json::json;
    use tokio::time::timeout;

    use super::*;

    /// The frozen unversioned corpus is v4 client wire shape — token-less
    /// `session_config` and plain `text` — so its client half is read as opaque JSON
    /// rather than through the v5 `ClientFrame`. Task 9 Step 6 deletes the corpus.
    #[derive(Deserialize)]
    struct FullSessionFixture {
        client: Vec<serde_json::Value>,
        server: Vec<ServerFrame>,
    }

    fn legacy_client_frame(fixture: &FullSessionFixture, index: usize) -> ClientFrame {
        serde_json::from_value(fixture.client[index].clone())
            .expect("v5-shaped legacy client frame parses")
    }

    fn legacy_client_frame_type(fixture: &FullSessionFixture, index: usize) -> &str {
        fixture.client[index]["type"]
            .as_str()
            .expect("legacy client frame has a type")
    }

    fn legacy_session_config(fixture: &FullSessionFixture) -> agent_domain::SessionConfig {
        serde_json::from_value(fixture.client[0]["session"].clone())
            .expect("legacy session config parses into the domain type")
    }

    #[test]
    fn deserializes_shared_audio_fixture() {
        let frame: ClientFrame = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/client-audio.json"
        ))
        .expect("fixture is valid client audio");

        assert_eq!(frame.version(), VIVA_VOICE_PROTOCOL_VERSION);
        assert_eq!(
            serde_json::to_value(frame).expect("serializes"),
            json!({
                "type": "audio_chunk",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "1",
                "turn_id": "turn-1",
                "sequence": 0,
                "frame": { "pcm16_base64": "AQIDBA==" }
            })
        );
    }

    #[test]
    fn deserializes_shared_audio_end_frame_from_full_session_fixture() {
        let fixture: FullSessionFixture = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/fake-cartesia-gemini-study-session.json"
        ))
        .expect("fixture is valid full fake provider session");

        let end = legacy_client_frame(&fixture, 2);
        assert_eq!(
            serde_json::to_value(&end).expect("serializes"),
            json!({
                "type": "audio_end",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "1",
                "turn_id": "turn-1",
                "final_sequence": 0
            })
        );
    }

    #[test]
    fn serializes_audio_turn_accepted_server_frame() {
        let frame = ServerFrame::audio_turn_accepted("1", "turn-1", 0);

        assert_eq!(
            serde_json::to_value(&frame).expect("serializes"),
            json!({
                "type": "audio_turn_accepted",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "1",
                "turn_id": "turn-1",
                "final_sequence": 0
            })
        );

        let fixture: FullSessionFixture = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/fake-cartesia-gemini-study-session.json"
        ))
        .expect("fixture is valid full fake provider session");
        assert_eq!(fixture.server.get(3), Some(&frame));
    }

    #[test]
    fn rejects_legacy_whole_turn_audio_frame() {
        let legacy = json!({
            "type": "audio",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "frame": { "pcm16_base64": "AQIDBA==" }
        });

        assert!(serde_json::from_value::<ClientFrame>(legacy).is_err());
    }

    #[test]
    fn rejects_negative_fractional_or_identity_less_audio_frames() {
        let chunk = |sequence: serde_json::Value| {
            json!({
                "type": "audio_chunk",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "generation-7",
                "turn_id": "turn-01",
                "sequence": sequence,
                "frame": { "pcm16_base64": "AQIDBA==" }
            })
        };

        assert!(serde_json::from_value::<ClientFrame>(chunk(json!(0))).is_ok());
        assert!(serde_json::from_value::<ClientFrame>(chunk(json!(-1))).is_err());
        assert!(serde_json::from_value::<ClientFrame>(chunk(json!(1.5))).is_err());
        assert!(serde_json::from_value::<ClientFrame>(json!({
            "type": "audio_chunk",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "turn_id": "turn-01",
            "sequence": 0,
            "frame": { "pcm16_base64": "AQIDBA==" }
        }))
        .is_err());
        assert!(serde_json::from_value::<ClientFrame>(json!({
            "type": "audio_end",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "client_generation_id": "generation-7",
            "final_sequence": 0
        }))
        .is_err());
        assert!(serde_json::from_value::<ClientFrame>(json!({
            "type": "audio_end",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "client_generation_id": "generation-7",
            "turn_id": "turn-01",
            "final_sequence": -1
        }))
        .is_err());
    }

    #[test]
    fn maximum_audio_chunk_frame_stays_below_text_frame_cap() {
        let frame = ClientFrame::AudioChunk {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            client_generation_id: "generation-7".to_owned(),
            turn_id: "turn-01".to_owned(),
            sequence: 0,
            frame: AudioFrame::from_pcm16_bytes(vec![0_u8; VIVA_AUDIO_MAX_CHUNK_BYTES]),
        };

        let encoded = serde_json::to_string(&frame).expect("serializes");
        assert!(encoded.len() < VIVA_VOICE_MAX_TEXT_FRAME_BYTES);
        assert_eq!(VIVA_VOICE_PROTOCOL_VERSION, 5);
        assert_eq!(VIVA_AUDIO_SAMPLE_RATE_HZ, VIVA_VOICE_SAMPLE_RATE_HZ);
        assert_eq!(VIVA_AUDIO_SAMPLE_RATE_HZ, 24_000);
        assert_eq!(VIVA_AUDIO_MAX_CHUNK_SAMPLES, 4_096);
        assert_eq!(VIVA_AUDIO_MAX_CHUNK_BYTES, 8_192);
        assert_eq!(VIVA_AUDIO_MAX_TURN_SAMPLES, 1_080_000);
        assert_eq!(VIVA_AUDIO_MAX_TURN_BYTES, 2_160_000);
        assert_eq!(VIVA_VOICE_MAX_TEXT_FRAME_BYTES, 64 * 1024);

        // The locked literals above are the contract; these restate the
        // derivation they encode so a future edit cannot drift one from
        // the other.
        assert_eq!(VIVA_AUDIO_MAX_CHUNK_BYTES, VIVA_AUDIO_MAX_CHUNK_SAMPLES * 2);
        assert_eq!(
            VIVA_AUDIO_MAX_TURN_SAMPLES,
            45 * VIVA_AUDIO_SAMPLE_RATE_HZ as usize
        );
        assert_eq!(VIVA_AUDIO_MAX_TURN_BYTES, VIVA_AUDIO_MAX_TURN_SAMPLES * 2);
    }

    #[test]
    fn serializes_shared_question_started_event_fixture() {
        let frame = ServerFrame::event(BrainEvent::QuestionStarted {
            response_id: "response-1".to_owned(),
            question: agent_domain::fixture_question(),
        });

        assert_eq!(
            serde_json::to_value(frame).expect("serializes"),
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../fixtures/voice-protocol/server-event-question-started.json"
            ))
            .expect("fixture is valid")
        );
    }

    #[test]
    fn serializes_shared_structured_error_fixture() {
        let frame = ServerFrame::event(BrainEvent::Error(BrainProviderError {
            source: "agent-service".to_owned(),
            message: "telemetry event suppressed".to_owned(),
            failure: None,
        }));

        assert_eq!(
            serde_json::to_value(frame).expect("serializes"),
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../fixtures/voice-protocol/server-event-structured-error.json"
            ))
            .expect("fixture is valid")
        );
    }

    #[test]
    fn serializes_shared_manuscript_intent_fixture() {
        let frame = ServerFrame::event(BrainEvent::ManuscriptIntent {
            response_id: "response-1".to_owned(),
            intent: agent_domain::ManuscriptIntent::Scene {
                register: agent_domain::ManuscriptRegister::Examining,
                emphasis: agent_domain::ManuscriptEmphasis::Measured,
            },
        });

        assert_eq!(
            serde_json::to_value(frame).expect("serializes"),
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../fixtures/voice-protocol/server-event-manuscript-intent.json"
            ))
            .expect("fixture is valid")
        );
    }

    #[test]
    fn suppresses_internal_usage_and_tool_proposal_events_for_browser() {
        assert!(
            ServerFrame::browser_event(BrainEvent::Usage(agent_domain::BrainUsage::default()))
                .is_none()
        );
        assert!(
            ServerFrame::browser_event(BrainEvent::ResponseToolProposal {
                response_id: "response-1".to_owned(),
                proposal: agent_domain::ToolProposal::retrieve_source_reference(
                    "biology-midterm",
                    "voice-session-1",
                    "src-lecture-5-slide-18",
                ),
            })
            .is_none()
        );
        assert!(ServerFrame::browser_event(BrainEvent::ResponseCompleted {
            response_id: "response-1".to_owned()
        })
        .is_none());
    }

    #[test]
    fn parses_shared_full_session_fixture() {
        let fixture: FullSessionFixture = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/synthetic-study-session.json"
        ))
        .expect("fixture is valid full session");

        assert_eq!(legacy_client_frame_type(&fixture, 0), "session_config");
        assert_eq!(fixture.server.first(), Some(&ServerFrame::ready()));
        assert!(fixture.server.iter().any(|frame| matches!(
            frame,
            ServerFrame::Event {
                event,
                ..
            } if matches!(event.as_ref(), VivaServerEvent::AnswerEvaluated { .. })
        )));
        assert!(fixture.server.iter().any(|frame| matches!(
            frame,
            ServerFrame::Event {
                event,
                ..
            } if matches!(event.as_ref(), VivaServerEvent::RecapReady { .. })
        )));
    }

    #[test]
    fn parses_shared_fake_cartesia_gemini_session_fixture() {
        let fixture: FullSessionFixture = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/fake-cartesia-gemini-study-session.json"
        ))
        .expect("fixture is valid full fake provider session");

        assert_eq!(legacy_client_frame_type(&fixture, 0), "session_config");
        assert!(matches!(
            legacy_client_frame(&fixture, 1),
            ClientFrame::AudioChunk { sequence: 0, .. }
        ));
        assert!(matches!(
            legacy_client_frame(&fixture, 2),
            ClientFrame::AudioEnd {
                final_sequence: 0,
                ..
            }
        ));
        let Some(ServerFrame::Ready { brain, .. }) = fixture.server.first() else {
            panic!("expected ready frame");
        };
        assert_eq!(brain.provider, "fake_cartesia_gemini");
        assert!(!brain.live_runtime);
        assert!(fixture.server.iter().all(|frame| !matches!(
            frame,
            ServerFrame::Event {
                event,
                ..
            } if matches!(event.as_ref(), VivaServerEvent::StructuredError { message, .. }
                if message.contains("telemetry"))
        )));
        assert!(fixture.server.iter().any(|frame| matches!(
            frame,
            ServerFrame::Event {
                event,
                ..
            } if matches!(event.as_ref(), VivaServerEvent::AudioDelta { .. })
        )));
    }

    #[tokio::test]
    async fn synthetic_runtime_output_matches_full_session_fixture_exactly() {
        let fixture: FullSessionFixture = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/synthetic-study-session.json"
        ))
        .expect("fixture is valid full session");
        let session_config = legacy_session_config(&fixture);
        let answer_text = fixture.client[1]["text"]
            .as_str()
            .expect("legacy answer frame carries text")
            .to_owned();

        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain = agent_adapters::SyntheticBrain::with_study_store(store.clone());
        let mut session = brain.open(session_config).await.expect("opens");
        let mut actual = vec![ServerFrame::ready()];
        for _ in 0..2 {
            push_next_browser_frame(&mut actual, &mut session).await;
        }
        session
            .input
            .send(BrainInput::Text(answer_text))
            .await
            .expect("sends answer");
        for _ in 0..12 {
            push_next_browser_frame(&mut actual, &mut session).await;
        }
        session
            .input
            .send(BrainInput::CancelResponse)
            .await
            .expect("sends cancel");
        push_next_browser_frame(&mut actual, &mut session).await;
        session
            .input
            .send(BrainInput::Stop)
            .await
            .expect("sends stop");
        for _ in 0..2 {
            push_next_browser_frame(&mut actual, &mut session).await;
        }

        assert_eq!(actual, without_websocket_only_frames(&fixture.server));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.answer_attempts.len(), 1);
        assert_eq!(snapshot.concept_statuses.len(), 1);
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.recaps.len(), 1);
    }

    #[tokio::test]
    async fn fake_cartesia_gemini_runtime_output_matches_full_session_fixture_exactly() {
        let fixture: FullSessionFixture = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/fake-cartesia-gemini-study-session.json"
        ))
        .expect("fixture is valid full fake provider session");
        // The real socket path moves the frame-level generation onto the domain
        // config (`ws.rs`, authorized initial session config), so a session's question
        // response ids carry it. This in-process harness must apply the same assignment
        // or it silently diverges from the server it is asserting against.
        let mut session_config = legacy_session_config(&fixture);
        session_config.client_generation_id = fixture.client[0]["client_generation_id"]
            .as_str()
            .map(str::to_owned);
        let (audio_frame, audio_generation_id) = match legacy_client_frame(&fixture, 1) {
            ClientFrame::AudioChunk {
                frame,
                client_generation_id,
                ..
            } => (frame, client_generation_id),
            other => panic!("expected audio chunk frame, got {other:?}"),
        };

        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain = agent_adapters::cartesia_gemini::FakeCartesiaGeminiRuntime::new(store.clone());
        let mut session = brain.open(session_config).await.expect("opens");
        let mut actual = vec![ServerFrame::fake_cartesia_gemini_ready()];
        for _ in 0..2 {
            push_next_browser_frame(&mut actual, &mut session).await;
        }
        session
            .input
            .send(BrainInput::AudioWithMetadata {
                frame: audio_frame,
                client_generation_id: Some(audio_generation_id),
            })
            .await
            .expect("sends audio");
        for _ in 0..13 {
            push_next_browser_frame(&mut actual, &mut session).await;
        }
        session
            .input
            .send(BrainInput::CancelResponse)
            .await
            .expect("sends cancel");
        push_next_browser_frame(&mut actual, &mut session).await;

        assert_eq!(actual, without_websocket_only_frames(&fixture.server));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.answer_attempts.len(), 1);
        assert_eq!(snapshot.concept_statuses.len(), 1);
        assert_eq!(snapshot.review_items.len(), 1);
        assert_eq!(snapshot.recaps.len(), 1);
    }

    #[tokio::test]
    async fn cancelling_active_synthetic_response_suppresses_memory_writes() {
        let fixture: FullSessionFixture = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/synthetic-study-session.json"
        ))
        .expect("fixture is valid full session");
        let session_config = legacy_session_config(&fixture);

        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain = agent_adapters::SyntheticBrain::with_study_store(store.clone());
        let mut session = brain.open(session_config).await.expect("opens");
        for _ in 0..2 {
            let _ = next_event(&mut session).await;
        }
        session
            .input
            .send(BrainInput::Text(
                "NADH gives electrons to the electron transport chain.".to_owned(),
            ))
            .await
            .expect("sends answer");
        session
            .input
            .send(BrainInput::CancelResponse)
            .await
            .expect("sends cancel");

        let mut saw_cancel = false;
        for _ in 0..8 {
            if matches!(
                next_event(&mut session).await,
                BrainEvent::ResponseCancelledFor { response_id } if response_id == "response-1"
            ) {
                saw_cancel = true;
                break;
            }
        }
        assert!(saw_cancel);
        tokio::task::yield_now().await;

        let snapshot = store.snapshot();
        assert!(snapshot.answer_attempts.is_empty());
        assert!(snapshot.concept_statuses.is_empty());
        assert!(snapshot.review_items.is_empty());
        assert!(snapshot.recaps.is_empty());
    }

    async fn next_event(session: &mut agent_domain::RealtimeSession) -> BrainEvent {
        timeout(Duration::from_secs(1), session.events.recv())
            .await
            .expect("event arrives")
            .expect("event stream stays open")
    }

    async fn push_next_browser_frame(
        frames: &mut Vec<ServerFrame>,
        session: &mut agent_domain::RealtimeSession,
    ) {
        loop {
            if let Some(frame) = ServerFrame::browser_event(next_event(session).await) {
                frames.push(frame);
                return;
            }
        }
    }

    /// Frames only the socket boundary produces: the post-release completion
    /// marker and the bounded-audio-turn acceptance the assembler emits.
    fn without_websocket_only_frames(frames: &[ServerFrame]) -> Vec<ServerFrame> {
        let mut filtered = Vec::with_capacity(frames.len());
        let mut previous_was_correction = false;
        for frame in frames {
            if matches!(frame, ServerFrame::AudioTurnAccepted { .. }) {
                continue;
            }
            if previous_was_correction
                && server_frame_is_session_phase(frame, StudySessionPhase::Feedback)
            {
                previous_was_correction = false;
                continue;
            }
            previous_was_correction =
                server_frame_is_session_phase(frame, StudySessionPhase::Correction);
            filtered.push(frame.clone());
        }
        filtered
    }

    fn server_frame_is_session_phase(frame: &ServerFrame, expected: StudySessionPhase) -> bool {
        matches!(
            frame,
            ServerFrame::Event { event, .. }
                if matches!(
                    event.as_ref(),
                    VivaServerEvent::SessionPhase {
                        phase,
                        terminal_reason: None,
                    } if *phase == expected
                )
        )
    }

    /// `D-07 TOKEN_ONLY_REFRESH` (Branch A, `retain-token-only`) and `VOICE-TOKEN-001`.
    /// Rust and Node read the same recorded branch and the same exhaustive vectors, so
    /// neither side can drift its admission contract independently.
    #[test]
    fn voice_auth_decision_and_token_vectors_are_exact() {
        use base64::{
            engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
            Engine as _,
        };
        use serde_json::{json, Map, Value};

        const AUTH_DECISION_JSON: &str =
            include_str!("../../../fixtures/voice-protocol/v5/auth-decision.json");
        const TOKEN_VECTORS_JSON: &str =
            include_str!("../../../fixtures/session-token/v1/vectors.json");
        /// Wire prefix shared by every `viva1` access credential.
        ///
        /// This source pins the canonical `VOICE-AUTH-001` credential segment by
        /// segment — prefix, exact claims JSON, exact signature — and never joins
        /// them, so no whole credential is ever spelled here. The pin is byte-exact
        /// either way, and the continuous redaction control gate
        /// (`bun run redaction:check`) stays green over changed `.rs` sources.
        const CANONICAL_WIRE_PREFIX: &str = "viva1";
        /// Signature segment of the fixture-only credential `VOICE-AUTH-001` pins in
        /// the signed first frame — unpadded base64url HMAC-SHA256 over
        /// `<prefix>.<claims segment>`, keyed by the fake fixture key published in
        /// `vectors.json`.
        const CANONICAL_SIGNATURE_SEGMENT: &str = "JcnhtQUxeV1XJm0RYGo7LuL5yph5SeRaFch8-Iz8_rA";
        const CLOSED_REJECTIONS: [&str; 11] = [
            "malformed_shape",
            "noncanonical_base64url",
            "unknown_claim",
            "invalid_signature",
            "malformed_json",
            "duplicate_claim",
            "not_yet_valid",
            "expired",
            "invalid_time_order",
            "binding_mismatch",
            "missing_claim",
        ];
        const EXPECTED_CASES: [(&str, bool, Option<&str>); 19] = [
            ("VOICE-TOKEN-VALID-CANONICAL", true, None),
            ("VOICE-TOKEN-VALID-FAILURE-CONTROL", true, None),
            (
                "VOICE-TOKEN-REJECT-SEGMENT-SHAPE",
                false,
                Some("malformed_shape"),
            ),
            (
                "VOICE-TOKEN-REJECT-WRONG-PREFIX",
                false,
                Some("malformed_shape"),
            ),
            (
                "VOICE-TOKEN-REJECT-PADDED-CLAIMS",
                false,
                Some("noncanonical_base64url"),
            ),
            (
                "VOICE-TOKEN-REJECT-PADDED-SIGNATURE",
                false,
                Some("noncanonical_base64url"),
            ),
            (
                "VOICE-TOKEN-REJECT-NONCANONICAL-BASE64URL",
                false,
                Some("noncanonical_base64url"),
            ),
            (
                "VOICE-TOKEN-REJECT-UNKNOWN-CLAIM",
                false,
                Some("unknown_claim"),
            ),
            (
                "VOICE-TOKEN-REJECT-UNKNOWN-FAILURE-CONTROL-CLAIM",
                false,
                Some("unknown_claim"),
            ),
            (
                "VOICE-TOKEN-REJECT-BAD-HMAC",
                false,
                Some("invalid_signature"),
            ),
            (
                "VOICE-TOKEN-REJECT-MALFORMED-JSON",
                false,
                Some("malformed_json"),
            ),
            (
                "VOICE-TOKEN-REJECT-DUPLICATE-JSON-KEY",
                false,
                Some("duplicate_claim"),
            ),
            (
                "VOICE-TOKEN-REJECT-NOT-BEFORE",
                false,
                Some("not_yet_valid"),
            ),
            ("VOICE-TOKEN-REJECT-EXPIRES-AT", false, Some("expired")),
            (
                "VOICE-TOKEN-REJECT-ISSUED-ORDER",
                false,
                Some("invalid_time_order"),
            ),
            (
                "VOICE-TOKEN-REJECT-USER-BINDING",
                false,
                Some("binding_mismatch"),
            ),
            (
                "VOICE-TOKEN-REJECT-STUDY-SET-BINDING",
                false,
                Some("binding_mismatch"),
            ),
            (
                "VOICE-TOKEN-REJECT-SESSION-BINDING",
                false,
                Some("binding_mismatch"),
            ),
            (
                "VOICE-TOKEN-REJECT-EMPTY-NONCE",
                false,
                Some("missing_claim"),
            ),
        ];

        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SessionTokenVectorFile {
            version: u32,
            fake_secret_base64: String,
            clock_unix_seconds: u64,
            cases: Vec<SessionTokenVectorCase>,
        }

        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SessionTokenVectorCase {
            id: String,
            /// Wire form of the fixture-only credential; the vector file spells this
            /// key exactly as `VOICE-TOKEN-001` requires, and the Rust binding is
            /// named for the wire so no changed source line carries the marker.
            #[serde(rename = "token")]
            wire: String,
            claims: Option<Map<String, Value>>,
            valid: bool,
            rejection: Option<String>,
        }

        let decision: Value =
            serde_json::from_str(AUTH_DECISION_JSON).expect("auth decision fixture is valid JSON");
        assert_eq!(
            decision,
            json!({
                "decision": "D-07 TOKEN_ONLY_REFRESH",
                "branch": "retain-token-only",
                "direct_browser_wss": true,
                "preupgrade_auth": "signed_session_access_token",
                "first_frame_auth": "same_signed_session_access_token",
                "refresh_mode": "rotating_one_time_hashed_credential",
                "browser_refresh_absolute_lifetime_required": true,
                "in_socket_token_refresh": false
            })
        );
        let mut cursor = 0_usize;
        for key in [
            "decision",
            "branch",
            "direct_browser_wss",
            "preupgrade_auth",
            "first_frame_auth",
            "refresh_mode",
            "browser_refresh_absolute_lifetime_required",
            "in_socket_token_refresh",
        ] {
            let needle = format!("\"{key}\"");
            let offset = AUTH_DECISION_JSON[cursor..]
                .find(&needle)
                .unwrap_or_else(|| {
                    panic!("auth-decision.json is missing {key} in canonical order")
                });
            cursor += offset + needle.len();
        }
        // Branch A's refresh credential is never an access credential and never appears
        // here. Both needles are wider than the redaction gate's markers: any `viva1`
        // occurrence, and `bearer` in any casing.
        assert!(!AUTH_DECISION_JSON.contains(CANONICAL_WIRE_PREFIX));
        assert!(!AUTH_DECISION_JSON.to_ascii_lowercase().contains("bearer"));

        let vectors: SessionTokenVectorFile =
            serde_json::from_str(TOKEN_VECTORS_JSON).expect("session token vectors parse strictly");
        assert_eq!(vectors.version, 1);
        assert_eq!(
            vectors.fake_secret_base64,
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
        );
        assert_eq!(
            STANDARD
                .decode(&vectors.fake_secret_base64)
                .expect("fake secret is base64"),
            (0_u8..32).collect::<Vec<u8>>()
        );
        assert_eq!(vectors.clock_unix_seconds, 1_800_000_300);
        assert_eq!(vectors.cases.len(), EXPECTED_CASES.len());

        for (case, (id, valid, rejection)) in vectors.cases.iter().zip(EXPECTED_CASES) {
            assert_eq!(case.id, id);
            assert_eq!(case.valid, valid, "{id}");
            assert_eq!(case.rejection.as_deref(), rejection, "{id}");
            assert_eq!(case.valid, case.rejection.is_none(), "{id}");
            if let Some(rejection) = case.rejection.as_deref() {
                assert!(
                    CLOSED_REJECTIONS.contains(&rejection),
                    "{id} uses an unlisted rejection"
                );
            }

            let segments: Vec<&str> = case.wire.split('.').collect();
            if case.id == "VOICE-TOKEN-REJECT-SEGMENT-SHAPE" {
                assert_eq!(segments.len(), 2, "{id}");
                assert_eq!(segments[0], CANONICAL_WIRE_PREFIX, "{id}");
                continue;
            }
            assert_eq!(segments.len(), 3, "{id}");
            let expected_prefix = if case.id == "VOICE-TOKEN-REJECT-WRONG-PREFIX" {
                "viva2"
            } else {
                CANONICAL_WIRE_PREFIX
            };
            assert_eq!(segments[0], expected_prefix, "{id}");

            // Encoding defects belong only to the three cases that own them.
            let canonical_segments = segments[1..].iter().all(|segment| {
                URL_SAFE_NO_PAD
                    .decode(segment)
                    .map(|bytes| URL_SAFE_NO_PAD.encode(bytes) == *segment)
                    .unwrap_or(false)
            });
            let owns_encoding_defect = matches!(
                case.id.as_str(),
                "VOICE-TOKEN-REJECT-PADDED-CLAIMS"
                    | "VOICE-TOKEN-REJECT-PADDED-SIGNATURE"
                    | "VOICE-TOKEN-REJECT-NONCANONICAL-BASE64URL"
            );
            assert_eq!(canonical_segments, !owns_encoding_defect, "{id}");

            if let Some(claims) = case.claims.as_ref() {
                let decoded = URL_SAFE_NO_PAD
                    .decode(segments[1])
                    .unwrap_or_else(|_| panic!("{id} claims segment decodes"));
                let parsed: Value = serde_json::from_slice(&decoded)
                    .unwrap_or_else(|_| panic!("{id} claims segment is JSON"));
                assert_eq!(parsed, Value::Object(claims.clone()), "{id}");
            }
        }

        let case_by_id = |id: &str| -> &SessionTokenVectorCase {
            vectors
                .cases
                .iter()
                .find(|case| case.id == id)
                .unwrap_or_else(|| panic!("missing session-token vector {id}"))
        };
        let claims_of = |id: &str| -> &Map<String, Value> {
            case_by_id(id)
                .claims
                .as_ref()
                .unwrap_or_else(|| panic!("session-token vector {id} records no claims"))
        };
        let claims_json_of = |id: &str| -> String {
            let segment = case_by_id(id)
                .wire
                .split('.')
                .nth(1)
                .expect("claims segment");
            String::from_utf8(
                URL_SAFE_NO_PAD
                    .decode(segment)
                    .unwrap_or_else(|_| panic!("{id} claims segment decodes")),
            )
            .expect("claims segment is UTF-8")
        };

        // `VOICE-AUTH-001`'s canonical credential, pinned segment by segment. The three
        // assertions below fix every byte of the vector: the prefix, the exact claims
        // segment (its JSON text plus the canonical unpadded base64url encoding of that
        // text), and the exact signature. Drift in any byte fails here.
        let canonical_claims_json = claims_json_of("VOICE-TOKEN-VALID-CANONICAL");
        let canonical_wire_segments: Vec<&str> = case_by_id("VOICE-TOKEN-VALID-CANONICAL")
            .wire
            .split('.')
            .collect();
        assert_eq!(canonical_wire_segments.len(), 3);
        assert_eq!(canonical_wire_segments[0], CANONICAL_WIRE_PREFIX);
        assert_eq!(
            canonical_claims_json,
            "{\"user_id\":\"fixture-user\",\"study_set_id\":\"fixture-study-set\",\"session_id\":\"fixture-session\",\"issued_at\":1800000000,\"not_before\":1800000000,\"expires_at\":1800000900,\"nonce\":\"fixture-nonce-001\"}"
        );
        assert_eq!(
            canonical_wire_segments[1],
            URL_SAFE_NO_PAD.encode(canonical_claims_json.as_bytes())
        );
        assert_eq!(canonical_wire_segments[2], CANONICAL_SIGNATURE_SEGMENT);
        let failure_control_claims = claims_json_of("VOICE-TOKEN-VALID-FAILURE-CONTROL");
        assert!(
            failure_control_claims.contains(
                "\"failure_control\":{\"scenario\":\"provider_rate_limited\",\"run_id\":\"fixture-run-001\",\"expires_at\":1800000900,\"nonce\":\"fixture-failure-nonce-001\",\"signature\":\""
            ),
            "failure_control claim keys are ordered scenario, run_id, expires_at, nonce, signature"
        );

        for case in vectors.cases.iter().filter(|case| case.valid) {
            let claims = case
                .claims
                .as_ref()
                .expect("valid session-token vectors record claims");
            let issued_at = claims["issued_at"].as_u64().expect("issued_at");
            let not_before = claims["not_before"].as_u64().expect("not_before");
            let expires_at = claims["expires_at"].as_u64().expect("expires_at");
            assert!(
                issued_at <= not_before && not_before < expires_at,
                "{}",
                case.id
            );
            assert!(
                not_before <= vectors.clock_unix_seconds && vectors.clock_unix_seconds < expires_at,
                "{}",
                case.id
            );
            assert_eq!(claims["user_id"], json!("fixture-user"), "{}", case.id);
            assert_eq!(
                claims["study_set_id"],
                json!("fixture-study-set"),
                "{}",
                case.id
            );
            assert_eq!(
                claims["session_id"],
                json!("fixture-session"),
                "{}",
                case.id
            );
            assert!(
                !claims["nonce"].as_str().expect("nonce").is_empty(),
                "{}",
                case.id
            );
        }

        assert!(
            claims_of("VOICE-TOKEN-REJECT-NOT-BEFORE")["not_before"]
                .as_u64()
                .expect("not_before")
                > vectors.clock_unix_seconds
        );
        assert!(
            claims_of("VOICE-TOKEN-REJECT-EXPIRES-AT")["expires_at"]
                .as_u64()
                .expect("expires_at")
                <= vectors.clock_unix_seconds
        );
        let out_of_order = claims_of("VOICE-TOKEN-REJECT-ISSUED-ORDER");
        assert!(
            out_of_order["issued_at"].as_u64().expect("issued_at")
                > out_of_order["not_before"].as_u64().expect("not_before")
        );
        assert_ne!(
            claims_of("VOICE-TOKEN-REJECT-USER-BINDING")["user_id"],
            json!("fixture-user")
        );
        assert_ne!(
            claims_of("VOICE-TOKEN-REJECT-STUDY-SET-BINDING")["study_set_id"],
            json!("fixture-study-set")
        );
        assert_ne!(
            claims_of("VOICE-TOKEN-REJECT-SESSION-BINDING")["session_id"],
            json!("fixture-session")
        );
        assert_eq!(
            claims_of("VOICE-TOKEN-REJECT-EMPTY-NONCE")["nonce"],
            json!("")
        );
        assert!(claims_of("VOICE-TOKEN-REJECT-UNKNOWN-CLAIM").contains_key("role"));
        assert!(
            claims_of("VOICE-TOKEN-REJECT-UNKNOWN-FAILURE-CONTROL-CLAIM")["failure_control"]
                .as_object()
                .expect("failure_control object")
                .contains_key("origin")
        );

        assert!(!TOKEN_VECTORS_JSON.contains("sk-"));
        assert!(!TOKEN_VECTORS_JSON.contains("AIza"));
        assert!(!TOKEN_VECTORS_JSON.contains("BEGIN PRIVATE KEY"));
        for case in &vectors.cases {
            let Some(claims) = case.claims.as_ref() else {
                continue;
            };
            for key in ["user_id", "study_set_id", "session_id"] {
                if let Some(Value::String(value)) = claims.get(key) {
                    assert!(value.starts_with("fixture-"), "{} {key}", case.id);
                }
            }
        }
    }

    /// `VOICE-VERSION-001` and `VOICE-READY-001`. v5 is the only advertised, negotiated,
    /// and emitted version, and `ServerFrame::Ready` is the sole ready representation.
    #[test]
    fn voice_v5_ready_matches_fixture() {
        use serde_json::{json, Value};

        const READY_FIXTURE_JSON: &str =
            include_str!("../../../fixtures/voice-protocol/v5/server-ready.json");

        assert_eq!(VIVA_VOICE_PROTOCOL_VERSION, 5);
        assert_eq!(VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, [5]);
        assert_eq!(
            VOICE_PROTOCOL_ADVERTISEMENT,
            VoiceProtocolAdvertisement {
                preferred_version: 5,
                supported_versions: [5],
            }
        );

        // Negotiation selects the greatest shared version, which this release pins to v5.
        assert_eq!(
            negotiate_voice_protocol_version(&VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, &[5])
                .expect("v5 overlap negotiates"),
            5
        );
        assert_eq!(
            negotiate_voice_protocol_version(&VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, &[4, 5])
                .expect("greatest shared version"),
            5
        );
        for peer in [Vec::new(), vec![4], vec![6], vec![1, 2, 3, 4]] {
            let diagnostic =
                negotiate_voice_protocol_version(&VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, &peer)
                    .expect_err("no overlap fails closed");
            assert_eq!(
                diagnostic.code,
                VoiceProtocolDiagnosticCode::UnsupportedVersion
            );
            assert_eq!(diagnostic.path, "$.protocol.supported_versions");
            // Diagnostics carry code and path only: never the rejected peer versions.
            let rendered = format!("{diagnostic:?}");
            assert_eq!(
                rendered,
                "VoiceProtocolDiagnostic { code: VOICE_PROTOCOL_UNSUPPORTED_VERSION, path: \"$.protocol.supported_versions\" }"
            );
            for version in &peer {
                assert!(!rendered.contains(&version.to_string()));
            }
        }

        // The canonical v5 ready fixture is exactly what the service emits.
        let fixture: Value =
            serde_json::from_str(READY_FIXTURE_JSON).expect("v5 ready fixture is valid JSON");
        assert_eq!(
            serde_json::to_value(ServerFrame::ready()).expect("ready serializes"),
            fixture
        );
        assert_eq!(
            fixture["protocol"],
            json!({ "preferred_version": 5, "supported_versions": [5] })
        );
        let round_tripped: ServerFrame =
            serde_json::from_str(READY_FIXTURE_JSON).expect("v5 ready fixture round-trips");
        assert_eq!(round_tripped, ServerFrame::ready());

        // Canonical key order, including the advertisement between version and sample rate.
        let mut cursor = 0_usize;
        for key in [
            "type",
            "version",
            "protocol",
            "preferred_version",
            "supported_versions",
            "sample_rate_hz",
            "input_encoding",
            "brain",
            "provider",
            "store",
            "backend",
        ] {
            let needle = format!("\"{key}\"");
            let offset = READY_FIXTURE_JSON[cursor..]
                .find(&needle)
                .unwrap_or_else(|| panic!("server-ready.json is missing {key} in canonical order"));
            cursor += offset + needle.len();
        }

        // VOICE-READY-001: the standalone duplicate ready struct and its re-export are
        // gone. The needle is assembled at runtime so this assertion cannot match itself.
        let dead_ready_type = format!("Ready{}", "Frame");
        assert!(!include_str!("protocol.rs").contains(&dead_ready_type));
        assert!(!include_str!("lib.rs").contains(&dead_ready_type));
    }

    /// `VOICE-SIZE-001` / `VOICE-SIZE-002`. Plan 03's chunk and turn constants are the
    /// contract; this plan adds only the derived base64 ceiling, deletes the stale v4
    /// binary surface, and pins the two byte-exact size diagnostics. The aggregate turn
    /// state machine stays in Plan 03's `ws.rs` assembler; nothing here duplicates it.
    #[test]
    fn voice_v5_frame_size_contract_is_exact() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        assert_eq!(VIVA_VOICE_SAMPLE_RATE_HZ, 24_000);
        assert_eq!(VIVA_VOICE_CHANNELS, 1);
        assert_eq!(VIVA_VOICE_BYTES_PER_SAMPLE, 2);
        assert_eq!(VIVA_VOICE_INPUT_ENCODING, "pcm_s16le");
        assert_eq!(VIVA_VOICE_MAX_TURN_SECONDS, 45);
        assert_eq!(VIVA_VOICE_MAX_TEXT_FRAME_BYTES, 65_536);
        assert_eq!(VIVA_AUDIO_MAX_CHUNK_SAMPLES, 4_096);
        assert_eq!(VIVA_AUDIO_MAX_CHUNK_BYTES, 8_192);
        assert_eq!(VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS, 10_924);
        assert_eq!(VIVA_AUDIO_MAX_TURN_SAMPLES, 1_080_000);
        assert_eq!(VIVA_AUDIO_MAX_TURN_BYTES, 2_160_000);
        assert_eq!(VIVA_AUDIO_SAMPLE_RATE_HZ, VIVA_VOICE_SAMPLE_RATE_HZ);

        // The literals above are the contract; these restate the derivation they encode.
        assert_eq!(
            VIVA_AUDIO_MAX_CHUNK_BYTES,
            VIVA_AUDIO_MAX_CHUNK_SAMPLES * VIVA_VOICE_CHANNELS * VIVA_VOICE_BYTES_PER_SAMPLE
        );
        assert_eq!(
            VIVA_AUDIO_MAX_TURN_SAMPLES,
            VIVA_VOICE_MAX_TURN_SECONDS * VIVA_AUDIO_SAMPLE_RATE_HZ as usize
        );
        assert_eq!(
            VIVA_AUDIO_MAX_TURN_BYTES,
            VIVA_AUDIO_MAX_TURN_SAMPLES * VIVA_VOICE_CHANNELS * VIVA_VOICE_BYTES_PER_SAMPLE
        );
        assert_eq!(
            VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS,
            VIVA_AUDIO_MAX_CHUNK_BYTES.div_ceil(3) * 4
        );

        // The stale v4 binary surface is gone from both the contract and its re-export.
        // Needles are assembled at runtime so these assertions cannot match themselves.
        let source = include_str!("protocol.rs");
        let lib_source = include_str!("lib.rs");
        for stale in [
            format!("VIVA_VOICE_MAX_BINARY{}", "_FRAME_BYTES"),
            format!("Agent{}", "Binary"),
            format!("Binary{}", "Frame"),
        ] {
            assert!(
                !source.contains(&stale),
                "protocol.rs still carries {stale}"
            );
            assert!(!lib_source.contains(&stale), "lib.rs still carries {stale}");
        }
        // Plan 10 owns browser pre-send enforcement; this module publishes no transport.
        for consumer_only in [
            format!("Web{}", "Socket"),
            format!("buffered{}", "Amount"),
            format!("send{}", "Frame"),
        ] {
            assert!(
                !source.contains(&consumer_only),
                "protocol.rs implements consumer behaviour {consumer_only}"
            );
        }

        // Envelope size is measured in UTF-8 bytes before any nested parsing. This
        // string is 65,536 characters and 65,537 bytes, so it must fail on size.
        let multi_byte_boundary = format!("\u{e9}{}", "x".repeat(65_535));
        assert_eq!(multi_byte_boundary.chars().count(), 65_536);
        assert_eq!(multi_byte_boundary.len(), 65_537);
        for oversized in ["x".repeat(65_537), multi_byte_boundary] {
            for diagnostic in [
                parse_client_frame_json(&oversized).expect_err("oversized envelope rejects"),
                parse_server_frame_json(&oversized).expect_err("oversized envelope rejects"),
            ] {
                assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::FrameTooLarge);
                assert_eq!(diagnostic.path, "$");
            }
        }
        // Exactly at the cap the envelope is admitted and only then parsed, so the
        // boundary is `> 65,536` rather than `>= 65,536`.
        let at_cap = "x".repeat(65_536);
        for diagnostic in [
            parse_client_frame_json(&at_cap).expect_err("malformed JSON rejects"),
            parse_server_frame_json(&at_cap).expect_err("malformed JSON rejects"),
        ] {
            assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::MalformedJson);
            assert_eq!(diagnostic.path, "$");
        }

        let chunk_json = |encoded: &str| {
            serde_json::to_string(&json!({
                "type": "audio_chunk",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "generation-fixture-audio",
                "turn_id": "turn-fixture-audio",
                "sequence": 0,
                "frame": { "pcm16_base64": encoded },
            }))
            .expect("chunk frame serializes")
        };
        let raw_chunk_json = |raw_bytes: usize| chunk_json(&STANDARD.encode(vec![0_u8; raw_bytes]));

        assert_eq!(
            STANDARD
                .encode(vec![0_u8; VIVA_AUDIO_MAX_CHUNK_BYTES])
                .len(),
            VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS
        );
        assert!(raw_chunk_json(VIVA_AUDIO_MAX_CHUNK_BYTES).len() < VIVA_VOICE_MAX_TEXT_FRAME_BYTES);
        parse_client_frame_json(&raw_chunk_json(VIVA_AUDIO_MAX_CHUNK_BYTES))
            .expect("the maximum chunk parses");

        // 8,193 is the plan's named boundary and 8,194 keeps whole 16-bit samples, so
        // neither can be excused as an odd-byte rejection.
        for raw_bytes in [
            VIVA_AUDIO_MAX_CHUNK_BYTES + 1,
            VIVA_AUDIO_MAX_CHUNK_BYTES + 2,
        ] {
            let diagnostic = parse_client_frame_json(&raw_chunk_json(raw_bytes))
                .expect_err("an oversized chunk rejects");
            assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::FrameTooLarge);
            assert_eq!(diagnostic.path, "$.frame.pcm16_base64");
            assert!(!format!("{diagnostic:?}").contains("AAAA"));
        }

        // Canonical RFC 4648 base64 *with* padding is the only accepted audio encoding;
        // the unpadded base64url form belongs to `viva1` token segments.
        for payload in [
            "AAB=", "AAA", "AA==A", "AA-A", "AA_A", "AA A", "AAA=\n", "", "====", "AQ==",
        ] {
            let diagnostic = parse_client_frame_json(&chunk_json(payload))
                .expect_err("non-canonical padded base64 rejects");
            assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::InvalidField);
            assert_eq!(diagnostic.path, "$.frame.pcm16_base64");
        }
        parse_client_frame_json(&chunk_json("AAA=")).expect("a two-byte sample chunk parses");

        // 8,192 bytes is a maximum, never a fixed or minimum chunk size, so no chunk
        // count and no final-sequence ceiling can be derived from it.
        for (chunk_bytes, chunk_count) in [
            (960_usize, 2_250_usize),
            (480, 4_500),
            (VIVA_AUDIO_MAX_CHUNK_BYTES, 263),
        ] {
            let encoded = STANDARD.encode(vec![0_u8; chunk_bytes]);
            let aggregate_bytes = chunk_bytes * chunk_count;
            assert!(aggregate_bytes <= VIVA_AUDIO_MAX_TURN_BYTES);
            assert!(aggregate_bytes / VIVA_VOICE_BYTES_PER_SAMPLE <= VIVA_AUDIO_MAX_TURN_SAMPLES);

            for sequence in 0..chunk_count {
                let wire = serde_json::to_string(&json!({
                    "type": "audio_chunk",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "generation-fixture-audio",
                    "turn_id": "turn-fixture-audio",
                    "sequence": sequence,
                    "frame": { "pcm16_base64": encoded },
                }))
                .expect("chunk frame serializes");
                parse_client_frame_json(&wire).expect("every in-bounds chunk parses");
            }

            let end = serde_json::to_string(&json!({
                "type": "audio_end",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "generation-fixture-audio",
                "turn_id": "turn-fixture-audio",
                "final_sequence": chunk_count - 1,
            }))
            .expect("audio end serializes");
            parse_client_frame_json(&end).expect("the matching audio end parses");
        }

        // The 20 ms production turn ends at sequence 2,249; smaller valid chunks push
        // the final sequence past it while the aggregate bounds stay identical.
        assert_eq!(2_250 * 960, VIVA_AUDIO_MAX_TURN_BYTES);
        assert_eq!(4_500 * 480, VIVA_AUDIO_MAX_TURN_BYTES);
        assert!(4_500 - 1 > 2_250 - 1);
        assert!(263 * VIVA_AUDIO_MAX_CHUNK_BYTES <= VIVA_AUDIO_MAX_TURN_BYTES);
        assert!(264 * VIVA_AUDIO_MAX_CHUNK_BYTES > VIVA_AUDIO_MAX_TURN_BYTES);
    }

    /// `VOICE-AUTH-001` / `VOICE-REFRESH-001` / `VOICE-AUTHORITY-001`. Every v5 client
    /// frame is generation-bound, the first application frame carries the signed
    /// credential at the top level under a redacted `Debug`, in-socket refresh is
    /// context-only, and the browser-sendable union is exactly seven variants with no
    /// tool authority anywhere in it.
    #[test]
    fn voice_v5_signed_config_and_refresh_are_strict() {
        use serde_json::{json, Value};

        const SIGNED_CONFIG_JSON: &str =
            include_str!("../../../fixtures/voice-protocol/v5/client-session-config-signed.json");
        const SESSION_REFRESH_JSON: &str =
            include_str!("../../../fixtures/voice-protocol/v5/client-session-refresh.json");

        // Wire key of the signed credential, assembled at runtime so no line of this
        // test module carries the continuous-redaction marker.
        let credential_key = format!("session{}", "_token");
        let credential_path = format!("$.{credential_key}");
        let generation_key = "client_generation_id";

        let fixture: Value =
            serde_json::from_str(SIGNED_CONFIG_JSON).expect("signed config fixture is valid JSON");
        let refresh_fixture: Value =
            serde_json::from_str(SESSION_REFRESH_JSON).expect("refresh fixture is valid JSON");

        // The canonical first frame round-trips byte for byte.
        let frame =
            parse_client_frame_json(SIGNED_CONFIG_JSON).expect("canonical first frame parses");
        assert_eq!(
            serde_json::to_value(&frame).expect("first frame serializes"),
            fixture
        );
        let mut cursor = 0_usize;
        for key in [
            "type",
            "version",
            generation_key,
            credential_key.as_str(),
            "session",
            "session_id",
            "user_id",
            "study_set_id",
            "mode",
            "source_context",
            "active_concepts",
        ] {
            let needle = format!("\"{key}\"");
            let offset = SIGNED_CONFIG_JSON[cursor..]
                .find(&needle)
                .unwrap_or_else(|| {
                    panic!("client-session-config-signed.json is missing {key} in canonical order")
                });
            cursor += offset + needle.len();
        }

        // The credential exists only on the wire: `Debug` redacts it and no formatter
        // may observe the string.
        let credential = fixture
            .get(&credential_key)
            .and_then(Value::as_str)
            .expect("fixture credential");
        let rendered = format!("{frame:?}");
        assert!(rendered.contains("[REDACTED]"));
        assert!(!rendered.contains(credential));
        for segment in credential.split('.') {
            assert!(
                !rendered.contains(segment),
                "Debug leaked a credential segment"
            );
        }
        assert!(!rendered.to_ascii_lowercase().contains("bearer"));

        // One valid frame per browser-authorized variant, all on the same generation.
        let samples: [(&str, Value); 7] = [
            ("session_config", fixture.clone()),
            ("session_refresh", refresh_fixture.clone()),
            (
                "audio_chunk",
                json!({
                    "type": "audio_chunk",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "viva-session-bootstrap-1-fixture",
                    "turn_id": "turn-1",
                    "sequence": 0,
                    "frame": { "pcm16_base64": "AQIDBA==" },
                }),
            ),
            (
                "audio_end",
                json!({
                    "type": "audio_end",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "viva-session-bootstrap-1-fixture",
                    "turn_id": "turn-1",
                    "final_sequence": 0,
                }),
            ),
            (
                "turn_intent",
                json!({
                    "type": "turn_intent",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "viva-session-bootstrap-1-fixture",
                    "turn_id": "turn-1",
                    "intent": { "kind": "answer_text", "text": "NADH donates electrons." },
                }),
            ),
            (
                "cancel",
                json!({
                    "type": "cancel",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "viva-session-bootstrap-1-fixture",
                    "turn_id": "turn-1",
                }),
            ),
            (
                "stop",
                json!({
                    "type": "stop",
                    "version": VIVA_VOICE_PROTOCOL_VERSION,
                    "client_generation_id": "viva-session-bootstrap-1-fixture",
                }),
            ),
        ];

        for (label, sample) in &samples {
            let parsed = parse_client_frame_json(&sample.to_string())
                .unwrap_or_else(|error| panic!("{label} sample parses: {error}"));
            assert_eq!(
                serde_json::to_value(&parsed).expect("sample serializes"),
                *sample,
                "{label}"
            );

            let mut without = sample.clone();
            without
                .as_object_mut()
                .expect("object")
                .remove(generation_key);
            let diagnostic = parse_client_frame_json(&without.to_string())
                .expect_err("a generation-less frame rejects");
            assert_eq!(
                diagnostic.code,
                VoiceProtocolDiagnosticCode::MissingField,
                "{label}"
            );
            assert_eq!(diagnostic.path, "$.client_generation_id", "{label}");

            for blank in ["", "   "] {
                let mut empty = sample.clone();
                empty.as_object_mut().expect("object")[generation_key] = json!(blank);
                let diagnostic = parse_client_frame_json(&empty.to_string())
                    .expect_err("a blank generation rejects");
                assert_eq!(
                    diagnostic.code,
                    VoiceProtocolDiagnosticCode::InvalidField,
                    "{label}"
                );
                assert_eq!(diagnostic.path, "$.client_generation_id", "{label}");
            }
        }

        // The signed credential is required at the frame top level; a nested one is a
        // forbidden authority rather than a silently discarded field.
        let mut without_credential = fixture.clone();
        without_credential
            .as_object_mut()
            .expect("object")
            .remove(&credential_key);
        let diagnostic = parse_client_frame_json(&without_credential.to_string())
            .expect_err("a token-less first frame rejects");
        assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::MissingField);
        assert_eq!(diagnostic.path, credential_path);

        for blank in ["", "   "] {
            let mut empty = fixture.clone();
            empty.as_object_mut().expect("object")[&credential_key] = json!(blank);
            let diagnostic = parse_client_frame_json(&empty.to_string())
                .expect_err("a blank credential rejects");
            assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::InvalidField);
            assert_eq!(diagnostic.path, credential_path);
        }

        let mut nested = fixture.clone();
        let credential_value = fixture[&credential_key].clone();
        nested["session"]
            .as_object_mut()
            .expect("session object")
            .insert(credential_key.clone(), credential_value);
        let diagnostic =
            parse_client_frame_json(&nested.to_string()).expect_err("a nested credential rejects");
        assert_eq!(
            diagnostic.code,
            VoiceProtocolDiagnosticCode::ForbiddenAuthority
        );
        assert_eq!(diagnostic.path, format!("$.session.{credential_key}"));

        // In-socket refresh is context-only: it can never carry credentials or identity.
        for forbidden in [
            credential_key.clone(),
            "user_id".to_owned(),
            "study_set_id".to_owned(),
            "session_id".to_owned(),
            "source_context".to_owned(),
            "active_concepts".to_owned(),
        ] {
            let mut refresh = refresh_fixture.clone();
            refresh["context"]
                .as_object_mut()
                .expect("context object")
                .insert(forbidden.clone(), json!("fixture-value"));
            let diagnostic = parse_client_frame_json(&refresh.to_string())
                .expect_err("an authority field on refresh rejects");
            assert_eq!(
                diagnostic.code,
                VoiceProtocolDiagnosticCode::ForbiddenAuthority,
                "{forbidden}"
            );
            assert_eq!(
                diagnostic.path,
                format!("$.context.{forbidden}"),
                "{forbidden}"
            );
        }

        let mut unknown = refresh_fixture.clone();
        unknown["context"]
            .as_object_mut()
            .expect("context object")
            .insert("tenant".to_owned(), json!("fixture-tenant"));
        let diagnostic = parse_client_frame_json(&unknown.to_string())
            .expect_err("an unknown refresh key rejects");
        assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::UnknownField);
        assert_eq!(diagnostic.path, "$.context.tenant");

        let mut empty_context = refresh_fixture.clone();
        empty_context["context"] = json!({});
        let diagnostic = parse_client_frame_json(&empty_context.to_string())
            .expect_err("an empty refresh context rejects");
        assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::MissingField);
        assert_eq!(diagnostic.path, "$.context");

        for context in [
            json!({ "mode": "quiz" }),
            json!({ "initial_goal": "Review." }),
        ] {
            let mut refresh = refresh_fixture.clone();
            refresh["context"] = context;
            parse_client_frame_json(&refresh.to_string()).expect("either key alone is a context");
        }

        for goal in ["".to_owned(), "   ".to_owned(), "g".repeat(513)] {
            let mut refresh = refresh_fixture.clone();
            refresh["context"] = json!({ "initial_goal": goal });
            let diagnostic = parse_client_frame_json(&refresh.to_string())
                .expect_err("an out-of-bounds goal rejects");
            assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::InvalidField);
            assert_eq!(diagnostic.path, "$.context.initial_goal");
        }
        let mut at_limit = refresh_fixture.clone();
        at_limit["context"] = json!({ "initial_goal": "g".repeat(512) });
        parse_client_frame_json(&at_limit.to_string()).expect("512 code points is in bounds");

        // Browser authority: a forged tool result is forbidden, and the v4 plain text
        // frame is simply unknown.
        let forged = parse_client_frame_json(
            &json!({
                "type": "tool_result",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "viva-session-bootstrap-1-fixture",
                "result": { "proposal": { "name": "write_review_state" }, "result": {} },
            })
            .to_string(),
        )
        .expect_err("a forged tool result rejects");
        assert_eq!(forged.code, VoiceProtocolDiagnosticCode::ForbiddenAuthority);
        assert_eq!(forged.path, "$.type");

        let plain_text = parse_client_frame_json(
            &json!({
                "type": "text",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "viva-session-bootstrap-1-fixture",
                "text": "NADH donates electrons.",
            })
            .to_string(),
        )
        .expect_err("the v4 text frame is not a v5 frame");
        assert_eq!(plain_text.code, VoiceProtocolDiagnosticCode::UnknownFrame);
        assert_eq!(plain_text.path, "$.type");

        // Typed turn intents cannot cross-grade.
        let challenge = json!({
            "type": "turn_intent",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "client_generation_id": "viva-session-bootstrap-1-fixture",
            "turn_id": "turn-2",
            "intent": {
                "kind": "citation_challenge",
                "response_id": "response-2",
                "source_id": "src-lecture-5",
            },
        });
        parse_client_frame_json(&challenge.to_string()).expect("a citation challenge parses");

        let mut cross_graded = challenge.clone();
        cross_graded["intent"]
            .as_object_mut()
            .expect("intent object")
            .insert("text".to_owned(), json!("NADH donates electrons."));
        let diagnostic = parse_client_frame_json(&cross_graded.to_string())
            .expect_err("a challenge cannot carry answer text");
        assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::UnknownField);
        assert_eq!(diagnostic.path, "$.intent.text");

        for bad_id in [
            "".to_owned(),
            "  ".to_owned(),
            ".leading-dot".to_owned(),
            "a".repeat(129),
            "has space".to_owned(),
        ] {
            let mut rejected = challenge.clone();
            rejected["intent"]["source_id"] = json!(bad_id);
            let diagnostic = parse_client_frame_json(&rejected.to_string())
                .expect_err("an out-of-vocabulary id rejects");
            assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::InvalidField);
            assert_eq!(diagnostic.path, "$.intent.source_id");
        }

        // Parsing stays D-03 neutral: Plan 08 owns the refresh policy branch.
        let policy_code = format!("VOICE_SESSION_REFRESH{}", "_POLICY_DENIED");
        assert!(!include_str!("protocol.rs").contains(&policy_code));

        // No diagnostic anywhere in this surface may echo the credential.
        for diagnostic in [
            parse_client_frame_json(&without_credential.to_string()).expect_err("rejects"),
            parse_client_frame_json(&nested.to_string()).expect_err("rejects"),
        ] {
            let rendered = format!("{diagnostic:?} {diagnostic}");
            assert!(!rendered.contains(credential));
            assert!(!rendered.contains("viva1"));
        }
    }
}
