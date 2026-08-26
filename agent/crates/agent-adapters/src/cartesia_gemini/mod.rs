pub mod constants;
pub mod llm;
mod runner;
pub mod stt;
pub mod tts;

use std::{
    env, fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use serde_json::json;
use serde_json::Value;
use tokio::sync::mpsc;

use agent_domain::{
    learning_outcome::{VIVA_TURN_OUTCOME_RECORD_SCHEMA, VIVA_TURN_OUTCOME_SCHEMA},
    tool_executor::VIVA_STUDY_MODE,
    AnswerEvaluation, AudioFrame, AuthorizedStudySession, BrainError, BrainEvent,
    BrainFailureClass, BrainFailureStage, BrainInput, BrainProviderError, BrainProviderFailure,
    BrainProviderFailureParts, BrainUsage, EvaluationLabel, PersistedTurnOutcome,
    QuestionProgressionResult, RealtimeBrain, RealtimeBrainCapabilities, RealtimeSession,
    RealtimeSessionTaskGuard, SessionConfig, StudyMemoryStore, StudyQuestion, StudySessionPhase,
    StudySessionRecap, StudySessionState, StudySourceReference, ToolProposal, TurnOutcome,
    TurnResolution, VivaToolExecutor,
};

pub use llm::{
    gemini_request, parse_gemini_sse_line, viva_tool_declarations, GeminiConfig, GeminiStreamEvent,
    ThinkingLevel,
};
pub use stt::{audio_frame_bytes, parse_ink_event, InkConfig, InkEvent};
pub use tts::{parse_sonic_event, sonic_generation_request, SonicConfig, SonicEvent};

use runner::{
    answer_attempt_envelope, CartesiaGeminiRunner, FakeCartesiaGeminiTransports,
    LiveCartesiaGeminiTransports, RunnerInput,
};

pub(crate) const FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT: &str =
    "NADH donates electrons to the electron transport chain.";
pub(crate) const MAX_GEMINI_TOOL_LOOP_PASSES: u32 = 2;
pub(crate) const MAX_GEMINI_EXECUTED_TOOL_STAGES: u32 = 5;
pub(crate) const DETERMINISTIC_STUDY_TOOL_STAGES: u32 = 3;

// ---------------------------------------------------------------------------
// `ADAPTER-01` shared seam: typed failures, the Plan 06 phase machine, and the
// one projection from a persisted Plan 04 outcome to learner-visible events.
//
// Everything below is consumed by both the Cartesia/Gemini runner and the
// synthetic runtime, so neither can grow a second, divergent copy of the rule.
// ---------------------------------------------------------------------------

/// Every adapter failure is a classified failure; there is no untyped path.
pub(crate) fn brain_failure(parts: BrainProviderFailureParts) -> BrainError {
    BrainError::from_failure(BrainProviderFailure::new(parts))
}

/// Re-stamp a source-constructed failure with the elapsed stage latency.
///
/// The transport that observed the status classifies it, but only the caller
/// that started the stage knows how long it took. Fields are private, so the
/// latency is applied by rebuilding the failure from its own accessors; a
/// failure that already carries a latency is returned untouched.
pub(crate) fn failure_with_latency(error: BrainError, latency: Duration) -> BrainError {
    let failure = error.failure();
    if failure.latency_ms() != 0 {
        return error;
    }
    brain_failure(BrainProviderFailureParts {
        failure_class: failure.failure_class(),
        stage: failure.stage(),
        retry_eligible: failure.retry_eligible(),
        latency_ms: duration_ms(latency),
        provider: failure.provider().to_owned(),
        model: failure.model().to_owned(),
        metadata: failure.metadata().to_owned(),
    })
}

pub(crate) fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

/// The session's phase, driven only through Plan 06's one legal-transition
/// table.
///
/// A raw `SessionPhase` send cannot exist behind this type: every emission is a
/// transition the domain accepted, and a rejected transition becomes a typed
/// domain failure *before* any event is produced.
#[derive(Clone)]
pub(crate) struct SessionPhaseTracker {
    state: Arc<Mutex<StudySessionState>>,
}

impl SessionPhaseTracker {
    pub(crate) fn ready() -> Self {
        Self {
            state: Arc::new(Mutex::new(StudySessionState::ready())),
        }
    }

    /// Enter `listening` for a newly accepted turn.
    ///
    /// A fresh or completed turn moves forward through the legal table; a turn
    /// that replaced one still in flight uses the machine's one explicit
    /// backward motion, which is exactly what a barge-in is. Neither path
    /// invents a transition the domain does not allow.
    pub(crate) fn begin_turn(&self) -> Result<BrainEvent, BrainError> {
        let mut state = self.state.lock().map_err(|_| phase_machine_failure())?;
        let phase = if state
            .phase()
            .can_transition_to(StudySessionPhase::Listening)
        {
            state.transition(StudySessionPhase::Listening)
        } else {
            state.restart_after_cancellation()
        }
        .map_err(|_| phase_machine_failure())?;
        Ok(BrainEvent::SessionPhase { phase })
    }

    pub(crate) fn phase_event(&self, to: StudySessionPhase) -> Result<BrainEvent, BrainError> {
        let mut state = self.state.lock().map_err(|_| phase_machine_failure())?;
        state
            .transition(to)
            .map(|phase| BrainEvent::SessionPhase { phase })
            .map_err(|_| phase_machine_failure())
    }

    /// The one deliberately permissive reader: session teardown claims the recap
    /// phase only when the session actually reached a phase that leads there. A
    /// session that never took a turn simply never claims it, which is not a
    /// rejected emission but an emission that is never attempted.
    pub(crate) fn phase_event_if_legal(&self, to: StudySessionPhase) -> Option<BrainEvent> {
        let mut state = self.state.lock().ok()?;
        state
            .transition(to)
            .ok()
            .map(|phase| BrainEvent::SessionPhase { phase })
    }

    #[cfg(test)]
    pub(crate) fn phase(&self) -> StudySessionPhase {
        self.state.lock().expect("phase lock poisoned").phase()
    }
}

fn phase_machine_failure() -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class: BrainFailureClass::ToolExecutorFailure,
        stage: BrainFailureStage::Session,
        retry_eligible: false,
        latency_ms: 0,
        provider: "server".to_owned(),
        model: "viva-session".to_owned(),
        metadata: "error_kind=illegal_phase_transition".to_owned(),
    })
}

