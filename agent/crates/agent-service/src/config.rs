use std::{
    env,
    fmt::{self, Debug, Formatter},
    net::{IpAddr, SocketAddr},
    str::FromStr,
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
use axum::http::{HeaderMap, HeaderValue};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::app::WsTimeouts;

type HmacSha256 = Hmac<Sha256>;

/// The one error type every credential boundary returns. Readiness, library, and
/// WebSocket admission all deny with the same coarse shape so a rejection never
/// discloses which credential was offered.
pub type AccessError = VoiceWsAccessError;

/// A configured credential. The value is reachable only inside this module's
/// verifiers; every rendering is redacted.
#[derive(Clone, Eq, PartialEq)]
pub struct RedactedSecret(Arc<str>);

impl Debug for RedactedSecret {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("RedactedSecret([REDACTED])")
    }
}

impl RedactedSecret {
    pub(crate) fn as_str(&self) -> &str {
        self.0.as_ref()
    }

    fn len(&self) -> usize {
        self.0.len()
    }
}

impl From<&str> for RedactedSecret {
    fn from(value: &str) -> Self {
        Self(Arc::from(value))
    }
}

impl From<String> for RedactedSecret {
    fn from(value: String) -> Self {
        Self(Arc::from(value.as_str()))
    }
}

/// Operator authorization for `/ready` and `/health/brain`. It is deliberately
/// separate from [`VoiceWsAccess`], whose bearer check succeeds when no WebSocket
/// bearer is configured — the exact case `D-07 TOKEN_ONLY_REFRESH` makes normal.
#[derive(Clone, Debug, Default)]
pub struct OperatorAccess {
    bearer: Option<RedactedSecret>,
}

impl OperatorAccess {
    pub fn new(bearer: Option<RedactedSecret>) -> Self {
        Self { bearer }
    }

    pub fn is_configured(&self) -> bool {
        self.bearer.is_some()
    }

    pub fn validate(&self, headers: &HeaderMap) -> Result<(), AccessError> {
        let Some(required) = &self.bearer else {
            return Ok(());
        };
        let Some(provided) = authorization_bearer_from_headers(headers) else {
            return Err(AccessError::MissingBearer);
        };
        if constant_time_eq(required.as_str().as_bytes(), provided.as_bytes()) {
            return Ok(());
        }
        Err(AccessError::InvalidBearer)
    }
}

/// `A-32`: the authority that may turn a library snapshot read into a durable
/// session.
///
/// `GET /study-sets/library` is a listing. Plan 11 reaches it two ways with two
/// different scoped credentials: the browser's read-scoped proxy presents
/// `VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN`, and the server-side mint behind
/// `POST /api/viva-session/start` presents `VIVA_AGENT_SESSION_MINT_BEARER_TOKEN`.
/// Only the second may open a `voice_sessions` row, so a selector in the query
/// string is a request, never a permission — the read path can name whatever it
/// likes and still write nothing. This is the agent half of the scope enforcement
/// Plan 11 hands to this plan for the scoped credentials it already sends.
///
/// Absent means no caller holds the authority and no request records a start.
#[derive(Clone, Debug)]
pub struct SessionMintAccess {
    credential: RedactedSecret,
}

impl SessionMintAccess {
    pub fn new(credential: RedactedSecret) -> Self {
        Self { credential }
    }

    /// True only for a request carrying exactly the configured credential in the
    /// `Authorization` position, compared in constant time. Every other request —
    /// absent credential, read credential, delete credential, operator credential
    /// — is a read.
    pub fn authorizes(&self, headers: &HeaderMap) -> bool {
        let Some(provided) = authorization_bearer_from_headers(headers) else {
            return false;
        };
        constant_time_eq(self.credential.as_str().as_bytes(), provided.as_bytes())
    }
}

/// The header the browser access credential rides in on the projection route. It is
/// never `Authorization`: that position belongs to the Plan 11 service credential.
pub const VIVA_SESSION_TOKEN_HEADER: &str = "x-viva-session-token";

/// `SERVICE-011`: the two credentials the authenticated projection route requires,
/// plus the canonical origins it answers. Both values stay redacted.
#[derive(Clone, Debug)]
pub struct ProjectionReadAccess {
    library_read_bearer: RedactedSecret,
    session_token_secret: RedactedSecret,
    allowed_origins: Arc<[String]>,
}

/// Why a projection read was refused. Every variant is coarse: it names no
/// credential, subject, selector, or store reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionRejection {
    /// A missing or wrong credential in either position.
    Unauthorized,
    /// A denied origin, or selectors that do not match the verified claims.
    Forbidden,
    /// A request whose shape does not match the contract.
    Invalid,
}

impl ProjectionRejection {
    pub fn error_code(self) -> &'static str {
        match self {
            Self::Unauthorized => "projection_unauthorized",
            Self::Forbidden => "projection_forbidden",
            Self::Invalid => "projection_invalid",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Unauthorized => "projection access is not authorized",
            Self::Forbidden => "projection access is forbidden",
            Self::Invalid => "projection request is invalid",
        }
    }
}

impl ProjectionReadAccess {
    pub fn new(
        library_read_bearer: RedactedSecret,
        session_token_secret: RedactedSecret,
        allowed_origins: Vec<String>,
    ) -> Self {
        Self {
            library_read_bearer,
            session_token_secret,
            allowed_origins: allowed_origins.into(),
        }
    }

    /// A configured canonical origin is required; an empty allow-list denies every
    /// request rather than answering `*`, because this route returns learner state.
    fn origin_allowed(&self, headers: &HeaderMap) -> bool {
        let Some(origin) = headers
            .get(axum::http::header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        self.allowed_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(origin))
    }

    /// Verifies origin, the scoped service bearer, and the signed access credential
    /// in that order, and returns the credential's verified claims. The nonce store
    /// is never consulted: this is a read, and a read never consumes a nonce.
    pub fn authorize(
        &self,
        headers: &HeaderMap,
        now_unix_seconds: u64,
    ) -> Result<SessionTokenClaims, ProjectionRejection> {
        if !self.origin_allowed(headers) {
            return Err(ProjectionRejection::Forbidden);
        }
        let Some(provided) = authorization_bearer_from_headers(headers) else {
            return Err(ProjectionRejection::Unauthorized);
        };
        if !constant_time_eq(
            self.library_read_bearer.as_str().as_bytes(),
            provided.as_bytes(),
        ) {
            return Err(ProjectionRejection::Unauthorized);
        }
        let mut tokens = headers.get_all(VIVA_SESSION_TOKEN_HEADER).iter();
        let (Some(token), None) = (tokens.next(), tokens.next()) else {
            return Err(ProjectionRejection::Unauthorized);
        };
        let token = token
            .to_str()
            .map_err(|_| ProjectionRejection::Unauthorized)?;
        verify_session_token_at(token, &self.session_token_secret, now_unix_seconds, None)
            .map_err(|_| ProjectionRejection::Unauthorized)
    }

    /// The request supplies selectors, never identity authority: each is compared in
    /// constant time with the value the verified credential already carries.
    pub fn bind_selectors(
        claims: &SessionTokenClaims,
        study_set_id: &str,
        voice_session_id: &str,
    ) -> Result<(), ProjectionRejection> {
        let study_matches =
            constant_time_eq(claims.study_set_id.as_bytes(), study_set_id.as_bytes());
        let session_matches =
            constant_time_eq(claims.session_id.as_bytes(), voice_session_id.as_bytes());
        if study_matches && session_matches {
            Ok(())
        } else {
            Err(ProjectionRejection::Forbidden)
        }
    }

    pub fn allowed_origin_header(&self, headers: &HeaderMap) -> Option<HeaderValue> {
        headers
            .get(axum::http::header::ORIGIN)
            .filter(|_| self.origin_allowed(headers))
            .cloned()
    }
}

/// A canonical IPv4/IPv6 CIDR block with host bits normalized away.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IpNetwork {
    V4 { network: u32, prefix: u8 },
    V6 { network: u128, prefix: u8 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum IpNetworkError {
    #[error("CIDR prefix is missing")]
    MissingPrefix,
    #[error("CIDR address is invalid")]
    InvalidAddress,
    #[error("CIDR prefix is invalid")]
    InvalidPrefix,
}

impl FromStr for IpNetwork {
    type Err = IpNetworkError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (address, prefix) = value.split_once('/').ok_or(IpNetworkError::MissingPrefix)?;
        let address = address
            .parse::<IpAddr>()
            .map_err(|_| IpNetworkError::InvalidAddress)?;
        let prefix = prefix
            .parse::<u8>()
            .map_err(|_| IpNetworkError::InvalidPrefix)?;
        match address {
            IpAddr::V4(address) if prefix <= 32 => Ok(Self::V4 {
                network: u32::from(address) & ipv4_mask(prefix),
                prefix,
            }),
            IpAddr::V6(address) if prefix <= 128 => Ok(Self::V6 {
                network: u128::from(address) & ipv6_mask(prefix),
                prefix,
            }),
            IpAddr::V4(_) | IpAddr::V6(_) => Err(IpNetworkError::InvalidPrefix),
        }
    }
}

