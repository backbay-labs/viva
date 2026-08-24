# Code Review: Rust agent-service crate (WS protocol + HTTP service)

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | agent/crates/agent-service/ |
| **Verdict** | sound-with-fixes |
| **Confidence** | High for static/local behavior; moderate for deployed proxy/network behavior |

The agent-service crate is the Rust WebSocket voice endpoint plus its HTTP service surface: session-token auth, per-user/per-study-set/per-IP admission, provider concurrency limiting, brain event forwarding with server-authoritative re-authorization, and terminal-reason handling. A first-pass review produced nine findings; this pass adversarially re-verified every critical/important finding against the source and spot-checked the minors. All nine survived verification at their original severities — none were refuted or downgraded, and verification strengthened one (the runbook itself recommends the spoofable IP cap). The core session logic, auth design, and cancellation accounting are correct under close reading; the confirmed gaps cluster around liveness and abuse resistance of a long-running public service, each with a contained fix.

## Strengths

- Session-token auth is carefully engineered: HMAC-SHA256 over a versioned `viva1.` payload with `deny_unknown_fields` claims, constant-time comparison, bounded clock skew, and single-use nonces consumed only after lease/backoff admission so a denied connection does not burn its token (`agent/crates/agent-service/src/config.rs:782-868`, `src/ws.rs:443-487`; `tests/voice_ws.rs` covers the denial-does-not-consume-nonce case).
- Server-authoritative trust boundary: client identity fields are re-validated against the token binding on every `session_config` (`src/ws.rs:3077-3103`), browser-supplied `source_context`/`active_concepts` are stripped and rehydrated from the store, `tool_result` frames are rejected as untrusted (`src/ws.rs:2963`), and every provider event forwarded to the browser is re-authorized against the durable store before send (`src/ws.rs:2559-2652`).
- Fail-closed configuration: public binds require auth plus origin allowlists (`src/config.rs:173-192`), signed-session mode requires a durable store with nonce replay protection (`src/config.rs:594-625`), and failure-control refuses to enable without its full gate set.
- Integration tests exercise real behavior: real WebSockets over TCP replay fixtures shared byte-exact with the TS contract, evidence packs are asserted, an optional Postgres path verifies terminal rows via SQL, and adversarial cases (forged identity, replayed nonce, queue cancellation, backpressure, drain, slow client) are covered (`tests/voice_ws.rs`, ~150 tests).
- Terminal-reason handling is disciplined: static sanitized messages to clients, a structured observability classification table, careful discrimination of durability-degraded store failures from semantic store errors, and a deterministic durable-state-only partial recap on provider failure (`src/ws.rs:1396-1439`, `src/ws.rs:1960-1968`).
- Cancellation/barge-in propagation is correct under concurrency: pending queued provider admissions are dropped with Drop-based waiter release (`src/app.rs:199-210`, `src/app.rs:597-609`), and stale post-cancel events and superseded recaps are suppressed by response identity (`src/ws.rs:790-806`, `src/ws.rs:1915-1932`).

## Findings

### Important

1. **No server heartbeat or between-turn idle cap: a zombie socket locks a learner out of their study set for up to 6 hours**

   `agent/crates/agent-service/src/ws.rs:51` (also `src/ws.rs:544`, `src/ws.rs:800-803`)

   **What:** After the first answer resolves, `pre_answer_idle` stays disarmed — the only re-arm site is the cancel path (`ws.rs:800-803`); `apply_provider_turn_accounting` (`ws.rs:1853-1913`) clears `turn_cap_deadline` when counts return to zero but never re-arms the idle timer. Between turns the only live timer is the 6-hour session cap (`WsTimeouts::default().session`, `src/app.rs:972`). The server never sends WebSocket Ping frames (the only Ping/Pong handling is inbound, mapped to `Keepalive` at `ws.rs:2987`, which browsers cannot send), and the web client has no application-level keepalive. A half-open TCP connection (device sleep, network drop between questions) is therefore undetected until the 6h cap fires. `MAX_ACTIVE_SESSIONS_PER_USER_STUDY_SET` is hardcoded to 1 with a 250ms reconnect grace (`ws.rs:49-51`), so every reconnect attempt is denied with a `session_cap` terminal close (`ws.rs:406-426`) while the zombie holds the lease.

   **Why it matters:** In the documented direct-browser-WSS production mode, a student whose laptop sleeps between questions cannot resume that study set for hours — the core product flow breaks after a routine network event, and each zombie also pins one of the 32 global session slots.

   **Fix:** Add a server-initiated Ping interval (e.g. 30s) with a pong deadline that closes dead sockets, and/or arm a between-turn idle timeout (re-arm `pre_answer_idle` with a generous think-time bound when `pending_submitted_answers` and `active_provider_turns` both return to 0).

