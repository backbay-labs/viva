use agent_adapters::cartesia_gemini::{
    gemini_request, viva_tool_declarations, CartesiaGeminiBrain, CartesiaGeminiConfig,
    FakeCartesiaGeminiRuntime, FakeRuntimeInterrupt, FakeSessionScenario, GeminiConfig, InkConfig,
    SonicConfig, ThinkingLevel,
};
use agent_domain::{
    AnswerAttemptEnvelope, AnswerEvaluation, AudioFrame, AuthorizedStudySession, BrainEvent,
    BrainInput, ConceptStatus, ManuscriptEmphasis, ManuscriptEntityKind, ManuscriptIntent,
    ManuscriptRegister, PortError, RealtimeBrain, RealtimeSession, SessionConfig, SessionId,
    StudyMemoryStore, StudyMode, StudyQuestion, StudySessionRecap, StudySourceReference,
    StudyStoreCapabilities, StudyStoreWriteCounts, ToolProposal, VivaToolExecutor,
    VoiceUsageRecord,
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::{
    sync::oneshot,
    time::{timeout, Duration},
};

const FAKE_INK_INTERIM_TRANSCRIPT: &str = "received 4 PCM16 bytes";
const FAKE_INK_FINAL_TRANSCRIPT: &str = "NADH donates electrons to the electron transport chain.";

#[test]
fn adapter_defaults_are_viva_native_and_live_keys_are_explicit() {
    let config = CartesiaGeminiConfig::default();

    assert!(config.missing_live_keys());
    assert!(!config.provider_zero_data_retention_confirmed());
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
fn manuscript_intent_tool_schema_exposes_semantic_fields_only() {
    let tools = viva_tool_declarations();
    let declaration = tools
        .iter()
        .find(|tool| tool["name"] == "emit_manuscript_intent")
        .expect("missing manuscript intent tool declaration");
    let parameters = &declaration["parameters"];
    let branches = parameters["anyOf"]
        .as_array()
        .expect("manuscript intent branch schemas");

    assert_eq!(branches.len(), 3);
    let entity_branch = branches
        .iter()
        .find(|branch| branch["properties"]["type"]["enum"][0] == "entity_intent")
        .expect("entity intent branch");
    assert_eq!(
        entity_branch["required"],
        json!(["type", "entity_id", "entity_kind", "register", "emphasis"])
    );
    assert_eq!(
        entity_branch["properties"]["entity_kind"]["enum"],
        json!(["concept", "source"])
    );
    let marginalia_branch = branches
        .iter()
        .find(|branch| branch["properties"]["type"]["enum"][0] == "marginalia_intent")
        .expect("marginalia intent branch");
    assert_eq!(
        marginalia_branch["required"],
        json!([
            "type",
            "marginalia_id",
            "anchor_entity_id",
            "register",
            "emphasis"
        ])
    );
    for branch in branches {
        let properties = branch["properties"]
            .as_object()
            .expect("manuscript intent branch properties");
        assert_eq!(branch["additionalProperties"], false);
        assert!(properties.contains_key("type"));
        assert!(properties.contains_key("register"));
        assert!(properties.contains_key("emphasis"));
    }
    for forbidden in ["x", "y", "color", "css", "markup", "draw", "pixels"] {
        assert!(branches.iter().all(|branch| !branch["properties"]
            .as_object()
            .expect("branch properties")
            .contains_key(forbidden)));
    }
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
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let capabilities = CartesiaGeminiBrain::new(
        CartesiaGeminiConfig {
            cartesia_api_key: "cartesia-key".to_owned(),
            gemini: GeminiConfig {
                api_key: "gemini-key".to_owned(),
                ..GeminiConfig::default()
            },
            ..CartesiaGeminiConfig::default()
        },
        store,
    )
    .capabilities();

    assert_eq!(capabilities.provider, "cartesia_gemini");
    assert!(capabilities.configured);
    assert!(!capabilities.selectable);
    assert!(!capabilities.live_runtime);
}

#[test]
fn cartesia_gemini_brain_becomes_selectable_only_with_explicit_live_runtime_gate() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let capabilities = CartesiaGeminiBrain::new(
        CartesiaGeminiConfig {
            cartesia_api_key: "cartesia-key".to_owned(),
            gemini: GeminiConfig {
                api_key: "gemini-key".to_owned(),
                ..GeminiConfig::default()
            },
            live_runtime_enabled: true,
            cartesia_zero_data_retention_enabled: true,
            gemini_zero_data_retention_approved: true,
            ..CartesiaGeminiConfig::default()
        },
        store,
    )
    .capabilities();

    assert_eq!(capabilities.provider, "cartesia_gemini");
    assert!(capabilities.configured);
    assert!(capabilities.selectable);
    assert!(capabilities.live_runtime);
}

#[test]
fn cartesia_gemini_brain_requires_zero_retention_confirmation_for_live_selection() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let capabilities = CartesiaGeminiBrain::new(
        CartesiaGeminiConfig {
            cartesia_api_key: "cartesia-key".to_owned(),
            gemini: GeminiConfig {
                api_key: "gemini-key".to_owned(),
                ..GeminiConfig::default()
            },
            live_runtime_enabled: true,
            ..CartesiaGeminiConfig::default()
        },
        store,
    )
    .capabilities();

    assert_eq!(capabilities.provider, "cartesia_gemini");
    assert!(capabilities.configured);
    assert!(!capabilities.selectable);
    assert!(!capabilities.live_runtime);
}

