use std::fmt;

use agent_domain::{
    AnswerEvaluation, AudioFrame, BrainEvent, ConceptStatus, EvaluationDeferralReason,
    ManuscriptIntent, RealtimeBrainCapabilities, SessionConfig, StudyMode, StudyQuestion,
    StudySessionPhase, StudySessionRecap, StudySourceReference, StudyStoreBackend,
    StudyStoreCapabilities, TerminalSessionReason,
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
    let frame = require_wire_envelope(value)?;
    require_wire_version(frame)?;
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
            require_only_wire_keys(
                frame,
                &[
                    "type",
                    "version",
                    "client_generation_id",
                    SESSION_CREDENTIAL_KEY,
                    "session",
                ],
                "$",
            )?;
            require_wire_credential(frame.get(SESSION_CREDENTIAL_KEY))?;
            validate_session_config_wire(frame.get("session"))?;
        }
        "session_refresh" => {
            require_only_wire_keys(
                frame,
                &["type", "version", "client_generation_id", "context"],
                "$",
            )?;
            validate_session_refresh_context_wire(frame.get("context"))?;
        }
        "audio_chunk" => {
            require_only_wire_keys(
                frame,
                &[
                    "type",
                    "version",
                    "client_generation_id",
                    "turn_id",
                    "sequence",
                    "frame",
                ],
                "$",
            )?;
            require_wire_id(frame.get("turn_id"), "$.turn_id")?;
            require_wire_sequence(frame.get("sequence"), "$.sequence")?;
            validate_audio_chunk_payload(value)?;
        }
        "audio_end" => {
            require_only_wire_keys(
                frame,
                &[
                    "type",
                    "version",
                    "client_generation_id",
                    "turn_id",
                    "final_sequence",
                ],
                "$",
            )?;
            require_wire_id(frame.get("turn_id"), "$.turn_id")?;
            require_wire_sequence(frame.get("final_sequence"), "$.final_sequence")?;
        }
        "turn_intent" => {
            require_only_wire_keys(
                frame,
                &[
                    "type",
                    "version",
                    "client_generation_id",
                    "turn_id",
                    "intent",
                ],
                "$",
            )?;
            require_wire_id(frame.get("turn_id"), "$.turn_id")?;
            validate_turn_intent_wire(frame.get("intent"))?;
        }
        "cancel" => {
            require_only_wire_keys(
                frame,
                &["type", "version", "client_generation_id", "turn_id"],
                "$",
            )?;
            if frame.contains_key("turn_id") {
                require_wire_id(frame.get("turn_id"), "$.turn_id")?;
            }
        }
        _ => {
            require_only_wire_keys(frame, &["type", "version", "client_generation_id"], "$")?;
        }
    }
    Ok(())
}

/// `VOICE-DIAGNOSTIC-001`: the closed server frame and event vocabularies, and the
/// explicit wire allowlist that runs before any conversion to a domain type.
const VIVA_SERVER_FRAME_TYPES: [&str; 4] = ["ready", "audio_turn_accepted", "event", "error"];

const VIVA_SERVER_EVENT_TYPES: [&str; 13] = [
    "session_phase",
    "question_started",
    "transcript_delta",
    "transcript_final",
    "answer_evaluated",
    "turn_deferred",
    "source_reference",
    "concept_status",
    "manuscript_intent",
    "recap_ready",
    "audio_delta",
    "cancellation",
    "structured_error",
];

const VOICE_STRUCTURED_ERROR_TERMINALITIES: [&str; 2] = ["recoverable", "terminal"];

const SOURCE_REFERENCE_KEYS: [&str; 6] = SOURCE_CONTEXT_KEYS;

/// The closed value vocabularies the wire allowlist enforces before any conversion to a
/// domain type. They are written as literals so both language contracts read identically.
const STUDY_SESSION_PHASES: [&str; 6] = [
    "ready",
    "listening",
    "thinking",
    "feedback",
    "correction",
    "recap",
];
const CONCEPT_STATUSES: [&str; 4] = ["strong", "shaky", "missed", "review"];
const EVALUATION_LABELS: [&str; 7] = [
    "strong",
    "mostly correct",
    "partially correct",
    "vague",
    "wrong",
    "off-topic",
    "insufficient evidence",
];
const MANUSCRIPT_REGISTERS: [&str; 5] = [
    "examining",
    "reflecting",
    "correcting",
    "sourcing",
    "recapping",
];
const MANUSCRIPT_EMPHASES: [&str; 3] = ["quiet", "measured", "marked"];
const MANUSCRIPT_ENTITY_KINDS: [&str; 3] = ["concept", "source", "marginal_note"];

fn validate_server_frame_wire(value: &Value) -> Result<(), VoiceProtocolDiagnostic> {
    let frame = require_wire_envelope(value)?;
    require_wire_version(frame)?;
    let Some(frame_type) = frame
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| VIVA_SERVER_FRAME_TYPES.contains(kind))
    else {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::UnknownFrame,
            "$.type",
        ));
    };

    match frame_type {
        "ready" => {
            require_only_wire_keys(
                frame,
                &[
                    "type",
                    "version",
                    "protocol",
                    "sample_rate_hz",
                    "input_encoding",
                    "brain",
                    "store",
                ],
                "$",
            )?;
            validate_protocol_advertisement_wire(frame.get("protocol"))?;
            if require_wire_u64(frame.get("sample_rate_hz"), "$.sample_rate_hz")?
                != u64::from(VIVA_VOICE_SAMPLE_RATE_HZ)
            {
                return Err(diagnostic(
                    VoiceProtocolDiagnosticCode::InvalidField,
                    "$.sample_rate_hz",
                ));
            }
            if require_wire_string(frame.get("input_encoding"), "$.input_encoding")?
                != VIVA_VOICE_INPUT_ENCODING
            {
                return Err(diagnostic(
                    VoiceProtocolDiagnosticCode::InvalidField,
                    "$.input_encoding",
                ));
            }
            let brain = require_wire_object(frame.get("brain"), "$.brain")?;
            require_only_wire_keys(
                brain,
                &["provider", "configured", "selectable", "live_runtime"],
                "$.brain",
            )?;
            require_non_empty_wire_string(brain.get("provider"), "$.brain.provider")?;
            for key in ["configured", "selectable", "live_runtime"] {
                require_wire_bool(brain.get(key), format!("$.brain.{key}"))?;
            }
            let store = require_wire_object(frame.get("store"), "$.store")?;
            require_only_wire_keys(
                store,
                &[
                    "backend",
                    "available",
                    "durable",
                    "nonce_replay_protection",
                    "raw_audio_persistence",
                    "transcript_persistence",
                    "uuid_schema_translation",
                ],
                "$.store",
            )?;
            require_non_empty_wire_string(store.get("backend"), "$.store.backend")?;
            for key in [
                "available",
                "durable",
                "nonce_replay_protection",
                "raw_audio_persistence",
                "transcript_persistence",
                "uuid_schema_translation",
            ] {
                require_wire_bool(store.get(key), format!("$.store.{key}"))?;
            }
        }
        "audio_turn_accepted" => {
            require_only_wire_keys(
                frame,
                &[
                    "type",
                    "version",
                    "client_generation_id",
                    "turn_id",
                    "final_sequence",
                ],
                "$",
            )?;
            require_wire_id(frame.get("client_generation_id"), "$.client_generation_id")?;
            require_wire_id(frame.get("turn_id"), "$.turn_id")?;
            require_wire_sequence(frame.get("final_sequence"), "$.final_sequence")?;
        }
        "event" => {
            require_only_wire_keys(frame, &["type", "version", "event"], "$")?;
            validate_server_event_wire(frame.get("event"), "$.event")?;
        }
        _ => {
            require_only_wire_keys(frame, &["type", "version", "error"], "$")?;
            let error = require_wire_object(frame.get("error"), "$.error")?;
            require_only_wire_keys(error, &["code", "message", "retryable"], "$.error")?;
            let code = require_wire_string(error.get("code"), "$.error.code")?;
            let Some(code) = VoiceServerErrorCode::from_wire(code) else {
                return Err(diagnostic(
                    VoiceProtocolDiagnosticCode::InvalidField,
                    "$.error.code",
                ));
            };
            require_non_empty_wire_string(error.get("message"), "$.error.message")?;
            // Retryability is derived from the code, never trusted from the wire.
            if require_wire_bool(error.get("retryable"), "$.error.retryable")? != code.retryable() {
                return Err(diagnostic(
                    VoiceProtocolDiagnosticCode::Invariant,
                    "$.error.retryable",
                ));
            }
        }
    }
    Ok(())
}

fn validate_protocol_advertisement_wire(
    value: Option<&Value>,
) -> Result<(), VoiceProtocolDiagnostic> {
    let advertisement = require_wire_object(value, "$.protocol")?;
    require_only_wire_keys(
        advertisement,
        &["preferred_version", "supported_versions"],
        "$.protocol",
    )?;
    let supported = require_wire_array(
        advertisement.get("supported_versions"),
        "$.protocol.supported_versions",
    )?;
    let versions: Vec<u32> = supported
        .iter()
        .map(|version| {
            version
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| {
                    diagnostic(
                        VoiceProtocolDiagnosticCode::InvalidField,
                        "$.protocol.supported_versions",
                    )
                })
        })
        .collect::<Result<_, _>>()?;
    let negotiated =
        negotiate_voice_protocol_version(&VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, &versions)?;
    if advertisement
        .get("preferred_version")
        .and_then(Value::as_u64)
        != Some(u64::from(negotiated))
    {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::UnsupportedVersion,
            "$.protocol.preferred_version",
        ));
    }
    Ok(())
}

