# Agent Service Runtime Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Rust agent service fail closed at admission, keep every long-lived resource bounded, prove deterministic lease release and drain behavior, and expose the authenticated study projection required by Plans 04, 09, 10, and 11.

**Architecture:** Keep the WebSocket session as the resource-ownership boundary, but move network identity, operator authorization, bounded recorders, bounded writes, and runtime accounting into server-owned types. A verified upgrade produces admission context; the first bound `session_config` consumes its nonce; all exits drop RAII leases and active-handler guards. Plan 05 remains the only writer of the v5 wire types and fixtures. This plan imports those types, tests their exact fixtures, and makes no protocol-version change. Access-token renewal always replaces the socket; the in-socket v5 `session_refresh` changes context only.

**Tech Stack:** Rust 2021, Axum WebSocket/HTTP, Tokio paused time, Futures `Sink`, Serde, HMAC session tokens, SQLx/Postgres integration tests.

**Spec:** `docs/superpowers/reviews/2026-08-23-rust-agent-service.md`

**Review inputs:** `docs/superpowers/reviews/2026-08-23-security.md`, `2026-08-23-security-review.md`, `2026-08-23-reliability-and-performance-review.md`, `2026-08-23-quality-and-tests-review.md`, `2026-08-23-correctness-review.md`, `2026-08-23-comprehensive-review-summary.md`, and `docs/superpowers/reviews/index.md`.

**Upstream contracts:** `docs/superpowers/plans/2026-08-23-expedited-critical-path.md` (Plan 03, locked v5 audio) and `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md` (Plan 05, frozen v5 wire/auth plus `D-07 TOKEN_ONLY_REFRESH`).

## Global Constraints

- Begin only after Plans 03 and 05 land; this lane's merge additionally requires Plans 04B, 06, and 09 merged per Program Section 6, and Tasks 6–7 consume their published ports/artifacts. Read Plan 05's immutable `agent/fixtures/voice-protocol/v5/auth-decision.json`; stop unless it records exactly one valid `D-07 TOKEN_ONLY_REFRESH` branch.
- Do not choose `D-04 DELETION_UX`. Read the coordinator decision record before Task 6's restore subtask. `CONFIRM_DELETE` means no restore route or dead restore test/config branch; `SOFT_DELETE_UNDO` means the exact conditional route below after Plan 09 publishes its durable 30-second restore port.
- Existing protocol v4 is the baseline that Plan 03 intentionally raises to v5 for bounded `audio_chunk`/`audio_end`. Import Plan 05's current-version constant, assert that it equals `5`, and never renumber it in this plan.
- Permanent runtime ownership after the Plan 05 handoff is `agent/crates/agent-service/src/ws.rs`, `app.rs`, `main.rs`, `config.rs`, and `lib.rs`, including the exact `src/ws/**` and `src/http/**` responsibility modules introduced by Task 13. Plan 05 exclusively owns `agent/crates/agent-service/src/protocol.rs`, `agent/fixtures/voice-protocol/**`, and `packages/core/src/agent-contract.ts`; it also removes the dead `ReadyFrame` and `lib.rs` re-export before handoff.
- Read, but never modify, these Plan 05 fixtures: `agent/fixtures/voice-protocol/v5/client-session-config-signed.json`, `agent/fixtures/voice-protocol/v5/client-session-refresh.json`, `agent/fixtures/session-token/v1/vectors.json`, and `agent/fixtures/voice-protocol/v5/manifest.json`.
- Add Tokio paused-time support only to `agent/crates/agent-service/Cargo.toml` under `[dev-dependencies]`: `tokio = { workspace = true, features = ["test-util"] }`. Do not edit `agent/Cargo.toml`.
- All runtime bounds are server configuration. Client frames cannot extend heartbeat, between-turn idle, absolute lifetime, queue, retention, or drain deadlines.
- Tests must inspect server-owned permits, counters, and snapshots. A client close frame or a locally green mock is not release proof.
- Strict TDD is mandatory: add the named RED test, run it and record the expected failure, make the smallest fail-closed implementation, rerun GREEN, then execute the named mutation/negative control before committing. Do not add a permissive fallback, stub, ignored assertion, swallowed error, or optional external-evidence skip to make a gate green.
- `D-07 TOKEN_ONLY_REFRESH`, `D-03 MODE_GOAL_CONTRACT`, and `D-04 DELETION_UX` are hard gates. Execute and commit only the selected branch, delete or prove absent the unselected runtime surface, and stop on a missing/unknown decision record rather than inferring from configuration or existing code.
- Upstream type/fixture disagreement is a blocking defect returned to the owning plan. Do not shadow, coerce, string-classify, or locally patch an upstream contract in service code.
- Use sanitized identities in logs/evidence. Never export bearer values, refresh credentials, raw session tokens, nonce values, raw transcript, or raw audio.
- Run every unqualified `cargo` command from `agent/`; commands with `--manifest-path agent/Cargo.toml` run from the repository root. Use focused tests before the full workspace suite; stage only the files listed by the task.

## Interfaces fixed by this plan

Add these exact configuration keys and defaults (rows marked "(existing)" are already parsed today and keep their behavior; they are listed so Task 1 specifies the full `WsTimeouts` mapping):

| Environment key | Default | Validation |
| --- | ---: | --- |
| `VIVA_AGENT_OPERATOR_BEARER_TOKEN` | absent on loopback only | required for a non-loopback bind; 32-512 bytes |
| `VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN` | absent on loopback only | required for a non-loopback bind; 32-512 bytes |
| `VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN` | absent on loopback only | required for a non-loopback bind; 32-512 bytes; distinct from read/operator/WebSocket credentials |
| `VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS` | empty | comma-separated IPv4/IPv6 CIDRs; invalid entry is startup-fatal |
| `VIVA_VOICE_WS_HEARTBEAT_SECONDS` | 30 | integer 1-300 |
| `VIVA_VOICE_WS_PONG_TIMEOUT_SECONDS` | 10 | integer 1-60 and not greater than heartbeat |
| `VIVA_VOICE_WS_BETWEEN_TURN_IDLE_SECONDS` | 600 | integer 1-3600 and less than absolute session lifetime |
| `VIVA_VOICE_WS_WRITE_TIMEOUT_SECONDS` | 5 | integer 1-30 |
| `VIVA_VOICE_DRAIN_GRACE_SECONDS` | 20 | integer 1-120 |
| `VIVA_VOICE_EVIDENCE_RETENTION_EVENTS` | 4096 | integer 0-1,000,000; zero retains no events |
| `VIVA_VOICE_USAGE_RETENTION_EVENTS` | 1024 | integer 0-1,000,000; zero retains no events |
| `VIVA_VOICE_WS_TURN_SECONDS` (existing) | BAC-510 outer bound | positive integer seconds; parsed into `ws_timeouts.idle`, still capped by `bac_510_max_turn_duration()`, setting `max_turn_duration_overridden` when supplied |
| `VIVA_VOICE_WS_SESSION_SECONDS` (existing) | 21600 | positive integer seconds; parsed into `ws_timeouts.session` |

`VIVA_VOICE_WS_TURN_SECONDS` remains the in-turn progress deadline (parsed into `ws_timeouts.idle`, still capped by `bac_510_max_turn_duration` with `max_turn_duration_overridden` semantics preserved) and `VIVA_VOICE_WS_SESSION_SECONDS` remains the absolute session lifetime (`ws_timeouts.session`); neither is the between-turn sleeping-client deadline. `ws_timeouts.first_frame` has no environment key and keeps its existing 10-second default. This plan introduces no key named `VIVA_VOICE_WS_IDLE_SECONDS`.

---

### Task 1: Add validated runtime and operator configuration (SERVICE-010)

**Files:**
- Modify: `agent/crates/agent-service/Cargo.toml`
- Modify: `agent/crates/agent-service/src/config.rs`
- Modify: `agent/crates/agent-service/src/app.rs`
- Test: `agent/crates/agent-service/src/config.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`

**Interfaces:**

```rust
#[derive(Clone, Eq, PartialEq)]
pub struct RedactedSecret(Arc<str>);

impl Debug for RedactedSecret {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("RedactedSecret([REDACTED])")
    }
}

impl RedactedSecret {
    fn as_str(&self) -> &str {
        self.0.as_ref()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct VoiceWsAccess {
    pub required_bearer: Option<RedactedSecret>,
    pub session_token_secret: Option<RedactedSecret>,
    pub allowed_origins: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct OperatorAccess {
    bearer: Option<RedactedSecret>,
}

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
        let (address, prefix) = value
            .split_once('/')
            .ok_or(IpNetworkError::MissingPrefix)?;
        let address = address
            .parse::<IpAddr>()
            .map_err(|_| IpNetworkError::InvalidAddress)?;
        let prefix = prefix
            .parse::<u8>()
            .map_err(|_| IpNetworkError::InvalidPrefix)?;
        match address {
            IpAddr::V4(address) if prefix <= 32 => {
                let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
                Ok(Self::V4 {
                    network: u32::from(address) & mask,
                    prefix,
                })
            }
            IpAddr::V6(address) if prefix <= 128 => {
                let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
                Ok(Self::V6 {
                    network: u128::from(address) & mask,
                    prefix,
                })
            }
            IpAddr::V4(_) | IpAddr::V6(_) => Err(IpNetworkError::InvalidPrefix),
        }
    }
}

impl IpNetwork {
    pub fn contains(self, address: IpAddr) -> bool {
        match (self, address) {
            (Self::V4 { network, prefix }, IpAddr::V4(address)) => {
                let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
                u32::from(address) & mask == network
            }
            (Self::V6 { network, prefix }, IpAddr::V6(address)) => {
                let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
                u128::from(address) & mask == network
            }
            (Self::V4 { .. }, IpAddr::V6(_)) | (Self::V6 { .. }, IpAddr::V4(_)) => false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TrustedProxyConfig {
    networks: Arc<[IpNetwork]>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecorderLimits {
    pub evidence_events: usize,
    pub usage_events: usize,
}

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
    pub trusted_proxies: TrustedProxyConfig,
    pub recorder_limits: RecorderLimits,
    pub ws_timeouts: WsTimeouts,
    pub max_turn_duration_overridden: bool,
    pub max_sessions: usize,
    pub voice_limits: VoiceLimitConfig,
    pub failure_control: FailureControlConfig,
}
```

`IpNetwork` must parse canonical IPv4 and IPv6 CIDR strings with standard-library `IpAddr` plus an explicit prefix length, normalize host bits, and implement `contains(IpAddr)`. Do not add a CIDR dependency for this small surface.

- [ ] Add `tokio = { workspace = true, features = ["test-util"] }` under `[dev-dependencies]` in `agent/crates/agent-service/Cargo.toml`; do not change the root workspace manifest.
- [ ] Add table-driven RED tests for every key above: defaults, minimum, maximum, one below/above the bounds, invalid number/CIDR, `pong_timeout > heartbeat_interval`, and non-loopback startup without an operator bearer.
- [ ] Run `cargo test -p agent-service config::tests::runtime_bounds -- --exact` from `agent/`. Expected RED: fields and validation variants do not exist.
- [ ] Replace the duplicate `max_session_duration`/`max_turn_duration` fields with `ws_timeouts`, add the exact `ServiceConfig` fields above, parse once in `ServiceConfig::from_env_with`, and validate cross-field invariants in `ServiceConfig::validate`. A non-loopback bind requires operator auth, distinct library-read/library-delete bearers, and a session-token secret; Task 4 additionally enforces its selected shared-bearer/token-only branch. Configuring either library bearer without a session-token secret is startup-fatal. Reject byte-equal operator/read/delete/WebSocket credentials so route scopes cannot collapse by configuration. Keep secret values behind redacting `Debug` output.
- [ ] Give readiness an independent `OperatorAccess::validate(&HeaderMap) -> Result<(), AccessError>`. Do not reuse `VoiceWsAccess::validate_bearer_headers`, because it intentionally succeeds when its bearer is absent.
- [ ] Add RED route tests proving `/live` remains public and minimal while `/ready` and `/health/brain` return `401` for absent/wrong operator credentials and `200` for the configured operator credential. Assert responses never echo either credential.
- [ ] Run `cargo test -p agent-service readiness_operator_auth` and `cargo test -p agent-service config::tests`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/Cargo.toml agent/crates/agent-service/src/config.rs agent/crates/agent-service/src/app.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): validate runtime and operator bounds"
```

### Task 2: Bound evidence and usage retention with O(1) aggregates (SERVICE-005)

**Files:**
- Modify: `agent/crates/agent-service/src/app.rs`
- Modify: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`