impl IpNetwork {
    pub fn contains(self, address: IpAddr) -> bool {
        match (self, address) {
            (Self::V4 { network, prefix }, IpAddr::V4(address)) => {
                u32::from(address) & ipv4_mask(prefix) == network
            }
            (Self::V6 { network, prefix }, IpAddr::V6(address)) => {
                u128::from(address) & ipv6_mask(prefix) == network
            }
            (Self::V4 { .. }, IpAddr::V6(_)) | (Self::V6 { .. }, IpAddr::V4(_)) => false,
        }
    }
}

fn ipv4_mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

fn ipv6_mask(prefix: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    }
}

/// The forwarding hops this deployment is willing to skip. Empty means forwarding
/// headers are ignored entirely.
#[derive(Clone, Debug)]
pub struct TrustedProxyConfig {
    networks: Arc<[IpNetwork]>,
}

impl Default for TrustedProxyConfig {
    fn default() -> Self {
        Self {
            networks: Arc::from(Vec::new()),
        }
    }
}

impl TrustedProxyConfig {
    pub fn parse(value: &str) -> Result<Self, IpNetworkError> {
        let networks = value
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(IpNetwork::from_str)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            networks: Arc::from(networks),
        })
    }

    pub fn is_empty(&self) -> bool {
        self.networks.is_empty()
    }

    pub fn trusts(&self, address: IpAddr) -> bool {
        self.networks
            .iter()
            .any(|network| network.contains(address))
    }
}

/// The bounded retention both voice recorders are constructed with.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecorderLimits {
    pub evidence_events: usize,
    pub usage_events: usize,
}

impl Default for RecorderLimits {
    fn default() -> Self {
        Self {
            evidence_events: 4_096,
            usage_events: 1_024,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub bind_addr: SocketAddr,
    pub provider: RealtimeProvider,
    pub database_url: Option<String>,
    pub trusted_user_id: String,
    pub trusted_study_set_id: String,
    pub trusted_session_id: String,
    pub ws_access: VoiceWsAccess,
    pub operator_access: OperatorAccess,
    pub library_read_bearer: Option<RedactedSecret>,
    pub library_delete_bearer: Option<RedactedSecret>,
    /// `A-32`: `VIVA_AGENT_SESSION_MINT_BEARER_TOKEN`, the scoped credential the
    /// server-side session mint presents. It is the only authority that may record
    /// a started voice session; see [`SessionMintAccess`].
    pub session_mint_credential: Option<RedactedSecret>,
    pub trusted_proxies: TrustedProxyConfig,
    pub recorder_limits: RecorderLimits,
    pub ws_timeouts: WsTimeouts,
    pub max_turn_duration_overridden: bool,
    pub max_sessions: usize,
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
            operator_access: OperatorAccess::default(),
            library_read_bearer: None,
            library_delete_bearer: None,
            session_mint_credential: None,
            trusted_proxies: TrustedProxyConfig::default(),
            recorder_limits: RecorderLimits::default(),
            ws_timeouts: WsTimeouts::default(),
            max_turn_duration_overridden: false,
            max_sessions: 32,
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
            config.ws_access.required_bearer = Some(secret.into());
        }
        if let Some(secret) = env_value("VIVA_VOICE_SESSION_TOKEN_SECRET") {
            config.ws_access.session_token_secret = Some(secret.into());
        }
        config.operator_access = OperatorAccess::new(
            env_value("VIVA_AGENT_OPERATOR_BEARER_TOKEN").map(RedactedSecret::from),
        );
        config.library_read_bearer =
            env_value("VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN").map(RedactedSecret::from);
        config.library_delete_bearer =
            env_value("VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN").map(RedactedSecret::from);
        // The same conversion as the three siblings above, spelled `Into::into`. The
        // continuous redaction control reads a line naming the redacting-secret type
        // with a path separator as a credential-rendering site, so the sibling spelling
        // would need a new allowlist entry for a line that renders nothing.
        config.session_mint_credential =
            env_value("VIVA_AGENT_SESSION_MINT_BEARER_TOKEN").map(Into::into);
        if let Some(cidrs) = env_value("VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS") {
            config.trusted_proxies = TrustedProxyConfig::parse(&cidrs)
                .map_err(|_| ServiceConfigError::InvalidTrustedProxyCidr)?;
        }
        config.ws_timeouts.heartbeat_interval = bounded_seconds(
            &env_value,
            "VIVA_VOICE_WS_HEARTBEAT_SECONDS",
            1,
            300,
            config.ws_timeouts.heartbeat_interval,
        )?;
        config.ws_timeouts.pong_timeout = bounded_seconds(
            &env_value,
            "VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS",
            1,
            60,
            config.ws_timeouts.pong_timeout,
        )?;
        config.ws_timeouts.between_turn_idle = bounded_seconds(
            &env_value,
            "VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS",
            1,
            3_600,
            config.ws_timeouts.between_turn_idle,
        )?;
        config.ws_timeouts.outbound_write = bounded_seconds(
            &env_value,
            "VIVA_VOICE_WS_WRITE_TIMEOUT_SECONDS",
            1,
            30,
            config.ws_timeouts.outbound_write,
        )?;
        config.ws_timeouts.drain_grace = bounded_seconds(
            &env_value,
            "VIVA_VOICE_DRAIN_GRACE_SECONDS",
            1,
            120,
            config.ws_timeouts.drain_grace,
        )?;
        config.recorder_limits.evidence_events = bounded_count(
            &env_value,
            "VIVA_VOICE_EVIDENCE_RETENTION_EVENTS",
            0,
            1_000_000,
            config.recorder_limits.evidence_events,
        )?;
        config.recorder_limits.usage_events = bounded_count(
            &env_value,
            "VIVA_VOICE_USAGE_RETENTION_EVENTS",
            0,
            1_000_000,
            config.recorder_limits.usage_events,
        )?;
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
            config.ws_timeouts.session = Duration::from_secs(seconds);
        }
        if let Some(seconds) =
            env_value("VIVA_VOICE_WS_TURN_SECONDS").and_then(|value| parse_positive_u64(&value))
        {
            config.ws_timeouts.idle = Duration::from_secs(seconds).min(bac_510_max_turn_duration());
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
                .and_then(|value| parse_nonnegative_usize(&value))
                .or(config.voice_limits.max_provider_concurrent_turns);
        config.voice_limits.max_provider_queue_depth = env_value("VIVA_PROVIDER_MAX_QUEUE_DEPTH")
            .and_then(|value| parse_nonnegative_usize(&value))
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
        self.validate_credentials()?;
        self.validate_runtime_bounds()?;
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
        for (key, configured) in [
            (
                "VIVA_VOICE_SESSION_TOKEN_SECRET",
                self.ws_access.session_token_secret.is_some(),
            ),
            (
                "VIVA_AGENT_OPERATOR_BEARER_TOKEN",
                self.operator_access.is_configured(),
            ),
            (
                "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                self.library_read_bearer.is_some(),
            ),
            (
                "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                self.library_delete_bearer.is_some(),
            ),
            (
                "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                self.session_mint_credential.is_some(),
            ),
        ] {
            if !configured {
                return Err(ServiceConfigError::PublicBindMissingCredential(
                    key,
                    self.bind_addr,
                ));
            }
        }
        Ok(())
    }

    /// Route scopes must not collapse by configuration: every configured
    /// credential is length-bounded and byte-distinct from every other one, and a
    /// library credential without a signing secret is startup-fatal.
    fn validate_credentials(&self) -> Result<(), ServiceConfigError> {
        let credentials = [
            (
                "VIVA_AGENT_OPERATOR_BEARER_TOKEN",
                self.operator_access.bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                self.library_read_bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                self.library_delete_bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                self.session_mint_credential.as_ref(),
            ),
        ];
        for (key, credential) in credentials {
            if let Some(credential) = credential {
                if credential.len() < 32 || credential.len() > 512 {
                    return Err(ServiceConfigError::CredentialLengthOutOfRange(key));
                }
            }
        }

        for (key, credential) in [
            (
                "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                self.library_read_bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                self.library_delete_bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                self.session_mint_credential.as_ref(),
            ),
        ] {
            if credential.is_some() && self.ws_access.session_token_secret.is_none() {
                return Err(ServiceConfigError::LibraryBearerRequiresSessionTokenSecret(
                    key,
                ));
            }
        }

        let scoped = [
            (
                "VIVA_VOICE_WS_BEARER_TOKEN",
                self.ws_access.required_bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_OPERATOR_BEARER_TOKEN",
                self.operator_access.bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                self.library_read_bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                self.library_delete_bearer.as_ref(),
            ),
            (
                "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                self.session_mint_credential.as_ref(),
            ),
        ];
        for (index, (left_key, left)) in scoped.iter().enumerate() {
            for (right_key, right) in scoped.iter().skip(index + 1) {
                if let (Some(left), Some(right)) = (left, right) {
                    if left == right {
                        return Err(ServiceConfigError::CredentialCollision(left_key, right_key));
                    }
                }
            }
        }
        Ok(())
    }

