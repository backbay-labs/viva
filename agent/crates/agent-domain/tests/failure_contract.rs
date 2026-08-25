//! Plan 06 Task 2 (`DOMAIN-004`, `DOMAIN-009`): typed, sanitized, exhaustive failures.
//!
//! Classification is data, not prose. These tests pin three separate claims:
//!
//! 1. every `BrainFailureClass` maps to exactly one `TerminalSessionReason` and
//!    carries exactly one wire token, so Plans 07/08 can delete every
//!    message-substring classifier;
//! 2. neither the constructor nor the deserializer can be talked into keeping a
//!    raw provider string — hostile Unicode, newlines, secret markers, and
//!    oversized values are sanitized, and a wire value whose `terminal_reason`
//!    contradicts its `failure_class` is rejected outright;
//! 3. `BrainProviderError` stays wire-compatible for `protocol.rs` while
//!    `require_failure()` turns a missing typed failure into a typed error
//!    instead of letting absence become a message-classification fallback.
//!
//! The `brain_usage_add_saturates_at_u64_max` case is a characterization pin of
//! the ledger's `DOMAIN-002` saturation contract: it has no RED run, and its
//! enforcement proof is the mutation control in the plan's acceptance matrix.

use std::collections::BTreeSet;

use agent_domain::{
    BrainError, BrainFailureClass, BrainFailureStage, BrainProviderError,
    BrainProviderErrorClassificationError, BrainProviderFailure, BrainProviderFailureParts,
    BrainUsage, TerminalSessionReason,
};
use proptest::prelude::*;
use serde_json::{json, Value};

/// The sanitized token cap the domain constructor enforces on `provider`/`model`.
const MAX_TOKEN_LENGTH: usize = 96;
/// The sanitized cap the domain constructor enforces on `metadata`.
const MAX_METADATA_LENGTH: usize = 240;

/// The complete published class vocabulary: variant, wire token, and the single
/// terminal reason it implies. Hand-written here so a mapping swap in `brain.rs`
/// is a test failure rather than a silently mirrored table.
const CLASS_TABLE: [(BrainFailureClass, &str, TerminalSessionReason); 16] = [
    (
        BrainFailureClass::DeployDrain,
        "deploy_drain",
        TerminalSessionReason::Drained,
    ),
    (
        BrainFailureClass::SessionCap,
        "session_cap",
        TerminalSessionReason::SessionCap,
    ),
    (
        BrainFailureClass::TurnCap,
        "turn_cap",
        TerminalSessionReason::TurnCap,
    ),
    (
        BrainFailureClass::LocalRateLimit,
        "local_rate_limit",
        TerminalSessionReason::RateLimit,
    ),
    (
        BrainFailureClass::CostBudget,
        "cost_budget",
        TerminalSessionReason::CostBudget,
    ),
    (
        BrainFailureClass::ProviderAuthFailure,
        "provider_auth_failure",
        TerminalSessionReason::ProviderAuthFailed,
    ),
    (
        BrainFailureClass::QuotaRateFailure,
        "quota_rate_failure",
        TerminalSessionReason::ProviderRateLimited,
    ),
    (
        BrainFailureClass::Timeout,
        "timeout",
        TerminalSessionReason::ProviderTimeout,
    ),
    (
        BrainFailureClass::MalformedStream,
        "malformed_stream",
        TerminalSessionReason::ProviderMalformedStream,
    ),
    (
        BrainFailureClass::NetworkDisconnect,
        "network_disconnect",
        TerminalSessionReason::ProviderNetworkDisconnect,
    ),
    (
        BrainFailureClass::SlowClient,
        "slow_client",
        TerminalSessionReason::SlowClient,
    ),
    (
        BrainFailureClass::Cancellation,
        "cancellation",
        TerminalSessionReason::ProviderCancelled,
    ),
    (
        BrainFailureClass::PartialStageSuccess,
        "partial_stage_success",
        TerminalSessionReason::PartialStageSuccess,
    ),
    (
        BrainFailureClass::DurabilityDegraded,
        "durability_degraded",
        TerminalSessionReason::DurabilityDegraded,
    ),
    (
        BrainFailureClass::ToolExecutorFailure,
        "tool_executor_failure",
        TerminalSessionReason::ToolExecutorFailure,
    ),
    (
        BrainFailureClass::Rollback,
        "rollback",
        TerminalSessionReason::Rollback,
    ),
];

