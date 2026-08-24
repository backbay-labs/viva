use agent_domain::{
    AnswerEvaluation, AudioFrame, BrainEvent, BrainProviderError, ConceptStatus, ManuscriptIntent,
    RealtimeBrainCapabilities, SessionConfig, StudyQuestion, StudySessionPhase, StudySessionRecap,
    StudySourceReference, StudyStoreBackend, StudyStoreCapabilities, TerminalSessionReason,
    ToolResult,
};
use serde::{Deserialize, Serialize};

pub const VIVA_VOICE_PROTOCOL_VERSION: u32 = 5;
pub const VIVA_VOICE_SAMPLE_RATE_HZ: u32 = 24_000;
pub const VIVA_VOICE_INPUT_ENCODING: &str = "pcm_s16le";
pub const VIVA_VOICE_MAX_TEXT_FRAME_BYTES: usize = 64 * 1024;
pub const VIVA_VOICE_MAX_BINARY_FRAME_BYTES: usize = 256 * 1024;

/// Alias of the existing 24 kHz voice constant; one literal source.
pub const VIVA_AUDIO_SAMPLE_RATE_HZ: u32 = VIVA_VOICE_SAMPLE_RATE_HZ;
pub const VIVA_AUDIO_MAX_CHUNK_SAMPLES: usize = 4_096;
/// Mono `pcm_s16le` is two bytes per sample.
pub const VIVA_AUDIO_MAX_CHUNK_BYTES: usize = 8_192;
/// The 45-second bound on one browser turn.
pub const VIVA_AUDIO_MAX_TURN_SAMPLES: usize = 1_080_000;
pub const VIVA_AUDIO_MAX_TURN_BYTES: usize = 2_160_000;

// The locked v5 audio constants are written as literals so both language
// contracts read identically. This compile-time block keeps the literals
// self-consistent in production builds, not only under `cargo test`.
const _: () = {
    assert!(VIVA_AUDIO_MAX_CHUNK_BYTES == VIVA_AUDIO_MAX_CHUNK_SAMPLES * 2);
    assert!(VIVA_AUDIO_MAX_TURN_SAMPLES == 45 * VIVA_AUDIO_SAMPLE_RATE_HZ as usize);
    assert!(VIVA_AUDIO_MAX_TURN_BYTES == VIVA_AUDIO_MAX_TURN_SAMPLES * 2);
    assert!(VIVA_AUDIO_MAX_CHUNK_BYTES < VIVA_VOICE_MAX_TEXT_FRAME_BYTES);
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    SessionConfig {
        version: u32,
        session: SessionConfig,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_generation_id: Option<String>,
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
    Text {
        version: u32,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_generation_id: Option<String>,
    },
    ToolResult {
        version: u32,
        result: ToolResult,
    },
    Cancel {
        version: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_generation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    Stop {
        version: u32,
    },
}

impl ClientFrame {
    pub fn version(&self) -> u32 {
        match self {
            Self::SessionConfig { version, .. }
            | Self::AudioChunk { version, .. }
            | Self::AudioEnd { version, .. }
            | Self::Text { version, .. }
            | Self::ToolResult { version, .. }
            | Self::Cancel { version, .. }
            | Self::Stop { version } => *version,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReadyFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub version: u32,
    pub sample_rate_hz: u32,
    pub input_encoding: String,
    pub brain: RealtimeBrainCapabilities,
    pub store: StudyStoreCapabilities,
}

impl ReadyFrame {
    pub fn new() -> Self {
        Self {
            frame_type: "ready".to_owned(),
            version: VIVA_VOICE_PROTOCOL_VERSION,
            sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
            input_encoding: VIVA_VOICE_INPUT_ENCODING.to_owned(),
            brain: default_ready_brain(),
            store: default_ready_store(),
        }
    }
}

impl Default for ReadyFrame {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Ready {
        version: u32,
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

    #[derive(Deserialize)]
    struct FullSessionFixture {
        client: Vec<ClientFrame>,
        server: Vec<ServerFrame>,
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

        let end = fixture.client.get(2).expect("audio end frame exists");
        assert_eq!(
            serde_json::to_value(end).expect("serializes"),
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

        assert!(matches!(
            fixture.client.first(),
            Some(ClientFrame::SessionConfig { .. })
        ));
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

        assert!(matches!(
            fixture.client.first(),
            Some(ClientFrame::SessionConfig { .. })
        ));
        assert!(matches!(
            fixture.client.get(1),
            Some(ClientFrame::AudioChunk { sequence: 0, .. })
        ));
        assert!(matches!(
            fixture.client.get(2),
            Some(ClientFrame::AudioEnd {
                final_sequence: 0,
                ..
            })
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
        let session_config = match fixture.client.first().expect("client frame exists") {
            ClientFrame::SessionConfig { session, .. } => session.clone(),
            other => panic!("expected session_config, got {other:?}"),
        };
        let answer_text = match fixture.client.get(1).expect("answer frame exists") {
            ClientFrame::Text { text, .. } => text.clone(),
            other => panic!("expected text frame, got {other:?}"),
        };

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
        let session_config = match fixture.client.first().expect("client frame exists") {
            ClientFrame::SessionConfig {
                session,
                client_generation_id,
                ..
            } => {
                // The real WebSocket path moves the frame-level generation onto the
                // domain config (`ws.rs`, authorized initial session config), so a
                // session's question response ids carry it. This in-process harness
                // must apply the same assignment or it silently diverges from the
                // server it is asserting against.
                let mut session = session.clone();
                session.client_generation_id = client_generation_id.clone();
                session
            }
            other => panic!("expected session_config, got {other:?}"),
        };
        let (audio_frame, audio_generation_id) =
            match fixture.client.get(1).expect("audio chunk frame exists") {
                ClientFrame::AudioChunk {
                    frame,
                    client_generation_id,
                    ..
                } => (frame.clone(), client_generation_id.clone()),
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
        let session_config = match fixture.client.first().expect("client frame exists") {
            ClientFrame::SessionConfig { session, .. } => session.clone(),
            other => panic!("expected session_config, got {other:?}"),
        };

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

    /// Frames only the WebSocket boundary produces: the post-release completion
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
}