2. **No write timeout on outbound frames: a slow-reading client wedges the session loop, its leases, and graceful drain**

   `agent/crates/agent-service/src/ws.rs:3869-3877`

   **What:** `send_json` awaits `sender.send()` with no deadline, and all outbound sends happen inline inside `tokio::select!` branch bodies (e.g. brain-event forwarding at `ws.rs:1231-1332`), so while a send is blocked no other arm — drain, session cap, turn cap — can be polled. A client that stops reading (full TCP window) parks the handler inside `send_json` indefinitely, holding the session semaphore permit, the user/user-study-set leases, and any in-flight provider admission lease (one of 8 by default). The `TERMINAL_EVENT_DRAIN_TIMEOUT` at `ws.rs:1748` bounds only waiting for brain events, not the socket write. The handler never observes `drain_signal`, so the SIGTERM graceful shutdown in `src/main.rs:49-51` waits on the connection until the platform SIGKILLs the process.

   **Why it matters:** A single malicious or pathologically slow client permanently consumes provider concurrency and per-user leases, and deploy drains hang. The crate models `slow_client` failures elsewhere (`TerminalSessionReason::SlowClient`, `ws.rs:1007`) but has no defense on the write path itself.

   **Fix:** Wrap outbound sends in `tokio::time::timeout` (a few seconds), treating expiry as `TerminalSessionReason::SlowClient`; alternatively run the sink behind a bounded mpsc with a dedicated writer task so the select loop stays responsive to timers and drain.

3. **Per-IP session cap keys off client-spoofable x-forwarded-for (leftmost entry)**

   `agent/crates/agent-service/src/ws.rs:189-205`

   **What:** `session_ip_key` takes the first comma-separated element of `x-forwarded-for`, falls back to `x-real-ip`, and never consults the actual peer address — `ConnectInfo` is not used anywhere in the crate and `main.rs` serves the router without `into_make_service_with_connect_info`. Proxies append the real client IP to an existing header, so the leftmost entry is always attacker-controlled: sending `X-Forwarded-For: <random>` yields a fresh limiter key per connection. Without a proxy setting the header, all direct clients collapse into the single key `"unknown"`. The deployment runbook's direct-WSS recipe explicitly recommends `VIVA_VOICE_WS_MAX_IP_SESSIONS="5"` (`docs/deployment-runbook.md:85`), which in the unknown-collapse case becomes an accidental global cap of 5 concurrent sessions.

   **Why it matters:** The knob is an abuse control for public deployments and fails precisely against the adversary it exists to stop; following the runbook on a direct deployment can also lock out all legitimate clients at once.

   **Fix:** Bind with `into_make_service_with_connect_info::<SocketAddr>()` and use the peer address by default; honor forwarding headers only behind an explicit trusted-proxy config, taking the rightmost non-trusted entry.

4. **Token-only public mode performs zero auth at WS preflight, so unauthenticated sockets consume session slots**

   `agent/crates/agent-service/src/config.rs:760-779`

   **What:** `validate_ws_bearer_headers` returns `Ok` immediately when `required_bearer` is `None` — the `sec-websocket-protocol` bearer fallback (`config.rs:944-970`) is only consulted inside the shared-bearer comparison path, so in the documented bearer-less direct-WSS mode (the runbook "intentionally omits `VIVA_VOICE_WS_BEARER_TOKEN`", `docs/deployment-runbook.md:72`) only the trivially spoofable Origin allowlist gates the handshake. `validate_ws_preflight` then acquires an owned semaphore permit (`ws.rs:91-105`) and the handler sends the Ready frame with brain/store capabilities before any token is seen (`ws.rs:274-286`); auth happens only at the first frame, up to 10s later (`WsTimeouts::default().first_frame`). The web client already transmits the session token via `sec-websocket-protocol: bearer.<b64url>` (`apps/web/lib/viva-agent-client.ts` `vivaAgentProtocols`), so the material to authenticate the handshake is present but ignored.

   **Why it matters:** An unauthenticated attacker can hold all 32 default session slots with idle sockets refreshed every ~10s at near-zero cost, denying service to authenticated users, and receives capability metadata pre-auth.

   **Fix:** When `session_token_secret` is configured and `required_bearer` is not, verify the `sec-websocket-protocol` bearer token signature/expiry in `validate_headers` (rejecting handshakes without one), or defer semaphore acquisition and the Ready frame until after the first-frame token check.

