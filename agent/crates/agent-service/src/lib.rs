#![forbid(unsafe_code)]

mod app;
mod config;
mod protocol;
mod ws;

pub use app::{build_router, AppState, VoiceEvidenceRecorder, VoiceUsageRecorder, WsTimeouts};
pub use config::{
    build_brain, build_study_store, RealtimeProvider, ServiceConfig, ServiceConfigError,
    VoiceWsAccess,
};
pub use protocol::{
    ClientFrame, ReadyFrame, ServerFrame, VivaServerEvent, VIVA_VOICE_INPUT_ENCODING,
    VIVA_VOICE_MAX_BINARY_FRAME_BYTES, VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
    VIVA_VOICE_PROTOCOL_VERSION, VIVA_VOICE_SAMPLE_RATE_HZ,
};
