use agent_domain::{
    AnswerEvaluation, AudioFrame, BrainEvent, BrainProviderError, ConceptStatus, SessionConfig,
    StudyQuestion, StudySessionPhase, StudySessionRecap, StudySourceReference, ToolResult,
};
use serde::{Deserialize, Serialize};

pub const VIVA_VOICE_PROTOCOL_VERSION: u32 = 1;
pub const VIVA_VOICE_SAMPLE_RATE_HZ: u32 = 24_000;
pub const VIVA_VOICE_INPUT_ENCODING: &str = "pcm_s16le";
pub const VIVA_VOICE_MAX_TEXT_FRAME_BYTES: usize = 64 * 1024;
pub const VIVA_VOICE_MAX_BINARY_FRAME_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    SessionConfig {
        version: u32,
        session: SessionConfig,
    },
    Audio {
        version: u32,
        frame: AudioFrame,
    },
    Text {
        version: u32,
        text: String,
    },
    ToolResult {
        version: u32,
        result: ToolResult,
    },
    Cancel {
        version: u32,
    },
    Stop {
        version: u32,
    },
}

impl ClientFrame {
    pub fn version(&self) -> u32 {
        match self {
            Self::SessionConfig { version, .. }
            | Self::Audio { version, .. }
            | Self::Text { version, .. }
            | Self::ToolResult { version, .. }
            | Self::Cancel { version }
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
}

impl ReadyFrame {
    pub fn new() -> Self {
        Self {
            frame_type: "ready".to_owned(),
            version: VIVA_VOICE_PROTOCOL_VERSION,
            sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
            input_encoding: VIVA_VOICE_INPUT_ENCODING.to_owned(),
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
    RecapReady {
        response_id: String,
        recap: StudySessionRecap,
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
            BrainEvent::SessionPhase { phase } => Self::SessionPhase { phase },
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
            BrainEvent::RecapReady { response_id, recap } => {
                Self::RecapReady { response_id, recap }
            }
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
            BrainEvent::Error(BrainProviderError { source, message }) => {
                Self::StructuredError { source, message }
            }
            BrainEvent::InputSpeechStarted => Self::SessionPhase {
                phase: StudySessionPhase::Listening,
            },
            BrainEvent::InputSpeechStopped => Self::SessionPhase {
                phase: StudySessionPhase::Thinking,
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
            },
            BrainEvent::ResponseCompleted { .. } => Self::SessionPhase {
                phase: StudySessionPhase::Feedback,
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
        Self::Ready {
            version: VIVA_VOICE_PROTOCOL_VERSION,
            sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
            input_encoding: VIVA_VOICE_INPUT_ENCODING.to_owned(),
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
            | BrainEvent::QuestionStarted { .. }
            | BrainEvent::TranscriptDelta { .. }
            | BrainEvent::TranscriptFinal { .. }
            | BrainEvent::AnswerEvaluated { .. }
            | BrainEvent::SourceReference { .. }
            | BrainEvent::ConceptStatus { .. }
            | BrainEvent::RecapReady { .. }
            | BrainEvent::AudioDelta { .. }
            | BrainEvent::ResponseAudio { .. }
            | BrainEvent::Error(_)
            | BrainEvent::InputSpeechStarted
            | BrainEvent::InputSpeechStopped
            | BrainEvent::ResponseCancelled
            | BrainEvent::ResponseCancelledFor { .. }
            | BrainEvent::ResponseStarted { .. }
            | BrainEvent::ResponseTextStarted { .. }
            | BrainEvent::ResponseCompleted { .. } => Some(Self::event(event)),
            BrainEvent::Usage(_)
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
                "type": "audio",
                "version": 1,
                "frame": { "pcm16_base64": "AQIDBA==" }
            })
        );
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
            Some(ClientFrame::Audio { .. })
        ));
        assert_eq!(fixture.server.first(), Some(&ServerFrame::ready()));
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
        for _ in 0..11 {
            push_next_browser_frame(&mut actual, &mut session).await;
        }
        session
            .input
            .send(BrainInput::CancelResponse)
            .await
            .expect("sends cancel");
        push_next_browser_frame(&mut actual, &mut session).await;

        assert_eq!(actual, fixture.server);
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
            ClientFrame::SessionConfig { session, .. } => session.clone(),
            other => panic!("expected session_config, got {other:?}"),
        };
        let audio_frame = match fixture.client.get(1).expect("audio frame exists") {
            ClientFrame::Audio { frame, .. } => frame.clone(),
            other => panic!("expected audio frame, got {other:?}"),
        };

        let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
        let brain = agent_adapters::cartesia_gemini::FakeCartesiaGeminiRuntime::new(store.clone());
        let mut session = brain.open(session_config).await.expect("opens");
        let mut actual = vec![ServerFrame::ready()];
        for _ in 0..2 {
            push_next_browser_frame(&mut actual, &mut session).await;
        }
        session
            .input
            .send(BrainInput::Audio(audio_frame))
            .await
            .expect("sends audio");
        for _ in 0..11 {
            push_next_browser_frame(&mut actual, &mut session).await;
        }
        session
            .input
            .send(BrainInput::CancelResponse)
            .await
            .expect("sends cancel");
        push_next_browser_frame(&mut actual, &mut session).await;

        assert_eq!(actual, fixture.server);
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
}
