use agent_adapters::cartesia_gemini::{
    gemini_request, viva_tool_declarations, CartesiaGeminiBrain, CartesiaGeminiConfig,
    FakeCartesiaGeminiRuntime, FakeRuntimeInterrupt, FakeSessionScenario, GeminiConfig, InkConfig,
    SonicConfig, ThinkingLevel,
};
use agent_domain::{
    AnswerEvaluation, AudioFrame, BrainEvent, BrainInput, ConceptStatus, PortError, RealtimeBrain,
    RealtimeSession, SessionConfig, SessionId, StudyMemoryStore, StudyMode, StudyQuestion,
    StudySessionRecap, StudySourceReference, StudyStoreCapabilities, StudyStoreWriteCounts,
    VoiceUsageRecord,
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::{
    sync::oneshot,
    time::{timeout, Duration},
};

#[test]
fn adapter_defaults_are_viva_native_and_live_keys_are_explicit() {
    let config = CartesiaGeminiConfig::default();

    assert!(config.missing_live_keys());
    assert!(config
        .gemini
        .system_instruction
        .contains("source-grounded oral study coach"));
}

#[test]
fn fake_provider_request_json_matches_viva_tool_contract() {
    let gemini = GeminiConfig {
        thinking_level: ThinkingLevel::parse("minimal"),
        ..GeminiConfig::default()
    };

    let request = gemini_request(
        &gemini,
        vec![json!({
            "role": "user",
            "parts": [{ "text": "Ask one question from Lecture 5." }],
        })],
        &viva_tool_declarations(),
    );

    assert_eq!(
        request["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "MINIMAL"
    );
    assert_eq!(
        request["tools"][0]["functionDeclarations"][1]["name"],
        "evaluate_spoken_answer"
    );
}

#[test]
fn provider_urls_keep_cartesia_realtime_defaults() {
    let ink = InkConfig::default().websocket_endpoint();
    let sonic = SonicConfig::default().websocket_endpoint();

    assert!(ink.contains("wss://api.cartesia.ai/stt/turns/websocket"));
    assert!(ink.contains("sample_rate=24000"));
    assert!(sonic.contains("wss://api.cartesia.ai/tts/websocket"));
    assert!(sonic.contains("cartesia_version=2026-03-01"));
}

#[test]
fn cartesia_gemini_brain_stays_unselectable_until_live_runtime_is_proven() {
    let capabilities = CartesiaGeminiBrain::new(CartesiaGeminiConfig {
        cartesia_api_key: "cartesia-key".to_owned(),
        gemini: GeminiConfig {
            api_key: "gemini-key".to_owned(),
            ..GeminiConfig::default()
        },
        ..CartesiaGeminiConfig::default()
    })
    .capabilities();

    assert_eq!(capabilities.provider, "cartesia_gemini");
    assert!(capabilities.configured);
    assert!(!capabilities.selectable);
    assert!(!capabilities.live_runtime);
}

#[tokio::test]
async fn cartesia_gemini_brain_open_reaches_shared_no_network_runner_gate() {
    let brain = CartesiaGeminiBrain::new(CartesiaGeminiConfig {
        cartesia_api_key: "cartesia-key".to_owned(),
        gemini: GeminiConfig {
            api_key: "gemini-key".to_owned(),
            ..GeminiConfig::default()
        },
        ..CartesiaGeminiConfig::default()
    });

    let error = match brain.open(fixture_session_config()).await {
        Ok(_) => panic!("live Cartesia/Gemini brain unexpectedly opened"),
        Err(error) => error,
    };

    assert!(error
        .to_string()
        .contains("shared Cartesia/Gemini runner is wired"));
    assert!(!brain.capabilities().selectable);
}

#[tokio::test]
async fn fake_runtime_is_selectable_realtime_brain_without_live_keys() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());
    let capabilities = runtime.capabilities();

    assert_eq!(capabilities.provider, "fake_cartesia_gemini");
    assert!(capabilities.configured);
    assert!(capabilities.selectable);
    assert!(!capabilities.live_runtime);

    let mut session = runtime.open(fixture_session_config()).await.unwrap();
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::SessionPhase {
            phase: agent_domain::StudySessionPhase::Ready
        }
    ));
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::QuestionStarted { response_id, .. } if response_id == "response-1"
    ));
    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();

    let mut saw_evaluation = false;
    let mut saw_audio = false;
    let mut saw_recap = false;
    for _ in 0..12 {
        match next_event(&mut session).await {
            BrainEvent::AnswerEvaluated { evaluation, .. } => {
                assert_eq!(evaluation.answer_text, "received 4 PCM16 bytes");
                saw_evaluation = true;
            }
            BrainEvent::AudioDelta { frame, .. } => {
                assert_eq!(frame.pcm16_bytes(), [1, 2, 3, 4]);
                saw_audio = true;
            }
            BrainEvent::RecapReady { recap, .. } => {
                assert_eq!(recap.voice_session_id, "voice-session-1");
                saw_recap = true;
            }
            _ => {}
        }
    }

    assert!(saw_evaluation);
    assert!(saw_audio);
    assert!(saw_recap);
    let snapshot = store.snapshot();
    assert_eq!(snapshot.sessions.len(), 1);
    assert_eq!(snapshot.answer_attempts.len(), 1);
    assert_eq!(snapshot.concept_statuses.len(), 1);
    assert_eq!(snapshot.review_items.len(), 1);
    assert_eq!(snapshot.recaps.len(), 1);
}