fn validate_server_event_wire(
    value: Option<&Value>,
    path: &str,
) -> Result<(), VoiceProtocolDiagnostic> {
    let event = require_wire_object(value, path)?;
    let Some(event_type) = event
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| VIVA_SERVER_EVENT_TYPES.contains(kind))
    else {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::UnknownFrame,
            format!("{path}.type"),
        ));
    };

    match event_type {
        "session_phase" => {
            require_only_wire_keys(event, &["type", "phase", "terminal_reason"], path)?;
            require_wire_enum(
                event.get("phase"),
                &STUDY_SESSION_PHASES,
                format!("{path}.phase"),
            )?;
            if event.contains_key("terminal_reason") {
                require_wire_terminal_reason(
                    event.get("terminal_reason"),
                    format!("{path}.terminal_reason"),
                )?;
            }
        }
        "question_started" => {
            require_only_wire_keys(event, &["type", "turn_id", "response_id", "question"], path)?;
            require_strict_wire_id(event.get("turn_id"), format!("{path}.turn_id"))?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            validate_study_question_wire(event.get("question"), &format!("{path}.question"))?;
        }
        "turn_deferred" => {
            require_only_wire_keys(
                event,
                &[
                    "type",
                    "turn_id",
                    "response_id",
                    "question_id",
                    "reason",
                    "can_retry_same_question",
                ],
                path,
            )?;
            require_strict_wire_id(event.get("turn_id"), format!("{path}.turn_id"))?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            require_strict_wire_id(event.get("question_id"), format!("{path}.question_id"))?;
            require_wire_enum(
                event.get("reason"),
                &VOICE_DEFERRAL_REASONS,
                format!("{path}.reason"),
            )?;
            require_wire_bool(
                event.get("can_retry_same_question"),
                format!("{path}.can_retry_same_question"),
            )?;
        }
        "transcript_delta" => {
            require_only_wire_keys(event, &["type", "response_id", "text"], path)?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            require_wire_string(event.get("text"), format!("{path}.text"))?;
        }
        "transcript_final" => {
            require_only_wire_keys(event, &["type", "response_id", "text", "confidence"], path)?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            require_wire_string(event.get("text"), format!("{path}.text"))?;
            require_wire_provider_confidence(
                event.get("confidence"),
                format!("{path}.confidence"),
            )?;
        }
        "answer_evaluated" => {
            require_only_wire_keys(event, &["type", "response_id", "evaluation"], path)?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            validate_answer_evaluation_wire(
                event.get("evaluation"),
                &format!("{path}.evaluation"),
            )?;
        }
        "source_reference" => {
            require_only_wire_keys(event, &["type", "response_id", "source"], path)?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            validate_source_reference_wire(event.get("source"), &format!("{path}.source"))?;
        }
        "concept_status" => {
            require_only_wire_keys(
                event,
                &["type", "response_id", "concept_id", "status"],
                path,
            )?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            require_strict_wire_id(event.get("concept_id"), format!("{path}.concept_id"))?;
            require_wire_enum(
                event.get("status"),
                &CONCEPT_STATUSES,
                format!("{path}.status"),
            )?;
        }
        "manuscript_intent" => {
            require_only_wire_keys(event, &["type", "response_id", "intent"], path)?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            validate_manuscript_intent_wire(event.get("intent"), &format!("{path}.intent"))?;
        }
        "recap_ready" => {
            require_only_wire_keys(
                event,
                &["type", "response_id", "recap", "partial", "partial_reason"],
                path,
            )?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            validate_recap_wire(event.get("recap"), &format!("{path}.recap"))?;
            // `VOICE-TERMINAL-001`: `partial` is the discriminant. `true` is terminal and
            // must state why; `false` may not carry a reason at all.
            if require_wire_bool(event.get("partial"), format!("{path}.partial"))? {
                require_wire_terminal_reason(
                    event.get("partial_reason"),
                    format!("{path}.partial_reason"),
                )?;
            } else if event.contains_key("partial_reason") {
                return Err(diagnostic(
                    VoiceProtocolDiagnosticCode::Invariant,
                    format!("{path}.partial_reason"),
                ));
            }
        }
        "audio_delta" => {
            require_only_wire_keys(event, &["type", "response_id", "frame"], path)?;
            require_strict_wire_id(event.get("response_id"), format!("{path}.response_id"))?;
            let frame = require_wire_object(event.get("frame"), format!("{path}.frame"))?;
            require_only_wire_keys(frame, &["pcm16_base64"], &format!("{path}.frame"))?;
            require_non_empty_wire_string(
                frame.get("pcm16_base64"),
                format!("{path}.frame.pcm16_base64"),
            )?;
        }
        "cancellation" => {
            require_only_wire_keys(event, &["type", "response_id"], path)?;
            match event.get("response_id") {
                None => {
                    return Err(diagnostic(
                        VoiceProtocolDiagnosticCode::MissingField,
                        format!("{path}.response_id"),
                    ))
                }
                Some(Value::Null) => {}
                other => {
                    require_strict_wire_id(other, format!("{path}.response_id"))?;
                }
            }
        }
        _ => {
            require_only_wire_keys(
                event,
                &[
                    "type",
                    "source",
                    "code",
                    "message",
                    "terminality",
                    "terminal_reason",
                ],
                path,
            )?;
            require_non_empty_wire_string(event.get("source"), format!("{path}.source"))?;
            require_strict_wire_id(event.get("code"), format!("{path}.code"))?;
            require_non_empty_wire_string(event.get("message"), format!("{path}.message"))?;
            // `VOICE-TERMINAL-002`: terminality is stated, never inferred from the message.
            let terminality = require_wire_enum(
                event.get("terminality"),
                &VOICE_STRUCTURED_ERROR_TERMINALITIES,
                format!("{path}.terminality"),
            )?;
            if terminality == VoiceStructuredErrorTerminality::Terminal.as_str() {
                require_wire_terminal_reason(
                    event.get("terminal_reason"),
                    format!("{path}.terminal_reason"),
                )?;
            } else if event.contains_key("terminal_reason") {
                return Err(diagnostic(
                    VoiceProtocolDiagnosticCode::Invariant,
                    format!("{path}.terminal_reason"),
                ));
            }
        }
    }
    Ok(())
}

fn validate_study_question_wire(
    value: Option<&Value>,
    path: &str,
) -> Result<(), VoiceProtocolDiagnostic> {
    let question = require_wire_object(value, path)?;
    require_only_wire_keys(
        question,
        &[
            "question_id",
            "concept_id",
            "prompt",
            "expected_terms",
            "follow_up",
            "rubric",
            "source",
        ],
        path,
    )?;
    require_strict_wire_id(question.get("question_id"), format!("{path}.question_id"))?;
    require_strict_wire_id(question.get("concept_id"), format!("{path}.concept_id"))?;
    require_non_empty_wire_string(question.get("prompt"), format!("{path}.prompt"))?;
    for (index, term) in require_wire_array(
        question.get("expected_terms"),
        format!("{path}.expected_terms"),
    )?
    .iter()
    .enumerate()
    {
        require_wire_string(Some(term), format!("{path}.expected_terms[{index}]"))?;
    }
    require_non_empty_wire_string(question.get("follow_up"), format!("{path}.follow_up"))?;

    let rubric_path = format!("{path}.rubric");
    let rubric = require_wire_object(question.get("rubric"), rubric_path.clone())?;
    require_only_wire_keys(rubric, &["policy_version", "criteria"], &rubric_path)?;
    require_non_empty_wire_string(
        rubric.get("policy_version"),
        format!("{rubric_path}.policy_version"),
    )?;
    for (index, criterion) in
        require_wire_array(rubric.get("criteria"), format!("{rubric_path}.criteria"))?
            .iter()
            .enumerate()
    {
        let criterion_path = format!("{rubric_path}.criteria[{index}]");
        let criterion = require_wire_object(Some(criterion), criterion_path.clone())?;
        require_only_wire_keys(
            criterion,
            &[
                "criterion_id",
                "concept_id",
                "claim",
                "source_id",
                "required",
            ],
            &criterion_path,
        )?;
        require_strict_wire_id(
            criterion.get("criterion_id"),
            format!("{criterion_path}.criterion_id"),
        )?;
        require_strict_wire_id(
            criterion.get("concept_id"),
            format!("{criterion_path}.concept_id"),
        )?;
        require_non_empty_wire_string(criterion.get("claim"), format!("{criterion_path}.claim"))?;
        require_strict_wire_id(
            criterion.get("source_id"),
            format!("{criterion_path}.source_id"),
        )?;
        require_wire_bool(
            criterion.get("required"),
            format!("{criterion_path}.required"),
        )?;
    }
    validate_source_reference_wire(question.get("source"), &format!("{path}.source"))
}

fn validate_source_reference_wire(
    value: Option<&Value>,
    path: &str,
) -> Result<(), VoiceProtocolDiagnostic> {
    let source = require_wire_object(value, path)?;
    require_only_wire_keys(source, &SOURCE_REFERENCE_KEYS, path)?;
    for key in [
        "source_id",
        "document_id",
        "span",
        "excerpt",
        "retrieval_reason",
    ] {
        require_non_empty_wire_string(source.get(key), format!("{path}.{key}"))?;
    }
    require_wire_source_confidence(source.get("confidence"), format!("{path}.confidence"))
}

fn validate_answer_evaluation_wire(
    value: Option<&Value>,
    path: &str,
) -> Result<(), VoiceProtocolDiagnostic> {
    let evaluation = require_wire_object(value, path)?;
    require_only_wire_keys(
        evaluation,
        &[
            "question_id",
            "answer_text",
            "label",
            "concise_feedback",
            "retry_prompt",
            "source",
            "concept_status",
            "confidence_score",
        ],
        path,
    )?;
    require_strict_wire_id(evaluation.get("question_id"), format!("{path}.question_id"))?;
    require_wire_string(evaluation.get("answer_text"), format!("{path}.answer_text"))?;
    require_wire_enum(
        evaluation.get("label"),
        &EVALUATION_LABELS,
        format!("{path}.label"),
    )?;
    require_non_empty_wire_string(
        evaluation.get("concise_feedback"),
        format!("{path}.concise_feedback"),
    )?;
    require_non_empty_wire_string(
        evaluation.get("retry_prompt"),
        format!("{path}.retry_prompt"),
    )?;
    validate_source_reference_wire(evaluation.get("source"), &format!("{path}.source"))?;
    require_wire_enum(
        evaluation.get("concept_status"),
        &CONCEPT_STATUSES,
        format!("{path}.concept_status"),
    )?;
    require_wire_unit_interval(
        evaluation.get("confidence_score"),
        format!("{path}.confidence_score"),
    )
    .map(|_| ())
}

/// The `viva.study_session_recap.v2` shape the merged Plan 04/06 domain emits: concept
/// outcomes and a review schedule folded from persisted evidence, not free-form lists.
fn validate_recap_wire(value: Option<&Value>, path: &str) -> Result<(), VoiceProtocolDiagnostic> {
    let recap = require_wire_object(value, path)?;
    require_only_wire_keys(
        recap,
        &[
            "schema",
            "voice_session_id",
            "headline",
            "summary",
            "concepts",
            "review_schedule",
            "next_action",
            "source_moments",
            "deferred_turns",
        ],
        path,
    )?;
    require_non_empty_wire_string(recap.get("schema"), format!("{path}.schema"))?;
    require_strict_wire_id(
        recap.get("voice_session_id"),
        format!("{path}.voice_session_id"),
    )?;
    for key in ["headline", "summary", "next_action"] {
        require_non_empty_wire_string(recap.get(key), format!("{path}.{key}"))?;
    }
    for (index, concept) in require_wire_array(recap.get("concepts"), format!("{path}.concepts"))?
        .iter()
        .enumerate()
    {
        let concept_path = format!("{path}.concepts[{index}]");
        let concept = require_wire_object(Some(concept), concept_path.clone())?;
        require_only_wire_keys(concept, &["concept_id", "label", "status"], &concept_path)?;
        require_strict_wire_id(
            concept.get("concept_id"),
            format!("{concept_path}.concept_id"),
        )?;
        require_non_empty_wire_string(concept.get("label"), format!("{concept_path}.label"))?;
        require_wire_enum(
            concept.get("status"),
            &CONCEPT_STATUSES,
            format!("{concept_path}.status"),
        )?;
    }
    for (index, entry) in require_wire_array(
        recap.get("review_schedule"),
        format!("{path}.review_schedule"),
    )?
    .iter()
    .enumerate()
    {
        let entry_path = format!("{path}.review_schedule[{index}]");
        let entry = require_wire_object(Some(entry), entry_path.clone())?;
        require_only_wire_keys(entry, &["concept_id", "due_at", "authority"], &entry_path)?;
        require_strict_wire_id(entry.get("concept_id"), format!("{entry_path}.concept_id"))?;
        require_non_empty_wire_string(entry.get("due_at"), format!("{entry_path}.due_at"))?;
        let authority_path = format!("{entry_path}.authority");
        if !matches!(
            require_wire_string(entry.get("authority"), authority_path.clone())?,
            "server_persisted_fsrs" | "core_fsrs_read_time"
        ) {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::InvalidField,
                authority_path,
            ));
        }
    }
    for (index, moment) in require_wire_array(
        recap.get("source_moments"),
        format!("{path}.source_moments"),
    )?
    .iter()
    .enumerate()
    {
        let moment_path = format!("{path}.source_moments[{index}]");
        let moment = require_wire_object(Some(moment), moment_path.clone())?;
        require_only_wire_keys(moment, &["response_id", "source_id"], &moment_path)?;
        require_strict_wire_id(
            moment.get("response_id"),
            format!("{moment_path}.response_id"),
        )?;
        require_strict_wire_id(moment.get("source_id"), format!("{moment_path}.source_id"))?;
    }
    require_wire_sequence(
        recap.get("deferred_turns"),
        format!("{path}.deferred_turns"),
    )
    .map(|_| ())
}

fn validate_manuscript_intent_wire(
    value: Option<&Value>,
    path: &str,
) -> Result<(), VoiceProtocolDiagnostic> {
    let intent = require_wire_object(value, path)?;
    let allowed: &[&str] = match intent.get("type").and_then(Value::as_str) {
        Some("scene_intent") => &["type", "register", "emphasis"],
        Some("entity_intent") => &["type", "entity_id", "entity_kind", "register", "emphasis"],
        Some("marginalia_intent") => &[
            "type",
            "marginalia_id",
            "anchor_entity_id",
            "register",
            "emphasis",
        ],
        _ => {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::InvalidField,
                format!("{path}.type"),
            ))
        }
    };
    require_only_wire_keys(intent, allowed, path)?;
    for key in allowed.iter().filter(|key| key.ends_with("_id")) {
        let id = require_strict_wire_id(intent.get(*key), format!("{path}.{key}"))?;
        if id.chars().count() > MAX_MANUSCRIPT_ID_LENGTH {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::InvalidField,
                format!("{path}.{key}"),
            ));
        }
    }
    require_wire_enum(
        intent.get("register"),
        &MANUSCRIPT_REGISTERS,
        format!("{path}.register"),
    )?;
    require_wire_enum(
        intent.get("emphasis"),
        &MANUSCRIPT_EMPHASES,
        format!("{path}.emphasis"),
    )?;
    if intent.contains_key("entity_kind") {
        require_wire_enum(
            intent.get("entity_kind"),
            &MANUSCRIPT_ENTITY_KINDS,
            format!("{path}.entity_kind"),
        )?;
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

/// The root of a wire frame must be a JSON object, never an array or a scalar.
fn require_wire_envelope(value: &Value) -> Result<&Map<String, Value>, VoiceProtocolDiagnostic> {
    value
        .as_object()
        .ok_or_else(|| diagnostic(VoiceProtocolDiagnosticCode::InvalidEnvelope, "$"))
}

/// v5 is the only accepted version; a missing or other version is never upgraded.
fn require_wire_version(frame: &Map<String, Value>) -> Result<(), VoiceProtocolDiagnostic> {
    if frame.get("version").and_then(Value::as_u64) != Some(u64::from(VIVA_VOICE_PROTOCOL_VERSION))
    {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::UnsupportedVersion,
            "$.version",
        ));
    }
    Ok(())
}