5. **VoiceEvidenceRecorder and VoiceUsageRecorder grow unbounded in a long-running process**

   `agent/crates/agent-service/src/app.rs:1005-1030`

   **What:** Both recorders are `Arc<RwLock<Vec<_>>>` that only ever push. Evidence gets an entry per client audio frame (`record_client_action` maps `ClientAction::Audio` to `AnswerReceived`, `ws.rs:3422-3444`), per provider admission, per question/evaluation/cancel event, and per terminal close; nothing in production code reads or trims it — `evidence.snapshot()` is called only from tests, and no HTTP route exposes it. Usage events accumulate per turn forever and `/health/brain` re-scans them linearly via `summary()` (`app.rs:1081-1107`, served at `app.rs:1265`).

   **Why it matters:** A production agent process streaming voice accumulates heap-allocated Strings indefinitely — at tens of audio frames per second this is tens of MB per active-session-hour — an unbounded leak that will eventually OOM long-lived deployments, and `/health/brain` gets slower over time.

   **Fix:** Cap both recorders with a ring buffer (e.g. `VecDeque` with a max length), or gate evidence recording behind a config flag used only by the release-gate harness, and keep running aggregates for the usage summary instead of retaining every event.

### Minor

1. **`brain_event_submitted_answer_resolution` and `brain_event_provider_turn_completion` are byte-identical duplicates**

   `agent/crates/agent-service/src/ws.rs:1352-1394`

   **What:** The two functions have exactly the same match body over the same `BrainEvent` variants; `forward_brain_event_with_turn_accounting` calls both on every event and `apply_provider_turn_accounting` consumes both results for the two counters.

   **Why it matters:** This is the most delicate accounting in the file (turn-cap disarm vs provider-lease release); duplicated logic invites the two paths drifting apart silently when a new `BrainEvent` variant is added, and the duplication obscures that the two counters currently resolve on identical signals.

   **Fix:** Collapse into one function called once, or make one delegate to the other with a comment explaining when the two would legitimately diverge.

2. **Trusted-mode session rotation makes mid-session `session_config` refresh impossible**

   `agent/crates/agent-service/src/ws.rs:3169-3175`

   **What:** In trusted mode (no token secret) `authorize_initial_session_config` rotates `config.session_id` to a server-generated id after sanitizing against the trusted binding, and the loop's binding is rebuilt from the rotated config (`ws.rs:320-321`). A subsequent refresh frame is sanitized against that rotated id (`ws.rs:2917-2925` via `sanitize_client_session_config`), which the client never learns — no `ServerFrame` variant carries a session id — so any refresh is rejected as `invalid_session_identity` and the socket closes.

   **Why it matters:** Latent contract mismatch: the shipped web client only sends `session_config` on socket open, but the first client that exercises the documented refresh path in local trusted mode will get an inexplicable identity-mismatch close.

   **Fix:** Echo the rotated session id to the client (e.g. in a dedicated event), or accept the original trusted session id in refresh sanitization while keeping the rotated id server-side.

3. **`send_json` serialization-failure fallback frame hardcodes version 1, which the TS parser rejects**

   `agent/crates/agent-service/src/ws.rs:3873-3875`

   **What:** The fallback error string is `{"type":"error","version":1,...}` while the protocol is v4 (`protocol.rs:9`); `packages/core/src/agent-contract.ts` `parseVivaServerFrame` throws "Unsupported Viva voice protocol version" for any frame whose version differs, so the fallback frame would crash the client parser instead of communicating the error.

   **Why it matters:** Practically unreachable (`ServerFrame` serialization cannot realistically fail), but if it ever fires the client shows a protocol-version error rather than the intended diagnostic, and the stale constant will silently survive future version bumps.

   **Fix:** Build the fallback with `format!` using `VIVA_VOICE_PROTOCOL_VERSION`.