#[test]
fn cartesia_gemini_brain_rejects_placeholder_keys_even_when_live_runtime_gate_is_set() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let capabilities = CartesiaGeminiBrain::new(
        CartesiaGeminiConfig {
            cartesia_api_key: "viva-release-check-cartesia-placeholder-key".to_owned(),
            gemini: GeminiConfig {
                api_key: "viva-release-check-gemini-placeholder-key".to_owned(),
                ..GeminiConfig::default()
            },
            live_runtime_enabled: true,
            cartesia_zero_data_retention_enabled: true,
            gemini_zero_data_retention_approved: true,
            ..CartesiaGeminiConfig::default()
        },
        store,
    )
    .capabilities();

    assert_eq!(capabilities.provider, "cartesia_gemini");
    assert!(capabilities.configured);
    assert!(!capabilities.selectable);
    assert!(!capabilities.live_runtime);
}

#[tokio::test]
async fn cartesia_gemini_brain_open_reaches_shared_no_network_runner_gate() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let brain = CartesiaGeminiBrain::new(
        CartesiaGeminiConfig {
            cartesia_api_key: "cartesia-key".to_owned(),
            gemini: GeminiConfig {
                api_key: "gemini-key".to_owned(),
                ..GeminiConfig::default()
            },
            cartesia_zero_data_retention_enabled: true,
            gemini_zero_data_retention_approved: true,
            ..CartesiaGeminiConfig::default()
        },
        store.clone(),
    );

    let error = match brain.open(fixture_session_config()).await {
        Ok(_) => panic!("live Cartesia/Gemini brain unexpectedly opened"),
        Err(error) => error,
    };

    assert!(error
        .to_string()
        .contains("shared Cartesia/Gemini runner is wired"));
    assert!(!error.to_string().contains("without a study-memory store"));
    assert!(store.snapshot().sessions.is_empty());
    assert!(!brain.capabilities().selectable);
}

#[tokio::test]
async fn cartesia_gemini_brain_open_authorizes_explicit_live_runtime_without_network_until_audio() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let brain = CartesiaGeminiBrain::new(
        CartesiaGeminiConfig {
            cartesia_api_key: "cartesia-key".to_owned(),
            gemini: GeminiConfig {
                api_key: "gemini-key".to_owned(),
                ..GeminiConfig::default()
            },
            live_runtime_enabled: true,
            cartesia_zero_data_retention_enabled: true,
            gemini_zero_data_retention_approved: true,
            ..CartesiaGeminiConfig::default()
        },
        store.clone(),
    );

    let mut session = brain
        .open(fixture_session_config())
        .await
        .expect("explicit live runtime gate should authorize opening the session");

    assert!(brain.capabilities().selectable);
    assert!(brain.capabilities().live_runtime);
    assert_eq!(store.snapshot().sessions.len(), 1);
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
    session.input.send(BrainInput::Stop).await.unwrap();
}

