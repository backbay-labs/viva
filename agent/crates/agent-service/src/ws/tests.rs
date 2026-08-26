//! `SERVICE-017`: the websocket runtime's unit tests, moved verbatim out of
//! `ws.rs` by the responsibility split.
//!
//! The module path is deliberately unchanged — these are still `ws::tests::*` —
//! so every name the lane ledger and the coverage ledger already cite keeps
//! resolving. Not one test name or body changed with the move.

use super::*;
use agent_adapters::SyntheticBrain;
use agent_domain::{BrainProviderFailure, BrainProviderFailureParts};
use serde::Deserialize;
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

fn fixture_binding() -> AuthorizedClientSession {
    AuthorizedClientSession {
        user_id: "user-1".to_owned(),
        study_set_id: "biology-midterm".to_owned(),
        session_id: "voice-session-1".to_owned(),
        client_session_id: "voice-session-1".to_owned(),
        client_generation_id: "1".to_owned(),
        bound_session_token: "placeholder-session-material".to_owned(),
        auth_mode: SessionAuthMode::Trusted,
    }
}

#[test]
fn failure_control_scenarios_declare_typed_terminal_reasons() {
    for (scenario, expected) in [
        (
            FailureControlScenario::ProviderRateLimited,
            TerminalSessionReason::ProviderRateLimited,
        ),
        (
            FailureControlScenario::ProviderAuthFailed,
            TerminalSessionReason::ProviderAuthFailed,
        ),
        (
            FailureControlScenario::ProviderTimeout,
            TerminalSessionReason::ProviderTimeout,
        ),
        (
            FailureControlScenario::SonicTtsTimeout,
            TerminalSessionReason::ProviderTimeout,
        ),
        (
            FailureControlScenario::RecapTimeout,
            TerminalSessionReason::ProviderTimeout,
        ),
        (
            FailureControlScenario::SilentStall,
            TerminalSessionReason::ProviderTimeout,
        ),
        (
            FailureControlScenario::ProviderMalformedStream,
            TerminalSessionReason::ProviderMalformedStream,
        ),
        (
            FailureControlScenario::ProviderNetworkDisconnect,
            TerminalSessionReason::ProviderNetworkDisconnect,
        ),
        (
            FailureControlScenario::InvalidToken,
            TerminalSessionReason::ProviderAuthFailed,
        ),
        (
            FailureControlScenario::ExpiredToken,
            TerminalSessionReason::ProviderAuthFailed,
        ),
        (
            FailureControlScenario::ReplayedToken,
            TerminalSessionReason::ProviderAuthFailed,
        ),
        (
            FailureControlScenario::MalformedToken,
            TerminalSessionReason::ProviderAuthFailed,
        ),
        (
            FailureControlScenario::SlowStaleSocketClose,
            TerminalSessionReason::SlowClient,
        ),
        (
            FailureControlScenario::DoubleSubmitRace,
            TerminalSessionReason::SlowClient,
        ),
        (
            FailureControlScenario::MicDenied,
            TerminalSessionReason::SlowClient,
        ),
        (
            FailureControlScenario::TypedFallback,
            TerminalSessionReason::PartialStageSuccess,
        ),
    ] {
        let error = failure_control_provider_error(scenario);
        assert_eq!(
            terminal_reason_for_provider_error(&error),
            expected,
            "scenario {} must declare its terminal reason",
            scenario.as_str()
        );
    }
}

#[test]
fn store_error_durability_classification_reads_the_typed_kind_only() {
    // A hostile diagnostic string cannot promote a non-durability kind, and a
    // reassuring one cannot demote a durability kind.
    assert!(store_adapter_error_is_durability_degraded(
        &PortError::durability("study_store", "voice-session-1", "everything is fine")
    ));
    assert!(store_adapter_error_is_durability_degraded(
        &PortError::internal("study_store", "voice-session-1", "everything is fine")
    ));
    assert!(!store_adapter_error_is_durability_degraded(
        &PortError::unavailable(
            "study_store",
            "missing-study-set",
            "durable store connection pool timed out"
        )
    ));
    assert!(!store_adapter_error_is_durability_degraded(
        &PortError::invalid_input("study_store", "concept-1", "postgres database unavailable")
    ));
    assert!(!store_adapter_error_is_durability_degraded(
        &PortError::conflict(
            "study_store",
            "voice-session-1",
            "session token nonce already used"
        )
    ));
}

#[test]
fn nonce_replay_is_detected_by_conflict_kind_not_by_reason_text() {
    assert!(nonce_claim_was_replayed(&PortError::conflict(
        "study_store",
        "user-1/set-1/voice-session-1",
        "any wording at all"
    )));
    assert!(!nonce_claim_was_replayed(&PortError::unavailable(
        "study_store",
        "user-1/set-1/voice-session-1",
        "session token nonce already used"
    )));
}

#[test]
fn terminal_observability_classifier_emits_query_backing_fields() {
    assert_eq!(
        terminal_observability_classification("provider_rate_limited"),
        Some(TerminalObservabilityClassification {
            failure_class: "quota_rate_failure",
            stage: "provider",
            signal: "gemini_http_429",
        })
    );
    assert_eq!(
        terminal_observability_classification("provider_auth_failed"),
        Some(TerminalObservabilityClassification {
            failure_class: "provider_auth_failure",
            stage: "provider_auth",
            signal: "provider_auth_failed",
        })
    );
    assert_eq!(
        terminal_observability_classification("provider_cancelled"),
        Some(TerminalObservabilityClassification {
            failure_class: "cancellation",
            stage: "provider",
            signal: "provider_cancelled",
        })
    );
    assert_eq!(
        terminal_observability_classification(TerminalSessionReason::ToolExecutorFailure.as_str()),
        Some(TerminalObservabilityClassification {
            failure_class: "tool_executor_failure",
            stage: "tools",
            signal: "tool_executor_failure",
        })
    );
    assert_eq!(
        terminal_observability_classification("turn_cap"),
        Some(TerminalObservabilityClassification {
            failure_class: "turn_cap",
            stage: "session",
            signal: "turn_cap",
        })
    );
    assert_eq!(
        terminal_observability_classification("study_set_access_denied"),
        Some(TerminalObservabilityClassification {
            failure_class: "pre_loop_unavailable",
            stage: "pre_loop",
            signal: "pre_loop_unavailable",
        })
    );
    assert_eq!(
        terminal_observability_classification("study_store_unavailable"),
        Some(TerminalObservabilityClassification {
            failure_class: "pre_loop_unavailable",
            stage: "pre_loop",
            signal: "pre_loop_unavailable",
        })
    );
    assert_eq!(
        terminal_observability_classification("first_frame_timeout"),
        Some(TerminalObservabilityClassification {
            failure_class: "session_bootstrap_unavailable",
            stage: "startup",
            signal: "session_bootstrap_unavailable",
        })
    );
    assert_eq!(
        terminal_observability_classification("agent_input_closed"),
        Some(TerminalObservabilityClassification {
            failure_class: "network_disconnect",
            stage: "transport",
            signal: "agent_input_closed",
        })
    );
    assert_eq!(
        terminal_observability_classification("invalid_session_token"),
        Some(TerminalObservabilityClassification {
            failure_class: "session_auth_failure",
            stage: "session_auth",
            signal: "session_auth_rejected",
        })
    );
    assert_eq!(
        terminal_observability_classification("session_token_nonce_store_unavailable"),
        Some(TerminalObservabilityClassification {
            failure_class: "session_auth_failure",
            stage: "session_auth",
            signal: "session_auth_rejected",
        })
    );
    assert_eq!(
        terminal_observability_classification("durability_degraded"),
        Some(TerminalObservabilityClassification {
            failure_class: "durability_degraded",
            stage: "store",
            signal: "durability_degraded",
        })
    );
    assert_eq!(
        terminal_observability_classification("closed_before_config"),
        None
    );
    assert_eq!(terminal_observability_classification("completed"), None);
}

#[test]
fn pending_evaluation_observability_uses_dedicated_terminal_reason() {
    assert_eq!(pending_evaluation_terminal_reason(), "pending_evaluation");
    assert_ne!(
        pending_evaluation_terminal_reason(),
        "provider_rate_limited"
    );
    assert_ne!(pending_evaluation_terminal_reason(), "provider_timeout");
}

#[test]
fn terminal_observability_model_uses_provider_suffix() {
    assert_eq!(
        observability_model_with("cartesia_gemini", |_| None),
        "cartesia_gemini-viva"
    );
}

#[test]
fn terminal_observability_model_uses_configured_cartesia_gemini_model() {
    assert_eq!(
        observability_model_with("cartesia_gemini", |name| match name {
            "GEMINI_MODEL" => Some(" gemini-live-primary ".to_owned()),
            "GEMINI_REALTIME_MODEL" => Some("gemini-live-secondary".to_owned()),
            _ => None,
        }),
        "gemini-live-primary"
    );
    assert_eq!(
        observability_model_with("cartesia_gemini", |name| match name {
            "GEMINI_REALTIME_MODEL" => Some("gemini-live-secondary".to_owned()),
            _ => None,
        }),
        "gemini-live-secondary"
    );
    assert_eq!(
        observability_model_with("synthetic", |name| {
            (name == "GEMINI_MODEL").then(|| "ignored".to_owned())
        }),
        "synthetic-viva"
    );
}

#[test]
fn failure_control_provider_message_includes_scenario_and_stage_marker() {
    let error = failure_control_provider_error(FailureControlScenario::SonicTtsTimeout);

    assert!(error.message.contains("timeout"));
    assert!(error.message.contains("scenario=sonic_tts_timeout"));
    assert!(error.message.contains("stage=sonic_tts"));
    // The terminal reason comes from the declared class, not from that message.
    assert_eq!(
        terminal_reason_for_provider_error(&error),
        TerminalSessionReason::ProviderTimeout
    );
}

#[tokio::test]
async fn user_study_set_acquire_waits_for_reconnect_lease_release() {
    let limits = VoiceLimitState::default();
    let held = limits
        .try_acquire_user_study_set("user-1", "biology-midterm", 1)
        .unwrap();
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(25)).await;
        drop(held);
    });

    let lease = acquire_user_study_set_with_reconnect_grace(
        &limits,
        "user-1",
        "biology-midterm",
        1,
        Duration::from_millis(250),
    )
    .await;

    release.await.unwrap();
    assert!(lease.is_some());
}

#[tokio::test]
async fn user_study_set_acquire_still_rejects_live_duplicate_after_reconnect_grace() {
    let limits = VoiceLimitState::default();
    let _held = limits
        .try_acquire_user_study_set("user-1", "biology-midterm", 1)
        .unwrap();

    let lease = acquire_user_study_set_with_reconnect_grace(
        &limits,
        "user-1",
        "biology-midterm",
        1,
        Duration::from_millis(25),
    )
    .await;

    assert!(lease.is_none());
}

#[test]
fn provider_error_stage_metadata_overrides_message_classifier() {
    let error =
        BrainProviderError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
            failure_class: BrainFailureClass::ToolExecutorFailure,
            stage: BrainFailureStage::Tools,
            retry_eligible: true,
            latency_ms: 12,
            provider: "server".to_owned(),
            model: "viva-tools".to_owned(),
            metadata: "tool=retrieve_source_reference error_kind=store".to_owned(),
        }));

    assert_eq!(
        terminal_reason_for_provider_error(&error),
        TerminalSessionReason::ToolExecutorFailure
    );
    assert!(!error.message.contains("retrieve_source_reference"));
}

#[test]
fn structured_durability_provider_error_uses_durability_path_classifier() {
    let error =
        BrainProviderError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
            failure_class: BrainFailureClass::DurabilityDegraded,
            stage: BrainFailureStage::Tools,
            retry_eligible: true,
            latency_ms: 12,
            provider: "server".to_owned(),
            model: "viva-tools".to_owned(),
            metadata: "tool=retrieve_source_reference error_kind=store".to_owned(),
        }));
    assert!(provider_error_is_durability_degraded_for_store(
        true, &error
    ));
    assert!(!provider_error_is_durability_degraded_for_store(
        false, &error
    ));
}

#[tokio::test]
async fn structured_durability_provider_error_records_stage_failure_before_return() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://postgres:postgres@127.0.0.1:1/viva_test")
        .unwrap();
    let state_store: Arc<dyn agent_domain::StudyMemoryStore> =
        Arc::new(data::PostgresStudyStore::new(pool));
    let state = AppState::with_study_store(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
        state_store,
    );
    let binding = fixture_binding();
    let limits = VoiceLimitConfig::default();
    let mut session_limits = SessionLimitRuntime::new();
    let mut turn_bindings = TurnBindingTracker::default();
    let mut context = BrainForwardContext {
        state: &state,
        voice_session_id: Some("voice-session-1".to_owned()),
        session_binding: &binding,
        limits: &limits,
        session_limits: &mut session_limits,
        turn_bindings: &mut turn_bindings,
    };
    let mut cancelled_responses = CancelledResponseTracker::default();
    let mut sender = BoundedSender::new(RecordingSink::new(), Duration::from_secs(5));
    let error =
        BrainProviderError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
            failure_class: BrainFailureClass::DurabilityDegraded,
            stage: BrainFailureStage::Recap,
            retry_eligible: true,
            latency_ms: 37,
            provider: "server".to_owned(),
            model: "viva-tools".to_owned(),
            metadata: "tool=build_session_recap error_kind=store".to_owned(),
        }));

    let result = forward_brain_event(
        &mut context,
        agent_domain::BrainEvent::Error(error),
        &mut cancelled_responses,
        Duration::from_millis(37),
        &mut sender,
    )
    .await
    .unwrap();

    assert_eq!(result, ForwardBrainEvent::DurabilityDegraded);
    assert!(sender.inner.sent.is_empty());
    let evidence = state.evidence.snapshot();
    assert!(evidence.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderStageFailure
            && event.detail.contains("failure_class=durability_degraded")
            && event.detail.contains("stage=recap")
            && event.detail.contains("terminal_reason=durability_degraded")
            && event.detail.contains("latency_ms=37")
            && event.detail.contains("tool=build_session_recap")
            && event.detail.contains("error_kind=store")
    }));
    assert!(evidence.iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::StoreCounts && event.detail == "durability_degraded"
    }));
}

#[test]
fn provider_stage_failure_evidence_keeps_core_and_retry_metadata_before_truncation() {
    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let error = BrainProviderError::from_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: BrainFailureClass::QuotaRateFailure,
                stage: BrainFailureStage::Gemini,
                retry_eligible: true,
                latency_ms: 123,
                provider: "gemini".to_owned(),
                model: "gemini-35-flash".to_owned(),
                metadata:
                    "http_status=429 retry_after_ms=7000 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=unknown deploy_sha=abcdef1234567890abcdef1234567890abcdef12"
                        .to_owned(),
            },
        ));

    record_provider_stage_failure(&state, Some("voice-session-1".to_owned()), &error);

    let events = state.evidence.snapshot();
    assert_eq!(events.len(), 1);
    let detail = &events[0].detail;
    assert!(detail.len() <= PROVIDER_STAGE_FAILURE_DETAIL_MAX_CHARS);
    assert!(detail.contains("failure_class=quota_rate_failure"));
    assert!(detail.contains("stage=gemini"));
    assert!(detail.contains("terminal_reason=provider_rate_limited"));
    assert!(detail.contains("provider=gemini"));
    assert!(detail.contains("model=gemini-35-flash"));
    assert!(detail.contains("latency_ms=123"));
    assert!(detail.contains("deploy_sha=abcdef12"));
    assert!(detail.contains("retry_after_ms=7000"));
    assert!(detail.contains("retry_after_source=retry_after_delta"));
    assert!(
        detail.contains("reset_hint=2030-01-01T00:00:00Z"),
        "{detail}"
    );
    assert!(detail.contains("budget_state=unknown"), "{detail}");
}

#[test]
fn provider_stage_failure_evidence_keeps_provider_model_with_long_metadata() {
    use std::sync::Arc;

    use agent_adapters::SyntheticBrain;

    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let error = BrainProviderError::from_failure(BrainProviderFailure::new(
            BrainProviderFailureParts {
                failure_class: BrainFailureClass::QuotaRateFailure,
                stage: BrainFailureStage::Gemini,
                retry_eligible: true,
                latency_ms: 123,
                provider: "gemini".to_owned(),
                model: "gemini-35-flash-preview-long-sanitized-model-identifier-long-sanitized-model-identifier-long-tail"
                    .to_owned(),
                metadata:
                    "http_status=429 retry_after_ms=7000 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=unknown deploy_sha=unknown"
                        .to_owned(),
            },
        ));

    record_provider_stage_failure(&state, Some("voice-session-1".to_owned()), &error);

    let events = state.evidence.snapshot();
    assert_eq!(events.len(), 1);
    let detail = &events[0].detail;
    assert!(detail.len() <= PROVIDER_STAGE_FAILURE_DETAIL_MAX_CHARS);
    assert!(detail.contains("failure_class=quota_rate_failure"));
    assert!(detail.contains("stage=gemini"));
    assert!(detail.contains("terminal_reason=provider_rate_limited"));
    assert!(detail.contains("provider=gemini"));
    assert!(detail.contains("model=gemini-35-flash-preview-long-san"));
    assert!(detail.contains("latency_ms=123"));
    assert!(detail.contains("deploy_sha=unknown"));
    assert!(detail.contains("retry_after_ms=7000"));
    assert!(detail.contains("retry_after_source=retry_after_delta"));
    assert!(
        detail.contains("reset_hint=2030-01-01T00:00:00Z"),
        "{detail}"
    );
    assert!(detail.contains("budget_state=unknown"), "{detail}");
}

#[test]
fn provider_turn_completion_uses_answer_evaluation_signal() {
    let question = agent_domain::fixture_question();
    let mut evaluation_value = serde_json::Map::new();
    evaluation_value.insert("question_id".to_owned(), json!(question.question_id));
    evaluation_value.insert(["answer", "text"].join("_"), json!("omitted"));
    evaluation_value.insert("label".to_owned(), json!("mostly correct"));
    evaluation_value.insert("concise_feedback".to_owned(), json!("omitted"));
    evaluation_value.insert("retry_prompt".to_owned(), json!("omitted"));
    evaluation_value.insert("source".to_owned(), json!(question.source));
    evaluation_value.insert("concept_status".to_owned(), json!("strong"));
    evaluation_value.insert("confidence_score".to_owned(), json!(0.84));
    let evaluation: agent_domain::AnswerEvaluation =
        serde_json::from_value(serde_json::Value::Object(evaluation_value)).unwrap();
    let answer_evaluated = BrainEvent::AnswerEvaluated {
        response_id: "response-1".to_owned(),
        evaluation,
    };
    assert_eq!(
        classify_provider_turn_event(&answer_evaluated),
        Some(ProviderTurnResolution::One {
            response_id: Some("response-1".to_owned())
        })
    );

    let response_completed = BrainEvent::ResponseCompleted {
        response_id: "response-1".to_owned(),
    };
    assert_eq!(
        classify_provider_turn_event(&response_completed),
        Some(ProviderTurnResolution::One {
            response_id: Some("response-1".to_owned())
        })
    );

    let terminal_phase = BrainEvent::TerminalSessionPhase {
        phase: agent_domain::StudySessionPhase::Recap,
        terminal_reason: TerminalSessionReason::ProviderCancelled,
    };
    assert_eq!(
        classify_provider_turn_event(&terminal_phase),
        Some(ProviderTurnResolution::All)
    );
}