**Interfaces:**

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct RecorderStats {
    pub capacity: usize,
    pub retained: usize,
    pub total_recorded: u64,
    pub dropped: u64,
}

struct RetainedEvents<T> {
    capacity: usize,
    events: VecDeque<T>,
    total_recorded: u64,
    dropped: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct VoiceUsageAggregate {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
    pub invalid_cost_events: u64,
}

#[derive(Clone, Debug)]
pub struct VoiceEvidenceRecorder {
    retained: Arc<RwLock<RetainedEvents<VoiceEvidenceEvent>>>,
}

struct VoiceUsageState {
    retained: RetainedEvents<VoiceUsageEvent>,
    aggregate: VoiceUsageAggregate,
}

#[derive(Clone, Debug)]
pub struct VoiceUsageRecorder {
    state: Arc<RwLock<VoiceUsageState>>,
}
```

`record` increments `total_recorded` with saturating arithmetic, updates the usage aggregate under the same lock before eviction, and keeps at most `capacity` newest sanitized events. Add tokens with saturating arithmetic. Accumulate only finite, non-negative cost; otherwise increment `invalid_cost_events`. `stats` and `summary` copy counters without walking retained events.

- [ ] Add a RED test that records exactly 1,000,000 deterministic events into capacity `257`, asserts `retained == 257`, `total_recorded == 1_000_000`, `dropped == 999_743`, and validates token/cost totals after early events have been evicted.
- [ ] Add a zero-capacity negative control: aggregates and total/dropped counts advance while `snapshot()` stays empty.
- [ ] Add hostile retained-event/provider/model strings containing `viva1.`, `Bearer `, transcript text, and base64 audio; assert constructors sanitize or reject them before retention and neither `snapshot()` nor readiness JSON contains a forbidden value.
- [ ] Add a readiness test that checks only aggregate counts and `RecorderStats`; assert no user ID, session ID, transcript text, audio bytes, token, or nonce is present.
- [ ] Run `cargo test -p agent-service recorder_retention_is_bounded -- --exact`. Expected RED: both recorders still use unbounded `Vec` and usage summary scans it.
- [ ] Replace the vectors with the interfaces above, inject `RecorderLimits` from `ServiceConfig`, and update all recorder construction sites. Preserve existing exact under-cap fixture snapshots.
- [ ] Run `cargo test -p agent-service recorder_` and `cargo test -p agent-service --test voice_ws readiness_`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/app.rs agent/crates/agent-service/src/ws.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): bound voice telemetry retention"
```

### Task 3: Derive client IP only from the peer and trusted proxies (SERVICE-003)

**Files:**
- Modify: `agent/crates/agent-service/src/config.rs`
- Modify: `agent/crates/agent-service/src/ws.rs`
- Modify: `agent/crates/agent-service/src/main.rs`
- Test: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`

**Interfaces:**

```rust
pub async fn voice_ws(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, VoiceWsRejection>;

fn client_ip_key(
    peer: SocketAddr,
    headers: &HeaderMap,
    trusted: &TrustedProxyConfig,
) -> Result<IpAddr, ClientIpError>;
```

Algorithm: if the direct peer is untrusted, ignore forwarding headers and use `peer.ip()`. If the peer is trusted, require a syntactically valid `X-Forwarded-For`, parse every comma-separated hop, scan right-to-left while skipping configured trusted hops, and select the first untrusted hop. An empty/malformed chain or an all-trusted chain is an admission error when IP limiting is enabled. Do not consult `X-Real-IP` and do not collapse failures into an `unknown` bucket.

Set `const MAX_FORWARDED_HOPS: usize = 32`; reject a trusted-proxy chain above that count before allocating a hop vector or a session permit.

- [ ] Add pure RED table tests: direct attacker with spoofed XFF, trusted proxy with `client, trusted, trusted`, rightmost-untrusted mixed chain, malformed IPv4, malformed IPv6, empty elements, all-trusted chain, exactly 32 hops, 33 hops, and untrusted peer that supplies a valid-looking chain.
- [ ] Add an integration RED test that fills the IP cap from a direct peer while varying XFF values. Assert the next upgrade is rejected and the internal per-IP lease count stays at the configured cap.
- [ ] Run `cargo test -p agent-service client_ip_`. Expected RED: current code trusts the left-most header and accepts `unknown`.
- [ ] Implement strict extraction before acquiring the session permit. Change production and test servers to `app.into_make_service_with_connect_info::<SocketAddr>()`.
- [ ] Add lease-drop assertions after disconnect, preflight rejection, heartbeat timeout, slow-client timeout, and drain. The exact peer entry must disappear at zero count.
- [ ] Run `cargo test -p agent-service client_ip_` and `cargo test -p agent-service --test voice_ws ip_cap_`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/config.rs agent/crates/agent-service/src/ws.rs agent/crates/agent-service/src/main.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): trust only configured proxy hops"
```

Handoff: `docs/deployment-runbook.md` is Plan 12-owned; this plan does not edit it. Send Plan 12 the exact replacement guidance for the direct-WSS recipe: `VIVA_VOICE_WS_MAX_IP_SESSIONS` now keys off the socket peer address (or the rightmost untrusted hop behind `VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS`); remove any claim that direct deployments require a forwarding proxy header, and document that unset trusted proxies means forwarding headers are ignored. Record this handoff against SERVICE-003 in the lane PR so the coordinator can link the Plan 12 commit in the ledger rows requiring the runbook update.

### Task 4: Apply the locked token-only decision at HTTP upgrade (SERVICE-004, D-07)

**Files:**
- Modify: `agent/crates/agent-service/src/config.rs`
- Modify: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/src/config.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`
- Read only: `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md`
- Read only: `agent/fixtures/voice-protocol/v5/auth-decision.json`
- Read only: `agent/fixtures/session-token/v1/vectors.json`

**Decision gate:** Parse Plan 05's `auth-decision.json` and require `decision == "D-07 TOKEN_ONLY_REFRESH"`. Execute Task 4A only for `branch == "retain-token-only"`, or Task 4B only for `branch == "require-service-auth"`. Any other/missing value blocks execution. Record the fixture's SHA-256 and selected branch in the lane proof/PR referenced by the coordinator ledger. Do not merge both implementations.

Both branches use one strict verifier:

```rust
#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionTokenClaims {
    pub user_id: String,
    pub study_set_id: String,
    pub session_id: String,
    pub issued_at: u64,
    pub not_before: u64,
    pub expires_at: u64,
    pub nonce: String,
    #[serde(default)]
    pub failure_control: Option<FailureControlClaim>,
}

impl Debug for SessionTokenClaims {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionTokenClaims([REDACTED])")
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct ExpectedSessionBinding<'a> {
    pub user_id: &'a str,
    pub study_set_id: &'a str,
    pub session_id: &'a str,
}

pub fn verify_session_token_at(
    encoded: &str,
    secret: &RedactedSecret,
    now_unix_seconds: u64,
    expected: Option<ExpectedSessionBinding<'_>>,
) -> Result<SessionTokenClaims, SessionTokenError>;
```

It accepts canonical unpadded base64url only, rejects unknown/duplicate/missing claims, verifies HMAC before returning claims, requires `issued_at <= not_before < expires_at` and `not_before <= now < expires_at`, rejects an empty nonce, and applies `expected` binding when supplied. It never includes encoded input, claim values, signatures, or JSON fragments in `Debug`, errors, logs, or responses.

- [ ] Add one common RED vector runner over every case in `agent/fixtures/session-token/v1/vectors.json`, using its fake secret, clock, expected binding, `valid`, claims, and exact rejection code byte-for-byte. Do not copy vector secrets into Rust literals or mint expected tokens with the verifier.
- [ ] Add a common RED ordering test for both auth branches: preflight performs zero nonce calls; after authenticated first-config identity binding, user/user-study-set/provider-backoff admission runs first, then the one atomic nonce claim before any study lookup, queueing, or provider input; a capacity/backoff denial closes the socket without consuming the nonce; replay/store failure releases session/IP resources with zero provider work.
- [ ] Add an explicit RED lease-denial case asserting a capacity/backoff-denied connection leaves the nonce claimable by a later attempt with the same token, preserving the existing baseline `websocket_provider_backoff_denial_does_not_consume_signed_nonce` test rather than reconciling it away.
- [ ] Run `cargo test -p agent-service session_token_v1_vectors -- --exact`. Expected RED includes the current hidden 60-second expiry skew and incomplete canonical/claim validation.
- [ ] Implement `verify_session_token_at` and the common claim ordering, make initial-frame verification call it, expose it to Task 6's projection verifier, and rerun both common tests to PASS before executing the selected branch below.

#### Task 4A: Retain public token-only mode with verified preflight

**Interfaces:**

```rust
#[derive(Clone)]
struct VerifiedUpgradeToken {
    encoded: RedactedSecret,
    claims: SessionTokenClaims,
}

impl Debug for VerifiedUpgradeToken {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("VerifiedUpgradeToken([REDACTED])")
    }
}

#[derive(Clone, Debug)]
enum UpgradePrincipal {
    ServiceBearer,
    TokenOnly(VerifiedUpgradeToken),
}

struct VoiceAdmission {
    session_permit: OwnedSemaphorePermit,
    ip_lease: VoiceLimitLease,
    principal: UpgradePrincipal,
}

fn authenticate_upgrade(
    headers: &HeaderMap,
    access: &VoiceWsAccess,
    now_unix_seconds: u64,
) -> Result<UpgradePrincipal, AccessError>;
```

In token-only public mode, extract the signed session token from the existing `bearer.<base64url(token)>` entry in `Sec-WebSocket-Protocol`, verify HMAC/signature and time bounds during HTTP upgrade, and carry the verified claims into `VoiceAdmission`. Do not call the nonce store during preflight. At the first typed v5 `session_config`, constant-time compare its token with the preflight token, bind user/study/client-session claims, run user/user-study-set/provider-backoff admission, then claim the nonce exactly once before any study lookup, queueing, or provider input; a capacity/backoff denial closes the socket without consuming the nonce. An upgrade that disconnects before a bound `session_config` leaves the nonce usable. An accepted first config makes replay fail. Enforce the absolute `session` timeout; access-token renewal requires a new socket/generation.

- [ ] Add RED HTTP tests for missing token, malformed token, bad signature, expired token, wrong subprotocol, and valid token. For every rejection assert status `401`, no `Ready`, unchanged session-slot availability, unchanged IP leases, and zero nonce-store calls.
- [ ] Add a RED nonce timing test: valid upgrade, server `Ready`, disconnect before `session_config`, reconnect with the same token, accept the first bound config, then reject a third replay. Assert the nonce store sees one successful claim total.
- [ ] Run `cargo test -p agent-service --test voice_ws token_only_preflight_`. Expected RED: token-only upgrade reaches `Ready` before token verification.
- [ ] Implement `authenticate_upgrade` before session-slot/IP acquisition. Preserve the baseline admission-then-nonce order: authenticated first-config identity binding, then user/user-study-set/provider-backoff admission, then the one atomic nonce claim before any study lookup, queueing, or provider dispatch; a denied admission closes the socket without consuming the nonce. On replay/store failure, emit only Plan 05's coarse typed auth/store outcome and release the upgrade-owned session/IP resources.
- [ ] Run the focused tests plus `cargo test -p agent-service --test voice_ws signed_session_nonce_`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/config.rs agent/crates/agent-service/src/ws.rs agent/crates/agent-service/tests/voice_ws.rs
decision_sha="$(shasum -a 256 agent/fixtures/voice-protocol/v5/auth-decision.json | awk '{print $1}')"
git commit -m "fix(agent-service): verify token-only websocket preflight" -m "D-07 TOKEN_ONLY_REFRESH: retain-token-only; auth-decision sha256=$decision_sha"
```

