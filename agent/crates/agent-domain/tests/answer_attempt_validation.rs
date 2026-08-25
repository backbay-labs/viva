//! Plan 06 Task 4 (`DOMAIN-008`): answer evidence is bounded, mode-consistent,
//! and fails closed.
//!
//! Three separate claims are pinned here.
//!
//! 1. The content-policy converse holds in both directions:
//!    `AnswerContentPolicy::DigestOnly` requires exactly one durable content
//!    trace — an `answer_digest_hmac` of exactly 64 lowercase hexadecimal
//!    characters (HMAC-SHA256 hex) — and `AnswerContentPolicy::None` forbids a
//!    digest outright. A malformed digest is rejected, never trimmed or
//!    lowercased into acceptance.
//! 2. Capture counts are mode-consistent: typed capture carries both a byte and
//!    a character count, audio capture carries a byte count and no character
//!    count, and an audio byte count is an even number of PCM16 bytes.
//! 3. Every present count is positive and within its inclusive domain bound.
//!    Each bound is exercised at its accepted maximum and at its rejected
//!    nearest neighbour, so an off-by-one relaxation in `ports.rs` is a test
//!    failure rather than a silently widened contract.
//!
//! The constants are domain authority (plan Global Constraints, decision 2):
//! `MAX_ANSWER_BYTE_COUNT` is 45 seconds x 24,000 Hz x 2 PCM16 bytes.

use agent_domain::{
    AnswerAttemptEnvelope, AnswerCaptureMode, AnswerCaptureStatus, AnswerContentPolicy,
    ANSWER_DIGEST_HMAC_HEX_LENGTH, MAX_ANSWER_BYTE_COUNT, MAX_ANSWER_CHAR_COUNT,
    MAX_ANSWER_DURATION_MS,
};
use proptest::prelude::*;

/// A structurally valid envelope for the requested capture mode. Every helper
/// below mutates exactly one field of this value so a failing row names one
/// predicate rather than a combination.
fn envelope(capture_mode: AnswerCaptureMode) -> AnswerAttemptEnvelope {
    let (byte_count, char_count, pre_provider_state) = match capture_mode {
        // 48,000 PCM16 bytes is one second of 24 kHz mono audio.
        AnswerCaptureMode::Audio => (Some(48_000), None, "before_ink_stt"),
        AnswerCaptureMode::Typed => (Some(42), Some(21), "before_text_evaluation"),
    };

    AnswerAttemptEnvelope {
        response_id: "response-1".to_owned(),
        question_id: "q-etc-electron-flow".to_owned(),
        submission_sequence: 1,
        idempotency_key: "voice-1:q-etc-electron-flow:1:response-1".to_owned(),
        capture_mode,
        byte_count,
        char_count,
        duration_ms: Some(1_200),
        client_generation_id: None,
        locale: None,
        capture_status: AnswerCaptureStatus::Accepted,
        content_policy: AnswerContentPolicy::None,
        answer_digest_hmac: None,
        transcript_status: None,
        transcript_confidence_bucket: None,
        pre_provider_state: pre_provider_state.to_owned(),
    }
}

fn digest_only(answer_digest_hmac: Option<String>) -> AnswerAttemptEnvelope {
    AnswerAttemptEnvelope {
        content_policy: AnswerContentPolicy::DigestOnly,
        answer_digest_hmac,
        ..envelope(AnswerCaptureMode::Typed)
    }
}

fn none_policy(answer_digest_hmac: Option<String>) -> AnswerAttemptEnvelope {
    AnswerAttemptEnvelope {
        content_policy: AnswerContentPolicy::None,
        answer_digest_hmac,
        ..envelope(AnswerCaptureMode::Typed)
    }
}

fn typed_counts(byte_count: Option<u64>, char_count: Option<u64>) -> AnswerAttemptEnvelope {
    AnswerAttemptEnvelope {
        byte_count,
        char_count,
        ..envelope(AnswerCaptureMode::Typed)
    }
}

fn audio_counts(byte_count: Option<u64>, char_count: Option<u64>) -> AnswerAttemptEnvelope {
    AnswerAttemptEnvelope {
        byte_count,
        char_count,
        ..envelope(AnswerCaptureMode::Audio)
    }
}

