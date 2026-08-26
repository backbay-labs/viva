#![forbid(unsafe_code)]

mod app;
mod config;
mod protocol;
mod ws;

pub use app::{
    begin_drain_and_wait, build_router, ActiveHandlerGuard, AppState, BackgroundWorkerGuard,
    DrainOutcome, RecorderStats, RuntimeDraining, VoiceDrainSignal, VoiceEvidenceRecorder,
    VoiceLimitState, VoiceRuntimeSnapshot, VoiceRuntimeTracker, VoiceUsageAggregate,
    VoiceUsageRecorder, WsTimeouts,
};
pub use config::{
    build_brain, build_study_store, validate_runtime_store_preflight, verify_session_token_at,
    AccessError, ExpectedSessionBinding, FailureControlConfig, FailureControlScenario, IpNetwork,
    IpNetworkError, OperatorAccess, ProjectionReadAccess, ProjectionRejection, RealtimeProvider,
    RecorderLimits, RedactedSecret, ServiceConfig, ServiceConfigError, SessionTokenClaims,
    SessionTokenError, TrustedProxyConfig, VoiceLimitConfig, VoiceWsAccess,
    EXPIRY_CLOCK_SKEW_SECONDS, VIVA_SESSION_TOKEN_HEADER,
};
pub use protocol::{
    classify_voice_termination, negotiate_voice_protocol_version, parse_client_frame_json,
    parse_server_frame_json, ClientFrame, ClientTurnIntent, ServerError, ServerFrame,
    VivaServerEvent, VoiceProtocolAdvertisement, VoiceProtocolDiagnostic,
    VoiceProtocolDiagnosticCode, VoiceServerErrorCode, VoiceStructuredErrorTerminality,
    VoiceTermination, VoiceTerminationInput, VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS,
    VIVA_VOICE_BYTES_PER_SAMPLE, VIVA_VOICE_CHANNELS, VIVA_VOICE_INPUT_ENCODING,
    VIVA_VOICE_MAX_TEXT_FRAME_BYTES, VIVA_VOICE_MAX_TURN_SECONDS, VIVA_VOICE_PROTOCOL_VERSION,
    VIVA_VOICE_SAMPLE_RATE_HZ, VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, VOICE_DEFERRAL_REASONS,
    VOICE_NORMAL_CLOSE_CODE, VOICE_PROTOCOL_ADVERTISEMENT, VOICE_SERIALIZATION_FALLBACK_FRAME,
};
