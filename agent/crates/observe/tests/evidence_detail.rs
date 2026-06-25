use observe::{VoiceEvidenceEvent, VoiceEvidenceEventKind};

#[test]
fn evidence_detail_redacts_raw_payload_markers() {
    let event = VoiceEvidenceEvent::new(
        VoiceEvidenceEventKind::AnswerReceived,
        None,
        "answer_text=NADH transcript_final=raw CARTESIA_API_KEY",
    );

    assert_eq!(event.detail, "redacted_evidence_detail");
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
    ] {
        let event = VoiceEvidenceEvent::new(VoiceEvidenceEventKind::AnswerReceived, None, detail);

        assert_eq!(event.detail, "redacted_evidence_detail", "{detail}");
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