fn audio_duration(duration_ms: Option<u64>) -> AnswerAttemptEnvelope {
    AnswerAttemptEnvelope {
        duration_ms,
        ..envelope(AnswerCaptureMode::Audio)
    }
}

/// The plan's boundary table, row for row.
#[test]
fn answer_attempt_policy_and_size_boundaries_fail_closed() {
    let digest = "a".repeat(64);
    let cases = [
        (digest_only(None), false),
        (digest_only(Some("a".repeat(63))), false),
        (digest_only(Some("A".repeat(64))), false),
        (digest_only(Some("g".repeat(64))), false),
        (digest_only(Some(digest.clone())), true),
        (none_policy(Some(digest)), false),
        (typed_counts(Some(0), Some(1)), false),
        (typed_counts(Some(1), Some(0)), false),
        (
            typed_counts(Some(MAX_ANSWER_BYTE_COUNT), Some(MAX_ANSWER_CHAR_COUNT)),
            true,
        ),
        (
            typed_counts(Some(MAX_ANSWER_BYTE_COUNT + 1), Some(1)),
            false,
        ),
        (
            typed_counts(Some(1), Some(MAX_ANSWER_CHAR_COUNT + 1)),
            false,
        ),
        (audio_counts(Some(1), None), false),
        (audio_counts(Some(2), None), true),
    ];

    for (row, (envelope, expected_valid)) in cases.into_iter().enumerate() {
        assert_eq!(
            envelope.validate_fail_closed().is_ok(),
            expected_valid,
            "row {row} disagreed: {envelope:?} validated as {:?}",
            envelope.validate_fail_closed(),
        );
    }
}

/// `duration_ms` is optional evidence, but a present duration is positive and
/// inside the 45-second turn bound.
#[test]
fn answer_duration_is_optional_positive_and_inclusively_bounded() {
    let cases = [
        (None, true),
        (Some(0), false),
        (Some(1), true),
        (Some(MAX_ANSWER_DURATION_MS), true),
        (Some(MAX_ANSWER_DURATION_MS + 1), false),
    ];

    for (duration_ms, expected_valid) in cases {
        let envelope = audio_duration(duration_ms);
        assert_eq!(
            envelope.validate_fail_closed().is_ok(),
            expected_valid,
            "duration {duration_ms:?} validated as {:?}",
            envelope.validate_fail_closed(),
        );
    }
}

/// Typed capture carries both counts. A byte count with no character count is
/// as invalid as the reverse; neither may be inferred from the other.
#[test]
fn typed_capture_requires_both_counts() {
    assert!(typed_counts(Some(42), Some(21))
        .validate_fail_closed()
        .is_ok());
    assert!(typed_counts(Some(42), None).validate_fail_closed().is_err());
    assert!(typed_counts(None, Some(21)).validate_fail_closed().is_err());
    assert!(typed_counts(None, None).validate_fail_closed().is_err());
}

/// Audio capture carries a byte count and no character count, and its PCM16
/// byte count is even. `MAX_ANSWER_BYTE_COUNT` is itself even, so the maximum
/// and the over-bound neighbour below isolate the bound from the parity rule.
#[test]
fn audio_capture_forbids_char_counts_and_requires_even_pcm16_bytes() {
    assert!(audio_counts(Some(48_000), None)
        .validate_fail_closed()
        .is_ok());
    assert!(audio_counts(Some(48_000), Some(1))
        .validate_fail_closed()
        .is_err());
    assert!(audio_counts(Some(48_000), Some(0))
        .validate_fail_closed()
        .is_err());
    assert!(audio_counts(None, None).validate_fail_closed().is_err());
    assert!(audio_counts(Some(48_001), None)
        .validate_fail_closed()
        .is_err());
    assert!(audio_counts(Some(MAX_ANSWER_BYTE_COUNT), None)
        .validate_fail_closed()
        .is_ok());
    assert!(audio_counts(Some(MAX_ANSWER_BYTE_COUNT + 2), None)
        .validate_fail_closed()
        .is_err());
}