fn outcome_contract_failure(error_kind: &'static str) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class: BrainFailureClass::ToolExecutorFailure,
        stage: BrainFailureStage::Tools,
        retry_eligible: false,
        latency_ms: 0,
        provider: "server".to_owned(),
        model: "viva-tools".to_owned(),
        metadata: format!("error_kind={error_kind}"),
    })
}

/// Deserialize the Plan 04 executor's `evaluate_spoken_answer` payload.
///
/// The wrapper has exactly two members and the adapter reads exactly one of
/// them: `record` is checked for its schema and for naming this very response,
/// and is then never consulted for a learner fact. Validation happens before any
/// event, transition, disposition, schedule, or recap exists.
pub(crate) fn parse_persisted_turn_outcome(
    result: &Value,
    response_id: &str,
) -> Result<TurnOutcome, BrainError> {
    let persisted: PersistedTurnOutcome = serde_json::from_value(result.clone())
        .map_err(|_| outcome_contract_failure("persisted_turn_outcome_malformed"))?;
    if persisted.record.schema != VIVA_TURN_OUTCOME_RECORD_SCHEMA {
        return Err(outcome_contract_failure("turn_outcome_receipt_schema"));
    }
    if persisted.turn_outcome.schema != VIVA_TURN_OUTCOME_SCHEMA {
        return Err(outcome_contract_failure("turn_outcome_schema"));
    }
    if persisted.record.response_id != persisted.turn_outcome.response_id {
        return Err(outcome_contract_failure("turn_outcome_receipt_response_id"));
    }
    if persisted.turn_outcome.response_id != response_id {
        return Err(outcome_contract_failure("turn_outcome_response_id"));
    }
    Ok(persisted.turn_outcome)
}

/// The v2 recap the Plan 04 executor folded from persisted evidence.
pub(crate) fn recap_from_tool_result(result: &Value) -> Result<StudySessionRecap, BrainError> {
    serde_json::from_value(
        result
            .get("recap")
            .cloned()
            .ok_or_else(|| outcome_contract_failure("recap_payload_missing"))?,
    )
    .map_err(|_| outcome_contract_failure("recap_payload_malformed"))
}

/// The exact rubric wire token for a server-derived label. The adapter maps, it
/// never chooses: every arm is a `EvaluationLabel` the executor already decided.
pub(crate) fn evaluation_label_wire(label: EvaluationLabel) -> &'static str {
    match label {
        EvaluationLabel::Strong => "strong",
        EvaluationLabel::MostlyCorrect => "mostly correct",
        EvaluationLabel::PartiallyCorrect => "partially correct",
        EvaluationLabel::Vague => "vague",
        EvaluationLabel::Wrong => "wrong",
        EvaluationLabel::InsufficientEvidence => "insufficient evidence",
    }
}

/// Project a persisted evaluated outcome into the browser's evaluation payload.
///
/// Every graded field is copied from the outcome. `answer_text` is the
/// transcript this turn actually carried — a transport fact, never a grade — and
/// the source is the one the executor re-retrieved for a rubric-authorized id.
///
/// The learner-visible mastery value is the one the executor persisted for this
/// turn's own concept, or failing that the first concept the outcome names. An
/// evaluated outcome that names no concept at all has no honest status to show,
/// so it is a typed contract failure rather than an adapter-chosen default —
/// this is the last place an adapter could have picked a mastery value, and it
/// does not.
pub(crate) fn answer_evaluation_from_outcome(
    outcome: &TurnOutcome,
    answer_text: &str,
    source: &StudySourceReference,
    question: &StudyQuestion,
) -> Result<Option<AnswerEvaluation>, BrainError> {
    let TurnResolution::Evaluated {
        label,
        confidence,
        concept_transitions,
        concise_feedback,
        retry_prompt,
        ..
    } = &outcome.resolution
    else {
        return Ok(None);
    };
    let concept_status = concept_transitions
        .iter()
        .find(|transition| transition.concept_id == question.concept_id)
        .or_else(|| concept_transitions.first())
        .ok_or_else(|| outcome_contract_failure("turn_outcome_without_concept_transition"))?
        .to_status
        .clone();
    Ok(Some(AnswerEvaluation {
        question_id: outcome.question_id.clone(),
        answer_text: answer_text.to_owned(),
        label: evaluation_label_wire(*label).to_owned(),
        concise_feedback: concise_feedback.clone(),
        retry_prompt: retry_prompt.clone().unwrap_or_default(),
        source: source.clone(),
        concept_status,
        confidence_score: *confidence,
    }))
}