/// The complete published stage vocabulary. Protocol-only observability labels
/// (`pending_evaluation`, `pre_loop_unavailable`, `session_bootstrap_unavailable`,
/// `session_auth_failure`) are deliberately absent: Plan 08 keeps those
/// non-terminal/pre-session signals out of typed `BrainError` classification.
const STAGE_TABLE: [(BrainFailureStage, &str); 14] = [
    (BrainFailureStage::Session, "session"),
    (BrainFailureStage::Store, "store"),
    (BrainFailureStage::Tools, "tools"),
    (BrainFailureStage::Recap, "recap"),
    (BrainFailureStage::Gemini, "gemini"),
    (BrainFailureStage::Provider, "provider"),
    (BrainFailureStage::ProviderAuth, "provider_auth"),
    (BrainFailureStage::Websocket, "websocket"),
    (BrainFailureStage::Transport, "transport"),
    (BrainFailureStage::PreLoop, "pre_loop"),
    (BrainFailureStage::Startup, "startup"),
    (BrainFailureStage::SessionAuth, "session_auth"),
    (BrainFailureStage::Deployment, "deployment"),
    (BrainFailureStage::Rollback, "rollback"),
];

fn sanitized_token_is_well_formed(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN_LENGTH
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn sanitized_metadata_is_well_formed(value: &str) -> bool {
    value.len() <= MAX_METADATA_LENGTH
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    ' ' | '-' | '_' | ':' | '.' | '/' | '=' | ',' | ';' | '(' | ')'
                )
        })
}

fn fixture_parts(
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
) -> BrainProviderFailureParts {
    BrainProviderFailureParts {
        failure_class,
        stage,
        retry_eligible: false,
        latency_ms: 1_250,
        provider: "gemini".to_owned(),
        model: "gemini-realtime".to_owned(),
        metadata: "http_status=503".to_owned(),
    }
}

#[test]
fn every_failure_class_maps_to_exactly_one_terminal_reason() {
    assert_eq!(
        BrainFailureClass::ALL.len(),
        CLASS_TABLE.len(),
        "the class vocabulary changed without updating this table",
    );

    for (index, (class, wire, terminal_reason)) in CLASS_TABLE.into_iter().enumerate() {
        assert_eq!(
            BrainFailureClass::ALL[index],
            class,
            "class declaration order drifted from the published vocabulary",
        );
        assert_eq!(class.as_str(), wire, "wrong wire token for {class:?}");
        assert_eq!(
            class.terminal_reason(),
            terminal_reason,
            "wrong terminal reason for {class:?}",
        );
        assert_eq!(
            serde_json::to_value(class).expect("class serializes"),
            Value::String(wire.to_owned()),
            "serde token drifted from as_str for {class:?}",
        );
        assert_eq!(
            serde_json::from_value::<BrainFailureClass>(Value::String(wire.to_owned()))
                .expect("wire token deserializes"),
            class,
            "wire token does not round-trip for {class:?}",
        );
    }
}

#[test]
fn failure_classes_cover_every_terminal_reason_exactly_once() {
    let mapped = CLASS_TABLE
        .into_iter()
        .map(|(class, _, _)| class.terminal_reason().as_str())
        .collect::<BTreeSet<_>>();
    let declared = TerminalSessionReason::ALL
        .into_iter()
        .map(TerminalSessionReason::as_str)
        .collect::<BTreeSet<_>>();

    assert_eq!(
        mapped.len(),
        CLASS_TABLE.len(),
        "two classes collapse onto one terminal reason",
    );
    assert_eq!(
        mapped, declared,
        "class mapping is not exhaustive over TerminalSessionReason",
    );
}