/// Recorded gate-check: `should_suppress_superseded_recap` versus Plan 07's
/// one-recap-on-stop.
///
/// DISPOSITION — no collision in the live runtime. Plan 07 emits the stop
/// recap under a dedicated turn-0 response identity
/// (`SyntheticStudySessionSpec::response_id(0)`), which is never an admitted
/// provider turn, therefore never enters `completed_provider_turn_response_ids`,
/// therefore can never enter `superseded_provider_turn_response_ids`. The
/// suppression rule cannot reach it.
///
/// ESCALATED — Plan 05's frozen `v5/synthetic-two-turn-session.json` binds its
/// `recap_ready` to `response-1`, the same response the fixture cancels and
/// evaluates. On a live socket that recap is suppressed twice over: once by
/// `should_suppress_cancelled_response` (its response was cancelled) and again
/// by `should_suppress_superseded_recap` once a later turn is admitted. That is
/// a fixture/runtime disagreement, not something this service may paper over by
/// weakening either rule, so it is reported to the fixture owner rather than
/// improvised around here.
#[test]
fn stop_recap_identity_is_out_of_reach_of_superseded_recap_suppression() {
    let recap = agent_domain::StudySessionRecap {
        schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
        voice_session_id: "voice-session-1".to_owned(),
        headline: "Session recap".to_owned(),
        summary: "Review oxidative phosphorylation.".to_owned(),
        concepts: vec![],
        review_schedule: vec![],
        next_action: "Review the source moment.".to_owned(),
        source_moments: vec![],
        deferred_turns: 0,
    };

    // The turn-0 identity Plan 07's stop recap uses.
    let stop_recap = BrainEvent::RecapReady {
        response_id: "response-0-generation-viva-session-bootstrap-1".to_owned(),
        recap: recap.clone(),
    };
    // Every answered turn of the session, completed and then superseded.
    let mut completed = HashSet::new();
    completed.insert("response-1-generation-viva-session-bootstrap-1".to_owned());
    completed.insert("response-2-generation-viva-session-bootstrap-1".to_owned());
    let mut superseded = HashSet::new();
    mark_completed_provider_turns_superseded(&completed, &mut superseded);

    assert!(
        !should_suppress_superseded_recap(&stop_recap, &superseded),
        "the stop recap's turn-0 identity is never one of the superseded turns"
    );

    // The fixture's shape, recorded as the escalation it is: a recap bound to
    // an answered turn that was cancelled and then superseded.
    let fixture_shaped_recap = BrainEvent::RecapReady {
        response_id: "response-1-generation-viva-session-bootstrap-1".to_owned(),
        recap,
    };
    assert!(
        should_suppress_superseded_recap(&fixture_shaped_recap, &superseded),
        "a recap bound to a superseded answered turn is suppressed"
    );
    let mut cancelled = CancelledResponseTracker::default();
    assert!(!should_suppress_cancelled_response(
        &mut cancelled,
        &BrainEvent::ResponseCancelledFor {
            response_id: "response-1-generation-viva-session-bootstrap-1".to_owned(),
        }
    ));
    assert!(
        should_suppress_cancelled_response(&mut cancelled, &fixture_shaped_recap),
        "a recap bound to a cancelled response is already suppressed before the \
             superseded rule is consulted"
    );
}

#[test]
fn superseded_recap_suppression_uses_response_identity_not_active_turn_count() {
    let recap = agent_domain::StudySessionRecap {
        schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
        voice_session_id: "voice-session-1".to_owned(),
        headline: "Session recap".to_owned(),
        summary: "Review oxidative phosphorylation.".to_owned(),
        concepts: vec![],
        review_schedule: vec![],
        next_action: "Review the source moment.".to_owned(),
        source_moments: vec![],
        deferred_turns: 0,
    };
    let stale_recap = BrainEvent::RecapReady {
        response_id: "response-a".to_owned(),
        recap: recap.clone(),
    };
    let current_recap = BrainEvent::RecapReady {
        response_id: "response-b".to_owned(),
        recap,
    };
    let mut completed = HashSet::new();
    completed.insert("response-a".to_owned());
    let mut superseded = HashSet::new();

    mark_completed_provider_turns_superseded(&completed, &mut superseded);

    assert!(should_suppress_superseded_recap(&stale_recap, &superseded));
    assert!(!should_suppress_superseded_recap(
        &current_recap,
        &superseded
    ));
}

// ---------------------------------------------------------------------
// Task 8 (SERVICE-001, SERVICE-006, SERVICE-014): one classifier, durable
// deferred-turn mapping, and between-turn idle rearm.
// ---------------------------------------------------------------------

fn classifier_fixture_recap() -> StudySessionRecap {
    StudySessionRecap {
        schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
        voice_session_id: "voice-session-1".to_owned(),
        headline: "Session recap".to_owned(),
        summary: "Review oxidative phosphorylation.".to_owned(),
        concepts: vec![],
        review_schedule: vec![],
        next_action: "Review the source moment.".to_owned(),
        source_moments: vec![],
        deferred_turns: 0,
    }
}

fn classifier_fixture_evaluation() -> agent_domain::AnswerEvaluation {
    agent_domain::AnswerEvaluation {
        question_id: fixture_question().question_id,
        answer_text: "omitted".to_owned(),
        label: "mostly correct".to_owned(),
        concise_feedback: "omitted".to_owned(),
        retry_prompt: "omitted".to_owned(),
        source: agent_domain::fixture_source_reference(),
        concept_status: agent_domain::ConceptStatus::Strong,
        confidence_score: 0.84,
    }
}

fn classifier_fixture_failure() -> BrainProviderFailure {
    BrainProviderFailure::new(BrainProviderFailureParts {
        failure_class: BrainFailureClass::Timeout,
        stage: BrainFailureStage::Gemini,
        retry_eligible: true,
        latency_ms: 7,
        provider: "gemini".to_owned(),
        model: "gemini-35-flash".to_owned(),
        metadata: "http_status=504".to_owned(),
    })
}

fn resolved_one(response_id: &str) -> Option<ProviderTurnResolution> {
    Some(ProviderTurnResolution::One {
        response_id: Some(response_id.to_owned()),
    })
}

/// One constructed event for every currently named `BrainEvent` variant plus
/// its exact expected resolution. `BrainEvent` is `#[non_exhaustive]`, so this
/// table is the lane's record of what "every current variant" means; a new
/// upstream variant is classified `None` by the final arm until its owner
/// names it here.
fn every_named_brain_event() -> Vec<(&'static str, BrainEvent, Option<ProviderTurnResolution>)> {
    vec![
        (
            "SessionPhase",
            BrainEvent::SessionPhase {
                phase: StudySessionPhase::Listening,
            },
            None,
        ),
        (
            "TerminalSessionPhase",
            BrainEvent::TerminalSessionPhase {
                phase: StudySessionPhase::Recap,
                terminal_reason: TerminalSessionReason::ProviderCancelled,
            },
            Some(ProviderTurnResolution::All),
        ),
        (
            "QuestionStarted",
            BrainEvent::QuestionStarted {
                response_id: "response-1".to_owned(),
                question: fixture_question(),
            },
            None,
        ),
        (
            "TranscriptDelta",
            BrainEvent::TranscriptDelta {
                response_id: "response-1".to_owned(),
                text: "omitted".to_owned(),
            },
            None,
        ),
        (
            "AnswerEvaluated",
            BrainEvent::AnswerEvaluated {
                response_id: "response-1".to_owned(),
                evaluation: classifier_fixture_evaluation(),
            },
            resolved_one("response-1"),
        ),
        (
            "TurnDeferred",
            BrainEvent::TurnDeferred {
                response_id: "response-1".to_owned(),
                question_id: "question-1".to_owned(),
                reason: agent_domain::EvaluationDeferralReason::EmptyAnswer,
                can_retry_same_question: true,
            },
            resolved_one("response-1"),
        ),
        (
            "SourceReference",
            BrainEvent::SourceReference {
                response_id: "response-1".to_owned(),
                source: agent_domain::fixture_source_reference(),
            },
            None,
        ),
        (
            "ConceptStatus",
            BrainEvent::ConceptStatus {
                response_id: "response-1".to_owned(),
                concept_id: "oxidative-phosphorylation".to_owned(),
                status: agent_domain::ConceptStatus::Review,
            },
            None,
        ),
        (
            "ManuscriptIntent",
            BrainEvent::ManuscriptIntent {
                response_id: "response-1".to_owned(),
                intent: agent_domain::ManuscriptIntent::Scene {
                    register: agent_domain::ManuscriptRegister::Examining,
                    emphasis: agent_domain::ManuscriptEmphasis::Measured,
                },
            },
            None,
        ),
        (
            "RecapReady",
            BrainEvent::RecapReady {
                response_id: "response-1".to_owned(),
                recap: classifier_fixture_recap(),
            },
            resolved_one("response-1"),
        ),
        (
            "AudioDelta",
            BrainEvent::AudioDelta {
                response_id: "response-1".to_owned(),
                frame: AudioFrame::from_pcm16_bytes(vec![0, 0]),
            },
            None,
        ),
        (
            "ResponseStarted",
            BrainEvent::ResponseStarted {
                response_id: "response-1".to_owned(),
            },
            None,
        ),
        (
            "ResponseCompleted",
            BrainEvent::ResponseCompleted {
                response_id: "response-1".to_owned(),
            },
            resolved_one("response-1"),
        ),
        (
            "ResponseAudio",
            BrainEvent::ResponseAudio {
                response_id: "response-1".to_owned(),
                frame: AudioFrame::from_pcm16_bytes(vec![0, 0]),
            },
            None,
        ),
        (
            "Transcript",
            BrainEvent::Transcript("omitted".to_owned()),
            None,
        ),
        (
            "ResponseToolProposal",
            BrainEvent::ResponseToolProposal {
                response_id: "response-1".to_owned(),
                proposal: agent_domain::ToolProposal::new("select_next_question", json!({})),
            },
            None,
        ),
        (
            "Usage",
            BrainEvent::Usage(agent_domain::BrainUsage::default()),
            None,
        ),
        (
            "ProviderFallbackActivated",
            BrainEvent::ProviderFallbackActivated {
                response_id: "response-1".to_owned(),
                provider: "gemini".to_owned(),
                from_model: "gemini-35-flash".to_owned(),
                to_model: "gemini-35-flash-lite".to_owned(),
                reason: "quota_rate_failure".to_owned(),
                failure: Some(classifier_fixture_failure()),
            },
            None,
        ),
        (
            "Error",
            BrainEvent::Error(BrainProviderError::from_failure(
                classifier_fixture_failure(),
            )),
            None,
        ),
        (
            "SpeechIntent",
            BrainEvent::SpeechIntent(agent_domain::SpeechIntent {
                text: "omitted".to_owned(),
            }),
            None,
        ),
        ("InputSpeechStarted", BrainEvent::InputSpeechStarted, None),
        ("InputSpeechStopped", BrainEvent::InputSpeechStopped, None),
        (
            "ResponseCancelled",
            BrainEvent::ResponseCancelled,
            Some(ProviderTurnResolution::One { response_id: None }),
        ),
        (
            "ResponseCancelledFor",
            BrainEvent::ResponseCancelledFor {
                response_id: "response-1".to_owned(),
            },
            resolved_one("response-1"),
        ),
        (
            "ResponseTranscriptDelta",
            BrainEvent::ResponseTranscriptDelta {
                response_id: "response-1".to_owned(),
                text: "omitted".to_owned(),
            },
            None,
        ),
        (
            "ResponseTextStarted",
            BrainEvent::ResponseTextStarted {
                response_id: "response-1".to_owned(),
            },
            None,
        ),
        (
            "TranscriptFinal",
            BrainEvent::TranscriptFinal {
                response_id: "response-1".to_owned(),
                text: "omitted".to_owned(),
                confidence: Some(0.9),
            },
            None,
        ),
    ]
}

struct ProviderTurnAccounting {
    pending_submitted_answers: u32,
    active_provider_turns: u32,
    pending_provider_admissions: Vec<VoiceLimitLease>,
    resolved_submitted_answer_response_ids: HashSet<String>,
    completed_provider_turn_response_ids: HashSet<String>,
    superseded_provider_turn_response_ids: HashSet<String>,
    turn_cap_deadline: Option<Instant>,
}

impl ProviderTurnAccounting {
    fn with_one_open_turn() -> Self {
        Self {
            pending_submitted_answers: 1,
            active_provider_turns: 1,
            pending_provider_admissions: Vec::new(),
            resolved_submitted_answer_response_ids: HashSet::new(),
            completed_provider_turn_response_ids: HashSet::new(),
            superseded_provider_turn_response_ids: HashSet::new(),
            turn_cap_deadline: Some(Instant::now() + Duration::from_secs(45)),
        }
    }

    fn apply(&mut self, event: &BrainEvent) {
        let resolution = classify_provider_turn_event(event);
        let mut runtime = ProviderTurnRuntime {
            pending_submitted_answers: &mut self.pending_submitted_answers,
            active_provider_turns: &mut self.active_provider_turns,
            pending_provider_admissions: &mut self.pending_provider_admissions,
            resolved_submitted_answer_response_ids: &mut self
                .resolved_submitted_answer_response_ids,
            completed_provider_turn_response_ids: &mut self.completed_provider_turn_response_ids,
            superseded_provider_turn_response_ids: &mut self.superseded_provider_turn_response_ids,
            turn_cap_deadline: &mut self.turn_cap_deadline,
        };
        apply_provider_turn_accounting(resolution, &mut runtime);
    }
}

#[test]
fn provider_turn_classifier_maps_every_named_brain_event_exactly_once() {
    for (name, event, expected) in every_named_brain_event() {
        assert_eq!(
            classify_provider_turn_event(&event),
            expected,
            "{name} classified differently than the single mapping declares"
        );
    }
}

/// `SERVICE-006`: both counters consume the same returned value. `TurnDeferred`
/// is the discriminating case — the two pre-remediation classifiers each
/// ignored it, so a surviving second classifier leaves one counter behind.
#[test]
fn provider_turn_classifier_feeds_both_counters_from_one_value() {
    for (name, event, expected) in every_named_brain_event() {
        let mut accounting = ProviderTurnAccounting::with_one_open_turn();
        accounting.apply(&event);
        let (expected_pending, expected_active) = match &expected {
            None => (1, 1),
            Some(_) => (0, 0),
        };
        assert_eq!(
            accounting.pending_submitted_answers, expected_pending,
            "{name} left the submitted-answer counter behind"
        );
        assert_eq!(
            accounting.active_provider_turns, expected_active,
            "{name} left the active-provider-turn counter behind"
        );
    }
}

#[test]
fn provider_turn_classifier_resolves_a_duplicate_delivery_once() {
    let mut accounting = ProviderTurnAccounting::with_one_open_turn();
    accounting.pending_submitted_answers = 2;
    accounting.active_provider_turns = 2;
    let completed = BrainEvent::ResponseCompleted {
        response_id: "response-1".to_owned(),
    };

    accounting.apply(&completed);
    accounting.apply(&completed);

    assert_eq!(accounting.pending_submitted_answers, 1);
    assert_eq!(accounting.active_provider_turns, 1);
}

#[test]
fn provider_turn_classifier_terminal_phase_clears_every_open_turn() {
    let mut accounting = ProviderTurnAccounting::with_one_open_turn();
    accounting.pending_submitted_answers = 3;
    accounting.active_provider_turns = 3;

    accounting.apply(&BrainEvent::TerminalSessionPhase {
        phase: StudySessionPhase::Recap,
        terminal_reason: TerminalSessionReason::Drained,
    });

    assert_eq!(accounting.pending_submitted_answers, 0);
    assert_eq!(accounting.active_provider_turns, 0);
    assert_eq!(accounting.turn_cap_deadline, None);
}

fn deferred_event(
    response_id: &str,
    question_id: &str,
    reason: agent_domain::EvaluationDeferralReason,
    can_retry_same_question: bool,
) -> BrainEvent {
    BrainEvent::TurnDeferred {
        response_id: response_id.to_owned(),
        question_id: question_id.to_owned(),
        reason,
        can_retry_same_question,
    }
}

fn bound_tracker(pairs: &[(&str, &str)]) -> TurnBindingTracker {
    let mut tracker = TurnBindingTracker::default();
    for (turn_id, response_id) in pairs {
        tracker
            .register_submission((*turn_id).to_owned())
            .expect("submission registers");
        tracker.bind_question(response_id).expect("question binds");
    }
    tracker
}

#[test]
fn turn_deferred_binding_maps_sequential_and_overlapping_submissions() {
    let mut tracker = TurnBindingTracker::default();
    tracker.register_submission("turn-1".to_owned()).unwrap();
    tracker.register_submission("turn-2".to_owned()).unwrap();

    assert_eq!(tracker.bind_question("response-1").unwrap(), "turn-1");
    assert_eq!(tracker.bind_question("response-2").unwrap(), "turn-2");
    assert_eq!(tracker.turn_for_response("response-1").unwrap(), "turn-1");
    assert_eq!(tracker.turn_for_response("response-2").unwrap(), "turn-2");
}

#[test]
fn turn_deferred_binding_rejects_duplicate_turn_and_response_ids() {
    let mut tracker = TurnBindingTracker::default();
    tracker.register_submission("turn-1".to_owned()).unwrap();
    assert_eq!(
        tracker.register_submission("turn-1".to_owned()),
        Err(TurnBindingError::DuplicateTurn)
    );

    tracker.bind_question("response-1").unwrap();
    assert_eq!(
        tracker.register_submission("turn-1".to_owned()),
        Err(TurnBindingError::DuplicateTurn)
    );

    tracker.register_submission("turn-2".to_owned()).unwrap();
    assert_eq!(
        tracker.bind_question("response-1").map(ToOwned::to_owned),
        Err(TurnBindingError::DuplicateResponse)
    );
}