/// The complete set of learner-visible events one persisted outcome authorizes.
///
/// An evaluated outcome yields its source, its evaluation, and one
/// `ConceptStatus` per persisted transition, in persisted order. A deferred
/// outcome yields exactly one `TurnDeferred` carrying only Plan 04's four fields
/// — no feedback, no confidence, no status, no schedule, no recap.
pub(crate) fn learning_event_projection(
    outcome: &TurnOutcome,
    response_id: &str,
    source: &StudySourceReference,
    evaluation: Option<AnswerEvaluation>,
) -> Vec<BrainEvent> {
    match &outcome.resolution {
        TurnResolution::Evaluated {
            concept_transitions,
            ..
        } => {
            let mut events = vec![BrainEvent::SourceReference {
                response_id: response_id.to_owned(),
                source: source.clone(),
            }];
            if let Some(evaluation) = evaluation {
                events.push(BrainEvent::AnswerEvaluated {
                    response_id: response_id.to_owned(),
                    evaluation,
                });
            }
            events.extend(
                concept_transitions
                    .iter()
                    .map(|transition| BrainEvent::ConceptStatus {
                        response_id: response_id.to_owned(),
                        concept_id: transition.concept_id.clone(),
                        status: transition.to_status.clone(),
                    }),
            );
            events
        }
        TurnResolution::Deferred {
            reason,
            can_retry_same_question,
            ..
        } => vec![BrainEvent::TurnDeferred {
            response_id: response_id.to_owned(),
            question_id: outcome.question_id.clone(),
            reason: reason.clone(),
            can_retry_same_question: *can_retry_same_question,
        }],
    }
}

