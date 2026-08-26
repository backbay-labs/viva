use agent_adapters::cartesia_gemini::{
    gemini_request, viva_tool_declarations, CartesiaGeminiBrain, CartesiaGeminiConfig,
    FakeCartesiaGeminiRuntime, FakeRuntimeInterrupt, FakeSessionScenario, GeminiConfig, InkConfig,
    SonicConfig, ThinkingLevel,
};
use agent_domain::{
    viva_max_submitted_answer_resolution, AnswerAttemptEnvelope, AnswerEvaluation, AudioFrame,
    AuthorizedStudySession, BrainEvent, BrainFailureClass, BrainFailureStage, BrainInput,
    ConceptStatus, ManuscriptEmphasis, ManuscriptEntityKind, ManuscriptIntent, ManuscriptRegister,
    PersistedTurnOutcome, PortError, ProgressionPolicyId, QuestionProgressionResult, RealtimeBrain,
    RealtimeSession, SessionConfig, SessionId, SessionLearningEvidence, StudyMemoryStore,
    StudyMode, StudyQuestion, StudySessionRecap, StudySourceReference, StudyStoreCapabilities,
    StudyStoreWriteCounts, StudyStoreWriteOutcome, TerminalSessionReason, ToolProposal,
    TurnOutcome, VivaToolExecutor, VoiceUsageRecord,
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
fn adapter_defaults_define_stage_deadlines_under_bac_510_turn_cap() {
    let config = CartesiaGeminiConfig::default();

    assert!(config.ink.stage_timeout > Duration::ZERO);
    assert!(config.gemini.stage_timeout > Duration::ZERO);
    assert!(config.sonic.stage_timeout > Duration::ZERO);
    assert!(config.tool_stage_timeout > Duration::ZERO);
    assert!(config.recap_stage_timeout > Duration::ZERO);
    let expected_live_path_budget = [
        config.ink.stage_timeout,
        config.gemini.stage_timeout.saturating_mul(2),
        config.tool_stage_timeout.saturating_mul(8),
        config.sonic.stage_timeout,
        config.recap_stage_timeout,
    ]
    .into_iter()
    .fold(Duration::ZERO, |total, duration| {
        total.saturating_add(duration)
    });
    assert_eq!(
        config.total_live_stage_deadline(),
        expected_live_path_budget
    );
    assert!(
        config
            .total_live_stage_deadline()
            .saturating_add(Duration::from_secs(1))
            <= viva_max_submitted_answer_resolution(),
        "live provider stage deadlines must leave terminal-emission slack inside the BAC-510 submitted-answer cap"
    );
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
    let store = learning_ready_store();
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
    let store = learning_ready_store();
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
    let store = learning_ready_store();
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
    let store = learning_ready_store();
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
    let store = learning_ready_store();
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

    // A closed live-runtime gate is an operator configuration fact: it is typed
    // at the startup stage and is never retried as a provider blip.
    let failure = error.failure();
    assert_eq!(
        failure.failure_class(),
        BrainFailureClass::ProviderAuthFailure
    );
    assert_eq!(failure.stage(), BrainFailureStage::Startup);
    assert!(!failure.retry_eligible());
    assert_eq!(failure.metadata(), "error_kind=live_runtime_gated");
    assert!(store.snapshot().sessions.is_empty());
    assert!(!brain.capabilities().selectable);
}

#[tokio::test]
async fn cartesia_gemini_brain_open_authorizes_explicit_live_runtime_without_network_until_audio() {
    let store = learning_ready_store();
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
    let store = learning_ready_store();
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

    let failure = error.failure();
    assert_eq!(
        failure.failure_class(),
        BrainFailureClass::ProviderAuthFailure
    );
    assert_eq!(failure.stage(), BrainFailureStage::ProviderAuth);
    assert!(!failure.retry_eligible());
    assert_eq!(failure.metadata(), "error_kind=placeholder_credentials");
    assert!(store.snapshot().sessions.is_empty());
    assert!(!brain.capabilities().selectable);
}

#[tokio::test]
async fn fake_runtime_is_selectable_realtime_brain_without_live_keys() {
    let store = learning_ready_store();
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
    for _ in 0..16 {
        let event = next_event(&mut session).await;
        let turn_completed = matches!(event, BrainEvent::ResponseCompleted { .. });
        match event {
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
            BrainEvent::RecapReady { .. } => {
                panic!("the session recap is published on Stop, not inside a turn");
            }
            _ => {}
        }
        if turn_completed {
            break;
        }
    }

    assert!(saw_evaluation);
    assert!(saw_manuscript_intent);
    assert!(saw_audio);
    // The recap is the session's fold, not the turn's, so it arrives on Stop.
    let closing = stop_and_drain(&mut session).await;
    let recap = closing
        .iter()
        .find_map(|event| match event {
            BrainEvent::RecapReady { recap, .. } => Some(recap.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("stopping the session publishes its recap: {closing:?}"));
    assert_eq!(recap.voice_session_id, "voice-session-1");
    // Mastery and scheduling are persisted inside one canonical turn outcome;
    // there is no separate adapter-driven status or review write any more.
    let snapshot = store.snapshot();
    assert_eq!(snapshot.sessions.len(), 1);
    assert_eq!(snapshot.answer_attempts.len(), 1);
    assert_eq!(snapshot.turn_outcomes.len(), 1);
    assert!(snapshot.concept_statuses.is_empty());
    assert_eq!(snapshot.review_schedule_decisions.len(), 1);
    assert_eq!(snapshot.review_items.len(), 1);
    assert_eq!(snapshot.recaps.len(), 1);
}

#[tokio::test]
async fn fake_runtime_persists_client_generation_id_on_answer_attempts() {
    let store = learning_ready_store();
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
            BrainEvent::ResponseCompleted { .. }
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

    // A refreshed token opens its own voice session, so it carries its own
    // D-02B progression cursor rather than resuming an exhausted one.
    let mut second_config = fixture_session_config();
    second_config.session_id = Some(SessionId::new("voice-session-2"));
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
            BrainEvent::ResponseCompleted { .. }
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
    let inner_store = learning_ready_store();
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
    let inner_store = learning_ready_store();
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
    let store = learning_ready_store();
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
    let inner_store = learning_ready_store();
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
    let mut saw_new_question = false;
    let mut saw_new_interim = false;
    let mut saw_new_transcript = false;
    let mut saw_new_evaluation = false;
    let mut saw_new_audio = false;
    for _ in 0..32 {
        match next_event(&mut session).await {
            BrainEvent::ResponseCancelledFor { response_id } => {
                if response_id == "response-1" {
                    saw_old_cancel = true;
                }
            }
            // `ADAPTER-02`: the replacement turn starts its own question, and it
            // does so before any other event bound to the replacement response.
            BrainEvent::QuestionStarted { response_id, .. } => {
                assert_eq!(response_id, "response-2");
                assert!(
                    !saw_new_interim && !saw_new_transcript && !saw_new_evaluation,
                    "the replacement question must start before the replacement turn speaks"
                );
                saw_new_question = true;
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
            BrainEvent::RecapReady { .. } => {
                panic!("the session recap is published on Stop, not inside a turn");
            }
            _ => {}
        }
        if saw_old_cancel
            && saw_new_question
            && saw_new_interim
            && saw_new_transcript
            && saw_new_evaluation
            && saw_new_audio
        {
            break;
        }
    }

    assert!(saw_old_cancel);
    assert!(saw_new_question);
    assert!(saw_new_interim);
    assert!(saw_new_transcript);
    assert!(saw_new_evaluation);
    assert!(saw_new_audio);
    let _ = release_answer.send(());
    // The session's one recap arrives when the learner stops, folded over both
    // the barged-in turn and the turn that replaced it.
    let closing = stop_and_drain(&mut session).await;
    assert!(
        closing.iter().any(|event| matches!(
            event,
            BrainEvent::RecapReady { recap, .. } if recap.voice_session_id == "voice-session-1"
        )),
        "stopping the session publishes its recap: {closing:?}"
    );
    let snapshot = inner_store.snapshot();
    assert_eq!(snapshot.answer_attempts.len(), 2);
    assert!(snapshot
        .answer_attempts
        .iter()
        .any(|attempt| attempt.response_id == "response-1" && attempt.evaluation.is_none()));
    assert!(snapshot
        .answer_attempts
        .iter()
        .any(|attempt| attempt.response_id == "response-2"));
    // Only the replacement turn produced a persisted outcome; the barged-in turn
    // was cancelled before its commit.
    assert_eq!(snapshot.turn_outcomes.len(), 1);
    assert_eq!(snapshot.turn_outcomes[0].response_id, "response-2");
    assert!(snapshot.concept_statuses.is_empty());
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
async fn fake_runtime_session_completes_after_correction_phase() {
    let (store, session_config) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime.open(session_config).await.unwrap();

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

    let mut saw_correction = false;
    for _ in 0..20 {
        match next_event(&mut session).await {
            BrainEvent::SessionPhase {
                phase: agent_domain::StudySessionPhase::Correction,
            } => {
                saw_correction = true;
            }
            BrainEvent::ResponseCompleted { response_id } => {
                assert_eq!(response_id, "response-1");
                assert!(
                    saw_correction,
                    "fake provider must not complete before correction finishes"
                );
                return;
            }
            BrainEvent::RecapReady { .. } => {
                panic!("fake provider emitted recap before response completion");
            }
            _ => {}
        }
    }

    panic!("fake provider did not emit response completion");
}

#[tokio::test]
async fn fake_runtime_reports_tool_source_failure_as_stage_failure() {
    let inner = learning_ready_store();
    let session = fixture_session_config();
    let _ = inner.record_voice_session(&session).await.unwrap();
    let store = Arc::new(FailStudyToolStore::source_after_question(inner));
    let runtime = FakeCartesiaGeminiRuntime::new(store);

    let mut realtime = runtime.open(session).await.unwrap();
    assert!(matches!(
        next_event(&mut realtime).await,
        BrainEvent::SessionPhase { .. }
    ));
    assert!(matches!(
        next_event(&mut realtime).await,
        BrainEvent::QuestionStarted { .. }
    ));
    realtime
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();

    let error = loop {
        match next_event(&mut realtime).await {
            BrainEvent::Error(error) => break error,
            BrainEvent::RecapReady { .. } => {
                panic!("source tool failure unexpectedly reached recap")
            }
            _ => {}
        }
    };
    let error_text = error.message.clone();
    let failure = error
        .failure
        .expect("provider error includes stage failure");

    assert_eq!(
        failure.failure_class(),
        BrainFailureClass::ToolExecutorFailure
    );
    assert_eq!(failure.stage(), BrainFailureStage::Tools);
    assert_eq!(
        failure.terminal_reason(),
        TerminalSessionReason::ToolExecutorFailure
    );
    assert!(failure.retry_eligible());
    assert_eq!(failure.provider(), "server");
    assert_eq!(failure.model(), "viva-tools");
    assert!(
        failure
            .metadata()
            .contains("tool=retrieve_source_reference"),
        "{failure:?}"
    );
    assert!(!error_text.contains("raw source excerpt"));
    assert!(!failure.metadata().contains("raw source excerpt"));
}

#[tokio::test]
async fn fake_runtime_reports_recap_failure_with_tool_executor_failure_class() {
    let inner = learning_ready_store();
    let session = fixture_session_config();
    let _ = inner.record_voice_session(&session).await.unwrap();
    let store = Arc::new(FailStudyToolStore::recap(inner));
    let runtime = FakeCartesiaGeminiRuntime::new(store);

    let mut realtime = runtime.open(session).await.unwrap();
    assert!(matches!(
        next_event(&mut realtime).await,
        BrainEvent::SessionPhase { .. }
    ));
    assert!(matches!(
        next_event(&mut realtime).await,
        BrainEvent::QuestionStarted { .. }
    ));
    realtime
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();

    // The recap stage runs when the learner stops, so the failure surfaces
    // there: the turn itself completes and publishes no recap.
    loop {
        match next_event(&mut realtime).await {
            BrainEvent::ResponseCompleted { .. } => break,
            BrainEvent::Error(error) => panic!("the turn itself must not fail: {error:?}"),
            BrainEvent::RecapReady { .. } => {
                panic!("recap tool failure unexpectedly emitted recap")
            }
            _ => {}
        }
    }
    realtime.input.send(BrainInput::Stop).await.ok();
    let error = loop {
        match next_event(&mut realtime).await {
            BrainEvent::Error(error) => break error,
            BrainEvent::RecapReady { .. } => {
                panic!("recap tool failure unexpectedly emitted recap")
            }
            event => {
                assert!(
                    !matches!(
                        event,
                        BrainEvent::SessionPhase {
                            phase: agent_domain::StudySessionPhase::Recap
                        }
                    ),
                    "a failed recap must not move the learner into the recap phase"
                );
            }
        }
    };
    let error_text = error.message.clone();
    let failure = error
        .failure
        .expect("provider error includes stage failure");

    assert_eq!(
        failure.failure_class(),
        BrainFailureClass::ToolExecutorFailure,
        "{failure:?}"
    );
    assert_eq!(failure.stage(), BrainFailureStage::Recap, "{failure:?}");
    assert_eq!(
        failure.terminal_reason(),
        TerminalSessionReason::ToolExecutorFailure
    );
    assert!(failure.retry_eligible());
    assert_eq!(failure.provider(), "server");
    assert_eq!(failure.model(), "viva-tools");
    assert!(failure.metadata().contains("tool=build_session_recap"));
    assert!(!error_text.contains("raw recap excerpt"));
    assert!(!failure.metadata().contains("raw recap excerpt"));
}

#[tokio::test]
async fn fake_runtime_omits_tools_on_final_gemini_pass() {
    let (store, session) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store);

    let events = runtime
        .replay_audio_turn(session, AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]))
        .await
        .expect("final Gemini pass should complete without advertising tools");

    assert!(
        events
            .iter()
            .any(|event| matches!(event, BrainEvent::AnswerEvaluated { .. })),
        "first Gemini pass should still execute the answer-evaluation tool"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, BrainEvent::ResponseTranscriptDelta { text, .. } if text.contains("proton gradient"))),
        "final Gemini pass should return text after function responses"
    );
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

    let failure = error.failure();
    assert_eq!(failure.provider(), "fake_cartesia_gemini");
    assert_eq!(
        failure.metadata(),
        "stage=fake_transport error_kind=writer_failed_before_audio"
    );
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

/// `LEARN-009`: a model that names a server-owned scheduling fact is refused
/// outright rather than quietly overruled, and the tool it would have steered no
/// longer exists at all.
#[tokio::test]
async fn schedule_review_rejects_model_due_at_authority() {
    let (store, session_config) = fixture_store_and_session().await;
    let executor = VivaToolExecutor::new(
        store,
        AuthorizedStudySession::from_config(&session_config).unwrap(),
        scripted_satisfying_evaluator(),
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

    assert!(
        error
            .to_string()
            .contains("is a server-owned review scheduling fact"),
        "{error}"
    );
}

/// A scripted evaluator for tests that never reach evaluation: it satisfies every
/// bound criterion, so no assertion below can depend on a provider's opinion.
fn scripted_satisfying_evaluator() -> Arc<dyn agent_domain::AnswerEvaluator> {
    struct SatisfyingEvaluator;

    #[async_trait::async_trait]
    impl agent_domain::AnswerEvaluator for SatisfyingEvaluator {
        async fn evaluate(
            &self,
            request: &agent_domain::EvaluationRequest,
        ) -> Result<agent_domain::EvaluationDecision, agent_domain::EvaluationError> {
            Ok(agent_domain::EvaluationDecision::Evaluated {
                assessments: request
                    .question
                    .rubric
                    .criteria
                    .iter()
                    .map(|criterion| agent_domain::CriterionAssessment {
                        criterion_id: criterion.criterion_id.clone(),
                        assessment: agent_domain::CriterionAssessmentKind::Satisfied,
                        confidence: 0.9,
                    })
                    .collect(),
                concise_feedback: "scripted evaluator verdict".to_owned(),
                retry_prompt: None,
            })
        }
    }

    Arc::new(SatisfyingEvaluator)
}

async fn fixture_store_and_session() -> (Arc<data::InMemoryStudyStore>, SessionConfig) {
    let store = learning_ready_store();
    let session = fixture_session_config();
    let _ = store.record_voice_session(&session).await.unwrap();
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

struct FailStudyToolStore {
    inner: Arc<data::InMemoryStudyStore>,
    source_reference_calls: Mutex<usize>,
    fail_source_after_question: bool,
    fail_recap: bool,
    fail_envelope: bool,
}

impl FailStudyToolStore {
    fn source_after_question(inner: Arc<data::InMemoryStudyStore>) -> Self {
        Self {
            inner,
            source_reference_calls: Mutex::new(0),
            fail_source_after_question: true,
            fail_recap: false,
            fail_envelope: false,
        }
    }

    fn recap(inner: Arc<data::InMemoryStudyStore>) -> Self {
        Self {
            inner,
            source_reference_calls: Mutex::new(0),
            fail_source_after_question: false,
            fail_recap: true,
            fail_envelope: false,
        }
    }

    /// The durable answer-attempt envelope write fails before any provider I/O.
    fn answer_attempt_envelope(inner: Arc<data::InMemoryStudyStore>) -> Self {
        Self {
            inner,
            source_reference_calls: Mutex::new(0),
            fail_source_after_question: false,
            fail_recap: false,
            fail_envelope: true,
        }
    }
}

#[async_trait::async_trait]
impl StudyMemoryStore for FailStudyToolStore {
    fn capabilities(&self) -> StudyStoreCapabilities {
        self.inner.capabilities()
    }

    fn write_counts(&self) -> StudyStoreWriteCounts {
        self.inner.write_counts()
    }

    async fn record_voice_session(
        &self,
        config: &SessionConfig,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
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
        if self.fail_envelope {
            return Err(PortError::durability(
                "answer_attempt_envelope",
                envelope.response_id.clone(),
                format!(
                    "commit refused by {ENVELOPE_STORE_DSN_MARKER} while writing {ENVELOPE_ANSWER_MARKER}"
                ),
            ));
        }
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
        let should_fail = self.fail_source_after_question && {
            let mut calls = self
                .source_reference_calls
                .lock()
                .expect("source reference calls lock poisoned");
            *calls += 1;
            // Call one is the executor's own question binding; call two is the
            // adapter's post-outcome retrieval, which is the one under test.
            *calls > 1
        };
        if should_fail {
            return Err(PortError::internal(
                "study_store",
                "voice-session-1",
                "raw source excerpt from adapter must not leak",
            ));
        }
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

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<agent_domain::ReviewSchedulingContextV1, PortError> {
        self.inner
            .review_scheduling_context(user_id, study_set_id, concept_id)
            .await
    }

    async fn persist_review_schedule_decision(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: agent_domain::ReviewScheduleDecisionV1,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .persist_review_schedule_decision(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                decision,
            )
            .await
    }

    async fn record_turn_outcome(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
        self.inner
            .record_turn_outcome(user_id, study_set_id, voice_session_id, outcome)
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
        if self.fail_recap {
            return Err(PortError::internal(
                "study_store",
                "voice-session-1",
                "raw recap excerpt from adapter must not leak",
            ));
        }
        self.inner
            .record_recap(user_id, study_set_id, voice_session_id, response_id, recap)
            .await
    }

    async fn record_voice_usage(
        &self,
        event: VoiceUsageRecord,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        self.inner.record_voice_usage(event).await
    }

    // Plan 04's learning seam delegates straight through: these fakes inject a
    // single named failure each and invent no learner fact of their own.
    async fn session_learning_evidence(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<SessionLearningEvidence, PortError> {
        self.inner
            .session_learning_evidence(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn select_next_question(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        self.inner
            .select_next_question(user_id, study_set_id, voice_session_id, response_id, policy)
            .await
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::AuthenticatedStudyProjectionV1, PortError> {
        self.inner
            .authenticated_study_projection(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn authorize_manuscript_intent(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        intent: &ManuscriptIntent,
    ) -> Result<(), PortError> {
        self.inner
            .authorize_manuscript_intent(user_id, study_set_id, voice_session_id, intent)
            .await
    }
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

    async fn record_voice_session(
        &self,
        config: &SessionConfig,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
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

    /// The durable answer write is the persisted turn outcome, so that is where
    /// a cancel racing the commit has to be observed.
    async fn record_turn_outcome(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
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
            .record_turn_outcome(user_id, study_set_id, voice_session_id, outcome)
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

    async fn review_scheduling_context(
        &self,
        user_id: &str,
        study_set_id: &str,
        concept_id: &str,
    ) -> Result<agent_domain::ReviewSchedulingContextV1, PortError> {
        self.inner
            .review_scheduling_context(user_id, study_set_id, concept_id)
            .await
    }

    async fn persist_review_schedule_decision(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        concept_id: &str,
        decision: agent_domain::ReviewScheduleDecisionV1,
    ) -> Result<serde_json::Value, PortError> {
        self.inner
            .persist_review_schedule_decision(
                user_id,
                study_set_id,
                voice_session_id,
                response_id,
                concept_id,
                decision,
            )
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

    async fn record_voice_usage(
        &self,
        event: VoiceUsageRecord,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        self.inner.record_voice_usage(event).await
    }

    // Plan 04's learning seam delegates straight through: these fakes inject a
    // single named failure each and invent no learner fact of their own.
    async fn session_learning_evidence(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<SessionLearningEvidence, PortError> {
        self.inner
            .session_learning_evidence(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn select_next_question(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        response_id: &str,
        policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        self.inner
            .select_next_question(user_id, study_set_id, voice_session_id, response_id, policy)
            .await
    }

    async fn authenticated_study_projection(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<agent_domain::AuthenticatedStudyProjectionV1, PortError> {
        self.inner
            .authenticated_study_projection(user_id, study_set_id, voice_session_id)
            .await
    }

    async fn authorize_manuscript_intent(
        &self,
        user_id: &str,
        study_set_id: &str,
        voice_session_id: &str,
        intent: &ManuscriptIntent,
    ) -> Result<(), PortError> {
        self.inner
            .authorize_manuscript_intent(user_id, study_set_id, voice_session_id, intent)
            .await
    }
}

async fn next_event(session: &mut RealtimeSession) -> BrainEvent {
    timeout(Duration::from_secs(2), session.events.recv())
        .await
        .unwrap()
        .unwrap()
}

/// End the session and collect everything it publishes on the way out.
///
/// The session recap is a fold over every outcome the session persisted, so it
/// is published exactly once, on `Stop`. A test that needs the recap ends the
/// session for it rather than waiting for a turn to produce one.
async fn stop_and_drain(session: &mut RealtimeSession) -> Vec<BrainEvent> {
    session.input.send(BrainInput::Stop).await.ok();
    let mut events = Vec::new();
    while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
        events.push(event);
    }
    events
}

async fn expect_fake_interim_delta(session: &mut RealtimeSession, expected_response_id: &str) {
    // An accepted turn enters `listening` through the Plan 06 phase machine
    // before any transcript exists, so that transition may precede the delta.
    let mut event = next_event(session).await;
    if matches!(
        event,
        BrainEvent::SessionPhase {
            phase: agent_domain::StudySessionPhase::Listening
        }
    ) {
        event = next_event(session).await;
    }
    match event {
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

/// Task 1 (`ADAPTER-01`): both fixture runtimes take their scheduling and recap
/// facts from Plan 04's persisted seam, never from an adapter-local date or from
/// where an expected term happens to appear in the answer.
#[tokio::test]
async fn fake_and_synthetic_runtimes_consume_learning_core_fixture_outcomes() {
    for runtime in ["fake", "synthetic"] {
        let store = learning_ready_store();
        let config = fixture_session_config();
        let mut session = match runtime {
            "fake" => FakeCartesiaGeminiRuntime::new(store.clone())
                .open(config)
                .await
                .expect("fake runtime opens"),
            _ => agent_adapters::SyntheticBrain::with_study_store(store.clone())
                .open(config)
                .await
                .expect("synthetic runtime opens"),
        };
        // Ready, then the first question.
        let _ = next_event(&mut session).await;
        let _ = next_event(&mut session).await;
        session
            .input
            .send(BrainInput::Text(
                "NADH donates electrons to the electron transport chain.".to_owned(),
            ))
            .await
            .expect("text input accepted");

        let mut events = Vec::new();
        while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
            let completed = matches!(event, BrainEvent::ResponseCompleted { .. });
            events.push(event);
            if completed {
                break;
            }
        }
        // The recap is a session-end projection in both runtimes, so end the
        // session and drain what teardown produces.
        session.input.send(BrainInput::Stop).await.ok();
        while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
            let terminal = matches!(
                event,
                BrainEvent::SessionPhase {
                    phase: agent_domain::StudySessionPhase::Recap
                }
            );
            events.push(event);
            if terminal {
                break;
            }
        }
        drop(session);

        let snapshot = store.snapshot();
        assert_eq!(
            snapshot.turn_outcomes.len(),
            1,
            "{runtime}: exactly one persisted outcome: {events:?}"
        );
        let outcome = &snapshot.turn_outcomes[0].outcome;

        // Every emitted concept status is a copy of a persisted transition.
        let emitted = events
            .iter()
            .filter_map(|event| match event {
                BrainEvent::ConceptStatus {
                    concept_id, status, ..
                } => Some((concept_id.clone(), status.clone())),
                _ => None,
            })
            .collect::<Vec<_>>();
        let persisted = match &outcome.resolution {
            agent_domain::TurnResolution::Evaluated {
                concept_transitions,
                ..
            } => concept_transitions
                .iter()
                .map(|transition| (transition.concept_id.clone(), transition.to_status.clone()))
                .collect::<Vec<_>>(),
            agent_domain::TurnResolution::Deferred { .. } => Vec::new(),
        };
        assert_eq!(emitted, persisted, "{runtime}: {events:?}");

        // Scheduling is the authoritative D-01 decision the store wrote, and the
        // recap copies exactly those dates. No fixed adapter-local date survives.
        assert_eq!(
            snapshot.review_schedule_decisions.len(),
            persisted.len(),
            "{runtime}: one authoritative decision per persisted transition"
        );
        let recap = events
            .iter()
            .find_map(|event| match event {
                BrainEvent::RecapReady { recap, .. } => Some(recap.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{runtime}: a recap is emitted: {events:?}"));
        assert_eq!(
            recap.schema,
            agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA,
            "{runtime}: the recap is the evidence-derived v2 recap"
        );
        for entry in &recap.review_schedule {
            assert!(
                snapshot.review_schedule_decisions.iter().any(|record| {
                    record.concept_id == entry.concept_id
                        && agent_domain::format_rfc3339_millis(record.decision.due_at)
                            == entry.due_at
                }),
                "{runtime}: recap review date {entry:?} is not an authoritative decision"
            );
        }
        let serialized = serde_json::to_string(&recap).expect("recap serializes");
        assert!(
            !serialized.contains("2026-06-"),
            "{runtime}: a fixed adapter-local review date leaked: {serialized}"
        );

        // The evaluated label is the server's derivation of the fixture
        // evaluator's criterion verdicts, never a term-position guess.
        if let agent_domain::TurnResolution::Evaluated { label, .. } = &outcome.resolution {
            let emitted_label = events
                .iter()
                .find_map(|event| match event {
                    BrainEvent::AnswerEvaluated { evaluation, .. } => {
                        Some(evaluation.label.clone())
                    }
                    _ => None,
                })
                .unwrap_or_else(|| panic!("{runtime}: an evaluation is emitted"));
            assert_eq!(
                emitted_label,
                match label {
                    agent_domain::EvaluationLabel::Strong => "strong",
                    agent_domain::EvaluationLabel::MostlyCorrect => "mostly correct",
                    agent_domain::EvaluationLabel::PartiallyCorrect => "partially correct",
                    agent_domain::EvaluationLabel::Vague => "vague",
                    agent_domain::EvaluationLabel::Wrong => "wrong",
                    agent_domain::EvaluationLabel::InsufficientEvidence => "insufficient evidence",
                },
                "{runtime}: the emitted label copies the persisted outcome"
            );
        }

        // The fixture evaluator's verdict pattern comes from the immutable
        // learning-core corpus, so the persisted assessments must be one of the
        // corpus's evaluated cases' patterns.
        let fixture: serde_json::Value =
            serde_json::from_str(LEARNING_CORE_TURN_OUTCOMES_V1).expect("fixture parses");
        if let agent_domain::TurnResolution::Evaluated { assessments, .. } = &outcome.resolution {
            let kinds = assessments
                .iter()
                .map(|assessment| {
                    serde_json::to_value(assessment.assessment)
                        .expect("kind serializes")
                        .as_str()
                        .expect("kind is a string")
                        .to_owned()
                })
                .collect::<Vec<_>>();
            let corpus_patterns = fixture["outcomes"]
                .as_object()
                .expect("outcomes object")
                .values()
                .filter_map(|case| case["resolution"]["assessments"].as_array())
                .map(|assessments| {
                    assessments
                        .iter()
                        .map(|assessment| {
                            assessment["assessment"]
                                .as_str()
                                .expect("kind is a string")
                                .to_owned()
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            assert!(
                corpus_patterns
                    .iter()
                    .any(|pattern| pattern.starts_with(&kinds[..]) || pattern == &kinds),
                "{runtime}: assessment pattern {kinds:?} is not derived from the learning-core corpus"
            );
        }
    }
}

const LEARNING_CORE_TURN_OUTCOMES_V1: &str =
    include_str!("../../../fixtures/learning-core/turn-outcomes-v1.json");

/// The seeded development study set publishes concept ids that its own question's
/// rubric does not name, so a graded turn needs the rubric's concept published
/// before the executor can bind a prior status to it.
fn learning_ready_store() -> Arc<data::InMemoryStudyStore> {
    let store = data::InMemoryStudyStore::seeded_fixture();
    let question = agent_domain::fixture_question();
    let mut concept_ids = vec![
        "oxidative-phosphorylation".to_owned(),
        "nadh".to_owned(),
        "atp-synthase".to_owned(),
        "cellular-respiration".to_owned(),
    ];
    for criterion in &question.rubric.criteria {
        if !concept_ids.contains(&criterion.concept_id) {
            concept_ids.push(criterion.concept_id.clone());
        }
        store.upsert_concept(data::ConceptRecord {
            study_set_id: "biology-midterm".to_owned(),
            concept_id: criterion.concept_id.clone(),
            label: "Oxidative phosphorylation".to_owned(),
            status: ConceptStatus::Review,
            source_span_id: criterion.source_id.clone(),
        });
    }
    // A session that takes two turns needs a second active question, or the
    // D-02B cursor legitimately reports the set exhausted after the first.
    let mut follow_up = question.clone();
    follow_up.question_id = "q-oxidative-phosphorylation-atp".to_owned();
    follow_up.prompt = "Explain what the proton gradient powers.".to_owned();
    store.upsert_question(data::StudyQuestionRecord {
        study_set_id: "biology-midterm".to_owned(),
        question: follow_up.clone(),
        active: true,
    });
    store.upsert_study_set(data::StudySetRecord {
        study_set_id: "biology-midterm".to_owned(),
        user_id: "user-1".to_owned(),
        title: "Biology Midterm".to_owned(),
        course: Some("Biology 201".to_owned()),
        ingestion_status: agent_domain::StudySetIngestionStatus::Ready,
        ingestion_error: None,
        concept_ids,
        question_ids: vec![question.question_id.clone(), follow_up.question_id.clone()],
    });
    Arc::new(store)
}

// ---------------------------------------------------------------------------
// Task 1 (`ADAPTER-01`): learning authority lives in the persisted Plan 04
// outcome.
//
// The store below is an adapter-owned in-test fake with real hand-derived
// behaviour: it persists an outcome the executor did not compute, so an adapter
// that spoke from its own derivation instead of from the returned outcome could
// not make any assertion here pass. Every path the adapter must no longer use
// fails closed and is counted.
//
// The fixture transports drive the same shared runner, the same
// `VivaToolExecutor`, and the same learning projection as a live session; only
// provider I/O is scripted.
// ---------------------------------------------------------------------------

const BIOLOGY_MARKERS: [&str; 4] = [
    "proton gradient",
    "ATP synthase",
    "oxidative-phosphorylation",
    "atp-synthase",
];

#[derive(Default)]
struct StoreCalls {
    record_concept_status: u32,
    legacy_review_writes: u32,
    record_answer_evaluation: u32,
    persist_review_schedule_decision: Vec<String>,
    recorded_recaps: u32,
    recorded_outcomes: Vec<TurnOutcome>,
}

struct FixtureOutcomeStore {
    questions: Vec<StudyQuestion>,
    sources: Vec<StudySourceReference>,
    persisted: Vec<TurnOutcome>,
    receipt_response_id: Option<String>,
    /// Response ids in the order the session first asked for a question, so a
    /// turn's question and its persisted outcome are always the same ordinal.
    turn_order: Mutex<Vec<String>>,
    calls: Mutex<StoreCalls>,
}

impl FixtureOutcomeStore {
    fn new(
        question: StudyQuestion,
        sources: Vec<StudySourceReference>,
        persisted: TurnOutcome,
    ) -> Self {
        Self::per_turn(vec![question], sources, vec![persisted])
    }

    /// A multi-turn variant: turn *n* is asked `questions[n]` and the store
    /// persists `persisted[n]` for it. Both vectors must be the same length.
    fn per_turn(
        questions: Vec<StudyQuestion>,
        sources: Vec<StudySourceReference>,
        persisted: Vec<TurnOutcome>,
    ) -> Self {
        assert_eq!(
            questions.len(),
            persisted.len(),
            "one persisted outcome per fixture question"
        );
        assert!(
            !questions.is_empty(),
            "a session asks at least one question"
        );
        Self {
            questions,
            sources,
            persisted,
            receipt_response_id: None,
            turn_order: Mutex::new(Vec::new()),
            calls: Mutex::new(StoreCalls::default()),
        }
    }

    fn with_receipt_response_id(mut self, response_id: &str) -> Self {
        self.receipt_response_id = Some(response_id.to_owned());
        self
    }

    /// The ordinal of `response_id`, assigned on first sight and stable after.
    fn turn_index(&self, response_id: &str) -> usize {
        let mut order = self.turn_order.lock().expect("turn order lock poisoned");
        if let Some(index) = order.iter().position(|seen| seen == response_id) {
            return index.min(self.questions.len() - 1);
        }
        order.push(response_id.to_owned());
        (order.len() - 1).min(self.questions.len() - 1)
    }

    /// The question the session is currently on: the last turn's, or the first
    /// before any turn has been asked for.
    fn current_question(&self) -> StudyQuestion {
        let index = {
            let order = self.turn_order.lock().expect("turn order lock poisoned");
            order.len().saturating_sub(1).min(self.questions.len() - 1)
        };
        self.questions[index].clone()
    }

    fn calls(&self) -> std::sync::MutexGuard<'_, StoreCalls> {
        self.calls.lock().expect("store call lock poisoned")
    }
}

#[async_trait::async_trait]
impl StudyMemoryStore for FixtureOutcomeStore {
    async fn record_voice_session(
        &self,
        _config: &SessionConfig,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        Ok(StudyStoreWriteOutcome::Inserted)
    }

    async fn study_context(
        &self,
        _user_id: &str,
        _study_set_id: &str,
    ) -> Result<Option<serde_json::Value>, PortError> {
        Ok(None)
    }

    async fn active_question(
        &self,
        _user_id: &str,
        study_set_id: &str,
    ) -> Result<Option<StudyQuestion>, PortError> {
        Err(PortError::unavailable(
            "fixture_outcome_store",
            study_set_id,
            "the session-blind active-question shortcut must never be used",
        ))
    }

    async fn select_next_question(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        let index = self.turn_index(response_id);
        Ok(QuestionProgressionResult::Selected {
            question: self.questions[index].clone(),
            ordinal: (index + 1) as u32,
            total: self.questions.len() as u32,
            selection_reason: "ordered_v1".to_owned(),
            revision: (index + 1) as u64,
        })
    }

    async fn session_learning_evidence(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
    ) -> Result<SessionLearningEvidence, PortError> {
        let outcomes = self.calls().recorded_outcomes.clone();
        let mut concept_labels = outcomes
            .iter()
            .flat_map(|outcome| match &outcome.resolution {
                agent_domain::TurnResolution::Evaluated {
                    concept_transitions,
                    ..
                } => concept_transitions.clone(),
                agent_domain::TurnResolution::Deferred { .. } => Vec::new(),
            })
            .map(|transition| agent_domain::ConceptLabel {
                label: format!("label for {}", transition.concept_id),
                concept_id: transition.concept_id,
            })
            .collect::<Vec<_>>();
        concept_labels.sort_by(|left, right| left.concept_id.cmp(&right.concept_id));
        concept_labels.dedup_by(|left, right| left.concept_id == right.concept_id);
        Ok(SessionLearningEvidence {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            current_question: Some(self.current_question()),
            answered_questions: self.questions.clone(),
            outcomes,
            concept_labels,
            review_decisions: Vec::new(),
        })
    }

    /// The store keeps the fixture's resolution and stamps it with the response
    /// the executor is persisting under, exactly as a real store does. The
    /// resolution is therefore never what the executor computed, which is the
    /// whole point: the adapter may only speak from what came back.
    async fn record_turn_outcome(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        outcome: TurnOutcome,
    ) -> Result<PersistedTurnOutcome, PortError> {
        let mut persisted = self.persisted[self.turn_index(&outcome.response_id)].clone();
        persisted.response_id = outcome.response_id.clone();
        persisted.question_id = outcome.question_id.clone();
        self.calls().recorded_outcomes.push(persisted.clone());
        let receipt_response_id = self
            .receipt_response_id
            .clone()
            .unwrap_or_else(|| persisted.response_id.clone());
        Ok(PersistedTurnOutcome {
            turn_outcome: persisted,
            record: agent_domain::TurnOutcomeRecordReceipt {
                schema: agent_domain::learning_outcome::VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
                response_id: receipt_response_id,
                replayed: false,
            },
        })
    }

    async fn authenticated_study_projection(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
    ) -> Result<agent_domain::AuthenticatedStudyProjectionV1, PortError> {
        let mut concepts = self
            .questions
            .iter()
            .flat_map(|question| question.rubric.criteria.iter())
            .map(|criterion| criterion.concept_id.clone())
            .collect::<Vec<_>>();
        concepts.sort();
        concepts.dedup();
        Ok(agent_domain::AuthenticatedStudyProjectionV1 {
            version: agent_domain::study_projection::StudyProjectionVersionV1,
            study_set: agent_domain::study_projection::StudyProjectionStudySetV1 {
                id: "biology-midterm".to_owned(),
                title: "Adapter fixture set".to_owned(),
                course: None,
                exam_label: None,
                ingestion_status: agent_domain::StudySetIngestionStatus::Ready,
            },
            session: agent_domain::study_projection::StudyProjectionSessionV1 {
                id: "voice-session-1".to_owned(),
                mode: StudyMode::Quiz,
                goal: None,
            },
            concepts: concepts
                .into_iter()
                .map(
                    |concept_id| agent_domain::study_projection::StudyProjectionConceptV1 {
                        label: format!("label for {concept_id}"),
                        id: concept_id,
                        status: ConceptStatus::Review,
                        last_reviewed_at: None,
                        due_at: None,
                    },
                )
                .collect(),
            active_question: None,
            question_progress: agent_domain::study_projection::StudyProjectionQuestionProgressV1 {
                completed: 0,
                total: self.questions.len() as u32,
            },
            review_schedule: Vec::new(),
        })
    }

    async fn record_answer_attempt_envelope(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<serde_json::Value, PortError> {
        Ok(json!({ "response_id": envelope.response_id }))
    }

    async fn record_answer_evaluation(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _evaluation: AnswerEvaluation,
    ) -> Result<serde_json::Value, PortError> {
        self.calls().record_answer_evaluation += 1;
        Err(PortError::unavailable(
            "fixture_outcome_store",
            response_id,
            "the legacy evaluation write is not a learning authority",
        ))
    }

    async fn source_reference(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        source_id: &str,
    ) -> Result<Option<StudySourceReference>, PortError> {
        Ok(self
            .sources
            .iter()
            .find(|source| source.source_id == source_id)
            .cloned())
    }

    async fn record_concept_status(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _concept_id: &str,
        _status: ConceptStatus,
    ) -> Result<ConceptStatus, PortError> {
        self.calls().record_concept_status += 1;
        Err(PortError::unavailable(
            "fixture_outcome_store",
            response_id,
            "mastery moves only inside a persisted turn outcome",
        ))
    }

    async fn schedule_review_item(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        concept_id: &str,
        _due_at: &str,
    ) -> Result<serde_json::Value, PortError> {
        self.calls().legacy_review_writes += 1;
        Err(PortError::unavailable(
            "fixture_outcome_store",
            concept_id,
            "the adapter may not write a review item",
        ))
    }

    async fn review_scheduling_context(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _concept_id: &str,
    ) -> Result<agent_domain::ReviewSchedulingContextV1, PortError> {
        Ok(agent_domain::ReviewSchedulingContextV1::empty())
    }

    async fn persist_review_schedule_decision(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        _response_id: &str,
        concept_id: &str,
        decision: agent_domain::ReviewScheduleDecisionV1,
    ) -> Result<serde_json::Value, PortError> {
        self.calls()
            .persist_review_schedule_decision
            .push(concept_id.to_owned());
        Ok(serde_json::to_value(decision).expect("decision serializes"))
    }

    async fn record_recap(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        response_id: &str,
        _recap: StudySessionRecap,
    ) -> Result<serde_json::Value, PortError> {
        self.calls().recorded_recaps += 1;
        Ok(json!({ "response_id": response_id }))
    }

    async fn record_voice_usage(
        &self,
        _event: VoiceUsageRecord,
    ) -> Result<StudyStoreWriteOutcome, PortError> {
        Ok(StudyStoreWriteOutcome::Inserted)
    }

    async fn authorize_manuscript_intent(
        &self,
        _user_id: &str,
        _study_set_id: &str,
        _voice_session_id: &str,
        _intent: &ManuscriptIntent,
    ) -> Result<(), PortError> {
        Ok(())
    }
}

const LEARNING_CORE_SOURCE_IDS: [&str; 3] = [
    "src-lec5-slide-18",
    "src-lec5-slide-19",
    "src-lec5-slide-20",
];

fn learning_core_sources() -> Vec<StudySourceReference> {
    LEARNING_CORE_SOURCE_IDS
        .into_iter()
        .map(|source_id| StudySourceReference {
            source_id: source_id.to_owned(),
            document_id: "lec5".to_owned(),
            span: format!("slide:{source_id}"),
            excerpt: "server-bound rubric claim".to_owned(),
            confidence: agent_domain::SourceConfidence::High,
            retrieval_reason: "server-bound rubric source".to_owned(),
        })
        .collect()
}

fn learning_core_rubric() -> agent_domain::EvaluationRubricV1 {
    let fixture: serde_json::Value =
        serde_json::from_str(LEARNING_CORE_TURN_OUTCOMES_V1).expect("corpus parses");
    serde_json::from_value(fixture["rubric"].clone()).expect("corpus rubric parses")
}

fn learning_core_turn_outcome(case_id: &str) -> TurnOutcome {
    let fixture: serde_json::Value =
        serde_json::from_str(LEARNING_CORE_TURN_OUTCOMES_V1).expect("corpus parses");
    serde_json::from_value(fixture["outcomes"][case_id].clone())
        .unwrap_or_else(|error| panic!("corpus case `{case_id}` parses: {error}"))
}

fn learning_core_question() -> StudyQuestion {
    StudyQuestion {
        question_id: "q-etc-electron-flow".to_owned(),
        concept_id: "concept-electron-transport-chain".to_owned(),
        prompt: "Trace the electrons from NADH through the chain.".to_owned(),
        expected_terms: Vec::new(),
        follow_up: "Say where the electrons end up.".to_owned(),
        source: learning_core_sources()[0].clone(),
        rubric: learning_core_rubric(),
    }
}

/// A question with no biology vocabulary anywhere in it — prompt, follow-up,
/// rubric claims and concept ids alike — so a biology sentence anywhere in the
/// emitted stream can only have come from adapter-local fallback copy.
fn non_biology_question() -> StudyQuestion {
    let sources = learning_core_sources();
    StudyQuestion {
        question_id: "q-treaty-order".to_owned(),
        concept_id: "concept-treaty-order".to_owned(),
        prompt: "Name the two treaties that ended the war and say which came first.".to_owned(),
        expected_terms: Vec::new(),
        follow_up: "State the earlier treaty in one sentence.".to_owned(),
        source: sources[0].clone(),
        rubric: agent_domain::EvaluationRubricV1 {
            policy_version: agent_domain::learning_outcome::VIVA_SEMANTIC_RUBRIC_POLICY_VERSION
                .to_owned(),
            criteria: vec![
                agent_domain::RubricCriterionV1 {
                    criterion_id: "crit-treaty-first".to_owned(),
                    concept_id: "concept-treaty-order".to_owned(),
                    claim: "The first treaty was signed in the spring session.".to_owned(),
                    source_id: sources[0].source_id.clone(),
                    required: true,
                },
                agent_domain::RubricCriterionV1 {
                    criterion_id: "crit-treaty-second".to_owned(),
                    concept_id: "concept-treaty-order".to_owned(),
                    claim: "The second treaty replaced the first the following winter.".to_owned(),
                    source_id: sources[0].source_id.clone(),
                    required: true,
                },
            ],
        },
    }
}

/// The parity helper the Step 4 mutation controls run against: it decides
/// whether the emitted learning events are exactly the projection of one
/// persisted outcome, and returns an error otherwise.
fn learning_events_match_outcome(
    events: &[BrainEvent],
    outcome: &TurnOutcome,
) -> Result<(), String> {
    let statuses = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::ConceptStatus {
                concept_id, status, ..
            } => Some((concept_id.clone(), status.clone())),
            _ => None,
        })
        .collect::<Vec<_>>();
    match &outcome.resolution {
        agent_domain::TurnResolution::Evaluated {
            concept_transitions,
            ..
        } => {
            let expected = concept_transitions
                .iter()
                .map(|transition| (transition.concept_id.clone(), transition.to_status.clone()))
                .collect::<Vec<_>>();
            if statuses == expected {
                Ok(())
            } else {
                Err(format!("concept statuses {statuses:?} != {expected:?}"))
            }
        }
        agent_domain::TurnResolution::Deferred { .. } => {
            if statuses.is_empty() {
                Ok(())
            } else {
                Err(format!("deferred outcome emitted statuses {statuses:?}"))
            }
        }
    }
}

async fn run_fixture_outcome_turn(store: Arc<FixtureOutcomeStore>) -> Vec<BrainEvent> {
    run_fixture_outcome_turn_observed(store).await.0
}

/// The same fixture-outcome turn, followed by the learner stopping.
///
/// The session recap is published once, on `Stop`, so a trace that must record
/// the recap projection has to end the session for it.
async fn run_fixture_outcome_turn_then_stop(store: Arc<FixtureOutcomeStore>) -> Vec<BrainEvent> {
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime
        .open(fixture_session_config())
        .await
        .expect("runner opens");
    session
        .input
        .send(BrainInput::Text("the learner answer".to_owned()))
        .await
        .expect("text input accepted");
    let mut events = Vec::new();
    while let Ok(Some(event)) = timeout(Duration::from_millis(400), session.events.recv()).await {
        events.push(event);
    }
    events.extend(stop_and_drain(&mut session).await);
    events
}

/// The turn's events plus how many times the runtime asked Sonic to speak.
///
/// The count is a transport observation the event stream cannot make: a turn
/// that emitted no `AudioDelta` may still have called the speech provider and
/// dropped its frames.
async fn run_fixture_outcome_turn_observed(
    store: Arc<FixtureOutcomeStore>,
) -> (Vec<BrainEvent>, u32) {
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime
        .open(fixture_session_config())
        .await
        .expect("runner opens");
    session
        .input
        .send(BrainInput::Text("the learner answer".to_owned()))
        .await
        .expect("text input accepted");
    let mut events = Vec::new();
    while let Ok(Some(event)) = timeout(Duration::from_millis(400), session.events.recv()).await {
        events.push(event);
    }
    let sonic_calls = runtime.sonic_call_count();
    (events, sonic_calls)
}

#[tokio::test]
async fn live_runner_emits_learning_events_only_from_persisted_turn_outcome() {
    let outcome = learning_core_turn_outcome("evaluated_optional_contradiction_is_shaky");
    let agent_domain::TurnResolution::Evaluated {
        label,
        confidence,
        concept_transitions,
        concise_feedback,
        ..
    } = outcome.resolution.clone()
    else {
        panic!("the fixture case must be evaluated");
    };
    assert!(
        concept_transitions
            .iter()
            .any(|transition| transition.to_status != ConceptStatus::Strong),
        "the case must carry a non-strong transition"
    );

    let store = Arc::new(FixtureOutcomeStore::new(
        learning_core_question(),
        learning_core_sources(),
        outcome.clone(),
    ));
    let (events, sonic_calls) = run_fixture_outcome_turn_observed(Arc::clone(&store)).await;
    // The positive control for every "zero Sonic calls" assertion in this file:
    // a graded turn does speak, exactly once.
    assert_eq!(sonic_calls, 1, "{events:?}");

    let evaluations = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::AnswerEvaluated { evaluation, .. } => Some(evaluation.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(evaluations.len(), 1, "{events:?}");
    assert_eq!(evaluations[0].question_id, "q-etc-electron-flow");
    assert_eq!(evaluations[0].concise_feedback, concise_feedback);
    assert_eq!(evaluations[0].confidence_score, confidence);
    assert_eq!(
        evaluations[0].label,
        match label {
            agent_domain::EvaluationLabel::Strong => "strong",
            agent_domain::EvaluationLabel::MostlyCorrect => "mostly correct",
            agent_domain::EvaluationLabel::PartiallyCorrect => "partially correct",
            agent_domain::EvaluationLabel::Vague => "vague",
            agent_domain::EvaluationLabel::Wrong => "wrong",
            agent_domain::EvaluationLabel::InsufficientEvidence => "insufficient evidence",
        }
    );
    learning_events_match_outcome(&events, &outcome).expect("emitted events match the outcome");

    let calls = store.calls();
    assert_eq!(calls.record_concept_status, 0);
    assert_eq!(calls.legacy_review_writes, 0);
    assert_eq!(calls.record_answer_evaluation, 0);
    assert_eq!(
        calls.persist_review_schedule_decision.len(),
        concept_transitions.len(),
        "one authoritative decision per persisted transition and no extra review write"
    );
    drop(calls);

    // Step 4 mutation control: a transition mutated from `review` to `strong`
    // must no longer match the emitted events.
    let mut mutated = outcome.clone();
    if let agent_domain::TurnResolution::Evaluated {
        concept_transitions,
        ..
    } = &mut mutated.resolution
    {
        for transition in concept_transitions.iter_mut() {
            transition.to_status = ConceptStatus::Strong;
        }
    }
    assert!(
        learning_events_match_outcome(&events, &mutated).is_err(),
        "the parity helper must reject a mutated transition"
    );
}

#[tokio::test]
async fn live_runner_rejects_a_receipt_that_names_another_response() {
    let outcome = learning_core_turn_outcome("evaluated_optional_contradiction_is_shaky");
    let store = Arc::new(
        FixtureOutcomeStore::new(learning_core_question(), learning_core_sources(), outcome)
            .with_receipt_response_id("resp-marker-mismatch"),
    );
    let events = run_fixture_outcome_turn(Arc::clone(&store)).await;

    let failures = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::Error(error) => error.failure().cloned(),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(failures.len(), 1, "{events:?}");
    assert_eq!(
        failures[0].metadata(),
        "error_kind=turn_outcome_receipt_response_id"
    );
    assert!(events.iter().all(|event| !matches!(
        event,
        BrainEvent::AnswerEvaluated { .. }
            | BrainEvent::ConceptStatus { .. }
            | BrainEvent::TurnDeferred { .. }
            | BrainEvent::RecapReady { .. }
            | BrainEvent::AudioDelta { .. }
    )));
    // The executor's own D-01 write happens inside `evaluate_spoken_answer`,
    // before the adapter ever sees the wrapper; what must not happen is any
    // adapter-emitted transition, schedule, or recap.
    let calls = store.calls();
    assert_eq!(calls.recorded_recaps, 0);
    assert_eq!(calls.record_concept_status, 0);
    assert_eq!(calls.legacy_review_writes, 0);
}

#[tokio::test]
async fn deferred_turn_emits_recovery_without_mastery_schedule_or_graded_recap() {
    let outcome = learning_core_turn_outcome("deferred_insufficient_semantic_evidence");
    let agent_domain::TurnResolution::Deferred {
        reason,
        can_retry_same_question,
        ..
    } = outcome.resolution.clone()
    else {
        panic!("the fixture case must be deferred");
    };
    assert_eq!(
        reason,
        agent_domain::EvaluationDeferralReason::InsufficientSemanticEvidence
    );

    let store = Arc::new(FixtureOutcomeStore::new(
        learning_core_question(),
        learning_core_sources(),
        outcome.clone(),
    ));
    let (events, sonic_calls) = run_fixture_outcome_turn_observed(Arc::clone(&store)).await;
    // A deferral is a recovery signal, not a response to speak: the speech
    // provider is never even asked.
    assert_eq!(sonic_calls, 0, "{events:?}");

    let deferred = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::TurnDeferred {
                response_id,
                question_id,
                reason,
                can_retry_same_question,
            } => Some((
                response_id.clone(),
                question_id.clone(),
                reason.clone(),
                *can_retry_same_question,
            )),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(deferred.len(), 1, "{events:?}");
    assert_eq!(deferred[0].0, "response-1");
    assert_eq!(deferred[0].1, "q-etc-electron-flow");
    assert_eq!(deferred[0].2, reason);
    assert_eq!(deferred[0].3, can_retry_same_question);

    assert!(events.iter().all(|event| !matches!(
        event,
        BrainEvent::AnswerEvaluated { .. }
            | BrainEvent::ConceptStatus { .. }
            | BrainEvent::RecapReady { .. }
            | BrainEvent::AudioDelta { .. }
    )));
    learning_events_match_outcome(&events, &outcome).expect("no mastery leaked into a deferral");
    let calls = store.calls();
    assert!(calls.persist_review_schedule_decision.is_empty());
    assert_eq!(calls.record_concept_status, 0);
    assert_eq!(calls.legacy_review_writes, 0);
    assert_eq!(calls.recorded_recaps, 0);
    drop(calls);

    // Step 4 mutation control: a concept transition injected into the deferred
    // wrapper is rejected before it can become a fact.
    let mut deferred_outcome = outcome.clone();
    deferred_outcome.response_id = "response-1".to_owned();
    let mut wrapper = serde_json::to_value(PersistedTurnOutcome {
        record: agent_domain::TurnOutcomeRecordReceipt {
            schema: agent_domain::learning_outcome::VIVA_TURN_OUTCOME_RECORD_SCHEMA.to_owned(),
            response_id: deferred_outcome.response_id.clone(),
            replayed: false,
        },
        turn_outcome: deferred_outcome,
    })
    .expect("wrapper serializes");
    assert!(
        serde_json::from_value::<PersistedTurnOutcome>(wrapper.clone()).is_ok(),
        "the unmutated wrapper is accepted"
    );
    wrapper["turn_outcome"]["resolution"]["concept_transitions"] = json!([{
        "concept_id": "concept-proton-gradient",
        "from_status": "review",
        "to_status": "strong",
        "criterion_ids": ["crit-etc-gradient"],
    }]);
    assert!(
        serde_json::from_value::<PersistedTurnOutcome>(wrapper).is_err(),
        "an injected transition must fail closed"
    );
}

#[tokio::test]
async fn live_empty_model_output_fails_without_biology_speech_or_sonic_call() {
    // An evaluated outcome that carries no copy: the provider produced usage and
    // tool completion but no text at all.
    let mut outcome = learning_core_turn_outcome("evaluated_optional_contradiction_is_shaky");
    if let agent_domain::TurnResolution::Evaluated {
        concise_feedback,
        retry_prompt,
        ..
    } = &mut outcome.resolution
    {
        concise_feedback.clear();
        *retry_prompt = None;
    }
    let store = Arc::new(FixtureOutcomeStore::new(
        non_biology_question(),
        learning_core_sources(),
        outcome,
    ));
    let (events, sonic_calls) = run_fixture_outcome_turn_observed(Arc::clone(&store)).await;
    // The plan's literal proof: zero Sonic calls, not merely zero audio events.
    // The refusal happens before the speech provider is ever asked.
    assert_eq!(sonic_calls, 0, "{events:?}");

    let failures = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::Error(error) => error.failure().cloned(),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(failures.len(), 1, "{events:?}");
    assert_eq!(
        failures[0].failure_class(),
        BrainFailureClass::MalformedStream
    );
    assert_eq!(failures[0].stage(), BrainFailureStage::Gemini);
    assert_eq!(
        failures[0].metadata(),
        "tool=gemini_stream error_kind=empty_model_output"
    );
    assert!(events
        .iter()
        .all(|event| !matches!(event, BrainEvent::AudioDelta { .. })));

    let serialized = serde_json::to_string(&events).expect("events serialize");
    for marker in BIOLOGY_MARKERS {
        assert!(
            !serialized.contains(marker),
            "empty model output must not become `{marker}` copy: {serialized}"
        );
    }
}

#[tokio::test]
async fn live_session_with_no_active_concepts_substitutes_no_fixture_concept() {
    let outcome = learning_core_turn_outcome("evaluated_optional_contradiction_is_shaky");
    let store = Arc::new(FixtureOutcomeStore::new(
        learning_core_question(),
        learning_core_sources(),
        outcome.clone(),
    ));
    // `active_concepts` is empty, so nothing but the persisted transitions can
    // name a concept.
    let events = run_fixture_outcome_turn(Arc::clone(&store)).await;

    let agent_domain::TurnResolution::Evaluated {
        concept_transitions,
        ..
    } = &outcome.resolution
    else {
        panic!("evaluated fixture case");
    };
    let emitted = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::ConceptStatus { concept_id, .. } => Some(concept_id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let expected = concept_transitions
        .iter()
        .map(|transition| transition.concept_id.clone())
        .collect::<Vec<_>>();
    assert_eq!(emitted, expected);
    for fixture_concept in ["oxidative-phosphorylation", "atp-synthase", "nadh"] {
        assert!(
            !emitted
                .iter()
                .any(|concept_id| concept_id == fixture_concept),
            "an empty active-concept list must not substitute `{fixture_concept}`"
        );
    }
}

/// The last adapter-chosen mastery value: an evaluated outcome that names no
/// concept transition has no honest status to show a learner, so the turn is a
/// typed contract failure rather than a silent default.
#[tokio::test]
async fn evaluated_outcome_without_a_concept_transition_fails_closed_without_a_default_status() {
    let mut outcome = learning_core_turn_outcome("evaluated_optional_contradiction_is_shaky");
    if let agent_domain::TurnResolution::Evaluated {
        concept_transitions,
        ..
    } = &mut outcome.resolution
    {
        concept_transitions.clear();
    }
    let store = Arc::new(FixtureOutcomeStore::new(
        learning_core_question(),
        learning_core_sources(),
        outcome,
    ));
    let events = run_fixture_outcome_turn(Arc::clone(&store)).await;

    assert!(
        events.iter().all(|event| !matches!(
            event,
            BrainEvent::AnswerEvaluated { .. }
                | BrainEvent::ConceptStatus { .. }
                | BrainEvent::AudioDelta { .. }
                | BrainEvent::RecapReady { .. }
        )),
        "no learner-visible mastery may be invented for a transition-less outcome: {events:?}"
    );
    let failures = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::Error(error) => error.failure().cloned(),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(failures.len(), 1, "{events:?}");
    assert_eq!(
        failures[0].failure_class(),
        BrainFailureClass::ToolExecutorFailure
    );
    assert_eq!(failures[0].stage(), BrainFailureStage::Tools);
    assert_eq!(
        failures[0].metadata(),
        "error_kind=turn_outcome_without_concept_transition"
    );

    let calls = store.calls();
    assert_eq!(calls.record_concept_status, 0);
    assert!(calls.persist_review_schedule_decision.is_empty());
    assert_eq!(calls.recorded_recaps, 0);
}

// ---------------------------------------------------------------------------
// Task 2 (`ADAPTER-02`): every accepted turn starts its own question.
//
// The expectation is not written here by hand: it is read out of the frozen
// Plan 05 fixture through the published manifest, so the adapter's per-turn
// correlation is pinned to the same artefact the service and client lanes use.
// ---------------------------------------------------------------------------

const VOICE_FIXTURE_MANIFEST_SCHEMA: &str = "viva.voice-fixtures.manifest.v1";
const VOICE_FIXTURE_MANIFEST_PATH: &str = "agent/fixtures/voice-protocol/v5/manifest.json";

fn repository_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the adapter crate lives three directories below the repository root")
        .to_path_buf()
}

/// Every fixture Plan 05's manifest must publish for this lane, with the exact
/// `kind` the manifest declares for it. The list is the plan's Global
/// Constraints written down once, so a fixture that silently disappears or
/// changes kind fails the manifest test rather than a downstream projection.
const REQUIRED_VOICE_FIXTURES: [(&str, &str); 15] = [
    ("VOICE-FIXTURE-MANIFEST", "manifest"),
    ("VOICE-AUTH-DECISION", "auth_decision"),
    ("VOICE-CLIENT-SESSION-CONFIG-SIGNED", "client_frame"),
    ("VOICE-CLIENT-SESSION-REFRESH", "client_frame"),
    ("VOICE-AUDIO-TURN-LIFECYCLE", "frame_sequence"),
    ("VOICE-CLIENT-TURN-INTENTS", "client_frame_cases"),
    ("VOICE-SERVER-TURN-OUTCOMES", "server_event_cases"),
    ("VOICE-SERVER-READY", "server_frame"),
    ("VOICE-TERMINAL-SEQUENCES", "frame_sequence"),
    ("VOICE-TRANSPORT-OUTCOMES", "transport_cases"),
    ("VOICE-SYNTHETIC-TWO-TURN-SESSION", "session_sequence"),
    (
        "VOICE-FAKE-CARTESIA-GEMINI-TWO-TURN-SESSION",
        "session_sequence",
    ),
    ("VOICE-CLIENT-DIFFERENTIAL-CASES", "differential_cases"),
    ("VOICE-SERVER-DIFFERENTIAL-CASES", "differential_cases"),
    ("VOICE-TOKEN-V1-VECTORS", "token_vectors"),
];

fn voice_fixture_manifest() -> serde_json::Value {
    serde_json::from_str(
        &std::fs::read_to_string(repository_root().join(VOICE_FIXTURE_MANIFEST_PATH))
            .expect("Plan 05 publishes the v5 fixture manifest"),
    )
    .expect("the v5 fixture manifest is JSON")
}

/// The default fixture loader: read the manifest-declared path from the frozen
/// tree. It is a parameter of the resolver so a control can hand the resolver a
/// hostile body (a legacy v4 envelope, say) without ever writing a fixture.
fn read_repository_fixture(path: &str) -> Result<String, String> {
    std::fs::read_to_string(repository_root().join(path))
        .map_err(|error| format!("fixture path `{path}` is not readable: {error}"))
}

/// Resolve one Plan 05 fixture by its published manifest ID.
///
/// The manifest is the only way in: schema, protocol version, supported
/// versions, and legacy disposition are validated first; the ID must resolve
/// exactly once; the entry's `kind` must be the expected one; the referenced
/// path may not escape `agent/fixtures`; and the resolved body must be a strict
/// v5 envelope. Every failure is an `Err` rather than a panic so the Task 10
/// controls can assert the rejections.
fn resolve_voice_fixture_with(
    manifest: &serde_json::Value,
    manifest_id: &str,
    expected_kind: &str,
    load: &dyn Fn(&str) -> Result<String, String>,
) -> Result<serde_json::Value, String> {
    if manifest["schema"] != VOICE_FIXTURE_MANIFEST_SCHEMA {
        return Err(format!("manifest schema is {}", manifest["schema"]));
    }
    if manifest["protocol_version"] != 5 {
        return Err(format!(
            "manifest protocol_version is {}",
            manifest["protocol_version"]
        ));
    }
    if manifest["supported_versions"] != json!([5]) {
        return Err(format!(
            "manifest supported_versions is {}",
            manifest["supported_versions"]
        ));
    }
    if manifest["legacy_v4_disposition"] != "reject" {
        return Err(format!(
            "manifest legacy_v4_disposition is {}",
            manifest["legacy_v4_disposition"]
        ));
    }

    let entries = manifest["fixtures"]
        .as_array()
        .ok_or_else(|| "the manifest publishes no fixture list".to_owned())?;
    let resolved = entries
        .iter()
        .filter(|entry| entry["id"] == manifest_id)
        .collect::<Vec<_>>();
    if resolved.len() != 1 {
        return Err(format!(
            "manifest id {manifest_id} resolves {} times, not exactly once",
            resolved.len()
        ));
    }
    let entry = resolved[0];
    let kind = entry["kind"]
        .as_str()
        .ok_or_else(|| format!("manifest entry {manifest_id} names no kind"))?;
    if kind != expected_kind {
        return Err(format!(
            "manifest entry {manifest_id} is kind `{kind}`, not `{expected_kind}`"
        ));
    }
    let path = entry["path"]
        .as_str()
        .ok_or_else(|| format!("manifest entry {manifest_id} names no path"))?;
    if !path.starts_with("agent/fixtures/") {
        return Err(format!("manifest path {path} escapes the fixture tree"));
    }
    if path.contains("/../") || path.contains("/./") || path.contains('\\') {
        return Err(format!(
            "manifest path {path} traverses out of the fixture tree"
        ));
    }

    let body = load(path)?;
    let fixture: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("fixture {manifest_id} is not JSON: {error}"))?;
    if let Some(version) = fixture.get("protocol_version") {
        if version != &json!(5) {
            return Err(format!(
                "fixture {manifest_id} declares protocol_version {version}; strict v5 rejects it"
            ));
        }
    }
    if let Some(supported) = fixture.get("supported_versions") {
        if supported != &json!([5]) {
            return Err(format!(
                "fixture {manifest_id} declares supported_versions {supported}; strict v5 rejects it"
            ));
        }
    }
    Ok(fixture)
}

/// The strict wrapper existing tests use: the expected kind comes from the
/// published requirement table, and any rejection is a test failure.
fn resolve_voice_fixture(manifest_id: &str) -> serde_json::Value {
    let expected_kind = REQUIRED_VOICE_FIXTURES
        .iter()
        .find(|(id, _)| *id == manifest_id)
        .unwrap_or_else(|| panic!("{manifest_id} is not a fixture this lane consumes"))
        .1;
    resolve_voice_fixture_with(
        &voice_fixture_manifest(),
        manifest_id,
        expected_kind,
        &read_repository_fixture,
    )
    .unwrap_or_else(|error| panic!("{error}"))
}

/// The adapter-owned half of the frozen two-turn session fixture.
struct TwoTurnQuestionCorrelation {
    first_response_id: String,
    second_response_id: String,
    /// Event kinds the fixture itself places after the second question starts
    /// while still naming the first response. Nothing else may trail.
    authorized_trailing_kinds: std::collections::BTreeSet<String>,
}

fn two_turn_question_correlation(fixture: &serde_json::Value) -> TwoTurnQuestionCorrelation {
    let turns = fixture["turns"]
        .as_array()
        .expect("a session-sequence fixture publishes its turns");
    assert_eq!(turns.len(), 2, "the two-turn fixture publishes two turns");
    let first_response_id = turns[0]["response_id"]
        .as_str()
        .expect("turn 1 names its response")
        .to_owned();
    let second_response_id = turns[1]["response_id"]
        .as_str()
        .expect("turn 2 names its response")
        .to_owned();
    assert_ne!(first_response_id, second_response_id);

    let frames = fixture["server_sequence_json"]
        .as_array()
        .expect("a session-sequence fixture publishes its server frames")
        .iter()
        .map(|frame| {
            serde_json::from_str::<serde_json::Value>(
                frame.as_str().expect("each server frame is encoded JSON"),
            )
            .expect("each server frame is JSON")
        })
        .collect::<Vec<_>>();
    let second_start = frames
        .iter()
        .position(|frame| {
            frame["event"]["type"] == "question_started"
                && frame["event"]["response_id"] == second_response_id.as_str()
        })
        .expect("the fixture starts a question for the second response");
    let authorized_trailing_kinds = frames[second_start + 1..]
        .iter()
        .filter(|frame| frame["event"]["response_id"] == first_response_id.as_str())
        .filter_map(|frame| frame["event"]["type"].as_str().map(ToOwned::to_owned))
        .collect();

    TwoTurnQuestionCorrelation {
        first_response_id,
        second_response_id,
        authorized_trailing_kinds,
    }
}

fn adapter_event_kind(event: &BrainEvent) -> &'static str {
    match event {
        BrainEvent::QuestionStarted { .. } => "question_started",
        BrainEvent::TranscriptDelta { .. } => "transcript_delta",
        BrainEvent::TranscriptFinal { .. } => "transcript_final",
        BrainEvent::ResponseTranscriptDelta { .. } => "response_transcript_delta",
        BrainEvent::AnswerEvaluated { .. } => "answer_evaluated",
        BrainEvent::TurnDeferred { .. } => "turn_deferred",
        BrainEvent::SourceReference { .. } => "source_reference",
        BrainEvent::ConceptStatus { .. } => "concept_status",
        BrainEvent::ManuscriptIntent { .. } => "manuscript_intent",
        BrainEvent::AudioDelta { .. } => "audio_delta",
        BrainEvent::ResponseCompleted { .. } => "response_completed",
        BrainEvent::ResponseCancelledFor { .. } => "cancellation",
        BrainEvent::RecapReady { .. } => "recap_ready",
        BrainEvent::ProviderFallbackActivated { .. } => "provider_fallback_activated",
        _ => "other",
    }
}

fn adapter_event_response_id(event: &BrainEvent) -> Option<&str> {
    match event {
        BrainEvent::QuestionStarted { response_id, .. }
        | BrainEvent::TranscriptDelta { response_id, .. }
        | BrainEvent::TranscriptFinal { response_id, .. }
        | BrainEvent::ResponseTranscriptDelta { response_id, .. }
        | BrainEvent::AnswerEvaluated { response_id, .. }
        | BrainEvent::TurnDeferred { response_id, .. }
        | BrainEvent::SourceReference { response_id, .. }
        | BrainEvent::ConceptStatus { response_id, .. }
        | BrainEvent::ManuscriptIntent { response_id, .. }
        | BrainEvent::AudioDelta { response_id, .. }
        | BrainEvent::ResponseCompleted { response_id, .. }
        | BrainEvent::ResponseCancelledFor { response_id }
        | BrainEvent::RecapReady { response_id, .. }
        | BrainEvent::ProviderFallbackActivated { response_id, .. }
        | BrainEvent::ResponseStarted { response_id }
        | BrainEvent::ResponseAudio { response_id, .. }
        | BrainEvent::ResponseToolProposal { response_id, .. }
        | BrainEvent::ResponseTextStarted { response_id } => Some(response_id.as_str()),
        _ => None,
    }
}

/// The parity helper the mutation controls are aimed at.
fn two_turn_question_correlation_result(
    events: &[BrainEvent],
    correlation: &TwoTurnQuestionCorrelation,
) -> Result<(), String> {
    let started = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::QuestionStarted { response_id, .. } => Some(response_id.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let expected = [
        correlation.first_response_id.as_str(),
        correlation.second_response_id.as_str(),
    ];
    if started != expected {
        return Err(format!(
            "each accepted turn must start exactly one correlated question; expected {expected:?}, saw {started:?}"
        ));
    }

    for response_id in expected {
        let first_bound = events
            .iter()
            .find(|event| adapter_event_response_id(event) == Some(response_id))
            .ok_or_else(|| format!("no event carries {response_id}"))?;
        if !matches!(first_bound, BrainEvent::QuestionStarted { .. }) {
            return Err(format!(
                "{response_id} emitted {} before its question started",
                adapter_event_kind(first_bound)
            ));
        }
    }

    let second_start = events
        .iter()
        .position(|event| {
            matches!(event, BrainEvent::QuestionStarted { response_id, .. }
                if response_id == &correlation.second_response_id)
        })
        .expect("the second question start was located above");
    for event in &events[second_start + 1..] {
        let Some(response_id) = adapter_event_response_id(event) else {
            continue;
        };
        if response_id == correlation.second_response_id {
            continue;
        }
        let kind = adapter_event_kind(event);
        if response_id == correlation.first_response_id
            && correlation.authorized_trailing_kinds.contains(kind)
        {
            continue;
        }
        return Err(format!(
            "{kind} for {response_id} trails the start of {}",
            correlation.second_response_id
        ));
    }

    Ok(())
}

#[tokio::test]
async fn fake_cartesia_two_turns_match_manifest_question_correlation() {
    let fixture = resolve_voice_fixture("VOICE-FAKE-CARTESIA-GEMINI-TWO-TURN-SESSION");
    let correlation = two_turn_question_correlation(&fixture);

    let store = learning_ready_store();
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime.open(fixture_session_config()).await.unwrap();

    let mut events = vec![next_event(&mut session).await];
    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();
    loop {
        let event = next_event(&mut session).await;
        let completed = matches!(&event, BrainEvent::ResponseCompleted { response_id }
            if response_id == &correlation.first_response_id);
        events.push(event);
        if completed {
            break;
        }
    }
    // Let the first turn finish before the second is submitted: this is an
    // ordinary next turn, not a barge-in.
    events.extend(remaining_events(&mut session).await);

    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            5_u8, 6, 7, 8,
        ])))
        .await
        .unwrap();
    loop {
        let event = next_event(&mut session).await;
        let completed = matches!(&event, BrainEvent::ResponseCompleted { response_id }
            if response_id == &correlation.second_response_id);
        events.push(event);
        if completed {
            break;
        }
    }
    events.extend(remaining_events(&mut session).await);

    assert!(
        events
            .iter()
            .all(|event| !matches!(event, BrainEvent::ResponseCancelledFor { .. })),
        "the second turn must be accepted without a barge-in: {events:?}"
    );
    two_turn_question_correlation_result(&events, &correlation)
        .unwrap_or_else(|error| panic!("{error}: {events:?}"));

    let started = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::QuestionStarted {
                response_id,
                question,
            } => Some((response_id.clone(), question.question_id.clone())),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(started.len(), 2);
    assert_eq!(started[0].0, correlation.first_response_id);
    assert_eq!(started[1].0, correlation.second_response_id);
    assert_ne!(started[0].0, started[1].0);

    // Local mutation controls. The frozen fixture is never edited: both
    // mutations are applied to a clone of the projection this run produced, and
    // both must be rejected.
    let mut without_second_start = events.clone();
    let second_start_index = without_second_start
        .iter()
        .position(|event| {
            matches!(event, BrainEvent::QuestionStarted { response_id, .. }
                if response_id == &correlation.second_response_id)
        })
        .expect("the second turn started a question");
    without_second_start.remove(second_start_index);
    assert!(
        two_turn_question_correlation_result(&without_second_start, &correlation).is_err(),
        "deleting the second question start must be rejected"
    );

    let mut duplicated_response_id = events.clone();
    if let Some(BrainEvent::QuestionStarted { response_id, .. }) =
        duplicated_response_id.get_mut(second_start_index)
    {
        *response_id = correlation.first_response_id.clone();
    }
    assert!(
        two_turn_question_correlation_result(&duplicated_response_id, &correlation).is_err(),
        "reusing the first response id for the second turn must be rejected"
    );
}

// ---------------------------------------------------------------------------
// Task 6 (`ADAPTER-06`): a durable-store failure on the pre-provider answer
// envelope is a typed durability failure, not an untyped runner error and not a
// fixture-labelled provider incident.
// ---------------------------------------------------------------------------

const ENVELOPE_STORE_DSN_MARKER: &str = "postgres://viva:marker-dsn-a41@db.internal/viva";
const ENVELOPE_ANSWER_MARKER: &str = "marker-learner-answer-a42";

#[tokio::test]
async fn live_envelope_store_failure_is_typed_durability_degraded() {
    let inner = learning_ready_store();
    let session = fixture_session_config();
    let _ = inner.record_voice_session(&session).await.unwrap();
    let store = Arc::new(FailStudyToolStore::answer_attempt_envelope(inner));
    let runtime = FakeCartesiaGeminiRuntime::new(store);

    let mut realtime = runtime.open(session).await.unwrap();
    assert!(matches!(
        next_event(&mut realtime).await,
        BrainEvent::SessionPhase { .. }
    ));
    assert!(matches!(
        next_event(&mut realtime).await,
        BrainEvent::QuestionStarted { .. }
    ));
    realtime
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();

    let mut seen = Vec::new();
    let error = loop {
        let event = next_event(&mut realtime).await;
        if let BrainEvent::Error(error) = event {
            break error;
        }
        seen.push(event);
    };
    let failure = error
        .failure
        .clone()
        .expect("a durable-store failure is a typed failure");

    assert_eq!(
        failure.failure_class(),
        BrainFailureClass::DurabilityDegraded,
        "{failure:?}"
    );
    assert_eq!(failure.stage(), BrainFailureStage::Store);
    assert_eq!(
        failure.terminal_reason(),
        TerminalSessionReason::DurabilityDegraded
    );
    assert!(failure.retry_eligible());
    assert!(
        failure
            .metadata()
            .contains("tool=record_answer_attempt_envelope"),
        "{failure:?}"
    );

    // The envelope write happens before any provider I/O, so the transcription,
    // model, and speech stages must never have been asked for anything.
    assert_eq!(
        runtime.provider_call_count(),
        0,
        "a pre-provider durability failure must not call a provider: {seen:?}"
    );
    assert_eq!(runtime.sonic_call_count(), 0);
    assert!(
        seen.iter().all(|event| !matches!(
            event,
            BrainEvent::TranscriptFinal { .. }
                | BrainEvent::TranscriptDelta { .. }
                | BrainEvent::AudioDelta { .. }
                | BrainEvent::AnswerEvaluated { .. }
                | BrainEvent::RecapReady { .. }
        )),
        "{seen:?}"
    );

    // The store's own prose — including its DSN and the learner's answer — never
    // reaches the learner-visible error or the failure metadata.
    let rendered = format!(
        "{} {failure:?} {}",
        error.message,
        serde_json::to_string(&failure).unwrap()
    );
    assert!(!rendered.contains(ENVELOPE_STORE_DSN_MARKER), "{rendered}");
    assert!(!rendered.contains(ENVELOPE_ANSWER_MARKER), "{rendered}");
    assert!(!rendered.contains("marker-dsn-a41"), "{rendered}");
}

// ---------------------------------------------------------------------------
// Task 10 (`ADAPTER-10`): fixture parity and differential controls.
//
// Everything below reads the immutable Plan 04/05 fixtures through the
// published manifest and compares them with what this crate actually emits. No
// fixture is ever written: every "must be rejected" control mutates an
// in-memory clone and asserts the helper refuses it.
// ---------------------------------------------------------------------------

const LEARNING_CORE_RECAPS_V1: &str =
    include_str!("../../../fixtures/learning-core/recaps-v1.json");
const LEARNING_CORE_QUESTION_PROGRESSION_V1: &str =
    include_str!("../../../fixtures/learning-core/question-progression-v1.json");

/// The adapter-owned event kinds the frozen server sequences publish. The
/// runner also emits `response_completed`, which the service projects onto a
/// session phase rather than a distinct wire event, so it has no fixture kind
/// to compare against and is deliberately outside this set.
const ADAPTER_LEARNER_VISIBLE_KINDS: [&str; 10] = [
    "question_started",
    "transcript_delta",
    "transcript_final",
    "answer_evaluated",
    "turn_deferred",
    "source_reference",
    "concept_status",
    "audio_delta",
    "cancellation",
    "recap_ready",
];

#[test]
fn adapter_fixture_manifest_is_strict_v5_and_complete() {
    let manifest = voice_fixture_manifest();

    // Completeness: every fixture the plan's Global Constraints name resolves
    // exactly once, at its declared kind, inside the frozen tree.
    for (manifest_id, kind) in REQUIRED_VOICE_FIXTURES {
        let fixture =
            resolve_voice_fixture_with(&manifest, manifest_id, kind, &read_repository_fixture)
                .unwrap_or_else(|error| panic!("{manifest_id}: {error}"));
        assert!(
            fixture.is_object(),
            "{manifest_id} resolves to a JSON object"
        );
    }
    let published = manifest["fixtures"]
        .as_array()
        .expect("the manifest publishes a fixture list")
        .iter()
        .map(|entry| entry["id"].as_str().expect("each entry names an id"))
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        published.len(),
        manifest["fixtures"].as_array().unwrap().len(),
        "the manifest publishes no duplicate id"
    );
    for (manifest_id, _) in REQUIRED_VOICE_FIXTURES {
        assert!(
            published.contains(manifest_id),
            "the manifest must publish {manifest_id}"
        );
    }

    // Rejection controls. Each mutates a clone; the frozen manifest is never
    // written. A control that stopped failing would mean the resolver had lost
    // a guard.
    let resolve = |manifest: &serde_json::Value| {
        resolve_voice_fixture_with(
            manifest,
            "VOICE-SERVER-DIFFERENTIAL-CASES",
            "differential_cases",
            &read_repository_fixture,
        )
    };
    assert!(resolve(&manifest).is_ok(), "the pristine manifest resolves");

    let mut duplicated = manifest.clone();
    let duplicate_entry = duplicated["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "VOICE-SERVER-DIFFERENTIAL-CASES")
        .cloned()
        .unwrap();
    duplicated["fixtures"]
        .as_array_mut()
        .unwrap()
        .push(duplicate_entry);
    assert!(
        resolve(&duplicated).is_err(),
        "a duplicated manifest id must be rejected"
    );

    for hostile_path in [
        "agent/fixtures/../../etc/passwd",
        "/etc/passwd",
        "agent/fixtures/voice-protocol/./v5/manifest.json",
        "docs/superpowers/plans/2026-08-23-live-provider-adapters.md",
    ] {
        let mut escaped = manifest.clone();
        for entry in escaped["fixtures"].as_array_mut().unwrap() {
            if entry["id"] == "VOICE-SERVER-DIFFERENTIAL-CASES" {
                entry["path"] = json!(hostile_path);
            }
        }
        assert!(
            resolve(&escaped).is_err(),
            "manifest path `{hostile_path}` must be rejected"
        );
    }

    let mut missing = manifest.clone();
    for entry in missing["fixtures"].as_array_mut().unwrap() {
        if entry["id"] == "VOICE-SERVER-DIFFERENTIAL-CASES" {
            entry["path"] = json!("agent/fixtures/voice-protocol/v5/does-not-exist.json");
        }
    }
    assert!(
        resolve(&missing).is_err(),
        "a manifest path that does not exist must be rejected"
    );

    assert!(
        resolve_voice_fixture_with(
            &manifest,
            "VOICE-SERVER-DIFFERENTIAL-CASES",
            "session_sequence",
            &read_repository_fixture,
        )
        .is_err(),
        "resolving at the wrong kind must be rejected"
    );

    assert!(
        resolve_voice_fixture_with(
            &manifest,
            "VOICE-NOT-PUBLISHED",
            "differential_cases",
            &read_repository_fixture,
        )
        .is_err(),
        "an unpublished manifest id must be rejected"
    );

    for (field, value) in [
        ("schema", json!("viva.voice-fixtures.manifest.v0")),
        ("protocol_version", json!(4)),
        ("supported_versions", json!([4, 5])),
        ("legacy_v4_disposition", json!("accept")),
    ] {
        let mut downgraded = manifest.clone();
        downgraded[field] = value.clone();
        assert!(
            resolve(&downgraded).is_err(),
            "manifest {field} = {value} must be rejected"
        );
    }

    // Mutation control (Step 2, "version 5 -> 4"): the resolved body is refused
    // when its envelope is not strict v5, whichever direction it drifts.
    for version in [json!(4), json!(6)] {
        let downgraded_body = {
            let mut body = resolve(&manifest).expect("the pristine fixture resolves");
            body["protocol_version"] = version.clone();
            serde_json::to_string(&body).expect("the clone serializes")
        };
        let load = move |_path: &str| Ok(downgraded_body.clone());
        assert!(
            resolve_voice_fixture_with(
                &manifest,
                "VOICE-SERVER-DIFFERENTIAL-CASES",
                "differential_cases",
                &load,
            )
            .is_err(),
            "a resolved fixture at protocol_version {version} must be rejected"
        );
    }
}

// --- the two-turn adapter parity harness ----------------------------------

#[derive(Clone, Debug, PartialEq)]
enum VoiceFixtureResolution {
    Evaluated {
        evaluation: Box<AnswerEvaluation>,
        source: Box<StudySourceReference>,
        concept_statuses: Vec<(String, ConceptStatus)>,
    },
    Deferred {
        question_id: String,
        reason: agent_domain::EvaluationDeferralReason,
        can_retry_same_question: bool,
    },
}

#[derive(Clone, Debug)]
struct VoiceFixtureTurn {
    response_id: String,
    question: StudyQuestion,
    resolution: VoiceFixtureResolution,
    /// The fixture's own `transcript_final.confidence`. Plan 05 freezes it as
    /// `null`; the adapter must emit exactly that absence.
    transcript_confidence: Option<f64>,
}

#[derive(Clone, Debug)]
struct VoiceFixtureAdapterContract {
    fixture_id: String,
    provider: String,
    turns: Vec<VoiceFixtureTurn>,
    published_kinds: std::collections::BTreeSet<String>,
    authorized_trailing_kinds: std::collections::BTreeSet<String>,
    terminal_phase: agent_domain::StudySessionPhase,
    recap_schema: String,
    recap_deferred_turns: u32,
    /// How many recaps the fixture publishes for the whole session. A recap is
    /// a session-scope fold, so a projection that publishes a different number
    /// of them is not the fixture's session.
    recap_count: usize,
    /// The learner-visible kinds the fixture itself publishes after its recap.
    /// Both two-turn fixtures place the recap last, so this is empty and the
    /// projection may emit nothing learner-visible after its own recap.
    recap_trailing_kinds: std::collections::BTreeSet<String>,
    /// The recap's graded concepts, by identity and status. The label is the
    /// store's, not the adapter's, so it is deliberately not compared.
    recap_concepts: Vec<(String, ConceptStatus)>,
    recap_source_moments: Vec<(String, String)>,
}

fn fixture_server_events(fixture: &serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    let frames = fixture["server_sequence_json"]
        .as_array()
        .ok_or_else(|| "the fixture publishes no server sequence".to_owned())?;
    let mut events = Vec::new();
    for frame in frames {
        let decoded: serde_json::Value = serde_json::from_str(
            frame
                .as_str()
                .ok_or_else(|| "each server frame is encoded JSON".to_owned())?,
        )
        .map_err(|error| format!("a server frame is not JSON: {error}"))?;
        if decoded["version"] != json!(5) {
            return Err(format!(
                "server frame declares version {}; strict v5 rejects it",
                decoded["version"]
            ));
        }
        if decoded["type"] == "event" {
            events.push(decoded["event"].clone());
        }
    }
    Ok(events)
}

/// Extract the adapter-owned half of a frozen two-turn session fixture.
///
/// This reads only what this crate is responsible for: per-turn correlation,
/// the question the server asked, the outcome resolution and the learner facts
/// it authorizes, transcript-confidence nullability, cancellation legality, and
/// the terminal recap. It never rebuilds the service's wire-envelope mapper.
fn voice_fixture_adapter_contract(
    fixture: &serde_json::Value,
) -> Result<VoiceFixtureAdapterContract, String> {
    if fixture["schema"] != "viva.voice-session-sequence.v1" {
        return Err(format!("fixture schema is {}", fixture["schema"]));
    }
    let events = fixture_server_events(fixture)?;
    let published_kinds = events
        .iter()
        .filter_map(|event| event["type"].as_str().map(ToOwned::to_owned))
        .collect::<std::collections::BTreeSet<_>>();

    let declared_turns = fixture["turns"]
        .as_array()
        .ok_or_else(|| "the fixture publishes no turns".to_owned())?;
    let mut turns = Vec::new();
    for declared in declared_turns {
        let response_id = declared["response_id"]
            .as_str()
            .ok_or_else(|| "a turn names no response".to_owned())?
            .to_owned();
        let starts = events
            .iter()
            .filter(|event| {
                event["type"] == "question_started" && event["response_id"] == response_id.as_str()
            })
            .collect::<Vec<_>>();
        if starts.len() != 1 {
            return Err(format!(
                "{response_id} starts {} questions, not exactly one",
                starts.len()
            ));
        }
        if starts[0]["turn_id"] != declared["turn_id"] {
            return Err(format!(
                "{response_id} starts under turn {} but the fixture declares {}",
                starts[0]["turn_id"], declared["turn_id"]
            ));
        }
        let question: StudyQuestion = serde_json::from_value(starts[0]["question"].clone())
            .map_err(|error| format!("{response_id} question does not parse: {error}"))?;
        if declared["question_id"] != json!(question.question_id.as_str()) {
            return Err(format!(
                "{response_id} starts {} but the fixture declares {}",
                question.question_id, declared["question_id"]
            ));
        }

        let bound = |kind: &str| {
            events
                .iter()
                .filter(|event| {
                    event["type"] == kind && event["response_id"] == response_id.as_str()
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        let evaluated = bound("answer_evaluated");
        let deferred = bound("turn_deferred");
        if evaluated.len() + deferred.len() != 1 {
            return Err(format!(
                "{response_id} resolves {} times, not exactly once",
                evaluated.len() + deferred.len()
            ));
        }
        let resolution = if let Some(event) = evaluated.first() {
            let evaluation: AnswerEvaluation = serde_json::from_value(event["evaluation"].clone())
                .map_err(|error| format!("{response_id} evaluation does not parse: {error}"))?;
            evaluation
                .validate_fail_closed()
                .map_err(|error| format!("{response_id} evaluation is invalid: {error}"))?;
            let sources = bound("source_reference");
            if sources.len() != 1 {
                return Err(format!(
                    "an evaluated {response_id} cites {} sources, not exactly one",
                    sources.len()
                ));
            }
            let source: StudySourceReference = serde_json::from_value(sources[0]["source"].clone())
                .map_err(|error| format!("{response_id} source does not parse: {error}"))?;
            let mut concept_statuses = Vec::new();
            for event in bound("concept_status") {
                let concept_id = event["concept_id"]
                    .as_str()
                    .ok_or_else(|| format!("{response_id} concept status names no concept"))?
                    .to_owned();
                let status: ConceptStatus = serde_json::from_value(event["status"].clone())
                    .map_err(|error| format!("{response_id} concept status: {error}"))?;
                concept_statuses.push((concept_id, status));
            }
            if concept_statuses.is_empty() {
                return Err(format!(
                    "an evaluated {response_id} publishes no concept status"
                ));
            }
            VoiceFixtureResolution::Evaluated {
                evaluation: Box::new(evaluation),
                source: Box::new(source),
                concept_statuses,
            }
        } else {
            let event = &deferred[0];
            if event["turn_id"] != declared["turn_id"] {
                return Err(format!("{response_id} defers under the wrong turn"));
            }
            if !bound("concept_status").is_empty() || !bound("answer_evaluated").is_empty() {
                return Err(format!("a deferred {response_id} publishes a learner fact"));
            }
            VoiceFixtureResolution::Deferred {
                question_id: event["question_id"]
                    .as_str()
                    .ok_or_else(|| format!("{response_id} deferral names no question"))?
                    .to_owned(),
                reason: serde_json::from_value(event["reason"].clone())
                    .map_err(|error| format!("{response_id} deferral reason: {error}"))?,
                can_retry_same_question: event["can_retry_same_question"]
                    .as_bool()
                    .ok_or_else(|| format!("{response_id} deferral names no retry flag"))?,
            }
        };

        let finals = bound("transcript_final");
        if finals.len() != 1 {
            return Err(format!(
                "{response_id} publishes {} final transcripts, not exactly one",
                finals.len()
            ));
        }
        if !finals[0]
            .as_object()
            .is_some_and(|final_transcript| final_transcript.contains_key("confidence"))
        {
            return Err(format!("{response_id} omits transcript confidence"));
        }
        let transcript_confidence = finals[0]["confidence"].as_f64();

        turns.push(VoiceFixtureTurn {
            response_id,
            question,
            resolution,
            transcript_confidence,
        });
    }
    if turns.len() < 2 {
        return Err("a two-turn fixture publishes two turns".to_owned());
    }
    let mut identities = turns
        .iter()
        .map(|turn| turn.response_id.as_str())
        .collect::<Vec<_>>();
    identities.sort_unstable();
    identities.dedup();
    if identities.len() != turns.len() {
        return Err("the fixture reuses a response id across turns".to_owned());
    }

    // A cancellation may only name a response the fixture has already started;
    // naming the replacement context instead would cancel a turn before it
    // exists.
    for (index, event) in events.iter().enumerate() {
        if event["type"] != "cancellation" {
            continue;
        }
        let Some(cancelled) = event["response_id"].as_str() else {
            continue;
        };
        let started = events[..index].iter().any(|earlier| {
            earlier["type"] == "question_started" && earlier["response_id"] == cancelled
        });
        if !started {
            return Err(format!(
                "cancellation names {cancelled}, which has not started yet"
            ));
        }
    }

    let second_start = events
        .iter()
        .position(|event| {
            event["type"] == "question_started"
                && event["response_id"] == turns[1].response_id.as_str()
        })
        .ok_or_else(|| "the fixture starts a question for the second response".to_owned())?;
    let authorized_trailing_kinds = events[second_start + 1..]
        .iter()
        .filter(|event| event["response_id"] == turns[0].response_id.as_str())
        .filter_map(|event| event["type"].as_str().map(ToOwned::to_owned))
        .collect();

    let terminal_phase: agent_domain::StudySessionPhase = events
        .iter()
        .rev()
        .find(|event| event["type"] == "session_phase")
        .map(|event| serde_json::from_value(event["phase"].clone()))
        .ok_or_else(|| "the fixture publishes no session phase".to_owned())?
        .map_err(|error| format!("terminal phase does not parse: {error}"))?;

    let recap_count = events
        .iter()
        .filter(|event| event["type"] == "recap_ready")
        .count();
    let recap_position = events
        .iter()
        .rposition(|event| event["type"] == "recap_ready")
        .ok_or_else(|| "the fixture publishes no recap".to_owned())?;
    let recap_trailing_kinds = events[recap_position + 1..]
        .iter()
        .filter_map(|event| event["type"].as_str())
        .filter(|kind| ADAPTER_LEARNER_VISIBLE_KINDS.contains(kind))
        .map(ToOwned::to_owned)
        .collect();
    let recap = &events[recap_position];
    let recap_schema = recap["recap"]["schema"]
        .as_str()
        .ok_or_else(|| "the fixture recap names no schema".to_owned())?
        .to_owned();
    let recap_deferred_turns = recap["recap"]["deferred_turns"]
        .as_u64()
        .ok_or_else(|| "the fixture recap counts no deferrals".to_owned())?
        as u32;
    let fixture_deferrals = turns
        .iter()
        .filter(|turn| matches!(turn.resolution, VoiceFixtureResolution::Deferred { .. }))
        .count() as u32;
    if recap_deferred_turns != fixture_deferrals {
        return Err(format!(
            "the fixture recap counts {recap_deferred_turns} deferrals but publishes {fixture_deferrals}"
        ));
    }
    let mut recap_concepts = Vec::new();
    for concept in recap["recap"]["concepts"]
        .as_array()
        .ok_or_else(|| "the fixture recap names no concepts".to_owned())?
    {
        let concept_id = concept["concept_id"]
            .as_str()
            .ok_or_else(|| "a recap concept names no id".to_owned())?
            .to_owned();
        let status: ConceptStatus = serde_json::from_value(concept["status"].clone())
            .map_err(|error| format!("a recap concept status does not parse: {error}"))?;
        recap_concepts.push((concept_id, status));
    }
    let mut recap_source_moments = Vec::new();
    for moment in recap["recap"]["source_moments"]
        .as_array()
        .ok_or_else(|| "the fixture recap names no source moments".to_owned())?
    {
        recap_source_moments.push((
            moment["response_id"]
                .as_str()
                .ok_or_else(|| "a recap source moment names no response".to_owned())?
                .to_owned(),
            moment["source_id"]
                .as_str()
                .ok_or_else(|| "a recap source moment names no source".to_owned())?
                .to_owned(),
        ));
    }

    Ok(VoiceFixtureAdapterContract {
        fixture_id: fixture["id"]
            .as_str()
            .ok_or_else(|| "the fixture names no id".to_owned())?
            .to_owned(),
        provider: fixture["provider"]
            .as_str()
            .ok_or_else(|| "the fixture names no provider".to_owned())?
            .to_owned(),
        turns,
        published_kinds,
        authorized_trailing_kinds,
        terminal_phase,
        recap_schema,
        recap_deferred_turns,
        recap_count,
        recap_trailing_kinds,
        recap_concepts,
        recap_source_moments,
    })
}

/// The Task 10 parity helper: does this crate's emitted projection agree with
/// the frozen fixture on every dimension the adapter owns?
fn adapter_projection_matches_voice_fixture(
    events: &[BrainEvent],
    contract: &VoiceFixtureAdapterContract,
) -> Result<(), String> {
    // 1. Kind vocabulary: nothing learner-visible is emitted that the fixture
    //    does not publish.
    for event in events {
        let kind = adapter_event_kind(event);
        if ADAPTER_LEARNER_VISIBLE_KINDS.contains(&kind) && !contract.published_kinds.contains(kind)
        {
            return Err(format!(
                "{kind} is emitted but {} publishes no such event",
                contract.fixture_id
            ));
        }
    }

    // 2. Correlation: one question start per fixture turn, in order, and each
    //    is the first response-bound event for its response.
    let started = events
        .iter()
        .filter_map(|event| match event {
            BrainEvent::QuestionStarted { response_id, .. } => Some(response_id.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let expected = contract
        .turns
        .iter()
        .map(|turn| turn.response_id.as_str())
        .collect::<Vec<_>>();
    if started != expected {
        return Err(format!(
            "question starts {started:?} do not match the fixture turns {expected:?}"
        ));
    }

    for turn in &contract.turns {
        let response_id = turn.response_id.as_str();
        let bound = events
            .iter()
            .filter(|event| adapter_event_response_id(event) == Some(response_id))
            .collect::<Vec<_>>();
        let Some(first) = bound.first() else {
            return Err(format!("no event carries {response_id}"));
        };
        let BrainEvent::QuestionStarted { question, .. } = first else {
            return Err(format!(
                "{response_id} emitted {} before its question started",
                adapter_event_kind(first)
            ));
        };
        if question != &turn.question {
            return Err(format!(
                "{response_id} asked {} but the fixture asks {}",
                question.question_id, turn.question.question_id
            ));
        }

        // 3. Confidence nullability is the fixture's, exactly.
        let confidences = bound
            .iter()
            .filter_map(|event| match event {
                BrainEvent::TranscriptFinal { confidence, .. } => Some(*confidence),
                _ => None,
            })
            .collect::<Vec<_>>();
        if confidences.is_empty() {
            return Err(format!("{response_id} produced no final transcript"));
        }
        for confidence in &confidences {
            if confidence.is_some() != turn.transcript_confidence.is_some() {
                return Err(format!(
                    "{response_id} transcript confidence is {confidence:?} but the fixture publishes {:?}",
                    turn.transcript_confidence
                ));
            }
        }

        // 4. Outcome resolution and the learner facts it authorizes.
        let evaluations = bound
            .iter()
            .filter_map(|event| match event {
                BrainEvent::AnswerEvaluated { evaluation, .. } => Some(evaluation.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let deferrals = bound
            .iter()
            .filter_map(|event| match event {
                BrainEvent::TurnDeferred {
                    question_id,
                    reason,
                    can_retry_same_question,
                    ..
                } => Some((
                    question_id.clone(),
                    reason.clone(),
                    *can_retry_same_question,
                )),
                _ => None,
            })
            .collect::<Vec<_>>();
        let statuses = bound
            .iter()
            .filter_map(|event| match event {
                BrainEvent::ConceptStatus {
                    concept_id, status, ..
                } => Some((concept_id.clone(), status.clone())),
                _ => None,
            })
            .collect::<Vec<_>>();
        let sources = bound
            .iter()
            .filter_map(|event| match event {
                BrainEvent::SourceReference { source, .. } => Some(source.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let audio = bound
            .iter()
            .filter(|event| matches!(event, BrainEvent::AudioDelta { .. }))
            .count();

        match &turn.resolution {
            VoiceFixtureResolution::Evaluated {
                evaluation,
                source,
                concept_statuses,
            } => {
                if !deferrals.is_empty() {
                    return Err(format!("an evaluated {response_id} also deferred"));
                }
                if evaluations.len() != 1 {
                    return Err(format!(
                        "{response_id} emitted {} evaluations, not exactly one",
                        evaluations.len()
                    ));
                }
                if &evaluations[0] != evaluation.as_ref() {
                    return Err(format!(
                        "{response_id} evaluation {:?} != fixture {evaluation:?}",
                        evaluations[0]
                    ));
                }
                if &statuses != concept_statuses {
                    return Err(format!(
                        "{response_id} concept statuses {statuses:?} != fixture {concept_statuses:?}"
                    ));
                }
                if !sources.iter().any(|cited| cited == source.as_ref()) {
                    return Err(format!(
                        "{response_id} cited {sources:?}, not the fixture source {source:?}"
                    ));
                }
            }
            VoiceFixtureResolution::Deferred {
                question_id,
                reason,
                can_retry_same_question,
            } => {
                if !evaluations.is_empty() || !statuses.is_empty() {
                    return Err(format!(
                        "a deferred {response_id} emitted a learner fact: {evaluations:?} {statuses:?}"
                    ));
                }
                if audio != 0 {
                    return Err(format!("a deferred {response_id} spoke {audio} frames"));
                }
                if deferrals.len() != 1 {
                    return Err(format!(
                        "{response_id} emitted {} deferrals, not exactly one",
                        deferrals.len()
                    ));
                }
                if deferrals[0]
                    != (
                        question_id.clone(),
                        reason.clone(),
                        *can_retry_same_question,
                    )
                {
                    return Err(format!(
                        "{response_id} deferral {:?} != fixture ({question_id}, {reason:?}, {can_retry_same_question})",
                        deferrals[0]
                    ));
                }
                if bound
                    .iter()
                    .any(|event| matches!(event, BrainEvent::RecapReady { .. }))
                {
                    return Err(format!("a deferred {response_id} produced a graded recap"));
                }
            }
        }
    }

    // 5. Cancellation legality, and no stale response trailing the next turn.
    for (index, event) in events.iter().enumerate() {
        let BrainEvent::ResponseCancelledFor { response_id } = event else {
            continue;
        };
        let started_earlier = events[..index].iter().any(|earlier| {
            matches!(earlier, BrainEvent::QuestionStarted { response_id: started, .. }
                if started == response_id)
        });
        if !started_earlier {
            return Err(format!(
                "cancellation names {response_id}, which has not started yet"
            ));
        }
    }
    let second_start = events
        .iter()
        .position(|event| {
            matches!(event, BrainEvent::QuestionStarted { response_id, .. }
                if response_id == &contract.turns[1].response_id)
        })
        .expect("the second question start was located above");
    // Nothing but the kinds the fixture itself places after the second question
    // starts may trail it. In these fixtures that is exactly `recap_ready`, the
    // one session-scope projection; a stale transcript, evaluation, status, or
    // audio frame from the previous turn is rejected.
    for event in &events[second_start + 1..] {
        let Some(response_id) = adapter_event_response_id(event) else {
            continue;
        };
        if response_id == contract.turns[1].response_id {
            continue;
        }
        let kind = adapter_event_kind(event);
        if contract.authorized_trailing_kinds.contains(kind) {
            continue;
        }
        return Err(format!(
            "{kind} for {response_id} trails the start of {}",
            contract.turns[1].response_id
        ));
    }

    // 6. Terminal ordering: the session publishes the fixture's number of
    //    recaps, with the fixture's schema and deferral count, nothing
    //    learner-visible trails the recap that the fixture does not itself
    //    place after its own, and the recap precedes the terminal phase.
    let recaps = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            BrainEvent::RecapReady { recap, .. } => Some((index, recap.clone())),
            _ => None,
        })
        .collect::<Vec<_>>();
    if recaps.len() != contract.recap_count {
        return Err(format!(
            "the session published {} recaps but {} publishes {}",
            recaps.len(),
            contract.fixture_id,
            contract.recap_count
        ));
    }
    let Some((recap_index, recap)) = recaps.last() else {
        return Err("the session produced no recap".to_owned());
    };
    if recap.schema != contract.recap_schema {
        return Err(format!(
            "recap schema {} != fixture {}",
            recap.schema, contract.recap_schema
        ));
    }
    // The recap's deferral bucket is the fixture's own number, compared
    // directly. It is additionally held to the law that a recap counts exactly
    // the deferrals that had happened when it was built, so a recap published
    // too early cannot satisfy the fixture by accident.
    if recap.deferred_turns != contract.recap_deferred_turns {
        return Err(format!(
            "recap counts {} deferrals but {} publishes {}",
            recap.deferred_turns, contract.fixture_id, contract.recap_deferred_turns
        ));
    }
    let deferrals_before_recap = events[..*recap_index]
        .iter()
        .filter(|event| matches!(event, BrainEvent::TurnDeferred { .. }))
        .count() as u32;
    if recap.deferred_turns != deferrals_before_recap {
        return Err(format!(
            "recap counts {} deferrals but {deferrals_before_recap} had happened",
            recap.deferred_turns
        ));
    }
    for event in &events[*recap_index + 1..] {
        let kind = adapter_event_kind(event);
        if ADAPTER_LEARNER_VISIBLE_KINDS.contains(&kind)
            && !contract.recap_trailing_kinds.contains(kind)
        {
            return Err(format!(
                "{kind} trails the session recap, which {} publishes last",
                contract.fixture_id
            ));
        }
    }
    let graded = recap
        .concepts
        .iter()
        .map(|concept| (concept.concept_id.clone(), concept.status.clone()))
        .collect::<Vec<_>>();
    let expected_graded = contract
        .recap_concepts
        .iter()
        .filter(|(concept_id, _)| {
            contract.turns.iter().any(|turn| match &turn.resolution {
                VoiceFixtureResolution::Evaluated {
                    concept_statuses, ..
                } => concept_statuses
                    .iter()
                    .any(|(graded_id, _)| graded_id == concept_id),
                VoiceFixtureResolution::Deferred { .. } => false,
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    if graded != expected_graded {
        return Err(format!(
            "recap concepts {graded:?} != the fixture's graded concepts {expected_graded:?}"
        ));
    }
    let moments = recap
        .source_moments
        .iter()
        .map(|moment| (moment.response_id.clone(), moment.source_id.clone()))
        .collect::<Vec<_>>();
    if moments != contract.recap_source_moments {
        return Err(format!(
            "recap source moments {moments:?} != fixture {:?}",
            contract.recap_source_moments
        ));
    }
    let terminal_index = events.iter().rposition(|event| {
        matches!(event, BrainEvent::SessionPhase { phase } | BrainEvent::TerminalSessionPhase { phase, .. }
            if phase == &contract.terminal_phase)
    });
    let Some(terminal_index) = terminal_index else {
        return Err(format!(
            "the session never reached the fixture's terminal phase {:?}",
            contract.terminal_phase
        ));
    };
    if terminal_index < *recap_index {
        return Err("the terminal phase preceded the recap".to_owned());
    }
    Ok(())
}

/// The persisted outcome the fixture's own resolution implies, so a run driven
/// by this store can only match the fixture if the adapter copies the outcome
/// through unchanged.
fn voice_fixture_turn_outcome(turn: &VoiceFixtureTurn) -> TurnOutcome {
    let resolution = match &turn.resolution {
        VoiceFixtureResolution::Evaluated {
            evaluation,
            source,
            concept_statuses,
        } => {
            let _ = source;
            agent_domain::TurnResolution::Evaluated {
                label: match evaluation.label.as_str() {
                    "strong" => agent_domain::EvaluationLabel::Strong,
                    "mostly correct" => agent_domain::EvaluationLabel::MostlyCorrect,
                    "partially correct" => agent_domain::EvaluationLabel::PartiallyCorrect,
                    "vague" => agent_domain::EvaluationLabel::Vague,
                    "wrong" => agent_domain::EvaluationLabel::Wrong,
                    "insufficient evidence" => agent_domain::EvaluationLabel::InsufficientEvidence,
                    other => panic!("the fixture publishes an unknown label `{other}`"),
                },
                confidence: evaluation.confidence_score,
                assessments: turn
                    .question
                    .rubric
                    .criteria
                    .iter()
                    .map(|criterion| agent_domain::CriterionAssessment {
                        criterion_id: criterion.criterion_id.clone(),
                        assessment: agent_domain::CriterionAssessmentKind::Satisfied,
                        confidence: evaluation.confidence_score,
                    })
                    .collect(),
                concept_transitions: concept_statuses
                    .iter()
                    .map(
                        |(concept_id, status)| agent_domain::ConceptStatusTransition {
                            concept_id: concept_id.clone(),
                            from_status: ConceptStatus::Review,
                            to_status: status.clone(),
                            criterion_ids: turn
                                .question
                                .rubric
                                .criteria
                                .iter()
                                .filter(|criterion| &criterion.concept_id == concept_id)
                                .map(|criterion| criterion.criterion_id.clone())
                                .collect(),
                        },
                    )
                    .collect(),
                concise_feedback: evaluation.concise_feedback.clone(),
                retry_prompt: (!evaluation.retry_prompt.is_empty())
                    .then(|| evaluation.retry_prompt.clone()),
                disposition: agent_domain::QuestionDisposition::Advance,
            }
        }
        VoiceFixtureResolution::Deferred {
            reason,
            can_retry_same_question,
            ..
        } => agent_domain::TurnResolution::Deferred {
            reason: reason.clone(),
            can_retry_same_question: *can_retry_same_question,
            disposition: agent_domain::QuestionDisposition::Deferred,
        },
    };
    TurnOutcome {
        schema: agent_domain::learning_outcome::VIVA_TURN_OUTCOME_SCHEMA.to_owned(),
        response_id: turn.response_id.clone(),
        question_id: turn.question.question_id.clone(),
        rubric_policy_version: turn.question.rubric.policy_version.clone(),
        recorded_at: "2026-08-24T16:00:00.000Z".to_owned(),
        source_ids: vec![match &turn.resolution {
            VoiceFixtureResolution::Evaluated { source, .. } => source.source_id.clone(),
            VoiceFixtureResolution::Deferred { .. } => turn.question.source.source_id.clone(),
        }],
        supersedes_response_id: None,
        resolution,
    }
}

fn voice_fixture_store(contract: &VoiceFixtureAdapterContract) -> Arc<FixtureOutcomeStore> {
    let mut sources = Vec::new();
    for turn in &contract.turns {
        for source in [
            Some(turn.question.source.clone()),
            match &turn.resolution {
                VoiceFixtureResolution::Evaluated { source, .. } => Some(source.as_ref().clone()),
                VoiceFixtureResolution::Deferred { .. } => None,
            },
        ]
        .into_iter()
        .flatten()
        {
            if !sources
                .iter()
                .any(|known: &StudySourceReference| known.source_id == source.source_id)
            {
                sources.push(source);
            }
        }
    }
    Arc::new(FixtureOutcomeStore::per_turn(
        contract
            .turns
            .iter()
            .map(|turn| turn.question.clone())
            .collect(),
        sources,
        contract
            .turns
            .iter()
            .map(voice_fixture_turn_outcome)
            .collect(),
    ))
}

/// The learner answers the fixture's own final transcripts, so the emitted
/// evaluation's `answer_text` can be compared with the fixture's.
fn voice_fixture_answers(fixture: &serde_json::Value) -> Vec<String> {
    fixture_server_events(fixture)
        .expect("the fixture's server sequence decodes")
        .iter()
        .filter(|event| event["type"] == "transcript_final")
        .filter_map(|event| event["text"].as_str().map(ToOwned::to_owned))
        .collect()
}

async fn run_two_turn_fixture_session(
    session: &mut RealtimeSession,
    answers: &[String],
) -> Vec<BrainEvent> {
    let mut events = Vec::new();
    // Ready, then the first question.
    events.push(next_event(session).await);
    events.push(next_event(session).await);
    for answer in answers {
        session
            .input
            .send(BrainInput::Text(answer.clone()))
            .await
            .expect("text input accepted");
        while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
            let completed = matches!(event, BrainEvent::ResponseCompleted { .. });
            events.push(event);
            if completed {
                break;
            }
        }
    }
    session.input.send(BrainInput::Stop).await.ok();
    while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
        let terminal = matches!(
            event,
            BrainEvent::SessionPhase {
                phase: agent_domain::StudySessionPhase::Recap
            } | BrainEvent::TerminalSessionPhase { .. }
        );
        events.push(event);
        if terminal {
            break;
        }
    }
    events
}

async fn two_turn_fixture_projection(
    manifest_id: &str,
    runtime: &str,
) -> (VoiceFixtureAdapterContract, Vec<BrainEvent>) {
    let fixture = resolve_voice_fixture(manifest_id);
    let contract = voice_fixture_adapter_contract(&fixture).expect("the fixture contract holds");
    let answers = voice_fixture_answers(&fixture);
    let store = voice_fixture_store(&contract);
    let config = fixture_session_config();
    let mut session = match runtime {
        "fake" => FakeCartesiaGeminiRuntime::new(store)
            .open(config)
            .await
            .expect("the fixture runtime opens"),
        _ => agent_adapters::SyntheticBrain::with_study_store(store)
            .open(config)
            .await
            .expect("the synthetic runtime opens"),
    };
    let events = run_two_turn_fixture_session(&mut session, &answers).await;
    drop(session);
    (contract, events)
}

/// The mutation controls Step 2 requires, run against one real projection.
fn assert_two_turn_mutation_controls(
    contract: &VoiceFixtureAdapterContract,
    events: &[BrainEvent],
) {
    // The projection must be accepted before a rejection means anything.
    adapter_projection_matches_voice_fixture(events, contract)
        .unwrap_or_else(|error| panic!("{error}: {events:?}"));
    assert_eq!(
        contract.recap_deferred_turns,
        contract
            .turns
            .iter()
            .filter(|turn| matches!(turn.resolution, VoiceFixtureResolution::Deferred { .. }))
            .count() as u32,
        "the fixture recap counts exactly the deferrals the fixture publishes"
    );

    // Second-turn response id -> first-turn response id.
    let mut reused = contract.clone();
    reused.turns[1].response_id = reused.turns[0].response_id.clone();
    assert!(
        adapter_projection_matches_voice_fixture(events, &reused).is_err(),
        "reusing the first response id for the second turn must be rejected"
    );

    // Remove the second `QuestionStarted`.
    let second_start = events
        .iter()
        .position(|event| {
            matches!(event, BrainEvent::QuestionStarted { response_id, .. }
                if response_id == &contract.turns[1].response_id)
        })
        .expect("the second turn started a question");
    let mut without_second_start = events.to_vec();
    without_second_start.remove(second_start);
    assert!(
        adapter_projection_matches_voice_fixture(&without_second_start, contract).is_err(),
        "deleting the second question start must be rejected"
    );

    // `confidence: null` -> `0.91`.
    let mut invented_confidence = events.to_vec();
    for event in &mut invented_confidence {
        if let BrainEvent::TranscriptFinal { confidence, .. } = event {
            *confidence = Some(0.91);
        }
    }
    assert!(
        adapter_projection_matches_voice_fixture(&invented_confidence, contract).is_err(),
        "an invented transcript confidence must be rejected"
    );

    // A deferred outcome plus an injected `concept_status`.
    let deferred_response = contract
        .turns
        .iter()
        .find(|turn| matches!(turn.resolution, VoiceFixtureResolution::Deferred { .. }))
        .expect("the fixture publishes a deferred turn")
        .response_id
        .clone();
    let mut injected_status = events.to_vec();
    let deferral_index = injected_status
        .iter()
        .position(|event| {
            matches!(event, BrainEvent::TurnDeferred { response_id, .. }
                if response_id == &deferred_response)
        })
        .expect("the deferred turn emitted its deferral");
    injected_status.insert(
        deferral_index,
        BrainEvent::ConceptStatus {
            response_id: deferred_response.clone(),
            concept_id: "concept-fixture-2".to_owned(),
            status: ConceptStatus::Strong,
        },
    );
    assert!(
        adapter_projection_matches_voice_fixture(&injected_status, contract).is_err(),
        "mastery injected into a deferral must be rejected"
    );

    // An evaluated outcome whose transition status drifts from the fixture.
    let mut drifted_status = events.to_vec();
    for event in &mut drifted_status {
        if let BrainEvent::ConceptStatus { status, .. } = event {
            *status = ConceptStatus::Missed;
        }
    }
    assert!(
        adapter_projection_matches_voice_fixture(&drifted_status, contract).is_err(),
        "a concept status that drifts from the fixture must be rejected"
    );

    // Cancellation naming the replacement context instead of the cancelled one.
    let mut premature_cancel = events.to_vec();
    premature_cancel.insert(
        second_start,
        BrainEvent::ResponseCancelledFor {
            response_id: contract.turns[1].response_id.clone(),
        },
    );
    assert!(
        adapter_projection_matches_voice_fixture(&premature_cancel, contract).is_err(),
        "cancelling the replacement context before it starts must be rejected"
    );

    // The recap bucket changed from the Plan 04 fold.
    let mut drifted_recap = events.to_vec();
    for event in &mut drifted_recap {
        if let BrainEvent::RecapReady { recap, .. } = event {
            recap.deferred_turns = recap.deferred_turns.wrapping_add(1);
        }
    }
    assert!(
        adapter_projection_matches_voice_fixture(&drifted_recap, contract).is_err(),
        "a recap deferral count that drifts from the fixture must be rejected"
    );

    // A per-turn recap published before the session's later turns: the exact
    // shape that reports a stale deferral count to the learner.
    let recap_index = events
        .iter()
        .position(|event| matches!(event, BrainEvent::RecapReady { .. }))
        .expect("the session published its recap");
    let mut early_recap = events.to_vec();
    let mut moved = early_recap.remove(recap_index);
    if let BrainEvent::RecapReady { recap, .. } = &mut moved {
        // A recap built before the second turn could not have counted its
        // deferral, so the mutation carries the count that position implies.
        recap.deferred_turns = 0;
    }
    early_recap.insert(second_start, moved);
    assert!(
        adapter_projection_matches_voice_fixture(&early_recap, contract).is_err(),
        "a recap published before the session's later turns must be rejected"
    );

    // A second recap: a session-scope fold published more than once.
    let mut duplicated_recap = events.to_vec();
    duplicated_recap.insert(recap_index, events[recap_index].clone());
    assert!(
        adapter_projection_matches_voice_fixture(&duplicated_recap, contract).is_err(),
        "publishing the session recap twice must be rejected"
    );
}

#[tokio::test]
async fn synthetic_two_turn_adapter_projection_matches_voice_fixture() {
    let (contract, events) =
        two_turn_fixture_projection("VOICE-SYNTHETIC-TWO-TURN-SESSION", "synthetic").await;
    assert_eq!(contract.provider, "synthetic");
    assert_two_turn_mutation_controls(&contract, &events);
}

#[tokio::test]
async fn fake_cartesia_two_turn_adapter_projection_matches_voice_fixture() {
    let (contract, events) =
        two_turn_fixture_projection("VOICE-FAKE-CARTESIA-GEMINI-TWO-TURN-SESSION", "fake").await;
    assert_eq!(contract.provider, "fake_cartesia_gemini");
    assert_two_turn_mutation_controls(&contract, &events);
}

// --- differential cases and the diagnostics boundary ------------------------

/// Read every `.rs` file under the adapter crate's `src` tree.
fn adapter_source_files() -> Vec<(std::path::PathBuf, String)> {
    fn walk(directory: &std::path::Path, found: &mut Vec<(std::path::PathBuf, String)>) {
        for entry in std::fs::read_dir(directory).expect("the adapter src tree is readable") {
            let path = entry.expect("a readable directory entry").path();
            if path.is_dir() {
                walk(&path, found);
            } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
                let body = std::fs::read_to_string(&path).expect("an adapter source file reads");
                found.push((path, body));
            }
        }
    }
    let mut found = Vec::new();
    walk(
        &repository_root().join("agent/crates/agent-adapters/src"),
        &mut found,
    );
    assert!(!found.is_empty(), "the adapter crate has sources");
    found
}

/// The frozen server-differential cases whose rejection is an adapter-owned
/// domain type's job. Everything else in the corpus is a wire-envelope concern
/// this crate must not restate.
const ADAPTER_OWNED_SERVER_REJECTIONS: [&str; 8] = [
    "VOICE-SERVER-REJECT-MISSING-QUESTION-CONCEPT",
    "VOICE-SERVER-REJECT-EVALUATION-LABEL",
    "VOICE-SERVER-REJECT-EVALUATION-CONFIDENCE",
    "VOICE-SERVER-REJECT-UNKNOWN-RECAP-KEY",
    "VOICE-SERVER-REJECT-UNKNOWN-RECAP-MOMENT-KEY",
    "VOICE-SERVER-REJECT-UNKNOWN-RECAP-CONCEPT-KEY",
    "VOICE-SERVER-REJECT-RECAP-REVIEW-AUTHORITY",
    "VOICE-SERVER-REJECT-DEFERRED-UNKNOWN-REASON",
];

/// Parse every adapter-owned payload a server event carries with the exact
/// domain types this crate consumes. Returns the payloads it recognised so a
/// case cannot pass vacuously.
fn adapter_owned_payload_verdict(event: &serde_json::Value) -> Result<Vec<&'static str>, String> {
    let mut seen = Vec::new();
    if let Some(question) = event.get("question") {
        serde_json::from_value::<StudyQuestion>(question.clone())
            .map_err(|error| format!("question: {error}"))?;
        seen.push("question");
    }
    if let Some(evaluation) = event.get("evaluation") {
        let evaluation: AnswerEvaluation = serde_json::from_value(evaluation.clone())
            .map_err(|error| format!("evaluation: {error}"))?;
        evaluation
            .validate_fail_closed()
            .map_err(|error| format!("evaluation: {error}"))?;
        seen.push("evaluation");
    }
    if let Some(recap) = event.get("recap") {
        serde_json::from_value::<StudySessionRecap>(recap.clone())
            .map_err(|error| format!("recap: {error}"))?;
        seen.push("recap");
    }
    // `structured_error` also carries a `source`, but it is the emitting
    // component's name, not a study source: only the source-reference event
    // publishes an adapter-owned `StudySourceReference`.
    if event["type"] == "source_reference" {
        if let Some(source) = event.get("source") {
            serde_json::from_value::<StudySourceReference>(source.clone())
                .map_err(|error| format!("source: {error}"))?;
            seen.push("source");
        }
    }
    if let Some(frame) = event.get("frame") {
        serde_json::from_value::<AudioFrame>(frame.clone())
            .map_err(|error| format!("frame: {error}"))?;
        seen.push("frame");
    }
    if event["type"] == "concept_status" {
        if let Some(status) = event.get("status") {
            serde_json::from_value::<ConceptStatus>(status.clone())
                .map_err(|error| format!("status: {error}"))?;
            seen.push("status");
        }
    }
    if event["type"] == "turn_deferred" {
        if let Some(reason) = event.get("reason") {
            serde_json::from_value::<agent_domain::EvaluationDeferralReason>(reason.clone())
                .map_err(|error| format!("reason: {error}"))?;
            seen.push("reason");
        }
    }
    Ok(seen)
}

/// The adapter's own closed provider-diagnostic vocabulary (Task 6). It must
/// stay disjoint from the wire diagnostics the fixtures publish.
const ADAPTER_PROVIDER_DIAGNOSTIC_CODES: [&str; 13] = [
    "gemini_http_auth",
    "gemini_http_rate_limited",
    "gemini_http_rejected",
    "cartesia_ink_http_auth",
    "cartesia_ink_http_rate_limited",
    "cartesia_ink_http_rejected",
    "cartesia_ink_ws_closed",
    "cartesia_ink_provider_error",
    "cartesia_sonic_http_auth",
    "cartesia_sonic_http_rate_limited",
    "cartesia_sonic_http_rejected",
    "cartesia_sonic_ws_closed",
    "cartesia_sonic_provider_error",
];

/// Does one frozen transport-outcome case agree with the adapter's own typed
/// auth policy? An unusable credential is terminal for this crate: only an
/// expiry the client can refresh is retryable.
fn transport_outcome_agrees_with_adapter_auth_policy(
    case: &serde_json::Value,
    adapter_auth_retry_eligible: bool,
) -> Result<(), String> {
    if case["expected"]["kind"] != "auth" {
        return Ok(());
    }
    let code = case["expected"]["errorCode"]
        .as_str()
        .ok_or_else(|| "an auth case names no error code".to_owned())?;
    let retryable = case["expected"]["retryable"]
        .as_bool()
        .ok_or_else(|| "an auth case declares no retryability".to_owned())?;
    if code == "VOICE_AUTH_EXPIRED" {
        // The one refreshable credential failure: the client may mint a new
        // token. Everything else is the adapter's non-retryable class.
        return if retryable {
            Ok(())
        } else {
            Err(format!("{code} must stay refreshable"))
        };
    }
    if retryable != adapter_auth_retry_eligible {
        return Err(format!(
            "{code} is retryable={retryable} but the adapter's provider-auth failure is retry_eligible={adapter_auth_retry_eligible}"
        ));
    }
    Ok(())
}

#[test]
fn adapter_consumes_voice_differential_cases_without_redefining_diagnostics() {
    let server = resolve_voice_fixture("VOICE-SERVER-DIFFERENTIAL-CASES");
    let client = resolve_voice_fixture("VOICE-CLIENT-DIFFERENTIAL-CASES");
    let transports = resolve_voice_fixture("VOICE-TRANSPORT-OUTCOMES");
    let sources = adapter_source_files();

    // 1. The wire diagnostics stay Plan 05's and the service's. This crate
    //    names none of them and its own closed provider vocabulary is disjoint.
    let mut wire_codes = std::collections::BTreeSet::new();
    for corpus in [&server, &client] {
        for case in corpus["cases"].as_array().expect("a differential corpus") {
            if let Some(code) = case["diagnostic_code"].as_str() {
                wire_codes.insert(code.to_owned());
            }
        }
    }
    assert!(
        wire_codes.len() >= 8,
        "the corpora publish a diagnostic vocabulary: {wire_codes:?}"
    );
    for code in &wire_codes {
        for (path, body) in &sources {
            assert!(
                !body.contains(code.as_str()),
                "{} redefines the wire diagnostic {code}",
                path.display()
            );
        }
        assert!(
            !ADAPTER_PROVIDER_DIAGNOSTIC_CODES.contains(&code.as_str()),
            "the adapter's provider vocabulary collides with the wire code {code}"
        );
    }

    // 2. Every server case is consumed by the adapter-owned domain types.
    let cases = server["cases"].as_array().expect("server cases");
    let mut accepted_payloads = std::collections::BTreeSet::new();
    let mut adapter_rejections = std::collections::BTreeSet::new();
    for case in cases {
        let id = case["id"].as_str().expect("a case names an id");
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(
            case["wire_json"].as_str().expect("a case names wire JSON"),
        ) else {
            // A malformed-JSON case is an envelope concern by construction.
            assert_eq!(case["valid"], json!(false), "{id}");
            continue;
        };
        let Some(event) = frame.get("event") else {
            continue;
        };
        let verdict = adapter_owned_payload_verdict(event);
        if case["valid"] == json!(true) {
            let payloads = verdict.unwrap_or_else(|error| {
                panic!("{id} is valid but the adapter refused it: {error}")
            });
            accepted_payloads.extend(payloads.into_iter().map(ToOwned::to_owned));
        } else if verdict.is_err() {
            adapter_rejections.insert(id.to_owned());
        }
    }
    for payload in [
        "question",
        "evaluation",
        "recap",
        "source",
        "frame",
        "status",
        "reason",
    ] {
        assert!(
            accepted_payloads.contains(payload),
            "the corpus never exercised the adapter-owned `{payload}` payload"
        );
    }
    for id in ADAPTER_OWNED_SERVER_REJECTIONS {
        assert!(
            cases
                .iter()
                .any(|case| case["id"] == id && case["valid"] == json!(false)),
            "the corpus must still publish the invalid case {id}"
        );
        assert!(
            adapter_rejections.contains(id),
            "{id} must be rejected by the adapter's own domain type"
        );
    }

    // 3. The client corpus is consumed as a strict-v5 guard and as evidence
    //    that no client credential reaches this crate. Client frames are the
    //    service's to parse; the adapter never sees one.
    let client_cases = client["cases"].as_array().expect("client cases");
    assert!(client_cases.len() >= 10);
    let mut valid_client_frames = 0_u32;
    for case in client_cases {
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(
            case["wire_json"].as_str().expect("a case names wire JSON"),
        ) else {
            assert_eq!(case["valid"], json!(false), "{}", case["id"]);
            continue;
        };
        if case["valid"] == json!(true) {
            assert_eq!(
                frame["version"],
                json!(5),
                "{} is valid but not strict v5",
                case["id"]
            );
            valid_client_frames += 1;
        }
    }
    assert!(valid_client_frames >= 8);
    for (path, body) in &sources {
        assert!(
            !body.contains("session_token"),
            "{} names the client session credential",
            path.display()
        );
    }

    // 4. The frozen transport outcomes agree with the adapter's own typed auth
    //    policy, read out of the real live composition rather than restated.
    let adapter_auth_retry_eligible = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a current-thread runtime")
        .block_on(async {
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
                learning_ready_store(),
            );
            let error = brain
                .open(fixture_session_config())
                .await
                .err()
                .expect("an unusable credential never opens a session");
            let failure = error.failure();
            assert_eq!(
                failure.failure_class(),
                BrainFailureClass::ProviderAuthFailure
            );
            assert_eq!(
                failure.terminal_reason(),
                TerminalSessionReason::ProviderAuthFailed
            );
            failure.retry_eligible()
        });
    assert!(
        !adapter_auth_retry_eligible,
        "the adapter's provider-auth failure is terminal"
    );

    let transport_cases = transports["cases"].as_array().expect("transport cases");
    let auth_cases = transport_cases
        .iter()
        .filter(|case| case["expected"]["kind"] == "auth")
        .count();
    assert!(auth_cases >= 3, "the corpus publishes auth terminations");
    for case in transport_cases {
        transport_outcome_agrees_with_adapter_auth_policy(case, adapter_auth_retry_eligible)
            .unwrap_or_else(|error| panic!("{}: {error}", case["id"]));
    }

    // Mutation control: provider auth retryable false -> true.
    let mut promoted = transport_cases
        .iter()
        .find(|case| case["expected"]["errorCode"] == "VOICE_AUTH_INVALID")
        .expect("the corpus publishes an invalid-credential termination")
        .clone();
    promoted["expected"]["retryable"] = json!(true);
    assert!(
        transport_outcome_agrees_with_adapter_auth_policy(&promoted, adapter_auth_retry_eligible)
            .is_err(),
        "promoting an unusable credential to retryable must be rejected"
    );
}

// --- the Plan 04 learning-core corpus --------------------------------------

#[test]
fn adapter_consumes_learning_core_v1_outcomes_recaps_and_progression() {
    let outcomes: serde_json::Value =
        serde_json::from_str(LEARNING_CORE_TURN_OUTCOMES_V1).expect("the outcome corpus parses");
    assert_eq!(outcomes["schema"], "viva.learning_core.turn_outcomes.v1");

    // Every outcome case is a `TurnOutcome` this crate can project.
    let mut deferral_reasons = std::collections::BTreeSet::new();
    let mut evaluated = 0_u32;
    for (case_id, case) in outcomes["outcomes"]
        .as_object()
        .expect("the corpus publishes outcomes")
    {
        let outcome: TurnOutcome = serde_json::from_value(case.clone())
            .unwrap_or_else(|error| panic!("{case_id} does not parse: {error}"));
        assert_eq!(
            outcome.schema,
            agent_domain::learning_outcome::VIVA_TURN_OUTCOME_SCHEMA,
            "{case_id}"
        );
        match &outcome.resolution {
            agent_domain::TurnResolution::Evaluated {
                concept_transitions,
                ..
            } => {
                assert!(
                    !concept_transitions.is_empty(),
                    "{case_id}: an evaluated outcome names its transitions"
                );
                evaluated += 1;
            }
            agent_domain::TurnResolution::Deferred { reason, .. } => {
                deferral_reasons.insert(format!("{reason:?}"));
            }
        }
    }
    assert!(evaluated >= 5, "the corpus publishes evaluated cases");
    assert_eq!(
        deferral_reasons.len(),
        6,
        "the corpus covers all six deferral reasons: {deferral_reasons:?}"
    );

    // The persisted wrapper the adapter deserializes, receipt included.
    for (case_id, case) in outcomes["persisted"]
        .as_object()
        .expect("the corpus publishes persisted records")
    {
        let persisted: PersistedTurnOutcome = serde_json::from_value(case.clone())
            .unwrap_or_else(|error| panic!("{case_id} does not parse: {error}"));
        assert_eq!(
            persisted.record.schema,
            agent_domain::learning_outcome::VIVA_TURN_OUTCOME_RECORD_SCHEMA,
            "{case_id}"
        );
        assert_eq!(
            persisted.record.response_id, persisted.turn_outcome.response_id,
            "{case_id}: the receipt names the outcome's own response"
        );
    }
    for (case_id, case) in outcomes["challenges"]
        .as_object()
        .expect("the corpus publishes challenge resolutions")
    {
        let challenge: agent_domain::ChallengeResolution = serde_json::from_value(case.clone())
            .unwrap_or_else(|error| panic!("{case_id} does not parse: {error}"));
        assert_eq!(
            challenge.schema,
            agent_domain::learning_outcome::VIVA_CHALLENGE_RESOLUTION_SCHEMA,
            "{case_id}"
        );
    }

    // Mutation control: a deferred outcome plus an injected transition fails
    // closed before it could become a learner fact.
    let mut injected = outcomes["outcomes"]["deferred_evaluator_unavailable"].clone();
    assert!(
        serde_json::from_value::<TurnOutcome>(injected.clone()).is_ok(),
        "the unmutated deferred case parses"
    );
    injected["resolution"]["concept_transitions"] = json!([{
        "concept_id": "concept-proton-gradient",
        "from_status": "review",
        "to_status": "strong",
        "criterion_ids": ["crit-etc-gradient"],
    }]);
    assert!(
        serde_json::from_value::<TurnOutcome>(injected).is_err(),
        "mastery injected into a deferral must fail closed"
    );

    // Recaps: the adapter builds its recap only through Plan 04's fold, so the
    // fold must reproduce every published recap exactly.
    let recaps: serde_json::Value =
        serde_json::from_str(LEARNING_CORE_RECAPS_V1).expect("the recap corpus parses");
    assert_eq!(recaps["schema"], "viva.learning_core.recaps.v1");
    let published = recaps["recaps"].as_object().expect("published recaps");
    assert!(published.len() >= 8);
    for (case_id, expected) in published {
        let evidence: SessionLearningEvidence =
            serde_json::from_value(recaps["evidence"][case_id].clone())
                .unwrap_or_else(|error| panic!("{case_id} evidence does not parse: {error}"));
        let expected: StudySessionRecap = serde_json::from_value(expected.clone())
            .unwrap_or_else(|error| panic!("{case_id} recap does not parse: {error}"));
        let built = agent_domain::build_session_recap(&evidence)
            .unwrap_or_else(|error| panic!("{case_id} does not fold: {error:?}"));
        assert_eq!(built, expected, "{case_id}");
        assert_eq!(
            built.schema,
            agent_domain::learning_recap::VIVA_STUDY_SESSION_RECAP_SCHEMA
        );
    }

    // Mutation control: an evaluated transition changed from the Plan 04
    // fixture no longer folds to the published recap.
    let mut drifted: SessionLearningEvidence =
        serde_json::from_value(recaps["evidence"]["mixed_strong_shaky_missed"].clone())
            .expect("the mixed case parses");
    let mut mutated_any = false;
    for outcome in &mut drifted.outcomes {
        if let agent_domain::TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &mut outcome.resolution
        {
            for transition in concept_transitions.iter_mut() {
                if transition.to_status != ConceptStatus::Strong {
                    transition.to_status = ConceptStatus::Strong;
                    mutated_any = true;
                }
            }
        }
    }
    assert!(
        mutated_any,
        "the mixed case carries a non-strong transition"
    );
    let expected: StudySessionRecap =
        serde_json::from_value(recaps["recaps"]["mixed_strong_shaky_missed"].clone())
            .expect("the mixed recap parses");
    assert_ne!(
        agent_domain::build_session_recap(&drifted).expect("the mutated evidence still folds"),
        expected,
        "a transition changed from the Plan 04 fixture must change the recap"
    );

    // Progression: D-02B ordered_v1, consumed exactly as the runner consumes it.
    let progression: serde_json::Value =
        serde_json::from_str(LEARNING_CORE_QUESTION_PROGRESSION_V1)
            .expect("the progression corpus parses");
    assert_eq!(
        progression["schema"],
        "viva.learning_core.question_progression.v1"
    );
    assert_eq!(
        progression["policy"], "ordered_v1",
        "D-02B selects the ordered progression"
    );
    let active = progression["active_question_ids"]
        .as_array()
        .expect("active question ids")
        .iter()
        .map(|value| value.as_str().expect("an id").to_owned())
        .collect::<Vec<_>>();
    for (case_id, case) in progression["cursors"]
        .as_object()
        .expect("published cursors")
    {
        let cursor: agent_domain::QuestionProgressionCursor = serde_json::from_value(case.clone())
            .unwrap_or_else(|error| panic!("{case_id} cursor does not parse: {error}"));
        assert_eq!(cursor.policy, ProgressionPolicyId::OrderedV1, "{case_id}");
    }
    let mut selected_questions = Vec::new();
    for (case_id, case) in progression["results"]
        .as_object()
        .expect("published results")
    {
        let result: QuestionProgressionResult = serde_json::from_value(case.clone())
            .unwrap_or_else(|error| panic!("{case_id} result does not parse: {error}"));
        match result {
            QuestionProgressionResult::Selected { question, .. }
            | QuestionProgressionResult::Retry { question, .. } => {
                assert!(
                    active.contains(&question.question_id),
                    "{case_id} selects the inactive question {}",
                    question.question_id
                );
                selected_questions.push(question.question_id);
            }
            QuestionProgressionResult::Exhausted {
                completed, total, ..
            } => {
                assert_eq!(completed, total, "{case_id}");
            }
        }
    }
    selected_questions.sort();
    selected_questions.dedup();
    assert_eq!(
        selected_questions.len(),
        active.len(),
        "the corpus exercises every active question"
    );
    for inactive in progression["inactive_question_ids"]
        .as_array()
        .expect("inactive question ids")
    {
        assert!(
            !selected_questions.iter().any(|id| json!(id) == *inactive),
            "an archived question was selected: {inactive}"
        );
    }
}

// --- the `#[cfg(test)]` PCM fixture helper ---------------------------------

/// The adapter's only test-side PCM constructor.
///
/// Production adapter code builds frames through Plan 06's byte/base64
/// constructors and reads them back through the borrowed `pcm16_base64()`
/// accessor; `AudioFrame::from_pcm16_text` is gone and this helper deliberately
/// does not bring it back. An odd byte count is not PCM16 at all, so it is
/// refused before any frame exists.
fn pcm16_fixture_frame(pcm16: &[u8]) -> Result<AudioFrame, String> {
    if !pcm16.len().is_multiple_of(2) {
        return Err(format!(
            "PCM16 needs whole samples; {} bytes is not a sample boundary",
            pcm16.len()
        ));
    }
    Ok(AudioFrame::from_pcm16_bytes(pcm16.to_vec()))
}

#[test]
fn adapter_pcm16_fixture_helper_rejects_odd_byte_length() {
    for even in [
        Vec::new(),
        vec![0_u8, 0],
        vec![1_u8, 2, 3, 4],
        vec![0xff_u8; 64],
    ] {
        let frame = pcm16_fixture_frame(&even).expect("an even byte count is PCM16");
        assert_eq!(frame.pcm16_bytes(), &even[..]);
        // The borrowed accessor is the only way production code reads it back,
        // and it round-trips through Plan 06's base64 constructor.
        assert_eq!(
            AudioFrame::from_base64(frame.pcm16_base64()).expect("cached base64 decodes"),
            frame
        );
    }
    for odd in [vec![0_u8], vec![1_u8, 2, 3], vec![0xab_u8; 65]] {
        let error = pcm16_fixture_frame(&odd).expect_err("an odd byte count is not PCM16");
        assert!(error.contains("sample boundary"), "{error}");
    }

    // Production adapter code reaches `AudioFrame` only through Plan 06's two
    // byte/base64 constructors — there is no text constructor to reach for —
    // and reads it only through the published borrowed accessors.
    const ALLOWED_FRAME_ASSOCIATED: [&str; 2] = ["from_pcm16_bytes", "from_base64"];
    const ALLOWED_FRAME_ACCESSORS: [&str; 3] = ["pcm16_bytes", "pcm16_bytes_owned", "pcm16_base64"];
    let sources = adapter_source_files();
    let mut associated_seen = std::collections::BTreeSet::new();
    for (path, body) in &sources {
        assert!(
            !body.contains("from_pcm16_text"),
            "{} names the removed text constructor",
            path.display()
        );
        for (offset, _) in body.match_indices("AudioFrame::") {
            let tail = &body[offset + "AudioFrame::".len()..];
            let name = tail
                .split(|character: char| !character.is_alphanumeric() && character != '_')
                .next()
                .unwrap_or_default();
            assert!(
                ALLOWED_FRAME_ASSOCIATED.contains(&name),
                "{} builds an AudioFrame through `{name}`",
                path.display()
            );
            associated_seen.insert(name.to_owned());
        }
        for (offset, _) in body.match_indices(".pcm16") {
            let tail = &body[offset + 1..];
            let name = tail
                .split(|character: char| !character.is_alphanumeric() && character != '_')
                .next()
                .unwrap_or_default();
            assert!(
                ALLOWED_FRAME_ACCESSORS.contains(&name),
                "{} reads an AudioFrame through `{name}`",
                path.display()
            );
        }
    }
    assert!(
        associated_seen.len() == ALLOWED_FRAME_ASSOCIATED.len(),
        "both Plan 06 constructors are exercised by production adapter code: {associated_seen:?}"
    );
    // `agent-domain` gained no fixtures feature to make this helper shared.
    let manifest =
        std::fs::read_to_string(repository_root().join("agent/crates/agent-domain/Cargo.toml"))
            .expect("the domain manifest reads");
    assert!(
        !manifest.contains("[features]") && !manifest.contains("fixtures"),
        "agent-domain must not grow a fixtures feature for this helper"
    );
}

// ---------------------------------------------------------------------------
// Task 11 (`ADAPTER-11`): frozen characterization traces.
//
// These are deliberately GREEN characterization, not fabricated RED tests. They
// exist to prove that the responsibility extraction that follows changes no
// event order, payload, provider request, fallback choice, retry policy,
// timeout/cancel/close behaviour, outcome projection, or public construction.
//
// No trace snapshots a raw provider string: identities, typed classifications,
// bounded allowlisted metadata, and counts only.
// ---------------------------------------------------------------------------

/// One canonical line per emitted domain event.
fn canonical_event_line(event: &BrainEvent) -> String {
    match event {
        BrainEvent::SessionPhase { phase } => format!("session_phase:{phase:?}"),
        BrainEvent::TerminalSessionPhase {
            phase,
            terminal_reason,
        } => format!("terminal_session_phase:{phase:?}:{terminal_reason:?}"),
        BrainEvent::QuestionStarted {
            response_id,
            question,
        } => format!(
            "question_started:{response_id}:{}:{}:criteria={}",
            question.question_id,
            question.concept_id,
            question.rubric.criteria.len()
        ),
        BrainEvent::TranscriptDelta { response_id, .. } => {
            format!("transcript_delta:{response_id}")
        }
        BrainEvent::TranscriptFinal {
            response_id,
            confidence,
            ..
        } => format!(
            "transcript_final:{response_id}:confidence={}",
            confidence.map_or_else(|| "none".to_owned(), |value| format!("{value}"))
        ),
        BrainEvent::ResponseTranscriptDelta { response_id, .. } => {
            format!("response_transcript_delta:{response_id}")
        }
        BrainEvent::ResponseTextStarted { response_id } => {
            format!("response_text_started:{response_id}")
        }
        BrainEvent::AnswerEvaluated {
            response_id,
            evaluation,
        } => format!(
            "answer_evaluated:{response_id}:{}:label={}:status={:?}:confidence={}:source={}",
            evaluation.question_id,
            evaluation.label,
            evaluation.concept_status,
            evaluation.confidence_score,
            evaluation.source.source_id
        ),
        BrainEvent::TurnDeferred {
            response_id,
            question_id,
            reason,
            can_retry_same_question,
        } => format!(
            "turn_deferred:{response_id}:{question_id}:{reason:?}:retry={can_retry_same_question}"
        ),
        BrainEvent::SourceReference {
            response_id,
            source,
        } => format!("source_reference:{response_id}:{}", source.source_id),
        BrainEvent::ConceptStatus {
            response_id,
            concept_id,
            status,
        } => format!("concept_status:{response_id}:{concept_id}={status:?}"),
        BrainEvent::ManuscriptIntent {
            response_id,
            intent,
        } => format!(
            "manuscript_intent:{response_id}:{}",
            manuscript_kind(intent)
        ),
        BrainEvent::AudioDelta { response_id, frame } => format!(
            "audio_delta:{response_id}:bytes={}",
            frame.pcm16_bytes().len()
        ),
        BrainEvent::ResponseAudio { response_id, frame } => format!(
            "response_audio:{response_id}:bytes={}",
            frame.pcm16_bytes().len()
        ),
        BrainEvent::RecapReady { response_id, recap } => format!(
            "recap_ready:{response_id}:concepts={}:moments={}:deferred={}",
            recap.concepts.len(),
            recap.source_moments.len(),
            recap.deferred_turns
        ),
        BrainEvent::ResponseStarted { response_id } => format!("response_started:{response_id}"),
        BrainEvent::ResponseCompleted { response_id } => {
            format!("response_completed:{response_id}")
        }
        BrainEvent::ResponseCancelledFor { response_id } => format!("cancellation:{response_id}"),
        BrainEvent::ResponseCancelled => "cancellation:session".to_owned(),
        BrainEvent::ResponseToolProposal {
            response_id,
            proposal,
        } => format!("tool_proposal:{response_id}:{}", proposal.name()),
        BrainEvent::ProviderFallbackActivated {
            response_id,
            provider,
            from_model,
            to_model,
            reason,
            failure,
        } => format!(
            "provider_fallback:{response_id}:{provider}:{from_model}->{to_model}:{reason}:{}",
            failure
                .as_ref()
                .map_or_else(|| "none".to_owned(), canonical_failure_line)
        ),
        BrainEvent::Error(error) => format!(
            "error:{}",
            error
                .failure
                .as_ref()
                .map_or_else(|| "untyped".to_owned(), canonical_failure_line)
        ),
        BrainEvent::Usage(usage) => format!(
            "usage:text_in={}:text_out={}:corrections={}",
            usage.text_input_tokens,
            usage.text_output_tokens,
            usage.source_grounded_correction_count
        ),
        BrainEvent::InputSpeechStarted => "input_speech_started".to_owned(),
        BrainEvent::InputSpeechStopped => "input_speech_stopped".to_owned(),
        BrainEvent::SpeechIntent(_) => "speech_intent".to_owned(),
        BrainEvent::Transcript(_) => "transcript".to_owned(),
        // `BrainEvent` is `#[non_exhaustive]`. A variant this crate does not
        // know is a trace hole, so it is named loudly rather than swallowed.
        other => panic!("unclassified domain event in the frozen trace: {other:?}"),
    }
}

/// A typed failure rendered by its classification only. `metadata()` is Plan
/// 06-sanitized and Task 6-allowlisted, so it carries closed adapter tokens
/// rather than provider prose.
fn canonical_failure_line(failure: &agent_domain::BrainProviderFailure) -> String {
    format!(
        "class={:?}:stage={:?}:terminal={:?}:retry={}:provider={}:metadata={}",
        failure.failure_class(),
        failure.stage(),
        failure.terminal_reason(),
        failure.retry_eligible(),
        failure.provider(),
        failure.metadata()
    )
}

fn manuscript_kind(intent: &ManuscriptIntent) -> String {
    match intent {
        ManuscriptIntent::Scene {
            register, emphasis, ..
        } => format!("scene:{register:?}:{emphasis:?}"),
        ManuscriptIntent::Entity {
            entity_id,
            entity_kind,
            register,
            emphasis,
        } => format!("entity:{entity_id}:{entity_kind:?}:{register:?}:{emphasis:?}"),
        ManuscriptIntent::Marginalia {
            marginalia_id,
            anchor_entity_id,
            register,
            emphasis,
        } => format!("marginalia:{marginalia_id}:{anchor_entity_id}:{register:?}:{emphasis:?}"),
    }
}

fn canonical_event_trace(events: &[BrainEvent]) -> Vec<String> {
    events.iter().map(canonical_event_line).collect()
}

#[tokio::test]
async fn two_turn_live_orchestration_trace_is_stable_across_extraction() {
    // (a) The frozen voice fixture drives both turns: the store answers with the
    //     fixture's own questions and resolutions, so this trace is the
    //     orchestration the fixture publishes.
    let (_, fixture_events) =
        two_turn_fixture_projection("VOICE-FAKE-CARTESIA-GEMINI-TWO-TURN-SESSION", "fake").await;
    assert_eq!(
        canonical_event_trace(&fixture_events),
        vec![
            "session_phase:Ready",
            "question_started:response-1:q-fixture-1:concept-fixture-1:criteria=1",
            "input_speech_started",
            "session_phase:Listening",
            "transcript_final:response-1:confidence=none",
            "input_speech_stopped",
            "session_phase:Thinking",
            "manuscript_intent:response-1:entity:nadh:Concept:Correcting:Marked",
            "source_reference:response-1:src-lecture-5-slide-18",
            "answer_evaluated:response-1:q-fixture-1:label=mostly correct:status=Strong:confidence=0.9:source=src-lecture-5-slide-18",
            "concept_status:response-1:concept-fixture-1=Strong",
            "usage:text_in=20:text_out=10:corrections=1",
            "audio_delta:response-1:bytes=4",
            "session_phase:Feedback",
            "session_phase:Correction",
            "response_completed:response-1",
            "question_started:response-2:q-fixture-2:concept-fixture-2:criteria=1",
            "input_speech_started",
            "session_phase:Listening",
            "transcript_final:response-2:confidence=none",
            "input_speech_stopped",
            "session_phase:Thinking",
            "manuscript_intent:response-2:entity:nadh:Concept:Correcting:Marked",
            "turn_deferred:response-2:q-fixture-2:EvaluatorUnavailable:retry=true",
            "usage:text_in=20:text_out=10:corrections=1",
            "session_phase:Feedback",
            "session_phase:Correction",
            "response_completed:response-2",
            "recap_ready:response-0:concepts=1:moments=1:deferred=1",
            "session_phase:Recap",
        ],
        "{fixture_events:?}"
    );

    // (b) The frozen learning-core corpus drives both turns through the seeded
    //     study store: the same orchestration, with the corpus's own rotation
    //     choosing each turn's verdict.
    let store = learning_ready_store();
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime.open(fixture_session_config()).await.unwrap();
    let mut learning_events = vec![next_event(&mut session).await];
    for answer in ["first corpus answer", "second corpus answer"] {
        session
            .input
            .send(BrainInput::Text(answer.to_owned()))
            .await
            .unwrap();
        while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
            let completed = matches!(event, BrainEvent::ResponseCompleted { .. });
            learning_events.push(event);
            if completed {
                break;
            }
        }
    }
    session.input.send(BrainInput::Stop).await.ok();
    while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
        learning_events.push(event);
    }
    drop(session);
    assert_eq!(
        canonical_event_trace(&learning_events),
        vec![
            "session_phase:Ready",
            "question_started:response-1:q-oxidative-phosphorylation-nadh:concept-oxidative-phosphorylation:criteria=2",
            "input_speech_started",
            "session_phase:Listening",
            "transcript_final:response-1:confidence=none",
            "input_speech_stopped",
            "session_phase:Thinking",
            "manuscript_intent:response-1:entity:nadh:Concept:Correcting:Marked",
            "source_reference:response-1:src-lecture-5-slide-18",
            "answer_evaluated:response-1:q-oxidative-phosphorylation-nadh:label=strong:status=Strong:confidence=0.9:source=src-lecture-5-slide-18",
            "concept_status:response-1:concept-oxidative-phosphorylation=Strong",
            "usage:text_in=20:text_out=10:corrections=1",
            "audio_delta:response-1:bytes=4",
            "session_phase:Feedback",
            "session_phase:Correction",
            "response_completed:response-1",
            "question_started:response-2:q-oxidative-phosphorylation-atp:concept-oxidative-phosphorylation:criteria=2",
            "input_speech_started",
            "session_phase:Listening",
            "transcript_final:response-2:confidence=none",
            "input_speech_stopped",
            "session_phase:Thinking",
            "manuscript_intent:response-2:entity:nadh:Concept:Correcting:Marked",
            "source_reference:response-2:src-lecture-5-slide-18",
            "answer_evaluated:response-2:q-oxidative-phosphorylation-atp:label=strong:status=Strong:confidence=0.9:source=src-lecture-5-slide-18",
            "concept_status:response-2:concept-oxidative-phosphorylation=Strong",
            "usage:text_in=20:text_out=10:corrections=1",
            "audio_delta:response-2:bytes=4",
            "session_phase:Feedback",
            "session_phase:Correction",
            "response_completed:response-2",
            "recap_ready:response-0:concepts=1:moments=2:deferred=0",
            "session_phase:Recap",
        ],
        "{learning_events:?}"
    );
}

/// A loopback HTTP/1.1 responder that answers every request with one canned
/// status and body. It exists so a live composition can be driven into a typed
/// HTTP failure without a network or a key.
struct LoopbackHttpServer {
    base_url: String,
    requests: Arc<std::sync::atomic::AtomicU32>,
}

impl LoopbackHttpServer {
    async fn start(status_line: &'static str, body: &'static str) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port is available");
        let port = listener.local_addr().expect("bound address").port();
        let requests = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let served = Arc::clone(&requests);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let served = Arc::clone(&served);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut scratch = [0_u8; 4096];
                    let mut buffer = Vec::new();
                    loop {
                        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                        match stream.read(&mut scratch).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => buffer.extend_from_slice(&scratch[..read]),
                        }
                    }
                    served.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let response = format!(
                        "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.flush().await;
                });
            }
        });
        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            requests,
        }
    }

    fn requests(&self) -> u32 {
        self.requests.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// A loopback WebSocket endpoint that completes the upgrade and then closes with
/// a fixed code and a hostile reason. It drives a typed provider close without a
/// network or a key.
struct LoopbackClosingWebSocket {
    url: String,
    connections: Arc<std::sync::atomic::AtomicU32>,
}

impl LoopbackClosingWebSocket {
    async fn start(close_code: u16, reason: &'static str) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port is available");
        let port = listener.local_addr().expect("bound address").port();
        let connections = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let accepted = Arc::clone(&connections);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let accepted = Arc::clone(&accepted);
                tokio::spawn(async move {
                    use futures_util::{SinkExt, StreamExt};
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    accepted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    // Take the client's whole turn first — the audio frames and
                    // the close command — so the hang-up lands on a connected
                    // socket rather than on a half-written request.
                    while let Some(Ok(message)) = socket.next().await {
                        if message.is_text() {
                            break;
                        }
                    }
                    let _ = socket
                        .send(tokio_tungstenite::tungstenite::Message::Close(Some(
                            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                code: close_code.into(),
                                reason: reason.into(),
                            },
                        )))
                        .await;
                    let _ = socket.flush().await;
                });
            }
        });
        Self {
            url: format!("ws://127.0.0.1:{port}"),
            connections,
        }
    }

    fn connections(&self) -> u32 {
        self.connections.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// A live composition that reaches only loopback endpoints. It is a live
/// *runtime*, not a live *provider*: no key is real and no request leaves the
/// machine.
fn loopback_live_config(
    gemini_base_url: &str,
    ink_url: &str,
    sonic_url: &str,
) -> CartesiaGeminiConfig {
    CartesiaGeminiConfig {
        cartesia_api_key: "cartesia-loopback-key".to_owned(),
        gemini: GeminiConfig {
            api_key: "gemini-loopback-key".to_owned(),
            base_url: gemini_base_url.to_owned(),
            fallback_model_ids: Vec::new(),
            ..GeminiConfig::default()
        },
        ink: InkConfig {
            websocket_url: ink_url.to_owned(),
            ..InkConfig::default()
        },
        sonic: SonicConfig {
            websocket_url: sonic_url.to_owned(),
            ..SonicConfig::default()
        },
        live_runtime_enabled: true,
        cartesia_zero_data_retention_enabled: true,
        gemini_zero_data_retention_approved: true,
        ..CartesiaGeminiConfig::default()
    }
}

/// Drive one turn to its first terminal marker and return everything emitted.
async fn drain_turn(session: &mut RealtimeSession, input: BrainInput) -> Vec<BrainEvent> {
    session.input.send(input).await.expect("input accepted");
    let mut events = Vec::new();
    while let Ok(Some(event)) = timeout(Duration::from_secs(10), session.events.recv()).await {
        let terminal = matches!(
            event,
            BrainEvent::ResponseCompleted { .. } | BrainEvent::Error(_)
        );
        events.push(event);
        if terminal {
            break;
        }
    }
    events
}

#[tokio::test]
async fn evaluated_deferred_cancel_and_error_projection_trace_is_stable() {
    // 1. One evaluated outcome, projected from the persisted Plan 04 record,
    //    and the session recap the learner's Stop folds out of it.
    let evaluated = run_fixture_outcome_turn_then_stop(Arc::new(FixtureOutcomeStore::new(
        learning_core_question(),
        learning_core_sources(),
        learning_core_turn_outcome("evaluated_optional_contradiction_is_shaky"),
    )))
    .await;
    assert_eq!(
        canonical_event_trace(&evaluated),
        vec![
            "session_phase:Ready",
            "question_started:response-1:q-etc-electron-flow:concept-electron-transport-chain:criteria=4",
            "input_speech_started",
            "session_phase:Listening",
            "transcript_final:response-1:confidence=none",
            "input_speech_stopped",
            "session_phase:Thinking",
            "manuscript_intent:response-1:entity:nadh:Concept:Correcting:Marked",
            "source_reference:response-1:src-lec5-slide-18",
            "answer_evaluated:response-1:q-etc-electron-flow:label=mostly correct:status=Strong:confidence=0.9:source=src-lec5-slide-18",
            "concept_status:response-1:concept-electron-transport-chain=Strong",
            "concept_status:response-1:concept-proton-gradient=Shaky",
            "usage:text_in=20:text_out=10:corrections=1",
            "audio_delta:response-1:bytes=4",
            "session_phase:Feedback",
            "session_phase:Correction",
            "response_completed:response-1",
            "recap_ready:response-0:concepts=2:moments=3:deferred=0",
            "session_phase:Recap",
        ],
        "{evaluated:?}"
    );

    // 2. One durable deferred outcome: a recovery signal with no learner fact,
    //    no speech, and no graded recap.
    let deferred = run_fixture_outcome_turn(Arc::new(FixtureOutcomeStore::new(
        learning_core_question(),
        learning_core_sources(),
        learning_core_turn_outcome("deferred_insufficient_semantic_evidence"),
    )))
    .await;
    assert_eq!(
        canonical_event_trace(&deferred),
        vec![
            "session_phase:Ready",
            "question_started:response-1:q-etc-electron-flow:concept-electron-transport-chain:criteria=4",
            "input_speech_started",
            "session_phase:Listening",
            "transcript_final:response-1:confidence=none",
            "input_speech_stopped",
            "session_phase:Thinking",
            "manuscript_intent:response-1:entity:nadh:Concept:Correcting:Marked",
            "turn_deferred:response-1:q-etc-electron-flow:InsufficientSemanticEvidence:retry=true",
            "usage:text_in=20:text_out=10:corrections=1",
            "session_phase:Feedback",
            "session_phase:Correction",
            "response_completed:response-1",
        ],
        "{deferred:?}"
    );

    // 3. One barge-in: the replaced response is cancelled and its audio is
    //    suppressed before the replacement turn starts.
    let (store, session_config) = fixture_store_and_session().await;
    let runtime = FakeCartesiaGeminiRuntime::new(store);
    let mut session = runtime
        .open_scripted_session(session_config, FakeSessionScenario::BargeInDuringSonicAudio)
        .expect("the scripted session opens");
    let mut barge_in = Vec::new();
    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            1_u8, 2, 3, 4,
        ])))
        .await
        .unwrap();
    for _ in 0..3 {
        barge_in.push(next_event(&mut session).await);
    }
    session
        .input
        .send(BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![
            5_u8, 6, 7, 8,
        ])))
        .await
        .unwrap();
    barge_in.push(next_event(&mut session).await);
    barge_in.extend(remaining_events(&mut session).await);
    drop(session);
    assert_eq!(
        canonical_event_trace(&barge_in),
        vec![
            "input_speech_started",
            "transcript_final:fake-cartesia-gemini-session-response-1:confidence=none",
            "usage:text_in=20:text_out=10:corrections=1",
            "cancellation:fake-cartesia-gemini-session-response-1",
        ],
        "{barge_in:?}"
    );

    // 4. One typed HTTP failure, from a live composition talking to a loopback
    //    endpoint that refuses the credential.
    let refusing = LoopbackHttpServer::start(
        "401 Unauthorized",
        r#"{"error":{"status":"UNAUTHENTICATED","message":"loopback-http-marker"}}"#,
    )
    .await;
    let brain = CartesiaGeminiBrain::new(
        loopback_live_config(&refusing.base_url, "ws://127.0.0.1:1", "ws://127.0.0.1:1"),
        learning_ready_store(),
    );
    let mut session = brain
        .open(fixture_session_config())
        .await
        .expect("an explicit live runtime opens without a network");
    let mut http_failure = vec![
        next_event(&mut session).await,
        next_event(&mut session).await,
    ];
    http_failure
        .extend(drain_turn(&mut session, BrainInput::Text("a live answer".to_owned())).await);
    drop(session);
    assert!(
        refusing.requests() >= 1,
        "the live turn reached the endpoint"
    );
    let http_trace = canonical_event_trace(&http_failure);
    assert_eq!(
        http_trace,
        vec![
            "session_phase:Ready",
            "question_started:response-1:q-oxidative-phosphorylation-nadh:concept-oxidative-phosphorylation:criteria=2",
            "input_speech_started",
            "session_phase:Listening",
            "transcript_final:response-1:confidence=none",
            "input_speech_stopped",
            "session_phase:Thinking",
            "error:class=ProviderAuthFailure:stage=Gemini:terminal=ProviderAuthFailed:retry=false:provider=gemini:metadata=stage=gemini error_kind=gemini_http_auth http_status=401 retry_eligible=false retry_after_ms=1000 retry_after_source=default body_status=unknown",
        ],
        "{http_failure:?}"
    );
    assert!(
        !http_trace.join("|").contains("loopback-http-marker"),
        "the provider body never reaches the trace: {http_trace:?}"
    );

    // 5. One typed WebSocket close, from a live composition whose speech-to-text
    //    endpoint accepts the upgrade and then hangs up.
    let closing = LoopbackClosingWebSocket::start(1011, "loopback-close-marker").await;
    let brain = CartesiaGeminiBrain::new(
        loopback_live_config(&refusing.base_url, &closing.url, "ws://127.0.0.1:1"),
        learning_ready_store(),
    );
    let mut session = brain
        .open(fixture_session_config())
        .await
        .expect("an explicit live runtime opens without a network");
    let mut ws_failure = vec![
        next_event(&mut session).await,
        next_event(&mut session).await,
    ];
    ws_failure.extend(
        drain_turn(
            &mut session,
            BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4])),
        )
        .await,
    );
    drop(session);
    assert_eq!(closing.connections(), 1);
    let ws_trace = canonical_event_trace(&ws_failure);
    assert_eq!(
        ws_trace,
        vec![
            "session_phase:Ready",
            "question_started:response-1:q-oxidative-phosphorylation-nadh:concept-oxidative-phosphorylation:criteria=2",
            "input_speech_started",
            "session_phase:Listening",
            "error:class=MalformedStream:stage=Provider:terminal=ProviderMalformedStream:retry=true:provider=cartesia:metadata=stage=cartesia_ink error_kind=cartesia_ink_ws_closed ws_close_code=1011 retry_eligible=true",
        ],
        "{ws_failure:?}"
    );
    assert!(
        !ws_trace.join("|").contains("loopback-close-marker"),
        "the provider close reason never reaches the trace: {ws_trace:?}"
    );
}

/// A recording loopback stand-in for Gemini.
///
/// It answers the first request with `429` so the bounded fallback policy has
/// to promote a model, then serves the evaluator's bounded JSON answer and both
/// tool-loop passes. It records only the request ordinal, the model named in the
/// path, and the status it returned.
struct RecordingGeminiEndpoint {
    base_url: String,
    calls: Arc<Mutex<Vec<(String, u16)>>>,
}

impl RecordingGeminiEndpoint {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port is available");
        let port = listener.local_addr().expect("bound address").port();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&calls);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let recorded = Arc::clone(&recorded);
                tokio::spawn(async move {
                    serve_recording_gemini(stream, recorded).await;
                });
            }
        });
        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            calls,
        }
    }

    fn calls(&self) -> Vec<(String, u16)> {
        self.calls
            .lock()
            .expect("gemini record lock poisoned")
            .clone()
    }
}

async fn serve_recording_gemini(
    mut stream: tokio::net::TcpStream,
    calls: Arc<Mutex<Vec<(String, u16)>>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buffer = Vec::new();
    let mut scratch = [0_u8; 8192];
    loop {
        let head_end = loop {
            if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
            match stream.read(&mut scratch).await {
                Ok(0) | Err(_) => return,
                Ok(read) => buffer.extend_from_slice(&scratch[..read]),
            }
        };
        let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
        let content_length = head
            .to_ascii_lowercase()
            .split("\r\n")
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or_default();
        while buffer.len() < head_end + content_length {
            match stream.read(&mut scratch).await {
                Ok(0) | Err(_) => return,
                Ok(read) => buffer.extend_from_slice(&scratch[..read]),
            }
        }
        let body =
            String::from_utf8_lossy(&buffer[head_end..head_end + content_length]).to_string();
        buffer.drain(..head_end + content_length);

        // `POST /{model}:streamGenerateContent?alt=sse HTTP/1.1`
        let model = head
            .split_whitespace()
            .nth(1)
            .and_then(|target| target.rsplit('/').next())
            .and_then(|tail| tail.split(':').next())
            .unwrap_or("unknown")
            .to_owned();

        let first_call = {
            let mut record = calls.lock().expect("gemini record lock poisoned");
            let first = record.is_empty();
            record.push((model.clone(), if first { 429 } else { 200 }));
            first
        };

        let (status_line, payload) = if first_call {
            (
                "429 Too Many Requests",
                r#"{"error":{"status":"RESOURCE_EXHAUSTED","message":"loopback-rate-marker"}}"#
                    .to_owned(),
            )
        } else if body.contains("responseMimeType") {
            // The evaluator's bounded JSON answer: criterion verdicts only.
            let decision = json!({
                "kind": "evaluated",
                "assessments": [
                    { "criterion_id": "crit-oxphos-donor", "assessment": "satisfied", "confidence": 0.9 },
                    { "criterion_id": "crit-oxphos-gradient", "assessment": "satisfied", "confidence": 0.88 },
                ],
                "concise_feedback": "Both required claims held.",
                "retry_prompt": null,
            })
            .to_string();
            (
                "200 OK",
                format!(
                    "data: {}\n\n",
                    json!({ "candidates": [{ "content": { "parts": [{ "text": decision }] } }] })
                ),
            )
        } else if body.contains("functionResponse") {
            (
                "200 OK",
                format!(
                    "data: {}\n\n",
                    json!({
                        "candidates": [{ "content": { "parts": [{ "text": "That holds up. Next question." }] } }],
                        "usageMetadata": { "promptTokenCount": 17, "candidatesTokenCount": 6 },
                    })
                ),
            )
        } else {
            (
                "200 OK",
                format!(
                    "data: {}\n\n",
                    json!({
                        "candidates": [{ "content": { "parts": [{ "functionCall": {
                            "id": "call-eval-1",
                            "name": "evaluate_spoken_answer",
                            "args": {
                                "study_set_id": "biology-midterm",
                                "voice_session_id": "voice-session-1",
                                "question_id": "q-oxidative-phosphorylation-nadh",
                                "answer_text": "NADH donates electrons to the chain and pumps protons.",
                            },
                        } }] } }],
                        "usageMetadata": { "promptTokenCount": 11, "candidatesTokenCount": 3 },
                    })
                ),
            )
        };
        let response = format!(
            "HTTP/1.1 {status_line}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{payload}",
            payload.len()
        );
        if stream.write_all(response.as_bytes()).await.is_err() {
            return;
        }
        let _ = stream.flush().await;
    }
}

/// A recording loopback stand-in for Cartesia Ink.
struct RecordingInkEndpoint {
    url: String,
    record: Arc<Mutex<InkRecord>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct InkRecord {
    connections: u32,
    audio_frames: u32,
    close_commands: u32,
}

impl RecordingInkEndpoint {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port is available");
        let port = listener.local_addr().expect("bound address").port();
        let record = Arc::new(Mutex::new(InkRecord::default()));
        let served = Arc::clone(&record);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let served = Arc::clone(&served);
                tokio::spawn(async move {
                    use futures_util::{SinkExt, StreamExt};
                    use tokio_tungstenite::tungstenite::Message;
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    served.lock().expect("ink record lock poisoned").connections += 1;
                    while let Some(Ok(message)) = socket.next().await {
                        match message {
                            Message::Binary(_) => {
                                served
                                    .lock()
                                    .expect("ink record lock poisoned")
                                    .audio_frames += 1;
                            }
                            Message::Text(_) => {
                                served
                                    .lock()
                                    .expect("ink record lock poisoned")
                                    .close_commands += 1;
                                let event = json!({
                                    "type": "turn.end",
                                    "text": "NADH donates electrons to the chain and pumps protons.",
                                    "confidence": null,
                                });
                                let _ = socket.send(Message::text(event.to_string())).await;
                                let _ = socket.flush().await;
                                break;
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
        Self {
            url: format!("ws://127.0.0.1:{port}"),
            record,
        }
    }

    fn record(&self) -> InkRecord {
        self.record
            .lock()
            .expect("ink record lock poisoned")
            .clone()
    }
}

/// A recording loopback stand-in for Cartesia Sonic.
///
/// It records the shape of every write — context id, whether the context stays
/// open, and whether the write was the documented cancel — and answers the
/// finalizer with one audio chunk and `done`.
struct RecordingSonicEndpoint {
    url: String,
    record: Arc<Mutex<SonicRecord>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct SonicRecord {
    connections: u32,
    writes: Vec<String>,
}

impl RecordingSonicEndpoint {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port is available");
        let port = listener.local_addr().expect("bound address").port();
        let record = Arc::new(Mutex::new(SonicRecord::default()));
        let served = Arc::clone(&record);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let served = Arc::clone(&served);
                tokio::spawn(async move {
                    use futures_util::{SinkExt, StreamExt};
                    use tokio_tungstenite::tungstenite::Message;
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    served
                        .lock()
                        .expect("sonic record lock poisoned")
                        .connections += 1;
                    while let Some(Ok(message)) = socket.next().await {
                        let Message::Text(text) = message else {
                            continue;
                        };
                        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                            continue;
                        };
                        let context_id = value["context_id"].as_str().unwrap_or("none").to_owned();
                        let line = if value["cancel"].as_bool().unwrap_or(false) {
                            format!("cancel:{context_id}")
                        } else {
                            format!(
                                "generate:{context_id}:continue={}:transcript={}",
                                value["continue"].as_bool().unwrap_or(false),
                                if value["transcript"].as_str().unwrap_or("").is_empty() {
                                    "empty"
                                } else {
                                    "present"
                                }
                            )
                        };
                        let finalizer = line.starts_with("generate:")
                            && !value["continue"].as_bool().unwrap_or(false);
                        served
                            .lock()
                            .expect("sonic record lock poisoned")
                            .writes
                            .push(line);
                        if finalizer {
                            let chunk = json!({
                                "type": "chunk",
                                "context_id": context_id,
                                "data": "AQIDBA==",
                            });
                            let done = json!({ "type": "done", "context_id": context_id });
                            let _ = socket.send(Message::text(chunk.to_string())).await;
                            let _ = socket.send(Message::text(done.to_string())).await;
                            let _ = socket.flush().await;
                        }
                    }
                });
            }
        });
        Self {
            // Sonic's endpoint builder appends its query to the configured URL
            // verbatim, so the loopback stand-in publishes a real path.
            url: format!("ws://127.0.0.1:{port}/tts/websocket"),
            record,
        }
    }

    fn record(&self) -> SonicRecord {
        self.record
            .lock()
            .expect("sonic record lock poisoned")
            .clone()
    }
}

#[tokio::test]
async fn primary_fallback_ink_and_sonic_call_trace_is_stable() {
    let gemini = RecordingGeminiEndpoint::start().await;
    let ink = RecordingInkEndpoint::start().await;
    let sonic = RecordingSonicEndpoint::start().await;

    let mut config = loopback_live_config(&gemini.base_url, &ink.url, &sonic.url);
    config.gemini.fallback_model_ids = vec!["gemini-3.5-flash-lite".to_owned()];
    let brain = CartesiaGeminiBrain::new(config, learning_ready_store());
    let mut session = brain
        .open(fixture_session_config())
        .await
        .expect("an explicit live runtime opens without a network");

    let mut events = vec![
        next_event(&mut session).await,
        next_event(&mut session).await,
    ];
    events.extend(
        drain_turn(
            &mut session,
            BrainInput::Audio(AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4])),
        )
        .await,
    );
    session.input.send(BrainInput::Stop).await.ok();
    while let Ok(Some(event)) = timeout(Duration::from_secs(5), session.events.recv()).await {
        events.push(event);
    }
    drop(session);

    // The provider-call trace: stage, attempt ordinal, selected model, the Ink
    // turn's frames, and the Sonic context's continuation and finalizer.
    let gemini_calls = gemini
        .calls()
        .into_iter()
        .enumerate()
        .map(|(index, (model, status))| format!("gemini:attempt={}:{model}:{status}", index + 1))
        .collect::<Vec<_>>();
    assert_eq!(
        gemini_calls,
        vec![
            "gemini:attempt=1:gemini-3.5-flash:429",
            "gemini:attempt=2:gemini-3.5-flash-lite:200",
            "gemini:attempt=3:gemini-3.5-flash:200",
            "gemini:attempt=4:gemini-3.5-flash-lite:200",
        ],
        "{events:?}"
    );
    assert_eq!(
        ink.record(),
        InkRecord {
            connections: 1,
            audio_frames: 1,
            close_commands: 1,
        }
    );
    assert_eq!(
        sonic.record(),
        SonicRecord {
            connections: 1,
            writes: vec![
                "generate:response-1:continue=true:transcript=present".to_owned(),
                "generate:response-1:continue=false:transcript=empty".to_owned(),
            ],
        },
        "{events:?}"
    );

    // The domain projection the same run produced. The fallback promotion is
    // reported to the learner's session as a typed event, once.
    assert_eq!(
        canonical_event_trace(&events),
        vec![
            "session_phase:Ready",
            "question_started:response-1:q-oxidative-phosphorylation-nadh:concept-oxidative-phosphorylation:criteria=2",
            "input_speech_started",
            "session_phase:Listening",
            "transcript_final:response-1:confidence=none",
            "input_speech_stopped",
            "session_phase:Thinking",
            "provider_fallback:response-1:gemini:gemini-3.5-flash->gemini-3.5-flash-lite:primary_429:class=QuotaRateFailure:stage=Gemini:terminal=ProviderRateLimited:retry=true:provider=gemini:metadata=stage=gemini error_kind=gemini_http_rate_limited http_status=429 retry_eligible=true reset_hint=none retry_after_ms=1000 retry_after_source=default body_status=resource_exhausted",
            "source_reference:response-1:src-lecture-5-slide-18",
            "answer_evaluated:response-1:q-oxidative-phosphorylation-nadh:label=strong:status=Strong:confidence=0.88:source=src-lecture-5-slide-18",
            "concept_status:response-1:concept-oxidative-phosphorylation=Strong",
            "usage:text_in=28:text_out=9:corrections=1",
            "audio_delta:response-1:bytes=4",
            "session_phase:Feedback",
            "session_phase:Correction",
            "response_completed:response-1",
            "recap_ready:response-0:concepts=1:moments=1:deferred=0",
            "session_phase:Recap",
        ],
        "{events:?}"
    );
}

/// One forbidden responsibility edge: a module that must not name a marker.
struct ForbiddenEdge {
    rule: &'static str,
    modules: &'static [&'static str],
    markers: &'static [&'static str],
}

