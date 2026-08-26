use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_domain::{
    BrainUsage, RealtimeBrain, StudyMemoryStore, StudySetIngestionRecord, VoiceUsageRecord,
};
use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    routing::get,
    Json, Router,
};
use observe::{usage_event, CostModel, VoiceEvidenceEvent, VoiceUsageEvent};
use serde::Serialize;
use serde_json::json;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    config::{
        bac_510_max_turn_duration, FailureControlClaim, FailureControlClaimRequest,
        FailureControlConfig, OperatorAccess, ProjectionReadAccess, RecorderLimits,
        SessionTokenClaims, TrustedProxyConfig, VoiceLimitConfig, VoiceWsAccess,
    },
    ws::{
        admission::{VoiceDrainSignal, VoiceLimitState, VoiceRuntimeSnapshot, VoiceRuntimeTracker},
        voice_ws,
    },
};

#[derive(Clone)]
pub struct AppState {
    pub brain: Arc<dyn RealtimeBrain>,
    pub study_store: Arc<dyn StudyMemoryStore>,
    pub provider: String,
    pub trusted_user_id: String,
    pub trusted_study_set_id: String,
    pub trusted_session_id: String,
    pub trusted_session_sequence: Arc<AtomicU64>,
    pub ws_access: VoiceWsAccess,
    pub operator_access: OperatorAccess,
    /// `SERVICE-011`: present only where the Plan 11 scoped read credential and a
    /// session-token secret are both configured. Absent means the route refuses
    /// every request rather than falling back to a broader credential.
    pub projection_read_access: Option<ProjectionReadAccess>,
    pub trusted_proxies: TrustedProxyConfig,
    pub session_slots: Arc<Semaphore>,
    /// The configured global session capacity `session_slots` was built with.
    /// The semaphore reports only what is still available, so the total has to be
    /// carried beside it for `SERVICE-012`'s snapshot to mean anything.
    pub max_sessions: usize,
    /// `SERVICE-012`: server-owned handler/worker accounting and the drain gate
    /// that closes admission before a session slot can be allocated.
    pub runtime_tracker: VoiceRuntimeTracker,
    pub ws_timeouts: WsTimeouts,
    pub turn_cap_override: bool,
    pub voice_limits: VoiceLimitConfig,
    pub limit_state: VoiceLimitState,
    pub drain_signal: VoiceDrainSignal,
    pub evidence: VoiceEvidenceRecorder,
    pub usage: VoiceUsageRecorder,
    pub unauthenticated_paste_allowed: bool,
    pub failure_control: FailureControlConfig,
}

impl AppState {
    pub fn new(
        brain: Arc<dyn RealtimeBrain>,
        provider: impl Into<String>,
        ws_access: VoiceWsAccess,
        max_sessions: usize,
    ) -> Self {
        Self::with_study_store(
            brain,
            provider,
            ws_access,
            max_sessions,
            Arc::new(data::InMemoryStudyStore::seeded_fixture()),
        )
    }

    pub fn with_study_store(
        brain: Arc<dyn RealtimeBrain>,
        provider: impl Into<String>,
        ws_access: VoiceWsAccess,
        max_sessions: usize,
        study_store: Arc<dyn StudyMemoryStore>,
    ) -> Self {
        Self {
            brain,
            study_store,
            provider: provider.into(),
            trusted_user_id: "user-1".to_owned(),
            trusted_study_set_id: "biology-midterm".to_owned(),
            trusted_session_id: "voice-session-1".to_owned(),
            trusted_session_sequence: Arc::new(AtomicU64::new(0)),
            ws_access,
            operator_access: OperatorAccess::default(),
            projection_read_access: None,
            trusted_proxies: TrustedProxyConfig::default(),
            session_slots: Arc::new(Semaphore::new(max_sessions)),
            max_sessions,
            runtime_tracker: VoiceRuntimeTracker::default(),
            ws_timeouts: WsTimeouts::default(),
            turn_cap_override: false,
            voice_limits: VoiceLimitConfig::default(),
            limit_state: VoiceLimitState::default(),
            drain_signal: VoiceDrainSignal::default(),
            evidence: VoiceEvidenceRecorder::default(),
            usage: VoiceUsageRecorder::default(),
            unauthenticated_paste_allowed: true,
            failure_control: FailureControlConfig::default(),
        }
    }

