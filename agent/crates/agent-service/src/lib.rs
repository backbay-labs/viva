#![forbid(unsafe_code)]

mod app;
mod config;
mod protocol;
mod ws;

pub use app::{
    build_router, AppState, VoiceDrainSignal, VoiceEvidenceRecorder, VoiceUsageRecorder, WsTimeouts,
};
pub use config::{
    build_brain, build_study_store, validate_runtime_store_preflight, FailureControlConfig,
    FailureControlScenario, RealtimeProvider, ServiceConfig, ServiceConfigError, VoiceLimitConfig,
    VoiceWsAccess,
};
pub use protocol::{
    classify_voice_termination, negotiate_voice_protocol_version, parse_client_frame_json,
    parse_server_frame_json, ClientFrame, ServerFrame, VivaServerEvent, VoiceProtocolAdvertisement,
    VoiceProtocolDiagnostic, VoiceProtocolDiagnosticCode, VoiceStructuredErrorTerminality,
    VoiceTermination, VoiceTerminationInput, VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS,
    VIVA_VOICE_BYTES_PER_SAMPLE, VIVA_VOICE_CHANNELS, VIVA_VOICE_INPUT_ENCODING,
    VIVA_VOICE_MAX_TEXT_FRAME_BYTES, VIVA_VOICE_MAX_TURN_SECONDS, VIVA_VOICE_PROTOCOL_VERSION,
    VIVA_VOICE_SAMPLE_RATE_HZ, VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, VOICE_DEFERRAL_REASONS,
    VOICE_NORMAL_CLOSE_CODE, VOICE_PROTOCOL_ADVERTISEMENT, VOICE_SERIALIZATION_FALLBACK_FRAME,
};