#[tokio::test]
async fn cartesia_gemini_brain_open_rejects_placeholder_keys_before_network_or_store_writes() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let brain = CartesiaGeminiBrain::new(
        CartesiaGeminiConfig {
            cartesia_api_key: "viva-release-check-cartesia-placeholder-key".to_owned(),
            gemini: GeminiConfig {
                api_key: "viva-release-check-gemini-placeholder-key".to_owned(),
                ..GeminiConfig::default()
            },
            live_runtime_enabled: true,
            ..CartesiaGeminiConfig::default()
        },
        store.clone(),
    );

    let error = match brain.open(fixture_session_config()).await {
        Ok(_) => panic!("placeholder Cartesia/Gemini keys unexpectedly opened"),
        Err(error) => error,
    };

    assert!(error
        .to_string()
        .contains("live Cartesia/Gemini keys must be real provider credentials"));
    assert!(store.snapshot().sessions.is_empty());
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
    let mut saw_manuscript_intent = false;
    let mut saw_audio = false;
    let mut saw_recap = false;
    for _ in 0..16 {
        match next_event(&mut session).await {
            BrainEvent::AnswerEvaluated { evaluation, .. } => {
                assert_eq!(evaluation.answer_text, FAKE_INK_FINAL_TRANSCRIPT);
                saw_evaluation = true;
            }
            BrainEvent::ManuscriptIntent {
                response_id,
                intent:
                    ManuscriptIntent::Entity {
                        entity_id,
                        entity_kind: ManuscriptEntityKind::Concept,
                        register: ManuscriptRegister::Correcting,
                        emphasis: ManuscriptEmphasis::Marked,
                    },
            } => {
                assert_eq!(response_id, "response-1");
                assert_eq!(entity_id, "nadh");
                saw_manuscript_intent = true;
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
        if saw_evaluation && saw_manuscript_intent && saw_audio && saw_recap {
            break;
        }
    }

    assert!(saw_evaluation);
    assert!(saw_manuscript_intent);
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
async fn fake_runtime_persists_client_generation_id_on_answer_attempts() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());
    let mut first_config = fixture_session_config();
    first_config.client_generation_id = Some("back_forward_restore-2".to_owned());
    let mut session = runtime.open(first_config).await.unwrap();

    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::SessionPhase {
            phase: agent_domain::StudySessionPhase::Ready
        }
    ));
    let first_response_id = "response-1-generation-back_forward_restore-2";
    assert!(matches!(
        next_event(&mut session).await,
        BrainEvent::QuestionStarted { response_id, .. } if response_id == first_response_id
    ));
    session
        .input
        .send(BrainInput::TextWithMetadata {
            text: "NADH donates electrons.".to_owned(),
            client_generation_id: Some("back_forward_restore-2".to_owned()),
        })
        .await
        .unwrap();

    for _ in 0..16 {
        if matches!(
            next_event(&mut session).await,
            BrainEvent::RecapReady { .. }
        ) {
            break;
        }
    }

    let snapshot = store.snapshot();
    assert_eq!(snapshot.answer_attempts.len(), 1);
    assert_eq!(snapshot.answer_attempts[0].response_id, first_response_id);
    assert_eq!(
        snapshot.answer_attempts[0]
            .envelope
            .client_generation_id
            .as_deref(),
        Some("back_forward_restore-2"),
    );

    let mut second_config = fixture_session_config();
    second_config.client_generation_id = Some("token_refresh-3".to_owned());
    let mut refreshed_session = runtime.open(second_config).await.unwrap();
    assert!(matches!(
        next_event(&mut refreshed_session).await,
        BrainEvent::SessionPhase {
            phase: agent_domain::StudySessionPhase::Ready
        }
    ));
    let second_response_id = "response-1-generation-token_refresh-3";
    assert!(matches!(
        next_event(&mut refreshed_session).await,
        BrainEvent::QuestionStarted { response_id, .. } if response_id == second_response_id
    ));
    refreshed_session
        .input
        .send(BrainInput::TextWithMetadata {
            text: "NADH donates electrons again.".to_owned(),
            client_generation_id: Some("token_refresh-3".to_owned()),
        })
        .await
        .unwrap();

    for _ in 0..16 {
        if matches!(
            next_event(&mut refreshed_session).await,
            BrainEvent::RecapReady { .. }
        ) {
            break;
        }
    }

    let snapshot = store.snapshot();
    let response_ids = snapshot
        .answer_attempts
        .iter()
        .map(|attempt| attempt.response_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(response_ids, vec![first_response_id, second_response_id]);
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
    expect_fake_interim_delta(&mut session, "response-1").await;
    expect_fake_final_transcript(&mut session, "response-1").await;
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
    assert_single_pending_attempt(&inner_store.snapshot(), "response-1");

    let _ = release_answer.send(());
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    let snapshot = inner_store.snapshot();
    assert_single_pending_attempt(&snapshot, "response-1");
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
async fn fake_runtime_records_attempt_envelope_before_evaluation_commit() {
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
    expect_fake_interim_delta(&mut session, "response-1").await;
    expect_fake_final_transcript(&mut session, "response-1").await;
    timeout(Duration::from_secs(2), answer_started)
        .await
        .unwrap()
        .unwrap();

    let snapshot = inner_store.snapshot();
    assert_eq!(
        snapshot.answer_attempts.len(),
        1,
        "the privacy-safe answer attempt envelope must be durable before evaluation commits"
    );
    let persisted = serde_json::to_string(&snapshot.answer_attempts).unwrap();
    assert!(!persisted.contains(FAKE_INK_FINAL_TRANSCRIPT));
    assert!(!persisted.contains("(spoken answer)"));

    let _ = release_answer.send(());
}

#[tokio::test]
async fn fake_runtime_session_emits_interim_delta_but_evaluates_only_final_transcript() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());
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

    let mut saw_interim_delta = false;
    let mut saw_final_transcript = false;
    let mut saw_final_evaluation = false;
    for _ in 0..12 {
        match next_event(&mut session).await {
            BrainEvent::TranscriptDelta { response_id, text } => {
                if response_id == "response-1" {
                    assert_eq!(text, FAKE_INK_INTERIM_TRANSCRIPT);
                    saw_interim_delta = true;
                }
            }
            BrainEvent::TranscriptFinal {
                response_id, text, ..
            } => {
                if response_id == "response-1" {
                    assert_eq!(text, FAKE_INK_FINAL_TRANSCRIPT);
                    saw_final_transcript = true;
                }
            }
            BrainEvent::AnswerEvaluated {
                response_id,
                evaluation,
            } => {
                if response_id == "response-1" {
                    assert_eq!(evaluation.answer_text, FAKE_INK_FINAL_TRANSCRIPT);
                    saw_final_evaluation = true;
                }
            }
            _ => {}
        }
        if saw_interim_delta && saw_final_transcript && saw_final_evaluation {
            break;
        }
    }

    assert!(saw_interim_delta);
    assert!(saw_final_transcript);
    assert!(saw_final_evaluation);
    assert_eq!(store.snapshot().answer_attempts.len(), 1);
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
    expect_fake_interim_delta(&mut session, "response-1").await;
    expect_fake_final_transcript(&mut session, "response-1").await;
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
    let mut saw_new_interim = false;
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
            BrainEvent::TranscriptDelta { response_id, text } => {
                if response_id == "response-2" {
                    assert_eq!(text, FAKE_INK_INTERIM_TRANSCRIPT);
                    saw_new_interim = true;
                }
            }
            BrainEvent::TranscriptFinal {
                response_id, text, ..
            } => {
                if response_id == "response-2" {
                    assert_eq!(text, FAKE_INK_FINAL_TRANSCRIPT);
                    saw_new_transcript = true;
                }
            }
            BrainEvent::AnswerEvaluated {
                response_id,
                evaluation,
            } => {
                if response_id == "response-2" {
                    assert_eq!(evaluation.answer_text, FAKE_INK_FINAL_TRANSCRIPT);
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
            && saw_new_interim
            && saw_new_transcript
            && saw_new_evaluation
            && saw_new_audio
            && saw_new_recap
        {
            break;
        }
    }

    assert!(saw_old_cancel);
    assert!(saw_new_interim);
    assert!(saw_new_transcript);
    assert!(saw_new_evaluation);
    assert!(saw_new_audio);
    assert!(saw_new_recap);
    let _ = release_answer.send(());
    let snapshot = inner_store.snapshot();
    assert_eq!(snapshot.answer_attempts.len(), 2);
    assert!(snapshot
        .answer_attempts
        .iter()
        .any(|attempt| attempt.response_id == "response-1" && attempt.evaluation.is_none()));
    assert!(snapshot
        .answer_attempts
        .iter()
        .any(|attempt| attempt.response_id == "response-2" && attempt.evaluation.is_some()));
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

    assert!(events.iter().any(|event| matches!(
        event,
        BrainEvent::TranscriptDelta { text, .. } if text == FAKE_INK_INTERIM_TRANSCRIPT
    )));
    assert!(events.iter().all(|event| !matches!(
        event,
        BrainEvent::ResponseTranscriptDelta { text, .. } if text == FAKE_INK_INTERIM_TRANSCRIPT
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        BrainEvent::TranscriptFinal { text, .. } if text == FAKE_INK_FINAL_TRANSCRIPT
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        BrainEvent::AnswerEvaluated { evaluation, .. }
            if evaluation.answer_text == FAKE_INK_FINAL_TRANSCRIPT
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        BrainEvent::ManuscriptIntent {
            response_id,
            intent: ManuscriptIntent::Entity {
                entity_id,
                entity_kind: ManuscriptEntityKind::Concept,
                register: ManuscriptRegister::Correcting,
                emphasis: ManuscriptEmphasis::Marked,
            },
        } if response_id == "fake-cartesia-gemini-response-1" && entity_id == "nadh"
    )));
    assert!(events.iter().all(|event| !matches!(
        event,
        BrainEvent::AnswerEvaluated { evaluation, .. }
            if evaluation.answer_text == FAKE_INK_INTERIM_TRANSCRIPT
    )));
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
async fn fake_runtime_drops_invalid_gemini_manuscript_intent_without_blocking_v1_events() {
    let (store, session) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());

    let report = runtime
        .replay_audio_turn_with_interrupt(
            session,
            AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]),
            FakeRuntimeInterrupt::MalformedGeminiManuscriptIntent,
        )
        .await
        .unwrap();

    assert!(report
        .events
        .iter()
        .all(|event| !matches!(event, BrainEvent::ManuscriptIntent { .. })));
    assert!(report
        .events
        .iter()
        .any(|event| matches!(event, BrainEvent::AnswerEvaluated { .. })));
    assert!(report
        .events
        .iter()
        .any(|event| matches!(event, BrainEvent::AudioDelta { .. })));
    assert_eq!(store.snapshot().answer_attempts.len(), 1);
}