#[tokio::test]
async fn fake_runtime_open_cancel_aborts_active_tool_write_before_commit() {
    let inner_store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let (store, answer_started, release_answer) = BlockingAnswerStore::new(inner_store.clone());
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime.open(fixture_session_config()).await.unwrap();

    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::SessionPhase {
            phase: agent_domain::StudySessionPhase::Ready
        }
    ));
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::QuestionStarted { response_id, .. } if response_id == "response-1"
    ));
    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();
    assert_eq!(
        next_event(&mut session).await,
        BrainEvent::InputSpeechStarted
    );
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::TranscriptFinal { response_id, .. } if response_id == "response-1"
    ));
    timeout(Duration::from_secs(2), answer_started)
        .await
        .unwrap()
        .unwrap();

    session
        .input
        .send(BrainInput::CancelResponse)
        .await
        .unwrap();
    let mut saw_cancel = false;
    for _ in 0..4 {
        if matches!(
            next_event(&mut session).await,
            BrainEvent::ResponseCancelledFor { response_id } if response_id == "response-1"
        ) {
            saw_cancel = true;
            break;
        }
    }
    assert!(saw_cancel);
    assert_eq!(inner_store.snapshot().answer_attempts.len(), 0);

    let _ = release_answer.send(());
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    let snapshot = inner_store.snapshot();
    assert_eq!(snapshot.answer_attempts.len(), 0);
    assert_eq!(snapshot.concept_statuses.len(), 0);
    assert_eq!(snapshot.review_items.len(), 0);
    assert_eq!(snapshot.recaps.len(), 0);
    assert!(remaining_events(&mut session)
        .await
        .iter()
        .all(|event| !matches!(
            event,
            BrainEvent::AnswerEvaluated { .. }
                | BrainEvent::ConceptStatus { .. }
                | BrainEvent::AudioDelta { .. }
                | BrainEvent::RecapReady { .. }
        )));
}

