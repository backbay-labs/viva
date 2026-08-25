use observe::{VoiceEvidenceEvent, VoiceEvidenceEventKind};
use serde_json::json;

/// `DATA-006`: each of these hides a forbidden marker behind one zero-width or
/// invisible code point. The ASCII filter deletes that code point, so a scan that
/// only ever saw the raw form hands back a detail in which the marker has been
/// reassembled.
const UNICODE_SPLIT_DETAILS: [&str; 3] = [
    "answer\u{200b}_text=NADH",
    "session\u{2060}_token=viva1.payload.signature",
    "source\u{feff}_excerpt_text=chapter",
];

const REDACTED: &str = "redacted_evidence_detail";

#[test]
fn evidence_detail_redacts_raw_payload_markers() {
    let event = VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::AnswerReceived,
        None,
        "answer_text=NADH transcript_final=raw CARTESIA_API_KEY",
    );

    assert_eq!(event.detail, REDACTED);
}

#[test]
fn evidence_detail_redacts_token_key_and_compound_payload_markers() {
    for detail in [
        "token=opaque-control-value",
        "controlToken=opaque-control-value",
        "APIKey=opaque-provider-value",
        "bearer.opaque-session-value",
        "rawAnswerText=plain learner content",
        "promptContent=question stem",
        "sourceExcerptText=chapter quote",
        // A quoted field name with no assignment operator. This one is why the
        // *raw* scan still has to run: the allowed-character filter deletes the
        // quotes, so the filtered form is a bare word the field-assignment
        // detector cannot recognise.
        r#"{"token"} appeared in a frame"#,
    ] {
        let event = VoiceEvidenceEvent::new(VoiceEvidenceEventKind::AnswerReceived, None, detail);

        assert_eq!(event.detail, REDACTED, "{detail}");
    }
}

#[test]
fn evidence_detail_preserves_invalid_session_terminal_reason() {
    let event = VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::TerminalReason,
        None,
        "invalid_session_token",
    );

    assert_eq!(event.detail, "invalid_session_token");
}

#[test]
fn evidence_detail_keeps_default_event_cap() {
    let detail = "a".repeat(300);
    let event = VoiceEvidenceEvent::new(VoiceEvidenceEventKind::AnswerReceived, None, detail);

    assert_eq!(event.detail.len(), 240);
}

#[test]
fn provider_stage_failure_uses_extended_detail_cap() {
    let detail = "a".repeat(300);
    let event = VoiceEvidenceEvent::new(VoiceEvidenceEventKind::ProviderStageFailure, None, detail);

    assert_eq!(event.detail.len(), 300);
}

/// `DATA-006`: the filter and the scan must agree on one string.
#[test]
fn unicode_split_forbidden_marker_is_redacted_after_filtering() {
    for detail in UNICODE_SPLIT_DETAILS {
        let event = VoiceEvidenceEvent::new(VoiceEvidenceEventKind::AnswerReceived, None, detail);

        assert_eq!(
            event.detail, REDACTED,
            "a marker split by an invisible code point is still a marker: {detail:?}"
        );
        // The point of the redaction is that nothing survives it, not that the
        // string changed shape.
        assert!(!event.detail.contains("NADH"));
        assert!(!event.detail.contains("viva1."));
        assert!(!event.detail.contains("chapter"));
    }
}

/// `DATA-007`: `VoiceEvidenceEvent::new` is not the only way a value of this type
/// comes into existence. Deserialization is the other one, and it must go through
/// the same constructor rather than filling the field directly.
#[test]
fn voice_evidence_event_deserialize_sanitizes_detail() {
    for detail in UNICODE_SPLIT_DETAILS {
        let event: VoiceEvidenceEvent = serde_json::from_value(json!({
            "kind": "answer_received",
            "voice_session_id": null,
            "detail": detail,
        }))
        .expect("the wire shape still deserializes");

        assert_eq!(
            event.detail, REDACTED,
            "deserialization must not bypass the kind-aware constructor: {detail:?}"
        );
    }

    // A plainly forbidden detail, with no Unicode trick at all, through the same
    // path — deserialization is not a second, weaker policy.
    let event: VoiceEvidenceEvent = serde_json::from_value(json!({
        "kind": "answer_received",
        "voice_session_id": "voice-session-1",
        "detail": "answer_text=NADH transcript_final=raw",
    }))
    .expect("the wire shape still deserializes");
    assert_eq!(event.detail, REDACTED);
    assert_eq!(event.voice_session_id.as_deref(), Some("voice-session-1"));

    // And a safe detail is filtered, not destroyed.
    let event: VoiceEvidenceEvent = serde_json::from_value(json!({
        "kind": "terminal_reason",
        "voice_session_id": null,
        "detail": "invalid_session_token",
    }))
    .expect("the wire shape still deserializes");
    assert_eq!(event.detail, "invalid_session_token");
}

