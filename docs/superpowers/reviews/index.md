# Viva comprehensive code review index

**Review date:** 2026-08-23  
**Reviewed revision:** `main` at `4d5d8276f03635ca74c04f4d500d13ce62198dd0`  
**Remote verification:** `origin/main` resolved to the same SHA on 2026-08-23  
**Overall confidence:** High for code and local-runtime findings; unknown for real Cartesia/Gemini and durable Postgres behavior because those environments were not available.

## Verdict

Viva is not release-ready as a voice-first product. The repository has unusually strong protocol, redaction, failure-state, and synthetic-browser testing, but its primary live microphone path rejects ordinary answers longer than roughly one second. The current remote `main` validation is also red, its default branch has no branch protection or ruleset, and both JavaScript and Rust dependency audits fail.

The strongest engineering is at the trust boundary: server-authoritative identity, nonce claims at WebSocket admission, client tool-result rejection, bounded source tuples, live-provider gating, sanitized evidence, and deterministic synthetic/fake provider fixtures. The weakest engineering is at the product boundary: real audio transport, real PDF extraction, study-set projection, grading/scheduling authority, and continuous proof of Postgres/live-provider behavior.

## Review documents

| Document | Scope |
| --- | --- |
| [Project state](./2026-08-23-project-state.md) | Git/remote/CI state, repository inventory, executed validation, unverified environments |
| [Architecture](./2026-08-23-architecture-review.md) | Package/crate boundaries, authority, coupling, module concentration |
| [Correctness](./2026-08-23-correctness-review.md) | Voice transport, ingestion, scheduling, grading, recap, audio conversion |
| [Security](./2026-08-23-security-review.md) | Tokens, tenancy, rate limiting, headers, supply chain, data handling |
| [Reliability and performance](./2026-08-23-reliability-and-performance-review.md) | Polling, retention, process lifetime, canvas/CSS cost, release tooling |
| [Quality and tests](./2026-08-23-quality-and-tests-review.md) | Hosted CI, branch protection, coverage gaps, Postgres/live-path proof, docs/gate honesty |
| [Frontend and UX](./2026-08-23-frontend-review.md) | Live browser inspection, responsive behavior, accessibility, visual-system audit |

### Component deep dives

The synthesis documents above use the authoritative P0-P3 model. The component reviews below retain a local `Critical` / `Important` / `Minor` vocabulary so that each file can stand alone; use this index when comparing priority across components.

[Component review corpus summary](./2026-08-23-comprehensive-review-summary.md) aggregates the twelve deep dives and their local finding counts.

| Document | Scope |
| --- | --- |
| [Architecture and contract consistency](./2026-08-23-architecture-consistency.md) | Cross-language protocol, learner-loop contract, build graph, documentation claims |
| [Web UI](./2026-08-23-web-ui.md) | App pages, live-session component, landing UI, browser behaviors |
| [Web session client](./2026-08-23-web-session-client.md) | WebSocket reducer/controller, runtime projection, capture and playback |
| [Web API proxy](./2026-08-23-web-api-proxy.md) | Same-origin mint/refresh routes, library proxy, capability filtering |
| [Shared TypeScript packages](./2026-08-23-packages-shared.md) | Core contracts and scheduler, tokens, UI package, shared types |
| [Rust agent-domain](./2026-08-23-rust-agent-domain.md) | Domain ports, tool executor, grading, recap, scheduling |
| [Rust agent-adapters](./2026-08-23-rust-agent-adapters.md) | Synthetic/fake/live Cartesia-Gemini runners and provider transports |
| [Rust agent-service](./2026-08-23-rust-agent-service.md) | HTTP/WS admission, lifecycle, forwarding, terminal behavior |
| [Rust data and observe](./2026-08-23-rust-data-observe.md) | Memory/Postgres stores, migrations, durable authorization, sanitized evidence |
| [E2E and hosted monitoring scripts](./2026-08-23-scripts-e2e-monitoring.md) | Browser proof, hosted monitors, live smoke, publication and quarantine |
| [Release-gate scripts](./2026-08-23-scripts-release-gates.md) | Bundle construction/integrity, evidence imports, redaction and shell gates |
| [Cross-cutting security deep dive](./2026-08-23-security.md) | Runtime containers, IP trust, token flow, CI/dependency hardening |

## Severity model

- **P0 — Blocking:** prevents the primary task or creates immediate catastrophic behavior.
- **P1 — Major:** wrong persistent data, material security/release exposure, or a major workflow failure.
- **P2 — Moderate:** meaningful reliability, accessibility, performance, or maintainability defect.
- **P3 — Minor:** bounded polish, hygiene, or future-maintenance issue.

## Cross-codebase priority findings