#[test]
fn failure_class_tokens_are_a_closed_lowercase_vocabulary() {
    let tokens = BrainFailureClass::ALL
        .into_iter()
        .map(BrainFailureClass::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(tokens.len(), BrainFailureClass::ALL.len());
    for token in &tokens {
        assert!(
            token
                .chars()
                .all(|character| character.is_ascii_lowercase() || character == '_'),
            "class token {token} is not lowercase snake_case",
        );
    }
    assert!(
        serde_json::from_value::<BrainFailureClass>(json!("timeout_v2")).is_err(),
        "an unknown class token must not deserialize",
    );
    assert!(
        serde_json::from_value::<BrainFailureClass>(json!("pending_evaluation")).is_err(),
        "a protocol-only observability label is not a domain failure class",
    );
}

#[test]
fn every_failure_stage_has_its_exact_wire_token() {
    assert_eq!(
        BrainFailureStage::ALL.len(),
        STAGE_TABLE.len(),
        "the stage vocabulary changed without updating this table",
    );

    for (index, (stage, wire)) in STAGE_TABLE.into_iter().enumerate() {
        assert_eq!(
            BrainFailureStage::ALL[index],
            stage,
            "stage declaration order drifted from the published vocabulary",
        );
        assert_eq!(stage.as_str(), wire, "wrong wire token for {stage:?}");
        assert_eq!(
            serde_json::to_value(stage).expect("stage serializes"),
            Value::String(wire.to_owned()),
            "serde token drifted from as_str for {stage:?}",
        );
        assert_eq!(
            serde_json::from_value::<BrainFailureStage>(Value::String(wire.to_owned()))
                .expect("wire token deserializes"),
            stage,
            "wire token does not round-trip for {stage:?}",
        );
    }

    let tokens = BrainFailureStage::ALL
        .into_iter()
        .map(BrainFailureStage::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(tokens.len(), BrainFailureStage::ALL.len());
    assert!(
        serde_json::from_value::<BrainFailureStage>(json!("pre_loop_unavailable")).is_err(),
        "a protocol-only observability label is not a domain failure stage",
    );
}

#[test]
fn constructed_failures_derive_the_terminal_reason_from_the_class() {
    for (class, _, terminal_reason) in CLASS_TABLE {
        let failure =
            BrainProviderFailure::new(fixture_parts(class, BrainFailureStage::ProviderAuth));
        assert_eq!(failure.failure_class(), class);
        assert_eq!(failure.stage(), BrainFailureStage::ProviderAuth);
        assert_eq!(failure.terminal_reason(), terminal_reason);
    }
}

#[test]
fn failure_serialization_keeps_the_published_wire_field_names() {
    let failure = BrainProviderFailure::new(BrainProviderFailureParts {
        failure_class: BrainFailureClass::QuotaRateFailure,
        stage: BrainFailureStage::Provider,
        retry_eligible: true,
        latency_ms: 8_192,
        provider: "cartesia".to_owned(),
        model: "sonic-2".to_owned(),
        metadata: "http_status=429,attempt=2".to_owned(),
    });

    assert_eq!(
        serde_json::to_value(&failure).expect("failure serializes"),
        json!({
            "failure_class": "quota_rate_failure",
            "stage": "provider",
            "terminal_reason": "provider_rate_limited",
            "retry_eligible": true,
            "latency_ms": 8_192,
            "provider": "cartesia",
            "model": "sonic-2",
            "metadata": "http_status=429,attempt=2",
        }),
    );

    let round_tripped: BrainProviderFailure =
        serde_json::from_value(serde_json::to_value(&failure).expect("failure serializes"))
            .expect("canonical failure round-trips");
    assert_eq!(round_tripped, failure);
    assert!(round_tripped.retry_eligible());
    assert_eq!(round_tripped.latency_ms(), 8_192);
}

#[test]
fn hostile_failure_wire_values_are_sanitized_or_rejected() {
    let value = serde_json::json!({
        "failure_class": "timeout",
        "stage": "gemini",
        "terminal_reason": "provider_timeout",
        "retry_eligible": true,
        "latency_ms": 42,
        "provider": "gemini\nBearer secret-token",
        "model": "model🔥/../../raw_prompt",
        "metadata": "http_status=503\nraw_prompt=<secret> bearer.token",
    });
    let failure: agent_domain::BrainProviderFailure = serde_json::from_value(value).unwrap();

    assert_eq!(
        failure.failure_class(),
        agent_domain::BrainFailureClass::Timeout
    );
    assert_eq!(failure.stage(), agent_domain::BrainFailureStage::Gemini);
    assert_eq!(
        failure.terminal_reason(),
        TerminalSessionReason::ProviderTimeout
    );
    assert!(!failure
        .provider()
        .chars()
        .any(|character| matches!(character, '\n' | ' ')));
    assert!(failure.provider().len() <= 96);
    assert!(!failure.model().contains('🔥'));
    assert!(!failure.metadata().contains('\n'));
    assert!(failure.metadata().len() <= 240);
}

#[test]
fn hostile_wire_values_never_survive_as_raw_secrets() {
    let value = json!({
        "failure_class": "provider_auth_failure",
        "stage": "provider_auth",
        "terminal_reason": "provider_auth_failed",
        "retry_eligible": false,
        "latency_ms": 11,
        "provider": "gemini Authorization: Bearer sk-live-secret",
        "model": "../../etc/passwd",
        "metadata": "raw_prompt=<user answer> token=\"sk-live\"",
    });
    let failure: BrainProviderFailure = serde_json::from_value(value).expect("wire is sanitized");

    assert!(sanitized_token_is_well_formed(failure.provider()));
    assert!(sanitized_token_is_well_formed(failure.model()));
    assert!(sanitized_metadata_is_well_formed(failure.metadata()));
    assert!(!failure.provider().contains(':'));
    assert!(!failure.metadata().contains('<'));
    assert!(!failure.metadata().contains('"'));
    assert_eq!(failure.model(), "etcpasswd");
}

#[test]
fn oversized_wire_values_are_truncated_to_the_domain_caps() {
    let value = json!({
        "failure_class": "malformed_stream",
        "stage": "transport",
        "terminal_reason": "provider_malformed_stream",
        "retry_eligible": false,
        "latency_ms": 0,
        "provider": "p".repeat(4_096),
        "model": "m".repeat(4_096),
        "metadata": "k=v,".repeat(4_096),
    });
    let failure: BrainProviderFailure = serde_json::from_value(value).expect("wire is sanitized");

    assert_eq!(failure.provider().len(), MAX_TOKEN_LENGTH);
    assert_eq!(failure.model().len(), MAX_TOKEN_LENGTH);
    assert_eq!(failure.metadata().len(), MAX_METADATA_LENGTH);
}

#[test]
fn an_empty_provider_token_falls_back_to_unknown_instead_of_an_empty_string() {
    let failure = BrainProviderFailure::new(BrainProviderFailureParts {
        provider: "\u{1F525}\u{1F525}".to_owned(),
        model: String::new(),
        ..fixture_parts(BrainFailureClass::Timeout, BrainFailureStage::Gemini)
    });

    assert_eq!(failure.provider(), "unknown");
    assert_eq!(failure.model(), "unknown");
}

#[test]
fn a_wire_terminal_reason_that_contradicts_its_class_is_rejected() {
    let value = json!({
        "failure_class": "timeout",
        "stage": "gemini",
        "terminal_reason": "provider_auth_failed",
        "retry_eligible": true,
        "latency_ms": 42,
        "provider": "gemini",
        "model": "gemini-realtime",
        "metadata": "http_status=504",
    });

    let error = serde_json::from_value::<BrainProviderFailure>(value)
        .expect_err("a mismatched terminal reason must not deserialize");
    assert!(
        error.to_string().contains("provider_timeout"),
        "rejection must name the class-implied reason, got: {error}",
    );
}

#[test]
fn every_class_rejects_every_foreign_terminal_reason_on_the_wire() {
    for (class, class_wire, terminal_reason) in CLASS_TABLE {
        for (_, _, foreign) in CLASS_TABLE {
            let value = json!({
                "failure_class": class_wire,
                "stage": "provider",
                "terminal_reason": foreign.as_str(),
                "retry_eligible": false,
                "latency_ms": 3,
                "provider": "gemini",
                "model": "gemini-realtime",
                "metadata": "",
            });
            let parsed = serde_json::from_value::<BrainProviderFailure>(value);
            if foreign.as_str() == terminal_reason.as_str() {
                assert_eq!(
                    parsed
                        .expect("the class-implied reason deserializes")
                        .failure_class(),
                    class,
                );
            } else {
                assert!(
                    parsed.is_err(),
                    "{class:?} must reject wire terminal reason {}",
                    foreign.as_str(),
                );
            }
        }
    }
}

#[test]
fn unknown_wire_keys_are_rejected_rather_than_ignored() {
    let value = json!({
        "failure_class": "rollback",
        "stage": "websocket",
        "terminal_reason": "rollback",
        "retry_eligible": false,
        "latency_ms": 5,
        "provider": "agent-service",
        "model": "none",
        "metadata": "",
        "raw_provider_message": "Bearer sk-live-secret",
    });

    assert!(
        serde_json::from_value::<BrainProviderFailure>(value).is_err(),
        "an unknown wire key must not smuggle raw provider text into the domain",
    );
}

#[test]
fn a_missing_wire_field_is_rejected_rather_than_defaulted() {
    let value = json!({
        "failure_class": "rollback",
        "stage": "websocket",
        "terminal_reason": "rollback",
        "retry_eligible": false,
        "latency_ms": 5,
        "provider": "agent-service",
        "model": "none",
    });

    assert!(
        serde_json::from_value::<BrainProviderFailure>(value).is_err(),
        "metadata must be present on the wire, never silently defaulted",
    );
}

#[test]
fn brain_error_carries_exactly_one_typed_failure() {
    let failure = BrainProviderFailure::new(fixture_parts(
        BrainFailureClass::DurabilityDegraded,
        BrainFailureStage::Store,
    ));
    let error = BrainError::from_failure(failure.clone());

    assert_eq!(error.failure(), &failure);
    assert_eq!(
        error.terminal_reason(),
        TerminalSessionReason::DurabilityDegraded,
    );
    assert_eq!(error.to_string(), failure.to_string());
    assert_eq!(
        error.to_string(),
        "store stage failure: durability_degraded"
    );
}

#[test]
fn provider_error_requires_a_typed_failure() {
    let failure = BrainProviderFailure::new(fixture_parts(
        BrainFailureClass::Timeout,
        BrainFailureStage::Gemini,
    ));
    let provider_error = BrainProviderError::from_failure(failure.clone());

    assert_eq!(
        provider_error
            .require_failure()
            .expect("a classified provider error carries its typed failure"),
        &failure,
    );
    assert_eq!(provider_error.failure(), Some(&failure));
    assert_eq!(provider_error.source, failure.provider());
    assert_eq!(provider_error.message, failure.to_string());
    assert_eq!(provider_error.message, "gemini stage failure: timeout");

    let legacy: BrainProviderError = serde_json::from_value(json!({
        "source": "agent-service",
        "message": "telemetry event suppressed",
    }))
    .expect("the legacy protocol shape still deserializes");

    assert_eq!(legacy.failure(), None);
    assert_eq!(
        legacy.require_failure(),
        Err(BrainProviderErrorClassificationError::MissingTypedFailure),
    );
    assert_eq!(
        BrainProviderErrorClassificationError::MissingTypedFailure.to_string(),
        "provider error is missing a typed failure",
    );
}

/// Hand-derived saturation table for the ledger's `DOMAIN-002` contract. Each row
/// is written out rather than computed so a cross-wired counter or a plain `+`
/// cannot satisfy it.
#[test]
fn brain_usage_add_saturates_at_u64_max() {
    const COUNTER_COUNT: usize = 7;

    fn counter(usage: &BrainUsage, index: usize) -> u64 {
        match index {
            0 => usage.audio_input_tokens,
            1 => usage.cached_audio_input_tokens,
            2 => usage.audio_output_tokens,
            3 => usage.text_input_tokens,
            4 => usage.cached_text_input_tokens,
            5 => usage.text_output_tokens,
            6 => usage.source_grounded_correction_count,
            _ => unreachable!("BrainUsage has exactly 7 counters"),
        }
    }

    fn only(index: usize, value: u64) -> BrainUsage {
        let mut usage = BrainUsage::default();
        match index {
            0 => usage.audio_input_tokens = value,
            1 => usage.cached_audio_input_tokens = value,
            2 => usage.audio_output_tokens = value,
            3 => usage.text_input_tokens = value,
            4 => usage.cached_text_input_tokens = value,
            5 => usage.text_output_tokens = value,
            6 => usage.source_grounded_correction_count = value,
            _ => unreachable!("BrainUsage has exactly 7 counters"),
        }
        usage
    }

    for index in 0..COUNTER_COUNT {
        let mut total = only(index, u64::MAX - 1);
        total.add(&only(index, 2));

        assert_eq!(
            counter(&total, index),
            u64::MAX,
            "counter {index} must saturate instead of wrapping",
        );
        for other in 0..COUNTER_COUNT {
            if other != index {
                assert_eq!(
                    counter(&total, other),
                    0,
                    "counter {other} moved while saturating counter {index}",
                );
            }
        }

        let mut normal = only(index, 40);
        normal.add(&only(index, 2));
        assert_eq!(
            counter(&normal, index),
            42,
            "counter {index} must still perform normal arithmetic",
        );
    }

    // Distinct per-counter values so a cross-wired assignment cannot pass.
    let mut mixed = BrainUsage {
        audio_input_tokens: 10,
        cached_audio_input_tokens: 20,
        audio_output_tokens: 30,
        text_input_tokens: 40,
        cached_text_input_tokens: 50,
        text_output_tokens: 60,
        source_grounded_correction_count: 70,
    };
    mixed.add(&BrainUsage {
        audio_input_tokens: 1,
        cached_audio_input_tokens: 2,
        audio_output_tokens: 3,
        text_input_tokens: 4,
        cached_text_input_tokens: 5,
        text_output_tokens: 6,
        source_grounded_correction_count: 7,
    });

    assert_eq!(
        mixed,
        BrainUsage {
            audio_input_tokens: 11,
            cached_audio_input_tokens: 22,
            audio_output_tokens: 33,
            text_input_tokens: 44,
            cached_text_input_tokens: 55,
            text_output_tokens: 66,
            source_grounded_correction_count: 77,
        },
    );
}

proptest! {
    /// Arbitrary Unicode — including control characters, newlines, and secret
    /// markers — must not survive construction.
    #[test]
    fn constructed_failures_sanitize_arbitrary_unicode(
        provider in "(?s).{0,400}",
        model in "(?s).{0,400}",
        metadata in "(?s).{0,400}",
    ) {
        let failure = BrainProviderFailure::new(BrainProviderFailureParts {
            failure_class: BrainFailureClass::NetworkDisconnect,
            stage: BrainFailureStage::Transport,
            retry_eligible: true,
            latency_ms: u64::MAX,
            provider,
            model,
            metadata,
        });

        prop_assert!(
            sanitized_token_is_well_formed(failure.provider()),
            "unsanitized provider: {:?}",
            failure.provider(),
        );
        prop_assert!(
            sanitized_token_is_well_formed(failure.model()),
            "unsanitized model: {:?}",
            failure.model(),
        );
        prop_assert!(
            sanitized_metadata_is_well_formed(failure.metadata()),
            "unsanitized metadata: {:?}",
            failure.metadata(),
        );
        prop_assert_eq!(
            failure.terminal_reason(),
            TerminalSessionReason::ProviderNetworkDisconnect,
        );
    }

    /// The same guarantee must hold for values that arrive over the wire: a
    /// derived `Deserialize` would bypass the constructor entirely.
    #[test]
    fn deserialized_failures_sanitize_arbitrary_unicode(
        provider in "(?s).{0,400}",
        model in "(?s).{0,400}",
        metadata in "(?s).{0,400}",
    ) {
        let value = json!({
            "failure_class": "slow_client",
            "stage": "websocket",
            "terminal_reason": "slow_client",
            "retry_eligible": false,
            "latency_ms": 60_000,
            "provider": provider,
            "model": model,
            "metadata": metadata,
        });
        let failure: BrainProviderFailure =
            serde_json::from_value(value).expect("hostile strings are sanitized, never rejected");

        prop_assert!(
            sanitized_token_is_well_formed(failure.provider()),
            "unsanitized provider: {:?}",
            failure.provider(),
        );
        prop_assert!(
            sanitized_token_is_well_formed(failure.model()),
            "unsanitized model: {:?}",
            failure.model(),
        );
        prop_assert!(
            sanitized_metadata_is_well_formed(failure.metadata()),
            "unsanitized metadata: {:?}",
            failure.metadata(),
        );

        // Serialization of a sanitized failure is a fixed point: re-reading it
        // yields the identical value.
        let serialized = serde_json::to_value(&failure).expect("failure serializes");
        let reparsed: BrainProviderFailure =
            serde_json::from_value(serialized).expect("sanitized failure round-trips");
        prop_assert_eq!(reparsed, failure);
    }
}