#[tokio::test]
async fn fake_runtime_open_barge_in_cancels_old_response_and_accepts_new_turn() {
    let inner_store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let (store, answer_started, release_answer) = BlockingAnswerStore::new(inner_store.clone());
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime.open(fixture_session_config()).await.unwrap();

    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::SessionPhase {
            phase: agent_domain::StudySessionPhase::Ready
        }
    ));
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::QuestionStarted { response_id, .. } if response_id == "response-1"
    ));
    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();
    assert_eq!(
        next_event(&mut session).await,
        BrainEvent::InputSpeechStarted
    );
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::TranscriptFinal { response_id, .. } if response_id == "response-1"
    ));
    timeout(Duration::from_secs(2), answer_started)
        .await
        .unwrap()
        .unwrap();

    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            5_u8, 6, 7, 8,
        ])))
        .await
        .unwrap();

    let mut saw_old_cancel = false;
    let mut saw_new_transcript = false;
    let mut saw_new_evaluation = false;
    let mut saw_new_audio = false;
    let mut saw_new_recap = false;
    for _ in 0..18 {
        match next_event(&mut session).await {
            BrainEvent::ResponseCancelledFor { response_id } => {
                if response_id == "response-1" {
                    saw_old_cancel = true;
                }
            }
            BrainEvent::TranscriptFinal {
                response_id, text, ..
            } => {
                if response_id == "response-2" {
                    assert_eq!(text, "received 4 PCM16 bytes");
                    saw_new_transcript = true;
                }
            }
            BrainEvent::AnswerEvaluated {
                response_id,
                evaluation,
            } => {
                if response_id == "response-2" {
                    assert_eq!(evaluation.answer_text, "received 4 PCM16 bytes");
                    saw_new_evaluation = true;
                }
            }
            BrainEvent::AudioDelta { response_id, frame } => {
                if response_id == "response-2" {
                    assert_eq!(frame.pcm16_bytes(), [1, 2, 3, 4]);
                    saw_new_audio = true;
                }
            }
            BrainEvent::RecapReady { response_id, recap } => {
                if response_id == "response-2" {
                    assert_eq!(recap.voice_session_id, "voice-session-1");
                    saw_new_recap = true;
                }
            }
            _ => {}
        }
        if saw_old_cancel
            && saw_new_transcript
            && saw_new_evaluation
            && saw_new_audio
            && saw_new_recap
        {
            break;
        }
    }

    assert!(saw_old_cancel);
    assert!(saw_new_transcript);
    assert!(saw_new_evaluation);
    assert!(saw_new_audio);
    assert!(saw_new_recap);
    let _ = release_answer.send(());
    let snapshot = inner_store.snapshot();
    assert_eq!(snapshot.answer_attempts.len(), 1);
    assert_eq!(snapshot.concept_statuses.len(), 1);
    assert_eq!(snapshot.review_items.len(), 1);
    assert_eq!(snapshot.recaps.len(), 1);
}

#[tokio::test]
async fn fake_runtime_replays_provider_shaped_pipeline_without_live_selection() {
    let (store, session) = fixture_store_and_session().await;

    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());
    let events = runtime
        .replay_audio_turn(session, AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]))
        .await
        .unwrap();

    assert!(events
        .iter()
        .any(|event| matches!(event, BrainEvent::TranscriptFinal { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, BrainEvent::AnswerEvaluated { .. })));
    assert!(events.iter().any(|event| matches!(
        event,
        BrainEvent::Usage(usage)
            if usage.text_input_tokens == 20 && usage.text_output_tokens == 10
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        BrainEvent::AudioDelta { frame, .. } if frame.pcm16_bytes() == [1, 2, 3, 4]
    )));
    assert_eq!(store.snapshot().answer_attempts.len(), 1);
    assert!(CartesiaGeminiConfig::default().missing_live_keys());
}

#[tokio::test]
async fn fake_runtime_cancel_during_gemini_tool_call_suppresses_tool_writes() {
    let (store, session) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());

    let report = runtime
        .replay_audio_turn_with_interrupt(
            session,
            AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]),
            FakeRuntimeInterrupt::CancelDuringGeminiToolCall,
        )
        .await
        .unwrap();

    assert_eq!(report.stopped_stage, Some("gemini_tool_call_pre_commit"));
    assert!(report
        .events
        .iter()
        .any(|event| matches!(event, BrainEvent::ResponseCancelledFor { .. })));
    assert!(report
        .events
        .iter()
        .all(|event| !matches!(event, BrainEvent::AnswerEvaluated { .. })));
    assert_eq!(store.snapshot().answer_attempts.len(), 0);
}