/// The post-extraction ownership contract from Task 11 Step 3, written as the
/// edges that must not exist.
const ADAPTER_FORBIDDEN_EDGES: [ForbiddenEdge; 5] = [
    ForbiddenEdge {
        rule: "projection-owns-no-transport",
        modules: &["projection.rs"],
        markers: &[
            "reqwest",
            "tokio_tungstenite",
            "InkSocket",
            "SonicSocket",
            "GeminiSse",
        ],
    },
    ForbiddenEdge {
        rule: "projection-builds-no-request",
        modules: &["projection.rs"],
        markers: &[
            "into_client_request",
            "HeaderValue",
            "streamGenerateContent",
        ],
    },
    ForbiddenEdge {
        rule: "transports-emit-no-domain-event-or-outcome",
        modules: &["llm.rs", "stt.rs", "tts.rs"],
        markers: &["BrainEvent", "StudySessionState", "TurnOutcome"],
    },
    ForbiddenEdge {
        rule: "runner-decodes-no-provider-frame",
        modules: &["runner.rs"],
        markers: &[
            "parse_ink",
            "parse_sonic",
            "parse_sse",
            "streamGenerateContent",
            "websocket_endpoint",
            "authorization",
        ],
    },
    ForbiddenEdge {
        rule: "session-parses-no-provider-json",
        modules: &["session.rs"],
        markers: &[
            "parse_ink",
            "parse_sonic",
            "parse_gemini_sse",
            "GeminiSseDecoder",
        ],
    },
];