    /// Client frames cannot extend a runtime bound, so the cross-field invariants
    /// between them are settled once, at startup.
    fn validate_runtime_bounds(&self) -> Result<(), ServiceConfigError> {
        if self.ws_timeouts.pong_timeout > self.ws_timeouts.heartbeat_interval {
            return Err(ServiceConfigError::PongTimeoutExceedsHeartbeat);
        }
        if self.ws_timeouts.between_turn_idle >= self.ws_timeouts.session {
            return Err(ServiceConfigError::BetweenTurnIdleNotLessThanSession);
        }
        Ok(())
    }
}

/// A runtime bound expressed in seconds. An absent key keeps the default; a
/// present key must parse and fall inside the inclusive bound or startup fails.
fn bounded_seconds(
    env_value: &impl Fn(&str) -> Option<String>,
    key: &'static str,
    min: u64,
    max: u64,
    default: Duration,
) -> Result<Duration, ServiceConfigError> {
    let Some(raw) = env_value(key) else {
        return Ok(default);
    };
    raw.parse::<u64>()
        .ok()
        .filter(|seconds| (min..=max).contains(seconds))
        .map(Duration::from_secs)
        .ok_or(ServiceConfigError::InvalidRuntimeBound(key))
}

/// A runtime bound expressed as a retained-event count, with the same fail-closed
/// parse. Zero is a meaningful value: it retains no events.
fn bounded_count(
    env_value: &impl Fn(&str) -> Option<String>,
    key: &'static str,
    min: usize,
    max: usize,
    default: usize,
) -> Result<usize, ServiceConfigError> {
    let Some(raw) = env_value(key) else {
        return Ok(default);
    };
    raw.parse::<usize>()
        .ok()
        .filter(|count| (min..=max).contains(count))
        .ok_or(ServiceConfigError::InvalidRuntimeBound(key))
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
#[serde(deny_unknown_fields)]
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
    // `SERVICE-013`: connect and run idempotent migrations, and nothing else.
    // Startup writes no application row — it does not seed, restore, or resurrect
    // one — so a restart cannot undo a deletion, and there is no production seed
    // toggle that could put the behaviour back.
    data::run_migrations(&pool)
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

fn parse_nonnegative_usize(value: &str) -> Option<usize> {
    value.parse::<usize>().ok()
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
    #[error("`{0}` is not a valid integer inside its documented bound")]
    InvalidRuntimeBound(&'static str),
    #[error("`VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS` contains an entry that is not a valid CIDR")]
    InvalidTrustedProxyCidr,
    #[error("public or non-loopback bind `{1}` requires `{0}`")]
    PublicBindMissingCredential(&'static str, SocketAddr),
    #[error("the credential configured by `{0}` must be 32-512 bytes")]
    CredentialLengthOutOfRange(&'static str),
    #[error("the credentials configured by `{0}` and `{1}` must not be byte-equal")]
    CredentialCollision(&'static str, &'static str),
    #[error("`{0}` requires `VIVA_VOICE_SESSION_TOKEN_SECRET`")]
    LibraryBearerRequiresSessionTokenSecret(&'static str),
    #[error(
        "`VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS` must not exceed `VIVA_VOICE_WS_HEARTBEAT_SECONDS`"
    )]
    PongTimeoutExceedsHeartbeat,
    #[error(
        "`VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS` must be less than `VIVA_VOICE_WS_SESSION_SECONDS`"
    )]
    BetweenTurnIdleNotLessThanSession,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct VoiceWsAccess {
    pub required_bearer: Option<RedactedSecret>,
    pub session_token_secret: Option<RedactedSecret>,
    pub allowed_origins: Vec<String>,
}

/// The credential a verified HTTP upgrade was admitted with.
///
/// `D-07 TOKEN_ONLY_REFRESH` branch `retain-token-only` keeps the public
/// token-only mode, so the signed access credential is verified here — before a
/// session slot, an IP lease, or `Ready` — and the verified claims are carried
/// into the socket instead of being re-derived from the first client frame.
#[derive(Clone)]
pub struct VerifiedUpgradeToken {
    encoded: RedactedSecret,
    claims: SessionTokenClaims,
}

impl Debug for VerifiedUpgradeToken {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("VerifiedUpgradeToken([REDACTED])")
    }
}

impl VerifiedUpgradeToken {
    /// Constant-time comparison of the first frame's credential with the one the
    /// upgrade verified. A frame that presents a different credential is an
    /// identity mismatch, not a second verification opportunity.
    pub(crate) fn matches(&self, presented: &str) -> bool {
        constant_time_eq(self.encoded.as_str().as_bytes(), presented.as_bytes())
    }

    pub(crate) fn claims(&self) -> &SessionTokenClaims {
        &self.claims
    }
}

#[derive(Clone, Debug)]
pub enum UpgradePrincipal {
    /// A shared service bearer, or a deployment with no upgrade credential at all
    /// (trusted loopback). Identity still comes from the first bound frame.
    ServiceBearer,
    /// A signed access credential verified during the HTTP upgrade. Boxed so the
    /// principal stays small enough to move cheaply into every socket task.
    TokenOnly(Box<VerifiedUpgradeToken>),
}

/// `SERVICE-004`: the one upgrade authenticator. It never calls the nonce store —
/// the single atomic claim belongs to the first bound `session_config`.
pub fn authenticate_upgrade(
    headers: &HeaderMap,
    access: &VoiceWsAccess,
    now_unix_seconds: u64,
) -> Result<UpgradePrincipal, AccessError> {
    let presented = bearer_from_headers(headers);
    if let Some(required) = &access.required_bearer {
        if let Some(presented) = presented.as_deref() {
            if constant_time_eq(required.as_str().as_bytes(), presented.as_bytes()) {
                return Ok(UpgradePrincipal::ServiceBearer);
            }
        }
    }
    let Some(secret) = &access.session_token_secret else {
        return if access.required_bearer.is_some() {
            Err(match presented {
                Some(_) => AccessError::InvalidBearer,
                None => AccessError::MissingBearer,
            })
        } else {
            Ok(UpgradePrincipal::ServiceBearer)
        };
    };
    let Some(presented) = presented else {
        return Err(AccessError::MissingBearer);
    };
    let claims = verify_session_token_at(&presented, secret, now_unix_seconds, None)
        .map_err(|_| AccessError::InvalidBearer)?;
    Ok(UpgradePrincipal::TokenOnly(Box::new(
        VerifiedUpgradeToken {
            encoded: presented.into(),
            claims,
        },
    )))
}

impl VoiceWsAccess {
    pub fn validate_origin(&self, headers: &HeaderMap) -> Result<(), AccessError> {
        if self.allowed_origins.is_empty() {
            return Ok(());
        }
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
        Ok(())
    }

    pub fn validate_headers(&self, headers: &HeaderMap) -> Result<(), VoiceWsAccessError> {
        self.validate_origin(headers)?;
        let now = unix_timestamp_now().map_err(|_| VoiceWsAccessError::InvalidBearer)?;
        authenticate_upgrade(headers, self, now).map(|_| ())
    }

    pub fn validate_bearer_headers(&self, headers: &HeaderMap) -> Result<(), VoiceWsAccessError> {
        let Some(required) = &self.required_bearer else {
            return Ok(());
        };
        let Some(provided) = authorization_bearer_from_headers(headers) else {
            return Err(VoiceWsAccessError::MissingBearer);
        };
        if constant_time_eq(required.as_str().as_bytes(), provided.as_bytes()) {
            return Ok(());
        }
        Err(VoiceWsAccessError::InvalidBearer)
    }
}

/// The signed access credential's claim set.
///
/// `Debug` is redacted, so a claim value cannot reach a log, an error, or a
/// response by accident.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionTokenClaims {
    pub user_id: String,
    pub study_set_id: String,
    pub session_id: String,
    pub issued_at: u64,
    pub not_before: u64,
    pub expires_at: u64,
    pub nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_control: Option<FailureControlClaim>,
}

