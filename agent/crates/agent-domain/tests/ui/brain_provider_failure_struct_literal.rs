// Plan 06 Task 2 (`DOMAIN-004`): a struct literal must not be able to bypass the
// sanitizing constructor. Every name used here is exported by `agent_domain`, so
// the only thing this file can fail on is the private fields themselves.

use agent_domain::{
    BrainFailureClass, BrainFailureStage, BrainProviderFailure, TerminalSessionReason,
};

fn main() {
    let failure = BrainProviderFailure {
        failure_class: BrainFailureClass::Timeout,
        stage: BrainFailureStage::Gemini,
        terminal_reason: TerminalSessionReason::ProviderTimeout,
        retry_eligible: true,
        latency_ms: 42,
        provider: "gemini\nBearer secret-token".to_owned(),
        model: "model\u{1F525}/../../raw_prompt".to_owned(),
        metadata: "raw_prompt=<secret> bearer.token".to_owned(),
    };

    println!("{}", failure.provider());
}