Branch A has a downstream release gate: Plan 11 must provide a separate rotating one-time refresh credential stored only as a hash, bind it to the verified user/study/client-session identity, rotate it on each use, revoke it on replay/deletion, and refuse refresh after the original absolute session expiry. That credential never enters this service or a v5 frame. Task 5 consumes Plan 05's context-only `session_refresh` fixture, which is unrelated to access-token renewal.

#### Task 4B: Remove public token-only mode

Public deployments require a shared service bearer at HTTP upgrade. A signed session token remains first-frame identity proof behind that service-authenticated boundary; it is never accepted as the HTTP bearer.

- [ ] Add RED config tests proving a non-loopback public bind with a session-token secret but no shared service bearer is rejected.
- [ ] Add RED HTTP tests proving absent/wrong shared bearer returns `401` before a slot, IP lease, `Ready`, or nonce access; a signed session token in the bearer/subprotocol position must also return `401`.
- [ ] Run `cargo test -p agent-service --test voice_ws service_bearer_preflight_`. Expected RED: the session-token fallback admits the request.
- [ ] Delete the session-token fallback in `validate_ws_bearer_headers`, delete token-only configuration branches, and delete only tests made unreachable by the locked decision. Preserve first-frame signed-token identity/nonce tests behind a valid service bearer.
- [ ] Run `cargo test -p agent-service config::tests` and `cargo test -p agent-service --test voice_ws`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/config.rs agent/crates/agent-service/src/ws.rs agent/crates/agent-service/tests/voice_ws.rs
decision_sha="$(shasum -a 256 agent/fixtures/voice-protocol/v5/auth-decision.json | awk '{print $1}')"
git commit -m "fix(agent-service): require authenticated websocket deployment" -m "D-07 TOKEN_ONLY_REFRESH: require-service-auth; auth-decision sha256=$decision_sha"
```

Branch B has a downstream release gate: Plans 04/11 must delete token-only mint/refresh routes, browser storage, deployment variables, and tests, and must configure the shared service bearer between trusted services. Do not leave unreachable token-only settings documented.

### Task 5: Consume Plan 05 v5 session/refresh contracts (SERVICE-007, SERVICE-009)

**Files:**
- Modify: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`
- Read only: `docs/superpowers/plans/2026-08-23-learning-core-authority.md`
- Read only: `agent/crates/agent-service/src/protocol.rs`
- Read only: `agent/crates/agent-service/src/lib.rs`
- Read only: `agent/fixtures/voice-protocol/v5/client-session-config-signed.json`
- Read only: `agent/fixtures/voice-protocol/v5/client-session-refresh.json`
- Read only: `agent/fixtures/voice-protocol/v5/terminal-sequences.json`
- Read only: `agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json`
- Read only: `agent/fixtures/voice-protocol/v5/manifest.json`