    pub fn with_trusted_user_id(mut self, trusted_user_id: impl Into<String>) -> Self {
        self.trusted_user_id = trusted_user_id.into();
        self
    }

    pub fn with_trusted_study_set_id(mut self, trusted_study_set_id: impl Into<String>) -> Self {
        self.trusted_study_set_id = trusted_study_set_id.into();
        self
    }

    pub fn with_trusted_session_id(mut self, trusted_session_id: impl Into<String>) -> Self {
        self.trusted_session_id = trusted_session_id.into();
        self
    }

    pub fn next_trusted_voice_session_id(&self) -> String {
        let sequence = self
            .trusted_session_sequence
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        Uuid::from_u128(u128::from(sequence)).to_string()
    }

    pub fn with_ws_timeouts(mut self, ws_timeouts: WsTimeouts) -> Self {
        self.turn_cap_override = ws_timeouts.idle != WsTimeouts::default().idle;
        self.ws_timeouts = ws_timeouts;
        self
    }

    pub fn with_projection_read_access(
        mut self,
        projection_read_access: ProjectionReadAccess,
    ) -> Self {
        self.projection_read_access = Some(projection_read_access);
        self
    }

    pub fn with_operator_access(mut self, operator_access: OperatorAccess) -> Self {
        self.operator_access = operator_access;
        self
    }

    pub fn with_trusted_proxies(mut self, trusted_proxies: TrustedProxyConfig) -> Self {
        self.trusted_proxies = trusted_proxies;
        self
    }

    /// Rebuilds both voice recorders against the configured retention bound. It
    /// runs at startup, before any event exists, so no retained event is lost.
    pub fn with_recorder_limits(mut self, recorder_limits: RecorderLimits) -> Self {
        self.evidence = VoiceEvidenceRecorder::with_capacity(recorder_limits.evidence_events);
        self.usage = VoiceUsageRecorder::with_capacity(recorder_limits.usage_events);
        self
    }

    pub fn with_turn_cap_override(mut self, turn_cap_override: bool) -> Self {
        self.turn_cap_override = turn_cap_override;
        self
    }

    pub fn with_voice_limits(mut self, voice_limits: VoiceLimitConfig) -> Self {
        self.voice_limits = voice_limits;
        self
    }

    pub fn with_unauthenticated_paste_allowed(mut self, allowed: bool) -> Self {
        self.unauthenticated_paste_allowed = allowed;
        self
    }

    pub fn with_failure_control(mut self, failure_control: FailureControlConfig) -> Self {
        self.failure_control = failure_control;
        self
    }

    pub fn is_ready(&self) -> bool {
        let brain = self.brain.capabilities();
        let store = self.study_store.capabilities();
        brain.configured
            && brain.selectable
            && store.available
            && !self.drain_signal.is_draining()
            && !self.runtime_tracker.is_draining()
    }

    /// `SERVICE-012`: the one sanitized view of live runtime occupancy. It is
    /// built from the server's own permits, counters, and guards, so a client can
    /// neither inflate nor hide a number in it, and it carries counts only.
    pub fn runtime_snapshot(&self) -> VoiceRuntimeSnapshot {
        let leases = self.limit_state.lease_counts();
        let (active_handlers, background_workers) = self.runtime_tracker.counts();
        VoiceRuntimeSnapshot {
            session_capacity: self.max_sessions,
            session_in_use: self
                .max_sessions
                .saturating_sub(self.session_slots.available_permits()),
            user_leases: leases.users,
            ip_leases: leases.ips,
            provider_inflight: leases.provider_inflight,
            provider_waiting: leases.provider_waiting,
            active_handlers,
            background_workers,
            draining: self.drain_signal.is_draining() || self.runtime_tracker.is_draining(),
        }
    }
}

/// `SERVICE-017`: the final composition. Each responsibility group is merged
/// exactly once and `/ws` is registered exactly once, in the same order and with
/// the same handlers as before the split.
pub fn build_router(state: AppState) -> Router {
    crate::http::routes()
        .route("/ws", get(voice_ws))
        .with_state(state)
}

/// Every long-lived WebSocket bound, resolved once from server configuration. A
/// client frame can never extend one of these.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WsTimeouts {
    pub first_frame: Duration,
    pub idle: Duration,
    pub between_turn_idle: Duration,
    pub session: Duration,
    pub heartbeat_interval: Duration,
    pub pong_timeout: Duration,
    pub outbound_write: Duration,
    pub drain_grace: Duration,
}