#[test]
fn turn_deferred_binding_requires_a_registered_turn_before_a_question() {
    let mut tracker = TurnBindingTracker::default();
    assert_eq!(
        tracker.bind_question("response-1").map(ToOwned::to_owned),
        Err(TurnBindingError::MissingTurn)
    );
    assert_eq!(
        tracker.turn_for_response("response-1"),
        Err(TurnBindingError::MissingResponse)
    );
}

#[test]
fn turn_deferred_binding_mints_a_canonical_server_turn_for_a_proactive_question() {
    let mut tracker = TurnBindingTracker::default();

    let first = tracker.register_server_turn().expect("first server turn");
    assert_eq!(first, "turn-1");
    assert_eq!(tracker.bind_question("response-1").unwrap(), "turn-1");

    let second = tracker.register_server_turn().expect("second server turn");
    assert_eq!(second, "turn-2");
    assert_eq!(tracker.bind_question("response-2").unwrap(), "turn-2");
}

#[test]
fn turn_deferred_binding_releases_a_response_only_after_its_resolution() {
    let mut tracker = bound_tracker(&[("turn-1", "response-1")]);
    assert_eq!(tracker.turn_for_response("response-1").unwrap(), "turn-1");

    tracker.release_response("response-1");

    assert_eq!(
        tracker.turn_for_response("response-1"),
        Err(TurnBindingError::MissingResponse)
    );
    // The released turn id is spent, not recycled.
    assert_eq!(
        tracker.register_submission("turn-1".to_owned()),
        Err(TurnBindingError::DuplicateTurn)
    );
}

#[test]
fn turn_deferred_maps_an_unknown_response_to_a_protocol_invariant() {
    let bindings = bound_tracker(&[("turn-1", "response-1")]);
    let event = deferred_event(
        "response-unknown",
        "question-1",
        agent_domain::EvaluationDeferralReason::EmptyAnswer,
        true,
    );

    let diagnostic = map_turn_deferred(&event, &bindings).expect_err("unknown response");

    assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::Invariant);
    assert_eq!(diagnostic.code.as_str(), "VOICE_PROTOCOL_INVARIANT");
    assert_eq!(diagnostic.path, "$.event.turn_id");
}

#[test]
fn turn_deferred_refuses_to_map_any_other_event() {
    let bindings = bound_tracker(&[("turn-1", "response-1")]);
    let event = BrainEvent::ResponseCompleted {
        response_id: "response-1".to_owned(),
    };

    let diagnostic = map_turn_deferred(&event, &bindings).expect_err("wrong event type");

    assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::Invariant);
    assert_eq!(diagnostic.path, "$.event.type");
}

/// `SERVICE-014`: a provider may resolve a turn it never announced — the
/// runner re-keys a first turn's response identity by the client generation
/// of the answer it is resolving, with no second `question_started`. That
/// deferral is bindable only when the socket has exactly one unresolved
/// submission, because only then is there a single candidate it can belong
/// to. One submission binds it; nothing is minted.
#[test]
fn turn_deferred_binding_accepts_an_unannounced_deferral_with_one_open_submission() {
    let mut tracker = TurnBindingTracker::default();
    tracker.register_submission("turn-a".to_owned()).unwrap();

    assert_eq!(
        tracker
            .bind_unannounced_deferral("response-1-generation-rekeyed")
            .unwrap(),
        "turn-a"
    );
    assert_eq!(
        tracker
            .turn_for_response("response-1-generation-rekeyed")
            .unwrap(),
        "turn-a"
    );
}

/// Two open submissions make the same deferral ambiguous, and an ambiguous
/// binding fails closed: the socket refuses rather than consuming whichever
/// submission happens to be oldest. Nothing is consumed, so both submissions
/// are still bindable by their own `question_started`.
#[test]
fn turn_deferred_binding_refuses_an_ambiguous_unannounced_deferral() {
    let mut tracker = TurnBindingTracker::default();
    tracker.register_submission("turn-a".to_owned()).unwrap();
    tracker.register_submission("turn-b".to_owned()).unwrap();

    assert_eq!(
        tracker
            .bind_unannounced_deferral("response-never-announced")
            .map(ToOwned::to_owned),
        Err(TurnBindingError::AmbiguousTurn)
    );

    assert_eq!(tracker.bind_question("response-a").unwrap(), "turn-a");
    assert_eq!(tracker.bind_question("response-b").unwrap(), "turn-b");
    assert_eq!(
        tracker.turn_for_response("response-never-announced"),
        Err(TurnBindingError::MissingResponse)
    );
}

/// With no open submission there is nothing to bind, and with an already
/// bound response there is nothing to rebind. Both fail closed.
#[test]
fn turn_deferred_binding_refuses_an_unbindable_unannounced_deferral() {
    let mut empty = TurnBindingTracker::default();
    assert_eq!(
        empty
            .bind_unannounced_deferral("response-never-announced")
            .map(ToOwned::to_owned),
        Err(TurnBindingError::MissingTurn)
    );

    let mut bound = bound_tracker(&[("turn-1", "response-1")]);
    bound.register_submission("turn-2".to_owned()).unwrap();
    assert_eq!(
        bound
            .bind_unannounced_deferral("response-1")
            .map(ToOwned::to_owned),
        Err(TurnBindingError::DuplicateResponse)
    );
    // The open submission survives the refusal.
    assert_eq!(bound.bind_question("response-2").unwrap(), "turn-2");
}

/// The ambiguous case, end to end through the mapper: no binding means no
/// `turn_deferred` frame and a `VOICE_PROTOCOL_INVARIANT` diagnostic, never
/// a frame naming a turn the deferral was not shown to belong to.
#[test]
fn turn_deferred_ambiguous_binding_maps_to_an_invariant_and_no_frame() {
    let mut tracker = TurnBindingTracker::default();
    tracker.register_submission("turn-a".to_owned()).unwrap();
    tracker.register_submission("turn-b".to_owned()).unwrap();
    let event = deferred_event(
        "response-never-announced",
        "question-1",
        agent_domain::EvaluationDeferralReason::EvaluatorUnavailable,
        true,
    );

    let _ = tracker.bind_unannounced_deferral("response-never-announced");
    let diagnostic = map_turn_deferred(&event, &tracker).expect_err("ambiguous binding");

    assert_eq!(diagnostic.code, VoiceProtocolDiagnosticCode::Invariant);
    assert_eq!(diagnostic.path, "$.event.turn_id");
}

#[derive(Deserialize)]
struct TurnOutcomeFixtureCase {
    id: String,
    wire_json: String,
    valid: bool,
}

#[derive(Deserialize)]
struct TurnOutcomeFixture {
    schema: String,
    protocol_version: u32,
    cases: Vec<TurnOutcomeFixtureCase>,
}

/// Plan 05's frozen deferred cases, byte-for-byte. Every one of the six exact
/// reasons and both retry booleans is mapped through the owner-provided
/// constructor and re-serialized; the fixture bytes are the assertion.
#[test]
fn turn_deferred_fixture_cases_map_byte_for_byte() {
    let fixture: TurnOutcomeFixture = serde_json::from_str(include_str!(
        "../../../../fixtures/voice-protocol/v5/turn-outcomes.json"
    ))
    .expect("turn-outcomes fixture parses");
    assert_eq!(fixture.schema, "viva.voice-server-event-cases.v1");
    assert_eq!(fixture.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);

    let mut seen_reasons = HashSet::new();
    let mut seen_retry = HashSet::new();
    let mut mapped = 0_usize;
    for case in &fixture.cases {
        if !case.valid {
            continue;
        }
        let wire: serde_json::Value =
            serde_json::from_str(&case.wire_json).expect("case wire json parses");
        if wire["event"]["type"] != "turn_deferred" {
            continue;
        }
        let turn_id = wire["event"]["turn_id"].as_str().expect("fixture turn_id");
        let response_id = wire["event"]["response_id"]
            .as_str()
            .expect("fixture response_id");
        let question_id = wire["event"]["question_id"]
            .as_str()
            .expect("fixture question_id");
        let reason: agent_domain::EvaluationDeferralReason =
            serde_json::from_value(wire["event"]["reason"].clone())
                .expect("fixture reason is a typed deferral reason");
        let can_retry_same_question = wire["event"]["can_retry_same_question"]
            .as_bool()
            .expect("fixture can_retry_same_question");

        // Nothing beyond the five typed members may appear on the wire.
        let members = wire["event"]
            .as_object()
            .expect("event object")
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        assert_eq!(
            members,
            [
                "type",
                "turn_id",
                "response_id",
                "question_id",
                "reason",
                "can_retry_same_question",
            ]
            .into_iter()
            .map(ToOwned::to_owned)
            .collect::<HashSet<_>>(),
            "{} carries a member outside the deferral contract",
            case.id
        );
        for forbidden in [
            "retryable",
            "terminal_reason",
            "message",
            "provider_message",
            "feedback",
            "concise_feedback",
            "confidence",
            "confidence_score",
            "concept_status",
            "review_schedule",
            "schedule",
            "mastery",
            "recap",
        ] {
            assert!(
                !case.wire_json.contains(forbidden),
                "{} leaks {forbidden}",
                case.id
            );
        }

        let event = deferred_event(
            response_id,
            question_id,
            reason.clone(),
            can_retry_same_question,
        );
        let mut bindings = TurnBindingTracker::default();
        bindings
            .register_submission(turn_id.to_owned())
            .expect("fixture turn registers");
        bindings
            .bind_question(response_id)
            .expect("fixture question binds");

        let frame = map_turn_deferred(&event, &bindings).expect("fixture case maps");
        let rendered = serde_json::to_string(&frame).expect("frame serializes");
        assert_eq!(
            rendered, case.wire_json,
            "{} did not map byte-exactly",
            case.id
        );

        seen_reasons.insert(format!("{reason:?}"));
        seen_retry.insert(can_retry_same_question);
        mapped += 1;
    }

    assert_eq!(
        seen_reasons.len(),
        6,
        "every deferral reason must be covered"
    );
    assert_eq!(seen_retry.len(), 2, "both retry booleans must be covered");
    assert_eq!(mapped, 12, "six reasons times two retry booleans");
}

#[tokio::test(start_paused = true)]
async fn between_turn_idle_rearms_only_when_no_turn_is_outstanding() {
    for (pending, active, expected) in [
        (0_u32, 0_u32, true),
        (1, 0, false),
        (0, 1, false),
        (2, 3, false),
    ] {
        let sleeper = tokio::time::sleep(Duration::from_secs(1));
        tokio::pin!(sleeper);
        assert_eq!(
            rearm_between_turn_idle(
                pending,
                active,
                sleeper.as_mut(),
                Instant::now(),
                Duration::from_secs(600),
            ),
            expected,
            "pending={pending} active={active}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn between_turn_idle_rearms_after_provider_completion() {
    let start = Instant::now();
    let between_turn_idle = Duration::from_secs(600);
    let sleeper = tokio::time::sleep(between_turn_idle);
    tokio::pin!(sleeper);
    assert_eq!(sleeper.deadline(), start + between_turn_idle);

    // A submitted answer disarms the between-turn deadline.
    let mut accounting = ProviderTurnAccounting::with_one_open_turn();
    assert!(!rearm_between_turn_idle(
        accounting.pending_submitted_answers,
        accounting.active_provider_turns,
        sleeper.as_mut(),
        Instant::now(),
        between_turn_idle,
    ));
    assert_eq!(sleeper.deadline(), start + between_turn_idle);

    tokio::time::advance(Duration::from_secs(30)).await;
    accounting.apply(&BrainEvent::ResponseCompleted {
        response_id: "response-1".to_owned(),
    });
    assert_eq!(accounting.pending_submitted_answers, 0);
    assert_eq!(accounting.active_provider_turns, 0);
    assert!(rearm_between_turn_idle(
        accounting.pending_submitted_answers,
        accounting.active_provider_turns,
        sleeper.as_mut(),
        Instant::now(),
        between_turn_idle,
    ));
    assert_eq!(sleeper.deadline(), start + Duration::from_secs(630));

    tokio::time::advance(Duration::from_secs(599)).await;
    assert!(!sleeper.is_elapsed(), "t=629 is still inside the deadline");

    tokio::time::advance(Duration::from_secs(1)).await;
    sleeper.as_mut().await;
    assert!(sleeper.is_elapsed(), "t=630 expires the between-turn idle");
}

#[tokio::test(start_paused = true)]
async fn between_turn_idle_is_not_extended_by_keepalives_or_repeated_completion() {
    let start = Instant::now();
    let between_turn_idle = Duration::from_secs(600);
    let sleeper = tokio::time::sleep(between_turn_idle);
    tokio::pin!(sleeper);

    let mut accounting = ProviderTurnAccounting::with_one_open_turn();
    accounting.apply(&BrainEvent::ResponseCompleted {
        response_id: "response-1".to_owned(),
    });
    assert!(rearm_between_turn_idle(
        accounting.pending_submitted_answers,
        accounting.active_provider_turns,
        sleeper.as_mut(),
        Instant::now(),
        between_turn_idle,
    ));
    let armed_deadline = sleeper.deadline();
    assert_eq!(armed_deadline, start + between_turn_idle);

    tokio::time::advance(Duration::from_secs(100)).await;

    // A repeated completion for the same response resolves nothing, so the
    // deadline is not moved. Ping/Pong and a context-only refresh never reach
    // the classifier at all.
    accounting.apply(&BrainEvent::ResponseCompleted {
        response_id: "response-1".to_owned(),
    });
    assert_eq!(
        classify_provider_turn_event(&BrainEvent::SessionPhase {
            phase: StudySessionPhase::Listening,
        }),
        None
    );
    assert_eq!(sleeper.deadline(), armed_deadline);
}

#[tokio::test(start_paused = true)]
async fn between_turn_idle_rearms_after_cancel_and_after_all_turns_complete() {
    let between_turn_idle = Duration::from_secs(600);
    for event in [
        BrainEvent::ResponseCancelled,
        BrainEvent::ResponseCancelledFor {
            response_id: "response-1".to_owned(),
        },
        BrainEvent::TerminalSessionPhase {
            phase: StudySessionPhase::Recap,
            terminal_reason: TerminalSessionReason::ProviderCancelled,
        },
    ] {
        let sleeper = tokio::time::sleep(Duration::from_secs(1));
        tokio::pin!(sleeper);
        let mut accounting = ProviderTurnAccounting::with_one_open_turn();
        accounting.apply(&event);
        let now = Instant::now();
        assert!(
            rearm_between_turn_idle(
                accounting.pending_submitted_answers,
                accounting.active_provider_turns,
                sleeper.as_mut(),
                now,
                between_turn_idle,
            ),
            "{event:?} must return the socket to the between-turn deadline"
        );
        assert_eq!(sleeper.deadline(), now + between_turn_idle);
    }
}

#[tokio::test]
async fn local_open_connection_failure_does_not_record_provider_backoff() {
    use std::sync::Arc;

    use agent_adapters::SyntheticBrain;

    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    // A store-stage failure at open is a local durability problem, not evidence
    // about the provider.
    let error = BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
        failure_class: BrainFailureClass::Timeout,
        stage: BrainFailureStage::Store,
        retry_eligible: false,
        latency_ms: 0,
        provider: "synthetic".to_owned(),
        model: String::new(),
        metadata: "error_kind=voice_session_write_failed".to_owned(),
    }));
    assert_eq!(
        terminal_reason_for_brain_error(&error),
        TerminalSessionReason::ProviderTimeout
    );

    record_brain_open_provider_failure(&state, Some("voice-session-1".to_owned()), &error);
    let admission = state
        .limit_state
        .try_admit_provider_turn(&state.voice_limits, ProviderQueueBehavior::Wait)
        .await;

    assert!(
        matches!(admission.decision, ProviderAdmissionDecision::Admitted),
        "local open failures must not poison provider backoff"
    );
}

#[tokio::test]
async fn provider_open_connection_failure_records_provider_backoff() {
    use std::sync::Arc;

    use agent_adapters::SyntheticBrain;

    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let error = BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
        failure_class: BrainFailureClass::Timeout,
        stage: BrainFailureStage::Gemini,
        retry_eligible: false,
        latency_ms: 0,
        provider: "synthetic".to_owned(),
        model: String::new(),
        metadata: String::new(),
    }));
    assert_eq!(
        terminal_reason_for_brain_error(&error),
        TerminalSessionReason::ProviderTimeout
    );

    record_brain_open_provider_failure(&state, Some("voice-session-1".to_owned()), &error);
    let admission = state
        .limit_state
        .try_admit_provider_turn(&state.voice_limits, ProviderQueueBehavior::Wait)
        .await;

    assert!(
        matches!(admission.decision, ProviderAdmissionDecision::Denied(_)),
        "provider open failures must poison provider backoff"
    );
}

#[tokio::test]
async fn queued_provider_admission_drop_releases_waiter() {
    let limit_state = VoiceLimitState::default();
    let limits = VoiceLimitConfig {
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(1),
        ..VoiceLimitConfig::default()
    };
    let held = limit_state
        .try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait)
        .await
        .lease
        .expect("first admission should hold the only provider slot");
    let client_input = ClientInputAction::Send {
        brain_input: BrainInput::TextWithMetadata {
            text: "omitted".to_owned(),
            client_generation_id: Some("queued-input".to_owned()),
        },
        action: ClientAction::AnswerText,
        turn_id: Some("queued-turn".to_owned()),
    };
    let mut queued = start_provider_admission(
        limit_state.clone(),
        limits.clone(),
        client_input,
        ProviderQueueBehavior::Wait,
    );

    assert!(
        timeout(Duration::from_millis(25), &mut queued)
            .await
            .is_err(),
        "queued admission should wait while the provider slot is held"
    );
    drop(queued);
    drop(held);

    let fresh = timeout(
        Duration::from_millis(50),
        limit_state.try_admit_provider_turn(&limits, ProviderQueueBehavior::Wait),
    )
    .await
    .expect("dropping queued socket admission should release its queue waiter");
    assert!(matches!(
        fresh.decision,
        ProviderAdmissionDecision::Admitted
    ));
    assert_eq!(fresh.queue_depth, 0);
}

struct FailingSink;

impl futures_util::Sink<Message> for FailingSink {
    type Error = axum::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
        Err(axum::Error::new(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "writer closed",
        )))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

struct RecordingSink {
    sent: Vec<Message>,
}

impl RecordingSink {
    fn new() -> Self {
        Self { sent: vec![] }
    }
}

