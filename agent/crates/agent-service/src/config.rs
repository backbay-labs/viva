use std::{
    env, fmt,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_adapters::{
    cartesia_gemini::{CartesiaGeminiBrain, CartesiaGeminiConfig, FakeCartesiaGeminiRuntime},
    SyntheticBrain,
};
use agent_domain::{
    viva_max_submitted_answer_resolution, RealtimeBrain, StudyMemoryStore, StudyStoreCapabilities,
};
use axum::http::HeaderMap;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub bind_addr: SocketAddr,
    pub provider: RealtimeProvider,
    pub database_url: Option<String>,
    pub trusted_user_id: String,
    pub trusted_study_set_id: String,
    pub trusted_session_id: String,
    pub ws_access: VoiceWsAccess,
    pub max_sessions: usize,
    pub max_session_duration: Duration,
    pub max_turn_duration: Duration,
    pub max_turn_duration_overridden: bool,
    pub voice_limits: VoiceLimitConfig,
    pub failure_control: FailureControlConfig,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            bind_addr: "127.0.0.1:4318"
                .parse()
                .expect("default bind address is valid"),
            provider: RealtimeProvider::Synthetic,
            database_url: None,
            trusted_user_id: "user-1".to_owned(),
            trusted_study_set_id: "biology-midterm".to_owned(),
            trusted_session_id: "voice-session-1".to_owned(),
            ws_access: VoiceWsAccess::default(),
            max_sessions: 32,
            max_session_duration: Duration::from_secs(6 * 60 * 60),
            max_turn_duration: bac_510_max_turn_duration(),
            max_turn_duration_overridden: false,
            voice_limits: VoiceLimitConfig::default(),
            failure_control: FailureControlConfig::default(),
        }
    }
}

impl ServiceConfig {
    pub fn from_env() -> Result<Self, ServiceConfigError> {
        Self::from_env_with(|name| env::var(name).ok())
    }

