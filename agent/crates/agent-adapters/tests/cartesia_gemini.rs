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
    let mut saw_new_interim = false;
    let mut saw_new_transcript = false;
    let mut saw_new_evaluation = false;
    let mut saw_new_audio = false;
    let mut saw_new_recap = false;
    for _ in 0..32 {
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

    let error = loop {
        match next_event(&mut realtime).await {
            BrainEvent::Error(error) => break error,
            BrainEvent::RecapReady { .. } => {
                panic!("recap tool failure unexpectedly emitted recap")
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
}

impl FailStudyToolStore {
    fn source_after_question(inner: Arc<data::InMemoryStudyStore>) -> Self {
        Self {
            inner,
            source_reference_calls: Mutex::new(0),
            fail_source_after_question: true,
            fail_recap: false,
        }
    }

    fn recap(inner: Arc<data::InMemoryStudyStore>) -> Self {
        Self {
            inner,
            source_reference_calls: Mutex::new(0),
            fail_source_after_question: false,
            fail_recap: true,
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
    question: StudyQuestion,
    sources: Vec<StudySourceReference>,
    persisted: TurnOutcome,
    receipt_response_id: Option<String>,
    calls: Mutex<StoreCalls>,
}

impl FixtureOutcomeStore {
    fn new(
        question: StudyQuestion,
        sources: Vec<StudySourceReference>,
        persisted: TurnOutcome,
    ) -> Self {
        Self {
            question,
            sources,
            persisted,
            receipt_response_id: None,
            calls: Mutex::new(StoreCalls::default()),
        }
    }

    fn with_receipt_response_id(mut self, response_id: &str) -> Self {
        self.receipt_response_id = Some(response_id.to_owned());
        self
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
        _response_id: &str,
        _policy: ProgressionPolicyId,
    ) -> Result<QuestionProgressionResult, PortError> {
        Ok(QuestionProgressionResult::Selected {
            question: self.question.clone(),
            ordinal: 1,
            total: 1,
            selection_reason: "ordered_v1".to_owned(),
            revision: 1,
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
            current_question: Some(self.question.clone()),
            answered_questions: vec![self.question.clone()],
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
        let mut persisted = self.persisted.clone();
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
            .question
            .rubric
            .criteria
            .iter()
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
                total: 1,
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