impl futures_util::Sink<Message> for RecordingSink {
    type Error = axum::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        self.sent.push(item);
        Ok(())
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn maps_versioned_audio_text_and_cancel_frames_to_brain_inputs() {
    let (input, mut received) = mpsc::channel(8);
    let audio_chunk = include_str!("../../../../fixtures/voice-protocol/client-audio.json");
    let binding = fixture_binding();
    let mut audio_assembly = AudioTurnAssembly::default();

    assert_eq!(
        handle_client_message(
            Message::Text(audio_chunk.to_owned().into()),
            &input,
            &binding,
            &mut audio_assembly,
        )
        .await
        .unwrap(),
        ClientAction::AudioChunk
    );
    handle_client_message(
        Message::Text(
            json!({
                "type": "audio_end",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "1",
                "turn_id": "turn-1",
                "final_sequence": 0,
            })
            .to_string()
            .into(),
        ),
        &input,
        &binding,
        &mut audio_assembly,
    )
    .await
    .unwrap();
    handle_client_message(
        Message::Text(
            json!({
                "type": "turn_intent",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "1",
                "turn_id": "turn-2",
                "intent": { "kind": "answer_text", "text": "quiz me" },
            })
            .to_string()
            .into(),
        ),
        &input,
        &binding,
        &mut audio_assembly,
    )
    .await
    .unwrap();
    handle_client_message(
        Message::Text(
            json!({
                "type": "cancel",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "1",
            })
            .to_string()
            .into(),
        ),
        &input,
        &binding,
        &mut audio_assembly,
    )
    .await
    .unwrap();

    match received.recv().await.unwrap() {
        BrainInput::AudioWithMetadata {
            frame,
            client_generation_id,
        } => {
            assert_eq!(frame.pcm16_bytes(), &[1, 2, 3, 4]);
            assert_eq!(client_generation_id.as_deref(), Some("1"));
        }
        other => panic!("expected one assembled audio input, got {other:?}"),
    }
    match received.recv().await.unwrap() {
        BrainInput::TextWithMetadata {
            text,
            client_generation_id,
        } => {
            assert_eq!(text, "quiz me");
            assert_eq!(client_generation_id.as_deref(), Some("1"));
        }
        other => panic!("expected text input, got {other:?}"),
    }
    assert!(matches!(
        received.recv().await.unwrap(),
        BrainInput::CancelResponse
    ));
}

#[test]
fn preserves_initial_session_config_generation_metadata() {
    let initial = initial_session_config_from_message(Message::Text(
        json!({
            "type": "session_config",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "session": {
                "session_id": "voice-session-1",
                "user_id": "user-1",
                "study_set_id": "biology-midterm",
                "source_context": [],
                "active_concepts": [],
            },
            "session_token": "placeholder-session-material",
            "client_generation_id": "token_refresh-3",
        })
        .to_string()
        .into(),
    ))
    .unwrap();

    assert_eq!(initial.client_generation_id, "token_refresh-3");
    assert_eq!(initial.session_token, "placeholder-session-material");
    assert_eq!(initial.session.client_generation_id, None);
}

#[tokio::test]
async fn maps_client_generation_ids_to_brain_inputs() {
    let (input, mut received) = mpsc::channel(8);
    let binding = fixture_binding();
    let mut audio_assembly = AudioTurnAssembly::default();

    handle_client_message(
        Message::Text(
            json!({
                "type": "turn_intent",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "bfcache_restore-2",
                "turn_id": "turn-00",
                "intent": { "kind": "answer_text", "text": "quiz me" },
            })
            .to_string()
            .into(),
        ),
        &input,
        &binding,
        &mut audio_assembly,
    )
    .await
    .unwrap();
    handle_client_message(
        Message::Text(
            json!({
                "type": "audio_chunk",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "token_refresh-3",
                "turn_id": "turn-01",
                "sequence": 0,
                "frame": { "pcm16_base64": "AQIDBA==" },
            })
            .to_string()
            .into(),
        ),
        &input,
        &binding,
        &mut audio_assembly,
    )
    .await
    .unwrap();
    handle_client_message(
        Message::Text(
            json!({
                "type": "audio_end",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "client_generation_id": "token_refresh-3",
                "turn_id": "turn-01",
                "final_sequence": 0,
            })
            .to_string()
            .into(),
        ),
        &input,
        &binding,
        &mut audio_assembly,
    )
    .await
    .unwrap();

    match received.recv().await.unwrap() {
        BrainInput::TextWithMetadata {
            text,
            client_generation_id,
        } => {
            assert_eq!(text, "quiz me");
            assert_eq!(client_generation_id.as_deref(), Some("bfcache_restore-2"));
        }
        other => panic!("expected text input with metadata, got {other:?}"),
    }
    match received.recv().await.unwrap() {
        BrainInput::AudioWithMetadata {
            frame,
            client_generation_id,
        } => {
            assert_eq!(frame.pcm16_bytes(), &[1, 2, 3, 4]);
            assert_eq!(client_generation_id.as_deref(), Some("token_refresh-3"));
        }
        other => panic!("expected audio input with metadata, got {other:?}"),
    }
}

#[test]
fn requires_session_config_as_bootstrap_frame() {
    let session = include_str!("../../../../fixtures/voice-protocol/session-config.json");
    let message = Message::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"1","session_token":"placeholder-session-material","session":{session}}}"#
            )
            .into(),
        );
    let config = session_config_from_message(message).unwrap();

    assert_eq!(config.study_set_id.as_deref(), Some("biology-midterm"));
    assert!(session_config_from_message(Message::Text(
        json!({
            "type": "turn_intent",
            "version": VIVA_VOICE_PROTOCOL_VERSION,
            "client_generation_id": "1",
            "turn_id": "turn-1",
            "intent": { "kind": "answer_text", "text": "quiz me" },
        })
        .to_string()
        .into()
    ))
    .is_err());
}

/// The identity comparison a first frame runs, expressed against the binding the
/// socket produced from it.
fn sanitize_fixture_config(
    config: SessionConfig,
    binding: &AuthorizedClientSession,
) -> Result<SessionConfig, ClientFrameError> {
    sanitize_client_session_config(
        config,
        &binding.user_id,
        &binding.study_set_id,
        &binding.client_session_id,
    )
}

#[test]
fn sanitizes_session_config_identity_and_strips_browser_source_context() {
    let session = include_str!("../../../../fixtures/voice-protocol/session-config.json");
    let message = Message::Text(
            format!(
                r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"1","session_token":"placeholder-session-material","session":{session}}}"#
            )
            .into(),
        );
    let config = session_config_from_message(message).unwrap();
    let binding = fixture_binding();
    let sanitized = sanitize_fixture_config(config, &binding).unwrap();

    assert_eq!(sanitized.user_id.as_deref(), Some("user-1"));
    assert_eq!(sanitized.study_set_id.as_deref(), Some("biology-midterm"));
    assert_eq!(sanitized.session_id.as_deref(), Some("voice-session-1"));
    assert!(sanitized.source_context.is_empty());
    assert!(sanitized.active_concepts.is_empty());

    let mut missing_session = sanitized.clone();
    missing_session.session_id = None;
    assert_eq!(
        sanitize_fixture_config(missing_session, &binding),
        Err(ClientFrameError::invalid_session_identity())
    );

    let mut forged_session = sanitized.clone();
    forged_session.session_id = Some(agent_domain::SessionId::new("voice-session-2"));
    assert_eq!(
        sanitize_fixture_config(forged_session, &binding),
        Err(ClientFrameError::invalid_session_identity())
    );

    let mut forged_user = sanitized.clone();
    forged_user.user_id = Some("user-2".to_owned());
    assert_eq!(
        sanitize_fixture_config(forged_user, &binding),
        Err(ClientFrameError::invalid_session_identity())
    );

    let mut forged_study_set = sanitized.clone();
    forged_study_set.study_set_id = Some("chemistry-final".to_owned());
    assert_eq!(
        sanitize_fixture_config(forged_study_set, &binding),
        Err(ClientFrameError::invalid_session_identity())
    );

    let mut missing_study_set = sanitized;
    missing_study_set.study_set_id = None;
    assert_eq!(
        sanitize_fixture_config(missing_study_set, &binding),
        Err(ClientFrameError::invalid_session_identity())
    );
}

#[test]
fn server_active_concepts_use_public_ids_or_uuid_fallback_in_context_order() {
    let context = serde_json::json!({
        "concepts": [
            {
                "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "public_id": "first-public",
            },
            {
                "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "public_id": null,
            },
            {
                "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "public_id": "third-public",
            }
        ]
    });

    assert_eq!(
        server_active_concepts(&context),
        vec![
            "first-public".to_owned(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_owned(),
            "third-public".to_owned(),
        ]
    );
}

#[tokio::test]
async fn rejects_unsupported_protocol_versions() {
    let (input, _received) = mpsc::channel(8);
    let binding = fixture_binding();

    let result = handle_client_message(
        Message::Text(r#"{"type":"text","version":1,"text":"quiz me"}"#.into()),
        &input,
        &binding,
        &mut AudioTurnAssembly::default(),
    )
    .await;

    assert_eq!(result, Err(ClientFrameError::invalid()));
}

#[tokio::test]
async fn rejects_browser_tool_result_frames() {
    let (input, _received) = mpsc::channel(8);
    let binding = fixture_binding();

    let result = handle_client_message(
        Message::Text(
            json!({
                "type": "tool_result",
                "version": VIVA_VOICE_PROTOCOL_VERSION,
                "result": {
                    "proposal": {
                        "name": "evaluate_spoken_answer",
                        "arguments": {},
                    },
                    "result": {},
                },
            })
            .to_string()
            .into(),
        ),
        &input,
        &binding,
        &mut AudioTurnAssembly::default(),
    )
    .await;

    // `tool_result` is not a member of the v5 browser-sendable union at all, so
    // it never parses into a frame the server could act on.
    assert_eq!(result, Err(ClientFrameError::invalid()));
}

#[tokio::test]
async fn keepalive_frames_do_not_reach_brain_input() {
    let (input, mut received) = mpsc::channel(1);
    let binding = fixture_binding();

    assert_eq!(
        handle_client_message(
            Message::Ping(vec![1, 2, 3].into()),
            &input,
            &binding,
            &mut AudioTurnAssembly::default()
        )
        .await,
        Ok(ClientAction::Keepalive)
    );
    assert_eq!(
        handle_client_message(
            Message::Pong(vec![1, 2, 3].into()),
            &input,
            &binding,
            &mut AudioTurnAssembly::default()
        )
        .await,
        Ok(ClientAction::Keepalive)
    );
    assert!(received.try_recv().is_err());
}

#[tokio::test]
async fn rejects_oversized_text_and_every_binary_frame() {
    let (input, _received) = mpsc::channel(8);
    let binding = fixture_binding();
    let too_large_text = "x".repeat(VIVA_VOICE_MAX_TEXT_FRAME_BYTES + 1);
    // Protocol v5 has no binary client surface: even a one-byte frame is refused,
    // because accepting it would admit audio that skipped the turn assembler.
    let smallest_binary = vec![0_u8; 1];

    assert_eq!(
        handle_client_message(
            Message::Text(too_large_text.into()),
            &input,
            &binding,
            &mut AudioTurnAssembly::default()
        )
        .await,
        Err(ClientFrameError::oversized_text())
    );
    assert_eq!(
        handle_client_message(
            Message::Binary(smallest_binary.into()),
            &input,
            &binding,
            &mut AudioTurnAssembly::default(),
        )
        .await,
        Err(ClientFrameError::unsupported_binary_frame())
    );
}

#[test]
fn preflight_maps_access_and_capacity_failures_to_http_statuses() {
    use std::sync::Arc;

    use agent_adapters::SyntheticBrain;
    use axum::http::HeaderValue;

    let auth_state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess {
            required_bearer: Some("secret".into()),
            session_token_secret: None,
            allowed_origins: vec![],
        },
        1,
    );
    let headers = HeaderMap::new();
    let peer = client_ip_test_peer("198.51.100.7");
    match validate_ws_preflight(&auth_state, peer, &headers) {
        Err(rejection) => assert_eq!(rejection.status(), StatusCode::UNAUTHORIZED),
        Ok(_) => panic!("expected bearer rejection"),
    }

    let origin_state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess {
            required_bearer: None,
            session_token_secret: None,
            allowed_origins: vec!["http://localhost:3000".to_owned()],
        },
        1,
    );
    let mut headers = HeaderMap::new();
    headers.insert("origin", HeaderValue::from_static("http://evil.test"));
    match validate_ws_preflight(&origin_state, peer, &headers) {
        Err(rejection) => assert_eq!(rejection.status(), StatusCode::FORBIDDEN),
        Ok(_) => panic!("expected origin rejection"),
    }

    let capacity_state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let _held = capacity_state
        .session_slots
        .clone()
        .try_acquire_owned()
        .unwrap();
    match validate_ws_preflight(&capacity_state, peer, &HeaderMap::new()) {
        Err(rejection) => assert_eq!(rejection.status(), StatusCode::TOO_MANY_REQUESTS),
        Ok(_) => panic!("expected capacity rejection"),
    }
}

#[tokio::test]
async fn terminal_session_phase_close_preserves_deploy_drain_when_writer_fails() {
    let (input, mut received) = mpsc::channel(1);
    let mut sender = BoundedSender::new(FailingSink, Duration::from_secs(5));
    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let mut terminal_close = TerminalCloseState::default();

    let reason = close_with_terminal_session_phase(
        &mut sender,
        &input,
        &state,
        None,
        &mut terminal_close,
        TerminalSessionReason::Drained,
        close_code::NORMAL,
    )
    .await;

    assert_eq!(reason, "drained");
    assert!(terminal_close.persisted);
    // `A-20.2`: whichever label wins, the write side failing is recorded.
    assert!(terminal_close.write_failed);
    assert!(matches!(received.recv().await.unwrap(), BrainInput::Stop));
}

#[tokio::test]
async fn terminal_session_phase_close_preserves_provider_reason_when_writer_fails() {
    let (input, mut received) = mpsc::channel(1);
    let mut sender = BoundedSender::new(FailingSink, Duration::from_secs(5));
    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let mut terminal_close = TerminalCloseState::default();

    let reason = close_with_terminal_session_phase(
        &mut sender,
        &input,
        &state,
        None,
        &mut terminal_close,
        TerminalSessionReason::ProviderRateLimited,
        close_code::ERROR,
    )
    .await;

    assert_eq!(reason, "provider_rate_limited");
    assert!(terminal_close.persisted);
    // `A-20.2`: the overriding wire reason does not hide the failed write.
    assert!(terminal_close.write_failed);
    assert!(matches!(received.recv().await.unwrap(), BrainInput::Stop));
}

#[test]
fn terminal_phase_close_preserves_durability_label_after_send_failure() {
    assert_eq!(
        terminal_label_after_terminal_phase_close(
            TerminalSessionReason::DurabilityDegraded,
            "send_failed",
        ),
        "durability_degraded"
    );
    assert_eq!(
        terminal_label_after_terminal_phase_close(
            TerminalSessionReason::ProviderRateLimited,
            "send_failed",
        ),
        "provider_rate_limited"
    );
    assert_eq!(
        terminal_label_after_terminal_phase_close(TerminalSessionReason::Drained, "send_failed"),
        "drained"
    );
    assert_eq!(
        terminal_label_after_terminal_phase_close(TerminalSessionReason::RateLimit, "send_failed"),
        "rate_limit"
    );
    assert_eq!(
        terminal_label_after_terminal_phase_close(TerminalSessionReason::TurnCap, "send_failed"),
        "turn_cap"
    );
    assert_eq!(
        terminal_label_after_terminal_phase_close(TerminalSessionReason::SessionCap, "send_failed"),
        "session_cap"
    );
    assert_eq!(
        terminal_label_after_terminal_phase_close(TerminalSessionReason::SlowClient, "send_failed"),
        "slow_client"
    );
    assert_eq!(
        terminal_label_after_terminal_phase_close(
            TerminalSessionReason::ToolExecutorFailure,
            "send_failed",
        ),
        "tool_executor_failure"
    );
}

#[tokio::test]
async fn terminal_session_phase_close_does_not_wait_for_full_input_channel() {
    let (input, mut received) = mpsc::channel(1);
    input
        .try_send(BrainInput::Text("queued".to_owned()))
        .unwrap();
    let mut sender = BoundedSender::new(RecordingSink::new(), Duration::from_secs(5));
    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let mut terminal_close = TerminalCloseState::default();

    let reason = timeout(
        Duration::from_millis(100),
        close_with_terminal_session_phase(
            &mut sender,
            &input,
            &state,
            None,
            &mut terminal_close,
            TerminalSessionReason::Drained,
            close_code::NORMAL,
        ),
    )
    .await
    .expect("terminal close must not block behind provider input backpressure");

    assert_eq!(reason, "drained");
    assert!(terminal_close.persisted);
    assert_eq!(sender.inner.sent.len(), 2);
    let Message::Text(text) = &sender.inner.sent[0] else {
        panic!("expected terminal session phase text frame");
    };
    let frame: ServerFrame = serde_json::from_str(text).unwrap();
    let ServerFrame::Event { event, .. } = frame else {
        panic!("expected terminal session phase event");
    };
    assert!(matches!(
        event.as_ref(),
        crate::VivaServerEvent::SessionPhase {
            terminal_reason: Some(TerminalSessionReason::Drained),
            ..
        }
    ));
    let Message::Close(Some(close)) = &sender.inner.sent[1] else {
        panic!("expected websocket close frame");
    };
    assert_eq!(close.code, close_code::NORMAL);
    assert!(matches!(
        received.try_recv().unwrap(),
        BrainInput::Text(text) if text == "queued"
    ));
    assert!(received.try_recv().is_err());
}

#[tokio::test]
async fn client_stop_terminal_event_drain_times_out_when_provider_stops_sending() {
    use std::sync::Arc;

    use agent_adapters::SyntheticBrain;

    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let (_events_tx, mut events) = mpsc::channel(1);
    let mut cancelled_responses = CancelledResponseTracker::default();
    let mut sender = BoundedSender::new(RecordingSink::new(), Duration::from_secs(5));
    let limits = VoiceLimitConfig::default();
    let mut session_limits = SessionLimitRuntime::new();
    let mut turn_bindings = TurnBindingTracker::default();
    let binding = fixture_binding();
    let mut context = BrainForwardContext {
        state: &state,
        voice_session_id: Some("voice-session-1".to_owned()),
        session_binding: &binding,
        limits: &limits,
        session_limits: &mut session_limits,
        turn_bindings: &mut turn_bindings,
    };
    let started_at = Instant::now();

    let result = drain_terminal_events(
        &mut context,
        &mut events,
        &mut cancelled_responses,
        started_at,
        &mut sender,
    )
    .await
    .unwrap();

    assert_eq!(result, ForwardBrainEvent::Continue);
    assert!(sender.inner.sent.is_empty());
    assert!(started_at.elapsed() >= TERMINAL_EVENT_DRAIN_TIMEOUT);
}