    fn from_env_with(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ServiceConfigError> {
        let env_value = |name: &str| {
            lookup(name)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let mut config = Self::default();
        if let Some(bind_addr) = env_value("VIVA_AGENT_BIND_ADDR")
            .or_else(|| env_value("BIND_ADDR"))
            .and_then(|value| value.parse::<SocketAddr>().ok())
        {
            config.bind_addr = bind_addr;
        }
        if let Some(provider) = env_value("VIVA_AGENT_PROVIDER") {
            config.provider = RealtimeProvider::parse(&provider)?;
        }
        config.database_url =
            env_value("VIVA_AGENT_DATABASE_URL").or_else(|| env_value("DATABASE_URL"));
        if let Some(trusted_user_id) =
            env_value("VIVA_VOICE_TRUSTED_USER_ID").or_else(|| env_value("VIVA_LOCAL_USER_ID"))
        {
            config.trusted_user_id = trusted_user_id;
        }
        if let Some(trusted_study_set_id) = env_value("VIVA_VOICE_TRUSTED_STUDY_SET_ID") {
            config.trusted_study_set_id = trusted_study_set_id;
        }
        if let Some(trusted_session_id) = env_value("VIVA_VOICE_TRUSTED_SESSION_ID") {
            config.trusted_session_id = trusted_session_id;
        }
        if let Some(secret) = env_value("VIVA_VOICE_WS_BEARER_TOKEN") {
            config.ws_access.required_bearer = Some(secret);
        }
        if let Some(secret) = env_value("VIVA_VOICE_SESSION_TOKEN_SECRET") {
            config.ws_access.session_token_secret = Some(secret);
        }
        if let Some(origins) = env_value("VIVA_VOICE_WS_ALLOWED_ORIGINS") {
            config.ws_access.allowed_origins = origins
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(ToOwned::to_owned)
                .collect();
        }
        if let Some(max_sessions) = env_value("VIVA_VOICE_WS_MAX_SESSIONS")
            .or_else(|| env_value("MAX_VOICE_SESSIONS"))
            .and_then(|value| value.parse().ok())
        {
            config.max_sessions = max_sessions;
        }
        if let Some(seconds) =
            env_value("VIVA_VOICE_WS_SESSION_SECONDS").and_then(|value| parse_positive_u64(&value))
        {
            config.max_session_duration = Duration::from_secs(seconds);
        }
        if let Some(seconds) =
            env_value("VIVA_VOICE_WS_TURN_SECONDS").and_then(|value| parse_positive_u64(&value))
        {
            config.max_turn_duration =
                Duration::from_secs(seconds).min(bac_510_max_turn_duration());
            config.max_turn_duration_overridden = true;
        }
        if let Some(max_user_sessions) = env_value("VIVA_VOICE_WS_MAX_USER_SESSIONS")
            .and_then(|value| parse_positive_usize(&value))
        {
            config.voice_limits.max_user_sessions = Some(max_user_sessions);
        }
        if let Some(max_ip_sessions) = env_value("VIVA_VOICE_WS_MAX_IP_SESSIONS")
            .and_then(|value| parse_positive_usize(&value))
        {
            config.voice_limits.max_ip_sessions = Some(max_ip_sessions);
        }
        if let Some(max_audio_bytes_per_minute) =
            env_value("VIVA_VOICE_WS_MAX_AUDIO_BYTES_PER_MINUTE")
                .and_then(|value| parse_positive_u64(&value))
        {
            config.voice_limits.max_audio_bytes_per_minute = Some(max_audio_bytes_per_minute);
        }
        if let Some(max_session_cost_usd) = env_value("VIVA_VOICE_WS_MAX_SESSION_COST_USD")
            .and_then(|value| parse_positive_f64(&value))
        {
            config.voice_limits.max_session_cost_usd = Some(max_session_cost_usd);
        }
        if let Some(enabled) =
            env_value("VIVA_PROVIDER_LIMITER_ENABLED").and_then(|value| parse_bool(&value))
        {
            config.voice_limits.provider_limiter_enabled = enabled;
        }
        config.voice_limits.max_provider_concurrent_turns =
            env_value("VIVA_PROVIDER_MAX_CONCURRENT_TURNS")
                .and_then(|value| parse_positive_usize(&value))
                .or(config.voice_limits.max_provider_concurrent_turns);
        config.voice_limits.max_provider_queue_depth = env_value("VIVA_PROVIDER_MAX_QUEUE_DEPTH")
            .and_then(|value| parse_positive_usize(&value))
            .or(config.voice_limits.max_provider_queue_depth);
        config.voice_limits.provider_backoff_default_ms =
            env_value("VIVA_PROVIDER_BACKOFF_DEFAULT_MS")
                .and_then(|value| parse_positive_u64(&value))
                .unwrap_or(config.voice_limits.provider_backoff_default_ms);
        config.voice_limits.provider_backoff_max_ms = env_value("VIVA_PROVIDER_BACKOFF_MAX_MS")
            .and_then(|value| parse_positive_u64(&value))
            .unwrap_or(config.voice_limits.provider_backoff_max_ms);
        config.failure_control = FailureControlConfig::from_env_with(&env_value)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ServiceConfigError> {
        if self.failure_control.enabled() && self.ws_access.session_token_secret.is_none() {
            return Err(ServiceConfigError::FailureControlMisconfigured(
                "session token signing secret required",
            ));
        }
        if self.bind_addr.ip().is_loopback() {
            return Ok(());
        }
        if self.ws_access.required_bearer.is_none() && self.ws_access.session_token_secret.is_none()
        {
            return Err(ServiceConfigError::PublicBindMissingAuth(self.bind_addr));
        }
        if self.ws_access.allowed_origins.is_empty() {
            return Err(ServiceConfigError::PublicBindMissingAllowedOrigins(
                self.bind_addr,
            ));
        }
        Ok(())
    }
}

pub(crate) fn bac_510_max_turn_duration() -> Duration {
    viva_max_submitted_answer_resolution()
}

#[derive(Clone, Debug, PartialEq)]
pub struct VoiceLimitConfig {
    pub max_user_sessions: Option<usize>,
    pub max_ip_sessions: Option<usize>,
    pub max_audio_bytes_per_minute: Option<u64>,
    pub max_session_cost_usd: Option<f64>,
    pub provider_limiter_enabled: bool,
    pub max_provider_concurrent_turns: Option<usize>,
    pub max_provider_queue_depth: Option<usize>,
    pub provider_backoff_default_ms: u64,
    pub provider_backoff_max_ms: u64,
}

impl Default for VoiceLimitConfig {
    fn default() -> Self {
        Self {
            max_user_sessions: None,
            max_ip_sessions: None,
            max_audio_bytes_per_minute: None,
            max_session_cost_usd: None,
            provider_limiter_enabled: true,
            max_provider_concurrent_turns: Some(8),
            max_provider_queue_depth: Some(0),
            provider_backoff_default_ms: 1_000,
            provider_backoff_max_ms: 30_000,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureControlScenario {
    ProviderRateLimited,
    ProviderAuthFailed,
    ProviderTimeout,
    SilentStall,
    ProviderMalformedStream,
    ProviderNetworkDisconnect,
    SonicTtsTimeout,
    RecapTimeout,
    InvalidToken,
    ExpiredToken,
    ReplayedToken,
    MalformedToken,
    SlowStaleSocketClose,
    DoubleSubmitRace,
    MicDenied,
    TypedFallback,
}

impl FailureControlScenario {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "provider_rate_limited" => Some(Self::ProviderRateLimited),
            "provider_auth_failed" => Some(Self::ProviderAuthFailed),
            "provider_timeout" => Some(Self::ProviderTimeout),
            "silent_stall" => Some(Self::SilentStall),
            "provider_malformed_stream" => Some(Self::ProviderMalformedStream),
            "provider_network_disconnect" => Some(Self::ProviderNetworkDisconnect),
            "sonic_tts_timeout" => Some(Self::SonicTtsTimeout),
            "recap_timeout" => Some(Self::RecapTimeout),
            "invalid_token" => Some(Self::InvalidToken),
            "expired_token" => Some(Self::ExpiredToken),
            "replayed_token" => Some(Self::ReplayedToken),
            "malformed_token" => Some(Self::MalformedToken),
            "slow_stale_socket_close" => Some(Self::SlowStaleSocketClose),
            "double_submit_race" => Some(Self::DoubleSubmitRace),
            "mic_denied" => Some(Self::MicDenied),
            "typed_fallback" => Some(Self::TypedFallback),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProviderRateLimited => "provider_rate_limited",
            Self::ProviderAuthFailed => "provider_auth_failed",
            Self::ProviderTimeout => "provider_timeout",
            Self::SilentStall => "silent_stall",
            Self::ProviderMalformedStream => "provider_malformed_stream",
            Self::ProviderNetworkDisconnect => "provider_network_disconnect",
            Self::SonicTtsTimeout => "sonic_tts_timeout",
            Self::RecapTimeout => "recap_timeout",
            Self::InvalidToken => "invalid_token",
            Self::ExpiredToken => "expired_token",
            Self::ReplayedToken => "replayed_token",
            Self::MalformedToken => "malformed_token",
            Self::SlowStaleSocketClose => "slow_stale_socket_close",
            Self::DoubleSubmitRace => "double_submit_race",
            Self::MicDenied => "mic_denied",
            Self::TypedFallback => "typed_fallback",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FailureControlClaim {
    pub scenario: FailureControlScenario,
    pub run_id: String,
    pub expires_at: u64,
    pub nonce: String,
    pub signature: String,
}

#[derive(Clone, Default, Eq, PartialEq)]
pub struct FailureControlConfig {
    enabled: bool,
    scenario: Option<FailureControlScenario>,
    secret: Option<String>,
    synthetic_user_ids: Vec<String>,
    study_set_ids: Vec<String>,
    allowed_origins: Vec<String>,
    max_sessions_per_identity: Option<usize>,
}

impl fmt::Debug for FailureControlConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FailureControlConfig")
            .field("enabled", &self.enabled)
            .field("scenario", &self.scenario)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .field("synthetic_user_ids", &self.synthetic_user_ids)
            .field("study_set_ids", &self.study_set_ids)
            .field("allowed_origins", &self.allowed_origins)
            .field("max_sessions_per_identity", &self.max_sessions_per_identity)
            .finish()
    }
}

impl FailureControlConfig {
    pub fn enabled_for_synthetic_identities(
        scenario: FailureControlScenario,
        secret: impl Into<String>,
        synthetic_user_ids: Vec<String>,
        study_set_ids: Vec<String>,
        allowed_origins: Vec<String>,
        max_sessions_per_identity: usize,
    ) -> Result<Self, ServiceConfigError> {
        let secret = secret.into();
        if max_sessions_per_identity == 0 {
            return Err(ServiceConfigError::FailureControlMisconfigured(
                "per-identity cap required",
            ));
        }
        if secret.trim().is_empty()
            || synthetic_user_ids.is_empty()
            || study_set_ids.is_empty()
            || allowed_origins.is_empty()
        {
            return Err(ServiceConfigError::FailureControlMisconfigured(
                "all failure-control gates required",
            ));
        }
        Ok(Self {
            enabled: true,
            scenario: Some(scenario),
            secret: Some(secret),
            synthetic_user_ids,
            study_set_ids,
            allowed_origins,
            max_sessions_per_identity: Some(max_sessions_per_identity),
        })
    }

    fn from_env_with(
        env_value: &impl Fn(&str) -> Option<String>,
    ) -> Result<Self, ServiceConfigError> {
        if env_value("VIVA_FAILURE_CONTROL_ENABLED").as_deref() != Some("1") {
            return Ok(Self::default());
        }
        let scenario = env_value("VIVA_FAILURE_CONTROL_SCENARIO")
            .as_deref()
            .and_then(FailureControlScenario::parse)
            .ok_or(ServiceConfigError::FailureControlMisconfigured(
                "valid scenario required",
            ))?;
        let secret = required_failure_control_value(
            env_value,
            "VIVA_FAILURE_CONTROL_SECRET",
            "control secret required",
        )?;
        let synthetic_user_ids = required_failure_control_list(
            env_value,
            "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS",
            "synthetic identity allowlist required",
        )?;
        let study_set_ids = required_failure_control_list(
            env_value,
            "VIVA_FAILURE_CONTROL_STUDY_SET_IDS",
            "study-set allowlist required",
        )?;
        let allowed_origins = required_failure_control_list(
            env_value,
            "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS",
            "origin allowlist required",
        )?;
        let max_sessions_per_identity = env_value("VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY")
            .and_then(|value| parse_positive_usize(&value))
            .ok_or(ServiceConfigError::FailureControlMisconfigured(
                "per-identity cap required",
            ))?;

        Ok(Self {
            enabled: true,
            scenario: Some(scenario),
            secret: Some(secret),
            synthetic_user_ids,
            study_set_ids,
            allowed_origins,
            max_sessions_per_identity: Some(max_sessions_per_identity),
        })
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn scenario(&self) -> Option<FailureControlScenario> {
        self.scenario
    }

    pub fn max_sessions_per_identity(&self) -> Option<usize> {
        self.max_sessions_per_identity
    }

    pub fn allows_identity(&self, user_id: &str, study_set_id: &str, origin: &str) -> bool {
        self.enabled
            && contains_str(&self.synthetic_user_ids, user_id)
            && contains_str(&self.study_set_ids, study_set_id)
            && self
                .allowed_origins
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(origin))
    }

    pub fn signed_claim_for(
        &self,
        request: FailureControlClaimRequest<'_>,
    ) -> Result<FailureControlClaim, SessionTokenError> {
        if !self.allows_identity(request.user_id, request.study_set_id, request.origin) {
            return Err(SessionTokenError::Invalid);
        }
        let scenario = self.scenario.ok_or(SessionTokenError::Invalid)?;
        let expires_at = request
            .now
            .checked_add(15 * 60)
            .ok_or(SessionTokenError::Invalid)?;
        let signature = self.sign_claim_payload(&FailureControlClaimPayload {
            scenario,
            user_id: request.user_id,
            study_set_id: request.study_set_id,
            session_id: request.session_id,
            origin: request.origin,
            run_id: request.run_id,
            expires_at,
            nonce: request.nonce,
        })?;
        Ok(FailureControlClaim {
            scenario,
            run_id: request.run_id.to_owned(),
            expires_at,
            nonce: request.nonce.to_owned(),
            signature,
        })
    }

    pub fn validate_claim(
        &self,
        claim: &FailureControlClaim,
        user_id: &str,
        study_set_id: &str,
        session_id: &str,
        origin: &str,
        now: u64,
    ) -> Result<FailureControlScenario, SessionTokenError> {
        if !self.allows_identity(user_id, study_set_id, origin) {
            return Err(SessionTokenError::Invalid);
        }
        if Some(claim.scenario) != self.scenario {
            return Err(SessionTokenError::Invalid);
        }
        if claim.run_id.trim().is_empty() || claim.nonce.trim().is_empty() {
            return Err(SessionTokenError::Invalid);
        }
        if claim.expires_at <= now {
            return Err(SessionTokenError::Expired);
        }
        let expected = self.sign_claim_payload(&FailureControlClaimPayload {
            scenario: claim.scenario,
            user_id,
            study_set_id,
            session_id,
            origin,
            run_id: &claim.run_id,
            expires_at: claim.expires_at,
            nonce: &claim.nonce,
        })?;
        if !constant_time_eq(expected.as_bytes(), claim.signature.as_bytes()) {
            return Err(SessionTokenError::Invalid);
        }
        Ok(claim.scenario)
    }

    fn sign_claim_payload(
        &self,
        payload: &FailureControlClaimPayload<'_>,
    ) -> Result<String, SessionTokenError> {
        let secret = self.secret.as_deref().ok_or(SessionTokenError::Invalid)?;
        let payload = format!(
            "viva-failure-control.v1\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
            payload.scenario.as_str(),
            payload.user_id,
            payload.study_set_id,
            payload.session_id,
            payload.origin,
            payload.run_id,
            payload.expires_at,
            payload.nonce
        );
        let signature = sign_payload(secret, payload.as_bytes())?;
        Ok(URL_SAFE_NO_PAD.encode(signature))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FailureControlClaimRequest<'a> {
    pub user_id: &'a str,
    pub study_set_id: &'a str,
    pub session_id: &'a str,
    pub origin: &'a str,
    pub run_id: &'a str,
    pub now: u64,
    pub nonce: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FailureControlClaimPayload<'a> {
    scenario: FailureControlScenario,
    user_id: &'a str,
    study_set_id: &'a str,
    session_id: &'a str,
    origin: &'a str,
    run_id: &'a str,
    expires_at: u64,
    nonce: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RealtimeProvider {
    Synthetic,
    FakeCartesiaGemini,
    CartesiaGemini,
}

impl RealtimeProvider {
    pub fn parse(value: &str) -> Result<Self, ServiceConfigError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "synthetic" => Ok(Self::Synthetic),
            "fake_cartesia_gemini" | "fake-cartesia-gemini" => Ok(Self::FakeCartesiaGemini),
            "cartesia_gemini" | "cartesia-gemini" => Ok(Self::CartesiaGemini),
            unsupported => Err(ServiceConfigError::UnsupportedRealtimeProvider(
                unsupported.to_owned(),
            )),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Synthetic => "synthetic",
            Self::FakeCartesiaGemini => "fake_cartesia_gemini",
            Self::CartesiaGemini => "cartesia_gemini",
        }
    }
}

pub async fn build_study_store(
    config: &ServiceConfig,
) -> Result<Arc<dyn StudyMemoryStore>, ServiceConfigError> {
    let Some(database_url) = &config.database_url else {
        return Ok(Arc::new(data::InMemoryStudyStore::seeded_fixture()));
    };
    let pg_config = data::PgConfig::new(database_url.clone());
    let pool = data::connect_pg(&pg_config)
        .await
        .map_err(|error| ServiceConfigError::StudyStoreInit(error.to_string()))?;
    data::run_migrations(&pool)
        .await
        .map_err(|error| ServiceConfigError::StudyStoreInit(error.to_string()))?;
    data::seed_postgres_fixture(&pool)
        .await
        .map_err(|error| ServiceConfigError::StudyStoreInit(error.to_string()))?;
    Ok(Arc::new(data::PostgresStudyStore::new(pool)))
}

pub fn validate_runtime_store_preflight(
    config: &ServiceConfig,
    store: &StudyStoreCapabilities,
) -> Result<(), ServiceConfigError> {
    if config.ws_access.session_token_secret.is_none() {
        return Ok(());
    }
    if config.bind_addr.ip().is_loopback()
        && config.failure_control.enabled()
        && store.nonce_replay_protection
    {
        return Ok(());
    }
    if !store.available {
        return Err(ServiceConfigError::SignedSessionStoreUnavailable(
            store.backend.as_str(),
        ));
    }
    if !store.durable {
        return Err(ServiceConfigError::DurableStoreRequiredForSignedSessions(
            store.backend.as_str(),
        ));
    }
    if !store.nonce_replay_protection {
        return Err(
            ServiceConfigError::NonceReplayProtectionRequiredForSignedSessions(
                store.backend.as_str(),
            ),
        );
    }
    Ok(())
}

pub fn build_brain(
    config: &ServiceConfig,
    study_store: Arc<dyn StudyMemoryStore>,
) -> Arc<dyn RealtimeBrain> {
    match config.provider {
        RealtimeProvider::Synthetic => Arc::new(SyntheticBrain::with_study_store(study_store)),
        RealtimeProvider::FakeCartesiaGemini => {
            Arc::new(FakeCartesiaGeminiRuntime::new(study_store))
        }
        RealtimeProvider::CartesiaGemini => Arc::new(CartesiaGeminiBrain::new(
            CartesiaGeminiConfig::from_env(),
            study_store,
        )),
    }
}

fn parse_positive_u64(value: &str) -> Option<u64> {
    value.parse::<u64>().ok().filter(|parsed| *parsed > 0)
}

fn parse_positive_usize(value: &str) -> Option<usize> {
    value.parse::<usize>().ok().filter(|parsed| *parsed > 0)
}

fn parse_positive_f64(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|parsed| parsed.is_finite() && *parsed > 0.0)
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn required_failure_control_value(
    env_value: &impl Fn(&str) -> Option<String>,
    name: &str,
    error: &'static str,
) -> Result<String, ServiceConfigError> {
    env_value(name).ok_or(ServiceConfigError::FailureControlMisconfigured(error))
}

fn required_failure_control_list(
    env_value: &impl Fn(&str) -> Option<String>,
    name: &str,
    error: &'static str,
) -> Result<Vec<String>, ServiceConfigError> {
    let values = required_failure_control_value(env_value, name, error)?
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Err(ServiceConfigError::FailureControlMisconfigured(error));
    }
    Ok(values)
}

fn contains_str(values: &[String], needle: &str) -> bool {
    values.iter().any(|value| value == needle)
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ServiceConfigError {
    #[error("unsupported realtime provider `{0}`; selectable providers are `synthetic`, `fake_cartesia_gemini`, and gated `cartesia_gemini`")]
    UnsupportedRealtimeProvider(String),
    #[error("study store initialization failed: {0}")]
    StudyStoreInit(String),
    #[error("public or non-loopback bind `{0}` requires VIVA_VOICE_WS_BEARER_TOKEN or VIVA_VOICE_SESSION_TOKEN_SECRET")]
    PublicBindMissingAuth(SocketAddr),
    #[error("public or non-loopback bind `{0}` requires VIVA_VOICE_WS_ALLOWED_ORIGINS")]
    PublicBindMissingAllowedOrigins(SocketAddr),
    #[error("failure-control misconfigured: {0}")]
    FailureControlMisconfigured(&'static str),
    #[error("signed-session store `{0}` is unavailable")]
    SignedSessionStoreUnavailable(&'static str),
    #[error("public signed-session mode requires a durable store; configured store is `{0}`")]
    DurableStoreRequiredForSignedSessions(&'static str),
    #[error(
        "public signed-session mode requires nonce replay protection; configured store is `{0}`"
    )]
    NonceReplayProtectionRequiredForSignedSessions(&'static str),
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct VoiceWsAccess {
    pub required_bearer: Option<String>,
    pub session_token_secret: Option<String>,
    pub allowed_origins: Vec<String>,
}

impl VoiceWsAccess {
    pub fn validate_headers(&self, headers: &HeaderMap) -> Result<(), VoiceWsAccessError> {
        if !self.allowed_origins.is_empty() {
            let origin = headers
                .get("origin")
                .and_then(|value| value.to_str().ok())
                .ok_or(VoiceWsAccessError::OriginDenied)?;
            if !self
                .allowed_origins
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(origin))
            {
                return Err(VoiceWsAccessError::OriginDenied);
            }
        }

        self.validate_ws_bearer_headers(headers)
    }

    pub fn validate_bearer_headers(&self, headers: &HeaderMap) -> Result<(), VoiceWsAccessError> {
        let Some(required) = &self.required_bearer else {
            return Ok(());
        };
        let Some(provided) = authorization_bearer_from_headers(headers) else {
            return Err(VoiceWsAccessError::MissingBearer);
        };
        if constant_time_eq(required.as_bytes(), provided.as_bytes()) {
            return Ok(());
        }
        Err(VoiceWsAccessError::InvalidBearer)
    }

    fn validate_ws_bearer_headers(&self, headers: &HeaderMap) -> Result<(), VoiceWsAccessError> {
        let Some(required) = &self.required_bearer else {
            return Ok(());
        };
        let Some(provided) = bearer_from_headers(headers) else {
            return Err(VoiceWsAccessError::MissingBearer);
        };
        if constant_time_eq(required.as_bytes(), provided.as_bytes()) {
            return Ok(());
        }
        if self
            .session_token_secret
            .as_deref()
            .and_then(|secret| SessionTokenClaims::verify(&provided, secret).ok())
            .is_some()
        {
            return Ok(());
        }
        Err(VoiceWsAccessError::InvalidBearer)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionTokenClaims {
    pub user_id: String,
    pub study_set_id: String,
    pub session_id: String,
    pub expires_at: u64,
    pub nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_control: Option<FailureControlClaim>,
}

pub const EXPIRY_CLOCK_SKEW_SECONDS: u64 = 60;

impl SessionTokenClaims {
    pub fn sign(&self, secret: &str) -> Result<String, SessionTokenError> {
        if secret.is_empty() || !self.has_required_claims() {
            return Err(SessionTokenError::Invalid);
        }
        let claims_json = serde_json::to_vec(self).map_err(|_| SessionTokenError::Invalid)?;
        let claims = URL_SAFE_NO_PAD.encode(claims_json);
        let payload = format!("viva1.{claims}");
        let signature = sign_payload(secret, payload.as_bytes())?;
        Ok(format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature)))
    }

    pub fn verify(token: &str, secret: &str) -> Result<Self, SessionTokenError> {
        Self::verify_at(token, secret, unix_timestamp_now()?)
    }

    fn verify_at(token: &str, secret: &str, now: u64) -> Result<Self, SessionTokenError> {
        if secret.is_empty() {
            return Err(SessionTokenError::Invalid);
        }
        let mut parts = token.split('.');
        let Some(prefix) = parts.next() else {
            return Err(SessionTokenError::Malformed);
        };
        let Some(claims_part) = parts.next() else {
            return Err(SessionTokenError::Malformed);
        };
        let Some(signature_part) = parts.next() else {
            return Err(SessionTokenError::Malformed);
        };
        if parts.next().is_some() || prefix != "viva1" {
            return Err(SessionTokenError::Malformed);
        }

        let signed_payload = format!("{prefix}.{claims_part}");
        let provided_signature = URL_SAFE_NO_PAD
            .decode(signature_part)
            .map_err(|_| SessionTokenError::Malformed)?;
        let expected_signature = sign_payload(secret, signed_payload.as_bytes())?;
        if !constant_time_eq(&expected_signature, &provided_signature) {
            return Err(SessionTokenError::Invalid);
        }

        let claims_bytes = URL_SAFE_NO_PAD
            .decode(claims_part)
            .map_err(|_| SessionTokenError::Malformed)?;
        let claims: Self =
            serde_json::from_slice(&claims_bytes).map_err(|_| SessionTokenError::Malformed)?;
        if !claims.has_required_claims() {
            return Err(SessionTokenError::Malformed);
        }
        if claims.expires_at.saturating_add(EXPIRY_CLOCK_SKEW_SECONDS) < now {
            return Err(SessionTokenError::Expired);
        }
        Ok(claims)
    }

    fn has_required_claims(&self) -> bool {
        !self.user_id.trim().is_empty()
            && !self.study_set_id.trim().is_empty()
            && !self.session_id.trim().is_empty()
            && !self.nonce.trim().is_empty()
            && self
                .failure_control
                .as_ref()
                .map(|claim| {
                    !claim.run_id.trim().is_empty()
                        && !claim.nonce.trim().is_empty()
                        && !claim.signature.trim().is_empty()
                })
                .unwrap_or(true)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SessionTokenError {
    #[error("malformed session token")]
    Malformed,
    #[error("invalid session token")]
    Invalid,
    #[error("expired session token")]
    Expired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionAuthFailureCode {
    Expired,
    Replayed,
    Malformed,
    InvalidSignature,
    IdentityMismatch,
    AccessDenied,
}

impl SessionAuthFailureCode {
    pub fn from_token_error(error: &SessionTokenError) -> Self {
        match error {
            SessionTokenError::Expired => Self::Expired,
            SessionTokenError::Malformed => Self::Malformed,
            SessionTokenError::Invalid => Self::InvalidSignature,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::Replayed => "replayed",
            Self::Malformed => "malformed",
            Self::InvalidSignature => "invalid_signature",
            Self::IdentityMismatch => "identity_mismatch",
            Self::AccessDenied => "access_denied",
        }
    }

    pub fn client_class(self) -> &'static str {
        match self {
            Self::Expired => "recoverable",
            Self::Replayed
            | Self::Malformed
            | Self::InvalidSignature
            | Self::IdentityMismatch
            | Self::AccessDenied => "terminal",
        }
    }

    pub fn retry_eligible(self) -> bool {
        matches!(self, Self::Expired)
    }

    pub fn stage(self) -> &'static str {
        "session"
    }

    pub fn evidence_field(self) -> &'static str {
        "session_auth_failure_code"
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum VoiceWsAccessError {
    #[error("origin is not allowed")]
    OriginDenied,
    #[error("missing bearer token")]
    MissingBearer,
    #[error("invalid bearer token")]
    InvalidBearer,
}

fn bearer_from_headers(headers: &HeaderMap) -> Option<String> {
    authorization_bearer_from_headers(headers).or_else(|| {
        headers
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .and_then(protocol_bearer)
    })
}

fn authorization_bearer_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(ToOwned::to_owned)
}

fn protocol_bearer(value: &str) -> Option<String> {
    value.split(',').map(str::trim).find_map(|protocol| {
        protocol.strip_prefix("bearer.").and_then(|encoded| {
            URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
        })
    })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in a.iter().zip(b) {
        diff |= left ^ right;
    }
    diff == 0
}

fn sign_payload(secret: &str, payload: &[u8]) -> Result<Vec<u8>, SessionTokenError> {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| SessionTokenError::Invalid)?;
    mac.update(payload);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn unix_timestamp_now() -> Result<u64, SessionTokenError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| SessionTokenError::Invalid)
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use crate::WsTimeouts;

    use super::*;

    #[test]
    fn validates_bearer_from_authorization_or_ws_protocol() {
        let access = VoiceWsAccess {
            required_bearer: Some("secret".to_owned()),
            session_token_secret: None,
            allowed_origins: vec![],
        };
        let mut headers = HeaderMap::new();

        assert_eq!(
            access.validate_headers(&headers),
            Err(VoiceWsAccessError::MissingBearer)
        );

        headers.insert("authorization", HeaderValue::from_static("Bearer secret"));
        assert_eq!(access.validate_headers(&headers), Ok(()));

        headers.remove("authorization");
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static("viva-voice, bearer.c2VjcmV0"),
        );
        assert_eq!(access.validate_headers(&headers), Ok(()));
    }

    #[test]
    fn validates_signed_session_token_protocol_when_rest_bearer_is_configured() {
        let access = VoiceWsAccess {
            required_bearer: Some("rest-secret".to_owned()),
            session_token_secret: Some("session-secret".to_owned()),
            allowed_origins: vec!["https://web.example".to_owned()],
        };
        let token = SessionTokenClaims {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            session_id: "voice-session-1".to_owned(),
            expires_at: unix_timestamp_now().expect("time should be available") + 60,
            nonce: "nonce-1".to_owned(),
            failure_control: None,
        }
        .sign("session-secret")
        .expect("token should sign");
        let protocol = format!("viva-voice, bearer.{}", URL_SAFE_NO_PAD.encode(&token));
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static("https://web.example"));
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&protocol).expect("protocol should be valid"),
        );

        assert_eq!(access.validate_headers(&headers), Ok(()));
        assert_eq!(
            access.validate_bearer_headers(&headers),
            Err(VoiceWsAccessError::MissingBearer)
        );
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {token}")).expect("header should be valid"),
        );
        assert_eq!(
            access.validate_bearer_headers(&headers),
            Err(VoiceWsAccessError::InvalidBearer)
        );
    }

    #[test]
    fn validates_allowed_origins() {
        let access = VoiceWsAccess {
            required_bearer: None,
            session_token_secret: None,
            allowed_origins: vec!["http://localhost:3000".to_owned()],
        };
        let mut headers = HeaderMap::new();

        assert_eq!(
            access.validate_headers(&headers),
            Err(VoiceWsAccessError::OriginDenied)
        );

        headers.insert("origin", HeaderValue::from_static("http://localhost:3000"));
        assert_eq!(access.validate_headers(&headers), Ok(()));
    }

    #[test]
    fn service_config_validation_accepts_loopback_defaults() {
        assert_eq!(ServiceConfig::default().validate(), Ok(()));

        let ipv6_loopback = ServiceConfig {
            bind_addr: "[::1]:4318".parse().expect("valid ipv6 loopback bind"),
            ..ServiceConfig::default()
        };
        assert_eq!(ipv6_loopback.validate(), Ok(()));
    }

    #[test]
    fn default_turn_timeout_matches_bac_510_outer_bound() {
        assert_eq!(
            ServiceConfig::default().max_turn_duration,
            Duration::from_secs(45)
        );
    }

    #[test]
    fn default_turn_timeout_is_loaded_from_bac_510_contract() {
        assert_eq!(
            ServiceConfig::default().max_turn_duration,
            bac_510_max_turn_duration()
        );
    }

    #[test]
    fn default_websocket_turn_timeout_matches_bac_510_outer_bound() {
        assert_eq!(WsTimeouts::default().idle, bac_510_max_turn_duration());
    }

    #[test]
    fn from_env_caps_turn_timeout_to_bac_510_outer_bound() {
        let config = ServiceConfig::from_env_with(|name| match name {
            "VIVA_VOICE_WS_TURN_SECONDS" => Some("120".to_owned()),
            _ => None,
        })
        .expect("loopback turn timeout config should validate");

        assert_eq!(config.max_turn_duration, bac_510_max_turn_duration());
        assert!(config.max_turn_duration_overridden);
    }

    #[test]
    fn from_env_parses_voice_timeout_and_limit_knobs() {
        let config = ServiceConfig::from_env_with(|name| match name {
            "VIVA_VOICE_WS_SESSION_SECONDS" => Some("1800".to_owned()),
            "VIVA_VOICE_WS_TURN_SECONDS" => Some("45".to_owned()),
            "VIVA_VOICE_WS_MAX_USER_SESSIONS" => Some("2".to_owned()),
            "VIVA_VOICE_WS_MAX_IP_SESSIONS" => Some("5".to_owned()),
            "VIVA_VOICE_WS_MAX_AUDIO_BYTES_PER_MINUTE" => Some("48000".to_owned()),
            "VIVA_VOICE_WS_MAX_SESSION_COST_USD" => Some("0.75".to_owned()),
            _ => None,
        })
        .expect("loopback voice limit config should validate");

        assert_eq!(config.max_session_duration, Duration::from_secs(1800));
        assert_eq!(config.max_turn_duration, Duration::from_secs(45));
        assert!(config.max_turn_duration_overridden);
        assert_eq!(config.voice_limits.max_user_sessions, Some(2));
        assert_eq!(config.voice_limits.max_ip_sessions, Some(5));
        assert_eq!(config.voice_limits.max_audio_bytes_per_minute, Some(48_000));
        assert_eq!(config.voice_limits.max_session_cost_usd, Some(0.75));
        assert!(config.voice_limits.provider_limiter_enabled);
        assert_eq!(config.voice_limits.max_provider_concurrent_turns, Some(8));
        assert_eq!(config.voice_limits.max_provider_queue_depth, Some(0));
        assert_eq!(config.voice_limits.provider_backoff_default_ms, 1_000);
        assert_eq!(config.voice_limits.provider_backoff_max_ms, 30_000);

        let disabled = ServiceConfig::from_env_with(|name| match name {
            "VIVA_VOICE_WS_SESSION_SECONDS" => Some("0".to_owned()),
            "VIVA_VOICE_WS_TURN_SECONDS" => Some("-1".to_owned()),
            "VIVA_VOICE_WS_MAX_USER_SESSIONS" => Some("0".to_owned()),
            "VIVA_VOICE_WS_MAX_IP_SESSIONS" => Some("0".to_owned()),
            "VIVA_VOICE_WS_MAX_AUDIO_BYTES_PER_MINUTE" => Some("0".to_owned()),
            "VIVA_VOICE_WS_MAX_SESSION_COST_USD" => Some("NaN".to_owned()),
            _ => None,
        })
        .expect("invalid loopback voice limit values should be ignored");

        assert_eq!(
            disabled.max_session_duration,
            ServiceConfig::default().max_session_duration
        );
        assert_eq!(
            disabled.max_turn_duration,
            ServiceConfig::default().max_turn_duration
        );
        assert!(!disabled.max_turn_duration_overridden);
        assert_eq!(disabled.voice_limits, VoiceLimitConfig::default());
    }

    #[test]
    fn voice_limits_default_user_total_cap_to_opt_in() {
        assert_eq!(VoiceLimitConfig::default().max_user_sessions, None);
    }

    #[test]
    fn from_env_parses_provider_limiter_knobs() {
        let config = ServiceConfig::from_env_with(|name| match name {
            "VIVA_PROVIDER_LIMITER_ENABLED" => Some("false".to_owned()),
            "VIVA_PROVIDER_MAX_CONCURRENT_TURNS" => Some("2".to_owned()),
            "VIVA_PROVIDER_MAX_QUEUE_DEPTH" => Some("3".to_owned()),
            "VIVA_PROVIDER_BACKOFF_DEFAULT_MS" => Some("250".to_owned()),
            "VIVA_PROVIDER_BACKOFF_MAX_MS" => Some("5000".to_owned()),
            _ => None,
        })
        .expect("loopback provider limiter config should validate");

        assert!(!config.voice_limits.provider_limiter_enabled);
        assert_eq!(config.voice_limits.max_provider_concurrent_turns, Some(2));
        assert_eq!(config.voice_limits.max_provider_queue_depth, Some(3));
        assert_eq!(config.voice_limits.provider_backoff_default_ms, 250);
        assert_eq!(config.voice_limits.provider_backoff_max_ms, 5_000);
    }

    #[test]
    fn from_env_parses_failure_control_gate_fail_closed() {
        let disabled = ServiceConfig::from_env_with(|_| None)
            .expect("default failure controls should stay hard off");
        assert!(!disabled.failure_control.enabled());

        let missing_secret = ServiceConfig::from_env_with(|name| match name {
            "VIVA_FAILURE_CONTROL_ENABLED" => Some("1".to_owned()),
            "VIVA_FAILURE_CONTROL_SCENARIO" => Some("provider_rate_limited".to_owned()),
            "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS" => Some("synthetic-user".to_owned()),
            "VIVA_FAILURE_CONTROL_STUDY_SET_IDS" => Some("biology-midterm".to_owned()),
            "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS" => Some("https://viva.example".to_owned()),
            "VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY" => Some("1".to_owned()),
            _ => None,
        })
        .expect_err("enabled failure control must require a signed-control secret");
        assert_eq!(
            missing_secret,
            ServiceConfigError::FailureControlMisconfigured("control secret required")
        );

        let enabled = ServiceConfig::from_env_with(|name| match name {
            "VIVA_FAILURE_CONTROL_ENABLED" => Some("1".to_owned()),
            "VIVA_FAILURE_CONTROL_SCENARIO" => Some(" provider_rate_limited ".to_owned()),
            "VIVA_FAILURE_CONTROL_SECRET" => Some(" control-secret ".to_owned()),
            "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS" => Some(" synthetic-user ".to_owned()),
            "VIVA_FAILURE_CONTROL_STUDY_SET_IDS" => Some(" biology-midterm ".to_owned()),
            "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS" => Some(" https://viva.example ".to_owned()),
            "VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY" => Some("1".to_owned()),
            "VIVA_VOICE_SESSION_TOKEN_SECRET" => Some("session-secret".to_owned()),
            _ => None,
        })
        .expect("fully gated failure control should parse");

        assert!(enabled.failure_control.enabled());
        assert_eq!(
            enabled.failure_control.scenario(),
            Some(FailureControlScenario::ProviderRateLimited)
        );
        assert!(enabled.failure_control.allows_identity(
            "synthetic-user",
            "biology-midterm",
            "https://viva.example"
        ));
        assert!(!enabled.failure_control.allows_identity(
            "learner-user",
            "biology-midterm",
            "https://viva.example"
        ));
    }

    #[test]
    fn from_env_rejects_enabled_failure_control_without_session_token_signing() {
        let error = ServiceConfig::from_env_with(|name| match name {
            "VIVA_FAILURE_CONTROL_ENABLED" => Some("1".to_owned()),
            "VIVA_FAILURE_CONTROL_SCENARIO" => Some("provider_rate_limited".to_owned()),
            "VIVA_FAILURE_CONTROL_SECRET" => Some("control-secret".to_owned()),
            "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS" => Some("synthetic-user".to_owned()),
            "VIVA_FAILURE_CONTROL_STUDY_SET_IDS" => Some("biology-midterm".to_owned()),
            "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS" => Some("https://viva.example".to_owned()),
            "VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY" => Some("1".to_owned()),
            _ => None,
        })
        .expect_err("enabled failure control must require signed session-token auth");

        assert_eq!(
            error,
            ServiceConfigError::FailureControlMisconfigured(
                "session token signing secret required"
            )
        );
    }

    #[test]
    fn failure_control_claim_is_signed_and_bound_to_synthetic_identity() {
        let config = ServiceConfig::from_env_with(|name| match name {
            "VIVA_FAILURE_CONTROL_ENABLED" => Some("1".to_owned()),
            "VIVA_FAILURE_CONTROL_SCENARIO" => Some("provider_rate_limited".to_owned()),
            "VIVA_FAILURE_CONTROL_SECRET" => Some("control-secret".to_owned()),
            "VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS" => Some("synthetic-user".to_owned()),
            "VIVA_FAILURE_CONTROL_STUDY_SET_IDS" => Some("biology-midterm".to_owned()),
            "VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS" => Some("https://viva.example".to_owned()),
            "VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY" => Some("1".to_owned()),
            "VIVA_VOICE_SESSION_TOKEN_SECRET" => Some("session-secret".to_owned()),
            _ => None,
        })
        .expect("fully gated failure control should parse");
        let claim = config
            .failure_control
            .signed_claim_for(FailureControlClaimRequest {
                user_id: "synthetic-user",
                study_set_id: "biology-midterm",
                session_id: "voice-session-control",
                origin: "https://viva.example",
                run_id: "run-1",
                now: 100,
                nonce: "nonce-1",
            })
            .expect("allowed synthetic identity should receive a signed control claim");

        assert_eq!(
            config.failure_control.validate_claim(
                &claim,
                "synthetic-user",
                "biology-midterm",
                "voice-session-control",
                "https://viva.example",
                100
            ),
            Ok(FailureControlScenario::ProviderRateLimited)
        );
        assert!(config
            .failure_control
            .validate_claim(
                &claim,
                "learner-user",
                "biology-midterm",
                "voice-session-control",
                "https://viva.example",
                100
            )
            .is_err());
        assert!(config
            .failure_control
            .validate_claim(
                &claim,
                "synthetic-user",
                "biology-midterm",
                "voice-session-control",
                "https://evil.example",
                100
            )
            .is_err());
    }

    #[test]
    fn service_config_validation_rejects_public_bind_without_bearer_or_origins() {
        for bind_addr in ["0.0.0.0:4318", "[::]:4318", "203.0.113.10:4318"] {
            let bind_addr: SocketAddr = bind_addr.parse().expect("valid public bind");
            let config = ServiceConfig {
                bind_addr,
                ..ServiceConfig::default()
            };
            assert_eq!(
                config.validate(),
                Err(ServiceConfigError::PublicBindMissingAuth(bind_addr))
            );
        }

        let bind_addr = "0.0.0.0:4318".parse().expect("valid public bind");
        let bearer_only = ServiceConfig {
            bind_addr,
            ws_access: VoiceWsAccess {
                required_bearer: Some("secret".to_owned()),
                session_token_secret: None,
                allowed_origins: vec![],
            },
            ..ServiceConfig::default()
        };
        assert_eq!(
            bearer_only.validate(),
            Err(ServiceConfigError::PublicBindMissingAllowedOrigins(
                bind_addr
            ))
        );
    }

    #[test]
    fn service_config_validation_accepts_public_bind_with_bearer_and_origins() {
        let config = ServiceConfig {
            bind_addr: "0.0.0.0:4318".parse().expect("valid public bind"),
            ws_access: VoiceWsAccess {
                required_bearer: Some("secret".to_owned()),
                session_token_secret: None,
                allowed_origins: vec!["https://app.example".to_owned()],
            },
            ..ServiceConfig::default()
        };

        assert_eq!(config.validate(), Ok(()));
    }

    #[test]
    fn from_env_validates_public_bind_before_startup_uses_config() {
        let err = ServiceConfig::from_env_with(|name| match name {
            "VIVA_AGENT_BIND_ADDR" => Some("0.0.0.0:4318".to_owned()),
            _ => None,
        })
        .expect_err("public bind without ws access should fail config validation");
        assert_eq!(
            err,
            ServiceConfigError::PublicBindMissingAuth(
                "0.0.0.0:4318".parse().expect("valid public bind")
            )
        );

        let config = ServiceConfig::from_env_with(|name| match name {
            "VIVA_AGENT_BIND_ADDR" => Some("0.0.0.0:4318".to_owned()),
            "VIVA_VOICE_WS_BEARER_TOKEN" => Some("secret".to_owned()),
            "VIVA_VOICE_WS_ALLOWED_ORIGINS" => Some("https://app.example".to_owned()),
            _ => None,
        })
        .expect("public bind with bearer and origins should validate");

        assert_eq!(
            config.bind_addr,
            "0.0.0.0:4318".parse().expect("valid public bind")
        );
        assert_eq!(config.ws_access.required_bearer, Some("secret".to_owned()));
        assert_eq!(
            config.ws_access.allowed_origins,
            vec!["https://app.example".to_owned()]
        );
    }

    #[test]
    fn service_config_validation_accepts_public_bind_with_session_token_secret_and_origins() {
        let config = ServiceConfig {
            bind_addr: "0.0.0.0:4318".parse().expect("valid public bind"),
            ws_access: VoiceWsAccess {
                required_bearer: None,
                session_token_secret: Some("session-secret".to_owned()),
                allowed_origins: vec!["https://app.example".to_owned()],
            },
            ..ServiceConfig::default()
        };

        assert_eq!(config.validate(), Ok(()));
    }

    #[test]
    fn service_config_validation_accepts_rest_bearer_plus_session_token_signing() {
        let config = ServiceConfig {
            bind_addr: "0.0.0.0:4318".parse().expect("valid public bind"),
            ws_access: VoiceWsAccess {
                required_bearer: Some("secret".to_owned()),
                session_token_secret: Some("session-secret".to_owned()),
                allowed_origins: vec!["https://app.example".to_owned()],
            },
            ..ServiceConfig::default()
        };

        assert_eq!(config.validate(), Ok(()));
    }

    #[test]
    fn session_tokens_verify_signature_shape_and_expiry() {
        let claims = SessionTokenClaims {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            session_id: "voice-session-1".to_owned(),
            expires_at: 100,
            nonce: "nonce-1".to_owned(),
            failure_control: None,
        };
        let token = claims.sign("secret").expect("token should sign");

        assert_eq!(
            SessionTokenClaims::verify_at(&token, "secret", 99),
            Ok(claims.clone())
        );
        assert_eq!(
            SessionTokenClaims::verify_at(&token, "wrong-secret", 99),
            Err(SessionTokenError::Invalid)
        );
        assert_eq!(
            SessionTokenClaims::verify_at(&token, "secret", 100),
            Ok(claims.clone())
        );
        assert_eq!(
            SessionTokenClaims::verify_at(&token, "secret", 160),
            Ok(claims.clone())
        );
        assert_eq!(
            SessionTokenClaims::verify_at(&token, "secret", 161),
            Err(SessionTokenError::Expired)
        );
        assert_eq!(
            SessionTokenClaims::verify_at("viva1.not-json.not-signature", "secret", 99),
            Err(SessionTokenError::Malformed)
        );
        assert_eq!(
            SessionTokenClaims::verify_at("not-a-viva-token", "secret", 99),
            Err(SessionTokenError::Malformed)
        );
        let malformed_claims = serde_json::json!({
            "user_id": "",
            "study_set_id": "biology-midterm",
            "session_id": "voice-session-1",
            "expires_at": 100,
            "nonce": "nonce-1",
        });
        let malformed_claims =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&malformed_claims).unwrap());
        let malformed_payload = ["viva1", malformed_claims.as_str()].join(".");
        let malformed_signature =
            URL_SAFE_NO_PAD.encode(sign_payload("secret", malformed_payload.as_bytes()).unwrap());
        let signed_malformed_claims = format!("{malformed_payload}.{malformed_signature}");
        assert_eq!(
            SessionTokenClaims::verify_at(&signed_malformed_claims, "secret", 99),
            Err(SessionTokenError::Malformed)
        );
    }

    #[test]
    fn session_auth_failure_codes_map_to_coarse_client_classes() {
        assert_eq!(
            SessionAuthFailureCode::from_token_error(&SessionTokenError::Expired),
            SessionAuthFailureCode::Expired
        );
        assert_eq!(
            SessionAuthFailureCode::from_token_error(&SessionTokenError::Malformed),
            SessionAuthFailureCode::Malformed
        );
        assert_eq!(
            SessionAuthFailureCode::from_token_error(&SessionTokenError::Invalid),
            SessionAuthFailureCode::InvalidSignature
        );
        for code in [
            SessionAuthFailureCode::Expired,
            SessionAuthFailureCode::Replayed,
            SessionAuthFailureCode::Malformed,
            SessionAuthFailureCode::InvalidSignature,
            SessionAuthFailureCode::IdentityMismatch,
            SessionAuthFailureCode::AccessDenied,
        ] {
            assert!(!code.as_str().contains("secret"));
            assert!(matches!(code.stage(), "session"));
            assert!(matches!(code.evidence_field(), "session_auth_failure_code"));
            match code {
                SessionAuthFailureCode::Expired => {
                    assert_eq!(code.client_class(), "recoverable");
                    assert!(code.retry_eligible());
                }
                _ => {
                    assert_eq!(code.client_class(), "terminal");
                    assert!(!code.retry_eligible());
                }
            }
        }
    }

    #[test]
    fn accepts_fake_provider_and_gated_live_provider_selection() {
        assert_eq!(
            RealtimeProvider::parse("fake_cartesia_gemini"),
            Ok(RealtimeProvider::FakeCartesiaGemini)
        );
        assert_eq!(
            RealtimeProvider::parse("fake-cartesia-gemini"),
            Ok(RealtimeProvider::FakeCartesiaGemini)
        );
        assert_eq!(
            RealtimeProvider::parse("cartesia_gemini"),
            Ok(RealtimeProvider::CartesiaGemini)
        );
        assert_eq!(
            RealtimeProvider::parse("cartesia-gemini"),
            Ok(RealtimeProvider::CartesiaGemini)
        );
    }

    #[test]
    fn builds_selectable_fake_provider_without_live_keys() {
        let config = ServiceConfig {
            provider: RealtimeProvider::FakeCartesiaGemini,
            ..ServiceConfig::default()
        };
        let brain = build_brain(
            &config,
            Arc::new(data::InMemoryStudyStore::seeded_fixture()),
        );
        let capabilities = brain.capabilities();

        assert_eq!(capabilities.provider, "fake_cartesia_gemini");
        assert!(capabilities.configured);
        assert!(capabilities.selectable);
        assert!(!capabilities.live_runtime);
    }

    #[test]
    fn builds_gated_live_provider_without_keys() {
        let config = ServiceConfig {
            provider: RealtimeProvider::CartesiaGemini,
            ..ServiceConfig::default()
        };
        let brain = build_brain(
            &config,
            Arc::new(data::InMemoryStudyStore::seeded_fixture()),
        );
        let capabilities = brain.capabilities();

        assert_eq!(capabilities.provider, "cartesia_gemini");
        assert!(!capabilities.selectable);
        assert!(!capabilities.live_runtime);
    }

    #[tokio::test]
    async fn defaults_to_in_memory_study_store_without_database_url() {
        let config = ServiceConfig::default();
        let store = build_study_store(&config)
            .await
            .expect("default study store should build");

        let capabilities = store.capabilities();
        assert_eq!(
            capabilities.backend,
            agent_domain::StudyStoreBackend::InMemory
        );
        assert!(!capabilities.durable);
        assert!(capabilities.nonce_replay_protection);
    }

    #[test]
    fn public_signed_session_preflight_rejects_ephemeral_store() {
        let config = ServiceConfig {
            bind_addr: "0.0.0.0:4318".parse().expect("bind parses"),
            ws_access: VoiceWsAccess {
                required_bearer: None,
                session_token_secret: Some("session-secret".to_owned()),
                allowed_origins: vec!["https://viva.example.com".to_owned()],
            },
            ..ServiceConfig::default()
        };
        let store = data::InMemoryStudyStore::seeded_fixture();

        let error = validate_runtime_store_preflight(&config, &store.capabilities())
            .expect_err("public signed sessions must not run on ephemeral store");

        assert_eq!(
            error,
            ServiceConfigError::DurableStoreRequiredForSignedSessions("in_memory")
        );
    }

    #[test]
    fn loopback_signed_session_preflight_rejects_ephemeral_store() {
        let config = ServiceConfig {
            bind_addr: "127.0.0.1:4318".parse().expect("bind parses"),
            ws_access: VoiceWsAccess {
                required_bearer: None,
                session_token_secret: Some("session-secret".to_owned()),
                allowed_origins: vec!["http://localhost:3000".to_owned()],
            },
            ..ServiceConfig::default()
        };
        let store = data::InMemoryStudyStore::seeded_fixture();

        let error = validate_runtime_store_preflight(&config, &store.capabilities())
            .expect_err("signed sessions must not run on ephemeral loopback store");

        assert_eq!(
            error,
            ServiceConfigError::DurableStoreRequiredForSignedSessions("in_memory")
        );
    }

    #[test]
    fn loopback_failure_control_allows_ephemeral_signed_session_store() {
        let config = ServiceConfig {
            bind_addr: "127.0.0.1:4318".parse().expect("bind parses"),
            ws_access: VoiceWsAccess {
                required_bearer: None,
                session_token_secret: Some("session-secret".to_owned()),
                allowed_origins: vec!["http://localhost:3000".to_owned()],
            },
            failure_control: FailureControlConfig::enabled_for_synthetic_identities(
                FailureControlScenario::ProviderRateLimited,
                "control-secret",
                vec!["user-1".to_owned()],
                vec!["biology-midterm".to_owned()],
                vec!["http://localhost:3000".to_owned()],
                1,
            )
            .expect("synthetic failure-control config should parse"),
            ..ServiceConfig::default()
        };
        let store = data::InMemoryStudyStore::seeded_fixture();

        validate_runtime_store_preflight(&config, &store.capabilities())
            .expect("loopback failure-control browser evidence may use the local fixture store");
    }
}