/// `DATA-007`: the serialized shape is unchanged, and a round trip cannot smuggle
/// the original text back in.
#[test]
fn voice_evidence_event_round_trip_preserves_only_sanitized_detail() {
    let event = VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::AnswerReceived,
        Some("voice-session-1".to_owned()),
        "answer\u{200b}_text=NADH",
    );

    let encoded = serde_json::to_string(&event).expect("the event serializes");
    // Byte-exact: same three field names, same order, and `detail` is still a
    // plain JSON string rather than a nested object the newtype could have
    // introduced.
    assert_eq!(
        encoded,
        r#"{"kind":"answer_received","voice_session_id":"voice-session-1","detail":"redacted_evidence_detail"}"#
    );
    assert!(!encoded.contains("NADH"), "{encoded}");
    assert!(!encoded.contains('\u{200b}'), "{encoded}");

    let decoded: VoiceEvidenceEvent =
        serde_json::from_str(&encoded).expect("the event deserializes");
    assert_eq!(decoded, event);

    let value: serde_json::Value = serde_json::from_str(&encoded).expect("valid JSON");
    let object = value.as_object().expect("an object");
    let mut keys = object.keys().collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(keys, vec!["detail", "kind", "voice_session_id"]);
    assert!(object["detail"].is_string());
}

/// `DATA-007`: the cap is part of the constructor, so it applies on the
/// deserialization path too — including the kind that gets the larger one.
#[test]
fn provider_stage_failure_deserialize_keeps_kind_specific_cap() {
    let event: VoiceEvidenceEvent = serde_json::from_value(json!({
        "kind": "provider_stage_failure",
        "voice_session_id": null,
        "detail": "a".repeat(500),
    }))
    .expect("the wire shape still deserializes");
    assert_eq!(event.detail.len(), 384);

    let event: VoiceEvidenceEvent = serde_json::from_value(json!({
        "kind": "answer_received",
        "voice_session_id": null,
        "detail": "a".repeat(500),
    }))
    .expect("the wire shape still deserializes");
    assert_eq!(event.detail.len(), 240);

    // The cap is applied *after* both scans. A marker that sits past the cap is
    // still a marker; truncating first would drop it out of view and emit the
    // 240 characters in front of it as if the detail had been clean.
    let event: VoiceEvidenceEvent = serde_json::from_value(json!({
        "kind": "answer_received",
        "voice_session_id": null,
        "detail": format!("{}answer\u{200b}_text=NADH", "a".repeat(300)),
    }))
    .expect("the wire shape still deserializes");
    assert_eq!(event.detail, REDACTED);
}

/// `DATA-007`: every read-only shape the existing consumers use against
/// `event.detail`, exercised here so the API change is proven rather than assumed.
///
/// `agent-service` and `agent-adapters` cannot be compiled on this branch — 141
/// pre-existing errors in `agent-adapters` (which does not depend on `observe`)
/// stop the build before `agent-service`'s own code is type-checked — so the
/// downstream compile the plan asks for cannot run here. These are the exact call
/// shapes counted in `agent/crates/**`: `.contains` (76), `== "literal"` /
/// `!= "literal"` (36), a `&event.detail` binding (2), `.len()` (2), and
/// `.as_str()` (2). If any of them stopped compiling, this file would stop
/// compiling.
#[test]
fn sanitized_detail_supports_every_read_only_consumer_shape() {
    let event = VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ProviderStageFailure,
        Some("voice-session-1".to_owned()),
        "stage=recap latency_ms=37",
    );

    assert!(event.detail.contains("stage=recap"));
    assert_eq!(event.detail, "stage=recap latency_ms=37");
    assert!(event.detail != "durability_degraded");
    assert_eq!(event.detail.len(), 25);
    assert_eq!(event.detail.as_str(), "stage=recap latency_ms=37");

    let detail = &event.detail;
    assert!(detail.contains("latency_ms=37"));

    // The other directions consumers can write an equality in.
    assert!("stage=recap latency_ms=37" == event.detail);
    assert_eq!(event.detail, "stage=recap latency_ms=37".to_owned());
    let borrowed: &str = event.detail.as_ref();
    assert_eq!(borrowed, "stage=recap latency_ms=37");
    assert_eq!(event.detail.to_string(), "stage=recap latency_ms=37");
}

/// `DATA-006` control: scanning the filtered form must not turn ordinary
/// non-ASCII punctuation into a false redaction. This detail has no forbidden
/// marker in either form, and removing the punctuation does not create one.
#[test]
fn safe_unicode_filter_positive_control_is_not_redacted() {
    let event = VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::ProviderStageFailure,
        None,
        "stage=recap \u{2014} evaluated 3 concepts \u{2026} latency_ms=37",
    );

    assert_eq!(
        event.detail,
        "stage=recap  evaluated 3 concepts  latency_ms=37"
    );

    // Same control through the deserialization path.
    let decoded: VoiceEvidenceEvent = serde_json::from_value(json!({
        "kind": "provider_stage_failure",
        "voice_session_id": null,
        "detail": "stage=recap \u{2014} evaluated 3 concepts \u{2026} latency_ms=37",
    }))
    .expect("the wire shape still deserializes");
    assert_eq!(decoded.detail, event.detail);
}