#[tokio::test]
async fn fake_runtime_drops_unauthorized_gemini_manuscript_intent_without_blocking_v1_events() {
    let (store, session) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());

    let report = runtime
        .replay_audio_turn_with_interrupt(
            session,
            AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]),
            FakeRuntimeInterrupt::UnauthorizedGeminiManuscriptIntent,
        )
        .await
        .unwrap();

    assert!(report
        .events
        .iter()
        .all(|event| !matches!(event, BrainEvent::ManuscriptIntent { .. })));
    assert!(report
        .events
        .iter()
        .any(|event| matches!(event, BrainEvent::AnswerEvaluated { .. })));
    assert!(report
        .events
        .iter()
        .any(|event| matches!(event, BrainEvent::AudioDelta { .. })));
    assert_eq!(store.snapshot().answer_attempts.len(), 1);
}

#[tokio::test]
async fn fake_runtime_falls_back_to_v1_events_when_gemini_omits_manuscript_intent() {
    let (store, session) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store.clone());

    let report = runtime
        .replay_audio_turn_with_interrupt(
            session,
            AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]),
            FakeRuntimeInterrupt::NoGeminiManuscriptIntent,
        )
        .await
        .unwrap();

    assert!(report
        .events
        .iter()
        .all(|event| !matches!(event, BrainEvent::ManuscriptIntent { .. })));
    assert!(report
        .events
        .iter()
        .any(|event| matches!(event, BrainEvent::AnswerEvaluated { .. })));
    assert!(report
        .events
        .iter()
        .any(|event| matches!(event, BrainEvent::AudioDelta { .. })));
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
    assert_single_pending_attempt(&store.snapshot(), "fake-cartesia-gemini-response-1");
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
        BrainEvent::TranscriptFinal {
            response_id, text, ..
        } if response_id == "fake-cartesia-gemini-session-response-1"
            && text == FAKE_INK_FINAL_TRANSCRIPT
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
    assert_single_pending_attempt(
        &inner_store.snapshot(),
        "fake-cartesia-gemini-session-response-1",
    );
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
    assert_single_pending_attempt(
        &inner_store.snapshot(),
        "fake-cartesia-gemini-session-response-1",
    );
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
        BrainEvent::TranscriptFinal {
            response_id, text, ..
        } if response_id == "fake-cartesia-gemini-session-response-1"
            && text == FAKE_INK_FINAL_TRANSCRIPT
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