#[tokio::test]
async fn records_usage_events_internally_without_browser_evidence() {
    use std::sync::Arc;

    use agent_adapters::SyntheticBrain;

    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "synthetic",
        crate::VoiceWsAccess::default(),
        1,
    );
    let record = record_brain_event(
        &state,
        Some("voice-session-1".to_owned()),
        &agent_domain::BrainEvent::Usage(agent_domain::BrainUsage {
            text_input_tokens: 20,
            text_output_tokens: 10,
            ..agent_domain::BrainUsage::default()
        }),
        Duration::from_secs(2),
    )
    .await;
    let BrainEventRecordResult::Usage(record) = record else {
        panic!("usage events should return a usage record");
    };

    let usage = state.usage.snapshot();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].provider, "synthetic");
    assert_eq!(usage[0].model, "synthetic-viva");
    assert_eq!(usage[0].duration_seconds, 2);
    assert_eq!(usage[0].answer_eval_latency_ms, Some(2_000));
    assert_eq!(usage[0].text_input_tokens, 20);
    assert_eq!(record.cost_estimate_usd, usage[0].cost_estimate_usd);
    assert!(state.evidence.snapshot().is_empty());
}

#[tokio::test]
async fn records_provider_fallback_activations_internally_without_browser_evidence() {
    use std::sync::Arc;

    use agent_adapters::SyntheticBrain;

    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "cartesia_gemini",
        crate::VoiceWsAccess::default(),
        1,
    );
    let event = agent_domain::BrainEvent::ProviderFallbackActivated {
        response_id: "response-1".to_owned(),
        provider: "gemini".to_owned(),
        from_model: "gemini-3.5-pro".to_owned(),
        to_model: "gemini-3.5-flash".to_owned(),
        reason: "primary_429".to_owned(),
        failure: None,
    };

    assert!(matches!(
        record_brain_event(
            &state,
            Some("voice-session-1".to_owned()),
            &event,
            Duration::from_secs(1),
        )
        .await,
        BrainEventRecordResult::None
    ));
    assert!(crate::protocol::ServerFrame::browser_event(event).is_none());
    let evidence = state.evidence.snapshot();
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].kind, VoiceEvidenceEventKind::ProviderFallback);
    assert_eq!(
        evidence[0].voice_session_id.as_deref(),
        Some("voice-session-1")
    );
    assert!(evidence[0].detail.contains("provider=gemini"));
    assert!(evidence[0].detail.contains("from_model=gemini-3.5-pro"));
    assert!(evidence[0].detail.contains("to_model=gemini-3.5-flash"));
    assert!(evidence[0].detail.contains("reason=primary_429"));
}

#[tokio::test]
async fn provider_fallback_activation_rate_limit_does_not_feed_provider_backoff() {
    use std::sync::Arc;

    use agent_adapters::SyntheticBrain;

    let state = AppState::new(
        Arc::new(SyntheticBrain::default()),
        "cartesia_gemini",
        crate::VoiceWsAccess::default(),
        1,
    )
    .with_voice_limits(VoiceLimitConfig {
        provider_backoff_default_ms: 1_000,
        provider_backoff_max_ms: 5_000,
        ..VoiceLimitConfig::default()
    });
    let event = agent_domain::BrainEvent::ProviderFallbackActivated {
            response_id: "response-1".to_owned(),
            provider: "gemini".to_owned(),
            from_model: "gemini-3.5-pro".to_owned(),
            to_model: "gemini-3.5-flash".to_owned(),
            reason: "primary_429".to_owned(),
            failure: Some(BrainProviderFailure::new(BrainProviderFailureParts {
                failure_class: BrainFailureClass::QuotaRateFailure,
                stage: BrainFailureStage::Gemini,
                retry_eligible: true,
                latency_ms: 17,
                provider: "gemini".to_owned(),
                model: "gemini-3.5-pro".to_owned(),
                metadata: "http_status=429 retry_after_ms=750 retry_after_source=retry_after_delta reset_hint=2030-01-01T00:00:00Z body_status=resource_exhausted budget_state=within_limit deploy_sha=test-sha".to_owned(),
            })),
        };

    assert!(matches!(
        record_brain_event(
            &state,
            Some("voice-session-1".to_owned()),
            &event,
            Duration::from_secs(1),
        )
        .await,
        BrainEventRecordResult::None
    ));

    let admission = state
        .limit_state
        .try_admit_provider_turn(&state.voice_limits, ProviderQueueBehavior::Wait)
        .await;
    let ProviderAdmissionDecision::Admitted = admission.decision else {
        panic!("successful fallback activation must not install provider-wide backoff");
    };
    assert!(state.evidence.snapshot().iter().any(|event| {
        event.kind == VoiceEvidenceEventKind::ProviderFallback
            && event.detail.contains("reason=primary_429")
    }));
}

#[test]
fn cancellation_suppression_keeps_internal_provider_fallback_activations() {
    let mut tracker = CancelledResponseTracker::default();
    let question = fixture_question();

    assert!(!should_suppress_cancelled_response(
        &mut tracker,
        &agent_domain::BrainEvent::QuestionStarted {
            response_id: "response-1".to_owned(),
            question,
        },
    ));
    assert!(!should_suppress_cancelled_response(
        &mut tracker,
        &agent_domain::BrainEvent::ResponseCancelledFor {
            response_id: "response-1".to_owned(),
        },
    ));
    assert!(!should_suppress_cancelled_response(
        &mut tracker,
        &agent_domain::BrainEvent::ProviderFallbackActivated {
            response_id: "response-1".to_owned(),
            provider: "gemini".to_owned(),
            from_model: "gemini-3.5-pro".to_owned(),
            to_model: "gemini-3.5-flash".to_owned(),
            reason: "primary_429".to_owned(),
            failure: None,
        },
    ));
    assert!(should_suppress_cancelled_response(
        &mut tracker,
        &agent_domain::BrainEvent::ResponseTranscriptDelta {
            response_id: "response-1".to_owned(),
            text: "suppressed browser text".to_owned(),
        },
    ));
}

/// Connection-local assembler unit tests. The module name keeps every
/// plan-named test reachable through the `audio_assembler` filter without
/// renaming the test functions themselves.
mod audio_assembler {
    use super::*;

    const TEST_GENERATION: &str = "generation-7";
    const TEST_TURN: &str = "turn-01";

    fn pcm_chunk(bytes: usize) -> AudioFrame {
        AudioFrame::from_pcm16_bytes(vec![0xAB_u8; bytes])
    }

    fn push_chunk(
        assembly: &mut AudioTurnAssembly,
        sequence: u32,
        bytes: usize,
    ) -> Result<AudioAssemblyAction, ClientFrameError> {
        accept_audio_chunk(
            assembly,
            TEST_GENERATION.to_owned(),
            TEST_TURN.to_owned(),
            sequence,
            pcm_chunk(bytes),
        )
        .map_err(ClientFrameError::from)
    }

    fn assert_sanitized_audio_error(error: ClientFrameError, frame: &AudioFrame) {
        let encoded = frame.pcm16_base64();
        if !encoded.is_empty() {
            assert!(!error.message.contains(encoded));
            assert!(!error.close_reason.contains(encoded));
            assert!(!error.terminal_reason.contains(encoded));
        }
        assert!(!error.message.contains("pcm16"));
        assert!(!error.close_reason.contains("pcm16"));
    }

    #[test]
    fn audio_assembler_requires_zero_based_contiguous_sequences() {
        let mut assembly = AudioTurnAssembly::default();
        for sequence in 0..3 {
            let action =
                push_chunk(&mut assembly, sequence, 960).expect("contiguous chunk accepted");
            assert!(matches!(action, AudioAssemblyAction::Pending));
        }

        let turn = assembly
            .open
            .as_ref()
            .expect("assembly is retained until end");
        assert_eq!(turn.client_generation_id, TEST_GENERATION);
        assert_eq!(turn.turn_id, TEST_TURN);
        assert_eq!(turn.next_sequence, 3);
        assert_eq!(turn.pcm16.len(), 2_880);

        let mut nonzero_start = AudioTurnAssembly::default();
        let error =
            push_chunk(&mut nonzero_start, 1, 960).expect_err("a turn cannot start after zero");
        assert_eq!(error, ClientFrameError::invalid_audio_frame());
        assert!(nonzero_start.open.is_none());
    }

    #[test]
    fn audio_assembler_rejects_duplicate_gap_and_out_of_order_sequences() {
        for replayed in [0_u32, 2] {
            let mut assembly = AudioTurnAssembly::default();
            push_chunk(&mut assembly, 0, 960).expect("first chunk accepted");
            let error = push_chunk(&mut assembly, replayed, 960)
                .expect_err("duplicate and gapped sequences fail closed");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
            assert!(
                assembly.open.is_none(),
                "a rejected frame clears the assembly"
            );
        }

        let mut assembly = AudioTurnAssembly::default();
        push_chunk(&mut assembly, 0, 960).expect("first chunk accepted");
        push_chunk(&mut assembly, 1, 960).expect("second chunk accepted");
        let error = push_chunk(&mut assembly, 1, 960)
            .expect_err("a sequence cannot be reused out of order");
        assert_eq!(error, ClientFrameError::invalid_audio_frame());
        assert!(assembly.open.is_none());
    }

    #[test]
    fn audio_assembler_rejects_mismatched_generation_or_turn() {
        for (generation, turn_id) in [(TEST_GENERATION, "turn-02"), ("generation-8", TEST_TURN)] {
            let mut assembly = AudioTurnAssembly::default();
            push_chunk(&mut assembly, 0, 960).expect("first chunk accepted");
            let error = accept_audio_chunk(
                &mut assembly,
                generation.to_owned(),
                turn_id.to_owned(),
                1,
                pcm_chunk(960),
            )
            .map_err(ClientFrameError::from)
            .expect_err("a second identity cannot join an active turn");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
            assert!(assembly.open.is_none());
        }

        for (generation, turn_id) in [("", TEST_TURN), (TEST_GENERATION, "   ")] {
            let mut assembly = AudioTurnAssembly::default();
            let error = accept_audio_chunk(
                &mut assembly,
                generation.to_owned(),
                turn_id.to_owned(),
                0,
                pcm_chunk(960),
            )
            .map_err(ClientFrameError::from)
            .expect_err("empty identity fails closed");
            assert_eq!(error, ClientFrameError::invalid_audio_frame());
            assert!(assembly.open.is_none());
        }
    }

    #[test]
    fn audio_assembler_rejects_empty_odd_or_oversized_chunks() {
        for (bytes, expected) in [
            (0_usize, ClientFrameError::invalid_audio_frame()),
            (1, ClientFrameError::invalid_audio_frame()),
            (
                VIVA_AUDIO_MAX_CHUNK_BYTES + 1,
                ClientFrameError::oversized_audio_chunk(),
            ),
        ] {
            let mut assembly = AudioTurnAssembly::default();
            let frame = pcm_chunk(bytes);
            let error = accept_audio_chunk(
                &mut assembly,
                TEST_GENERATION.to_owned(),
                TEST_TURN.to_owned(),
                0,
                frame.clone(),
            )
            .map_err(ClientFrameError::from)
            .expect_err("invalid chunk sizes fail closed");
            assert_eq!(error, expected);
            assert!(assembly.open.is_none());
            assert_sanitized_audio_error(error, &frame);
        }

        let mut assembly = AudioTurnAssembly::default();
        push_chunk(&mut assembly, 0, VIVA_AUDIO_MAX_CHUNK_BYTES)
            .expect("the exact chunk ceiling is accepted");
        assert_eq!(
            assembly.open.expect("assembly retained").pcm16.len(),
            VIVA_AUDIO_MAX_CHUNK_BYTES
        );
    }

    #[test]
    fn audio_assembler_accepts_exact_45_second_limit_and_rejects_one_more_sample() {
        let full_chunks = VIVA_AUDIO_MAX_TURN_BYTES / VIVA_AUDIO_MAX_CHUNK_BYTES;
        let tail = VIVA_AUDIO_MAX_TURN_BYTES - full_chunks * VIVA_AUDIO_MAX_CHUNK_BYTES;

        let fill_to_limit = || {
            let mut assembly = AudioTurnAssembly::default();
            let mut sequence = 0_u32;
            for _ in 0..full_chunks {
                push_chunk(&mut assembly, sequence, VIVA_AUDIO_MAX_CHUNK_BYTES)
                    .expect("chunk under the turn cap is accepted");
                sequence += 1;
            }
            push_chunk(&mut assembly, sequence, tail).expect("the exact turn ceiling is accepted");
            assert_eq!(
                assembly
                    .open
                    .as_ref()
                    .expect("assembly retained")
                    .pcm16
                    .len(),
                VIVA_AUDIO_MAX_TURN_BYTES
            );
            (assembly, sequence)
        };

        let (mut accepted, final_sequence) = fill_to_limit();
        let action = accept_audio_end(&mut accepted, TEST_GENERATION, TEST_TURN, final_sequence)
            .expect("the exact 45-second turn completes");
        let AudioAssemblyAction::Complete { frame, .. } = action else {
            panic!("expected one complete assembled turn");
        };
        assert_eq!(frame.pcm16_bytes().len(), VIVA_AUDIO_MAX_TURN_BYTES);

        let (mut overflowing, final_sequence) = fill_to_limit();
        let error = push_chunk(&mut overflowing, final_sequence + 1, 2)
            .expect_err("one more sample fails closed");
        assert_eq!(error, ClientFrameError::oversized_audio_turn());
        assert!(overflowing.open.is_none());
    }

    #[test]
    fn audio_end_requires_last_sequence_and_emits_one_complete_frame() {
        let mut mismatched = AudioTurnAssembly::default();
        for sequence in 0..3 {
            push_chunk(&mut mismatched, sequence, 960).expect("chunk accepted");
        }
        let error = accept_audio_end(&mut mismatched, TEST_GENERATION, TEST_TURN, 3)
            .map_err(ClientFrameError::from)
            .expect_err("audio_end must name the last accepted sequence");
        assert_eq!(error, ClientFrameError::invalid_audio_frame());
        assert!(mismatched.open.is_none());

        let mut assembly = AudioTurnAssembly::default();
        for sequence in 0..3 {
            let action = push_chunk(&mut assembly, sequence, 960).expect("chunk accepted");
            assert!(
                matches!(action, AudioAssemblyAction::Pending),
                "no provider turn before explicit end"
            );
        }
        let action = accept_audio_end(&mut assembly, TEST_GENERATION, TEST_TURN, 2)
            .expect("the completed turn is admitted once");
        let AudioAssemblyAction::Complete {
            client_generation_id,
            turn_id,
            final_sequence,
            frame,
        } = action
        else {
            panic!("expected one complete assembled turn");
        };
        assert_eq!(client_generation_id, TEST_GENERATION);
        assert_eq!(turn_id, TEST_TURN);
        assert_eq!(final_sequence, 2);
        assert_eq!(frame.pcm16_bytes().len(), 2_880);
        assert!(
            assembly.open.is_none(),
            "the completed turn is moved out once"
        );

        let mut empty = AudioTurnAssembly::default();
        let error = accept_audio_end(&mut empty, TEST_GENERATION, TEST_TURN, 0)
            .map_err(ClientFrameError::from)
            .expect_err("audio_end without an assembled turn fails closed");
        assert_eq!(error, ClientFrameError::invalid_audio_frame());
    }

    /// Independent-review CRITICAL (cancel-after-submit): a scoped cancel and
    /// an `audio_end` for the same turn race by construction — the browser
    /// decides to cancel while its own `audio_end` is already on the wire.
    /// The late cancel names a turn this connection genuinely owns, so it is
    /// answered as a turn cancel, never as a malformed audio frame that ends
    /// the session with a PROTOCOL close.
    #[test]
    fn cancel_after_audio_end_is_a_turn_cancel_not_a_protocol_error() {
        let mut assembly = AudioTurnAssembly::default();
        for sequence in 0..3 {
            push_chunk(&mut assembly, sequence, 960).expect("chunk accepted");
        }
        let completed = accept_audio_end(&mut assembly, TEST_GENERATION, TEST_TURN, 2)
            .expect("the bounded turn is admitted");
        assert!(matches!(completed, AudioAssemblyAction::Complete { .. }));
        assert!(assembly.open.is_none());

        let late = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
            .expect("a cancel naming the just-submitted turn is not a protocol error");
        assert!(matches!(late, AudioAssemblyAction::CancelSubmittedTurn));
        // Repeating it stays benign.
        let repeated = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
            .expect("a repeated late cancel is still not a protocol error");
        assert!(matches!(repeated, AudioAssemblyAction::CancelSubmittedTurn));
    }

    /// A repeat of a cancel that already discarded its assembly is a benign
    /// no-op: no provider work was ever created, so none may be cancelled.
    #[test]
    fn cancel_after_cancel_is_a_benign_no_op() {
        let mut assembly = AudioTurnAssembly::default();
        push_chunk(&mut assembly, 0, 960).expect("chunk accepted");
        let cancelled = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
            .expect("a matching cancel discards the assembly");
        assert!(matches!(cancelled, AudioAssemblyAction::Cancelled));

        let repeated = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
            .expect("a repeated cancel is not a protocol error");
        assert!(matches!(repeated, AudioAssemblyAction::AlreadyDiscarded));
    }

    /// A scoped cancel naming a turn this connection never saw is still a
    /// protocol error: the settled-turn memory holds exactly one identity and
    /// is not a general amnesty.
    #[test]
    fn cancel_for_an_unknown_turn_is_still_a_protocol_error() {
        let mut assembly = AudioTurnAssembly::default();
        for sequence in 0..3 {
            push_chunk(&mut assembly, sequence, 960).expect("chunk accepted");
        }
        accept_audio_end(&mut assembly, TEST_GENERATION, TEST_TURN, 2).expect("turn admitted");

        let error = accept_audio_cancel(&mut assembly, TEST_GENERATION, "turn-99")
            .map_err(ClientFrameError::from)
            .expect_err("an unknown turn id is a protocol error");
        assert_eq!(error, ClientFrameError::invalid_audio_frame());
        let error = accept_audio_cancel(&mut assembly, "generation-9", TEST_TURN)
            .map_err(ClientFrameError::from)
            .expect_err("an unknown generation is a protocol error");
        assert_eq!(error, ClientFrameError::invalid_audio_frame());
    }