/// `AnswerContentPolicy::DigestOnly` means exactly one durable content trace.
/// The accepted shape is 64 lowercase hexadecimal characters; the rejected
/// nearest neighbours differ from it by one character, one case change, or one
/// byte of surrounding whitespace.
#[test]
fn digest_only_accepts_exactly_one_lowercase_hex_shape() {
    assert_eq!(ANSWER_DIGEST_HMAC_HEX_LENGTH, 64);

    let digest = "0123456789abcdef".repeat(4);
    assert_eq!(digest.len(), ANSWER_DIGEST_HMAC_HEX_LENGTH);
    assert!(digest_only(Some(digest.clone()))
        .validate_fail_closed()
        .is_ok());

    let rejected = [
        digest[..63].to_owned(),
        format!("{digest}0"),
        digest.to_uppercase(),
        format!(" {}", &digest[..63]),
        format!("{}\n", &digest[..63]),
        format!("{}g", &digest[..63]),
        format!("{}\u{00e9}", &digest[..62]),
        String::new(),
    ];

    for candidate in rejected {
        assert!(
            digest_only(Some(candidate.clone()))
                .validate_fail_closed()
                .is_err(),
            "digest {candidate:?} must not be trimmed, lowercased, or padded into acceptance",
        );
    }
}

/// The converse: `AnswerContentPolicy::None` is the no-content-trace policy, so
/// even a well-formed digest is a contract violation under it.
#[test]
fn none_policy_forbids_every_digest_including_a_well_formed_one() {
    let digest = "0123456789abcdef".repeat(4);

    assert!(none_policy(None).validate_fail_closed().is_ok());
    assert!(none_policy(Some(digest)).validate_fail_closed().is_err());
}

/// The identity checks that predate this task still fail closed; bounding the
/// evidence must not have reordered them out of the contract.
#[test]
fn identity_fields_are_still_validated_first() {
    let blank_response = AnswerAttemptEnvelope {
        response_id: "   ".to_owned(),
        ..envelope(AnswerCaptureMode::Typed)
    };
    let blank_question = AnswerAttemptEnvelope {
        question_id: String::new(),
        ..envelope(AnswerCaptureMode::Typed)
    };
    let zero_sequence = AnswerAttemptEnvelope {
        submission_sequence: 0,
        ..envelope(AnswerCaptureMode::Typed)
    };
    let blank_key = AnswerAttemptEnvelope {
        idempotency_key: String::new(),
        ..envelope(AnswerCaptureMode::Typed)
    };
    let blank_state = AnswerAttemptEnvelope {
        pre_provider_state: String::new(),
        ..envelope(AnswerCaptureMode::Typed)
    };

    for envelope in [
        blank_response,
        blank_question,
        zero_sequence,
        blank_key,
        blank_state,
    ] {
        assert!(envelope.validate_fail_closed().is_err());
    }
}

proptest! {
    /// No string outside `[0-9a-f]{64}` is accepted under `DigestOnly`. The
    /// generator emits arbitrary Unicode, including control characters and
    /// multi-byte scalars, so a byte-length or case relaxation is caught here
    /// even when the boundary table above is left untouched.
    #[test]
    fn digest_only_rejects_every_string_outside_lowercase_hex_64(
        candidate in "(?s).{0,200}",
    ) {
        let is_canonical_digest = candidate.len() == ANSWER_DIGEST_HMAC_HEX_LENGTH
            && candidate
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));

        prop_assert_eq!(
            digest_only(Some(candidate.clone()))
                .validate_fail_closed()
                .is_ok(),
            is_canonical_digest,
            "digest {:?} was misclassified",
            candidate,
        );
    }

    /// The accepted half of the same predicate: every canonical digest passes.
    #[test]
    fn digest_only_accepts_every_lowercase_hex_64(candidate in "[0-9a-f]{64}") {
        prop_assert!(digest_only(Some(candidate)).validate_fail_closed().is_ok());
    }

    /// Byte counts inside the inclusive domain bound are accepted for typed
    /// capture and counts above it are rejected, with no gap at the boundary.
    #[test]
    fn typed_byte_counts_are_accepted_exactly_inside_the_domain_bound(
        byte_count in 1_u64..=(MAX_ANSWER_BYTE_COUNT + 4_096),
    ) {
        prop_assert_eq!(
            typed_counts(Some(byte_count), Some(21))
                .validate_fail_closed()
                .is_ok(),
            byte_count <= MAX_ANSWER_BYTE_COUNT,
        );
    }
}
