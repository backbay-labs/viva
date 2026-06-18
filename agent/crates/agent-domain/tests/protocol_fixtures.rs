use agent_domain::{
    fixture_source_reference, AudioFrame, BrainEvent, SessionConfig, SourceConfidence,
    SourceContext, StudyMode, ToolProposal,
};
use serde_json::json;

#[test]
fn protocol_fixtures_preserve_source_grounded_shapes() {
    let source = SourceContext {
        source_id: "source:lecture-5-slide-18".to_owned(),
        document_id: "doc:lecture-5".to_owned(),
        span: "slide=18".to_owned(),
        excerpt: "NADH donates high-energy electrons.".to_owned(),
        confidence: SourceConfidence::High,
        retrieval_reason: "direct concept overlap".to_owned(),
    };
    let proposal = ToolProposal::evaluate_spoken_answer(
        "biology-midterm",
        "voice-session-1",
        "q-oxidative-phosphorylation-nadh",
        "NADH gives electrons to the transport chain.",
    )
    .with_call_id("call-eval-1");

    assert_eq!(source.confidence, SourceConfidence::High);
    assert_eq!(proposal.name(), "evaluate_spoken_answer");
    assert_eq!(
        proposal.arguments()["answer_text"],
        "NADH gives electrons to the transport chain."
    );
}

#[test]
fn challenge_correction_carries_full_source_tuple() {
    let source = fixture_source_reference();
    let proposal = ToolProposal::challenge_correction(
        "biology-midterm",
        "voice-session-1",
        &source,
        "correction-1",
        "The slide says this differently.",
    );

    assert_eq!(proposal.arguments()["source_id"], "src-lecture-5-slide-18");
    assert_eq!(proposal.arguments()["document_id"], "lec-5");
    assert_eq!(proposal.arguments()["span"], "slide:18");
    assert_eq!(proposal.arguments()["confidence"], "high");
    assert_eq!(
        proposal.arguments()["retrieval_reason"],
        "server fixture source for oxidative phosphorylation"
    );
}

#[test]
fn shared_session_config_fixture_matches_rust_domain_types() {
    let config: SessionConfig = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .expect("shared session config fixture is valid");

    assert_eq!(config.mode, Some(StudyMode::Quiz));
    assert_eq!(config.source_context[0].confidence, SourceConfidence::High);
}

#[test]
fn audio_frame_serializes_to_base64_contract() {
    let frame = AudioFrame::from_pcm16_text("Ready.");
    let value = serde_json::to_value(&frame).expect("audio frame serializes");

    assert_eq!(value, json!({ "pcm16_base64": "UmVhZHku" }));
    let decoded: AudioFrame = serde_json::from_value(value).expect("audio frame deserializes");
    assert_eq!(decoded.pcm16_bytes(), b"Ready.");
}

#[test]
fn brain_events_carry_response_ids_for_stale_suppression() {
    let event = BrainEvent::ResponseAudio {
        response_id: "response-1".to_owned(),
        frame: AudioFrame::from_pcm16_text("hi"),
    };

    assert_eq!(event.response_id(), Some("response-1"));
}