#[tokio::test]
async fn fake_runtime_barge_in_during_sonic_audio_suppresses_tts_audio() {
    let (store, session) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());

    let report = runtime
        .replay_audio_turn_with_interrupt(
            session,
            AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]),
            FakeRuntimeInterrupt::BargeInDuringSonicAudio,
        )
        .await
        .unwrap();

    assert_eq!(report.stopped_stage, Some("sonic_audio"));
    assert!(report
        .events
        .iter()
        .any(|event| matches!(event, BrainEvent::ResponseCancelledFor { .. })));
    assert!(report
        .events
        .iter()
        .all(|event| !matches!(event, BrainEvent::AudioDelta { .. })));
    assert_eq!(store.snapshot().answer_attempts.len(), 1);
}

#[tokio::test]
async fn fake_runtime_writer_failure_before_audio_returns_error_without_live_selection() {
    let (store, session) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store);

    let error = runtime
        .replay_audio_turn_with_interrupt(
            session,
            AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]),
            FakeRuntimeInterrupt::WriterFailureBeforeSonicAudio,
        )
        .await
        .unwrap_err();

    assert!(error
        .to_string()
        .contains("fake browser writer failed before Sonic audio"));
    assert!(CartesiaGeminiConfig::default().missing_live_keys());
}

#[tokio::test]
async fn fake_runtime_session_cancel_during_gemini_tool_call_suppresses_tool_writes() {
    let (inner_store, session_config) = fixture_store_and_session().await;
    let (store, answer_started, release_answer) = BlockingAnswerStore::new(inner_store.clone());
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime
        .open_scripted_session(
            session_config,
            FakeSessionScenario::CancelDuringGeminiToolCall,
        )
        .unwrap();

    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();
    assert_eq!(
        next_event(&mut session).await,
        BrainEvent::InputSpeechStarted
    );
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::TranscriptFinal { response_id, .. }
            if response_id == "fake-cartesia-gemini-session-response-1"
    ));
    timeout(Duration::from_secs(2), answer_started)
        .await
        .unwrap()
        .unwrap();

    session
        .input
        .send(BrainInput::CancelResponse)
        .await
        .unwrap();
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::ResponseCancelledFor { response_id }
            if response_id == "fake-cartesia-gemini-session-response-1"
    ));
    assert_eq!(inner_store.snapshot().answer_attempts.len(), 0);
    assert!(remaining_events(&mut session)
        .await
        .iter()
        .all(|event| !matches!(
            event,
            BrainEvent::AnswerEvaluated { .. } | BrainEvent::AudioDelta { .. }
        )));
    drop(release_answer);
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    assert_eq!(inner_store.snapshot().answer_attempts.len(), 0);
}

#[tokio::test]
async fn fake_runtime_session_barge_in_during_sonic_audio_suppresses_old_audio() {
    let (store, session_config) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());
    let mut session = runtime
        .open_scripted_session(session_config, FakeSessionScenario::BargeInDuringSonicAudio)
        .unwrap();

    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();
    assert_eq!(
        next_event(&mut session).await,
        BrainEvent::InputSpeechStarted
    );
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::TranscriptFinal { response_id, .. }
            if response_id == "fake-cartesia-gemini-session-response-1"
    ));
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::Usage(usage)
            if usage.text_input_tokens == 20 && usage.text_output_tokens == 10
    ));
    assert_eq!(store.snapshot().answer_attempts.len(), 1);

    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            5_u8, 6, 7, 8,
        ])))
        .await
        .unwrap();
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::ResponseCancelledFor { response_id }
            if response_id == "fake-cartesia-gemini-session-response-1"
    ));
    assert!(remaining_events(&mut session)
        .await
        .iter()
        .all(|event| !matches!(event, BrainEvent::AudioDelta { .. })));
}