/// Report every forbidden edge an explicit module/source map contains.
fn adapter_dependency_violations(map: &[(String, String)]) -> Vec<String> {
    let mut violations = Vec::new();
    for edge in &ADAPTER_FORBIDDEN_EDGES {
        for (module, body) in map {
            if !edge.modules.contains(&module.as_str()) {
                continue;
            }
            for marker in edge.markers {
                if body.contains(marker) {
                    violations.push(format!("{}: {module} names `{marker}`", edge.rule));
                }
            }
        }
    }
    violations
}

/// The real `cartesia_gemini` module map, by file name.
fn adapter_module_map() -> Vec<(String, String)> {
    let directory = repository_root().join("agent/crates/agent-adapters/src/cartesia_gemini");
    let mut map = Vec::new();
    for entry in std::fs::read_dir(&directory).expect("the cartesia_gemini module tree is readable")
    {
        let path = entry.expect("a readable directory entry").path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("rs") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("a module file name")
            .to_owned();
        let body = std::fs::read_to_string(&path).expect("a module file reads");
        map.push((name, body));
    }
    map.sort_by(|left, right| left.0.cmp(&right.0));
    map
}

#[test]
fn adapter_module_dependency_direction_is_enforced() {
    // Negative controls first: one deliberately mutated source map per
    // forbidden edge, each of which must be rejected. Without these the rule
    // engine could be vacuous.
    for edge in &ADAPTER_FORBIDDEN_EDGES {
        for marker in edge.markers {
            let mutated = edge
                .modules
                .iter()
                .map(|module| {
                    (
                        (*module).to_owned(),
                        format!("fn moved() {{ let _ = {marker}; }}"),
                    )
                })
                .collect::<Vec<_>>();
            let violations = adapter_dependency_violations(&mutated);
            assert_eq!(
                violations.len(),
                edge.modules.len(),
                "{}: `{marker}` must be rejected in every module the rule covers",
                edge.rule
            );
            assert!(
                violations
                    .iter()
                    .all(|violation| violation.starts_with(edge.rule)),
                "{violations:?}"
            );
        }
    }
    // A clean map is accepted, so rejection means something.
    let clean = ADAPTER_FORBIDDEN_EDGES
        .iter()
        .flat_map(|edge| edge.modules.iter())
        .map(|module| ((*module).to_owned(), "fn moved() {}".to_owned()))
        .collect::<Vec<_>>();
    assert!(adapter_dependency_violations(&clean).is_empty());

    // Then the real modules. Before the extraction lands, `session.rs` and
    // `projection.rs` do not exist and the rules run only against the map
    // above; the branch is asserted explicitly so it can never be taken
    // silently once they do exist.
    let map = adapter_module_map();
    let extracted = ["session.rs", "projection.rs"]
        .iter()
        .all(|module| map.iter().any(|(name, _)| name == module));
    if extracted {
        assert!(
            adapter_dependency_violations(&map).is_empty(),
            "{:?}",
            adapter_dependency_violations(&map)
        );
    } else {
        assert!(
            !map.iter()
                .any(|(name, _)| name == "session.rs" || name == "projection.rs"),
            "the extraction is half-landed: {:?}",
            map.iter().map(|(name, _)| name).collect::<Vec<_>>()
        );
    }
}