**Interfaces:**

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
struct SessionIdentity {
    user_id: UserId,
    study_set_id: StudySetId,
    signed_session_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionAuthMode {
    Trusted,
    Signed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AuthorizedClientSession {
    client: SessionIdentity,
    client_generation_id: String,
    server_session_id: String,
    auth_mode: SessionAuthMode,
    learning_intent: BoundLearningIntentV1,
    absolute_expires_at_unix_seconds: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LearningIntentRefreshPolicy {
    ClaimBound,
    QuizOnlyNoRefresh,
}

fn validate_refresh_context(
    context: SessionRefreshContext, // Plan 05's Rust struct; mirrors TS AgentSessionRefreshContext
    authorized: &BoundLearningIntentV1,
    policy: LearningIntentRefreshPolicy,
) -> Result<BoundLearningIntentV1, ClientFrameError> {
    if policy == LearningIntentRefreshPolicy::QuizOnlyNoRefresh {
        return Err(ClientFrameError::session_refresh_policy_denied());
    }
    if context.mode.as_ref().is_some_and(|mode| mode != &authorized.mode)
        || context
            .initial_goal
            .as_ref()
            .is_some_and(|goal| Some(goal) != authorized.goal.as_ref())
    {
        return Err(ClientFrameError::session_refresh_policy_denied());
    }
    Ok(authorized.clone())
}

fn bind_context_refresh(
    refresh: SessionRefresh,
    authorized: &AuthorizedClientSession,
    policy: LearningIntentRefreshPolicy,
) -> Result<BrainInput, ClientFrameError> {
    if refresh.client_generation_id != authorized.client_generation_id {
        return Err(ClientFrameError::generation_mismatch());
    }
    let context = validate_refresh_context(
        refresh.context,
        &authorized.learning_intent,
        policy,
    )?;
    serde_json::to_value(BoundSessionRefreshContext {
        session_id: &authorized.server_session_id,
        mode: &context.mode,
        initial_goal: context.goal.as_deref(),
    })
    .map(BrainInput::SessionContextRefresh)
    .map_err(|_| ClientFrameError::internal_serialization())
}

#[derive(Serialize)]
struct BoundSessionRefreshContext<'a> {
    session_id: &'a str,
    mode: &'a StudyMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_goal: Option<&'a str>,
}
```

Use Plan 05's public `ClientFrame::SessionConfig` and `SessionRefresh` variants directly; delete the private `InitialClientFrame` shadow type. The initial signed config binds verified user/study/signed-session claims plus `client_generation_id`; trusted loopback mode binds the configured identity and same generation. Generate a separate server session ID for provider/store work. The context-only refresh must match the bound generation, exact-match/overwrite mode and goal from Plan 04's server-bound `BoundLearningIntentV1`, and rewrite provider-facing session identity to the unchanged server ID. It never rotates either session ID or the client generation. Plan 05's strict parser rejects token/user/study/session/source/active-concept fields on refresh before this helper. Access-token renewal, nonce consumption, and identity rebinding never happen inside the open socket: renewal opens a new generation and consumes the new token nonce at that new socket's initial config. The original absolute socket deadline is never reset.

**D-03 gate:** Under D-03A, `validate_refresh_context` rejects any mode/goal mismatch and returns only normalized claim-bound values. Under D-03B, Plan 05's branch-neutral parser may still accept the context-only frame, but service policy rejects every attempted context change without provider/store work, retains canonical quiz/no-goal intent, and removes dead mode branches. Policy denial emits Plan 05's recoverable `VOICE_SESSION_REFRESH_POLICY_DENIED`, keeps the socket open, and changes no session deadline. Token renewal always uses a new socket in both branches.

- [ ] Add a compile/fixture RED test that asserts the imported current-version constant is exactly `5`, deserializes both exact v5 client fixtures, and asserts each fixture's `version` equals the imported constant. Assert the manifest names both fixtures.
- [ ] Add RED stateful audio-lifecycle tests (prefix `audio_turn_lifecycle_`) that execute every `VOICE-AUDIO-TURN-LIFECYCLE` case from `agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json` behaviorally against Plan 03's `ws.rs` turn assembler: replay each case's `wire_sequence_json` (valid production-size, smaller-chunk/high-final-sequence, duplicate, gap, reorder, end-mismatch, oversized-chunk, and over-cap aggregate) and assert the fixture's exact `valid`/`diagnostic_code`/`path` outcome with no phantom provider turn. Plan 05's own tests validate the file's schema, case-id set, and per-frame parses only; this stateful behavioral execution is exclusively Plan 08's obligation and never edits the fixture.
- [ ] Add RED trusted and signed-mode refresh tests: under D-03A the fixture's matching generation/exact bound intent succeeds with the unchanged client/server session binding; under D-03B the parsed fixture returns recoverable `VOICE_SESSION_REFRESH_POLICY_DENIED` — load that case from `agent/fixtures/voice-protocol/v5/terminal-sequences.json` and assert the emitted policy-denial event matches the fixture byte-for-byte, including its recoverable (nonterminal) classification; a different/stale generation fails; accepted provider input contains the unchanged server session ID and selected D-03 intent; forbidden token/user/study/session/source/active-concept mutations fail in Plan 05 parsing; and every context refresh performs zero nonce-store calls. Policy denial keeps the same socket/deadlines and performs no provider/store write.
- [ ] Add a `#[tokio::test(start_paused = true)]` RED replacement-socket test: a new access token cannot appear in `session_refresh`; it succeeds only as the initial config on a new socket/generation, consumes its nonce there, and the old generation cannot resume. Advancing past the original socket's absolute deadline closes it even after valid context refreshes.
- [ ] Run `cargo test -p agent-service protocol_v5_fixture_`, `cargo test -p agent-service audio_turn_lifecycle_`, and `cargo test -p agent-service refresh_identity_`. Expected RED: the private initial-frame type and one-field session binding cannot enforce the contract, and the assembler's stateful lifecycle cases are unexercised.
- [ ] Implement the typed binding above and one initial-config nonce-claim helper. Assert Plan 05 already removed `ReadyFrame` from `protocol.rs` and its `lib.rs` re-export; return a Plan 05 defect if either remains. Do not edit either file for SERVICE-009. This absence assertion (plus the compile/fixture parity run) is the canonical SERVICE-009 proof recorded in the coverage ledger; the removal commit itself is Plan 05's VOICE-READY-001, and the lane PR must link that commit SHA next to the SERVICE-009 reference.
- [ ] Run the focused tests and `cargo test -p agent-service --test voice_ws signed_session_`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/ws.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): bind v5 refresh generation"
```

### Task 6: Expose claim-bound projection and the selected restore surface (SERVICE-011, SERVICE-018, Plan 04/09 handoff)

`SERVICE-011` is this plan's local task ID for the Plan 04/09/11 projection handoff obligation (ledger anchor: the study-projection contract obligation rows); it closes no component finding and must not be cited as a ledger row in the lane PR. `SERVICE-018` is the ledger's D-04 restore alias.

**Files:**
- Modify: `agent/crates/agent-service/src/config.rs`
- Modify: `agent/crates/agent-service/src/app.rs`
- Modify: `agent/crates/agent-service/src/lib.rs`
- Modify: `agent/crates/agent-service/src/main.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`
- Read only: `docs/superpowers/plans/2026-08-23-learning-core-authority.md`
- Read only: `docs/superpowers/plans/2026-08-23-web-api-security.md`
- Read only: `agent/fixtures/learning-core/study-projection-v1.json`

**D-01 gate:** Read the coordinator decision registry entry for `D-01 SCHEDULING_AUTHORITY_EXAM` (`docs/decisions/2026-08-23-d-01-review-scheduling-authority.md`). Under Branch B (`EVENTS_PLUS_READ_TIME_PROJECTION`), Plan 03 has already landed the Branch-B projection read seam in `app.rs`; rebase on the integration tip and extend that exact seam — do not register a second route or handler. Under Branch A (`SERVER_PERSISTED_FSRS`), register the route as specified below. In both branches the response type is Plan 04's exact `AuthenticatedStudyProjectionV1`; never author scheduling parameters reserved for Connor.

**Interfaces:**

```rust
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectionQuery {
    voice_session_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProjectionPrincipal {
    user_id: UserId,
    study_set_id: StudySetId,
    voice_session_id: String,
}

#[derive(Clone, Debug)]
struct ProjectionReadAccess {
    library_read_bearer: RedactedSecret,
    session_token_secret: RedactedSecret,
    allowed_origins: Arc<[String]>,
}

async fn authenticated_study_projection(
    State(state): State<AppState>,
    Path(study_set_id): Path<StudySetId>,
    Query(query): Query<ProjectionQuery>,
    headers: HeaderMap,
) -> Result<
    (HeaderMap, Json<AuthenticatedStudyProjectionV1>),
    ProjectionRejection,
>;
```

Register exactly `GET /v1/study-sets/{study_set_id}/projection?voice_session_id={voice_session_id}`. Require the Plan 11 service credential as `Authorization: Bearer <VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN>`, the signed access credential as `X-Viva-Session-Token: <viva1 token>`, and a configured canonical `Origin`. Constant-time verify the scoped bearer; then verify the session token's canonical encoding, HMAC, time bounds, and nonce-independent read validity. Derive `user_id`, `study_set_id`, and `voice_session_id` from the verified session claims and constant-time compare the path/query selectors with those claims. The request supplies selectors, never identity authority. Fetch through Plan 09's `authenticated_study_projection(user_id, study_set_id, voice_session_id)` port and return Plan 04's exact `AuthenticatedStudyProjectionV1` type with `cache-control: no-store` and `x-content-type-options: nosniff`. Do not create a second response shape.

- [ ] Add RED route tests for missing/wrong scoped bearer, absent/malformed/expired/bad-signature session token, missing/wrong origin, duplicate/extra query keys, path-study mismatch, query-session mismatch, unknown/deleted study set, store failure sanitization, and a valid exact response. A valid operator bearer, legacy broad bearer, WebSocket service bearer, or session token alone must not authorize this route.
- [ ] Add a confused-deputy RED test: credential for user A plus a path/query naming user B's live study/session must return `403` without calling the store for B.
- [ ] Run `cargo test -p agent-service authenticated_projection_`. Expected RED: the route and scoped principal do not exist.
- [ ] Add `ProjectionReadAccess` to `ServiceConfig`/`AppState`, register the route, and perform both credential checks plus claim binding before store access. Keep denial bodies and logs free of raw credentials and subject identifiers.
- [ ] Run `cargo test -p agent-service authenticated_projection_` and `cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_study_projection -- --nocapture`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/config.rs agent/crates/agent-service/src/app.rs agent/crates/agent-service/src/lib.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "feat(agent-service): expose authenticated study projection"
```

Handoff: Plan 11 proxies this endpoint with the scoped read credential in `Authorization`, the browser access token in `X-Viva-Session-Token`, and canonical `Origin`; it cannot forward browser identity as authority. Plan 10 consumes the Plan 11 proxy response. Neither downstream plan may bypass this service route with a direct store read.

#### Conditional D-04 restore subtask (SERVICE-018)

Read the recorded `D-04 DELETION_UX` selector; do not infer it from available code.

- Under `CONFIRM_DELETE`, register no restore route and commit no restore handler/request/outcome tests. Add one route-absence characterization named `restore_route_absent_when_confirm_delete_selected` asserting `POST /v1/study-sets/{study_set_id}/restore` is `404`, so a later accidental half-implementation fails.
- Under `SOFT_DELETE_UNDO`, wait for Plan 09's durable restore port, then implement only the contract below. Do not retain the `CONFIRM_DELETE` absence test.

```rust
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreStudySetRequest {
    deletion_id: Uuid,
}

const DELETION_FINALIZE_INTERVAL: Duration = Duration::from_secs(5);
const DELETION_FINALIZE_BATCH: usize = 100;

async fn run_deletion_finalizer(
    store: Arc<dyn StudyMemoryStore>,
    health: DeletionFinalizerHealth,
    mut shutdown: watch::Receiver<bool>,
);

async fn restore_study_set(
    State(state): State<AppState>,
    Path(study_set_id): Path<StudySetId>,
    headers: HeaderMap,
    Json(request): Json<RestoreStudySetRequest>,
) -> Result<(HeaderMap, Json<RestoreStudySetOutcomeV1>), RestoreRejection>;
```

Register exactly `POST /v1/study-sets/{study_set_id}/restore`. Require canonical `Origin`, `Authorization: Bearer <VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN>`, and the Plan 11 server-built identity header `X-Viva-Verified-User-Id`, accepted only when the exact delete-scoped bearer authenticates the request; no session token and no browser capability is accepted on this route. The delete-scoped bearer must not authorize projection; read/operator/WebSocket/legacy broad bearers must not authorize restore. Reject a missing, duplicate, empty, oversized (over 128 bytes), or malformed header value (C0/C1 controls, whitespace, comma, CR, or LF). Derive `user_id` from that header, `study_set_id` from the path, and `deletion_id` from the body before calling Plan 09 with exactly that internal tuple `{ user_id, study_set_id, deletion_id }`. `deletion_id` selects a server-created deletion operation; it is not identity or browser authority. The service never accepts or forwards Plan 11's browser one-time restore capability, and it redacts the identity header from logs/errors.

Plan 09 alone evaluates the half-open 30-second deadline with database/server time (`database_now < undo_expires_at`), verifies deletion ownership/target/state, and atomically resolves concurrent/replayed restore. Return its exact Plan 06 `RestoreStudySetOutcomeV1` unchanged on success: `schema == "viva.restore_study_set_outcome.v1"`, canonical `deletion_id`, canonical `study_set_id`, canonical RFC3339 UTC `restored_at`, and `outcome` serialized exactly as `"restored"` or `"already_restored"`. Both outcomes are HTTP `200`; an idempotent replay retains the originally persisted `restored_at`. Do not wrap this type, add `status`, add a numeric version, normalize the two outcomes together, or fabricate a service timestamp. Invalid request structure is fixed `400 {"error":"restore_invalid","message":"restore request is invalid"}`. Unknown/cross-user targets are fixed `404 {"error":"restore_unavailable","message":"restore is unavailable"}`. Expired, finalized/purged, and deletion-generation/study mismatches are fixed `409` with that same `restore_unavailable` body. A backend-unavailable classification is fixed `503 {"error":"restore_temporarily_unavailable","message":"restore is temporarily unavailable"}`; durability/internal is fixed `500 {"error":"restore_failed","message":"restore failed"}`. Select only from Plan 06's typed kind/safe ID, never `reason()` text. Every response sets `cache-control: no-store` and `x-content-type-options: nosniff`. Failure responses and logs never include the deletion ID, claims, target IDs, store reason, expiry, or capability; the exact successful typed outcome contains only its five published fields.

Consume Plan 06's conditional D-04 `restore_study_set` and `finalize_expired_study_set_deletions(limit: usize) -> Result<usize, PortError>` ports exactly; Plan 09 implements them. If `SOFT_DELETE_UNDO` is selected but either typed port or `RestoreStudySetOutcomeV1` is absent, stop and return the defect to Plan 06 rather than defining a service-local substitute or downcasting to a concrete store. Under `SOFT_DELETE_UNDO`, call the finalizer once during durable startup with limit `100`; startup fails if that call fails. Run one sequential (never overlapping) call every five seconds with Tokio `MissedTickBehavior::Delay`, and call it before delete, restore, library, and projection responses. A request-side finalizer failure returns sanitized `503` without the requested store operation. A background failure makes operator readiness false until a later successful pass. Stop and await this worker during Task 11's drain; no detached task may survive process shutdown. Under `CONFIRM_DELETE`, Plan 06's conditional default fails closed as unavailable and the service compiles none of this worker/health/route state.

- [ ] Add `SOFT_DELETE_UNDO` RED tests for exact route registration and `deny_unknown_fields`; missing/wrong Origin, missing/wrong delete-scoped bearer, read/operator/WebSocket bearer substitution, missing/duplicate/empty/oversized/malformed `X-Viva-Verified-User-Id`, a session token or browser capability offered in place of the identity header, and unknown body fields must fail before any store call.
- [ ] Add a valid store matrix for `Restored`, `AlreadyRestored`, expired-at-equality, expired-after-deadline, finalized/purged, unknown deletion, deletion/study mismatch, and store unavailable/durability/internal. For both successes, assert exact five-key `RestoreStudySetOutcomeV1`, canonical IDs/RFC3339, the correct snake_case outcome, and original `restored_at` on replay. For every failure, assert the exact coarse status/body/headers and that hostile store reasons never appear.
- [ ] Add two concurrent calls for one deletion ID: Plan 09 returns one `Restored` and one `AlreadyRestored`; both HTTP responses are exact typed `200` outcomes with different `outcome` values but the same schema/IDs/original `restored_at`, durable state is restored once, and no duplicate child/session material is created. A cross-user identity must return the fixed `404` `restore_unavailable` body with zero target-user store calls.
- [ ] Add `#[tokio::test(start_paused = true)]` finalizer tests. Assert the startup call uses batch `100`; no periodic call occurs at `4.999999999s`; exactly one occurs at `5s`; a deliberately blocked call never overlaps another tick; a failed tick marks authenticated readiness not-ready with no store prose; a later success restores readiness; drain cancellation joins the worker. Prove delete/restore/library/projection each run a successful finalizer first and perform no requested operation after finalizer failure.
- [ ] Run `cargo test -p agent-service authenticated_restore_`. Expected RED: the route and scoped handler do not exist. After implementation, run `cargo test --manifest-path agent/Cargo.toml -p data study_set_restore_ -- --nocapture` and `DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_study_set_restore_ -- --ignored --test-threads=1 --nocapture`, then rerun the service test GREEN. A mocked success is not deadline/replay proof.
- [ ] Commit the selected branch only. Under `SOFT_DELETE_UNDO`:

```bash
git add agent/crates/agent-service/src/config.rs agent/crates/agent-service/src/app.rs agent/crates/agent-service/src/lib.rs agent/crates/agent-service/src/main.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "feat(agent-service): expose scoped study restore"
```

The lane handoff/PR records `D-04=SOFT_DELETE_UNDO`, the Plan 09 commit SHA, and its required-Postgres restore command. Under `CONFIRM_DELETE`, include the route-absence characterization with the Task 6 projection commit and record `D-04=CONFIRM_DELETE`; do not create an empty restore commit.

Handoff: under `SOFT_DELETE_UNDO`, Plan 11 consumes the browser one-time restore capability, verifies/consumes it, proxies only the deletion ID plus its server-only delete-scoped bearer and a fresh server-built `X-Viva-Verified-User-Id` derived exclusively from the verified capability (never session claims or any session token), then strictly validates and forwards the exact five-field `RestoreStudySetOutcomeV1`. Plan 13 exposes Undo only for Plan 11's authoritative window and refreshes only after that exact success; it never reinserts cached data. Under `CONFIRM_DELETE`, Plans 11/13 must not expose or call restore.

### Task 7: Reject authority-shaped ingestion bodies and fail closed on PDF (SERVICE-015, SERVICE-016, COR-04)

**Files:**
- Modify: `agent/crates/agent-service/src/app.rs`
- Test: `agent/crates/agent-service/src/app.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`
- Read only: `docs/superpowers/plans/2026-08-23-persistence-postgres-privacy.md`
- Read only: `apps/web/lib/viva-agent-client.ts` (Plan 10 owns client cleanup, `WEBSESSION-PASTE-01`)

**Interfaces:**

```rust
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PasteStudySetRequest {
    title: String,
    course: Option<String>,
    exam_date: Option<String>,
    pasted_text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileStudySetRequest {
    title: String,
    course: Option<String>,
    exam_date: Option<String>,
    file_name: String,
    content_type: Option<String>,
    file_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetryFileStudySetRequest {
    file_name: String,
    content_type: Option<String>,
    file_base64: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GeneratedPdfCase {
    TextUncompressed,
    TextFlateCompressed,
    ScannedImageOnly,
    Encrypted,
    MalformedXref,
    MagicHeaderPlaintext,
}

const PDF_TEXT_STREAM: &[u8] =
    b"BT /F1 12 Tf 72 720 Td (Mitosis chromosome spindle metaphase cytokinesis) Tj ET";
const PDF_FLATE_TEXT_STREAM: [u8; 83] = [
    120, 156, 13, 202, 49, 14, 128, 32, 12, 5, 208, 171, 252, 81, 39, 133, 197, 221,
    68, 55, 183, 94, 128, 64, 13, 168, 80, 98, 89, 188, 189, 36, 111, 124, 43, 97,
    218, 13, 140, 5, 157, 88, 108, 55, 131, 2, 134, 35, 53, 209, 164, 240, 241,
    149, 44, 42, 153, 161, 53, 149, 240, 48, 50, 55, 87, 163, 83, 134, 255, 154,
    220, 169, 112, 143, 35, 232, 194, 70, 63, 178, 209, 25, 220,
];

fn generated_pdf(case: GeneratedPdfCase) -> Vec<u8>;

fn store_json_error(
    response_headers: HeaderMap,
    error: PortError,
    error_code: &'static str,
) -> (StatusCode, HeaderMap, Json<serde_json::Value>);
```

`generated_pdf` is a test-only fixture factory, not a production parser. For the first four cases, construct a `%PDF-1.7` file from numbered indirect objects and compute every xref byte offset plus `startxref` from the generated byte buffer. `TextUncompressed` has Catalog, Pages, one Page, Helvetica Font, and the exact literal text content stream above. `TextFlateCompressed` has the same page graph and a `/Filter /FlateDecode` stream containing the exact fixed zlib bytes above. `ScannedImageOnly` has a one-pixel grayscale `/Subtype /Image` XObject painted by the page content and no text operators. `Encrypted` uses the PDF Standard Security Handler revision 2 with fixed test-only user/owner passwords, MD5 document-key derivation, RC4-encrypted page content, a referenced `/Encrypt` dictionary, and 32-byte `/O` and `/U` entries; its builder asserts that plaintext is absent from the result. Keep the MD5/RC4 builder test-only and add no production crypto/PDF dependency. `MalformedXref` truncates the generated xref table. Only `MagicHeaderPlaintext` is deliberately not a PDF: it is `%PDF-1.7\n` followed by plain study notes. Each builder self-checks header, object offsets, xref, `startxref`, trailer/root, stream lengths, and its selected compression/image/encryption structure before the HTTP request. Do not replace these cases with a filename, magic-header-only, UTF-8 string, or mocked store error.

Plan 09 owns the store-side fail-closed implementation. It returns the closed Plan 06 taxonomy's `PortErrorKind::InvalidInput` for every PDF until bounded page-aware extraction exists. Do not add a `PortErrorKind`, parser, OCR path, decompressor, or `String::from_utf8_lossy` fallback in the service. `store_json_error` selects status only from `error.kind()`: every `InvalidInput` maps uniformly to sanitized `400 Bad Request`; it must not inspect, match, log, or return `error.reason()` to distinguish PDF. Preserve the caller's coarse route code (`file_ingestion_failed` or `file_retry_failed`) and use the fixed public message `"uploaded content is invalid or unsupported"`. Map `Conflict` to `409`, `Unavailable` to `503`, and `Durability | Internal` to `500`, each with fixed public prose.

- [ ] Add a recording `StudyMemoryStore` RED matrix for all three request structs. Send an otherwise valid body with, separately, `user_id`, `session_id`, and one arbitrary unknown key. Each request must return JSON `400` with exactly `{"error":"invalid_ingestion_request","message":"request body does not match the ingestion contract"}`, must not echo the rejected key/value, and must leave paste/create-file/retry call counters at zero. Include duplicate JSON keys and a malformed JSON control; neither may reach the store.
- [ ] Replace the current paste test that expects attacker `user_id`, `session_id`, `source_spans`, and `questions` to be silently discarded. The strict test must reject the whole request. Keep a separate valid paste test proving the handler derives `user_id` and new `session_id` from server state and returns no caller-authored facts.
- [ ] Run `cargo test -p agent-service ingestion_request_shape_`. Expected RED: Serde ignores unknown fields and the existing handler reaches the store.
- [ ] Add `#[serde(deny_unknown_fields)]` to the three structs and extract `Result<Json<T>, JsonRejection>` through one route-aware rejection helper so Serde/extractor diagnostics are never returned. Do not add `user_id` or `session_id` to an allowlist. Rerun the focused tests to PASS.
- [ ] Add an `app.rs` unit test for `store_json_error`: construct one `PortError` of each `PortErrorKind`, assert the exact status/public message, and give each error a hostile reason containing a bearer, token, filename, PDF bytes, SQL detail, and learner text. None may appear in the serialized body or captured log. Mutate the `InvalidInput` arm to `500` and confirm the test fails before restoring it.
- [ ] In `voice_ws.rs`, implement `generated_pdf` and table-drive all six cases through `POST /study-sets/files` with `content_type: application/pdf`. Assert exact `400`, `error == "file_ingestion_failed"`, fixed sanitized message, `cache-control: no-store`, no token, and no `study_set`, `session_id`, `documents`, `source_spans`, `concepts`, `questions`, generated label, or locator. Snapshot the real store before and after every request and assert no ready/retry/failed record, document, concept, question, or session was created.
- [ ] Seed one legitimate pre-existing failed non-PDF record, then table-drive all six PDF cases through `POST /study-sets/{study_set_id}/files/retry`. Assert exact `400`, `error == "file_retry_failed"`, no token/facts, and that the original failed record is byte-for-semantic-byte unchanged and never becomes `retry` or `ready`.
- [ ] Run `cargo test -p data pdf_ingestion_fails_closed_ -- --nocapture` to prove Plan 09 rejects the same generated categories at the store boundary, then run `cargo test -p agent-service ingestion_unsupported_pdf_ -- --nocapture`. Expected GREEN only on the combined Plan 08 + Plan 09 tree. A service mock returning `InvalidInput` is not the COR-04 acceptance proof.
- [ ] Wait for Plan 10 (`WEBSESSION-PASTE-01`) to remove `user_id`/`session_id` and unknown members from the paste/file/retry serializers in `apps/web/lib/viva-agent-client.ts`, then run Plan 10's exact client request-shape test on the combined tree. Plan 08 does not edit that file and must not claim integration GREEN while the shipped client still sends a now-rejected shape.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/app.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): reject unsafe ingestion shapes"
```

### Task 8: Map durable deferred turns, classify once, and rearm idle (SERVICE-001, SERVICE-006, SERVICE-014)

`SERVICE-014` is this plan's local task ID for the Plan 04/06/07 durable-deferral handoff (ledger anchor: the Plan 06 `TurnDeferred` handoff rows); it closes no component finding and must not be cited as a ledger row in the lane PR.

**Files:**
- Modify: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`
- Read only: `docs/superpowers/plans/2026-08-23-learning-core-authority.md`
- Read only: `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md`
- Read only: `agent/fixtures/voice-protocol/v5/turn-outcomes.json`

**Interfaces:**

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
enum ProviderTurnResolution {
    One { response_id: Option<String> },
    All,
}

fn classify_provider_turn_event(event: &BrainEvent) -> Option<ProviderTurnResolution>;

fn rearm_between_turn_idle(
    pending_submitted_answers: u32,
    active_provider_turns: u32,
    sleeper: Pin<&mut Sleep>,
    now: Instant,
    timeout: Duration,
) -> bool;
```

Implement the classifier as this single mapping:

```rust
fn classify_provider_turn_event(event: &BrainEvent) -> Option<ProviderTurnResolution> {
    match event {
        BrainEvent::TerminalSessionPhase { .. } => Some(ProviderTurnResolution::All),
        BrainEvent::AnswerEvaluated { response_id, .. }
        | BrainEvent::RecapReady { response_id, .. }
        | BrainEvent::ResponseCompleted { response_id }
        | BrainEvent::TurnDeferred { response_id, .. }
        | BrainEvent::ResponseCancelledFor { response_id } => {
            Some(ProviderTurnResolution::One {
                response_id: Some(response_id.clone()),
            })
        }
        BrainEvent::ResponseCancelled => Some(ProviderTurnResolution::One {
            response_id: None,
        }),
        BrainEvent::SessionPhase { .. }
        | BrainEvent::QuestionStarted { .. }
        | BrainEvent::TranscriptDelta { .. }
        | BrainEvent::SourceReference { .. }
        | BrainEvent::ConceptStatus { .. }
        | BrainEvent::ManuscriptIntent { .. }
        | BrainEvent::AudioDelta { .. }
        | BrainEvent::ResponseStarted { .. }
        | BrainEvent::ResponseAudio { .. }
        | BrainEvent::Transcript(_)
        | BrainEvent::ResponseToolProposal { .. }
        | BrainEvent::Usage(_)
        | BrainEvent::ProviderFallbackActivated { .. }
        | BrainEvent::Error(_)
        | BrainEvent::SpeechIntent(_)
        | BrainEvent::InputSpeechStarted
        | BrainEvent::InputSpeechStopped
        | BrainEvent::ResponseTranscriptDelta { .. }
        | BrainEvent::ResponseTextStarted { .. }
        | BrainEvent::TranscriptFinal { .. } => None,
        _ => None,
    }
}

fn rearm_between_turn_idle(
    pending_submitted_answers: u32,
    active_provider_turns: u32,
    mut sleeper: Pin<&mut Sleep>,
    now: Instant,
    timeout: Duration,
) -> bool {
    if pending_submitted_answers != 0 || active_provider_turns != 0 {
        return false;
    }
    sleeper.as_mut().reset(now + timeout);
    true
}
```

`BrainEvent` is `#[non_exhaustive]` in another crate, so the final arm safely ignores a future event until its contract owner classifies it; every current variant remains named in both the match and the table test. Both submitted-answer and active-provider counters must consume the same returned value.

Track the active v5 turn binding separately from provider response identity:

```rust
#[derive(Debug, Default)]
struct TurnBindingTracker {
    pending_turn_ids: VecDeque<String>,
    response_to_turn: HashMap<String, String>,
}

impl TurnBindingTracker {
    fn register_submission(&mut self, turn_id: String) -> Result<(), TurnBindingError> {
        if self.pending_turn_ids.contains(&turn_id)
            || self.response_to_turn.values().any(|known| known == &turn_id)
        {
            return Err(TurnBindingError::DuplicateTurn);
        }
        self.pending_turn_ids.push_back(turn_id);
        Ok(())
    }

    fn bind_question(&mut self, response_id: &str) -> Result<&str, TurnBindingError> {
        if self.response_to_turn.contains_key(response_id) {
            return Err(TurnBindingError::DuplicateResponse);
        }
        let turn_id = self
            .pending_turn_ids
            .pop_front()
            .ok_or(TurnBindingError::MissingTurn)?;
        self.response_to_turn
            .insert(response_id.to_owned(), turn_id);
        self.response_to_turn
            .get(response_id)
            .map(String::as_str)
            .ok_or(TurnBindingError::MissingTurn)
    }

    fn turn_for_response(&self, response_id: &str) -> Result<&str, TurnBindingError> {
        self.response_to_turn
            .get(response_id)
            .map(String::as_str)
            .ok_or(TurnBindingError::MissingResponse)
    }
}

fn map_turn_deferred(
    event: &BrainEvent,
    bindings: &TurnBindingTracker,
) -> Result<ServerFrame, VoiceProtocolDiagnostic> {
    let BrainEvent::TurnDeferred { response_id, .. } = event else {
        return Err(VoiceProtocolDiagnostic::invariant("$.event.type"));
    };
    let turn_id = bindings
        .turn_for_response(response_id)
        .map_err(|_| VoiceProtocolDiagnostic::invariant("$.event.turn_id"))?;
    ServerFrame::turn_deferred(turn_id, event)
}
```

Register a client `turn_id` only when its bounded audio/intent input is admitted. Register a server-generated canonical turn ID before a proactive input. Bind the oldest admitted ID when its `QuestionStarted` arrives, and use the same ID in Plan 05's owner-provided constructors — its `question_started` constructor and `ServerFrame::turn_deferred(turn_id: &str, event: &BrainEvent)` — then remove the response binding only after its single resolution is successfully forwarded. `map_turn_deferred` destructures `BrainEvent::TurnDeferred` only to extract `response_id` for the turn lookup; the entire frame construction, field copying, and validation stay inside Plan 05's constructor, whose `Result<ServerFrame, VoiceProtocolDiagnostic>` is returned unchanged. Do not redeclare the field mapping in `ws.rs`. Missing/duplicate bindings fail closed; never invent a replacement ID on deferred-event receipt.

- [ ] Add a RED table test with one constructed event for every currently named `BrainEvent`, including `TurnDeferred`, its exact expected resolution, and duplicate-delivery cases. The test must fail if either counter uses a second classifier.
- [ ] Load every deferred case from `turn-outcomes.json`. For all six exact reasons (`empty_answer`, `transcript_uncertain`, `evaluator_unavailable`, `invalid_evaluator_output`, `insufficient_semantic_evidence`, `contradictory_evidence`) and both retry booleans, assert byte-exact `turn_id`, `response_id`, `question_id`, `reason`, and `can_retry_same_question`. Assert the JSON has no `retryable`, `terminal_reason`, provider message, feedback, confidence, concept status, schedule, mastery, review, or recap fact.
- [ ] Add RED turn-binding tests for sequential and overlapping submissions, duplicate turn/response IDs, missing `QuestionStarted`, unknown deferred response, proactive server turn, and resolution cleanup. A missing binding must produce `VOICE_PROTOCOL_INVARIANT` and no `turn_deferred` frame.
- [ ] Add an end-to-end RED test with Plan 07's real outcome path and a recording/failing store. Success must show `record_turn_outcome` completed before the nonterminal `turn_deferred` frame. Store failure must emit no deferral, `answer_evaluated`, `concept_status`, review write, graded recap, or fabricated learner fact.
- [ ] Add a `#[tokio::test(start_paused = true)]` RED state-machine test: initial idle is armed for 600 seconds; a submitted answer disarms it; provider completion at `t=30` rearms it for `t=630`; advancing to `t=629` keeps the lease; advancing one second expires and drops user, IP, session, and provider leases.
- [ ] Add cancel, terminal-provider-error, and all-turns-complete cases. Ping, Pong, context-only `session_refresh`, or repeated completion must not extend the deadline.
- [ ] Run `cargo test -p agent-service provider_turn_classifier_`, `cargo test -p agent-service turn_deferred_`, and `cargo test -p agent-service between_turn_idle_`. Expected RED: the service has no durable deferral mapping, two duplicate classifiers exist, and normal provider completion does not rearm idle.
- [ ] Special-case `QuestionStarted`/`TurnDeferred` in the service mapper using `TurnBindingTracker` and Plan 05 constructors. Never synthesize a deferral from provider failure. Replace both accounting mappings with `classify_provider_turn_event`; call `rearm_between_turn_idle` after every transition that reaches zero pending answers and zero active turns. Use `ws_timeouts.between_turn_idle`, not the in-turn `idle` deadline.
- [ ] Run Plan 07's durability boundary controls: `cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_runner_emits_learning_events_only_from_persisted_turn_outcome -- --nocapture` and `cargo test --manifest-path agent/Cargo.toml -p agent-adapters deferred_turn_emits_recovery_without_mastery_schedule_or_graded_recap -- --nocapture`; expect PASS before accepting the service fixture mapping.
- [ ] Run the focused tests and `cargo test -p agent-service --test voice_ws provider_slot_`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/ws.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): map durable turn lifecycle"
```

### Task 9: Put every outbound write behind one deadline (SERVICE-002, SERVICE-008)

**Files:**
- Modify: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`
- Read only: `agent/crates/agent-service/src/protocol.rs`
- Read only: `packages/core/src/agent-contract.test.ts`

**Interfaces:**

```rust
#[derive(Debug, thiserror::Error)]
enum OutboundWriteError {
    #[error("outbound websocket write exceeded its deadline")]
    Timeout,
    #[error("outbound websocket sink failed")]
    Sink(#[source] axum::Error),
}

struct BoundedSender<S> {
    inner: S,
    timeout: Duration,
}

impl<S> BoundedSender<S>
where
    S: Sink<Message, Error = axum::Error> + Unpin,
{
    async fn send(&mut self, message: Message) -> Result<(), OutboundWriteError> {
        match tokio::time::timeout(self.timeout, self.inner.send(message)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(OutboundWriteError::Sink(error)),
            Err(_) => Err(OutboundWriteError::Timeout),
        }
    }
}

fn serialize_server_frame_with<E>(
    frame: &ServerFrame,
    serializer: impl FnOnce(&ServerFrame) -> Result<String, E>,
) -> String {
    serializer(frame).unwrap_or_else(|_| protocol::VOICE_SERIALIZATION_FALLBACK_FRAME.to_owned())
}
```

The fallback string is Plan 05's owner-published `protocol::VOICE_SERIALIZATION_FALLBACK_FRAME` constant; this replaces the hard-coded v1 string currently at `ws.rs` line 3874, and no literal v1 (or service-local) error JSON may remain.

All server frames, `Ready`, provider events, protocol errors, Ping/Pong, terminal frames, and Close frames go through one `BoundedSender`. `Timeout` records sanitized terminal label `slow_client`, aborts provider tasks, and drops every lease. `Sink` retains `send_failed`. A timeout while attempting the final terminal/Close frame must still return and release resources.

- [ ] Add a `PendingSink` whose `poll_ready`, `poll_flush`, and `poll_close` remain `Poll::Pending`, plus a `RecordingSink` control. Do not use a TCP buffer to simulate a slow reader in the deterministic unit test.
- [ ] Add a `#[tokio::test(start_paused = true)]` RED test that polls a write, advances to one nanosecond before five seconds, asserts pending, advances one nanosecond, asserts `OutboundWriteError::Timeout`, and proves a concurrently armed one-second timer was polled on schedule.
- [ ] Add a RED session test that owns session/user/IP/provider leases, blocks on `PendingSink`, advances five seconds, and asserts `slow_client`, provider task abortion, all lease counts zero, and drain completion.
- [ ] Add a forced-serializer-failure RED test with `Err::<String, ()>(())`. Assert the output string equals `protocol::VOICE_SERIALIZATION_FALLBACK_FRAME` exactly; parse it as JSON and assert `type == "error"`, `version == VIVA_VOICE_PROTOCOL_VERSION`, `VIVA_VOICE_PROTOCOL_VERSION == 5`, `error.code == "VOICE_INTERNAL_SERIALIZATION"`, `error.retryable == true`, and no application payload is present.
- [ ] Run `cargo test -p agent-service bounded_sender_` and `cargo test -p agent-service serialization_fallback_`. Expected RED: sends await forever and fallback hard-codes version 1.
- [ ] Introduce `BoundedSender` immediately after splitting the WebSocket and change every send/close helper to accept it. Extract the post-split session loop behind generic `Sink<Message>`/`Stream<Item = Result<Message, axum::Error>>` parameters so `PendingSink` exercises the real cleanup path rather than a parallel helper. Do not edit `protocol.rs`.
- [ ] Run the focused Rust tests and Plan 05's complete TypeScript contract suite: `bun test packages/core/src/agent-contract.test.ts`. The TypeScript parser must accept the exact `VOICE_SERIALIZATION_FALLBACK_FRAME` bytes: `{"type":"error","version":5,"error":{"code":"VOICE_INTERNAL_SERIALIZATION","message":"Server frame serialization failed.","retryable":true}}`.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/ws.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): bound websocket writes"
```

### Task 10: Add heartbeat expiry without letting keepalives extend work (SERVICE-001)

**Files:**
- Modify: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`

**Interfaces:**

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HeartbeatAction {
    SleepUntil(Instant),
    SendPing,
    Expired,
}

#[derive(Debug)]
struct HeartbeatState {
    next_ping: Instant,
    pong_deadline: Option<Instant>,
}

impl HeartbeatState {
    fn new(now: Instant, interval: Duration) -> Self {
        Self {
            next_ping: now + interval,
            pong_deadline: None,
        }
    }

