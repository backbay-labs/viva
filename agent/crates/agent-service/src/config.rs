use std::{
    env,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_adapters::{
    cartesia_gemini::{CartesiaGeminiBrain, CartesiaGeminiConfig, FakeCartesiaGeminiRuntime},
    SyntheticBrain,
};
use agent_domain::{RealtimeBrain, StudyMemoryStore};
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
    pub voice_limits: VoiceLimitConfig,
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
            max_turn_duration: Duration::from_secs(60),
            voice_limits: VoiceLimitConfig::default(),
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
            config.max_turn_duration = Duration::from_secs(seconds);
        }
        config.voice_limits.max_user_sessions = env_value("VIVA_VOICE_WS_MAX_USER_SESSIONS")
            .and_then(|value| parse_positive_usize(&value));
        config.voice_limits.max_ip_sessions = env_value("VIVA_VOICE_WS_MAX_IP_SESSIONS")
            .and_then(|value| parse_positive_usize(&value));
        config.voice_limits.max_audio_bytes_per_minute =
            env_value("VIVA_VOICE_WS_MAX_AUDIO_BYTES_PER_MINUTE")
                .and_then(|value| parse_positive_u64(&value));
        config.voice_limits.max_session_cost_usd = env_value("VIVA_VOICE_WS_MAX_SESSION_COST_USD")
            .and_then(|value| parse_positive_f64(&value));
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ServiceConfigError> {
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

#[derive(Clone, Debug, Default, PartialEq)]
pub struct VoiceLimitConfig {
    pub max_user_sessions: Option<usize>,
    pub max_ip_sessions: Option<usize>,
    pub max_audio_bytes_per_minute: Option<u64>,
    pub max_session_cost_usd: Option<f64>,
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

        self.validate_bearer_headers(headers)
    }

    pub fn validate_bearer_headers(&self, headers: &HeaderMap) -> Result<(), VoiceWsAccessError> {
        let Some(required) = &self.required_bearer else {
            return Ok(());
        };
        let Some(provided) = bearer_from_headers(headers) else {
            return Err(VoiceWsAccessError::MissingBearer);
        };
        if !constant_time_eq(required.as_bytes(), provided.as_bytes()) {
            return Err(VoiceWsAccessError::InvalidBearer);
        }
        Ok(())
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
}

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
            return Err(SessionTokenError::Invalid);
        }
        if claims.expires_at <= now {
            return Err(SessionTokenError::Expired);
        }
        Ok(claims)
    }

    fn has_required_claims(&self) -> bool {
        !self.user_id.trim().is_empty()
            && !self.study_set_id.trim().is_empty()
            && !self.session_id.trim().is_empty()
            && !self.nonce.trim().is_empty()
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
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(ToOwned::to_owned)
        .or_else(|| {
            headers
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .and_then(protocol_bearer)
        })
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
        assert_eq!(config.voice_limits.max_user_sessions, Some(2));
        assert_eq!(config.voice_limits.max_ip_sessions, Some(5));
        assert_eq!(config.voice_limits.max_audio_bytes_per_minute, Some(48_000));
        assert_eq!(config.voice_limits.max_session_cost_usd, Some(0.75));

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
        assert_eq!(disabled.voice_limits, VoiceLimitConfig::default());
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
    }
}
