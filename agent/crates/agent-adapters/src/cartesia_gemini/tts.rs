use serde_json::{json, Value};

use super::constants::{
    CARTESIA_SAMPLE_RATE, DEFAULT_CARTESIA_VERSION, DEFAULT_SONIC_MODEL, DEFAULT_SONIC_VOICE_ID,
    DEFAULT_SONIC_WEBSOCKET_URL,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SonicConfig {
    pub websocket_url: String,
    pub model_id: String,
    pub voice_id: String,
    pub language: String,
    pub sample_rate: u32,
    pub cartesia_version: String,
    pub max_buffer_delay_ms: u32,
}

impl Default for SonicConfig {
    fn default() -> Self {
        Self {
            websocket_url: DEFAULT_SONIC_WEBSOCKET_URL.to_owned(),
            model_id: DEFAULT_SONIC_MODEL.to_owned(),
            voice_id: DEFAULT_SONIC_VOICE_ID.to_owned(),
            language: "en".to_owned(),
            sample_rate: CARTESIA_SAMPLE_RATE,
            cartesia_version: DEFAULT_CARTESIA_VERSION.to_owned(),
            max_buffer_delay_ms: 0,
        }
    }
}

impl SonicConfig {
    pub fn websocket_endpoint(&self) -> String {
        format!(
            "{}?cartesia_version={}",
            self.websocket_url, self.cartesia_version
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SonicEvent {
    Audio {
        context_id: String,
        pcm16_base64: String,
    },
    Done {
        context_id: String,
    },
    FlushDone {
        context_id: String,
    },
    Error {
        context_id: Option<String>,
        message: String,
    },
}

pub fn sonic_generation_request(
    config: &SonicConfig,
    context_id: &str,
    transcript: &str,
    continue_context: bool,
) -> Value {
    json!({
        "model_id": config.model_id,
        "transcript": transcript,
        "voice": {
            "mode": "id",
            "id": config.voice_id,
        },
        "language": config.language,
        "context_id": context_id,
        "output_format": {
            "container": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": config.sample_rate,
        },
        "continue": continue_context,
        "max_buffer_delay_ms": config.max_buffer_delay_ms,
    })
}

pub fn sonic_cancel_request(context_id: &str) -> Value {
    json!({
        "context_id": context_id,
        "cancel": true,
    })
}

pub fn parse_sonic_event(text: &str) -> Option<SonicEvent> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    parse_sonic_value(&value)
}

pub fn parse_sonic_value(value: &Value) -> Option<SonicEvent> {
    let message_type = value.get("type").and_then(Value::as_str)?;
    match message_type {
        "chunk" => Some(SonicEvent::Audio {
            context_id: context_id(value)?.to_owned(),
            pcm16_base64: value.get("data")?.as_str()?.to_owned(),
        }),
        "done" => Some(SonicEvent::Done {
            context_id: context_id(value)?.to_owned(),
        }),
        "flush_done" => Some(SonicEvent::FlushDone {
            context_id: context_id(value)?.to_owned(),
        }),
        "error" => Some(SonicEvent::Error {
            context_id: context_id(value).map(ToOwned::to_owned),
            message: value
                .get("message")
                .or_else(|| value.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Cartesia Sonic error")
                .to_owned(),
        }),
        _ => None,
    }
}

fn context_id(value: &Value) -> Option<&str> {
    value.get("context_id").and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn builds_streaming_generation_and_cancel_requests() {
        let config = SonicConfig::default();
        let delta = sonic_generation_request(&config, "ctx-1", "Explain ", true);

        assert_eq!(delta["model_id"], "sonic-3.5");
        assert_eq!(delta["context_id"], "ctx-1");
        assert_eq!(delta["transcript"], "Explain ");
        assert_eq!(delta["continue"], true);
        assert_eq!(
            delta["output_format"],
            json!({
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": 24000
            })
        );
        assert_eq!(
            sonic_cancel_request("ctx-1"),
            json!({ "context_id": "ctx-1", "cancel": true })
        );
    }

    #[test]
    fn parses_audio_done_and_error_events() {
        assert_eq!(
            parse_sonic_value(&json!({ "type": "chunk", "context_id": "ctx-1", "data": "AAAA" })),
            Some(SonicEvent::Audio {
                context_id: "ctx-1".to_owned(),
                pcm16_base64: "AAAA".to_owned()
            })
        );
        assert_eq!(
            parse_sonic_value(&json!({ "type": "done", "context_id": "ctx-1" })),
            Some(SonicEvent::Done {
                context_id: "ctx-1".to_owned()
            })
        );
    }
}