| Priority | ID | Finding | Confidence |
| --- | --- | --- | --- |
| P0 | COR-01 | The browser buffers a complete 24 kHz PCM16 answer into one JSON text frame; the server's 64 KiB cap permits only about **1.022 seconds** before closing the socket with `oversized_text_frame`. | High |
| P1 | QLT-01 | Remote `main` is red at the reviewed SHA, and `main` has neither branch protection nor repository rulesets. | High |
| P1 | COR-02 | Review scheduling persists fixed dates from 2026-06-18 through 2026-06-24, all already overdue. | High |
| P1 | COR-03 | Every Postgres-backed agent boot reseeds the fixture and clears fixture source tombstones, resurrecting deleted material. | High |
| P1 | COR-04 | `.pdf` uploads are decoded with `String::from_utf8_lossy`; there is no PDF parser or OCR, yet the study set can become `ready`. | High |
| P1 | COR-05 | `/session` overlays arbitrary route IDs on `seedStudySets[0]`, then recomputes recap/mastery from the biology fixture. | High |
| P1 | COR-06 | The deterministic evaluator grades by case-insensitive substring presence and the recap builder ignores actual session mastery. | High |
| P1 | COR-07 | A successful recap screenshot is simultaneously labeled “Session not connected” and offers “Retry agent.” | High |
| P1 | CORE-01 | The FSRS scheduler constructs a fresh empty card for every review, so stability/difficulty never accumulate and repeated success never lengthens the interval. | High |
| P1 | ADP-01 | The live Cartesia/Gemini runner persists deterministic fixture-derived mastery and can speak a hardcoded biology fallback when Gemini yields no text. | High |
| P1 | SVC-01 | Between-turn idle is not re-armed after normal completion and there is no server heartbeat; a half-open socket can hold the one-session lease until the six-hour session cap. | High |
| P1 | SVC-02 | Outbound WebSocket writes have no deadline and run inline, so a slow reader can wedge timers, leases, provider capacity, and graceful drain. | High |
| P1 | SVC-03 | The pre-auth per-IP limiter trusts the spoofable left-most `X-Forwarded-For` value; token-only mode allocates global slots before authenticating the first frame. | High |
| P1 | SEC-01 | `/api/viva-session/refresh` accepts any correctly signed expired access token with no refresh horizon or refresh-token rotation. | High |
| P1 | SEC-02 | `bun audit` reports 16 vulnerabilities (9 high); `cargo audit` reports 2 vulnerabilities plus 3 warnings. Neither audit is a validation/CI gate. | High |
| P1 | QLT-02 | Synthetic/fake E2E uses written or tiny fixture input and never exercises the browser's real live microphone submission path. | High |
| P1 | QLT-03 | Durable Postgres tests only run through manual `workflow_dispatch`; when enabled, raw migration replay and sqlx migration-ledger tests share one database and conflict. | High |
| P1 | MON-01 | Hosted consecutive-failure state is not propagated into live-smoke evidence, so the documented two-failure quarantine/rollback trigger cannot activate from hosted artifacts. | High |
| P1 | GATE-01 | Live-smoke evidence is not bound to the release deploy SHA, the BAC-528 disabled-harness field is hardcoded safe, and bundle HMAC is never verified downstream. | High |
| P2 | COR-08 | Streaming resampling resets fractional phase per AudioWorklet callback; 44.1 kHz input drifts and introduces block-boundary discontinuities. | High |
| P2 | REL-01 | Readiness polling has no timeout or abort and uses `setInterval`, so hung requests can overlap and accumulate. | High |
| P2 | REL-02 | Evidence and usage recorders are unbounded process-lifetime vectors; usage health summaries scan the full vector. | High |
| P2 | SEC-03 | Session-mint rate limiting is per-process and its map is never swept; it is neither horizontally authoritative nor memory-bounded. | High |
| P2 | API-01 | The web proxy buffers request and upstream response bodies without a route-level cap; token stripping is applied to library snapshots but not all successful create responses. | High |
| P2 | SEC-04 | Both runtime images execute as root; workflow/action and base-image references are mutable rather than immutable digest/SHA pins. | High |
| P2 | FE-01 | The session route lacks a `main` landmark; several product-required 44 px targets render at 29–42 px; ochre body text is about 2.85:1 on paper. | High |

## Release decision

**Decision: block. Confidence: high.** A release should not proceed until COR-01 is fixed and exercised through browser-to-agent E2E, remote `main` is green on the exact release SHA, audits are remediated or explicitly risk-accepted with reachability evidence, Postgres seed behavior can no longer undelete production data, and the release proof is bound to the exact deploy and verified outside the process that created it.

## Recommended repair order

1. Redesign live audio as a bounded stream with an explicit end-of-turn lifecycle; add 2 s, 10 s, and 45 s browser-to-server tests at 44.1 and 48 kHz.
2. Stop production Postgres seeding and replace fixed scheduling timestamps with one authoritative clock/scheduler.
3. Fail closed for PDF until real page-aware extraction exists; test compressed, scanned, encrypted, malformed, and text PDFs.
4. Bind `/session` and recap rendering to the server study-set projection; remove fixture overlay and client-side recap rewriting.
5. Add authenticated WebSocket preflight, a trusted-peer IP model, server heartbeat/between-turn expiry, and bounded outbound-write deadlines.
6. Repair the Node 24 hosted-monitor deadline test, consecutive-failure propagation, deploy binding, and downstream evidence verification.
7. Recompose the durable Postgres suite around isolated databases/schemas, make it continuous, and prove restart/deletion/replay behavior.
8. Upgrade vulnerable dependencies; add `bun audit` and `cargo audit` policy gates.
9. Replace expired-access-token refresh with a bounded, rotatable refresh credential.
10. Protect `main` with exact-head required checks after the full hosted workflow is green.

## Positive findings worth preserving

- Public binds fail closed unless access and origin configuration are present.
- WebSocket session claims bind user, study set, session, expiry, and nonce; the store claims the nonce atomically.
- Browser-supplied source context and tool results cannot become authoritative server output.
- Live Cartesia/Gemini selectability requires explicit runtime and zero-retention gates.
- Learner-facing copy and operator diagnostics are separated and structurally tested.
- Redaction controls inspect both field structure and artifacts; local E2E retained no trace and reported zero forbidden hits.
- Canvas animation caps DPR, throttles to about 32 fps, pauses in hidden tabs, and respects reduced motion.
- The parchment/manuscript visual direction is distinctive and coherent rather than a generic AI dashboard.