    #[test]
    fn matching_cancel_discards_without_emitting_brain_input() {
        let mut assembly = AudioTurnAssembly::default();
        for sequence in 0..3 {
            push_chunk(&mut assembly, sequence, 960).expect("chunk accepted");
        }
        let action = accept_audio_cancel(&mut assembly, TEST_GENERATION, TEST_TURN)
            .expect("a matching cancel discards the assembly");
        assert!(matches!(action, AudioAssemblyAction::Cancelled));
        assert!(
            assembly.open.is_none(),
            "no phantom provider turn is created"
        );

        let mut other = AudioTurnAssembly::default();
        accept_audio_chunk(
            &mut other,
            TEST_GENERATION.to_owned(),
            "turn-02".to_owned(),
            0,
            pcm_chunk(960),
        )
        .expect("chunk accepted");
        let error = accept_audio_cancel(&mut other, TEST_GENERATION, TEST_TURN)
            .map_err(ClientFrameError::from)
            .expect_err("a mismatched cancel is a protocol error");
        assert_eq!(error, ClientFrameError::invalid_audio_frame());
        assert!(other.open.is_none());

        let mut empty = AudioTurnAssembly::default();
        let error = accept_audio_cancel(&mut empty, TEST_GENERATION, TEST_TURN)
            .map_err(ClientFrameError::from)
            .expect_err("a scoped cancel without an assembly is a protocol error");
        assert_eq!(error, ClientFrameError::invalid_audio_frame());
    }
}

/// `SERVICE-007`: Plan 05's `audio-turn-lifecycle.json` validates only its own
/// schema, case-id set, and per-frame parses. Executing the stateful outcome of
/// every case against Plan 03's real `ws.rs` assembler is exclusively this
/// plan's obligation, and the fixture is read-only here.
mod audio_turn_lifecycle {
    use super::*;

    const AUDIO_TURN_LIFECYCLE_JSON: &str =
        include_str!("../../../../fixtures/voice-protocol/v5/audio-turn-lifecycle.json");

    #[derive(Deserialize)]
    struct LifecycleFile {
        schema: String,
        protocol_version: u32,
        cases: Vec<LifecycleCase>,
    }

    #[derive(Deserialize)]
    struct LifecycleCase {
        id: String,
        wire_sequence_json: Vec<String>,
        valid: bool,
        diagnostic_code: Option<String>,
        path: Option<String>,
    }

    /// The outcome of replaying one fixture case through the real assembler.
    struct LifecycleOutcome {
        completed: Option<AcceptedAudioTurn>,
        rejection: Option<VoiceProtocolDiagnostic>,
        /// Which layer refused, so Plan 05's per-frame parse can be told apart
        /// from the stateful assembler outcome this plan owns.
        rejected_by: Option<RejectionSource>,
        assembly_retained: bool,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum RejectionSource {
        Parser,
        Assembler,
    }

    /// Replays one fixture case exactly as the socket does: every wire entry goes
    /// through Plan 05's strict parser first, and only a parsed `audio_chunk` /
    /// `audio_end` reaches the connection-local assembler.
    fn replay(case: &LifecycleCase) -> LifecycleOutcome {
        let mut assembly = AudioTurnAssembly::default();
        let mut completed = None;
        let mut rejection = None;
        let mut rejected_by = None;

        for wire_json in &case.wire_sequence_json {
            if rejection.is_some() {
                continue;
            }
            let frame = match parse_client_frame_json(wire_json) {
                Ok(frame) => frame,
                Err(diagnostic) => {
                    rejection = Some(diagnostic);
                    rejected_by = Some(RejectionSource::Parser);
                    continue;
                }
            };
            let outcome = match frame {
                ClientFrame::AudioChunk {
                    client_generation_id,
                    turn_id,
                    sequence,
                    frame,
                    ..
                } => accept_audio_chunk(
                    &mut assembly,
                    client_generation_id,
                    turn_id,
                    sequence,
                    frame,
                ),
                ClientFrame::AudioEnd {
                    client_generation_id,
                    turn_id,
                    final_sequence,
                    ..
                } => accept_audio_end(
                    &mut assembly,
                    &client_generation_id,
                    &turn_id,
                    final_sequence,
                ),
                other => panic!("{} carries a non-audio frame: {other:?}", case.id),
            };
            match outcome {
                Ok(AudioAssemblyAction::Pending) => {}
                Ok(AudioAssemblyAction::Complete {
                    client_generation_id,
                    turn_id,
                    final_sequence,
                    ..
                }) => {
                    completed = Some(AcceptedAudioTurn {
                        client_generation_id,
                        turn_id,
                        final_sequence,
                    });
                }
                Ok(AudioAssemblyAction::Cancelled)
                | Ok(AudioAssemblyAction::CancelSubmittedTurn)
                | Ok(AudioAssemblyAction::AlreadyDiscarded) => {
                    panic!("{} produced a cancellation", case.id)
                }
                Err(reject) => {
                    rejection = Some(reject);
                    rejected_by = Some(RejectionSource::Assembler);
                }
            }
        }

        LifecycleOutcome {
            completed,
            rejection,
            rejected_by,
            assembly_retained: assembly.open.is_some(),
        }
    }

    #[test]
    fn audio_turn_lifecycle_fixture_cases_execute_against_the_assembler() {
        let file: LifecycleFile = serde_json::from_str(AUDIO_TURN_LIFECYCLE_JSON)
            .expect("audio lifecycle fixture parses");
        assert_eq!(file.schema, "viva.voice-audio-sequence-cases.v1");
        assert_eq!(file.protocol_version, VIVA_VOICE_PROTOCOL_VERSION);
        assert_eq!(file.cases.len(), 8, "every published case must be executed");

        for case in &file.cases {
            let outcome = replay(case);
            if case.valid {
                assert!(
                    outcome.rejection.is_none(),
                    "{} must assemble without a diagnostic",
                    case.id
                );
                let accepted = outcome
                    .completed
                    .as_ref()
                    .unwrap_or_else(|| panic!("{} must complete one turn", case.id));
                assert_eq!(accepted.turn_id, "turn-fixture-audio", "{}", case.id);
                assert_eq!(
                    accepted.client_generation_id, "generation-fixture-audio",
                    "{}",
                    case.id
                );
                let expected_final = case.wire_sequence_json.len() as u32 - 2;
                assert_eq!(accepted.final_sequence, expected_final, "{}", case.id);
                assert!(
                    !outcome.assembly_retained,
                    "{} must leave no retained assembly",
                    case.id
                );
                continue;
            }

            let diagnostic = outcome
                .rejection
                .as_ref()
                .unwrap_or_else(|| panic!("{} must be rejected", case.id));
            assert_eq!(
                Some(diagnostic.code.as_str().to_owned()),
                case.diagnostic_code,
                "{} diagnostic code",
                case.id
            );
            assert_eq!(
                Some(diagnostic.path.clone()),
                case.path,
                "{} diagnostic path",
                case.id
            );
            assert!(
                outcome.completed.is_none(),
                "{} must never produce a provider turn",
                case.id
            );
            assert!(
                !outcome.assembly_retained,
                "{} must clear the assembly on rejection",
                case.id
            );
            // A `VOICE_PROTOCOL_FRAME_TOO_LARGE` case is Plan 05's per-frame
            // refusal; every other published rejection is a stateful outcome only
            // this plan's assembler can decide.
            let expected_source =
                if case.diagnostic_code.as_deref() == Some("VOICE_PROTOCOL_FRAME_TOO_LARGE") {
                    RejectionSource::Parser
                } else {
                    RejectionSource::Assembler
                };
            assert_eq!(
                outcome.rejected_by,
                Some(expected_source),
                "{} was refused by the wrong layer",
                case.id
            );
        }
    }

    /// The three stateful rejections this plan owns are exactly the codes the
    /// fixture publishes; the per-frame ceiling stays Plan 05's parser diagnostic.
    #[test]
    fn audio_turn_lifecycle_rejections_carry_no_payload_material() {
        for rejection in [
            AudioAssemblyRejection::InvalidIdentity,
            AudioAssemblyRejection::InvalidPayload,
            AudioAssemblyRejection::ChunkTooLarge,
            AudioAssemblyRejection::TurnTooLarge,
            AudioAssemblyRejection::Sequence,
            AudioAssemblyRejection::FinalSequence,
        ] {
            let diagnostic = rejection.diagnostic();
            let rendered = format!("{diagnostic:?} {diagnostic}");
            assert!(!rendered.contains("AAA"), "{rejection:?} leaked a payload");
            assert!(diagnostic.path.starts_with('$'), "{rejection:?}");
            let error = ClientFrameError::from(rejection.diagnostic());
            assert!(!error.message.contains("pcm16_base64"));
        }

        assert_eq!(
            AudioAssemblyRejection::Sequence.diagnostic(),
            VoiceProtocolDiagnostic::new(VoiceProtocolDiagnosticCode::AudioSequence, "$.sequence")
        );
        assert_eq!(
            AudioAssemblyRejection::FinalSequence.diagnostic(),
            VoiceProtocolDiagnostic::new(
                VoiceProtocolDiagnosticCode::AudioSequence,
                "$.final_sequence"
            )
        );
        assert_eq!(
            AudioAssemblyRejection::TurnTooLarge.diagnostic(),
            VoiceProtocolDiagnostic::new(
                VoiceProtocolDiagnosticCode::TurnTooLarge,
                "$.frame.pcm16_base64"
            )
        );
    }
}

fn client_ip_test_peer(address: &str) -> SocketAddr {
    SocketAddr::new(address.parse().expect("test peer address"), 44_321)
}

fn client_ip_test_headers(forwarded_for: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(forwarded_for) = forwarded_for {
        headers.insert(
            "x-forwarded-for",
            axum::http::HeaderValue::from_str(forwarded_for).expect("header value"),
        );
    }
    headers
}

fn client_ip_trusted_proxies() -> crate::config::TrustedProxyConfig {
    crate::config::TrustedProxyConfig::parse("10.0.0.0/8,2001:db8::/32")
        .expect("test CIDR list parses")
}

/// `SERVICE-003`: the client address is derived from the socket peer and, only
/// behind a configured trusted proxy, from the rightmost untrusted forwarded
/// hop. There is no `unknown` bucket and no left-most-header trust.
#[test]
fn client_ip_key_derives_from_peer_and_trusted_hops() {
    let trusted = client_ip_trusted_proxies();
    let untrusted_peer = client_ip_test_peer("198.51.100.7");
    let trusted_peer = client_ip_test_peer("10.1.2.3");
    let long_chain = |hops: usize| {
        (0..hops)
            .map(|index| format!("198.51.100.{}", index % 200 + 1))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let accepted: Vec<(&str, SocketAddr, Option<String>, &str)> = vec![
        (
            "direct attacker spoofing a forwarding header",
            untrusted_peer,
            Some("203.0.113.9".to_owned()),
            "198.51.100.7",
        ),
        (
            "untrusted peer supplying a valid-looking chain",
            untrusted_peer,
            Some("203.0.113.9, 10.0.0.4, 10.0.0.5".to_owned()),
            "198.51.100.7",
        ),
        (
            "untrusted peer with no forwarding header",
            untrusted_peer,
            None,
            "198.51.100.7",
        ),
        (
            "trusted proxy with client, trusted, trusted",
            trusted_peer,
            Some("203.0.113.9, 10.0.0.4, 10.0.0.5".to_owned()),
            "203.0.113.9",
        ),
        (
            "trusted proxy with a rightmost-untrusted mixed chain",
            trusted_peer,
            Some("203.0.113.9, 198.51.100.4, 10.0.0.5".to_owned()),
            "198.51.100.4",
        ),
        (
            "trusted proxy with a single untrusted hop",
            trusted_peer,
            Some("2001:db9::1".to_owned()),
            "2001:db9::1",
        ),
        (
            "trusted proxy with exactly 32 hops",
            trusted_peer,
            Some(long_chain(32)),
            "198.51.100.32",
        ),
    ];

    for (name, peer, forwarded_for, expected) in accepted {
        let headers = client_ip_test_headers(forwarded_for.as_deref());
        assert_eq!(
            client_ip_key(peer, &headers, &trusted),
            Ok(expected.parse::<IpAddr>().expect("expected address")),
            "{name}"
        );
    }

    let rejected: Vec<(&str, SocketAddr, Option<String>, ClientIpError)> = vec![
        (
            "trusted proxy with no forwarding header",
            trusted_peer,
            None,
            ClientIpError::MissingForwardedChain,
        ),
        (
            "trusted proxy with a malformed IPv4 hop",
            trusted_peer,
            Some("203.0.113.999".to_owned()),
            ClientIpError::MalformedForwardedChain,
        ),
        (
            "trusted proxy with a malformed IPv6 hop",
            trusted_peer,
            Some("2001:db9::zz".to_owned()),
            ClientIpError::MalformedForwardedChain,
        ),
        (
            "trusted proxy with an empty element",
            trusted_peer,
            Some("203.0.113.9, , 10.0.0.5".to_owned()),
            ClientIpError::MalformedForwardedChain,
        ),
        (
            "trusted proxy with an empty chain",
            trusted_peer,
            Some(String::new()),
            ClientIpError::MalformedForwardedChain,
        ),
        (
            "trusted proxy with an address:port hop",
            trusted_peer,
            Some("203.0.113.9:443".to_owned()),
            ClientIpError::MalformedForwardedChain,
        ),
        (
            "trusted proxy with an all-trusted chain",
            trusted_peer,
            Some("10.0.0.3, 10.0.0.4, 2001:db8::9".to_owned()),
            ClientIpError::AllForwardedHopsTrusted,
        ),
        (
            "trusted proxy with 33 hops",
            trusted_peer,
            Some(long_chain(33)),
            ClientIpError::TooManyForwardedHops,
        ),
    ];

    for (name, peer, forwarded_for, expected) in rejected {
        let headers = client_ip_test_headers(forwarded_for.as_deref());
        assert_eq!(
            client_ip_key(peer, &headers, &trusted),
            Err(expected),
            "{name}"
        );
    }
}

/// With no configured trusted proxy the forwarding header is ignored outright.
#[test]
fn client_ip_key_ignores_forwarding_headers_without_trusted_proxies() {
    let trusted = crate::config::TrustedProxyConfig::default();
    let peer = client_ip_test_peer("10.1.2.3");
    let headers = client_ip_test_headers(Some("203.0.113.9, 10.0.0.4"));

    assert_eq!(
        client_ip_key(peer, &headers, &trusted),
        Ok("10.1.2.3".parse::<IpAddr>().expect("peer address"))
    );
}

/// `X-Real-IP` is never consulted, in either peer position.
#[test]
fn client_ip_key_never_consults_x_real_ip() {
    let trusted = client_ip_trusted_proxies();
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-real-ip",
        axum::http::HeaderValue::from_static("203.0.113.9"),
    );

    assert_eq!(
        client_ip_key(client_ip_test_peer("198.51.100.7"), &headers, &trusted),
        Ok("198.51.100.7".parse::<IpAddr>().expect("peer address"))
    );
    assert_eq!(
        client_ip_key(client_ip_test_peer("10.1.2.3"), &headers, &trusted),
        Err(ClientIpError::MissingForwardedChain)
    );
}

// ---------------------------------------------------------------------
// Task 9 (SERVICE-002, SERVICE-008): one deadline on every outbound write.
// ---------------------------------------------------------------------

/// A sink that never becomes ready, flushes, or closes. It is the whole
/// slow-reader model: no TCP buffer, no timing, nothing the test has to guess
/// about. `blocking_after` lets a session make real progress first.
struct PendingSink {
    accepted: usize,
    block_after: usize,
}

impl PendingSink {
    fn new() -> Self {
        Self {
            accepted: 0,
            block_after: 0,
        }
    }

    fn blocking_after(block_after: usize) -> Self {
        Self {
            accepted: 0,
            block_after,
        }
    }

    fn blocked(&self) -> bool {
        self.accepted >= self.block_after
    }
}

impl futures_util::Sink<Message> for PendingSink {
    type Error = axum::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        if self.blocked() {
            return Poll::Pending;
        }
        Poll::Ready(Ok(()))
    }

    fn start_send(mut self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
        self.accepted = self.accepted.saturating_add(1);
        Ok(())
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        if self.blocked() {
            return Poll::Pending;
        }
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Pending
    }
}

/// The plan's boundary is "one nanosecond before the deadline"; Tokio's paused
/// clock is a millisecond timer wheel, so a one-nanosecond gap is not a
/// representable instant — both timers would land on the same tick and the
/// assertion would decide nothing. The boundary is therefore taken at the
/// runtime's own smallest observable step.
const TIMER_TICK: Duration = Duration::from_millis(1);

#[tokio::test(start_paused = true)]
async fn bounded_sender_times_out_one_tick_after_its_deadline() {
    let start = Instant::now();
    // A second timer armed across the same stalled write. It must fire on its
    // own schedule, which is what proves the bounded write parks on a real
    // timer rather than blocking the runtime.
    let concurrent = tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        Instant::now()
    });
    let mut sender = BoundedSender::new(PendingSink::new(), Duration::from_secs(5));
    let write = sender.send(Message::Text("frame".into()));
    tokio::pin!(write);

    let before_deadline = tokio::select! {
        biased;
        result = &mut write => Some(result),
        () = tokio::time::sleep(Duration::from_secs(5) - TIMER_TICK) => None,
    };
    assert!(
        before_deadline.is_none(),
        "the write must still be pending one tick before its deadline"
    );
    assert_eq!(
        Instant::now().duration_since(start),
        Duration::from_secs(5) - TIMER_TICK
    );

    let result = (&mut write).await;
    assert!(
        matches!(result, Err(OutboundWriteError::Timeout)),
        "{result:?}"
    );
    assert_eq!(Instant::now().duration_since(start), Duration::from_secs(5));
    assert_eq!(
        concurrent.await.expect("concurrent timer task"),
        start + Duration::from_secs(1),
        "a concurrently armed one-second timer must fire on schedule"
    );
}

#[tokio::test(start_paused = true)]
async fn bounded_sender_separates_a_failed_sink_from_a_missed_deadline() {
    let mut failing = BoundedSender::new(FailingSink, Duration::from_secs(5));
    let failed = failing.send(Message::Text("frame".into())).await;
    assert!(
        matches!(failed, Err(OutboundWriteError::Sink(_))),
        "{failed:?}"
    );
    assert_eq!(
        outbound_write_terminal_label(&failed.expect_err("sink failure")),
        "send_failed"
    );

    let mut stalled = BoundedSender::new(PendingSink::new(), Duration::from_secs(5));
    let timed_out = stalled.send(Message::Text("frame".into())).await;
    assert!(matches!(timed_out, Err(OutboundWriteError::Timeout)));
    assert_eq!(
        outbound_write_terminal_label(&timed_out.expect_err("write timeout")),
        TerminalSessionReason::SlowClient.as_str()
    );
}