#[tokio::test]
async fn schedule_review_rejects_model_due_at_authority() {
    let (store, session_config) = fixture_store_and_session().await;
    let executor = VivaToolExecutor::new(
        store,
        AuthorizedStudySession::from_config(&session_config).unwrap(),
    );
    let bad = ToolProposal::new(
        "schedule_review_item",
        json!({
            "study_set_id": "biology-midterm",
            "voice_session_id": "voice-session-1",
            "concept_id": "atp-synthase",
            "status": "shaky",
            "due_at": "2099-01-01T00:00:00Z"
        }),
    );

    let error = executor.execute("response-1", bad).await.unwrap_err();

    assert!(error
        .to_string()
        .contains("due_at is not an authoritative tool argument"));
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

fn assert_single_pending_attempt(snapshot: &data::InMemoryStudyState, response_id: &str) {
    assert_eq!(snapshot.answer_attempts.len(), 1);
    let attempt = &snapshot.answer_attempts[0];
    assert_eq!(attempt.response_id, response_id);
    assert_eq!(attempt.envelope.response_id, response_id);
    assert!(attempt.evaluation.is_none());
    assert!(attempt.envelope.answer_digest_hmac.is_none());
    let persisted = serde_json::to_string(&snapshot.answer_attempts).unwrap();
    assert!(!persisted.contains(FAKE_INK_FINAL_TRANSCRIPT));
    assert!(!persisted.contains("(spoken answer)"));
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

    async fn record_answer_attempt_envelope(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_answer_attempt_envelope(user_id, study_set_id, voice_session_id, envelope)
            .await
    }

    async fn record_answer_evaluation(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
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
            .record_answer_evaluation(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                evaluation,
            )
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
        response_id: &str,
        concept_id: &str,
        status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        self.inner
            .record_concept_status(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                status,
            )
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
        response_id: &str,
        recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, response_id, recap)
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

async fn expect_fake_interim_delta(session: &mut RealtimeSession, expected_response_id: &str) {
    match next_event(session).await {
        BrainEvent::TranscriptDelta { response_id, text } => {
            assert_eq!(response_id, expected_response_id);
            assert_eq!(text, FAKE_INK_INTERIM_TRANSCRIPT);
        }
        event => panic!("expected fake interim transcript delta, got {event:?}"),
    }
}

async fn expect_fake_final_transcript(session: &mut RealtimeSession, expected_response_id: &str) {
    match next_event(session).await {
        BrainEvent::TranscriptFinal {
            response_id, text, ..
        } => {
            assert_eq!(response_id, expected_response_id);
            assert_eq!(text, FAKE_INK_FINAL_TRANSCRIPT);
        }
        event => panic!("expected fake final transcript, got {event:?}"),
    }
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