    fn on_timer(
        &mut self,
        now: Instant,
        interval: Duration,
        pong_timeout: Duration,
    ) -> HeartbeatAction {
        if let Some(deadline) = self.pong_deadline {
            return if now >= deadline {
                HeartbeatAction::Expired
            } else {
                HeartbeatAction::SleepUntil(deadline)
            };
        }
        if now < self.next_ping {
            return HeartbeatAction::SleepUntil(self.next_ping);
        }
        self.pong_deadline = Some(now + pong_timeout);
        self.next_ping = now + interval;
        HeartbeatAction::SendPing
    }

    fn on_pong(&mut self, now: Instant, interval: Duration) -> bool {
        if self.pong_deadline.take().is_none() {
            return false;
        }
        self.next_ping = now + interval;
        true
    }
}
```

Only a Pong received while one is outstanding clears `pong_deadline`. Ping/Pong activity never changes the in-turn, between-turn, or absolute-session deadlines. Use the bounded sender for both Ping and Pong. A missing Pong records `heartbeat_timeout`, maps to the existing wire-safe slow-client/session termination contract from Plan 05, aborts provider tasks, and releases all permits.

- [ ] Add `#[tokio::test(start_paused = true)]` RED tests for: Ping at 30 seconds, expiry at 40 seconds without Pong, valid Pong at 39 seconds followed by the next Ping at 69 seconds, unsolicited Pong, client Ping requiring bounded Pong, and keepalives that continue through the 600-second between-turn deadline without extending it.
- [ ] Add a half-open integration test with server-owned snapshots: acquire a session and provider permit, stop reading/writing client frames, advance heartbeat deadlines, then assert active handler/session/user/IP/provider counts reach zero and a new client connects within one heartbeat interval.
- [ ] Run `cargo test -p agent-service heartbeat_` and `cargo test -p agent-service --test voice_ws half_open_`. Expected RED: no heartbeat state exists and the lease survives until the six-hour session cap.
- [ ] Handle WebSocket Ping/Pong control messages before JSON `ClientFrame` parsing, add heartbeat branches to the single session `select!`, keep the absolute session sleep pinned from session acceptance, and keep the between-turn sleeper independent.
- [ ] Run the focused tests plus `cargo test -p agent-service --test voice_ws idle_`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/ws.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): expire half-open voice sessions"
```

### Task 11: Make admission, capacity, and process drain server-observable (SERVICE-012)

`SERVICE-012` is this plan's local task ID for supporting infrastructure behind the SERVICE-001/SERVICE-002 proofs (their ledger rows cite graceful drain and lease release); record this task's evidence under those rows and do not cite `SERVICE-012` as a ledger row in the lane PR.

**Files:**
- Modify: `agent/crates/agent-service/src/app.rs`
- Modify: `agent/crates/agent-service/src/ws.rs`
- Modify: `agent/crates/agent-service/src/main.rs`
- Modify: `agent/crates/agent-service/src/lib.rs`
- Test: `agent/crates/agent-service/src/app.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`

**Interfaces:**

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct VoiceRuntimeSnapshot {
    pub session_capacity: usize,
    pub session_in_use: usize,
    pub user_leases: usize,
    pub ip_leases: usize,
    pub provider_inflight: usize,
    pub provider_waiting: usize,
    pub active_handlers: usize,
    pub background_workers: usize,
    pub draining: bool,
}

#[derive(Clone, Debug, Default)]
pub struct VoiceRuntimeTracker {
    state: Arc<Mutex<VoiceRuntimeState>>,
    zero: Arc<Notify>,
}

#[derive(Debug, Default)]
struct VoiceRuntimeState {
    draining: bool,
    active_handlers: usize,
    background_workers: usize,
}

pub struct ActiveHandlerGuard {
    tracker: VoiceRuntimeTracker,
}

pub struct BackgroundWorkerGuard {
    tracker: VoiceRuntimeTracker,
}

impl VoiceRuntimeTracker {
    pub fn enter(&self) -> Result<ActiveHandlerGuard, RuntimeDraining> {
        let mut state = self.state.lock().expect("runtime tracker lock poisoned");
        if state.draining {
            return Err(RuntimeDraining);
        }
        state.active_handlers = state
            .active_handlers
            .checked_add(1)
            .expect("active handler counter overflow");
        Ok(ActiveHandlerGuard {
            tracker: self.clone(),
        })
    }

    pub fn begin_drain(&self) {
        self.state
            .lock()
            .expect("runtime tracker lock poisoned")
            .draining = true;
    }

    pub fn enter_background_worker(&self) -> Result<BackgroundWorkerGuard, RuntimeDraining> {
        let mut state = self.state.lock().expect("runtime tracker lock poisoned");
        if state.draining {
            return Err(RuntimeDraining);
        }
        state.background_workers = state
            .background_workers
            .checked_add(1)
            .expect("background worker counter overflow");
        Ok(BackgroundWorkerGuard {
            tracker: self.clone(),
        })
    }
}

impl Drop for ActiveHandlerGuard {
    fn drop(&mut self) {
        let reached_zero = {
            let mut state = self
                .tracker
                .state
                .lock()
                .expect("runtime tracker lock poisoned");
            state.active_handlers = state
                .active_handlers
                .checked_sub(1)
                .expect("active handler guard dropped twice");
            state.active_handlers == 0 && state.background_workers == 0
        };
        if reached_zero {
            self.tracker.zero.notify_waiters();
        }
    }
}

impl Drop for BackgroundWorkerGuard {
    fn drop(&mut self) {
        let reached_zero = {
            let mut state = self
                .tracker
                .state
                .lock()
                .expect("runtime tracker lock poisoned");
            state.background_workers = state
                .background_workers
                .checked_sub(1)
                .expect("background worker guard dropped twice");
            state.active_handlers == 0 && state.background_workers == 0
        };
        if reached_zero {
            self.tracker.zero.notify_waiters();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DrainOutcome {
    Drained,
    TimedOut(VoiceRuntimeSnapshot),
}

pub async fn begin_drain_and_wait(
    state: &AppState,
    grace: Duration,
) -> DrainOutcome;
```