#[tokio::test]
async fn fake_runtime_scripted_session_task_guard_aborts_provider_task_on_drop() {
    let (_store, session_config) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(Arc::new(data::InMemoryStudyStore::new()));
    let mut session = runtime
        .open_scripted_session(
            session_config,
            FakeSessionScenario::CancelDuringGeminiToolCall,
        )
        .unwrap();
    let guard = session.task_guard.take().unwrap();

    drop(guard);

    assert!(timeout(Duration::from_secs(2), session.events.recv())
        .await
        .unwrap()
        .is_none());
}

async fn fixture_store_and_session() -> (Arc<data::InMemoryStudyStore>, SessionConfig) {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let session = fixture_session_config();
    store.record_voice_session(&session).await.unwrap();
    (store, session)
}

fn fixture_session_config() -> SessionConfig {
    SessionConfig {
        session_id: Some(SessionId::new("voice-session-1")),
        user_id: Some("user-1".to_owned()),
        study_set_id: Some("biology-midterm".to_owned()),
        mode: Some(StudyMode::Quiz),
        ..SessionConfig::default()
    }
}

struct BlockingAnswerStore {
    inner: Arc<data::InMemoryStudyStore>,
    answer_started: Mutex<Option<oneshot::Sender<()>>>,
    release_answer: Mutex<Option<oneshot::Receiver<()>>>,
}

impl BlockingAnswerStore {
    fn new(
        inner: Arc<data::InMemoryStudyStore>,
    ) -> (Arc<Self>, oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (answer_started_tx, answer_started_rx) = oneshot::channel();
        let (release_answer_tx, release_answer_rx) = oneshot::channel();
        (
            Arc::new(Self {
                inner,
                answer_started: Mutex::new(Some(answer_started_tx)),
                release_answer: Mutex::new(Some(release_answer_rx)),
            }),
            answer_started_rx,
            release_answer_tx,
        )
    }
}

#[async_trait::async_trait]
impl StudyMemoryStore for BlockingAnswerStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        self.inner.capabilities()
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.inner.write_counts()
    }

    async fn record_voice_session(&self, config: &SessionConfig) -> Result<(), PortError> {
        self.inner.record_voice_session(config).await
    }

    async fn study_context(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        self.inner.study_context(user_id, study_set_id).await
    }

    async fn active_question(
        &self,
        user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        self.inner.active_question(user_id, study_set_id).await
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        evaluation: AnswerEvaluation,
    ) -> Result<serde_json::Value, PortError> {
        if let Some(answer_started) = self
            .answer_started
            .lock()
            .expect("answer started lock poisoned")
            .take()
        {
            let _ = answer_started.send(());
        }
        let release_answer = self
            .release_answer
            .lock()
            .expect("release answer lock poisoned")
            .take();
        if let Some(release_answer) = release_answer {
            let _ = release_answer.await;
        }
        self.inner
            .record_answer_evaluation(user_id, study_set_id, voice_session_id, evaluation)
            .await
    }

    async fn source_reference(
        &self,
        user_id: &str,
        study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        self.inner
            .source_reference(user_id, study_set_id, source_id)
            .await
    }

    async fn record_concept_status(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        self.inner
            .record_concept_status(user_id, study_set_id, voice_session_id, concept_id, status)
            .await
    }

    async fn schedule_review_item(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        concept_id: &str,
        due_at: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .schedule_review_item(user_id, study_set_id, voice_session_id, concept_id, due_at)
            .await
    }

    async fn record_recap(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, recap)
            .await
    }

    async fn record_voice_usage(&self, event: VoiceUsageRecord) -> Result<(), PortError> {
        self.inner.record_voice_usage(event).await
    }
}

async fn next_event(session: &mut RealtimeSession) -> BrainEvent {
    timeout(Duration::from_secs(2), session.events.recv())
        .await
        .unwrap()
        .unwrap()
}

async fn remaining_events(session: &mut RealtimeSession) -> Vec<BrainEvent> {
    let mut events = Vec::new();
    loop {
        match timeout(Duration::from_millis(50), session.events.recv()).await {
            Ok(Some(event)) => events.push(event),
            Ok(None) | Err(_) => return events,
        }
    }
}