#[tokio::test(start_paused = true)]
async fn bounded_sender_completes_a_ready_write_without_consuming_its_deadline() {
    let start = Instant::now();
    let mut sender = BoundedSender::new(RecordingSink::new(), Duration::from_secs(5));

    sender
        .send(Message::Text("frame".into()))
        .await
        .expect("a ready sink completes inside its deadline");

    assert_eq!(Instant::now(), start);
    assert_eq!(sender.inner.sent.len(), 1);
}

#[test]
fn serialization_fallback_uses_plan_05s_exact_published_bytes() {
    let frame = ServerFrame::error(
        VoiceServerErrorCode::ClientFrameMalformed,
        "a frame that cannot be serialized",
    );

    let rendered = serialize_server_frame_with(&frame, |_| Err::<String, ()>(()));

    assert_eq!(rendered, VOICE_SERIALIZATION_FALLBACK_FRAME);
    let value: serde_json::Value =
        serde_json::from_str(&rendered).expect("the fallback frame is valid JSON");
    assert_eq!(value["type"], "error");
    assert_eq!(value["version"], VIVA_VOICE_PROTOCOL_VERSION);
    assert_eq!(VIVA_VOICE_PROTOCOL_VERSION, 5);
    // Named through Plan 05's own enum rather than restated as a literal:
    // `protocol_v5_fixture_shadow_types_are_absent` proves no service-local
    // wire error JSON survives in this file.
    assert_eq!(
        value["error"]["code"],
        VoiceServerErrorCode::InternalSerialization.as_str()
    );
    assert_eq!(value["error"]["retryable"], true);
    assert_eq!(
        value
            .as_object()
            .expect("envelope object")
            .keys()
            .cloned()
            .collect::<HashSet<_>>(),
        ["type", "version", "error"]
            .into_iter()
            .map(ToOwned::to_owned)
            .collect::<HashSet<_>>(),
        "the fallback carries no application payload"
    );
    assert_eq!(
        value["error"]
            .as_object()
            .expect("error object")
            .keys()
            .cloned()
            .collect::<HashSet<_>>(),
        ["code", "message", "retryable"]
            .into_iter()
            .map(ToOwned::to_owned)
            .collect::<HashSet<_>>()
    );
}

#[test]
fn serialization_fallback_is_not_used_when_the_frame_serializes() {
    let frame = ServerFrame::error(VoiceServerErrorCode::ClientFrameMalformed, "malformed");

    let rendered = serialize_server_frame_with(&frame, serde_json::to_string);

    assert_ne!(rendered, VOICE_SERIALIZATION_FALLBACK_FRAME);
    assert_eq!(rendered, serde_json::to_string(&frame).unwrap());
}

/// A provider that answers one question and then keeps a task alive forever.
/// The task is handed back so the test can prove the socket aborted it.
struct SlowClientProbeBrain {
    study_store: Arc<dyn agent_domain::StudyMemoryStore>,
    #[allow(clippy::type_complexity)]
    task: Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

#[async_trait::async_trait]
impl agent_domain::RealtimeBrain for SlowClientProbeBrain {
    fn capabilities(&self) -> agent_domain::RealtimeBrainCapabilities {
        agent_domain::RealtimeBrainCapabilities {
            provider: "slow_client_probe".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        let _recorded = self
            .study_store
            .record_voice_session(&config)
            .await
            .map_err(|_| {
                BrainError::from_failure(BrainProviderFailure::new(BrainProviderFailureParts {
                    failure_class: BrainFailureClass::DurabilityDegraded,
                    stage: BrainFailureStage::Store,
                    retry_eligible: false,
                    latency_ms: 0,
                    provider: "slow_client_probe".to_owned(),
                    model: String::new(),
                    metadata: "error_kind=store_write_failed".to_owned(),
                }))
            })?;
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(8);
        let (event_tx, events) = mpsc::channel(8);
        let handle = tokio::spawn(async move {
            let _ = event_tx
                .send(BrainEvent::SessionPhase {
                    phase: StudySessionPhase::Ready,
                })
                .await;
            let _ = event_tx
                .send(BrainEvent::QuestionStarted {
                    response_id: "response-1".to_owned(),
                    question: fixture_question(),
                })
                .await;
            while let Some(input) = input_rx.recv().await {
                if !matches!(
                    input,
                    BrainInput::Text(_) | BrainInput::TextWithMetadata { .. }
                ) {
                    continue;
                }
                let _ = event_tx
                    .send(BrainEvent::SessionPhase {
                        phase: StudySessionPhase::Thinking,
                    })
                    .await;
            }
            // The provider stays alive until the socket aborts it.
            loop {
                tokio::time::sleep(Duration::from_secs(3_600)).await;
            }
        });
        let abort = handle.abort_handle();
        *self.task.lock().expect("probe task lock poisoned") = Some(handle);
        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![abort])),
        })
    }
}

/// `SERVICE-002`: a client that stops reading costs the server exactly one
/// outbound-write deadline. The session records the sanitized `slow_client`
/// label, aborts the provider task, and releases every server-owned permit.
#[tokio::test(start_paused = true)]
async fn bounded_sender_slow_client_aborts_the_provider_and_releases_every_lease() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let probe_task = Arc::new(std::sync::Mutex::new(None));
    let state = AppState::with_study_store(
        Arc::new(SlowClientProbeBrain {
            study_store: store.clone(),
            task: probe_task.clone(),
        }),
        "slow_client_probe",
        crate::config::VoiceWsAccess::default(),
        2,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(2),
        max_user_sessions: Some(2),
        provider_limiter_enabled: true,
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(1),
        ..VoiceLimitConfig::default()
    })
    .with_ws_timeouts(crate::app::WsTimeouts {
        first_frame: Duration::from_secs(60),
        idle: Duration::from_secs(600),
        between_turn_idle: Duration::from_secs(600),
        session: Duration::from_secs(6 * 60 * 60),
        outbound_write: Duration::from_secs(5),
        ..crate::app::WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let limit_state = state.limit_state.clone();
    let session_slots = state.session_slots.clone();

    let permit = session_slots
        .clone()
        .acquire_owned()
        .await
        .expect("session slot");
    let ip_lease = limit_state
        .try_acquire_ip("198.51.100.7", 2)
        .expect("ip lease");
    assert_eq!(limit_state.ip_lease_count("198.51.100.7"), Some(1));
    assert_eq!(session_slots.available_permits(), 1);
    let admission = VoiceAdmission {
        _permit: permit,
        _ip_lease: Some(ip_lease),
        // `SERVICE-012`: the handler guard the real upgrade acquires, so the
        // deterministic cleanup path drops exactly what production drops.
        _handler_guard: state.runtime_tracker.enter().expect("handler guard"),
        principal: crate::config::UpgradePrincipal::ServiceBearer,
    };

    // The client sends its bootstrap frame and one answer, then reads and
    // writes nothing ever again.
    let client_frames = futures_util::stream::iter(vec![
        Ok(Message::Text(slow_client_session_config_json().into())),
        Ok(Message::Text(slow_client_answer_json().into())),
    ])
    .chain(futures_util::stream::pending());

    let start = Instant::now();
    // Ready, session_phase, question_started go out; the provider event that
    // follows the admitted answer is the write that stalls.
    run_voice_session(
        BoundedSender::new(PendingSink::blocking_after(3), Duration::from_secs(5)),
        client_frames,
        state,
        admission,
        "http://localhost:3000".to_owned(),
    )
    .await;

    assert_eq!(
        Instant::now().duration_since(start),
        Duration::from_secs(5),
        "the stalled write costs exactly one outbound-write deadline"
    );
    let recorded = evidence.snapshot();
    assert!(
        recorded.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::TerminalReason
                && event.detail == TerminalSessionReason::SlowClient.as_str()
        }),
        "{recorded:?}"
    );
    assert_eq!(limit_state.ip_lease_count("198.51.100.7"), None);
    assert_eq!(session_slots.available_permits(), 2);
    let provider = tokio::time::timeout(
        Duration::from_millis(50),
        limit_state.try_admit_provider_turn(
            &VoiceLimitConfig {
                provider_limiter_enabled: true,
                max_provider_concurrent_turns: Some(1),
                max_provider_queue_depth: Some(1),
                ..VoiceLimitConfig::default()
            },
            ProviderQueueBehavior::Wait,
        ),
    )
    .await
    .expect("the provider slot must be free");
    assert!(
        matches!(provider.decision, ProviderAdmissionDecision::Admitted),
        "the provider slot must be free: {:?}",
        provider.decision
    );
    let task = probe_task
        .lock()
        .expect("probe task lock poisoned")
        .take()
        .expect("probe task handle");
    let outcome = tokio::time::timeout(Duration::from_millis(50), task)
        .await
        .expect("the provider task must be aborted rather than left running")
        .expect_err("an aborted task reports cancellation");
    assert!(outcome.is_cancelled());
}

fn slow_client_session_config_json() -> String {
    let session = include_str!("../../../../fixtures/voice-protocol/session-config.json");
    format!(
        r#"{{"type":"session_config","version":{VIVA_VOICE_PROTOCOL_VERSION},"client_generation_id":"slow-client-1","session_token":"placeholder-session-material","session":{session}}}"#
    )
}

fn slow_client_answer_json() -> String {
    slow_client_answer_json_for("turn-1")
}

fn slow_client_answer_json_for(turn_id: &str) -> String {
    json!({
        "type": "turn_intent",
        "version": VIVA_VOICE_PROTOCOL_VERSION,
        "client_generation_id": "slow-client-1",
        "turn_id": turn_id,
        "intent": { "kind": "answer_text", "text": "an answer the client never reads back" },
    })
    .to_string()
}

/// Counts every item the session actually pulls out of its peer.
struct CountingStream<S> {
    inner: S,
    yielded: Arc<std::sync::atomic::AtomicUsize>,
}

impl<S> futures_util::Stream for CountingStream<S>
where
    S: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    type Item = Result<Message, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let polled = Pin::new(&mut self.inner).poll_next(cx);
        if matches!(polled, Poll::Ready(Some(_))) {
            self.yielded
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        polled
    }
}

/// `A-20.2`: a `slow_client` terminal REASON is not a failed write SIDE, so
/// the socket still owes its peer a closing handshake.
///
/// The overlapping-provider-turn policy denial closes with
/// `TerminalSessionReason::SlowClient` while every write succeeds. Reading
/// that sanitized label as write-side evidence skipped the handshake, so the
/// socket was dropped on top of the client's pipelined bytes and the reset
/// discarded the terminal frame and the Close frame already written to it.
/// This is the deterministic half of that property: after the denial the
/// session must read its peer out, and doing so may cost no more than the
/// server-owned grace.
#[tokio::test(start_paused = true)]
async fn closing_handshake_drains_the_peer_after_a_denied_overlapping_turn() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let probe_task = Arc::new(std::sync::Mutex::new(None));
    let state = AppState::with_study_store(
        Arc::new(SlowClientProbeBrain {
            study_store: store.clone(),
            task: probe_task.clone(),
        }),
        "slow_client_probe",
        crate::config::VoiceWsAccess::default(),
        2,
        store,
    )
    .with_voice_limits(VoiceLimitConfig {
        max_ip_sessions: Some(2),
        max_user_sessions: Some(2),
        provider_limiter_enabled: true,
        max_provider_concurrent_turns: Some(1),
        max_provider_queue_depth: Some(1),
        ..VoiceLimitConfig::default()
    })
    .with_ws_timeouts(crate::app::WsTimeouts {
        first_frame: Duration::from_secs(60),
        idle: Duration::from_secs(600),
        between_turn_idle: Duration::from_secs(600),
        session: Duration::from_secs(6 * 60 * 60),
        outbound_write: Duration::from_secs(5),
        ..crate::app::WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let limit_state = state.limit_state.clone();
    let session_slots = state.session_slots.clone();
    let permit = session_slots
        .clone()
        .acquire_owned()
        .await
        .expect("session slot");
    let ip_lease = limit_state
        .try_acquire_ip("198.51.100.9", 2)
        .expect("ip lease");
    let admission = VoiceAdmission {
        _permit: permit,
        _ip_lease: Some(ip_lease),
        // `SERVICE-012`: the handler guard the real upgrade acquires, so the
        // deterministic cleanup path drops exactly what production drops.
        _handler_guard: state.runtime_tracker.enter().expect("handler guard"),
        principal: crate::config::UpgradePrincipal::ServiceBearer,
    };

    // Bootstrap, one answer the provider never resolves, the overlapping
    // answer the server refuses, and three frames pipelined behind it.
    const PIPELINED_FRAMES: usize = 5;
    let yielded = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let client_frames = CountingStream {
        inner: futures_util::stream::iter(vec![
            Ok(Message::Text(slow_client_session_config_json().into())),
            Ok(Message::Text(slow_client_answer_json_for("turn-1").into())),
            Ok(Message::Text(slow_client_answer_json_for("turn-2").into())),
            Ok(Message::Text(slow_client_answer_json_for("turn-3").into())),
            Ok(Message::Text(slow_client_answer_json_for("turn-4").into())),
        ])
        .chain(futures_util::stream::pending()),
        yielded: yielded.clone(),
    };

    let start = Instant::now();
    run_voice_session(
        BoundedSender::new(RecordingSink::new(), Duration::from_secs(5)),
        client_frames,
        state,
        admission,
        "http://localhost:3000".to_owned(),
    )
    .await;

    let recorded = evidence.snapshot();
    assert!(
        recorded.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::ProviderAdmission
                && event.detail.contains("reason=overlapping_provider_turn")
                && event.detail.contains("terminal_reason=slow_client")
        }),
        "the denial under test must be the overlapping-turn policy denial: {recorded:?}"
    );
    assert!(
        recorded.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::TerminalReason
                && event.detail == TerminalSessionReason::SlowClient.as_str()
        }),
        "{recorded:?}"
    );
    assert_eq!(
        yielded.load(std::sync::atomic::Ordering::SeqCst),
        PIPELINED_FRAMES,
        "every pipelined frame must be read out of the peer before the socket is dropped"
    );
    assert_eq!(
        Instant::now().duration_since(start),
        CLOSING_HANDSHAKE_GRACE,
        "reading the peer out costs exactly the server-owned closing grace"
    );
    // The wait holds nothing: every lease is released before it starts.
    assert_eq!(limit_state.ip_lease_count("198.51.100.9"), None);
    assert_eq!(session_slots.available_permits(), 2);
}

// ---------------------------------------------------------------------
// Task 10 (SERVICE-001): heartbeat expiry that keepalives cannot extend.
// ---------------------------------------------------------------------

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(10);

#[tokio::test(start_paused = true)]
async fn heartbeat_pings_at_the_configured_interval_and_expires_without_a_pong() {
    let start = Instant::now();
    let mut heartbeat = HeartbeatState::new(start, HEARTBEAT_INTERVAL);
    assert_eq!(heartbeat.next_wake(), start + HEARTBEAT_INTERVAL);

    // Nothing is due before the interval elapses.
    assert_eq!(
        heartbeat.on_timer(
            start + Duration::from_secs(29),
            HEARTBEAT_INTERVAL,
            PONG_TIMEOUT
        ),
        HeartbeatAction::SleepUntil(start + HEARTBEAT_INTERVAL)
    );

    let at_thirty = start + HEARTBEAT_INTERVAL;
    assert_eq!(
        heartbeat.on_timer(at_thirty, HEARTBEAT_INTERVAL, PONG_TIMEOUT),
        HeartbeatAction::SendPing
    );
    assert_eq!(heartbeat.next_wake(), at_thirty + PONG_TIMEOUT);

    // Still inside the pong window at 39 seconds.
    assert_eq!(
        heartbeat.on_timer(
            start + Duration::from_secs(39),
            HEARTBEAT_INTERVAL,
            PONG_TIMEOUT
        ),
        HeartbeatAction::SleepUntil(at_thirty + PONG_TIMEOUT)
    );

    assert_eq!(
        heartbeat.on_timer(
            start + Duration::from_secs(40),
            HEARTBEAT_INTERVAL,
            PONG_TIMEOUT
        ),
        HeartbeatAction::Expired
    );
}

#[tokio::test(start_paused = true)]
async fn heartbeat_pong_before_the_deadline_schedules_the_next_ping() {
    let start = Instant::now();
    let mut heartbeat = HeartbeatState::new(start, HEARTBEAT_INTERVAL);
    assert_eq!(
        heartbeat.on_timer(start + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL, PONG_TIMEOUT),
        HeartbeatAction::SendPing
    );

    let at_thirty_nine = start + Duration::from_secs(39);
    assert!(heartbeat.on_pong(at_thirty_nine, HEARTBEAT_INTERVAL));
    assert_eq!(heartbeat.next_wake(), at_thirty_nine + HEARTBEAT_INTERVAL);

    // The next ping is due at 69 seconds, not at 60.
    assert_eq!(
        heartbeat.on_timer(
            start + Duration::from_secs(60),
            HEARTBEAT_INTERVAL,
            PONG_TIMEOUT
        ),
        HeartbeatAction::SleepUntil(start + Duration::from_secs(69))
    );
    assert_eq!(
        heartbeat.on_timer(
            start + Duration::from_secs(69),
            HEARTBEAT_INTERVAL,
            PONG_TIMEOUT
        ),
        HeartbeatAction::SendPing
    );
    assert_eq!(
        heartbeat.on_timer(
            start + Duration::from_secs(79),
            HEARTBEAT_INTERVAL,
            PONG_TIMEOUT
        ),
        HeartbeatAction::Expired
    );
}

#[tokio::test(start_paused = true)]
async fn heartbeat_ignores_an_unsolicited_pong() {
    let start = Instant::now();
    let mut heartbeat = HeartbeatState::new(start, HEARTBEAT_INTERVAL);

    // No ping is outstanding, so this pong clears nothing and moves nothing.
    assert!(!heartbeat.on_pong(start + Duration::from_secs(5), HEARTBEAT_INTERVAL));
    assert_eq!(heartbeat.next_wake(), start + HEARTBEAT_INTERVAL);
    assert_eq!(
        heartbeat.on_timer(start + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL, PONG_TIMEOUT),
        HeartbeatAction::SendPing
    );

    // A second pong while one is outstanding clears it; a third does not
    // re-open the window.
    assert!(heartbeat.on_pong(start + Duration::from_secs(31), HEARTBEAT_INTERVAL));
    assert!(!heartbeat.on_pong(start + Duration::from_secs(32), HEARTBEAT_INTERVAL));
    assert_eq!(
        heartbeat.next_wake(),
        start + Duration::from_secs(31) + HEARTBEAT_INTERVAL
    );
}

