use bytes::Bytes;
use serde_json::Value;

use agent_domain::AudioFrame;

use super::constants::{
    CARTESIA_SAMPLE_RATE, DEFAULT_CARTESIA_VERSION, DEFAULT_INK_MODEL,
    DEFAULT_INK_TURNS_WEBSOCKET_URL,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InkConfig {
    pub websocket_url: String,
    pub model: String,
    pub language: String,
    pub encoding: String,
    pub sample_rate: u32,
    pub min_volume: String,
    pub max_silence_duration_secs: String,
    pub cartesia_version: String,
}

impl Default for InkConfig {
    fn default() -> Self {
        Self {
            websocket_url: DEFAULT_INK_TURNS_WEBSOCKET_URL.to_owned(),
            model: DEFAULT_INK_MODEL.to_owned(),
            language: "en".to_owned(),
            encoding: "pcm_s16le".to_owned(),
            sample_rate: CARTESIA_SAMPLE_RATE,
            min_volume: "0.05".to_owned(),
            max_silence_duration_secs: "0.7".to_owned(),
            cartesia_version: DEFAULT_CARTESIA_VERSION.to_owned(),
        }
    }
}

impl InkConfig {
    pub fn websocket_endpoint(&self) -> String {
        format!(
            "{}?model={}&language={}&encoding={}&sample_rate={}&min_volume={}&max_silence_duration_secs={}&cartesia_version={}",
            self.websocket_url,
            self.model,
            self.language,
            self.encoding,
            self.sample_rate,
            self.min_volume,
            self.max_silence_duration_secs,
            self.cartesia_version
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InkEvent {
    TurnStart,
    TurnUpdate { text: String },
    TurnEagerEnd { text: String },
    TurnResume,
    TurnEnd { text: String },
    Error { message: String },
}

pub fn audio_frame_bytes(frame: &AudioFrame) -> Bytes {
    frame.pcm16_bytes_owned()
}

pub fn parse_ink_event(text: &str) -> Option<InkEvent> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    parse_ink_value(&value)
}

pub fn parse_ink_value(value: &Value) -> Option<InkEvent> {
    let message_type = value.get("type").and_then(Value::as_str)?;
    match message_type {
        "turn.start" => Some(InkEvent::TurnStart),
        "turn.update" => transcript_text(value).map(|text| InkEvent::TurnUpdate { text }),
        "turn.eager_end" => transcript_text(value).map(|text| InkEvent::TurnEagerEnd { text }),
        "turn.resume" => Some(InkEvent::TurnResume),
        "turn.end" => transcript_text(value).map(|text| InkEvent::TurnEnd { text }),
        "transcript" => transcript_text(value).map(|text| {
            if value
                .get("is_final")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                InkEvent::TurnEnd { text }
            } else {
                InkEvent::TurnUpdate { text }
            }
        }),
        "error" => Some(InkEvent::Error {
            message: value
                .get("message")
                .or_else(|| value.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Cartesia Ink error")
                .to_owned(),
        }),
        _ => None,
    }
}

fn transcript_text(value: &Value) -> Option<String> {
    value
        .get("text")
        .or_else(|| value.get("transcript"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_turn_events() {
        assert_eq!(
            parse_ink_value(&json!({ "type": "turn.start" })),
            Some(InkEvent::TurnStart)
        );
        assert_eq!(
            parse_ink_value(&json!({ "type": "turn.update", "text": "explain NADH" })),
            Some(InkEvent::TurnUpdate {
                text: "explain NADH".to_owned()
            })
        );
        assert_eq!(
            parse_ink_value(
                &json!({ "type": "transcript", "is_final": true, "text": "ATP synthase" })
            ),
            Some(InkEvent::TurnEnd {
                text: "ATP synthase".to_owned()
            })
        );
    }

    #[test]
    fn endpoint_includes_low_latency_pcm_parameters() {
        let endpoint = InkConfig::default().websocket_endpoint();

        assert!(endpoint.starts_with("wss://api.cartesia.ai/stt/turns/websocket?"));
        assert!(endpoint.contains("model=ink-2"));
        assert!(endpoint.contains("encoding=pcm_s16le"));
        assert!(endpoint.contains("sample_rate=24000"));
    }
}