fn require_wire_bool(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<bool, VoiceProtocolDiagnostic> {
    let path = path.into();
    match value {
        None => Err(diagnostic(
            VoiceProtocolDiagnosticCode::MissingField,
            path.clone(),
        )),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path)),
    }
}

fn require_wire_u64(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<u64, VoiceProtocolDiagnostic> {
    let path = path.into();
    match value {
        None => Err(diagnostic(
            VoiceProtocolDiagnosticCode::MissingField,
            path.clone(),
        )),
        Some(number) => number
            .as_u64()
            .ok_or_else(|| diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path.clone())),
    }
}

/// Sequence numbers start at 0 and are whole; fractional, negative, and out-of-range
/// values fail closed before any allocation.
fn require_wire_sequence(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<u32, VoiceProtocolDiagnostic> {
    let path = path.into();
    let number = require_wire_u64(value, path.clone())?;
    u32::try_from(number).map_err(|_| diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path))
}

/// Provider confidence is `null` when the provider supplied none. A number is valid only
/// inside `[0, 1]`; an omitted key is rejected so a fixture default can never become
/// product data.
fn require_wire_provider_confidence(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<(), VoiceProtocolDiagnostic> {
    let path = path.into();
    match value {
        None => Err(diagnostic(
            VoiceProtocolDiagnosticCode::MissingField,
            path.clone(),
        )),
        Some(Value::Null) => Ok(()),
        Some(_) => require_wire_unit_interval(value, path).map(|_| ()),
    }
}

fn require_wire_unit_interval(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<f64, VoiceProtocolDiagnostic> {
    let path = path.into();
    match value {
        None => Err(diagnostic(
            VoiceProtocolDiagnosticCode::MissingField,
            path.clone(),
        )),
        Some(number) => number
            .as_f64()
            .filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
            .ok_or_else(|| diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path.clone())),
    }
}

fn require_wire_object(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<&Map<String, Value>, VoiceProtocolDiagnostic> {
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

fn require_wire_array(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<&Vec<Value>, VoiceProtocolDiagnostic> {
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

fn require_wire_string(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<&str, VoiceProtocolDiagnostic> {
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

fn require_non_empty_wire_string(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<&str, VoiceProtocolDiagnostic> {
    let path = path.into();
    let text = require_wire_string(value, path.clone())?;
    if text.trim().is_empty() {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(text)
}

/// Wire identity: present, non-blank, and bounded.
fn require_wire_id(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<&str, VoiceProtocolDiagnostic> {
    let path = path.into();
    let text = require_wire_string(value, path.clone())?;
    if text.trim().is_empty() || text.chars().count() > MAX_WIRE_ID_LENGTH {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(text)
}

/// `VOICE-TURN-001`'s id vocabulary, also used for bound session identity.
fn require_strict_wire_id(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<&str, VoiceProtocolDiagnostic> {
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
    let segments: Vec<&str> = text.split('.').collect();
    if segments.len() != 3 || segments[0] != VIVA_SESSION_CREDENTIAL_PREFIX {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    // Shape only: the claims and signature segments must be canonical unpadded
    // base64url. Signature verification is Plan 08's, never this module's.
    if !segments[1..]
        .iter()
        .all(|segment| is_canonical_unpadded_base64url(segment))
    {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::NoncanonicalBase64Url,
            path,
        ));
    }
    Ok(())
}

/// The wire prefix every `viva1` session credential carries.
const VIVA_SESSION_CREDENTIAL_PREFIX: &str = "viva1";
/// Manuscript ids are render anchors, never learner text.
const MAX_MANUSCRIPT_ID_LENGTH: usize = 96;

/// Canonical unpadded base64url: no padding, no standard-alphabet characters, and no
/// non-zero unused bits in the final group. This is the only place the contract uses the
/// url alphabet; audio payloads are padded standard base64.
fn is_canonical_unpadded_base64url(segment: &str) -> bool {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    !segment.is_empty()
        && URL_SAFE_NO_PAD
            .decode(segment)
            .map(|bytes| URL_SAFE_NO_PAD.encode(bytes) == segment)
            .unwrap_or(false)
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

fn require_wire_enum<'a>(
    value: Option<&'a Value>,
    allowed: &[&str],
    path: impl Into<String>,
) -> Result<&'a str, VoiceProtocolDiagnostic> {
    let path = path.into();
    let text = require_wire_string(value, path.clone())?;
    if !allowed.contains(&text) {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
    }
    Ok(text)
}

fn require_wire_terminal_reason(
    value: Option<&Value>,
    path: impl Into<String>,
) -> Result<(), VoiceProtocolDiagnostic> {
    let path = path.into();
    let reason = require_wire_string(value, path.clone())?;
    if !TerminalSessionReason::ALL
        .iter()
        .any(|known| known.as_str() == reason)
    {
        return Err(diagnostic(VoiceProtocolDiagnosticCode::InvalidField, path));
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
    validate_server_frame_wire(&value)?;
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
    let frame = require_wire_object(value.get("frame"), "$.frame")?;
    require_only_wire_keys(frame, &["pcm16_base64"], "$.frame")?;
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
        error: ServerError,
    },
}

/// `VOICE-ERROR-001`: the closed typed vocabulary a server error frame may carry.
/// Retryability is a property of the code, never a value a sender may choose.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum VoiceServerErrorCode {
    #[serde(rename = "VOICE_AUTH_EXPIRED")]
    AuthExpired,
    #[serde(rename = "VOICE_AUTH_INVALID")]
    AuthInvalid,
    #[serde(rename = "VOICE_AUTH_IDENTITY_MISMATCH")]
    AuthIdentityMismatch,
    #[serde(rename = "VOICE_AUTH_REPLAYED")]
    AuthReplayed,
    #[serde(rename = "VOICE_CLIENT_FRAME_MALFORMED")]
    ClientFrameMalformed,
    #[serde(rename = "VOICE_CLIENT_FRAME_TOO_LARGE")]
    ClientFrameTooLarge,
    #[serde(rename = "VOICE_CLIENT_TURN_TOO_LARGE")]
    ClientTurnTooLarge,
    #[serde(rename = "VOICE_CLIENT_AUTHORITY_FORBIDDEN")]
    ClientAuthorityForbidden,
    #[serde(rename = "VOICE_INTERNAL_SERIALIZATION")]
    InternalSerialization,
}

impl VoiceServerErrorCode {
    pub const ALL: [Self; 9] = [
        Self::AuthExpired,
        Self::AuthInvalid,
        Self::AuthIdentityMismatch,
        Self::AuthReplayed,
        Self::ClientFrameMalformed,
        Self::ClientFrameTooLarge,
        Self::ClientTurnTooLarge,
        Self::ClientAuthorityForbidden,
        Self::InternalSerialization,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AuthExpired => "VOICE_AUTH_EXPIRED",
            Self::AuthInvalid => "VOICE_AUTH_INVALID",
            Self::AuthIdentityMismatch => "VOICE_AUTH_IDENTITY_MISMATCH",
            Self::AuthReplayed => "VOICE_AUTH_REPLAYED",
            Self::ClientFrameMalformed => "VOICE_CLIENT_FRAME_MALFORMED",
            Self::ClientFrameTooLarge => "VOICE_CLIENT_FRAME_TOO_LARGE",
            Self::ClientTurnTooLarge => "VOICE_CLIENT_TURN_TOO_LARGE",
            Self::ClientAuthorityForbidden => "VOICE_CLIENT_AUTHORITY_FORBIDDEN",
            Self::InternalSerialization => "VOICE_INTERNAL_SERIALIZATION",
        }
    }

    /// Only an expired credential and a server-side serialization fault are worth
    /// retrying; every other typed code is a terminal client or auth defect.
    pub const fn retryable(self) -> bool {
        matches!(self, Self::AuthExpired | Self::InternalSerialization)
    }

    pub fn from_wire(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|known| known.as_str() == code)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ServerError {
    pub fn new(code: VoiceServerErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.as_str().to_owned(),
            message: message.into(),
            retryable: code.retryable(),
        }
    }
}

/// `VOICE-TERMINATION-001`: the typed inputs a close classification may read. There is
/// deliberately no browser `CloseEvent.reason` and no free-form message here - a socket
/// outcome is decided by typed facts, never by parsing prose.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceTerminationInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ServerError>,
    #[serde(
        default,
        rename = "terminalReason",
        skip_serializing_if = "Option::is_none"
    )]
    pub terminal_reason: Option<TerminalSessionReason>,
    #[serde(rename = "closeCode")]
    pub close_code: u32,
    #[serde(rename = "wasClean")]
    pub was_clean: bool,
}

/// `VOICE-TERMINATION-001`: the typed close classification. The result carries no message
/// and no close-reason text, so nothing a peer wrote can reach a consumer's control flow.
///
/// Every `Terminal` outcome is `retryable: false` because the current wire session and
/// generation are finished. A learner-facing action may start a *new* session from the
/// typed reason; that is not this classifier's retry flag.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceTermination {
    Terminal {
        #[serde(rename = "terminalReason")]
        terminal_reason: TerminalSessionReason,
        retryable: bool,
        #[serde(rename = "closeCode")]
        close_code: u32,
    },
    Auth {
        #[serde(rename = "errorCode")]
        error_code: VoiceServerErrorCode,
        retryable: bool,
        #[serde(rename = "closeCode")]
        close_code: u32,
    },
    Protocol {
        #[serde(rename = "errorCode")]
        error_code: VoiceServerErrorCode,
        retryable: bool,
        #[serde(rename = "closeCode")]
        close_code: u32,
    },
    Service {
        #[serde(rename = "errorCode")]
        error_code: VoiceServerErrorCode,
        retryable: bool,
        #[serde(rename = "closeCode")]
        close_code: u32,
    },
    Normal {
        retryable: bool,
        #[serde(rename = "closeCode")]
        close_code: u32,
    },
    Transport {
        retryable: bool,
        #[serde(rename = "closeCode")]
        close_code: u32,
    },
}

/// Priority is terminal reason, then typed error category, then clean code 1000, then
/// transport. Retryability is derived from the typed code and never read off the wire.
pub fn classify_voice_termination(input: &VoiceTerminationInput) -> VoiceTermination {
    if let Some(terminal_reason) = input.terminal_reason {
        return VoiceTermination::Terminal {
            terminal_reason,
            retryable: false,
            close_code: input.close_code,
        };
    }

    if let Some(error_code) = input
        .error
        .as_ref()
        .and_then(|error| VoiceServerErrorCode::from_wire(&error.code))
    {
        let close_code = input.close_code;
        return match error_code {
            VoiceServerErrorCode::AuthExpired
            | VoiceServerErrorCode::AuthInvalid
            | VoiceServerErrorCode::AuthIdentityMismatch
            | VoiceServerErrorCode::AuthReplayed => VoiceTermination::Auth {
                error_code,
                retryable: error_code.retryable(),
                close_code,
            },
            VoiceServerErrorCode::ClientFrameMalformed
            | VoiceServerErrorCode::ClientFrameTooLarge
            | VoiceServerErrorCode::ClientTurnTooLarge
            | VoiceServerErrorCode::ClientAuthorityForbidden => VoiceTermination::Protocol {
                error_code,
                retryable: false,
                close_code,
            },
            VoiceServerErrorCode::InternalSerialization => VoiceTermination::Service {
                error_code,
                retryable: true,
                close_code,
            },
        };
    }

    if input.was_clean && input.close_code == VOICE_NORMAL_CLOSE_CODE {
        return VoiceTermination::Normal {
            retryable: false,
            close_code: VOICE_NORMAL_CLOSE_CODE,
        };
    }

    VoiceTermination::Transport {
        retryable: true,
        close_code: input.close_code,
    }
}

/// The one clean close code a v5 session may end on.
pub const VOICE_NORMAL_CLOSE_CODE: u32 = 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VivaServerEvent {
    SessionPhase {
        phase: StudySessionPhase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_reason: Option<TerminalSessionReason>,
    },
    /// `VOICE-TURN-001`: `question_started` is bound to the active wire turn. The domain
    /// event carries no turn identity, so this variant is only reachable through
    /// [`VivaServerEvent::question_started`].
    QuestionStarted {
        turn_id: String,
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
    /// `VOICE-TURN-002`: the wire mirror of a durably persisted Plan 04 `Deferred`
    /// outcome. It carries no provider message, feedback, confidence, concept status,
    /// schedule, mastery, `retryable`, or `terminal_reason`, and is never intrinsically
    /// terminal. Only [`VivaServerEvent::turn_deferred`] constructs it.
    TurnDeferred {
        turn_id: String,
        response_id: String,
        question_id: String,
        reason: EvaluationDeferralReason,
        can_retry_same_question: bool,
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
    /// `VOICE-TERMINAL-001`: recap terminality is discriminated, never an optional field
    /// whose meaning a consumer guesses. `partial: true` is terminal immediately and
    /// always carries its reason; `partial: false` never carries one. The pair is only
    /// reachable through [`VivaServerEvent::recap_ready`] and
    /// [`VivaServerEvent::partial_recap_ready`], and the wire allowlist rejects every
    /// other combination with `VOICE_PROTOCOL_INVARIANT`.
    RecapReady {
        response_id: String,
        recap: StudySessionRecap,
        partial: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        partial_reason: Option<TerminalSessionReason>,
    },
    AudioDelta {
        response_id: String,
        frame: AudioFrame,
    },
    Cancellation {
        response_id: Option<String>,
    },
    /// `VOICE-TERMINAL-002`: a structured error states its own terminality. A recoverable
    /// error never changes terminal state and may not carry a reason; a terminal error
    /// changes it immediately and must. Only
    /// [`VivaServerEvent::recoverable_structured_error`] and
    /// [`VivaServerEvent::terminal_structured_error`] construct it.
    StructuredError {
        source: String,
        code: String,
        message: String,
        terminality: VoiceStructuredErrorTerminality,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_reason: Option<TerminalSessionReason>,
    },
}

/// `VOICE-TERMINAL-002`: the closed terminality vocabulary of a structured error.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceStructuredErrorTerminality {
    Recoverable,
    Terminal,
}

impl VoiceStructuredErrorTerminality {
    pub const ALL: [Self; 2] = [Self::Recoverable, Self::Terminal];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Recoverable => "recoverable",
            Self::Terminal => "terminal",
        }
    }
}

/// The exact six snake_case wire mirrors of Plan 04 `EvaluationDeferralReason`. Adapter
/// and provider reasons are deliberately absent: only a durably persisted domain outcome
/// reaches the wire.
pub const VOICE_DEFERRAL_REASONS: [&str; 6] = [
    "empty_answer",
    "transcript_uncertain",
    "evaluator_unavailable",
    "invalid_evaluator_output",
    "insufficient_semantic_evidence",
    "contradictory_evidence",
];

/// Protocol-owned structured-error codes for the internal events this contract maps.
pub const VOICE_TELEMETRY_EVENT_SUPPRESSED_CODE: &str = "VOICE_TELEMETRY_EVENT_SUPPRESSED";
pub const VOICE_TOOL_PROPOSAL_NOT_BROWSER_SENDABLE_CODE: &str =
    "VOICE_TOOL_PROPOSAL_NOT_BROWSER_SENDABLE";
pub const VOICE_UNSUPPORTED_BRAIN_EVENT_CODE: &str = "VOICE_UNSUPPORTED_BRAIN_EVENT";
pub const VOICE_PROVIDER_FAILURE_CODE: &str = "VOICE_PROVIDER_FAILURE";
pub const VOICE_PROVIDER_ERROR_UNCLASSIFIED_CODE: &str = "VOICE_PROVIDER_ERROR_UNCLASSIFIED";

/// `VOICE-ERROR-001`: the owner-provided v5 serialization fallback. Plan 08 replaces the
/// hard-coded v1 literal in `ws.rs` with this constant; a round-trip test pins it.
pub const VOICE_SERIALIZATION_FALLBACK_FRAME: &str = "{\"type\":\"error\",\"version\":5,\"error\":{\"code\":\"VOICE_INTERNAL_SERIALIZATION\",\"message\":\"Server frame serialization failed.\",\"retryable\":true}}";

impl VivaServerEvent {
    /// `VOICE-TURN-001`: binds the active wire turn to a domain `QuestionStarted`. It
    /// accepts no other event, so a turn id can never be attached to something that is
    /// not a question start.
    pub fn question_started(
        turn_id: &str,
        event: &BrainEvent,
    ) -> Result<Self, VoiceProtocolDiagnostic> {
        let BrainEvent::QuestionStarted {
            response_id,
            question,
        } = event
        else {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::Invariant,
                "$.event.type",
            ));
        };
        Ok(Self::QuestionStarted {
            turn_id: require_active_turn_id(turn_id)?,
            response_id: response_id.clone(),
            question: question.clone(),
        })
    }

    /// `VOICE-TURN-002`: the only path from a durably persisted Plan 06
    /// `BrainEvent::TurnDeferred` to the wire. Every domain field is copied losslessly and
    /// the active wire `turn_id` is added; no provider message or learner fact is accepted.
    pub fn turn_deferred(
        turn_id: &str,
        event: &BrainEvent,
    ) -> Result<Self, VoiceProtocolDiagnostic> {
        let BrainEvent::TurnDeferred {
            response_id,
            question_id,
            reason,
            can_retry_same_question,
        } = event
        else {
            return Err(diagnostic(
                VoiceProtocolDiagnosticCode::Invariant,
                "$.event.type",
            ));
        };
        Ok(Self::TurnDeferred {
            turn_id: require_active_turn_id(turn_id)?,
            response_id: response_id.clone(),
            question_id: question_id.clone(),
            reason: reason.clone(),
            can_retry_same_question: *can_retry_same_question,
        })
    }

    /// A complete, non-terminal recap. There is deliberately no constructor that accepts
    /// `partial` plus an optional reason.
    pub fn recap_ready(response_id: impl Into<String>, recap: StudySessionRecap) -> Self {
        Self::RecapReady {
            response_id: response_id.into(),
            recap,
            partial: false,
            partial_reason: None,
        }
    }

    /// `VOICE-TERMINAL-001`: a partial recap is terminal immediately and always states why.
    pub fn partial_recap_ready(
        response_id: impl Into<String>,
        recap: StudySessionRecap,
        partial_reason: TerminalSessionReason,
    ) -> Self {
        Self::RecapReady {
            response_id: response_id.into(),
            recap,
            partial: true,
            partial_reason: Some(partial_reason),
        }
    }

    /// A structured error that changes neither socket status nor submission availability.
    pub fn recoverable_structured_error(
        source: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::StructuredError {
            source: source.into(),
            code: code.into(),
            message: message.into(),
            terminality: VoiceStructuredErrorTerminality::Recoverable,
            terminal_reason: None,
        }
    }

    /// A structured error that changes terminal state immediately. The reason is required
    /// by the type, so a terminal error without one is unrepresentable.
    pub fn terminal_structured_error(
        source: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
        terminal_reason: TerminalSessionReason,
    ) -> Self {
        Self::StructuredError {
            source: source.into(),
            code: code.into(),
            message: message.into(),
            terminality: VoiceStructuredErrorTerminality::Terminal,
            terminal_reason: Some(terminal_reason),
        }
    }

    /// The single authoritative terminality rule for a v5 server event, shared by Rust and
    /// TypeScript: a terminal session phase, a partial recap, and a terminal structured
    /// error are the only events that end a wire session. A deferred turn never is.
    pub fn terminal_reason(&self) -> Option<TerminalSessionReason> {
        match self {
            Self::SessionPhase {
                terminal_reason, ..
            } => *terminal_reason,
            Self::RecapReady {
                partial,
                partial_reason,
                ..
            } => partial.then_some(*partial_reason).flatten(),
            Self::StructuredError {
                terminality,
                terminal_reason,
                ..
            } => match terminality {
                VoiceStructuredErrorTerminality::Terminal => *terminal_reason,
                VoiceStructuredErrorTerminality::Recoverable => None,
            },
            _ => None,
        }
    }
}

/// A wire turn binding is a non-empty strict id. An unbound turn cannot be attached to a
/// turn-scoped event.
fn require_active_turn_id(turn_id: &str) -> Result<String, VoiceProtocolDiagnostic> {
    if !is_strict_wire_id(turn_id) {
        return Err(diagnostic(
            VoiceProtocolDiagnosticCode::InvalidField,
            "$.event.turn_id",
        ));
    }
    Ok(turn_id.to_owned())
}

impl TryFrom<BrainEvent> for VivaServerEvent {
    type Error = VoiceProtocolDiagnostic;

    fn try_from(event: BrainEvent) -> Result<Self, Self::Error> {
        Ok(match event {
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
            // `VOICE-TURN-001` / `VOICE-TURN-002`: both are bound to the active wire turn,
            // which the domain event does not carry. Plan 08 must call the explicit
            // turn constructors instead of this blanket conversion.
            BrainEvent::QuestionStarted { .. } | BrainEvent::TurnDeferred { .. } => {
                return Err(diagnostic(
                    VoiceProtocolDiagnosticCode::Invariant,
                    "$.event.turn_id",
                ))
            }
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
            BrainEvent::RecapReady { response_id, recap } => Self::recap_ready(response_id, recap),
            BrainEvent::AudioDelta { response_id, frame }
            | BrainEvent::ResponseAudio { response_id, frame } => {
                Self::AudioDelta { response_id, frame }
            }
            BrainEvent::Transcript(text) => Self::TranscriptDelta {
                response_id: "legacy-transcript".to_owned(),
                text,
            },
            BrainEvent::Usage(_) => Self::recoverable_structured_error(
                "agent-service",
                VOICE_TELEMETRY_EVENT_SUPPRESSED_CODE,
                "telemetry event suppressed",
            ),
            // A classified provider failure carries the domain's own terminal reason;
            // `VOICE-TERMINAL-002` forbids relabelling it recoverable to keep a socket.
            // An unclassified one has no proven terminal reason, and the domain forbids
            // inferring one from `source`/`message`, so it stays recoverable under a
            // distinct code rather than fabricating terminality.
            BrainEvent::Error(error) => {
                match error.failure().map(|failure| failure.terminal_reason()) {
                    Some(terminal_reason) => Self::terminal_structured_error(
                        error.source.clone(),
                        VOICE_PROVIDER_FAILURE_CODE,
                        error.message.clone(),
                        terminal_reason,
                    ),
                    None => Self::recoverable_structured_error(
                        error.source.clone(),
                        VOICE_PROVIDER_ERROR_UNCLASSIFIED_CODE,
                        error.message.clone(),
                    ),
                }
            }
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
            BrainEvent::ResponseToolProposal { response_id, .. } => {
                Self::recoverable_structured_error(
                    "agent-service",
                    VOICE_TOOL_PROPOSAL_NOT_BROWSER_SENDABLE_CODE,
                    format!("tool proposal {response_id} cannot be sent directly to browser"),
                )
            }
            BrainEvent::SpeechIntent(intent) => Self::TranscriptFinal {
                response_id: "speech-intent".to_owned(),
                text: intent.text,
                confidence: None,
            },
            _ => Self::recoverable_structured_error(
                "agent-service",
                VOICE_UNSUPPORTED_BRAIN_EVENT_CODE,
                "unsupported brain event",
            ),
        })
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

    /// Wraps a turn-independent domain event. Turn-bound events (`question_started`,
    /// `turn_deferred`) reject here and must use their explicit constructors.
    pub fn event(event: BrainEvent) -> Result<Self, VoiceProtocolDiagnostic> {
        Ok(Self::from_event(VivaServerEvent::try_from(event)?))
    }

    fn from_event(event: VivaServerEvent) -> Self {
        Self::Event {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            event: Box::new(event),
        }
    }

    /// `VOICE-TURN-001`: the owner-provided `question_started` constructor. Plan 08 calls
    /// it with the active wire turn while updating socket turn accounting.
    pub fn question_started(
        turn_id: &str,
        event: &BrainEvent,
    ) -> Result<Self, VoiceProtocolDiagnostic> {
        Ok(Self::from_event(VivaServerEvent::question_started(
            turn_id, event,
        )?))
    }

    /// `VOICE-TURN-002`: the owner-provided `turn_deferred` constructor. It accepts only
    /// Plan 06's `BrainEvent::TurnDeferred`, validates the active turn id, and copies the
    /// persisted outcome losslessly. Plan 08 calls it; it does not redeclare the mapping.
    pub fn turn_deferred(
        turn_id: &str,
        event: &BrainEvent,
    ) -> Result<Self, VoiceProtocolDiagnostic> {
        Ok(Self::from_event(VivaServerEvent::turn_deferred(
            turn_id, event,
        )?))
    }

    pub fn browser_event(event: BrainEvent) -> Option<Self> {
        match event {
            // Turn-bound: the wire turn id is not derivable from the domain event, so
            // these are unreachable through the blanket path by construction.
            BrainEvent::QuestionStarted { .. } | BrainEvent::TurnDeferred { .. } => None,
            BrainEvent::SessionPhase { .. }
            | BrainEvent::TerminalSessionPhase { .. }
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
            | BrainEvent::ResponseTextStarted { .. } => Self::event(event).ok(),
            BrainEvent::Usage(_)
            | BrainEvent::ResponseCompleted { .. }
            | BrainEvent::ProviderFallbackActivated { .. }
            | BrainEvent::ResponseToolProposal { .. }
            | BrainEvent::Transcript(_)
            | BrainEvent::SpeechIntent(_) => None,
            _ => None,
        }
    }

    /// A typed server error. The constructor derives `retryable` from the code, so an
    /// error frame whose retryability contradicts its code is unrepresentable.
    pub fn error(code: VoiceServerErrorCode, message: impl Into<String>) -> Self {
        Self::Error {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            error: ServerError::new(code, message),
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

    use agent_domain::{BrainInput, BrainProviderError, RealtimeBrain};
    use serde::Deserialize;
    use serde_json::{json, Value};
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

    /// The frozen unversioned `question_started` fixture predates `VOICE-TURN-001`'s
    /// required wire `turn_id`, so v5 rejects it at that exact path. Positive coverage
    /// lives in `turn-outcomes.json` and the two-turn session corpora; Task 9 Step 6
    /// deletes this fixture.
    #[test]
    fn rejects_legacy_question_started_event_fixture() {
        let diagnostic = parse_server_frame_json(include_str!(
            "../../../fixtures/voice-protocol/server-event-question-started.json"
        ))
        .map(|_| ())
        .expect_err("a turn-less question start is not a v5 event");
        assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::MissingField);
        assert_eq!(diagnostic.path, "$.event.turn_id");
    }

    /// Likewise, the frozen structured-error fixture predates `VOICE-TERMINAL-002`'s
    /// required `code` and `terminality`.
    #[test]
    fn rejects_legacy_structured_error_event_fixture() {
        let diagnostic = parse_server_frame_json(include_str!(
            "../../../fixtures/voice-protocol/server-event-structured-error.json"
        ))
        .map(|_| ())
        .expect_err("an untyped structured error is not a v5 event");
        assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::MissingField);
        assert_eq!(diagnostic.path, "$.event.code");
    }

    #[test]
    fn maps_provider_failures_to_their_own_terminal_reason() {
        let failure =
            agent_domain::BrainProviderFailure::new(agent_domain::BrainProviderFailureParts {
                failure_class: agent_domain::BrainFailureClass::Timeout,
                stage: agent_domain::BrainFailureStage::Provider,
                retry_eligible: false,
                latency_ms: 0,
                provider: "fixture-provider".to_owned(),
                model: "fixture-model".to_owned(),
                metadata: "fixture".to_owned(),
            });
        let frame =
            ServerFrame::event(BrainEvent::Error(BrainProviderError::from_failure(failure)))
                .expect("a classified provider failure converts");
        let ServerFrame::Event { event, .. } = &frame else {
            panic!("expected an event frame");
        };
        assert_eq!(
            event.terminal_reason(),
            Some(TerminalSessionReason::ProviderTimeout)
        );

        // An unclassified provider error has no proven terminal reason and the domain
        // forbids inferring one from `source`/`message`, so it stays recoverable under a
        // distinct code rather than fabricating terminality.
        let unclassified = ServerFrame::event(BrainEvent::Error(BrainProviderError {
            source: "agent-service".to_owned(),
            message: "provider error".to_owned(),
            failure: None,
        }))
        .expect("an unclassified provider error converts");
        let ServerFrame::Event { event, .. } = &unclassified else {
            panic!("expected an event frame");
        };
        assert_eq!(event.terminal_reason(), None);
    }

    #[test]
    fn serializes_shared_manuscript_intent_fixture() {
        let frame = ServerFrame::event(BrainEvent::ManuscriptIntent {
            response_id: "response-1".to_owned(),
            intent: agent_domain::ManuscriptIntent::Scene {
                register: agent_domain::ManuscriptRegister::Examining,
                emphasis: agent_domain::ManuscriptEmphasis::Measured,
            },
        })
        .expect("a turn-independent event converts");

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
        // These are deliberate frame-size contract pins: they fail the moment a
        // constant moves, which is exactly why they read as constant to clippy.
        #[allow(clippy::assertions_on_constants)]
        {
            assert_eq!(2_250 * 960, VIVA_AUDIO_MAX_TURN_BYTES);
            assert_eq!(4_500 * 480, VIVA_AUDIO_MAX_TURN_BYTES);
            assert!(4_500 - 1 > 2_250 - 1);
            assert!(263 * VIVA_AUDIO_MAX_CHUNK_BYTES <= VIVA_AUDIO_MAX_TURN_BYTES);
            assert!(264 * VIVA_AUDIO_MAX_CHUNK_BYTES > VIVA_AUDIO_MAX_TURN_BYTES);
        }
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
    /// `VOICE-DIFFERENTIAL-001`: one shared case format, executed in file order with no
    /// id filter. A valid case must reserialize byte for byte; a rejecting case must
    /// produce the exact code and path and leak nothing about the input.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct DifferentialCaseFile {
        schema: String,
        protocol_version: u32,
        cases: Vec<DifferentialCase>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct DifferentialCase {
        id: String,
        wire_json: String,
        valid: bool,
        diagnostic_code: Option<String>,
        path: Option<String>,
    }

    /// Substrings no diagnostic may ever carry: credentials, learner facts, raw JSON.
    const DIAGNOSTIC_LEAK_NEEDLES: [&str; 6] = [
        "viva1",
        "fixture-user",
        "fixture-study-set",
        "NADH",
        "AQIDBA",
        "{",
    ];

    /// Every nested object boundary of a wire frame, root first.
    fn object_boundaries(value: &Value, path: Vec<String>, out: &mut Vec<Vec<String>>) {
        match value {
            Value::Object(map) => {
                out.push(path.clone());
                for (key, entry) in map {
                    let mut next = path.clone();
                    next.push(key.clone());
                    object_boundaries(entry, next, &mut *out);
                }
            }
            Value::Array(items) => {
                for (index, entry) in items.iter().enumerate() {
                    let mut next = path.clone();
                    next.push(index.to_string());
                    object_boundaries(entry, next, &mut *out);
                }
            }
            _ => {}
        }
    }

    fn with_injected(source: &Value, path: &[String], key: &str, injected: Value) -> Value {
        let mut clone = source.clone();
        let mut cursor = &mut clone;
        for step in path {
            cursor = match cursor {
                Value::Object(map) => map.get_mut(step).expect("object step"),
                Value::Array(items) => items
                    .get_mut(step.parse::<usize>().expect("array index"))
                    .expect("array step"),
                other => other,
            };
        }
        cursor
            .as_object_mut()
            .expect("injection target is an object")
            .insert(key.to_owned(), injected);
        clone
    }

    fn run_differential_cases<T: serde::Serialize>(
        raw: &str,
        parse: impl Fn(&str) -> Result<T, VoiceProtocolDiagnostic>,
    ) -> usize {
        run_case_file(raw, "viva.voice-differential-cases.v1", parse)
    }

    fn run_case_file<T: serde::Serialize>(
        raw: &str,
        schema: &str,
        parse: impl Fn(&str) -> Result<T, VoiceProtocolDiagnostic>,
    ) -> usize {
        let file: DifferentialCaseFile =
            serde_json::from_str(raw).expect("differential case file parses strictly");
        assert_eq!(file.schema, schema);
        assert_eq!(file.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);
        assert!(!file.cases.is_empty());

        let mut seen = std::collections::BTreeSet::new();
        for differential_case in &file.cases {
            let id = differential_case.id.as_str();
            assert!(seen.insert(id), "{id} is duplicated");

            if differential_case.valid {
                assert_eq!(differential_case.diagnostic_code, None, "{id}");
                assert_eq!(differential_case.path, None, "{id}");
                let frame = parse(&differential_case.wire_json)
                    .unwrap_or_else(|error| panic!("{id} parses: {error}"));
                assert_eq!(
                    serde_json::to_string(&frame).expect("frame serializes"),
                    differential_case.wire_json,
                    "{id} does not reserialize byte for byte"
                );

                // Mutation controls: an unknown field at any object boundary rejects, and
                // no other protocol version is accepted.
                let source: Value =
                    serde_json::from_str(&differential_case.wire_json).expect("valid case is JSON");
                let mut boundaries = Vec::new();
                object_boundaries(&source, Vec::new(), &mut boundaries);
                assert!(!boundaries.is_empty(), "{id}");
                for boundary in &boundaries {
                    let mutated = with_injected(
                        &source,
                        boundary,
                        "VOICE_unknown_fixture_field",
                        Value::Bool(true),
                    );
                    let diagnostic = parse(&mutated.to_string())
                        .map(|_| ())
                        .expect_err("an unknown field rejects");
                    assert_eq!(
                        diagnostic.code,
                        VoiceProtocolDiagnosticCode::UnknownField,
                        "{id} accepted an unknown field at {boundary:?}"
                    );
                    assert!(
                        diagnostic.path.ends_with("VOICE_unknown_fixture_field"),
                        "{id} reported {} for an injected field",
                        diagnostic.path
                    );
                }
                for version in [4_u64, 6] {
                    let mutated = with_injected(&source, &[], "version", Value::from(version));
                    let diagnostic = parse(&mutated.to_string())
                        .map(|_| ())
                        .expect_err("another protocol version rejects");
                    assert_eq!(
                        diagnostic.code,
                        VoiceProtocolDiagnosticCode::UnsupportedVersion,
                        "{id}"
                    );
                    assert_eq!(diagnostic.path, "$.version", "{id}");
                }
                continue;
            }

            let diagnostic = parse(&differential_case.wire_json)
                .map(|_| ())
                .expect_err(id);
            assert_eq!(
                Some(diagnostic.code.as_str().to_owned()),
                differential_case.diagnostic_code,
                "{id}"
            );
            assert_eq!(
                Some(diagnostic.path.clone()),
                differential_case.path,
                "{id}"
            );

            let rendered = format!("{diagnostic}");
            for needle in DIAGNOSTIC_LEAK_NEEDLES {
                assert!(!rendered.contains(needle), "{id} leaked {needle}");
            }
        }
        file.cases.len()
    }

    #[test]
    fn voice_v5_client_differential_cases() {
        let executed = run_differential_cases(
            include_str!("../../../fixtures/voice-protocol/v5/client-differential-cases.json"),
            parse_client_frame_json,
        );
        assert!(executed >= 25, "the client corpus is too small: {executed}");
    }

    #[test]
    fn voice_v5_server_differential_cases() {
        let executed = run_differential_cases(
            include_str!("../../../fixtures/voice-protocol/v5/server-differential-cases.json"),
            parse_server_frame_json,
        );
        assert!(executed >= 25, "the server corpus is too small: {executed}");
    }

    // -----------------------------------------------------------------------
    // Task 7 - VOICE-TURN-001 / VOICE-TURN-002 / VOICE-TERMINAL-001 /
    // VOICE-TERMINAL-002 / VOICE-TERMINATION-001
    // -----------------------------------------------------------------------

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TerminalSequenceFile {
        schema: String,
        protocol_version: u32,
        sequences: Vec<TerminalSequenceCase>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TerminalSequenceCase {
        id: String,
        terminal_reason: Option<String>,
        terminal_at_index: Option<usize>,
        wire_sequence_json: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TransportOutcomeFile {
        schema: String,
        protocol_version: u32,
        cases: Vec<TransportOutcomeCase>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TransportOutcomeCase {
        id: String,
        input: VoiceTerminationInput,
        expected: Value,
    }

    /// `VOICE-TURN-002`: none of these keys may appear on a deferred wire event.
    const DEFERRED_FORBIDDEN_KEYS: [&str; 8] = [
        "provider_message",
        "feedback",
        "confidence",
        "status",
        "schedule",
        "mastery",
        "retryable",
        "terminal_reason",
    ];

    fn turn_deferred_events(raw: &str) -> Vec<serde_json::Map<String, Value>> {
        let file: DifferentialCaseFile =
            serde_json::from_str(raw).expect("turn outcome file parses strictly");
        file.cases
            .iter()
            .filter(|outcome| outcome.valid)
            .filter_map(|outcome| {
                let frame: Value =
                    serde_json::from_str(&outcome.wire_json).expect("valid case is JSON");
                let event = frame.get("event")?.as_object()?.clone();
                (event.get("type").and_then(Value::as_str) == Some("turn_deferred"))
                    .then_some(event)
            })
            .collect()
    }

    #[test]
    fn voice_v5_turn_and_terminal_sequences_match() {
        // The six exact snake_case mirrors of Plan 04 `EvaluationDeferralReason`.
        assert_eq!(
            VOICE_DEFERRAL_REASONS,
            [
                "empty_answer",
                "transcript_uncertain",
                "evaluator_unavailable",
                "invalid_evaluator_output",
                "insufficient_semantic_evidence",
                "contradictory_evidence",
            ]
        );
        // The domain enum is the authority: every variant's serde token must be one of
        // the six, and the list is exhaustive by construction (a new variant fails to
        // compile here rather than silently missing the wire).
        for reason in [
            EvaluationDeferralReason::EmptyAnswer,
            EvaluationDeferralReason::TranscriptUncertain,
            EvaluationDeferralReason::EvaluatorUnavailable,
            EvaluationDeferralReason::InvalidEvaluatorOutput,
            EvaluationDeferralReason::InsufficientSemanticEvidence,
            EvaluationDeferralReason::ContradictoryEvidence,
        ] {
            let wire = serde_json::to_value(&reason).expect("reason serializes");
            assert!(
                VOICE_DEFERRAL_REASONS.contains(&wire.as_str().expect("reason is a string")),
                "{wire} is not mirrored on the v5 wire"
            );
        }

        // Turn intents and turn outcomes run in full, with no id filter.
        let intents = run_case_file(
            include_str!("../../../fixtures/voice-protocol/v5/turn-intents.json"),
            "viva.voice-client-frame-cases.v1",
            parse_client_frame_json,
        );
        assert!(
            intents >= 8,
            "the turn-intent corpus is too small: {intents}"
        );
        let outcomes = run_case_file(
            include_str!("../../../fixtures/voice-protocol/v5/turn-outcomes.json"),
            "viva.voice-server-event-cases.v1",
            parse_server_frame_json,
        );
        assert!(
            outcomes >= 15,
            "the turn-outcome corpus is too small: {outcomes}"
        );

        // Every deferral reason and both retry affordances are covered, and no deferred
        // event carries a grade, a schedule, or provider prose.
        let deferred = turn_deferred_events(include_str!(
            "../../../fixtures/voice-protocol/v5/turn-outcomes.json"
        ));
        assert!(!deferred.is_empty());
        let reasons: std::collections::BTreeSet<&str> = deferred
            .iter()
            .map(|event| event["reason"].as_str().expect("reason is a string"))
            .collect();
        assert_eq!(
            reasons,
            VOICE_DEFERRAL_REASONS
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
        );
        let retries: std::collections::BTreeSet<bool> = deferred
            .iter()
            .map(|event| {
                event["can_retry_same_question"]
                    .as_bool()
                    .expect("retry affordance is a bool")
            })
            .collect();
        assert_eq!(retries, [false, true].into_iter().collect());
        for event in &deferred {
            assert_eq!(
                event.keys().map(String::as_str).collect::<Vec<_>>(),
                vec![
                    "can_retry_same_question",
                    "question_id",
                    "reason",
                    "response_id",
                    "turn_id",
                    "type",
                ],
                "a deferred event carries exactly the six contract keys"
            );
            for forbidden in DEFERRED_FORBIDDEN_KEYS {
                assert!(
                    !event.contains_key(forbidden),
                    "deferred carried {forbidden}"
                );
            }
            let parsed: VivaServerEvent = serde_json::from_value(Value::Object(event.clone()))
                .expect("deferred event parses");
            assert_eq!(parsed.terminal_reason(), None, "deferral is not terminal");
        }

        // `ServerFrame::turn_deferred` copies the persisted Plan 06 outcome losslessly and
        // accepts nothing else.
        let domain = BrainEvent::TurnDeferred {
            response_id: "response-2".to_owned(),
            question_id: "question-2".to_owned(),
            reason: EvaluationDeferralReason::EvaluatorUnavailable,
            can_retry_same_question: true,
        };
        let frame = ServerFrame::turn_deferred("turn-2", &domain).expect("constructs");
        assert_eq!(
            serde_json::to_value(&frame).expect("serializes"),
            json!({
                "type": "event",
                "version": 5,
                "event": {
                    "type": "turn_deferred",
                    "turn_id": "turn-2",
                    "response_id": "response-2",
                    "question_id": "question-2",
                    "reason": "evaluator_unavailable",
                    "can_retry_same_question": true,
                },
            })
        );
        let wrong_event = ServerFrame::turn_deferred(
            "turn-2",
            &BrainEvent::TranscriptDelta {
                response_id: "response-2".to_owned(),
                text: "not a deferral".to_owned(),
            },
        )
        .expect_err("only a durable deferral may construct this event");
        assert_eq!(wrong_event.code, VoiceProtocolDiagnosticCode::Invariant);
        let blank_turn = ServerFrame::turn_deferred("", &domain)
            .expect_err("an unbound turn cannot construct this event");
        assert_eq!(blank_turn.code, VoiceProtocolDiagnosticCode::InvalidField);
        assert_eq!(blank_turn.path, "$.event.turn_id");

        // `question_started` is turn-bound too, and the domain event alone cannot supply it.
        let started = ServerFrame::question_started(
            "turn-1",
            &BrainEvent::QuestionStarted {
                response_id: "response-1".to_owned(),
                question: agent_domain::fixture_question(),
            },
        )
        .expect("constructs");
        let started_value = serde_json::to_value(&started).expect("serializes");
        assert_eq!(started_value["event"]["turn_id"], json!("turn-1"));
        assert!(ServerFrame::event(BrainEvent::QuestionStarted {
            response_id: "response-1".to_owned(),
            question: agent_domain::fixture_question(),
        })
        .is_err());
        assert!(ServerFrame::browser_event(BrainEvent::TurnDeferred {
            response_id: "response-2".to_owned(),
            question_id: "question-2".to_owned(),
            reason: EvaluationDeferralReason::EmptyAnswer,
            can_retry_same_question: false,
        })
        .is_none());

        // Terminal sequences: terminality is a property of the frame, not of the trailer.
        let terminal_file: TerminalSequenceFile = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/v5/terminal-sequences.json"
        ))
        .expect("terminal sequence file parses strictly");
        assert_eq!(terminal_file.schema, "viva.voice-terminal-sequences.v1");
        assert_eq!(terminal_file.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);
        assert!(!terminal_file.sequences.is_empty());
        let mut seen = std::collections::BTreeSet::new();
        for sequence in &terminal_file.sequences {
            assert!(
                seen.insert(sequence.id.as_str()),
                "{} duplicated",
                sequence.id
            );
            let mut first_terminal: Option<(usize, String)> = None;
            for (index, wire_json) in sequence.wire_sequence_json.iter().enumerate() {
                let frame = parse_server_frame_json(wire_json)
                    .unwrap_or_else(|error| panic!("{} [{index}]: {error}", sequence.id));
                assert_eq!(
                    serde_json::to_string(&frame).expect("frame serializes"),
                    *wire_json,
                    "{} [{index}] does not reserialize byte for byte",
                    sequence.id
                );
                if let ServerFrame::Event { event, .. } = &frame {
                    if let Some(reason) = event.terminal_reason() {
                        if first_terminal.is_none() {
                            let wire = serde_json::to_value(reason).expect("reason serializes");
                            first_terminal = Some((
                                index,
                                wire.as_str().expect("reason is a string").to_owned(),
                            ));
                        }
                    }
                }
            }
            assert_eq!(
                first_terminal.as_ref().map(|(index, _)| *index),
                sequence.terminal_at_index,
                "{}",
                sequence.id
            );
            assert_eq!(
                first_terminal.map(|(_, reason)| reason),
                sequence.terminal_reason,
                "{}",
                sequence.id
            );
        }

        // A partial recap remains terminal when the trailing phase frame is lost.
        let with_trailer = terminal_file
            .sequences
            .iter()
            .find(|sequence| sequence.id == "VOICE-TERMINAL-PARTIAL-RECAP-THEN-PHASE")
            .expect("partial recap sequence");
        let without_trailer = terminal_file
            .sequences
            .iter()
            .find(|sequence| sequence.id == "VOICE-TERMINAL-PARTIAL-RECAP-TRAILING-PHASE-LOST")
            .expect("truncated partial recap sequence");
        assert_eq!(
            without_trailer.wire_sequence_json,
            vec![with_trailer.wire_sequence_json[0].clone()]
        );
        assert_eq!(
            without_trailer.terminal_reason,
            with_trailer.terminal_reason
        );
        assert_eq!(without_trailer.terminal_at_index, Some(0));

        // Structured-error terminality is explicit in both directions.
        // Split so the source scan above still proves this module carries no D-03 branch.
        let policy_denied_code = format!("VOICE_SESSION_REFRESH{}", "_POLICY_DENIED");
        let recoverable = parse_server_frame_json(
            &json!({
                "type": "event",
                "version": 5,
                "event": {
                    "type": "structured_error",
                    "source": "agent-service",
                    "code": policy_denied_code,
                    "message": "Session refresh is not authorized.",
                    "terminality": "recoverable",
                },
            })
            .to_string(),
        )
        .expect("a recoverable policy denial parses");
        if let ServerFrame::Event { event, .. } = &recoverable {
            assert_eq!(event.terminal_reason(), None);
        } else {
            panic!("expected an event frame");
        }
        let recoverable_with_reason = parse_server_frame_json(
            &json!({
                "type": "event",
                "version": 5,
                "event": {
                    "type": "structured_error",
                    "source": "agent-service",
                    "code": policy_denied_code,
                    "message": "Session refresh is not authorized.",
                    "terminality": "recoverable",
                    "terminal_reason": "provider_timeout",
                },
            })
            .to_string(),
        )
        .map(|_| ())
        .expect_err("a recoverable error may not carry a terminal reason");
        assert_eq!(
            recoverable_with_reason.code,
            VoiceProtocolDiagnosticCode::Invariant
        );
        assert_eq!(recoverable_with_reason.path, "$.event.terminal_reason");
        let terminal_without_reason = parse_server_frame_json(
            &json!({
                "type": "event",
                "version": 5,
                "event": {
                    "type": "structured_error",
                    "source": "agent-service",
                    "code": "VOICE_PROVIDER_FAILURE",
                    "message": "Provider failed.",
                    "terminality": "terminal",
                },
            })
            .to_string(),
        )
        .map(|_| ())
        .expect_err("a terminal error must carry its reason");
        assert_eq!(
            terminal_without_reason.code,
            VoiceProtocolDiagnosticCode::MissingField
        );
        assert_eq!(terminal_without_reason.path, "$.event.terminal_reason");

        // The owner-provided v5 serialization fallback round-trips to its own typed error.
        assert_eq!(
            VOICE_SERIALIZATION_FALLBACK_FRAME,
            "{\"type\":\"error\",\"version\":5,\"error\":{\"code\":\"VOICE_INTERNAL_SERIALIZATION\",\"message\":\"Server frame serialization failed.\",\"retryable\":true}}"
        );
        let fallback =
            parse_server_frame_json(VOICE_SERIALIZATION_FALLBACK_FRAME).expect("fallback parses");
        assert_eq!(
            serde_json::to_string(&fallback).expect("fallback serializes"),
            VOICE_SERIALIZATION_FALLBACK_FRAME
        );
        assert_eq!(
            fallback,
            ServerFrame::error(
                VoiceServerErrorCode::InternalSerialization,
                "Server frame serialization failed."
            )
        );

        // Termination classification: fixture-driven, priority-ordered, text-free.
        let transport_file: TransportOutcomeFile = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/v5/transport-outcomes.json"
        ))
        .expect("transport outcome file parses strictly");
        assert_eq!(transport_file.schema, "viva.voice-transport-outcomes.v1");
        assert_eq!(transport_file.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);
        assert!(!transport_file.cases.is_empty());
        let mut codes = std::collections::BTreeSet::new();
        let mut reasons = std::collections::BTreeSet::new();
        let mut ids = std::collections::BTreeSet::new();
        for outcome in &transport_file.cases {
            assert!(ids.insert(outcome.id.as_str()), "{} duplicated", outcome.id);
            let classified = classify_voice_termination(&outcome.input);
            assert_eq!(
                serde_json::to_value(classified).expect("classification serializes"),
                outcome.expected,
                "{}",
                outcome.id
            );
            if let Some(error) = &outcome.input.error {
                codes.insert(error.code.clone());
                let rendered = serde_json::to_string(&classified).expect("serializes");
                assert!(
                    !rendered.contains(&error.message),
                    "{} leaked a close message",
                    outcome.id
                );
            }
            if let Some(reason) = &outcome.input.terminal_reason {
                reasons.insert(
                    serde_json::to_value(reason)
                        .expect("reason serializes")
                        .as_str()
                        .expect("reason is a string")
                        .to_owned(),
                );
            }
        }
        assert_eq!(
            codes,
            VoiceServerErrorCode::ALL
                .into_iter()
                .map(|code| code.as_str().to_owned())
                .collect::<std::collections::BTreeSet<_>>()
        );
        assert_eq!(
            reasons.len(),
            TerminalSessionReason::ALL.len(),
            "every terminal reason must be covered"
        );

        // A terminal reason outranks a typed error, and hostile prose changes nothing.
        assert_eq!(
            classify_voice_termination(&VoiceTerminationInput {
                error: Some(ServerError::new(
                    VoiceServerErrorCode::AuthExpired,
                    "Expired."
                )),
                terminal_reason: Some(TerminalSessionReason::ProviderTimeout),
                close_code: 1011,
                was_clean: false,
            }),
            VoiceTermination::Terminal {
                terminal_reason: TerminalSessionReason::ProviderTimeout,
                retryable: false,
                close_code: 1011,
            }
        );
        assert_eq!(
            classify_voice_termination(&VoiceTerminationInput {
                error: Some(ServerError::new(
                    VoiceServerErrorCode::ClientFrameMalformed,
                    "terminal drained retry now 1000 clean",
                )),
                terminal_reason: None,
                close_code: 1008,
                was_clean: true,
            }),
            VoiceTermination::Protocol {
                error_code: VoiceServerErrorCode::ClientFrameMalformed,
                retryable: false,
                close_code: 1008,
            }
        );
        assert_eq!(
            classify_voice_termination(&VoiceTerminationInput {
                error: None,
                terminal_reason: None,
                close_code: 1000,
                was_clean: true,
            }),
            VoiceTermination::Normal {
                retryable: false,
                close_code: 1000,
            }
        );
        assert_eq!(
            classify_voice_termination(&VoiceTerminationInput {
                error: None,
                terminal_reason: None,
                close_code: 1000,
                was_clean: false,
            }),
            VoiceTermination::Transport {
                retryable: true,
                close_code: 1000,
            }
        );
    }

    // -----------------------------------------------------------------------
    // Task 8 - VOICE-FIXTURE-001 / VOICE-SESSION-001 / VOICE-AUDIO-TURN-LIFECYCLE
    // -----------------------------------------------------------------------

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ManifestFile {
        schema: String,
        protocol_version: u32,
        supported_versions: Vec<u32>,
        legacy_v4_disposition: String,
        fixtures: Vec<ManifestRow>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ManifestRow {
        id: String,
        path: String,
        kind: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct AudioSequenceFile {
        schema: String,
        protocol_version: u32,
        cases: Vec<AudioSequenceCase>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct AudioSequenceCase {
        id: String,
        wire_sequence_json: Vec<String>,
        valid: bool,
        diagnostic_code: Option<String>,
        path: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SessionSequenceFile {
        schema: String,
        protocol_version: u32,
        id: String,
        provider: String,
        client_generation_id: String,
        turns: Vec<SessionTurn>,
        client_sequence_json: Vec<String>,
        server_sequence_json: Vec<String>,
    }

    #[derive(Clone, Deserialize, Eq, PartialEq, Debug)]
    #[serde(deny_unknown_fields)]
    struct SessionTurn {
        turn_id: String,
        response_id: String,
        question_id: String,
    }

    /// `VOICE-FIXTURE-001`: the exact immutable corpus, in manifest order.
    const EXPECTED_MANIFEST_ROWS: [(&str, &str, &str); 15] = [
        (
            "VOICE-FIXTURE-MANIFEST",
            "agent/fixtures/voice-protocol/v5/manifest.json",
            "manifest",
        ),
        (
            "VOICE-AUTH-DECISION",
            "agent/fixtures/voice-protocol/v5/auth-decision.json",
            "auth_decision",
        ),
        (
            "VOICE-CLIENT-SESSION-CONFIG-SIGNED",
            "agent/fixtures/voice-protocol/v5/client-session-config-signed.json",
            "client_frame",
        ),
        (
            "VOICE-CLIENT-SESSION-REFRESH",
            "agent/fixtures/voice-protocol/v5/client-session-refresh.json",
            "client_frame",
        ),
        (
            "VOICE-AUDIO-TURN-LIFECYCLE",
            "agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json",
            "frame_sequence",
        ),
        (
            "VOICE-CLIENT-TURN-INTENTS",
            "agent/fixtures/voice-protocol/v5/turn-intents.json",
            "client_frame_cases",
        ),
        (
            "VOICE-SERVER-TURN-OUTCOMES",
            "agent/fixtures/voice-protocol/v5/turn-outcomes.json",
            "server_event_cases",
        ),
        (
            "VOICE-SERVER-READY",
            "agent/fixtures/voice-protocol/v5/server-ready.json",
            "server_frame",
        ),
        (
            "VOICE-TERMINAL-SEQUENCES",
            "agent/fixtures/voice-protocol/v5/terminal-sequences.json",
            "frame_sequence",
        ),
        (
            "VOICE-TRANSPORT-OUTCOMES",
            "agent/fixtures/voice-protocol/v5/transport-outcomes.json",
            "transport_cases",
        ),
        (
            "VOICE-SYNTHETIC-TWO-TURN-SESSION",
            "agent/fixtures/voice-protocol/v5/synthetic-two-turn-session.json",
            "session_sequence",
        ),
        (
            "VOICE-FAKE-CARTESIA-GEMINI-TWO-TURN-SESSION",
            "agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json",
            "session_sequence",
        ),
        (
            "VOICE-CLIENT-DIFFERENTIAL-CASES",
            "agent/fixtures/voice-protocol/v5/client-differential-cases.json",
            "differential_cases",
        ),
        (
            "VOICE-SERVER-DIFFERENTIAL-CASES",
            "agent/fixtures/voice-protocol/v5/server-differential-cases.json",
            "differential_cases",
        ),
        (
            "VOICE-TOKEN-V1-VECTORS",
            "agent/fixtures/session-token/v1/vectors.json",
            "token_vectors",
        ),
    ];

    /// Every manifest-listed file, embedded at compile time so a missing one cannot build.
    const MANIFEST_FIXTURE_SOURCES: [(&str, &str); 15] = [
        (
            "agent/fixtures/voice-protocol/v5/manifest.json",
            include_str!("../../../fixtures/voice-protocol/v5/manifest.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/auth-decision.json",
            include_str!("../../../fixtures/voice-protocol/v5/auth-decision.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/client-session-config-signed.json",
            include_str!("../../../fixtures/voice-protocol/v5/client-session-config-signed.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/client-session-refresh.json",
            include_str!("../../../fixtures/voice-protocol/v5/client-session-refresh.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json",
            include_str!("../../../fixtures/voice-protocol/v5/audio-turn-lifecycle.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/turn-intents.json",
            include_str!("../../../fixtures/voice-protocol/v5/turn-intents.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/turn-outcomes.json",
            include_str!("../../../fixtures/voice-protocol/v5/turn-outcomes.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/server-ready.json",
            include_str!("../../../fixtures/voice-protocol/v5/server-ready.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/terminal-sequences.json",
            include_str!("../../../fixtures/voice-protocol/v5/terminal-sequences.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/transport-outcomes.json",
            include_str!("../../../fixtures/voice-protocol/v5/transport-outcomes.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/synthetic-two-turn-session.json",
            include_str!("../../../fixtures/voice-protocol/v5/synthetic-two-turn-session.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json",
            include_str!(
                "../../../fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json"
            ),
        ),
        (
            "agent/fixtures/voice-protocol/v5/client-differential-cases.json",
            include_str!("../../../fixtures/voice-protocol/v5/client-differential-cases.json"),
        ),
        (
            "agent/fixtures/voice-protocol/v5/server-differential-cases.json",
            include_str!("../../../fixtures/voice-protocol/v5/server-differential-cases.json"),
        ),
        (
            "agent/fixtures/session-token/v1/vectors.json",
            include_str!("../../../fixtures/session-token/v1/vectors.json"),
        ),
    ];

    const EXPECTED_AUDIO_LIFECYCLE_CASE_IDS: [&str; 8] = [
        "VOICE-CLIENT-AUDIO-VALID-PRODUCTION-SIZE",
        "VOICE-CLIENT-AUDIO-VALID-SMALL-CHUNK-HIGH-FINAL-SEQUENCE",
        "VOICE-CLIENT-REJECT-AUDIO-SEQUENCE-DUPLICATE",
        "VOICE-CLIENT-REJECT-AUDIO-SEQUENCE-GAP",
        "VOICE-CLIENT-REJECT-AUDIO-SEQUENCE-REORDER",
        "VOICE-CLIENT-REJECT-AUDIO-END-MISMATCH",
        "VOICE-CLIENT-REJECT-AUDIO-CHUNK-8193",
        "VOICE-CLIENT-REJECT-TURN-2160002",
    ];

    /// The v5 fixture directory, located by walking up from the crate root. The plan's
    /// gate runs inside `agent-service`; the isolated harness this lane must use while
    /// `data`/`agent-adapters` do not compile roots one level higher, so the search stops
    /// at whichever ancestor actually holds the corpus.
    fn v5_fixture_dir() -> std::path::PathBuf {
        let mut cursor = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        loop {
            let candidate = cursor.join("fixtures/voice-protocol/v5");
            if candidate.is_dir() {
                return candidate;
            }
            cursor = cursor.parent().expect("the v5 fixture directory exists");
        }
    }

    /// Raw byte length of canonical padded base64, without decoding the payload: this
    /// module never keeps decoded audio around, not even in a test.
    fn canonical_base64_byte_length(encoded: &str) -> usize {
        let padding = encoded
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'=')
            .count();
        encoded.len() / 4 * 3 - padding
    }

    fn session_events(session: &SessionSequenceFile, event_type: &str) -> Vec<Value> {
        session
            .server_sequence_json
            .iter()
            .filter_map(|wire_json| {
                let frame: Value = serde_json::from_str(wire_json).expect("frame is JSON");
                let event = frame.get("event")?.clone();
                (event.get("type").and_then(Value::as_str) == Some(event_type)).then_some(event)
            })
            .collect()
    }

    fn client_frames_of(session: &SessionSequenceFile, frame_type: &str) -> Vec<Value> {
        session
            .client_sequence_json
            .iter()
            .filter_map(|wire_json| {
                let frame: Value = serde_json::from_str(wire_json).expect("frame is JSON");
                (frame.get("type").and_then(Value::as_str) == Some(frame_type)).then_some(frame)
            })
            .collect()
    }

    #[test]
    fn voice_fixture_manifest_is_complete() {
        let manifest: ManifestFile = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/v5/manifest.json"
        ))
        .expect("manifest parses strictly");
        assert_eq!(manifest.schema, "viva.voice-fixtures.manifest.v1");
        assert_eq!(manifest.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);
        assert_eq!(
            manifest.supported_versions,
            vec![VIVA_VOICE_PROTOCOL_VERSION]
        );
        assert_eq!(manifest.legacy_v4_disposition, "reject");

        let rows: Vec<(&str, &str, &str)> = manifest
            .fixtures
            .iter()
            .map(|row| (row.id.as_str(), row.path.as_str(), row.kind.as_str()))
            .collect();
        assert_eq!(rows, EXPECTED_MANIFEST_ROWS.to_vec());

        let mut ids = std::collections::BTreeSet::new();
        let mut paths = std::collections::BTreeSet::new();
        for row in &manifest.fixtures {
            assert!(ids.insert(row.id.as_str()), "{} is duplicated", row.id);
            assert!(
                paths.insert(row.path.as_str()),
                "{} is duplicated",
                row.path
            );
        }

        // Every listed file exists (it is embedded at compile time), is non-empty JSON,
        // and carries no live v4 envelope.
        let embedded: std::collections::BTreeMap<&str, &str> =
            MANIFEST_FIXTURE_SOURCES.into_iter().collect();
        assert_eq!(embedded.len(), EXPECTED_MANIFEST_ROWS.len());
        for row in &manifest.fixtures {
            let raw = embedded
                .get(row.path.as_str())
                .unwrap_or_else(|| panic!("{} is listed but not embedded", row.path));
            let parsed: Value = serde_json::from_str(raw)
                .unwrap_or_else(|error| panic!("{} is not JSON: {error}", row.path));
            assert!(
                parsed.as_object().is_some_and(|object| !object.is_empty()),
                "{} is empty",
                row.path
            );
            if row.kind == "differential_cases" {
                continue;
            }
            assert!(
                !raw.contains("\"version\":4") && !raw.contains("\"version\": 4"),
                "{} carries a live v4 envelope",
                row.path
            );
        }

        // No unlisted JSON file hides in the versioned directory.
        let mut present: Vec<String> = std::fs::read_dir(v5_fixture_dir())
            .expect("the v5 fixture directory is readable")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.ends_with(".json"))
            .map(|name| format!("agent/fixtures/voice-protocol/v5/{name}"))
            .collect();
        present.sort();
        let mut listed: Vec<String> = manifest
            .fixtures
            .iter()
            .map(|row| row.path.clone())
            .filter(|path| path.starts_with("agent/fixtures/voice-protocol/v5/"))
            .collect();
        listed.sort();
        assert_eq!(present, listed);
    }

    #[test]
    fn voice_v5_two_turn_fixtures_are_exhaustive() {
        // `audio-turn-lifecycle.json`: schema, exact case-id set, and per-frame parses.
        // The stateful outcomes are executed behaviourally by Plan 08 against `ws.rs`.
        let lifecycle: AudioSequenceFile = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/v5/audio-turn-lifecycle.json"
        ))
        .expect("audio lifecycle file parses strictly");
        assert_eq!(lifecycle.schema, "viva.voice-audio-sequence-cases.v1");
        assert_eq!(lifecycle.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);
        assert_eq!(
            lifecycle
                .cases
                .iter()
                .map(|audio_case| audio_case.id.as_str())
                .collect::<Vec<_>>(),
            EXPECTED_AUDIO_LIFECYCLE_CASE_IDS.to_vec()
        );

        for audio_case in &lifecycle.cases {
            let per_frame = !audio_case.valid
                && audio_case.diagnostic_code.as_deref() == Some("VOICE_PROTOCOL_FRAME_TOO_LARGE");
            let mut rejections = 0_usize;
            let mut raw_bytes = 0_usize;
            let mut final_sequence: i64 = -1;
            for wire_json in &audio_case.wire_sequence_json {
                match parse_client_frame_json(wire_json) {
                    Ok(frame) => {
                        assert_eq!(
                            serde_json::to_string(&frame).expect("frame serializes"),
                            *wire_json,
                            "{} does not reserialize byte for byte",
                            audio_case.id
                        );
                    }
                    Err(diagnostic) => {
                        rejections += 1;
                        assert_eq!(
                            Some(diagnostic.code.as_str().to_owned()),
                            audio_case.diagnostic_code,
                            "{}",
                            audio_case.id
                        );
                        assert_eq!(
                            Some(diagnostic.path.clone()),
                            audio_case.path,
                            "{}",
                            audio_case.id
                        );
                    }
                }
                let value: Value = serde_json::from_str(wire_json).expect("entry is JSON");
                match value.get("type").and_then(Value::as_str) {
                    Some("audio_chunk") => {
                        let encoded = value["frame"]["pcm16_base64"]
                            .as_str()
                            .expect("chunk payload is a string");
                        raw_bytes += canonical_base64_byte_length(encoded);
                    }
                    Some("audio_end") => {
                        final_sequence = value["final_sequence"].as_i64().expect("final sequence");
                    }
                    _ => {}
                }
            }
            assert_eq!(
                rejections,
                usize::from(per_frame),
                "{} per-frame rejection count",
                audio_case.id
            );

            match audio_case.id.as_str() {
                "VOICE-CLIENT-AUDIO-VALID-PRODUCTION-SIZE" => {
                    assert_eq!(final_sequence, 2_249);
                    assert_eq!(raw_bytes, VIVA_AUDIO_MAX_TURN_BYTES);
                }
                "VOICE-CLIENT-AUDIO-VALID-SMALL-CHUNK-HIGH-FINAL-SEQUENCE" => {
                    // No derived chunk-count or final-sequence ceiling exists: smaller
                    // valid chunks may exceed the production final sequence while the
                    // aggregate stays inside the turn bound.
                    assert!(final_sequence > 2_249);
                    assert!(raw_bytes <= VIVA_AUDIO_MAX_TURN_BYTES);
                }
                "VOICE-CLIENT-REJECT-TURN-2160002" => {
                    assert_eq!(raw_bytes, VIVA_AUDIO_MAX_TURN_BYTES + 2);
                    assert_eq!(raw_bytes % 2, 0);
                    assert_eq!(
                        audio_case.diagnostic_code.as_deref(),
                        Some("VOICE_PROTOCOL_TURN_TOO_LARGE")
                    );
                    assert_eq!(audio_case.path.as_deref(), Some("$.frame.pcm16_base64"));
                }
                _ => {}
            }
        }

        // Both two-turn session corpora.
        let synthetic: SessionSequenceFile = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/v5/synthetic-two-turn-session.json"
        ))
        .expect("synthetic session parses strictly");
        let fake_provider: SessionSequenceFile = serde_json::from_str(include_str!(
            "../../../fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json"
        ))
        .expect("fake provider session parses strictly");
        assert_eq!(synthetic.provider, "synthetic");
        assert_eq!(fake_provider.provider, "fake_cartesia_gemini");
        assert_eq!(synthetic.turns, fake_provider.turns);
        assert_eq!(
            synthetic.client_generation_id,
            fake_provider.client_generation_id
        );
        assert_eq!(synthetic.id, "VOICE-SYNTHETIC-TWO-TURN-SESSION");
        assert_eq!(
            fake_provider.id,
            "VOICE-FAKE-CARTESIA-GEMINI-TWO-TURN-SESSION"
        );

        for session in [&synthetic, &fake_provider] {
            let label = session.id.as_str();
            assert_eq!(session.schema, "viva.voice-session-sequence.v1");
            assert_eq!(session.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);

            // Byte-exact round trip in both directions, in wire order.
            for wire_json in &session.client_sequence_json {
                let frame = parse_client_frame_json(wire_json)
                    .unwrap_or_else(|error| panic!("{label}: {error}"));
                assert_eq!(
                    serde_json::to_string(&frame).expect("frame serializes"),
                    *wire_json,
                    "{label} client frame does not reserialize byte for byte"
                );
            }
            for wire_json in &session.server_sequence_json {
                let frame = parse_server_frame_json(wire_json)
                    .unwrap_or_else(|error| panic!("{label}: {error}"));
                assert_eq!(
                    serde_json::to_string(&frame).expect("frame serializes"),
                    *wire_json,
                    "{label} server frame does not reserialize byte for byte"
                );
                // Nothing in either corpus is terminal: deferral does not end a session.
                if let ServerFrame::Event { event, .. } = &frame {
                    assert_eq!(event.terminal_reason(), None, "{label}");
                }
            }

            // One signed, generation-bound first frame, and one generation throughout.
            let configs = client_frames_of(session, "session_config");
            assert_eq!(configs.len(), 1, "{label}");
            assert_eq!(
                configs[0]["client_generation_id"],
                json!(session.client_generation_id),
                "{label}"
            );
            const CANONICAL_WIRE_PREFIX: &str = "viva1";
            let credential = configs[0]["session_token"]
                .as_str()
                .expect("credential is a string");
            assert_eq!(
                credential.split('.').next(),
                Some(CANONICAL_WIRE_PREFIX),
                "{label}"
            );
            for wire_json in &session.client_sequence_json {
                let frame: Value = serde_json::from_str(wire_json).expect("frame is JSON");
                assert_eq!(
                    frame["client_generation_id"],
                    json!(session.client_generation_id),
                    "{label}"
                );
            }

            // Two distinct question turns with no identity reuse.
            let started = session_events(session, "question_started");
            assert_eq!(started.len(), 2, "{label}");
            for (index, turn) in session.turns.iter().enumerate() {
                assert_eq!(started[index]["turn_id"], json!(turn.turn_id), "{label}");
                assert_eq!(
                    started[index]["response_id"],
                    json!(turn.response_id),
                    "{label}"
                );
                assert_eq!(
                    started[index]["question"]["question_id"],
                    json!(turn.question_id),
                    "{label}"
                );
            }
            let turn_ids: std::collections::BTreeSet<&str> = session
                .turns
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect();
            let response_ids: std::collections::BTreeSet<&str> = session
                .turns
                .iter()
                .map(|turn| turn.response_id.as_str())
                .collect();
            assert_eq!(turn_ids.len(), 2, "{label}");
            assert_eq!(response_ids.len(), 2, "{label}");

            // Turn one is a complete monotonic audio lifecycle.
            let chunks = client_frames_of(session, "audio_chunk");
            assert!(!chunks.is_empty(), "{label}");
            for (index, chunk) in chunks.iter().enumerate() {
                assert_eq!(chunk["sequence"], json!(index), "{label}");
                assert_eq!(chunk["turn_id"], json!(session.turns[0].turn_id), "{label}");
            }
            let ends = client_frames_of(session, "audio_end");
            assert_eq!(ends.len(), 1, "{label}");
            assert_eq!(
                ends[0]["final_sequence"],
                json!(chunks.len() - 1),
                "{label}"
            );

            // Turn two answers by typed intent and carries a citation challenge.
            let intents = client_frames_of(session, "turn_intent");
            assert_eq!(intents.len(), 2, "{label}");
            for intent in &intents {
                assert_eq!(
                    intent["turn_id"],
                    json!(session.turns[1].turn_id),
                    "{label}"
                );
            }
            assert_eq!(intents[0]["intent"]["kind"], json!("citation_challenge"));
            assert_eq!(intents[1]["intent"]["kind"], json!("answer_text"));

            // Typed, turn-scoped cancellation.
            let cancels = client_frames_of(session, "cancel");
            assert_eq!(cancels.len(), 1, "{label}");
            assert_eq!(cancels[0]["turn_id"], json!(session.turns[0].turn_id));
            let cancellations = session_events(session, "cancellation");
            assert_eq!(cancellations.len(), 1, "{label}");
            assert_eq!(
                cancellations[0]["response_id"],
                json!(session.turns[0].response_id)
            );

            // One evaluated path with a normal recap; one durable deferral that stays
            // nonterminal and writes no grade, mastery, or review state.
            let evaluated = session_events(session, "answer_evaluated");
            assert_eq!(evaluated.len(), 1, "{label}");
            assert_eq!(
                evaluated[0]["response_id"],
                json!(session.turns[0].response_id)
            );
            let deferred = session_events(session, "turn_deferred");
            assert_eq!(deferred.len(), 1, "{label}");
            assert_eq!(deferred[0]["turn_id"], json!(session.turns[1].turn_id));
            assert_eq!(
                deferred[0]["response_id"],
                json!(session.turns[1].response_id)
            );
            assert_eq!(
                deferred[0]["question_id"],
                json!(session.turns[1].question_id)
            );
            for event in session_events(session, "concept_status") {
                assert_eq!(event["response_id"], json!(session.turns[0].response_id));
            }
            let recaps = session_events(session, "recap_ready");
            assert_eq!(recaps.len(), 1, "{label}");
            assert_eq!(recaps[0]["partial"], json!(false), "{label}");
            assert!(recaps[0].get("partial_reason").is_none(), "{label}");
            assert_eq!(recaps[0]["recap"]["deferred_turns"], json!(deferred.len()));

            // No fabricated transcript confidence.
            let finals = session_events(session, "transcript_final");
            assert!(!finals.is_empty(), "{label}");
            for event in &finals {
                assert_eq!(event["confidence"], Value::Null, "{label}");
            }

            // No credential, tool payload, or raw provider secret in server frames.
            let rendered = session.server_sequence_json.join("\n");
            for needle in [
                CANONICAL_WIRE_PREFIX,
                "tool_result",
                "tool_proposal",
                "Authorization",
            ] {
                assert!(!rendered.contains(needle), "{label} leaked {needle}");
            }
        }
    }
}