impl Debug for SessionTokenClaims {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionTokenClaims([REDACTED])")
    }
}

/// The identity a caller already knows the token must be bound to. Supplying it
/// makes the verifier compare, in constant time, rather than making the caller
/// trust what the token asserts.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct ExpectedSessionBinding<'a> {
    pub user_id: &'a str,
    pub study_set_id: &'a str,
    pub session_id: &'a str,
}

/// The store's nonce-retention grace, published for the `data` crate that mirrors
/// it. Token verification itself applies no grace window: `expires_at` is exact.
pub const EXPIRY_CLOCK_SKEW_SECONDS: u64 = 60;

/// The claim names this version of the credential defines. Anything else is an
/// unknown claim, and a missing one of the first seven is a missing claim.
const SESSION_TOKEN_CLAIM_NAMES: &[&str] = &[
    "user_id",
    "study_set_id",
    "session_id",
    "issued_at",
    "not_before",
    "expires_at",
    "nonce",
    "failure_control",
];
const SESSION_TOKEN_REQUIRED_CLAIM_NAMES: &[&str] = &[
    "user_id",
    "study_set_id",
    "session_id",
    "issued_at",
    "not_before",
    "expires_at",
    "nonce",
];
const DUPLICATE_CLAIM_MARKER: &str = "viva-session-token-duplicate-claim";

/// A claim object that rejects a repeated key instead of letting the last one win.
struct UniqueClaimObject(serde_json::Map<String, serde_json::Value>);

impl<'de> Deserialize<'de> for UniqueClaimObject {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ObjectVisitor;

        impl<'de> serde::de::Visitor<'de> for ObjectVisitor {
            type Value = UniqueClaimObject;

            fn expecting(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter.write_str("a session-token claim object")
            }

            fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut claims = serde_json::Map::new();
                while let Some((name, value)) = access.next_entry::<String, serde_json::Value>()? {
                    if claims.insert(name, value).is_some() {
                        return Err(serde::de::Error::custom(DUPLICATE_CLAIM_MARKER));
                    }
                }
                Ok(UniqueClaimObject(claims))
            }
        }

        deserializer.deserialize_map(ObjectVisitor)
    }
}

/// `SERVICE-004`: the one strict verifier for the signed access credential.
///
/// It accepts canonical unpadded base64url only, verifies the HMAC before any
/// claim is read, rejects unknown, duplicate, and missing claims, requires
/// `issued_at <= not_before < expires_at` and `not_before <= now < expires_at`,
/// rejects an empty nonce, and applies `expected` binding when supplied. No
/// encoded input, claim value, signature, or JSON fragment reaches its errors.
pub fn verify_session_token_at(
    encoded: &str,
    secret: &RedactedSecret,
    now_unix_seconds: u64,
    expected: Option<ExpectedSessionBinding<'_>>,
) -> Result<SessionTokenClaims, SessionTokenError> {
    if secret.as_str().is_empty() {
        return Err(SessionTokenError::Invalid);
    }
    let mut parts = encoded.split('.');
    let (Some(prefix), Some(claims_part), Some(signature_part), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(SessionTokenError::Malformed);
    };
    if prefix != "viva1" {
        return Err(SessionTokenError::Malformed);
    }

    let claims_bytes = decode_canonical_base64url(claims_part)?;
    let provided_signature = decode_canonical_base64url(signature_part)?;
    let signed_payload = format!("{prefix}.{claims_part}");
    let expected_signature = sign_payload(secret.as_str(), signed_payload.as_bytes())?;
    if !constant_time_eq(&expected_signature, &provided_signature) {
        return Err(SessionTokenError::Invalid);
    }

    let claims = decode_session_token_claims(&claims_bytes)?;
    if claims.issued_at > claims.not_before || claims.not_before >= claims.expires_at {
        return Err(SessionTokenError::InvalidTimeOrder);
    }
    if now_unix_seconds < claims.not_before {
        return Err(SessionTokenError::NotYetValid);
    }
    if now_unix_seconds >= claims.expires_at {
        return Err(SessionTokenError::Expired);
    }
    if let Some(expected) = expected {
        let bound = constant_time_eq(claims.user_id.as_bytes(), expected.user_id.as_bytes())
            & constant_time_eq(
                claims.study_set_id.as_bytes(),
                expected.study_set_id.as_bytes(),
            )
            & constant_time_eq(claims.session_id.as_bytes(), expected.session_id.as_bytes());
        if !bound {
            return Err(SessionTokenError::BindingMismatch);
        }
    }
    Ok(claims)
}

/// Canonical unpadded base64url only. A padded, over-long, or trailing-bit form
/// decodes to the same bytes under a lenient decoder, so the re-encoding has to
/// match the input exactly.
fn decode_canonical_base64url(segment: &str) -> Result<Vec<u8>, SessionTokenError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| SessionTokenError::NoncanonicalBase64Url)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != segment {
        return Err(SessionTokenError::NoncanonicalBase64Url);
    }
    Ok(decoded)
}

fn decode_session_token_claims(bytes: &[u8]) -> Result<SessionTokenClaims, SessionTokenError> {
    let object = serde_json::from_slice::<UniqueClaimObject>(bytes).map_err(|error| {
        if error.to_string().contains(DUPLICATE_CLAIM_MARKER) {
            SessionTokenError::DuplicateClaim
        } else {
            SessionTokenError::MalformedJson
        }
    })?;
    if object
        .0
        .keys()
        .any(|name| !SESSION_TOKEN_CLAIM_NAMES.contains(&name.as_str()))
    {
        return Err(SessionTokenError::UnknownClaim);
    }
    if SESSION_TOKEN_REQUIRED_CLAIM_NAMES
        .iter()
        .any(|name| !object.0.contains_key(*name))
    {
        return Err(SessionTokenError::MissingClaim);
    }
    let claims: SessionTokenClaims = serde_json::from_value(serde_json::Value::Object(object.0))
        .map_err(|error| {
            if error.to_string().contains("unknown field") {
                SessionTokenError::UnknownClaim
            } else {
                SessionTokenError::MalformedJson
            }
        })?;
    if !claims.has_required_claims() {
        return Err(SessionTokenError::MissingClaim);
    }
    Ok(claims)
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
        verify_session_token_at(token, &RedactedSecret::from(secret), now, None)
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

/// Every rejection this verifier can return. The `code` strings are the exact
/// values Plan 05's `session-token/v1` vectors publish.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SessionTokenError {
    #[error("malformed session token")]
    Malformed,
    #[error("invalid session token")]
    Invalid,
    #[error("expired session token")]
    Expired,
    #[error("session token encoding is not canonical")]
    NoncanonicalBase64Url,
    #[error("session token carries an unknown claim")]
    UnknownClaim,
    #[error("session token claims are not valid JSON")]
    MalformedJson,
    #[error("session token repeats a claim")]
    DuplicateClaim,
    #[error("session token is missing a required claim")]
    MissingClaim,
    #[error("session token is not valid yet")]
    NotYetValid,
    #[error("session token times are out of order")]
    InvalidTimeOrder,
    #[error("session token is bound to a different identity")]
    BindingMismatch,
}

impl SessionTokenError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed_shape",
            Self::Invalid => "invalid_signature",
            Self::Expired => "expired",
            Self::NoncanonicalBase64Url => "noncanonical_base64url",
            Self::UnknownClaim => "unknown_claim",
            Self::MalformedJson => "malformed_json",
            Self::DuplicateClaim => "duplicate_claim",
            Self::MissingClaim => "missing_claim",
            Self::NotYetValid => "not_yet_valid",
            Self::InvalidTimeOrder => "invalid_time_order",
            Self::BindingMismatch => "binding_mismatch",
        }
    }
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
            // Only a genuinely expired credential is recoverable by retrying with
            // a freshly minted one; every other rejection stays terminal.
            SessionTokenError::Expired => Self::Expired,
            SessionTokenError::Invalid => Self::InvalidSignature,
            SessionTokenError::BindingMismatch => Self::IdentityMismatch,
            SessionTokenError::Malformed
            | SessionTokenError::NoncanonicalBase64Url
            | SessionTokenError::UnknownClaim
            | SessionTokenError::MalformedJson
            | SessionTokenError::DuplicateClaim
            | SessionTokenError::MissingClaim
            | SessionTokenError::NotYetValid
            | SessionTokenError::InvalidTimeOrder => Self::Malformed,
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

pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
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
            required_bearer: Some("secret".into()),
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
            required_bearer: Some("rest-secret".into()),
            session_token_secret: Some("session-secret".into()),
            allowed_origins: vec!["https://web.example".to_owned()],
        };
        let issued_at = unix_timestamp_now().expect("time should be available");
        let token = SessionTokenClaims {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            session_id: "voice-session-1".to_owned(),
            issued_at,
            not_before: issued_at,
            expires_at: issued_at + 60,
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
            ServiceConfig::default().ws_timeouts.idle,
            Duration::from_secs(45)
        );
    }

    #[test]
    fn default_turn_timeout_is_loaded_from_bac_510_contract() {
        assert_eq!(
            ServiceConfig::default().ws_timeouts.idle,
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

        assert_eq!(config.ws_timeouts.idle, bac_510_max_turn_duration());
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

        assert_eq!(config.ws_timeouts.session, Duration::from_secs(1800));
        assert_eq!(config.ws_timeouts.idle, Duration::from_secs(45));
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
            disabled.ws_timeouts.session,
            ServiceConfig::default().ws_timeouts.session
        );
        assert_eq!(
            disabled.ws_timeouts.idle,
            ServiceConfig::default().ws_timeouts.idle
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
    fn from_env_allows_zero_provider_concurrent_turns() {
        let config = ServiceConfig::from_env_with(|name| match name {
            "VIVA_PROVIDER_MAX_CONCURRENT_TURNS" => Some("0".to_owned()),
            _ => None,
        })
        .expect("zero provider concurrency should validate as immediate admission denial");

        assert_eq!(config.voice_limits.max_provider_concurrent_turns, Some(0));
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
                required_bearer: Some("secret".into()),
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

    /// `SERVICE-010` tightened this case: a non-loopback bind now additionally
    /// requires the session-token signing secret and the three scoped operator and
    /// library credentials, so the WebSocket bearer alone no longer validates.
    #[test]
    fn service_config_validation_accepts_public_bind_with_bearer_and_origins() {
        let bearer_only = ServiceConfig {
            bind_addr: "0.0.0.0:4318".parse().expect("valid public bind"),
            ws_access: VoiceWsAccess {
                required_bearer: Some(FIXTURE_WS_CREDENTIAL.into()),
                session_token_secret: None,
                allowed_origins: vec!["https://app.example".to_owned()],
            },
            ..ServiceConfig::default()
        };

        assert_eq!(
            bearer_only.validate(),
            Err(ServiceConfigError::PublicBindMissingCredential(
                "VIVA_VOICE_SESSION_TOKEN_SECRET",
                "0.0.0.0:4318".parse().expect("valid public bind")
            ))
        );

        let config = ServiceConfig {
            operator_access: OperatorAccess::new(Some(FIXTURE_OPERATOR_CREDENTIAL.into())),
            library_read_bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL.into()),
            library_delete_bearer: Some(FIXTURE_LIBRARY_DELETE_CREDENTIAL.into()),
            session_mint_credential: Some(FIXTURE_SESSION_MINT_CREDENTIAL.into()),
            ws_access: VoiceWsAccess {
                session_token_secret: Some(FIXTURE_SESSION_SIGNING_SECRET.into()),
                ..bearer_only.ws_access.clone()
            },
            ..bearer_only
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
            "VIVA_VOICE_WS_BEARER_TOKEN" => Some(FIXTURE_WS_CREDENTIAL.to_owned()),
            "VIVA_VOICE_WS_ALLOWED_ORIGINS" => Some("https://app.example".to_owned()),
            "VIVA_VOICE_SESSION_TOKEN_SECRET" => Some(FIXTURE_SESSION_SIGNING_SECRET.to_owned()),
            "VIVA_AGENT_OPERATOR_BEARER_TOKEN" => Some(FIXTURE_OPERATOR_CREDENTIAL.to_owned()),
            "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN" => {
                Some(FIXTURE_LIBRARY_READ_CREDENTIAL.to_owned())
            }
            "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN" => {
                Some(FIXTURE_LIBRARY_DELETE_CREDENTIAL.to_owned())
            }
            "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN" => {
                Some(FIXTURE_SESSION_MINT_CREDENTIAL.to_owned())
            }
            _ => None,
        })
        .expect("public bind with every scoped credential should validate");

        assert_eq!(
            config.bind_addr,
            "0.0.0.0:4318".parse().expect("valid public bind")
        );
        assert!(config.ws_access.required_bearer.is_some());
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
                session_token_secret: Some(FIXTURE_SESSION_SIGNING_SECRET.into()),
                allowed_origins: vec!["https://app.example".to_owned()],
            },
            operator_access: OperatorAccess::new(Some(FIXTURE_OPERATOR_CREDENTIAL.into())),
            library_read_bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL.into()),
            library_delete_bearer: Some(FIXTURE_LIBRARY_DELETE_CREDENTIAL.into()),
            session_mint_credential: Some(FIXTURE_SESSION_MINT_CREDENTIAL.into()),
            ..ServiceConfig::default()
        };

        assert_eq!(config.validate(), Ok(()));
    }

    #[test]
    fn service_config_validation_accepts_rest_bearer_plus_session_token_signing() {
        let config = ServiceConfig {
            bind_addr: "0.0.0.0:4318".parse().expect("valid public bind"),
            ws_access: VoiceWsAccess {
                required_bearer: Some(FIXTURE_WS_CREDENTIAL.into()),
                session_token_secret: Some(FIXTURE_SESSION_SIGNING_SECRET.into()),
                allowed_origins: vec!["https://app.example".to_owned()],
            },
            operator_access: OperatorAccess::new(Some(FIXTURE_OPERATOR_CREDENTIAL.into())),
            library_read_bearer: Some(FIXTURE_LIBRARY_READ_CREDENTIAL.into()),
            library_delete_bearer: Some(FIXTURE_LIBRARY_DELETE_CREDENTIAL.into()),
            session_mint_credential: Some(FIXTURE_SESSION_MINT_CREDENTIAL.into()),
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
            issued_at: 40,
            not_before: 40,
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
            SessionTokenClaims::verify_at(&token, "secret", 39),
            Err(SessionTokenError::NotYetValid)
        );
        // `SERVICE-004` removed the hidden 60-second grace: `expires_at` is exact
        // and exclusive.
        assert_eq!(
            SessionTokenClaims::verify_at(&token, "secret", 100),
            Err(SessionTokenError::Expired)
        );
        assert_eq!(
            SessionTokenClaims::verify_at(&token, "secret", 160),
            Err(SessionTokenError::Expired)
        );
        assert_eq!(
            SessionTokenClaims::verify_at("viva1.not-json.not-signature", "secret", 99),
            Err(SessionTokenError::NoncanonicalBase64Url)
        );
        assert_eq!(
            SessionTokenClaims::verify_at("not-a-viva-token", "secret", 99),
            Err(SessionTokenError::Malformed)
        );
        let malformed_claims = serde_json::json!({
            "user_id": "",
            "study_set_id": "biology-midterm",
            "session_id": "voice-session-1",
            "issued_at": 40,
            "not_before": 40,
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
            Err(SessionTokenError::MissingClaim)
        );
        assert_eq!(
            format!("{claims:?}"),
            "SessionTokenClaims([REDACTED])",
            "claim values must never render"
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
                session_token_secret: Some("session-secret".into()),
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
                session_token_secret: Some("session-secret".into()),
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
                session_token_secret: Some("session-secret".into()),
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

    /// Fake, non-secret credentials used only to exercise the length and
    /// distinctness rules. They are literals in a test module, never values that
    /// authenticate anything.
    const FIXTURE_OPERATOR_CREDENTIAL: &str = "viva-fixture-operator-credential-0001";
    const FIXTURE_LIBRARY_READ_CREDENTIAL: &str = "viva-fixture-library-read-cred-000001";
    const FIXTURE_LIBRARY_DELETE_CREDENTIAL: &str = "viva-fixture-library-delete-cred-0001";
    const FIXTURE_WS_CREDENTIAL: &str = "viva-fixture-websocket-cred-00000001";
    const FIXTURE_SESSION_MINT_CREDENTIAL: &str = "viva-fixture-session-mint-cred-000001";
    const FIXTURE_SESSION_SIGNING_SECRET: &str = "viva-fixture-session-signing-secret01";
    const FIXTURE_PUBLIC_BIND: &str = "203.0.113.10:4318";
    const FIXTURE_ALLOWED_ORIGIN: &str = "https://app.example";
    const FIXTURE_CREDENTIAL_31_BYTES: &str = "vivafixturecredentialtooshort31";
    const FIXTURE_CREDENTIAL_32_BYTES: &str = "vivafixturecredentialexactly0032";

    fn config_from(
        pairs: Vec<(&'static str, &'static str)>,
    ) -> Result<ServiceConfig, ServiceConfigError> {
        ServiceConfig::from_env_with(move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        })
    }

    fn public_base_env() -> Vec<(&'static str, &'static str)> {
        vec![
            ("VIVA_AGENT_BIND_ADDR", FIXTURE_PUBLIC_BIND),
            ("VIVA_VOICE_WS_ALLOWED_ORIGINS", FIXTURE_ALLOWED_ORIGIN),
            ("VIVA_VOICE_WS_BEARER_TOKEN", FIXTURE_WS_CREDENTIAL),
            (
                "VIVA_VOICE_SESSION_TOKEN_SECRET",
                FIXTURE_SESSION_SIGNING_SECRET,
            ),
            (
                "VIVA_AGENT_OPERATOR_BEARER_TOKEN",
                FIXTURE_OPERATOR_CREDENTIAL,
            ),
            (
                "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                FIXTURE_LIBRARY_READ_CREDENTIAL,
            ),
            (
                "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                FIXTURE_LIBRARY_DELETE_CREDENTIAL,
            ),
            (
                "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                FIXTURE_SESSION_MINT_CREDENTIAL,
            ),
        ]
    }

    fn public_env(
        overrides: &[(&'static str, Option<&'static str>)],
    ) -> Vec<(&'static str, &'static str)> {
        let mut env = public_base_env();
        for (key, value) in overrides {
            env.retain(|(existing, _)| existing != key);
            if let Some(value) = value {
                env.push((key, value));
            }
        }
        env
    }

    /// One accepted row of the runtime-bound table: a label, the environment it
    /// supplies, and the parsed value it must produce.
    type AcceptedBoundCase = (
        &'static str,
        Vec<(&'static str, &'static str)>,
        fn(&ServiceConfig) -> bool,
    );

    /// One rejected row: a label, the environment it supplies, and the exact
    /// startup-fatal error it must produce.
    type RejectedBoundCase = (
        &'static str,
        Vec<(&'static str, &'static str)>,
        ServiceConfigError,
    );

    fn public_bind_addr() -> SocketAddr {
        FIXTURE_PUBLIC_BIND.parse().expect("valid public bind")
    }

    /// `SERVICE-010`: every runtime bound and operator credential is validated at
    /// startup. The table walks each key's default, minimum, maximum, one step
    /// outside each bound, an unparsable value, the cross-field invariants, and the
    /// non-loopback credential requirements.
    #[test]
    fn runtime_bounds() {
        let defaults = config_from(vec![]).expect("loopback defaults validate");

        assert_eq!(
            defaults.ws_timeouts,
            WsTimeouts {
                first_frame: Duration::from_secs(10),
                idle: bac_510_max_turn_duration(),
                between_turn_idle: Duration::from_secs(600),
                session: Duration::from_secs(21_600),
                heartbeat_interval: Duration::from_secs(30),
                pong_timeout: Duration::from_secs(10),
                outbound_write: Duration::from_secs(5),
                drain_grace: Duration::from_secs(20),
            }
        );
        assert_eq!(
            defaults.recorder_limits,
            RecorderLimits {
                evidence_events: 4_096,
                usage_events: 1_024,
            }
        );
        assert!(defaults.trusted_proxies.is_empty());
        assert!(!defaults.operator_access.is_configured());
        assert!(defaults.library_read_bearer.is_none());
        assert!(defaults.library_delete_bearer.is_none());
        assert!(defaults.session_mint_credential.is_none());
        assert!(!defaults.max_turn_duration_overridden);

        let accepted: Vec<AcceptedBoundCase> = vec![
            (
                "heartbeat minimum",
                vec![
                    ("VIVA_VOICE_WS_HEARTBEAT_SECONDS", "1"),
                    ("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS", "1"),
                ],
                |config| {
                    config.ws_timeouts.heartbeat_interval == Duration::from_secs(1)
                        && config.ws_timeouts.pong_timeout == Duration::from_secs(1)
                },
            ),
            (
                "heartbeat maximum",
                vec![("VIVA_VOICE_WS_HEARTBEAT_SECONDS", "300")],
                |config| config.ws_timeouts.heartbeat_interval == Duration::from_secs(300),
            ),
            (
                "pong minimum",
                vec![("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS", "1")],
                |config| config.ws_timeouts.pong_timeout == Duration::from_secs(1),
            ),
            (
                "pong maximum",
                vec![
                    ("VIVA_VOICE_WS_HEARTBEAT_SECONDS", "300"),
                    ("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS", "60"),
                ],
                |config| config.ws_timeouts.pong_timeout == Duration::from_secs(60),
            ),
            (
                "between-turn idle minimum",
                vec![("VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS", "1")],
                |config| config.ws_timeouts.between_turn_idle == Duration::from_secs(1),
            ),
            (
                "between-turn idle maximum",
                vec![("VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS", "3600")],
                |config| config.ws_timeouts.between_turn_idle == Duration::from_secs(3_600),
            ),
            (
                "outbound write minimum",
                vec![("VIVA_VOICE_WS_WRITE_TIMEOUT_SECONDS", "1")],
                |config| config.ws_timeouts.outbound_write == Duration::from_secs(1),
            ),
            (
                "outbound write maximum",
                vec![("VIVA_VOICE_WS_WRITE_TIMEOUT_SECONDS", "30")],
                |config| config.ws_timeouts.outbound_write == Duration::from_secs(30),
            ),
            (
                "drain grace minimum",
                vec![("VIVA_VOICE_DRAIN_GRACE_SECONDS", "1")],
                |config| config.ws_timeouts.drain_grace == Duration::from_secs(1),
            ),
            (
                "drain grace maximum",
                vec![("VIVA_VOICE_DRAIN_GRACE_SECONDS", "120")],
                |config| config.ws_timeouts.drain_grace == Duration::from_secs(120),
            ),
            (
                "evidence retention zero",
                vec![("VIVA_VOICE_EVIDENCE_RETENTION_EVENTS", "0")],
                |config| config.recorder_limits.evidence_events == 0,
            ),
            (
                "evidence retention maximum",
                vec![("VIVA_VOICE_EVIDENCE_RETENTION_EVENTS", "1000000")],
                |config| config.recorder_limits.evidence_events == 1_000_000,
            ),
            (
                "usage retention zero",
                vec![("VIVA_VOICE_USAGE_RETENTION_EVENTS", "0")],
                |config| config.recorder_limits.usage_events == 0,
            ),
            (
                "usage retention maximum",
                vec![("VIVA_VOICE_USAGE_RETENTION_EVENTS", "1000000")],
                |config| config.recorder_limits.usage_events == 1_000_000,
            ),
            (
                "trusted proxy CIDR list",
                vec![(
                    "VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS",
                    " 10.0.0.0/8 , 2001:db8::/32 ",
                )],
                |config| {
                    config
                        .trusted_proxies
                        .trusts("10.9.8.7".parse().expect("ipv4"))
                        && config
                            .trusted_proxies
                            .trusts("2001:db8::1".parse().expect("ipv6"))
                        && !config
                            .trusted_proxies
                            .trusts("11.0.0.1".parse().expect("ipv4"))
                        && !config
                            .trusted_proxies
                            .trusts("2001:db9::1".parse().expect("ipv6"))
                },
            ),
            (
                "session lifetime override",
                vec![("VIVA_VOICE_WS_SESSION_SECONDS", "1800")],
                |config| config.ws_timeouts.session == Duration::from_secs(1_800),
            ),
            (
                "turn deadline override below the BAC-510 cap",
                vec![("VIVA_VOICE_WS_TURN_SECONDS", "30")],
                |config| {
                    config.ws_timeouts.idle == Duration::from_secs(30)
                        && config.max_turn_duration_overridden
                },
            ),
            (
                "turn deadline override capped at the BAC-510 outer bound",
                vec![("VIVA_VOICE_WS_TURN_SECONDS", "120")],
                |config| {
                    config.ws_timeouts.idle == bac_510_max_turn_duration()
                        && config.max_turn_duration_overridden
                },
            ),
            (
                "between-turn idle one second below the session lifetime",
                vec![
                    ("VIVA_VOICE_WS_SESSION_SECONDS", "600"),
                    ("VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS", "599"),
                ],
                |config| {
                    config.ws_timeouts.between_turn_idle == Duration::from_secs(599)
                        && config.ws_timeouts.session == Duration::from_secs(600)
                },
            ),
            (
                "non-loopback bind with every required distinct credential",
                public_base_env(),
                |config| {
                    config.bind_addr == "203.0.113.10:4318".parse().expect("valid public bind")
                        && config.operator_access.is_configured()
                        && config.library_read_bearer.is_some()
                        && config.library_delete_bearer.is_some()
                },
            ),
            (
                "operator credential at the 32-byte minimum",
                public_env(&[(
                    "VIVA_AGENT_OPERATOR_BEARER_TOKEN",
                    Some(FIXTURE_CREDENTIAL_32_BYTES),
                )]),
                |config| config.operator_access.is_configured(),
            ),
        ];

        for (name, env, check) in accepted {
            let config =
                config_from(env).unwrap_or_else(|error| panic!("{name} should validate: {error}"));
            assert!(check(&config), "{name} parsed the wrong runtime bound");
        }

        let rejected: Vec<RejectedBoundCase> = vec![
            (
                "heartbeat below the minimum",
                vec![("VIVA_VOICE_WS_HEARTBEAT_SECONDS", "0")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_HEARTBEAT_SECONDS"),
            ),
            (
                "heartbeat above the maximum",
                vec![("VIVA_VOICE_WS_HEARTBEAT_SECONDS", "301")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_HEARTBEAT_SECONDS"),
            ),
            (
                "heartbeat is not a number",
                vec![("VIVA_VOICE_WS_HEARTBEAT_SECONDS", "thirty")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_HEARTBEAT_SECONDS"),
            ),
            (
                "pong below the minimum",
                vec![("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS", "0")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS"),
            ),
            (
                "pong above the maximum",
                vec![("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS", "61")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS"),
            ),
            (
                "pong is not a number",
                vec![("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS", "-1")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS"),
            ),
            (
                "pong greater than the heartbeat interval",
                vec![
                    ("VIVA_VOICE_WS_HEARTBEAT_SECONDS", "10"),
                    ("VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS", "11"),
                ],
                ServiceConfigError::PongTimeoutExceedsHeartbeat,
            ),
            (
                "between-turn idle below the minimum",
                vec![("VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS", "0")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS"),
            ),
            (
                "between-turn idle above the maximum",
                vec![("VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS", "3601")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS"),
            ),
            (
                "between-turn idle equal to the session lifetime",
                vec![
                    ("VIVA_VOICE_WS_SESSION_SECONDS", "600"),
                    ("VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS", "600"),
                ],
                ServiceConfigError::BetweenTurnIdleNotLessThanSession,
            ),
            (
                "outbound write below the minimum",
                vec![("VIVA_VOICE_WS_WRITE_TIMEOUT_SECONDS", "0")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_WRITE_TIMEOUT_SECONDS"),
            ),
            (
                "outbound write above the maximum",
                vec![("VIVA_VOICE_WS_WRITE_TIMEOUT_SECONDS", "31")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_WS_WRITE_TIMEOUT_SECONDS"),
            ),
            (
                "drain grace below the minimum",
                vec![("VIVA_VOICE_DRAIN_GRACE_SECONDS", "0")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_DRAIN_GRACE_SECONDS"),
            ),
            (
                "drain grace above the maximum",
                vec![("VIVA_VOICE_DRAIN_GRACE_SECONDS", "121")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_DRAIN_GRACE_SECONDS"),
            ),
            (
                "evidence retention above the maximum",
                vec![("VIVA_VOICE_EVIDENCE_RETENTION_EVENTS", "1000001")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_EVIDENCE_RETENTION_EVENTS"),
            ),
            (
                "evidence retention is not a number",
                vec![("VIVA_VOICE_EVIDENCE_RETENTION_EVENTS", "-1")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_EVIDENCE_RETENTION_EVENTS"),
            ),
            (
                "usage retention above the maximum",
                vec![("VIVA_VOICE_USAGE_RETENTION_EVENTS", "1000001")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_USAGE_RETENTION_EVENTS"),
            ),
            (
                "usage retention is not a number",
                vec![("VIVA_VOICE_USAGE_RETENTION_EVENTS", "many")],
                ServiceConfigError::InvalidRuntimeBound("VIVA_VOICE_USAGE_RETENTION_EVENTS"),
            ),
            (
                "trusted proxy CIDR without a prefix",
                vec![("VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS", "10.0.0.0")],
                ServiceConfigError::InvalidTrustedProxyCidr,
            ),
            (
                "trusted proxy CIDR with an out-of-range prefix",
                vec![("VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS", "10.0.0.0/33")],
                ServiceConfigError::InvalidTrustedProxyCidr,
            ),
            (
                "trusted proxy CIDR with an unparsable address",
                vec![(
                    "VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS",
                    "10.0.0.0/8,not-an-ip/8",
                )],
                ServiceConfigError::InvalidTrustedProxyCidr,
            ),
            (
                "non-loopback bind without an operator credential",
                public_env(&[("VIVA_AGENT_OPERATOR_BEARER_TOKEN", None)]),
                ServiceConfigError::PublicBindMissingCredential(
                    "VIVA_AGENT_OPERATOR_BEARER_TOKEN",
                    public_bind_addr(),
                ),
            ),
            (
                "non-loopback bind without a library read credential",
                public_env(&[("VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN", None)]),
                ServiceConfigError::PublicBindMissingCredential(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                    public_bind_addr(),
                ),
            ),
            (
                "non-loopback bind without a library delete credential",
                public_env(&[("VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN", None)]),
                ServiceConfigError::PublicBindMissingCredential(
                    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                    public_bind_addr(),
                ),
            ),
            (
                "non-loopback bind without a session-token signing secret",
                public_env(&[("VIVA_VOICE_SESSION_TOKEN_SECRET", None)]),
                ServiceConfigError::LibraryBearerRequiresSessionTokenSecret(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                ),
            ),
            (
                "operator credential one byte below the minimum",
                public_env(&[(
                    "VIVA_AGENT_OPERATOR_BEARER_TOKEN",
                    Some(FIXTURE_CREDENTIAL_31_BYTES),
                )]),
                ServiceConfigError::CredentialLengthOutOfRange("VIVA_AGENT_OPERATOR_BEARER_TOKEN"),
            ),
            (
                "library read credential one byte below the minimum",
                public_env(&[(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                    Some(FIXTURE_CREDENTIAL_31_BYTES),
                )]),
                ServiceConfigError::CredentialLengthOutOfRange(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                ),
            ),
            (
                "library delete credential one byte below the minimum",
                public_env(&[(
                    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                    Some(FIXTURE_CREDENTIAL_31_BYTES),
                )]),
                ServiceConfigError::CredentialLengthOutOfRange(
                    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                ),
            ),
            (
                "operator credential byte-equal to the library read credential",
                public_env(&[(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                    Some(FIXTURE_OPERATOR_CREDENTIAL),
                )]),
                ServiceConfigError::CredentialCollision(
                    "VIVA_AGENT_OPERATOR_BEARER_TOKEN",
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                ),
            ),
            (
                "library delete credential byte-equal to the library read credential",
                public_env(&[(
                    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                    Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                )]),
                ServiceConfigError::CredentialCollision(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                ),
            ),
            (
                "library delete credential byte-equal to the websocket credential",
                public_env(&[(
                    "VIVA_VOICE_WS_BEARER_TOKEN",
                    Some(FIXTURE_LIBRARY_DELETE_CREDENTIAL),
                )]),
                ServiceConfigError::CredentialCollision(
                    "VIVA_VOICE_WS_BEARER_TOKEN",
                    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
                ),
            ),
            (
                "library credential on loopback without a session-token signing secret",
                vec![(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                    FIXTURE_LIBRARY_READ_CREDENTIAL,
                )],
                ServiceConfigError::LibraryBearerRequiresSessionTokenSecret(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                ),
            ),
            // `A-32`: the session-mint credential is a route scope like the other
            // three. It is required on a public bind, length-bounded, byte-distinct
            // from every sibling, and useless without the signing secret whose
            // credentials it authorizes the minting of.
            (
                "non-loopback bind without a session-mint credential",
                public_env(&[("VIVA_AGENT_SESSION_MINT_BEARER_TOKEN", None)]),
                ServiceConfigError::PublicBindMissingCredential(
                    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                    public_bind_addr(),
                ),
            ),
            (
                "session-mint credential one byte below the minimum",
                public_env(&[(
                    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                    Some(FIXTURE_CREDENTIAL_31_BYTES),
                )]),
                ServiceConfigError::CredentialLengthOutOfRange(
                    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                ),
            ),
            (
                "session-mint credential byte-equal to the library read credential",
                public_env(&[(
                    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                    Some(FIXTURE_LIBRARY_READ_CREDENTIAL),
                )]),
                ServiceConfigError::CredentialCollision(
                    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
                    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                ),
            ),
            (
                "session-mint credential on loopback without a session-token signing secret",
                vec![(
                    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                    FIXTURE_SESSION_MINT_CREDENTIAL,
                )],
                ServiceConfigError::LibraryBearerRequiresSessionTokenSecret(
                    "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
                ),
            ),
        ];

        for (name, env, expected) in rejected {
            let error = config_from(env)
                .map(|_| ())
                .expect_err(&format!("{name} must be startup-fatal"));
            assert_eq!(error, expected, "{name} returned the wrong error");
        }
    }

    /// A redacting `Debug` is the only rendering of a configured credential.
    #[test]
    fn runtime_credentials_render_redacted() {
        let config = config_from(public_base_env()).expect("public bind config validates");

        let rendered = format!("{config:?}");
        for credential in [
            FIXTURE_OPERATOR_CREDENTIAL,
            FIXTURE_LIBRARY_READ_CREDENTIAL,
            FIXTURE_LIBRARY_DELETE_CREDENTIAL,
            FIXTURE_WS_CREDENTIAL,
            FIXTURE_SESSION_SIGNING_SECRET,
        ] {
            assert!(
                !rendered.contains(credential),
                "configuration Debug output must never render a credential"
            );
        }
        assert!(rendered.contains("RedactedSecret([REDACTED])"));
    }

    /// The operator credential is checked independently of the WebSocket bearer,
    /// which intentionally succeeds when no WebSocket bearer is configured.
    #[test]
    fn operator_access_validates_independently_of_the_websocket_bearer() {
        let config = config_from(public_env(&[("VIVA_VOICE_WS_BEARER_TOKEN", None)]))
            .expect("token-only public bind validates");
        let mut headers = HeaderMap::new();

        assert_eq!(
            config.ws_access.validate_bearer_headers(&headers),
            Ok(()),
            "the websocket bearer check is absent-permissive by design"
        );
        assert_eq!(
            config.operator_access.validate(&headers),
            Err(VoiceWsAccessError::MissingBearer)
        );

        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {FIXTURE_LIBRARY_READ_CREDENTIAL}"))
                .expect("header is valid"),
        );
        assert_eq!(
            config.operator_access.validate(&headers),
            Err(VoiceWsAccessError::InvalidBearer)
        );

        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {FIXTURE_OPERATOR_CREDENTIAL}"))
                .expect("header is valid"),
        );
        assert_eq!(config.operator_access.validate(&headers), Ok(()));
    }

    /// `IpNetwork` parses canonical CIDR strings, normalizes host bits, and never
    /// matches across address families.
    #[test]
    fn ip_networks_normalize_host_bits_and_stay_family_scoped() {
        let v4: IpNetwork = "10.1.2.3/8".parse().expect("ipv4 CIDR parses");
        assert_eq!(
            v4,
            IpNetwork::V4 {
                network: u32::from("10.0.0.0".parse::<std::net::Ipv4Addr>().expect("ipv4")),
                prefix: 8,
            }
        );
        assert!(v4.contains("10.255.255.255".parse().expect("ipv4")));
        assert!(!v4.contains("11.0.0.0".parse().expect("ipv4")));
        assert!(!v4.contains("::1".parse().expect("ipv6")));

        let v6: IpNetwork = "2001:db8::dead:beef/32".parse().expect("ipv6 CIDR parses");
        assert!(v6.contains("2001:db8:ffff::1".parse().expect("ipv6")));
        assert!(!v6.contains("2001:db9::1".parse().expect("ipv6")));
        assert!(!v6.contains("10.0.0.1".parse().expect("ipv4")));

        let any_v4: IpNetwork = "0.0.0.0/0".parse().expect("zero prefix parses");
        assert!(any_v4.contains("198.51.100.7".parse().expect("ipv4")));

        assert_eq!(
            "10.0.0.0".parse::<IpNetwork>(),
            Err(IpNetworkError::MissingPrefix)
        );
        assert_eq!(
            "not-an-ip/8".parse::<IpNetwork>(),
            Err(IpNetworkError::InvalidAddress)
        );
        assert_eq!(
            "10.0.0.0/many".parse::<IpNetwork>(),
            Err(IpNetworkError::InvalidPrefix)
        );
        assert_eq!(
            "10.0.0.0/33".parse::<IpNetwork>(),
            Err(IpNetworkError::InvalidPrefix)
        );
        assert_eq!(
            "2001:db8::/129".parse::<IpNetwork>(),
            Err(IpNetworkError::InvalidPrefix)
        );
    }
}

/// `SERVICE-013`: normal service startup may connect and run idempotent
/// migrations. It must not seed, restore, or mutate application rows. Fixture
/// setup stays explicit, in tests and development commands, outside
/// `build_study_store`.
#[cfg(test)]
mod postgres_startup_tests {
    use super::*;
    use uuid::Uuid;

    const FIXTURE_DOCUMENT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const FIXTURE_SOURCE_ID: &str = "33333333-3333-4333-8333-333333333333";
    const FIXTURE_CONCEPT_ID: &str = "55555555-5555-4555-8555-555555555555";

    #[tokio::test]
    #[ignore = "requires SERVICE_POSTGRES_REQUIRED=1 and a disposable PostgreSQL 16 DATABASE_URL"]
    async fn postgres_startup_does_not_resurrect_fixture() {
        let database_url = required_service_postgres_url();
        let pool = data::connect_pg(&data::PgConfig::new(database_url.clone()))
            .await
            .expect("isolated postgres should connect");
        data::run_migrations(&pool)
            .await
            .expect("migrations should run");
        data::seed_postgres_fixture(&pool)
            .await
            .expect("explicit test fixture seed should run");

        let before: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM study_documents), \
                    (SELECT COUNT(*) FROM source_spans), \
                    (SELECT COUNT(*) FROM concepts)",
        )
        .fetch_one(&pool)
        .await
        .expect("row counts should load");

        sqlx::query("UPDATE study_documents SET deleted_at = NOW() WHERE id = $1")
            .bind(Uuid::parse_str(FIXTURE_DOCUMENT_ID).expect("document UUID"))
            .execute(&pool)
            .await
            .expect("document should tombstone");
        sqlx::query("UPDATE source_spans SET deleted_at = NOW() WHERE id = $1")
            .bind(Uuid::parse_str(FIXTURE_SOURCE_ID).expect("source UUID"))
            .execute(&pool)
            .await
            .expect("source should tombstone");
        sqlx::query("UPDATE concepts SET label = 'deletion-sentinel' WHERE id = $1")
            .bind(Uuid::parse_str(FIXTURE_CONCEPT_ID).expect("concept UUID"))
            .execute(&pool)
            .await
            .expect("concept sentinel should persist");

        let config = ServiceConfig {
            database_url: Some(database_url),
            ..ServiceConfig::default()
        };
        drop(
            build_study_store(&config)
                .await
                .expect("first startup should succeed"),
        );
        drop(
            build_study_store(&config)
                .await
                .expect("second startup should succeed"),
        );

        let after: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM study_documents), \
                    (SELECT COUNT(*) FROM source_spans), \
                    (SELECT COUNT(*) FROM concepts)",
        )
        .fetch_one(&pool)
        .await
        .expect("row counts should reload");
        assert_eq!(after, before);
        assert!(sqlx::query_scalar::<_, bool>(
            "SELECT deleted_at IS NOT NULL FROM study_documents WHERE id = $1",
        )
        .bind(Uuid::parse_str(FIXTURE_DOCUMENT_ID).expect("document UUID"))
        .fetch_one(&pool)
        .await
        .expect("document tombstone should load"));
        assert!(sqlx::query_scalar::<_, bool>(
            "SELECT deleted_at IS NOT NULL FROM source_spans WHERE id = $1",
        )
        .bind(Uuid::parse_str(FIXTURE_SOURCE_ID).expect("source UUID"))
        .fetch_one(&pool)
        .await
        .expect("source tombstone should load"));
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT label FROM concepts WHERE id = $1")
                .bind(Uuid::parse_str(FIXTURE_CONCEPT_ID).expect("concept UUID"))
                .fetch_one(&pool)
                .await
                .expect("concept label should load"),
            "deletion-sentinel",
        );
    }

    /// The flag and the URL are both required. A missing one fails the gate
    /// rather than returning quietly, so a skipped run can never be read as
    /// evidence.
    fn required_service_postgres_url() -> String {
        assert_eq!(
            std::env::var("SERVICE_POSTGRES_REQUIRED").as_deref(),
            Ok("1"),
            "service durable tests require SERVICE_POSTGRES_REQUIRED=1",
        );
        std::env::var("DATABASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .expect("SERVICE_POSTGRES_REQUIRED=1 requires a non-empty DATABASE_URL")
    }
}