4. **`ReadyFrame` struct is dead code duplicating `ServerFrame::Ready`**

   `agent/crates/agent-service/src/protocol.rs:61-89`

   **What:** `ReadyFrame` (with `new()`/`Default`) is defined and re-exported from `lib.rs:17` but never constructed anywhere in the crate, its tests, or the workspace; all ready-frame production goes through `ServerFrame::ready_with_capabilities`, and `ReadyFrame::new()` bakes in synthetic-provider defaults that real handlers never use.

   **Why it matters:** A public duplicate of the ready shape with hardcoded default capabilities is a drift trap: a field added to `ServerFrame::Ready` but not `ReadyFrame` (or vice versa) would silently desynchronize the exported contract type from the wire format.

   **Fix:** Delete `ReadyFrame` and its re-export, or construct it from the same capability sources and add a parity test.

## Verification notes

No findings were refuted or downgraded. Every critical/important finding was re-derived from source, and the attempted refutations failed:

- F1: the inbound Ping/Pong→`Keepalive` path (`ws.rs:2987`) looked like a possible heartbeat, but browsers cannot send WS pings and the web client has no keepalive logic; `pre_answer_idle_armed = true` appears only at init and on the cancel path.
- F2: `TERMINAL_EVENT_DRAIN_TIMEOUT` looked like a write bound, but it wraps `events.recv()`, not the socket send.
- F3: verified `ConnectInfo`/`into_make_service_with_connect_info` appear nowhere in the crate; the runbook recommending `MAX_IP_SESSIONS=5` (`docs/deployment-runbook.md:85`) strengthened the finding.
- F4: the `sec-websocket-protocol` bearer extraction exists (`config.rs:944-970`) but is only reachable when `required_bearer` is `Some`, confirming zero preflight token verification in token-only mode.
- F5: confirmed `evidence.snapshot()` is test-only, no route exposes it, and `ClientAction::Audio` records an evidence event per frame.
- Minors F6-F9 were each spot-checked (byte-identical bodies; no server frame carries a session id; protocol v4 vs hardcoded v1 with the TS parser throwing; `ReadyFrame` referenced only by its `lib.rs` re-export) and all confirmed.

## Recommendations

- Add a server-initiated WebSocket ping interval plus a bounded write deadline on all outbound sends; this single change addresses findings 1 and 2 together (dead-peer detection and slow-reader eviction) and keeps graceful drain reliable.
- In token-only public mode, verify the `sec-websocket-protocol` bearer session token during preflight (the client already sends it), and move Ready-frame emission after first-frame auth so capability metadata is not disclosed to unauthenticated sockets.
- Bound the evidence and usage recorders (ring buffer or config-gated recording) before any long-lived hosted deployment; today they are write-only unbounded memory in production.
- Switch IP limiting to the socket peer address via `into_make_service_with_connect_info`, honoring forwarding headers only behind an explicit trusted-proxy setting (rightmost untrusted hop), and update the runbook's `VIVA_VOICE_WS_MAX_IP_SESSIONS` guidance accordingly.
- Align the paste/file HTTP request contract: the web client sends `user_id` and `session_id` fields that `PasteStudySetRequest` silently drops (server-authoritative by design); either add `#[serde(deny_unknown_fields)]` plus client cleanup, or document the ignored fields in the contract.
- Consider a between-turn idle cap well below the 6h session cap so abandoned-but-live sockets release the 1-per-user-study-set lease sooner.
- The string-matching failure classifiers (`terminal_reason_for_provider_message`, durability-degraded message matching) are well-tested but inherently brittle; keep migrating providers toward structured `BrainProviderFailure` so the substring paths shrink over time.

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first-pass reviewer; verification confirmed all nine findings at their original severities). The crate's core logic — auth/token design, server-authoritative event authorization, cancellation and provider-admission accounting, terminal-reason taxonomy — is correct under close reading, with an integration suite that exercises real sockets adversarially. The confirmed findings are production-hardening gaps in liveness and abuse resistance (no heartbeat or write deadline, preflight auth deferred in the documented token-only mode, a spoofable IP key, unbounded in-memory recorders), each with a contained, low-risk fix; findings 1-5 should land before sustained public hosting.