/// This session's authorized question for one response, from the D-02B cursor.
///
/// The selection is idempotent per response, so a turn always asks for its own
/// question rather than reusing a cached one the cursor may already have moved
/// past. An exhausted session carries no question and is never filled in with a
/// fixture one.
pub(crate) async fn select_session_question(
    executor: &VivaToolExecutor,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
) -> Result<StudyQuestion, BrainError> {
    let result = executor
        .execute(
            response_id,
            ToolProposal::select_next_question(study_set_id, voice_session_id, VIVA_STUDY_MODE),
        )
        .await
        .map_err(|_| outcome_contract_failure("select_next_question_failed"))?;
    let progression: QuestionProgressionResult =
        serde_json::from_value(result.result["progression"].clone())
            .map_err(|_| outcome_contract_failure("question_progression_malformed"))?;
    match progression {
        QuestionProgressionResult::Selected { question, .. }
        | QuestionProgressionResult::Retry { question, .. } => Ok(question),
        QuestionProgressionResult::Exhausted { .. } => {
            Err(outcome_contract_failure("question_progression_exhausted"))
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct CartesiaGeminiConfig {
    pub cartesia_api_key: String,
    pub gemini: GeminiConfig,
    pub ink: InkConfig,
    pub sonic: SonicConfig,
    pub tool_stage_timeout: Duration,
    pub recap_stage_timeout: Duration,
    pub live_runtime_enabled: bool,
    pub cartesia_zero_data_retention_enabled: bool,
    pub gemini_zero_data_retention_approved: bool,
    pub tools: Vec<serde_json::Value>,
}

impl fmt::Debug for CartesiaGeminiConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CartesiaGeminiConfig")
            .field("cartesia_api_key", &"<redacted>")
            .field("gemini", &self.gemini)
            .field("ink", &self.ink)
            .field("sonic", &self.sonic)
            .field("tool_stage_timeout", &self.tool_stage_timeout)
            .field("recap_stage_timeout", &self.recap_stage_timeout)
            .field("live_runtime_enabled", &self.live_runtime_enabled)
            .field(
                "cartesia_zero_data_retention_enabled",
                &self.cartesia_zero_data_retention_enabled,
            )
            .field(
                "gemini_zero_data_retention_approved",
                &self.gemini_zero_data_retention_approved,
            )
            .field("tool_count", &self.tools.len())
            .finish()
    }
}

impl Default for CartesiaGeminiConfig {
    fn default() -> Self {
        Self {
            cartesia_api_key: String::new(),
            gemini: GeminiConfig::default(),
            ink: InkConfig::default(),
            sonic: SonicConfig::default(),
            tool_stage_timeout: Duration::from_secs(2),
            recap_stage_timeout: Duration::from_secs(2),
            live_runtime_enabled: false,
            cartesia_zero_data_retention_enabled: false,
            gemini_zero_data_retention_approved: false,
            tools: viva_tool_declarations(),
        }
    }
}

impl CartesiaGeminiConfig {
    pub fn from_env() -> Self {
        Self::from_env_with(env_value)
    }

    fn from_env_with(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let env_value = |name: &str| {
            lookup(name)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let mut config = Self {
            cartesia_api_key: env_value("CARTESIA_API_KEY").unwrap_or_default(),
            gemini: GeminiConfig {
                api_key: env_value("GEMINI_API_KEY").unwrap_or_default(),
                ..GeminiConfig::default()
            },
            ..Self::default()
        };
        config.live_runtime_enabled =
            env_value("VIVA_CARTESIA_GEMINI_LIVE_RUNTIME").as_deref() == Some("1");
        config.cartesia_zero_data_retention_enabled =
            env_value("CARTESIA_ZERO_DATA_RETENTION_ENABLED").as_deref() == Some("1");
        config.gemini_zero_data_retention_approved =
            env_value("GEMINI_ZERO_DATA_RETENTION_APPROVED").as_deref() == Some("1");
        if let Some(model) =
            env_value("GEMINI_MODEL").or_else(|| env_value("GEMINI_REALTIME_MODEL"))
        {
            config.gemini.model_id = model;
        }
        if let Some(fallback_models) =
            env_value("GEMINI_FALLBACK_MODELS").or_else(|| env_value("GEMINI_FALLBACK_MODEL"))
        {
            config.gemini.fallback_model_ids =
                parse_gemini_fallback_models(&fallback_models, &config.gemini.model_id);
        }
        if let Some(base_url) = env_value("GEMINI_BASE_URL") {
            config.gemini.base_url = base_url;
        }
        if let Some(thinking_level) = env_value("GEMINI_THINKING_LEVEL") {
            config.gemini.thinking_level = ThinkingLevel::parse(thinking_level);
        }
        if let Some(websocket_url) = env_value("CARTESIA_INK_WEBSOCKET_URL") {
            config.ink.websocket_url = websocket_url;
        }
        if let Some(model) = env_value("CARTESIA_INK_MODEL") {
            config.ink.model = model;
        }
        if let Some(language) = env_value("CARTESIA_INK_LANGUAGE") {
            config.ink.language = language;
        }
        if let Some(encoding) = env_value("CARTESIA_INK_ENCODING") {
            config.ink.encoding = encoding;
        }
        if let Some(sample_rate) = env_value("CARTESIA_INK_SAMPLE_RATE")
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|sample_rate| *sample_rate > 0)
        {
            config.ink.sample_rate = sample_rate;
        }
        if let Some(min_volume) = env_value("CARTESIA_INK_MIN_VOLUME") {
            config.ink.min_volume = min_volume;
        }
        if let Some(max_silence_duration_secs) = env_value("CARTESIA_INK_MAX_SILENCE_DURATION_SECS")
        {
            config.ink.max_silence_duration_secs = max_silence_duration_secs;
        }
        if let Some(cartesia_version) =
            env_value("CARTESIA_VERSION").or_else(|| env_value("CARTESIA_INK_VERSION"))
        {
            config.ink.cartesia_version = cartesia_version;
        }
        if let Some(websocket_url) = env_value("CARTESIA_SONIC_WEBSOCKET_URL") {
            config.sonic.websocket_url = websocket_url;
        }
        if let Some(model) = env_value("CARTESIA_SONIC_MODEL") {
            config.sonic.model_id = model;
        }
        if let Some(voice_id) =
            env_value("CARTESIA_VOICE_ID").or_else(|| env_value("CARTESIA_SONIC_VOICE_ID"))
        {
            config.sonic.voice_id = voice_id;
        }
        if let Some(language) = env_value("CARTESIA_SONIC_LANGUAGE") {
            config.sonic.language = language;
        }
        if let Some(sample_rate) = env_value("CARTESIA_SONIC_SAMPLE_RATE")
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|sample_rate| *sample_rate > 0)
        {
            config.sonic.sample_rate = sample_rate;
        }
        if let Some(max_buffer_delay_ms) = env_value("CARTESIA_SONIC_MAX_BUFFER_DELAY_MS")
            .and_then(|value| value.parse::<u32>().ok())
        {
            config.sonic.max_buffer_delay_ms = max_buffer_delay_ms;
        }
        if let Some(cartesia_version) =
            env_value("CARTESIA_VERSION").or_else(|| env_value("CARTESIA_SONIC_VERSION"))
        {
            config.sonic.cartesia_version = cartesia_version;
        }
        config
    }

    pub fn missing_live_keys(&self) -> bool {
        self.cartesia_api_key.trim().is_empty() || self.gemini.api_key.trim().is_empty()
    }

    pub fn selectable_live_keys(&self) -> bool {
        !self.missing_live_keys()
            && !is_placeholder_live_key(&self.cartesia_api_key)
            && !is_placeholder_live_key(&self.gemini.api_key)
    }

    pub fn provider_zero_data_retention_confirmed(&self) -> bool {
        self.cartesia_zero_data_retention_enabled && self.gemini_zero_data_retention_approved
    }

    pub fn live_runtime_selectable(&self) -> bool {
        self.live_runtime_enabled
            && self.selectable_live_keys()
            && self.provider_zero_data_retention_confirmed()
    }

    pub fn total_live_stage_deadline(&self) -> Duration {
        [
            self.ink.stage_timeout,
            self.gemini
                .stage_timeout
                .saturating_mul(MAX_GEMINI_TOOL_LOOP_PASSES),
            self.tool_stage_timeout.saturating_mul(
                MAX_GEMINI_EXECUTED_TOOL_STAGES.saturating_add(DETERMINISTIC_STUDY_TOOL_STAGES),
            ),
            self.sonic.stage_timeout,
            self.recap_stage_timeout,
        ]
        .into_iter()
        .fold(Duration::ZERO, |total, duration| {
            total.saturating_add(duration)
        })
    }
}

#[derive(Clone, Debug)]
pub struct CartesiaGeminiBrain {
    config: CartesiaGeminiConfig,
    runner: CartesiaGeminiRunner<LiveCartesiaGeminiTransports>,
}

impl CartesiaGeminiBrain {
    pub fn new(config: CartesiaGeminiConfig, store: Arc<dyn StudyMemoryStore>) -> Self {
        Self {
            runner: CartesiaGeminiRunner::live(store, config.clone()),
            config,
        }
    }

    pub fn config(&self) -> &CartesiaGeminiConfig {
        &self.config
    }
}