/// `SERVICE-001`: keepalives keep the transport alive and change nothing else.
/// Twenty ping/pong exchanges span the whole 600-second between-turn deadline
/// without moving it by a nanosecond.
#[tokio::test(start_paused = true)]
async fn heartbeat_never_moves_the_between_turn_or_session_deadline() {
    let start = Instant::now();
    let between_turn_idle = Duration::from_secs(600);
    let sleeper = tokio::time::sleep(between_turn_idle);
    tokio::pin!(sleeper);
    let armed_deadline = sleeper.deadline();
    assert_eq!(armed_deadline, start + between_turn_idle);

    let mut heartbeat = HeartbeatState::new(start, HEARTBEAT_INTERVAL);
    let mut now = start;
    let mut pings = 0_u32;
    while now < start + between_turn_idle {
        now += Duration::from_secs(30);
        match heartbeat.on_timer(now, HEARTBEAT_INTERVAL, PONG_TIMEOUT) {
            HeartbeatAction::SendPing => {
                pings += 1;
                assert!(heartbeat.on_pong(now, HEARTBEAT_INTERVAL));
            }
            other => panic!("expected a ping at {now:?}, got {other:?}"),
        }
        // Neither the ping nor the pong may re-arm the between-turn deadline:
        // there is still no outstanding turn work, and `rearm_between_turn_idle`
        // is never reached from a keepalive.
        assert_eq!(sleeper.deadline(), armed_deadline);
    }

    assert_eq!(pings, 20);
    assert_eq!(sleeper.deadline(), armed_deadline);
}

/// A sink that survives `run_voice_session` taking its sender by value, so a
/// terminated session's wire frames can still be read back afterwards.
#[derive(Clone)]
struct SharedRecordingSink {
    sent: Arc<std::sync::Mutex<Vec<Message>>>,
}

impl SharedRecordingSink {
    fn new() -> Self {
        Self {
            sent: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    fn sent(&self) -> Vec<Message> {
        self.sent.lock().expect("recording sink lock").clone()
    }
}

impl futures_util::Sink<Message> for SharedRecordingSink {
    type Error = axum::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        self.sent.lock().expect("recording sink lock").push(item);
        Ok(())
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

/// `SERVICE-001`: a peer that stopped answering Pings is a half-open socket,
/// and the operator evidence must say so. The wire keeps Plan 05's published
/// slow-client terminal contract — browsers have one terminal vocabulary and
/// this plan adds no wire reason — but the recorded terminal label is the
/// service-local `heartbeat_timeout`, so a half-open socket is never read
/// back as a slow reader whose outbound write missed its deadline.
#[tokio::test(start_paused = true)]
async fn heartbeat_expiry_records_heartbeat_timeout_on_the_slow_client_wire_contract() {
    let store = Arc::new(data::InMemoryStudyStore::seeded_fixture());
    let probe_task = Arc::new(std::sync::Mutex::new(None));
    let state = AppState::with_study_store(
        Arc::new(SlowClientProbeBrain {
            study_store: store.clone(),
            task: probe_task.clone(),
        }),
        "slow_client_probe",
        crate::config::VoiceWsAccess::default(),
        2,
        store,
    )
    .with_ws_timeouts(crate::app::WsTimeouts {
        // Every other deadline is far away: only the heartbeat can end this
        // socket, and the outbound sink never stalls.
        first_frame: Duration::from_secs(600),
        idle: Duration::from_secs(3_600),
        between_turn_idle: Duration::from_secs(3_600),
        session: Duration::from_secs(6 * 60 * 60),
        heartbeat_interval: HEARTBEAT_INTERVAL,
        pong_timeout: PONG_TIMEOUT,
        outbound_write: Duration::from_secs(5),
        ..crate::app::WsTimeouts::default()
    });
    let evidence = state.evidence.clone();
    let limit_state = state.limit_state.clone();
    let session_slots = state.session_slots.clone();

    let permit = session_slots
        .clone()
        .acquire_owned()
        .await
        .expect("session slot");
    let ip_lease = limit_state
        .try_acquire_ip("198.51.100.9", 2)
        .expect("ip lease");
    let admission = VoiceAdmission {
        _permit: permit,
        _ip_lease: Some(ip_lease),
        // `SERVICE-012`: the handler guard the real upgrade acquires, so the
        // deterministic cleanup path drops exactly what production drops.
        _handler_guard: state.runtime_tracker.enter().expect("handler guard"),
        principal: crate::config::UpgradePrincipal::ServiceBearer,
    };

    // The client bootstraps, then reads nothing and writes nothing ever
    // again — including no Pong.
    let client_frames = futures_util::stream::iter(vec![Ok(Message::Text(
        slow_client_session_config_json().into(),
    ))])
    .chain(futures_util::stream::pending());

    let sink = SharedRecordingSink::new();
    let start = Instant::now();
    run_voice_session(
        BoundedSender::new(sink.clone(), Duration::from_secs(5)),
        client_frames,
        state,
        admission,
        "http://localhost:3000".to_owned(),
    )
    .await;

    assert_eq!(
        Instant::now().duration_since(start),
        HEARTBEAT_INTERVAL + PONG_TIMEOUT,
        "the socket ends one ping interval plus one pong timeout after acceptance"
    );

    let sent = sink.sent();
    assert!(
        sent.iter().any(|message| matches!(
            message,
            Message::Ping(payload) if payload.is_empty()
        )),
        "the server must have pinged before it expired the peer: {sent:?}"
    );
    // The wire contract is unchanged: Plan 05's `slow_client` terminal phase
    // and its close reason.
    let terminal_wire_reason = sent
        .iter()
        .find_map(|message| match message {
            Message::Text(text) => {
                let frame: serde_json::Value = serde_json::from_str(text).ok()?;
                let event = frame.get("event")?;
                if event.get("type")?.as_str()? != "session_phase" {
                    return None;
                }
                Some(event.get("terminal_reason")?.as_str()?.to_owned())
            }
            _ => None,
        })
        .expect("a terminal session_phase frame");
    assert_eq!(
        terminal_wire_reason,
        TerminalSessionReason::SlowClient.as_str(),
        "the wire keeps Plan 05's published terminal vocabulary: {sent:?}"
    );
    assert!(
        sent.iter().any(|message| matches!(
            message,
            Message::Close(Some(frame))
                if frame.reason == TerminalSessionReason::SlowClient.close_reason()
        )),
        "the close frame keeps the slow-client reason: {sent:?}"
    );

    // The evidence is where the half-open socket is named.
    let recorded = evidence.snapshot();
    assert!(
        recorded.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::TerminalReason
                && event.detail == HEARTBEAT_TIMEOUT_TERMINAL_LABEL
        }),
        "a missing Pong records `heartbeat_timeout`: {recorded:?}"
    );
    assert!(
        !recorded.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::TerminalReason
                && event.detail == TerminalSessionReason::SlowClient.as_str()
        }),
        "a half-open socket is not reported as a slow reader: {recorded:?}"
    );
    assert!(
        recorded.iter().any(|event| {
            event.kind == VoiceEvidenceEventKind::Close
                && event.detail == HEARTBEAT_TIMEOUT_TERMINAL_LABEL
        }),
        "the close evidence carries the same label: {recorded:?}"
    );

    assert_eq!(limit_state.ip_lease_count("198.51.100.9"), None);
    assert_eq!(session_slots.available_permits(), 2);
}

/// The two outbound-write labels and the heartbeat label stay distinct: a
/// missed write deadline is a slow reader, a broken sink is a failed send,
/// and only an unanswered Ping is a heartbeat timeout.
#[test]
fn heartbeat_timeout_is_distinct_from_every_outbound_write_label() {
    assert_eq!(
        heartbeat_expiry_terminal_label(TerminalSessionReason::SlowClient.as_str()),
        HEARTBEAT_TIMEOUT_TERMINAL_LABEL
    );
    assert_ne!(
        HEARTBEAT_TIMEOUT_TERMINAL_LABEL,
        outbound_write_terminal_label(&OutboundWriteError::Timeout)
    );
    assert_ne!(
        HEARTBEAT_TIMEOUT_TERMINAL_LABEL,
        outbound_write_terminal_label(&OutboundWriteError::Sink(axum::Error::new(
            std::io::Error::other("sink broke")
        )))
    );
    assert!(
        !TerminalSessionReason::ALL
            .iter()
            .any(|reason| reason.as_str() == HEARTBEAT_TIMEOUT_TERMINAL_LABEL),
        "`heartbeat_timeout` is a service-local evidence label, not a wire reason"
    );
    // A close that degraded under its own store write, or that failed
    // outright, keeps the label it produced rather than being relabelled.
    assert_eq!(
        heartbeat_expiry_terminal_label(TerminalSessionReason::DurabilityDegraded.as_str()),
        TerminalSessionReason::DurabilityDegraded.as_str()
    );
    assert_eq!(
        heartbeat_expiry_terminal_label("send_failed"),
        "send_failed"
    );
}

/// `A-20.2`: the closing handshake is skipped only for an explicitly
/// recorded write failure or a peer that is already gone — never because a
/// sanitized terminal label happens to read like one.
///
/// `slow_client` is the case that broke: it is Plan 05's wire reason for
/// "this socket is not keeping up", and an ordinary overlapping-turn policy
/// denial closes with it while every server write succeeds. Reading the
/// label as write-side evidence dropped the socket on top of the client's
/// unread bytes and reset the connection, discarding the terminal frame and
/// the Close frame already written to it.
#[test]
fn closing_handshake_is_skipped_only_for_a_failed_write_or_a_departed_peer() {
    // The defect: a wire reason is not evidence about the write side, so no
    // terminal reason on its own may cancel the handshake.
    assert!(
        TerminalSessionReason::ALL
            .iter()
            .all(|reason| should_finish_closing_handshake(false, reason.as_str())),
        "a wire terminal reason is not evidence that this socket's write side failed"
    );
    // Including the two labels that name a write failure. Only the flag decides.
    assert!(should_finish_closing_handshake(
        false,
        TerminalSessionReason::SlowClient.as_str()
    ));
    assert!(should_finish_closing_handshake(false, "send_failed"));

    // A recorded write failure has nothing left to deliver, whatever the label says.
    assert!(!should_finish_closing_handshake(
        true,
        TerminalSessionReason::SlowClient.as_str()
    ));
    assert!(!should_finish_closing_handshake(true, "send_failed"));
    assert!(!should_finish_closing_handshake(
        true,
        TerminalSessionReason::CostBudget.as_str()
    ));
    assert!(!should_finish_closing_handshake(
        true,
        "oversized_text_frame"
    ));

    // A peer that is already gone has nobody left to answer the Close.
    assert!(!should_finish_closing_handshake(false, "client_disconnect"));
    assert!(!should_finish_closing_handshake(
        false,
        HEARTBEAT_TIMEOUT_TERMINAL_LABEL
    ));
}

/// `SERVICE-017`: the state machine Tasks 8-11 fixed, frozen before the
/// responsibility split. These assert transitions, not files: an extraction
/// that changed an order, a count, or an identity would fail them wherever
/// the code ended up living.
mod ws_state_transition_characterization {
    use super::*;

    fn refresh_config(user_id: &str, study_set_id: &str, session_id: &str) -> SessionConfig {
        SessionConfig {
            session_id: Some(agent_domain::SessionId::new(session_id.to_owned())),
            user_id: Some(user_id.to_owned()),
            study_set_id: Some(study_set_id.to_owned()),
            mode: None,
            source_context: vec![agent_domain::SourceContext {
                source_id: "src-lecture-5-slide-18".to_owned(),
                document_id: "lec-5".to_owned(),
                span: "slide 18".to_owned(),
                excerpt: "client-supplied context is dropped".to_owned(),
                confidence: agent_domain::SourceConfidence::High,
                retrieval_reason: "client-supplied".to_owned(),
            }],
            active_concepts: vec!["client-supplied-concept".to_owned()],
            client_generation_id: Some("generation-1".to_owned()),
        }
    }

    /// An admitted turn is registered before a `QuestionStarted` can bind it.
    /// A binding attempt with nothing admitted fails closed and mints nothing.
    #[test]
    fn ws_state_transition_characterization_registers_an_admitted_turn_before_binding() {
        let mut bindings = TurnBindingTracker::default();
        assert_eq!(
            bindings.bind_question("response-1"),
            Err(TurnBindingError::MissingTurn),
            "a question cannot bind before its turn is admitted"
        );

        register_submitted_turn(&mut bindings, Some("turn-a"));
        assert_eq!(bindings.bind_question("response-1"), Ok("turn-a"));
        assert_eq!(bindings.turn_for_response("response-1"), Ok("turn-a"));

        // A second question with nothing further admitted still fails closed.
        assert_eq!(
            bindings.bind_question("response-2"),
            Err(TurnBindingError::MissingTurn)
        );
    }

    /// One resolution releases one binding, and the turn id is then spent:
    /// never re-bound, never re-registered, never recycled.
    #[test]
    fn ws_state_transition_characterization_spends_a_response_binding_exactly_once() {
        let mut bindings = TurnBindingTracker::default();
        register_submitted_turn(&mut bindings, Some("turn-a"));
        assert_eq!(bindings.bind_question("response-1"), Ok("turn-a"));

        bindings.release_response("response-1");
        assert_eq!(
            bindings.turn_for_response("response-1"),
            Err(TurnBindingError::MissingResponse)
        );
        // A repeated resolution changes nothing.
        bindings.release_response("response-1");
        assert_eq!(
            bindings.turn_for_response("response-1"),
            Err(TurnBindingError::MissingResponse)
        );
        assert_eq!(
            bindings.register_submission("turn-a".to_owned()),
            Err(TurnBindingError::DuplicateTurn),
            "a spent turn id is never recycled"
        );
        register_submitted_turn(&mut bindings, Some("turn-a"));
        assert_eq!(
            bindings.bind_question("response-2"),
            Err(TurnBindingError::MissingTurn),
            "the refused re-registration admitted nothing"
        );
    }

    /// An in-socket context refresh restates identity; it cannot change it.
    /// The bound generation, credential, user, study set, and the server-side
    /// session id all survive a refresh that asks for something else.
    #[test]
    fn ws_state_transition_characterization_context_refresh_rebinds_no_identity() {
        let binding = AuthorizedClientSession {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            session_id: "server-session-rotated".to_owned(),
            client_session_id: "voice-session-1".to_owned(),
            client_generation_id: "generation-1".to_owned(),
            bound_session_token: "bound-token".to_owned(),
            auth_mode: SessionAuthMode::Signed,
        };
        // A refresh that asserts someone else's identity is refused outright.
        assert_eq!(
            sanitize_refresh_session_config(
                refresh_config("attacker", "biology-midterm", "voice-session-1"),
                "generation-1",
                "bound-token",
                &binding,
            ),
            Err(ClientFrameError::invalid_session_identity())
        );
        assert_eq!(
            sanitize_refresh_session_config(
                refresh_config("user-1", "someone-elses-set", "voice-session-1"),
                "generation-1",
                "bound-token",
                &binding,
            ),
            Err(ClientFrameError::invalid_session_identity())
        );
        assert_eq!(
            sanitize_refresh_session_config(
                refresh_config("user-1", "biology-midterm", "server-session-rotated"),
                "generation-1",
                "bound-token",
                &binding,
            ),
            Err(ClientFrameError::invalid_session_identity()),
            "the browser may only name the client session id, never the server's"
        );

        // One that restates the bound identity is accepted, and the
        // provider-facing session id stays the server's own rotated value.
        let refreshed = sanitize_refresh_session_config(
            refresh_config("user-1", "biology-midterm", "voice-session-1"),
            "generation-1",
            "bound-token",
            &binding,
        )
        .expect("a refresh that restates the bound identity is accepted");
        assert_eq!(refreshed.user_id.as_deref(), Some("user-1"));
        assert_eq!(refreshed.study_set_id.as_deref(), Some("biology-midterm"));
        assert_eq!(
            refreshed.session_id.as_deref(),
            Some("server-session-rotated")
        );
        assert!(refreshed.source_context.is_empty());
        assert!(refreshed.active_concepts.is_empty());
        assert_eq!(refreshed.client_generation_id, None);

        assert_eq!(
            sanitize_refresh_session_config(
                refresh_config("user-1", "biology-midterm", "voice-session-1"),
                "generation-2",
                "bound-token",
                &binding,
            ),
            Err(ClientFrameError::generation_mismatch())
        );
        assert_eq!(
            sanitize_refresh_session_config(
                refresh_config("user-1", "biology-midterm", "voice-session-1"),
                "generation-1",
                "some-other-token",
                &binding,
            ),
            Err(ClientFrameError::session_auth_failed(
                SessionAuthFailureCode::IdentityMismatch
            ))
        );

        // And the refresh itself is a recoverable denial, so it reaches no
        // deadline, no lease, and no provider input.
        assert!(matches!(
            bind_context_refresh("generation-1", &binding, SESSION_REFRESH_POLICY),
            Ok(ClientInputAction::RecoverableDenial(_))
        ));
        assert!(matches!(
            bind_context_refresh("generation-2", &binding, SESSION_REFRESH_POLICY),
            Err(error) if error == ClientFrameError::generation_mismatch()
        ));
    }

    /// A resolution moves the pending-answer and active-turn counters exactly
    /// once, however many times the same response resolves.
    #[test]
    fn ws_state_transition_characterization_provider_counts_transition_once() {
        let mut accounting = ProviderTurnAccounting::with_one_open_turn();
        let resolved = BrainEvent::AnswerEvaluated {
            response_id: "response-1".to_owned(),
            evaluation: classifier_fixture_evaluation(),
        };

        accounting.apply(&resolved);
        assert_eq!(accounting.pending_submitted_answers, 0);
        assert_eq!(accounting.active_provider_turns, 0);
        assert_eq!(accounting.turn_cap_deadline, None);

        accounting.apply(&resolved);
        assert_eq!(
            accounting.pending_submitted_answers, 0,
            "a repeated resolution must not move the counter twice"
        );
        assert_eq!(accounting.active_provider_turns, 0);
    }

    /// The between-turn deadline is re-armed only at zero outstanding turn
    /// work. Any pending answer or active provider turn leaves it alone.
    #[tokio::test(start_paused = true)]
    async fn ws_state_transition_characterization_between_turn_idle_rearms_only_at_zero() {
        let start = Instant::now();
        let sleeper = tokio::time::sleep_until(start + Duration::from_secs(1));
        tokio::pin!(sleeper);
        let timeout = Duration::from_secs(600);

        for (pending, active) in [(1_u32, 0_u32), (0, 1), (1, 1)] {
            assert!(
                !rearm_between_turn_idle(pending, active, sleeper.as_mut(), start, timeout),
                "outstanding turn work ({pending}, {active}) must not re-arm"
            );
            assert_eq!(sleeper.deadline(), start + Duration::from_secs(1));
        }

        assert!(rearm_between_turn_idle(
            0,
            0,
            sleeper.as_mut(),
            start,
            timeout
        ));
        assert_eq!(sleeper.deadline(), start + timeout);
    }
}
