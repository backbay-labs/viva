use async_trait::async_trait;

use agent_domain::{RealtimeBrain, RealtimeBrainCapabilities};

#[derive(Clone, Debug, Default)]
pub struct NoopRealtimeBrain;

#[async_trait]
impl RealtimeBrain for NoopRealtimeBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "noop".to_owned(),
            configured: false,
            selectable: false,
            live_runtime: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use agent_domain::{BrainInput, SessionConfig};

    use super::*;

    #[tokio::test]
    async fn opens_without_provider_keys_or_events() {
        let session = NoopRealtimeBrain
            .open(SessionConfig::default())
            .await
            .unwrap();

        assert!(session.input.send(BrainInput::Stop).await.is_ok());
    }
}