#[async_trait]
impl RealtimeBrain for CartesiaGeminiBrain {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        let selectable = self.config.live_runtime_selectable();
        RealtimeBrainCapabilities {
            provider: "cartesia_gemini".to_owned(),
            configured: !self.config.missing_live_keys(),
            selectable,
            live_runtime: selectable,
        }
    }

    async fn open(&self, _config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        // A credential problem is a provider-auth failure at the auth stage and
        // is never retried as a transport blip; a gate that was never opened is
        // an operator configuration fact, not a provider one.
        if self.config.missing_live_keys() {
            return Err(live_open_refusal(
                BrainFailureClass::ProviderAuthFailure,
                BrainFailureStage::ProviderAuth,
                "error_kind=missing_api_key",
            ));
        }
        if !self.config.selectable_live_keys() {
            return Err(live_open_refusal(
                BrainFailureClass::ProviderAuthFailure,
                BrainFailureStage::ProviderAuth,
                "error_kind=placeholder_credentials",
            ));
        }
        if !self.config.provider_zero_data_retention_confirmed() {
            return Err(live_open_refusal(
                BrainFailureClass::ProviderAuthFailure,
                BrainFailureStage::Startup,
                "error_kind=zero_data_retention_unconfirmed",
            ));
        }

        self.runner.open(_config).await
    }
}

fn live_open_refusal(
    failure_class: BrainFailureClass,
    stage: BrainFailureStage,
    metadata: &'static str,
) -> BrainError {
    brain_failure(BrainProviderFailureParts {
        failure_class,
        stage,
        retry_eligible: false,
        latency_ms: 0,
        provider: "cartesia_gemini".to_owned(),
        model: "cartesia_gemini".to_owned(),
        metadata: metadata.to_owned(),
    })
}

