//! Plan 06 Task 5 (`DOMAIN-007`): every `AudioFrame` caches its base64 once and
//! returns it by reference.
//!
//! A realtime session serializes an audio frame on the hot path and the service
//! also reads the encoding for logging and sanitation checks. When
//! `pcm16_base64()` returned an owned `String`, a byte-built frame re-encoded the
//! whole buffer on every single access. Encoding once at construction and handing
//! out `&str` is not an optimization detail — it is the observable contract these
//! tests pin, because pointer stability is the only way a test can prove the
//! value was not recomputed.
//!
//! The second claim here is API isolation: frames come from decoded PCM16 bytes
//! or from validated base64 and from nothing else. The compile-time half of that
//! proof is `tests/ui/audio_frame_text_constructor.rs`, registered by
//! `tests/compile_fail.rs`; this file pins the runtime half — equality stays
//! decoded-byte equality, invalid base64 is rejected, and a test-only text
//! fixture helper must reject an odd byte length before it can build a frame.

use agent_domain::AudioFrame;

#[test]
fn bytes_constructor_caches_one_base64_allocation() {
    let frame = AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]);
    let first = frame.pcm16_base64();
    let first_ptr = first.as_ptr();

    assert_eq!(first, "AQIDBA==");
    assert_eq!(frame.pcm16_base64().as_ptr(), first_ptr);
    assert_eq!(
        serde_json::to_string(&frame).unwrap(),
        r#"{"pcm16_base64":"AQIDBA=="}"#
    );
    assert_eq!(frame.pcm16_base64().as_ptr(), first_ptr);
}

#[test]
fn base64_constructor_preserves_the_validated_encoding() {
    let frame = AudioFrame::from_base64("AQIDBA==").unwrap();
    assert_eq!(frame.pcm16_bytes(), &[1, 2, 3, 4]);
    assert_eq!(frame.pcm16_base64(), "AQIDBA==");
}

/// The cache survives cloning: a cloned frame shares the encoding rather than
/// re-encoding on first access.
#[test]
fn cloned_frames_share_the_cached_encoding() {
    let frame = AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]);
    let clone = frame.clone();

    assert_eq!(clone.pcm16_base64(), frame.pcm16_base64());
    assert_eq!(clone.pcm16_base64().as_ptr(), frame.pcm16_base64().as_ptr());
}

/// Serialization borrows the cached encoding, and a deserialized frame is
/// byte-identical to the one that produced it.
#[test]
fn frames_round_trip_through_the_wire_contract() {
    let frame = AudioFrame::from_pcm16_bytes(vec![0x00_u8, 0x01, 0xff, 0xfe]);
    let value = serde_json::to_value(&frame).expect("audio frame serializes");

    assert_eq!(value, serde_json::json!({ "pcm16_base64": "AAH//g==" }));

    let decoded: AudioFrame = serde_json::from_value(value).expect("audio frame deserializes");
    assert_eq!(decoded.pcm16_bytes(), &[0x00, 0x01, 0xff, 0xfe]);
    assert_eq!(decoded.pcm16_base64(), "AAH//g==");
    assert_eq!(decoded, frame);
}

/// Equality is decoded-byte equality, not encoding equality: the cached string is
/// a representation of the samples, never a second source of truth.
#[test]
fn equality_stays_decoded_byte_equality() {
    let from_bytes = AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]);
    let from_base64 = AudioFrame::from_base64("AQIDBA==").expect("valid base64 decodes");
    let other = AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 5]);

    assert_eq!(from_bytes, from_base64);
    assert_ne!(from_bytes, other);
}

/// Unknown JSON keys stay tolerated; the wire contract did not narrow.
#[test]
fn unknown_wire_fields_remain_tolerated() {
    let decoded: AudioFrame = serde_json::from_value(serde_json::json!({
        "pcm16_base64": "AQIDBA==",
        "sample_rate_hz": 24_000,
    }))
    .expect("an unknown audio frame key is ignored, not fatal");

    assert_eq!(decoded.pcm16_bytes(), &[1, 2, 3, 4]);
}

#[test]
fn invalid_base64_is_rejected_rather_than_cached() {
    let error = AudioFrame::from_base64("not base64!").expect_err("invalid base64 is rejected");

    assert!(error.starts_with("invalid base64 PCM: "), "{error}");
}

/// The exact `#[cfg(test)]` shape Plan 07 owes its adapter fixtures: a text
/// helper may exist beside a test, but it must reject an odd byte length before
/// it can reach `from_pcm16_bytes`. `from_pcm16_text` accepted "hello" and
/// produced five bytes of "PCM16"; this helper cannot.
fn fixture_audio_frame(text: &str) -> Result<AudioFrame, &'static str> {
    if !text.len().is_multiple_of(2) {
        return Err("a PCM16 fixture needs an even byte length");
    }
    Ok(AudioFrame::from_pcm16_bytes(text.as_bytes().to_vec()))
}

#[test]
fn a_test_only_text_fixture_helper_rejects_odd_byte_lengths() {
    assert_eq!(
        fixture_audio_frame("hello"),
        Err("a PCM16 fixture needs an even byte length"),
    );
    assert_eq!(
        fixture_audio_frame("hi")
            .expect("an even fixture builds")
            .pcm16_bytes(),
        b"hi",
    );
}