impl Default for WsTimeouts {
    fn default() -> Self {
        Self {
            first_frame: Duration::from_secs(10),
            idle: bac_510_max_turn_duration(),
            between_turn_idle: Duration::from_secs(600),
            session: Duration::from_secs(6 * 60 * 60),
            heartbeat_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(10),
            outbound_write: Duration::from_secs(5),
            drain_grace: Duration::from_secs(20),
        }
    }
}

/// `SERVICE-005`: what a caller may read about retention without walking the
/// retained events.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct RecorderStats {
    pub capacity: usize,
    pub retained: usize,
    pub total_recorded: u64,
    pub dropped: u64,
}

/// A bounded newest-wins window over recorded events. `record` is O(1) and the
/// counters keep counting long after the window has started evicting.
#[derive(Debug)]
struct RetainedEvents<T> {
    capacity: usize,
    events: VecDeque<T>,
    total_recorded: u64,
    dropped: u64,
}

impl<T> RetainedEvents<T> {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            events: VecDeque::with_capacity(capacity.min(1_024)),
            total_recorded: 0,
            dropped: 0,
        }
    }

    fn record(&mut self, event: T) {
        self.total_recorded = self.total_recorded.saturating_add(1);
        if self.capacity == 0 {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        if self.events.len() >= self.capacity {
            self.events.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
        self.events.push_back(event);
    }

    fn stats(&self) -> RecorderStats {
        RecorderStats {
            capacity: self.capacity,
            retained: self.events.len(),
            total_recorded: self.total_recorded,
            dropped: self.dropped,
        }
    }
}

impl<T: Clone> RetainedEvents<T> {
    fn snapshot(&self) -> Vec<T> {
        self.events.iter().cloned().collect()
    }
}

/// The O(1) usage totals. They are the only usage numbers readiness reports, so
/// eviction can never make the service under-report what it spent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct VoiceUsageAggregate {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
    pub invalid_cost_events: u64,
}

impl VoiceUsageAggregate {
    fn accumulate(&mut self, event: &VoiceUsageEvent) {
        let prompt = event
            .text_input_tokens
            .saturating_add(event.audio_input_tokens);
        let completion = event
            .text_output_tokens
            .saturating_add(event.audio_output_tokens);
        self.prompt_tokens = self.prompt_tokens.saturating_add(prompt);
        self.completion_tokens = self.completion_tokens.saturating_add(completion);
        self.total_tokens = self
            .total_tokens
            .saturating_add(prompt)
            .saturating_add(completion);
        if event.cost_estimate_usd.is_finite() && event.cost_estimate_usd >= 0.0 {
            self.estimated_cost_usd += event.cost_estimate_usd;
        } else {
            self.invalid_cost_events = self.invalid_cost_events.saturating_add(1);
        }
    }
}

/// `provider` and `model` are server-chosen identifiers, never learner text. A
/// value that is not a short identifier — a signed credential, a bearer header,
/// transcript prose, or a base64 audio blob — is replaced by this label before it
/// can be retained or rendered.
const REDACTED_USAGE_LABEL: &str = "redacted_usage_label";
const MAX_USAGE_LABEL_CHARS: usize = 64;

fn sanitized_usage_label(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let is_identifier = trimmed.chars().count() <= MAX_USAGE_LABEL_CHARS
        && trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
        });
    if !is_identifier {
        return REDACTED_USAGE_LABEL.to_owned();
    }
    if observe::sanitize_evidence_detail(trimmed.to_owned()) != trimmed {
        return REDACTED_USAGE_LABEL.to_owned();
    }
    trimmed.to_owned()
}

#[derive(Clone, Debug)]
pub struct VoiceEvidenceRecorder {
    retained: Arc<RwLock<RetainedEvents<VoiceEvidenceEvent>>>,
}

impl Default for VoiceEvidenceRecorder {
    fn default() -> Self {
        Self::with_capacity(RecorderLimits::default().evidence_events)
    }
}

impl VoiceEvidenceRecorder {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            retained: Arc::new(RwLock::new(RetainedEvents::new(capacity))),
        }
    }

    pub fn record(&self, event: VoiceEvidenceEvent) {
        self.retained
            .write()
            .expect("evidence recorder lock poisoned")
            .record(event);
    }

    pub fn snapshot(&self) -> Vec<VoiceEvidenceEvent> {
        self.retained
            .read()
            .expect("evidence recorder lock poisoned")
            .snapshot()
    }

    pub fn stats(&self) -> RecorderStats {
        self.retained
            .read()
            .expect("evidence recorder lock poisoned")
            .stats()
    }
}