#[derive(Clone)]
pub struct FakeCartesiaGeminiRuntime {
    runner: CartesiaGeminiRunner<FakeCartesiaGeminiTransports>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakeRuntimeInterrupt {
    None,
    CancelDuringGeminiToolCall,
    BargeInDuringSonicAudio,
    WriterFailureBeforeSonicAudio,
    MalformedGeminiManuscriptIntent,
    UnauthorizedGeminiManuscriptIntent,
    NoGeminiManuscriptIntent,
    GeminiToolCallOnFinalPass,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakeSessionScenario {
    CancelDuringGeminiToolCall,
    BargeInDuringSonicAudio,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FakeRuntimeReport {
    pub events: Vec<BrainEvent>,
    pub stopped_stage: Option<&'static str>,
}

impl FakeCartesiaGeminiRuntime {
    pub fn new(store: Arc<dyn StudyMemoryStore>) -> Self {
        Self {
            runner: CartesiaGeminiRunner::fake(store, CartesiaGeminiConfig::default()),
        }
    }

    /// How many times this runtime asked the speech provider to speak.
    ///
    /// A turn that must stay silent — a deferral, a refused empty model output —
    /// is only proven silent by this counter: an absent `AudioDelta` is also
    /// consistent with a synthesis that ran and had its frames dropped.
    pub fn sonic_call_count(&self) -> u32 {
        self.runner.sonic_call_count()
    }

    pub async fn replay_audio_turn(
        &self,
        session_config: SessionConfig,
        frame: AudioFrame,
    ) -> Result<Vec<BrainEvent>, BrainError> {
        Ok(self
            .replay_audio_turn_with_interrupt(session_config, frame, FakeRuntimeInterrupt::None)
            .await?
            .events)
    }

    pub async fn replay_audio_turn_with_interrupt(
        &self,
        session_config: SessionConfig,
        frame: AudioFrame,
        interrupt: FakeRuntimeInterrupt,
    ) -> Result<FakeRuntimeReport, BrainError> {
        self.runner
            .replay_audio_turn(session_config, frame, interrupt)
            .await
    }

    pub fn open_scripted_session(
        &self,
        session_config: SessionConfig,
        scenario: FakeSessionScenario,
    ) -> Result<RealtimeSession, BrainError> {
        let session = AuthorizedStudySession::from_config(&session_config)
            .map_err(|_| outcome_contract_failure("unauthorized_session"))?;
        let store = self
            .runner
            .store()
            .ok_or_else(|| outcome_contract_failure("missing_study_store"))?;
        let evaluator = self.runner.evaluator();
        let (input, mut input_rx) = mpsc::channel::<BrainInput>(32);
        let (event_tx, events) = mpsc::channel::<BrainEvent>(32);
        let task = tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                let runner_input = match input {
                    BrainInput::Audio(frame) => RunnerInput::Audio {
                        frame,
                        client_generation_id: None,
                    },
                    BrainInput::AudioWithMetadata {
                        frame,
                        client_generation_id,
                    } => RunnerInput::Audio {
                        frame,
                        client_generation_id,
                    },
                    BrainInput::Text(text) => RunnerInput::Text {
                        text,
                        client_generation_id: None,
                    },
                    BrainInput::TextWithMetadata {
                        text,
                        client_generation_id,
                    } => RunnerInput::Text {
                        text,
                        client_generation_id,
                    },
                    BrainInput::Stop => break,
                    _ => continue,
                };
                let response_id = "fake-cartesia-gemini-session-response-1".to_owned();
                let executor =
                    VivaToolExecutor::new(store.clone(), session.clone(), Arc::clone(&evaluator));
                let question = match select_session_question(
                    &executor,
                    &session.study_set_id,
                    &session.voice_session_id,
                    &response_id,
                )
                .await
                {
                    Ok(question) => question,
                    Err(error) => {
                        emit_provider_failure(&event_tx, error).await;
                        break;
                    }
                };
                if executor
                    .record_answer_attempt_envelope(answer_attempt_envelope(
                        &session,
                        &question,
                        &response_id,
                        1,
                        &runner_input,
                    ))
                    .await
                    .is_err()
                {
                    emit_provider_failure(
                        &event_tx,
                        outcome_contract_failure("answer_attempt_envelope_failed"),
                    )
                    .await;
                    break;
                }
                let final_transcript = match runner_input {
                    RunnerInput::Audio { .. } => FAKE_CARTESIA_GEMINI_FINAL_TRANSCRIPT.to_owned(),
                    RunnerInput::Text { text, .. } => text,
                };
                let _ = event_tx.send(BrainEvent::InputSpeechStarted).await;
                // The fixture Ink transport reports no confidence, so the v5 fake
                // fixture carries an explicit `null` rather than a default.
                let _ = event_tx
                    .send(BrainEvent::TranscriptFinal {
                        response_id: response_id.clone(),
                        text: final_transcript.clone(),
                        confidence: None,
                    })
                    .await;

                match scenario {
                    FakeSessionScenario::CancelDuringGeminiToolCall => {
                        let args = json!({
                            "study_set_id": session.study_set_id.clone(),
                            "voice_session_id": session.voice_session_id.clone(),
                            "question_id": "q-oxidative-phosphorylation-nadh",
                            "answer_text": final_transcript.clone(),
                        });
                        let tool_response_id = response_id.clone();
                        let mut tool_task = tokio::spawn(async move {
                            executor
                                .execute(
                                    &tool_response_id,
                                    ToolProposal::new("evaluate_spoken_answer", args)
                                        .with_call_id("call-eval-1"),
                                )
                                .await
                        });
                        loop {
                            tokio::select! {
                                input = input_rx.recv() => {
                                    match input {
                                        Some(BrainInput::CancelResponse) => {
                                            tool_task.abort();
                                            let _ = event_tx
                                                .send(BrainEvent::ResponseCancelledFor {
                                                    response_id: response_id.clone(),
                                                })
                                                .await;
                                            break;
                                        }
                                        Some(BrainInput::Stop) | None => {
                                            tool_task.abort();
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                                _ = &mut tool_task => {
                                    break;
                                }
                            }
                        }
                    }
                    FakeSessionScenario::BargeInDuringSonicAudio => {
                        let args = json!({
                            "study_set_id": session.study_set_id.clone(),
                            "voice_session_id": session.voice_session_id.clone(),
                            "question_id": "q-oxidative-phosphorylation-nadh",
                            "answer_text": final_transcript.clone(),
                        });
                        if executor
                            .execute(
                                &response_id,
                                ToolProposal::new("evaluate_spoken_answer", args)
                                    .with_call_id("call-eval-1"),
                            )
                            .await
                            .is_err()
                        {
                            break;
                        }
                        let _ = event_tx
                            .send(BrainEvent::Usage(BrainUsage {
                                text_input_tokens: 20,
                                text_output_tokens: 10,
                                source_grounded_correction_count: 1,
                                ..BrainUsage::default()
                            }))
                            .await;
                        while let Some(input) = input_rx.recv().await {
                            match input {
                                BrainInput::Audio(_)
                                | BrainInput::AudioWithMetadata { .. }
                                | BrainInput::Text(_)
                                | BrainInput::TextWithMetadata { .. } => {
                                    let _ = event_tx
                                        .send(BrainEvent::ResponseCancelledFor {
                                            response_id: response_id.clone(),
                                        })
                                        .await;
                                    break;
                                }
                                BrainInput::CancelResponse => {
                                    let _ = event_tx
                                        .send(BrainEvent::ResponseCancelledFor {
                                            response_id: response_id.clone(),
                                        })
                                        .await;
                                    break;
                                }
                                BrainInput::Stop => break,
                                _ => {}
                            }
                        }
                    }
                }
                break;
            }
        });

        Ok(RealtimeSession {
            input,
            events,
            task_guard: Some(RealtimeSessionTaskGuard::new(vec![task.abort_handle()])),
        })
    }
}

#[async_trait]
impl RealtimeBrain for FakeCartesiaGeminiRuntime {
    fn capabilities(&self) -> RealtimeBrainCapabilities {
        RealtimeBrainCapabilities {
            provider: "fake_cartesia_gemini".to_owned(),
            configured: true,
            selectable: true,
            live_runtime: false,
        }
    }

    async fn open(&self, session_config: SessionConfig) -> Result<RealtimeSession, BrainError> {
        self.runner.open(session_config).await
    }
}

async fn send_fake_unless_cancelled(
    event_tx: &mpsc::Sender<BrainEvent>,
    event: BrainEvent,
    cancelled: &AtomicBool,
) -> bool {
    if cancelled.load(Ordering::SeqCst) {
        return false;
    }
    if event_tx.send(event).await.is_err() {
        return false;
    }
    tokio::task::yield_now().await;
    !cancelled.load(Ordering::SeqCst)
}

/// The one provider-error emission path.
///
/// Plan 06 collapsed `BrainError` to a single classified variant, so the class,
/// stage, retry policy, and terminal reason were all chosen at the boundary that
/// observed the failure. Nothing here re-reads a message to guess any of them,
/// and there is no second emitter a generic code path could pick by accident.
async fn emit_provider_failure(event_tx: &mpsc::Sender<BrainEvent>, error: BrainError) {
    let _ = event_tx
        .send(BrainEvent::Error(BrainProviderError::from_failure(
            error.failure().clone(),
        )))
        .await;
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn is_placeholder_live_key(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("viva-release-check-") || normalized.contains("placeholder")
}

fn parse_gemini_fallback_models(value: &str, primary_model: &str) -> Vec<String> {
    let primary = primary_model.trim();
    let mut models = Vec::new();
    for model in value
        .split(',')
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        if model == primary || models.iter().any(|existing| existing == model) {
            continue;
        }
        models.push(model.to_owned());
    }
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_domain::viva_max_submitted_answer_resolution;

    #[test]
    fn from_env_applies_ink_transport_overrides() {
        let config = CartesiaGeminiConfig::from_env_with(|name| match name {
            "CARTESIA_API_KEY" => Some(" cartesia-key ".to_owned()),
            "GEMINI_API_KEY" => Some(" gemini-key ".to_owned()),
            "CARTESIA_INK_WEBSOCKET_URL" => {
                Some(" wss://example.test/stt/turns/websocket ".to_owned())
            }
            "CARTESIA_INK_MODEL" => Some(" ink-custom ".to_owned()),
            "CARTESIA_INK_LANGUAGE" => Some(" en ".to_owned()),
            "CARTESIA_INK_ENCODING" => Some(" pcm_f32le ".to_owned()),
            "CARTESIA_INK_SAMPLE_RATE" => Some(" 16000 ".to_owned()),
            "CARTESIA_INK_MIN_VOLUME" => Some(" 0.2 ".to_owned()),
            "CARTESIA_INK_MAX_SILENCE_DURATION_SECS" => Some(" 1.1 ".to_owned()),
            "CARTESIA_VERSION" => Some(" 2026-03-01 ".to_owned()),
            _ => None,
        });

        assert_eq!(config.cartesia_api_key, "cartesia-key");
        assert_eq!(config.gemini.api_key, "gemini-key");
        assert_eq!(
            config.ink.websocket_url,
            "wss://example.test/stt/turns/websocket"
        );
        assert_eq!(config.ink.model, "ink-custom");
        assert_eq!(config.ink.language, "en");
        assert_eq!(config.ink.encoding, "pcm_f32le");
        assert_eq!(config.ink.sample_rate, 16_000);
        assert_eq!(config.ink.min_volume, "0.2");
        assert_eq!(config.ink.max_silence_duration_secs, "1.1");
        assert_eq!(config.ink.cartesia_version, "2026-03-01");
    }

    #[test]
    fn from_env_applies_sonic_transport_overrides() {
        let config = CartesiaGeminiConfig::from_env_with(|name| match name {
            "CARTESIA_SONIC_WEBSOCKET_URL" => Some(" wss://example.test/tts/websocket ".to_owned()),
            "CARTESIA_SONIC_MODEL" => Some(" sonic-custom ".to_owned()),
            "CARTESIA_SONIC_VOICE_ID" => Some(" voice-custom ".to_owned()),
            "CARTESIA_SONIC_LANGUAGE" => Some(" es ".to_owned()),
            "CARTESIA_SONIC_SAMPLE_RATE" => Some(" 16000 ".to_owned()),
            "CARTESIA_SONIC_MAX_BUFFER_DELAY_MS" => Some(" 40 ".to_owned()),
            "CARTESIA_SONIC_VERSION" => Some(" 2026-03-01 ".to_owned()),
            _ => None,
        });

        assert_eq!(
            config.sonic.websocket_url,
            "wss://example.test/tts/websocket"
        );
        assert_eq!(config.sonic.model_id, "sonic-custom");
        assert_eq!(config.sonic.voice_id, "voice-custom");
        assert_eq!(config.sonic.language, "es");
        assert_eq!(config.sonic.sample_rate, 16_000);
        assert_eq!(config.sonic.max_buffer_delay_ms, 40);
        assert_eq!(config.sonic.cartesia_version, "2026-03-01");
    }

    #[test]
    fn defaults_allow_declared_live_tool_sequence_under_outer_turn_cap() {
        let config = CartesiaGeminiConfig::default();

        assert_eq!(MAX_GEMINI_EXECUTED_TOOL_STAGES, 5);
        assert_eq!(config.tool_stage_timeout, Duration::from_secs(2));
        assert_eq!(config.recap_stage_timeout, Duration::from_secs(2));
        assert!(
            config
                .total_live_stage_deadline()
                .saturating_add(Duration::from_secs(1))
                <= viva_max_submitted_answer_resolution()
        );
    }

    #[test]
    fn from_env_applies_deduped_gemini_fallback_models() {
        let config = CartesiaGeminiConfig::from_env_with(|name| match name {
            "GEMINI_MODEL" => Some(" gemini-3.5-pro ".to_owned()),
            "GEMINI_FALLBACK_MODELS" => {
                Some(" gemini-3.5-flash , gemini-3.0-flash ,, gemini-3.5-flash ".to_owned())
            }
            _ => None,
        });

        assert_eq!(
            config.gemini.fallback_model_ids,
            vec!["gemini-3.5-flash", "gemini-3.0-flash"]
        );
    }

    #[test]
    fn from_env_parses_live_runtime_gate_conservatively() {
        let enabled = CartesiaGeminiConfig::from_env_with(|name| match name {
            "VIVA_CARTESIA_GEMINI_LIVE_RUNTIME" => Some(" 1 ".to_owned()),
            "CARTESIA_ZERO_DATA_RETENTION_ENABLED" => Some(" 1 ".to_owned()),
            "GEMINI_ZERO_DATA_RETENTION_APPROVED" => Some(" 1 ".to_owned()),
            _ => None,
        });
        let disabled = CartesiaGeminiConfig::from_env_with(|name| match name {
            "VIVA_CARTESIA_GEMINI_LIVE_RUNTIME" => Some(" true ".to_owned()),
            "CARTESIA_ZERO_DATA_RETENTION_ENABLED" => Some(" true ".to_owned()),
            "GEMINI_ZERO_DATA_RETENTION_APPROVED" => Some(" true ".to_owned()),
            _ => None,
        });
        let alias = CartesiaGeminiConfig::from_env_with(|name| match name {
            "VIVA_AGENT_CARTESIA_GEMINI_LIVE_RUNTIME" => Some(" 1 ".to_owned()),
            _ => None,
        });

        assert!(enabled.live_runtime_enabled);
        assert!(enabled.provider_zero_data_retention_confirmed());
        assert!(!disabled.live_runtime_enabled);
        assert!(!disabled.provider_zero_data_retention_confirmed());
        assert!(!alias.live_runtime_enabled);
        assert!(!alias.provider_zero_data_retention_confirmed());
    }

    #[test]
    fn phase_tracker_emits_only_legal_transitions_and_fails_closed_otherwise() {
        let tracker = SessionPhaseTracker::ready();

        for phase in [
            StudySessionPhase::Listening,
            StudySessionPhase::Thinking,
            StudySessionPhase::Feedback,
            StudySessionPhase::Correction,
        ] {
            assert_eq!(
                tracker.phase_event(phase).expect("legal transition"),
                BrainEvent::SessionPhase { phase }
            );
        }
        assert_eq!(tracker.phase(), StudySessionPhase::Correction);

        // A second Feedback claim is backward motion the domain refuses, and the
        // refusal is a typed failure rather than an emitted phase.
        let error = tracker
            .phase_event(StudySessionPhase::Feedback)
            .expect_err("backward motion is illegal");
        assert_eq!(
            error.failure().failure_class(),
            BrainFailureClass::ToolExecutorFailure
        );
        assert_eq!(error.failure().stage(), BrainFailureStage::Session);
        assert_eq!(tracker.phase(), StudySessionPhase::Correction);

        // A barge-in during a turn takes the machine's one explicit backward
        // motion rather than an illegal forward claim.
        assert_eq!(
            tracker.begin_turn().expect("a replacement turn restarts"),
            BrainEvent::SessionPhase {
                phase: StudySessionPhase::Listening
            }
        );
        assert!(tracker.phase_event(StudySessionPhase::Thinking).is_ok());
        assert_eq!(
            tracker.begin_turn().expect("a second barge-in restarts"),
            BrainEvent::SessionPhase {
                phase: StudySessionPhase::Listening
            }
        );
        for phase in [
            StudySessionPhase::Thinking,
            StudySessionPhase::Feedback,
            StudySessionPhase::Correction,
        ] {
            tracker.phase_event(phase).expect("legal transition");
        }
        assert!(tracker
            .phase_event_if_legal(StudySessionPhase::Recap)
            .is_some());
        assert!(SessionPhaseTracker::ready()
            .phase_event_if_legal(StudySessionPhase::Recap)
            .is_none());
    }

    /// The projection copies a persisted mastery value; it never picks one.
    #[test]
    fn evaluation_projection_copies_a_persisted_status_and_never_defaults_one() {
        let mut outcome = crate::synthetic::learning_core_turn_outcome("evaluated_mostly_correct")
            .expect("the immutable corpus publishes the case");
        let source = agent_domain::fixture_source_reference();
        let TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &outcome.resolution
        else {
            panic!("the corpus case is evaluated");
        };
        let transitions = concept_transitions.clone();
        assert!(
            transitions.len() > 1,
            "the case must name more than one concept for the preference to be observable"
        );

        // This turn's own concept wins, whichever position it holds.
        for expected in &transitions {
            let mut question = agent_domain::fixture_question();
            question.concept_id = expected.concept_id.clone();
            let evaluation =
                answer_evaluation_from_outcome(&outcome, "the answer", &source, &question)
                    .expect("a transition-bearing outcome projects")
                    .expect("an evaluated outcome carries an evaluation");
            assert_eq!(evaluation.concept_status, expected.to_status);
            assert_eq!(evaluation.answer_text, "the answer");
        }

        // A concept the outcome never mentions falls back to the outcome's own
        // first transition, still a persisted value.
        let mut unrelated = agent_domain::fixture_question();
        unrelated.concept_id = "concept-the-outcome-never-names".to_owned();
        assert_eq!(
            answer_evaluation_from_outcome(&outcome, "the answer", &source, &unrelated)
                .expect("a transition-bearing outcome projects")
                .expect("an evaluated outcome carries an evaluation")
                .concept_status,
            transitions[0].to_status
        );

        // With no transition at all there is nothing honest to show.
        if let TurnResolution::Evaluated {
            concept_transitions,
            ..
        } = &mut outcome.resolution
        {
            concept_transitions.clear();
        }
        let error = answer_evaluation_from_outcome(&outcome, "the answer", &source, &unrelated)
            .expect_err("a transition-less evaluated outcome has no status to show");
        assert_eq!(
            error.failure().failure_class(),
            BrainFailureClass::ToolExecutorFailure
        );
        assert_eq!(error.failure().stage(), BrainFailureStage::Tools);
        assert_eq!(
            error.failure().metadata(),
            "error_kind=turn_outcome_without_concept_transition"
        );

        // A deferral carries no evaluation and is not a failure.
        let deferred =
            crate::synthetic::learning_core_turn_outcome("deferred_insufficient_semantic_evidence")
                .expect("the immutable corpus publishes the case");
        assert!(
            answer_evaluation_from_outcome(&deferred, "the answer", &source, &unrelated)
                .expect("a deferral projects")
                .is_none()
        );
    }
}