`VoiceRuntimeTracker::enter` checks drain and increments under one lock before allocating a session slot, then returns an RAII guard carried by `VoiceAdmission` into socket handling. A corresponding background-worker guard is acquired when the selected D-04 finalizer starts. Guard drop decrements its exact counter once and notifies waiters when both counters reach zero. `begin_drain_and_wait` first calls `runtime_tracker.begin_drain()` to close the admission race, then flips `VoiceDrainSignal` for accepted sessions, then waits until `active_handlers == 0 && background_workers == 0` or the absolute grace deadline. Construct the `Notify::notified()` future before each zero check so the final drop cannot be missed. The snapshot exposes only counts, never map keys.

When D-04 is `SOFT_DELETE_UNDO`, the same drain sequence also signals Task 6's deletion-finalizer worker and awaits its `JoinHandle` within the absolute drain grace. A worker blocked in its store call is cancelled at grace expiry and reported as one sanitized background-worker count; no deletion ID/store reason is logged. Under `CONFIRM_DELETE`, there is no such handle or conditional runtime branch.

- [ ] Add RED unit tests for guard enter/drop, concurrent guard drops, a waiter that starts before the last drop, a waiter that starts after zero, and a paused-time grace timeout whose `TimedOut` snapshot shows the remaining handler.
- [ ] Add RED admission tests that simultaneously fill global session, per-user, per-IP, provider-inflight, and provider-wait capacities. Assert exact snapshots at each transition, no counter exceeds its configured cap, queue cancellation decrements waiting once, and denial/drop returns to the initial snapshot.
- [ ] Add a RED drain race test: hold sessions in first-frame wait, active provider work, provider queue, blocked outbound write, and—under `SOFT_DELETE_UNDO`—one deletion-finalizer pass; call `begin_drain_and_wait`; assert new upgrades fail before slot acquisition, every provider task is stopped, the finalizer is joined/cancelled, every lease reaches zero, and the outcome is `Drained` before 20 seconds.
- [ ] Run `cargo test -p agent-service runtime_tracker_` and `cargo test -p agent-service --test voice_ws server_owned_capacity_`. Expected RED: only semaphore availability is observable and shutdown uses an unconditional sleep.
- [ ] Add the tracker and sanitized snapshot to `AppState`; include the snapshot in operator-authenticated readiness, returning not-ready while draining. Keep `/live` independent of store/provider checks and omit capacity detail there.
- [ ] Replace `main.rs`'s fixed two-second sleep with `begin_drain_and_wait(&state, state.ws_timeouts.drain_grace)`, logging only counts if grace expires. Continue to use Axum graceful shutdown after the drain future resolves.
- [ ] Run the focused tests plus `cargo test -p agent-service --test voice_ws websocket_drain_`; expect PASS.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/app.rs agent/crates/agent-service/src/ws.rs agent/crates/agent-service/src/main.rs agent/crates/agent-service/src/lib.rs agent/crates/agent-service/tests/voice_ws.rs
git commit -m "fix(agent-service): prove bounded admission drain"
```

### Task 12: Remove production fixture resurrection (SERVICE-013)

**Files:**
- Modify: `agent/crates/agent-service/src/config.rs`
- Test: `agent/crates/agent-service/src/config.rs`

Normal service startup may connect and run idempotent migrations. It must not seed, restore, or mutate application rows. Fixture setup remains explicit in tests and development commands outside `build_study_store`.

Use these fixed seeded storage IDs in the restart test:

```rust
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
    data::run_migrations(&pool).await.expect("migrations should run");
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
    drop(build_study_store(&config).await.expect("first startup should succeed"));
    drop(build_study_store(&config).await.expect("second startup should succeed"));

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
```

- [ ] Add an ignored, required-Postgres RED restart test named `postgres_startup_does_not_resurrect_fixture`. It must call `required_service_postgres_url`, explicitly connect, run migrations, call `data::seed_postgres_fixture` once as test setup, tombstone the seeded study document and source span, change a seeded concept label to `deletion-sentinel`, then call `build_study_store` twice. It must fail, not return, when the required flag or URL is absent.
- [ ] Query by the fixed fixture UUIDs and assert both `deleted_at` values remain non-null and the concept label remains `deletion-sentinel`. Also assert no startup call changes row counts. Use one isolated PostgreSQL 16 database and `--test-threads=1`.
- [ ] Run:

```bash
cd agent
SERVICE_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_service_test \
cargo test -p agent-service postgres_ -- --ignored --test-threads=1 --nocapture
```

Expected RED: `build_study_store` calls `data::seed_postgres_fixture`, clears tombstones, and restores fixture values.

- [ ] Delete only the `data::seed_postgres_fixture(&pool)` call from production `build_study_store`; retain connection, migrations, and the `PostgresStudyStore` construction. Do not add a production seed toggle.
- [ ] Rerun the required-Postgres command twice against freshly isolated databases; expect PASS both times. A skipped test or missing `DATABASE_URL` is not evidence.
- [ ] Commit:

```bash
git add agent/crates/agent-service/src/config.rs
git commit -m "fix(agent-service): stop reseeding production startup"
```

### Task 13: Characterize and decompose service responsibilities without semantic change (SERVICE-017, ARC-05, QLT-09, REL-07)

This is deliberately late: Tasks 1-12 first fix and freeze the service behavior. The extraction commit may move code and narrow visibility, but it may not change a route, response, timer, capacity transition, authorization decision, store/provider call, protocol frame, or cleanup order. `protocol.rs` remains excluded.

**Files:**
- Modify: `agent/crates/agent-service/src/ws.rs`
- Create: `agent/crates/agent-service/src/ws/preflight.rs`
- Create: `agent/crates/agent-service/src/ws/admission.rs`
- Create: `agent/crates/agent-service/src/ws/turn.rs`
- Create: `agent/crates/agent-service/src/ws/provider.rs`
- Create: `agent/crates/agent-service/src/ws/terminal.rs`
- Modify: `agent/crates/agent-service/src/app.rs`
- Modify: `agent/crates/agent-service/src/lib.rs`
- Create: `agent/crates/agent-service/src/http/mod.rs`
- Create: `agent/crates/agent-service/src/http/health.rs`
- Create: `agent/crates/agent-service/src/http/library.rs`
- Create: `agent/crates/agent-service/src/http/ingestion.rs`
- Test: `agent/crates/agent-service/src/ws.rs`
- Test: `agent/crates/agent-service/src/app.rs`
- Test: `agent/crates/agent-service/tests/voice_ws.rs`
- Never modify: `agent/crates/agent-service/src/protocol.rs`
- Conditional coordinator handoff only: `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`

**Exact responsibility map:**

| Module | Sole responsibility after extraction |
| --- | --- |
| `ws/preflight.rs` | peer/proxy IP derivation, Origin/bearer/token preflight, signed claim verification, initial-config nonce/binding gate |
| `ws/admission.rs` | session/user/IP/provider capacity reservations, runtime tracker/guard, queue accounting, drain admission closure |
| `ws/turn.rs` | admitted turn registration, response binding, single event classifier, context refresh policy, between-turn idle state |
| `ws/provider.rs` | provider task spawn/stop, provider stream receive, durable event forwarding prerequisites, provider backoff input |
| `ws/terminal.rs` | `BoundedSender`, v5 serialization fallback, heartbeat, terminal/error/Close emission, write-timeout cleanup trigger |
| `ws.rs` | public upgrade entry point and top-level session-loop orchestration only |
| `http/health.rs` | root/health/live/operator-ready/brain-ready handlers and their route registration |
| `http/library.rs` | authenticated projection, snapshot/export/delete, and selected D-04 restore handlers plus route registration |
| `http/ingestion.rs` | paste/file/retry request parsing, strict-shape rejection, PDF/store error mapping, and route registration |
| `http/mod.rs` | merge the three route groups; no business logic |
| `app.rs` | shared `AppState`, shared HTTP access/error types, `/ws` registration, and final router composition |

Use these route-group interfaces; `build_router` merges each group once and adds `/ws` once:

```rust
pub(crate) mod health;
pub(crate) mod ingestion;
pub(crate) mod library;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .merge(health::routes())
        .merge(ingestion::routes())
        .merge(library::routes())
}
```

Child modules use `pub(super)` by default. A type becomes `pub(crate)` only when `app.rs`, `main.rs`, or a sibling module requires it; no new public export is allowed from `lib.rs` except the `http` module declaration needed for composition. Do not copy helpers between modules: move them once, preserve call order, and pass explicit state/guards instead of introducing globals.

- [ ] Before moving code, record the measured baseline with `wc -l agent/crates/agent-service/src/{ws.rs,app.rs}` and `rg -n '^(pub\(crate\) )?(async )?fn |^async fn ' agent/crates/agent-service/src/{ws.rs,app.rs}`. Add the counts and responsibility list to the lane proof referenced by the PR and coordinator ledger.
- [ ] Add a RED `router_surface_registration_` table that sends the correct HTTP method to every registered route: `/`, `/health`, `/live`, `/ready`, `/health/brain`, `/study-sets/paste`, `/study-sets/files`, `/study-sets/{id}/files/retry`, `/study-sets/export`, `/study-sets/library`, `/v1/study-sets/{id}/projection`, both delete routes, the selected D-04 restore route when applicable, and `/ws`. With minimally valid headers/body, assert each response is not `404`/`405`; assert an unknown path is `404`. Count each handler invocation with test state so a duplicate or missing merge cannot hide behind status alone.
- [ ] Freeze the state-machine characterizations from Tasks 8-11: admitted turn registration precedes `QuestionStarted` binding; exactly one resolution removes a response binding only after successful forwarding; context refresh cannot change access identity/deadlines; provider wait/inflight counts transition once; between-turn idle rearms only at zero pending/active turns; slow-client/heartbeat/drain paths drop all RAII guards. Name the aggregate control `ws_state_transition_characterization_` and run it before extraction.
- [ ] Run `cargo test -p agent-service router_surface_registration_ -- --nocapture` and `cargo test -p agent-service ws_state_transition_characterization_ -- --nocapture`. Expected PASS on the fixed monolith. Commit only these characterization additions as `test(agent-service): freeze service behavior before split`; record `git hash-object agent/crates/agent-service/src/ws.rs agent/crates/agent-service/src/app.rs agent/crates/agent-service/tests/voice_ws.rs` in the lane proof.
- [ ] Prove sensitivity before extraction. Independently remove the `/study-sets/files` registration, skip admitted-turn registration, skip response-binding removal, and skip between-turn-idle rearm. Each mutation must fail its named characterization test. Restore each mutation with the inverse patch and rerun GREEN before applying the next. This is mandatory mutation evidence, not an instruction to commit mutations.
- [ ] Move code according to the responsibility table. `ws.rs` declares the five exact submodules; `lib.rs` declares `mod http`; `app.rs::build_router` merges `http::routes()` and registers `/ws`. Preserve all existing test names and bodies after the characterization commit; the extraction commit may update only import paths/visibility required by the move.
- [ ] Run `cargo fmt --all -- --check`, `cargo clippy -p agent-service --all-targets -- -D warnings`, `cargo test -p agent-service --lib`, and `cargo test -p agent-service --test voice_ws`. Compare the before/after route table and sanitized runtime snapshots byte-for-byte. Expected: no behavioral delta.
- [ ] Measure the result. `ws.rs` and `app.rs` must each contain no more than 900 lines, each named responsibility must have exactly one owning module, and `rg -n 'VIVA_VOICE_PROTOCOL_VERSION|enum (ClientFrame|ServerFrame)' agent/crates/agent-service/src/ws agent/crates/agent-service/src/http` must show imports/usages but no redefinition. Review `git diff --stat` and `git diff -- agent/crates/agent-service/src/protocol.rs`; the latter must be empty.
- [ ] If a named split cannot safely compile and preserve the frozen tests within this bounded task, do not silently keep a partial anonymous split. Capture the attempted module, before/after line counts, functions/responsibilities still coupled, the exact compile/test failure, and the smallest prerequisite under exactly one of `SERVICE-DECOMPOSITION-DEFER-WS-PREFLIGHT`, `SERVICE-DECOMPOSITION-DEFER-WS-ADMISSION`, `SERVICE-DECOMPOSITION-DEFER-WS-TURN`, `SERVICE-DECOMPOSITION-DEFER-WS-PROVIDER`, `SERVICE-DECOMPOSITION-DEFER-WS-TERMINAL`, `SERVICE-DECOMPOSITION-DEFER-HTTP-HEALTH`, `SERVICE-DECOMPOSITION-DEFER-HTTP-LIBRARY`, or `SERVICE-DECOMPOSITION-DEFER-HTTP-INGESTION`. Ask the coverage-ledger owner to record `DEFER` before merging the other safe sub-splits. A preference, time estimate, or unmeasured “too coupled” claim is not sufficient. The task itself and every safely separable named module remain required.
- [ ] Commit the extraction separately with no test-body or semantic change:

```bash
git add agent/crates/agent-service/src/app.rs agent/crates/agent-service/src/lib.rs agent/crates/agent-service/src/ws.rs agent/crates/agent-service/src/http agent/crates/agent-service/src/ws
git commit -m "refactor(agent-service): decompose runtime responsibilities"
```

The lane proof/PR must state `No semantic change`, list any coordinator-recorded DEFER keys, and include the before/after line counts plus the four mutation-test names.

### Task 14: Run the combined release proof and hand off downstream gates (SERVICE-001 through SERVICE-018)

**Files:**
- Verify: `agent/crates/agent-service/Cargo.toml`
- Verify: `agent/crates/agent-service/src/app.rs`
- Verify: `agent/crates/agent-service/src/config.rs`
- Verify: `agent/crates/agent-service/src/lib.rs`
- Verify: `agent/crates/agent-service/src/main.rs`
- Verify: `agent/crates/agent-service/src/ws.rs`
- Verify: `agent/crates/agent-service/src/ws/preflight.rs`
- Verify: `agent/crates/agent-service/src/ws/admission.rs`
- Verify: `agent/crates/agent-service/src/ws/turn.rs`
- Verify: `agent/crates/agent-service/src/ws/provider.rs`
- Verify: `agent/crates/agent-service/src/ws/terminal.rs`
- Verify: `agent/crates/agent-service/src/http/mod.rs`
- Verify: `agent/crates/agent-service/src/http/health.rs`
- Verify: `agent/crates/agent-service/src/http/library.rs`
- Verify: `agent/crates/agent-service/src/http/ingestion.rs`
- Verify: `agent/crates/agent-service/tests/voice_ws.rs`
- Read only: `agent/crates/agent-service/src/protocol.rs`
- Read only: `agent/fixtures/voice-protocol/v5/manifest.json`

- [ ] From `agent/`, run the deterministic service gate:

```bash
cargo fmt --all -- --check
cargo clippy -p agent-service --all-targets -- -D warnings
cargo test -p agent-service --lib
cargo test -p agent-service --test voice_ws
cargo test -p data pdf_ingestion_fails_closed_ -- --nocapture
cargo test --workspace
```

- [ ] Apply the recorded D-04 branch to release proof. Under `SOFT_DELETE_UNDO`, run:

```bash
cargo test -p agent-service authenticated_restore_ -- --nocapture
cargo test -p data study_set_restore_ -- --nocapture
DATA_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test \
cargo test -p data postgres_study_set_restore_ -- --ignored --test-threads=1 --nocapture
```

Under `CONFIRM_DELETE`, run `cargo test -p agent-service restore_route_absent_ -- --nocapture` and reject any restore-route symbol/registration in the combined diff.

- [ ] Run the required durable restart proof; fail the gate if the database variable is absent:

```bash
cd agent
: "${DATABASE_URL:?set DATABASE_URL to a fresh PostgreSQL 16 viva_service_test database}"
SERVICE_POSTGRES_REQUIRED=1 \
DATABASE_URL="$DATABASE_URL" \
cargo test -p agent-service postgres_ -- --ignored --test-threads=1 --nocapture
```

- [ ] From the repository root, run Plan 05's contract and fixture checks without changing its files:

```bash
bun test packages/core/src/agent-contract.test.ts
VIVA_ALLOW_LOOPBACK_TEST_SKIP=1 cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_study_projection -- --nocapture
```

- [ ] Run structural controls:

```bash
test "$(rg -n 'pub const VIVA_VOICE_PROTOCOL_VERSION: u32 = 5' agent/crates/agent-service/src/protocol.rs | wc -l | tr -d ' ')" = "1"
test "$(rg -n 'InitialClientFrame|version\\\":1|brain_event_provider_turn_completion' agent/crates/agent-service/src/{ws.rs,app.rs,lib.rs,ws,http} | wc -l | tr -d ' ')" = "0"
test "$(rg -n 'from_utf8_lossy|pdf_extract|pdf_parser|ocr' agent/crates/agent-service/src/{app.rs,http} agent/crates/agent-service/tests/voice_ws.rs | wc -l | tr -d ' ')" = "0"
test "$(rg -n 'seed_postgres_fixture' agent/crates/agent-service/src/config.rs | wc -l | tr -d ' ')" = "1"
test "$(wc -l < agent/crates/agent-service/src/ws.rs | tr -d ' ')" -le 900
test "$(wc -l < agent/crates/agent-service/src/app.rs | tr -d ' ')" -le 900
git diff --check
```

The one remaining `seed_postgres_fixture` reference is the explicit ignored Postgres test, not `build_study_store`. Review the matching line before accepting this control.

- [ ] Inspect the combined diff. Reject any edit to `protocol.rs`, `agent/fixtures/voice-protocol/**`, `packages/core/src/agent-contract.ts`, or `agent/Cargo.toml`. Reject any test that relies only on client state to prove lease release.
- [ ] Commit any mechanical formatting produced by the task, staging only Plan 08-owned files:

```bash
git add agent/crates/agent-service/Cargo.toml agent/crates/agent-service/src/app.rs agent/crates/agent-service/src/config.rs agent/crates/agent-service/src/lib.rs agent/crates/agent-service/src/main.rs agent/crates/agent-service/src/ws.rs agent/crates/agent-service/src/ws agent/crates/agent-service/src/http agent/crates/agent-service/tests/voice_ws.rs
git diff --cached --quiet || git commit -m "test(agent-service): prove bounded runtime lifecycle"
```

## Downstream release handoff

Plan 08 is code-complete only after the local and required-Postgres gates above pass. Production release remains blocked until the downstream owners attach all of this evidence to the same commit:

- **Plan 04/09:** the exact `AuthenticatedStudyProjectionV1` conformance artifact and claim tuple used by the service projection route; no alternate projection schema. Attach the real text/compressed/scanned/encrypted/malformed PDF store proof showing every PDF is `InvalidInput`, never ready, until bounded page-aware extraction exists. The lane handoff report must also publish the exact names of this plan's service learning tests (the `ws.rs`/service tests covering `turn_deferred`, V2 recap, progression, completion, and selected D-03 claim binding): Plan 04's LEARN-011 Step 3 runs precisely that published list and treats a zero-match filter as FAIL, so the names may not be left implicit.
- **Plan 11:** scoped library-read/library-delete credential configuration and rotation, exact two-header projection proxy proof, and the selected D-07 branch. Under D-07 Branch A, include hashed one-time refresh rotation, replay/deletion revocation, identity binding, and absolute-lifetime proof. Under D-07 Branch B, include shared service-bearer deployment and deletion of token-only surfaces. Under D-04 `SOFT_DELETE_UNDO`, consume the browser one-time restore capability before proxying the exact deletion ID with the delete-scoped bearer and the fresh server-built `X-Viva-Verified-User-Id` (never session claims or any session token); under `CONFIRM_DELETE`, expose no restore proxy.
- **Plan 10:** browser consumption through the Plan 11 proxy, never a direct agent/store credential or caller-selected identity. Shipped paste/file/retry requests from `apps/web/lib/viva-agent-client.ts` contain only the strict Plan 08 request members; attach Plan 10's client request-shape test (`WEBSESSION-PASTE-01`) proving no `user_id`, `session_id`, source, question, or unknown member is sent.
- **Plan 12:** apply the Task 3 runbook handoff to `docs/deployment-runbook.md` — `VIVA_VOICE_WS_MAX_IP_SESSIONS` keys off the socket peer address (or the rightmost untrusted hop behind `VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS`), no forwarding-header requirement for direct deployments, unset trusted proxies means forwarding headers are ignored — so the coordinator can link the Plan 12 commit in the SERVICE-003 ledger rows.
- **Plan 13:** restore/undo UI obligations for the surfaces it owns, exactly as stated in the Task 6 handoff; it edits none of the ingestion client files.
- **Plan 05:** immutable v5 manifest and fixtures, legacy-v4 rejection unless its explicit compatibility task proves a narrower safe path, and TypeScript parsing of the v5 serialization fallback.
- **Architecture/reliability owner:** attach the characterization commit, no-semantic-change extraction commit, before/after line counts, four mutation failures, and any coordinator-approved `SERVICE-DECOMPOSITION-DEFER-*` entries. A partial unrecorded split does not pass.
- **Release owner:** configure `VIVA_AGENT_OPERATOR_BEARER_TOKEN` in the probe secret store, keep `/live` unauthenticated, and send the operator bearer only to `/ready` and `/health/brain`. Run a hosted termination test against the actual platform and live provider. Establish a voice session, hold provider work, initiate process termination, and prove before the platform kill deadline: admission closes, the provider receives stop/cancel, handler/session/user/IP/provider counts reach zero, and the process exits. Sanitize the captured readiness snapshots and provider evidence.

The release owner must record the exact commit SHA, selected D-07 branch, selected D-04 branch, configuration bounds, PostgreSQL 16 job URL, hosted termination job URL, Plan 05 manifest digest, and zero unresolved review threads. Local paused-time/custom-sink success is necessary but does not substitute for hosted process/provider evidence.