#[derive(Debug)]
struct VoiceUsageState {
    retained: RetainedEvents<VoiceUsageEvent>,
    aggregate: VoiceUsageAggregate,
}

#[derive(Clone, Debug)]
pub struct VoiceUsageRecorder {
    state: Arc<RwLock<VoiceUsageState>>,
}

impl Default for VoiceUsageRecorder {
    fn default() -> Self {
        Self::with_capacity(RecorderLimits::default().usage_events)
    }
}

impl VoiceUsageRecorder {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            state: Arc::new(RwLock::new(VoiceUsageState {
                retained: RetainedEvents::new(capacity),
                aggregate: VoiceUsageAggregate::default(),
            })),
        }
    }

    pub fn record(
        &self,
        voice_session_id: Option<&str>,
        provider: &str,
        model: &str,
        usage: BrainUsage,
        duration_seconds: u64,
        answer_eval_latency_ms: Option<u64>,
    ) -> VoiceUsageRecord {
        let parsed_session_id = voice_session_id.and_then(|id| id.parse().ok());
        let cost_model = CostModel::default();
        let mut event = usage_event(
            parsed_session_id,
            sanitized_usage_label(provider),
            sanitized_usage_label(model),
            duration_seconds,
            usage,
            &cost_model,
        );
        event.answer_eval_latency_ms = answer_eval_latency_ms;
        let record = VoiceUsageRecord {
            voice_session_id: voice_session_id.map(ToOwned::to_owned),
            provider: event.provider.clone(),
            model: event.model.clone(),
            duration_seconds: event.duration_seconds,
            text_input_tokens: event.text_input_tokens,
            text_output_tokens: event.text_output_tokens,
            audio_input_tokens: event.audio_input_tokens,
            audio_output_tokens: event.audio_output_tokens,
            cost_estimate_usd: event.cost_estimate_usd,
            first_audio_latency_ms: event.first_audio_latency_ms,
            answer_eval_latency_ms: event.answer_eval_latency_ms,
            source_retrieval_latency_ms: event.source_retrieval_latency_ms,
            source_grounded_correction_count: event.source_grounded_correction_count,
        };
        // The aggregate is updated under the same lock, before eviction, so no
        // recorded event can be evicted without having been counted.
        let mut state = self.state.write().expect("usage recorder lock poisoned");
        state.aggregate.accumulate(&event);
        state.retained.record(event);
        record
    }

    pub fn snapshot(&self) -> Vec<VoiceUsageEvent> {
        self.state
            .read()
            .expect("usage recorder lock poisoned")
            .retained
            .snapshot()
    }

    pub fn stats(&self) -> RecorderStats {
        self.state
            .read()
            .expect("usage recorder lock poisoned")
            .retained
            .stats()
    }

    pub fn aggregate(&self) -> VoiceUsageAggregate {
        self.state
            .read()
            .expect("usage recorder lock poisoned")
            .aggregate
    }

    pub fn summary(&self) -> serde_json::Value {
        let state = self.state.read().expect("usage recorder lock poisoned");
        let stats = state.retained.stats();
        let aggregate = state.aggregate;
        drop(state);
        json!({
            "events": stats.retained,
            "prompt_tokens": aggregate.prompt_tokens,
            "completion_tokens": aggregate.completion_tokens,
            "total_tokens": aggregate.total_tokens,
            "estimated_cost_usd": aggregate.estimated_cost_usd,
            "invalid_cost_events": aggregate.invalid_cost_events,
            "retention": stats,
        })
    }
}

pub(crate) fn access_error_status(error: &crate::config::VoiceWsAccessError) -> StatusCode {
    match error {
        crate::config::VoiceWsAccessError::OriginDenied => StatusCode::FORBIDDEN,
        crate::config::VoiceWsAccessError::MissingBearer
        | crate::config::VoiceWsAccessError::InvalidBearer => StatusCode::UNAUTHORIZED,
    }
}

pub(crate) fn access_error_code(error: &crate::config::VoiceWsAccessError) -> &'static str {
    match error {
        crate::config::VoiceWsAccessError::OriginDenied => "origin_denied",
        crate::config::VoiceWsAccessError::MissingBearer => "missing_bearer",
        crate::config::VoiceWsAccessError::InvalidBearer => "invalid_bearer",
    }
}

pub(crate) async fn paste_options(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, HeaderMap) {
    match cors_headers(&state.ws_access, headers.get(header::ORIGIN)) {
        Ok(headers) => (StatusCode::NO_CONTENT, headers),
        Err(_) => (StatusCode::FORBIDDEN, HeaderMap::new()),
    }
}

pub(crate) fn signed_session_token(
    record: &StudySetIngestionRecord,
    secret: &str,
    state: &AppState,
    origin: Option<&str>,
) -> Result<String, crate::config::SessionTokenError> {
    let failure_control = failure_control_claim_for(
        state,
        &record.study_set.user_id,
        &record.study_set.id,
        &record.session_id,
        origin,
    )?;
    signed_session_token_for(
        &record.study_set.user_id,
        &record.study_set.id,
        &record.session_id,
        secret,
        failure_control,
    )
}

pub(crate) fn signed_session_token_for(
    user_id: &str,
    study_set_id: &str,
    session_id: &str,
    secret: &str,
    failure_control: Option<FailureControlClaim>,
) -> Result<String, crate::config::SessionTokenError> {
    let issued_at = unix_timestamp_now().unwrap_or(0);
    let expires_at = issued_at + 15 * 60;
    SessionTokenClaims {
        user_id: user_id.to_owned(),
        study_set_id: study_set_id.to_owned(),
        session_id: session_id.to_owned(),
        issued_at,
        not_before: issued_at,
        expires_at,
        nonce: Uuid::new_v4().to_string(),
        failure_control,
    }
    .sign(secret)
}

pub(crate) fn failure_control_claim_for(
    state: &AppState,
    user_id: &str,
    study_set_id: &str,
    session_id: &str,
    origin: Option<&str>,
) -> Result<Option<FailureControlClaim>, crate::config::SessionTokenError> {
    if !state.failure_control.enabled() {
        return Ok(None);
    }
    let Some(origin) = origin.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !state
        .failure_control
        .allows_identity(user_id, study_set_id, origin)
    {
        return Ok(None);
    }
    let now = unix_timestamp_now()?;
    let run_id = Uuid::new_v4().to_string();
    let nonce = Uuid::new_v4().to_string();
    Ok(Some(state.failure_control.signed_claim_for(
        FailureControlClaimRequest {
            user_id,
            study_set_id,
            session_id,
            origin,
            run_id: &run_id,
            now,
            nonce: &nonce,
        },
    )?))
}

pub(crate) fn request_origin(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(crate) fn unix_timestamp_now() -> Result<u64, crate::config::SessionTokenError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| crate::config::SessionTokenError::Invalid)
}

pub(crate) fn optional_cors_json_headers(
    access: &VoiceWsAccess,
    request_headers: &HeaderMap,
) -> Result<HeaderMap, crate::config::VoiceWsAccessError> {
    let mut headers = request_headers.get(header::ORIGIN).map_or_else(
        || Ok(HeaderMap::new()),
        |origin| cors_headers(access, Some(origin)),
    )?;
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(headers)
}

pub(crate) fn cors_json_error(
    error: crate::config::VoiceWsAccessError,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
    (
        access_error_status(&error),
        HeaderMap::new(),
        Json(json!({
            "error": access_error_code(&error),
            "message": error.to_string(),
            "readiness_status": "access_denied",
            "failure_kind": crate::http::health::readiness_failure_kind("access_denied"),
            "access": {
                "status": "denied",
                "reason": access_error_code(&error),
            },
        })),
    )
}

pub(crate) fn cors_headers(
    access: &VoiceWsAccess,
    origin: Option<&HeaderValue>,
) -> Result<HeaderMap, crate::config::VoiceWsAccessError> {
    let mut headers = HeaderMap::new();
    let allow_origin = if access.allowed_origins.is_empty() {
        origin
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("*"))
    } else {
        let origin = origin.ok_or(crate::config::VoiceWsAccessError::OriginDenied)?;
        let origin_text = origin
            .to_str()
            .map_err(|_| crate::config::VoiceWsAccessError::OriginDenied)?;
        if !access
            .allowed_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(origin_text))
        {
            return Err(crate::config::VoiceWsAccessError::OriginDenied);
        }
        origin.clone()
    };
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, authorization, x-viva-library-control-token"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("origin"));
    Ok(headers)
}
