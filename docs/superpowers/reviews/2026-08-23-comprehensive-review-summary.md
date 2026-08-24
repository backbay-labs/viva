# Comprehensive Code Review — Summary

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | `4d5d827` (main, "Prepare repository for public release") |
| **Method** | 12 area-specific reviews; findings were adversarially rechecked against cited source before publication |
| **Ground truth** | Fresh forced local TypeScript/Rust validation passed; the exact reviewed remote `main` workflow is red (run `31401218406`) |
| **Totals** | **2 critical · 44 important · 82 minor** confirmed findings; 2 first-pass findings refuted during verification |
| **Confidence** | High for source/local-runtime findings; unknown for live Cartesia/Gemini and live Postgres behavior |

Every critical and important finding below survived a dedicated adversarial verification pass
that re-read the cited code and tried to refute the claim. The two critical findings were also
rechecked directly against source before this summary was written.

> This file summarizes the twelve component reviews below. [The review index](./index.md) is the
> authoritative release decision and cross-component P0-P3 prioritization; the synthesis reviews
> organize the same codebase by correctness, security, architecture, reliability, quality, and UX.

## Verdicts by area

| Area | Doc | Verdict | C | I | M |
|---|---|---|---|---|---|
| Rust `agent-domain` | [2026-08-23-rust-agent-domain.md](2026-08-23-rust-agent-domain.md) | **needs-work** | 1 | 4 | 6 |
| Rust `agent-adapters` | [2026-08-23-rust-agent-adapters.md](2026-08-23-rust-agent-adapters.md) | sound-with-fixes | 0 | 6 | 5 |
| Rust `agent-service` | [2026-08-23-rust-agent-service.md](2026-08-23-rust-agent-service.md) | sound-with-fixes | 0 | 5 | 4 |
| Rust `data` + `observe` | [2026-08-23-rust-data-observe.md](2026-08-23-rust-data-observe.md) | sound-with-fixes | 0 | 5 | 8 |
| Web API + library proxy | [2026-08-23-web-api-proxy.md](2026-08-23-web-api-proxy.md) | sound-with-fixes | 0 | 2 | 6 |
| Web session client libs | [2026-08-23-web-session-client.md](2026-08-23-web-session-client.md) | sound-with-fixes | 0 | 2 | 8 |
| Web UI | [2026-08-23-web-ui.md](2026-08-23-web-ui.md) | sound-with-fixes | 1 | 4 | 7 |
| Shared TS packages | [2026-08-23-packages-shared.md](2026-08-23-packages-shared.md) | sound-with-fixes | 0 | 3 | 8 |
| Release-gate scripts | [2026-08-23-scripts-release-gates.md](2026-08-23-scripts-release-gates.md) | sound-with-fixes | 0 | 4 | 8 |
| E2E + monitoring scripts | [2026-08-23-scripts-e2e-monitoring.md](2026-08-23-scripts-e2e-monitoring.md) | sound-with-fixes | 0 | 4 | 8 |
| Security (cross-cutting) | [2026-08-23-security.md](2026-08-23-security.md) | sound-with-fixes | 0 | 2 | 6 |
| Architecture & contracts | [2026-08-23-architecture-consistency.md](2026-08-23-architecture-consistency.md) | sound-with-fixes | 0 | 3 | 8 |

## The two critical findings

1. **Live spoken answers longer than about 1.022 s terminate the session.**
   `apps/web/components/session/LiveSessionPage.tsx:484-515` base64-encodes the entire captured
   PCM buffer and sends it as one JSON text frame; the server rejects text frames over
   `VIVA_VOICE_MAX_TEXT_FRAME_BYTES = 64 * 1024` (`agent/crates/agent-service/src/protocol.rs:12`).
   At 24 kHz mono, 16-bit PCM produces 48,000 raw bytes/s and about 64,000 base64 bytes/s before
   JSON metadata. The measured representative limit is 24,537 samples, or 1.022375 s. No existing
   suite exercises a realistic-length live answer, so local suites remain green despite the bug.

2. **Review scheduling persists hardcoded June-2026 fixture dates as real due dates.**
   `agent/crates/agent-domain/src/tool_executor.rs:339-346` (`storage_due_at_for_status`) maps
   concept status to fixed timestamps of 2026-06-18 through 2026-06-24 — all already in the past.
   The README and docs describe FSRS scheduling; the genuine FSRS implementation exists in
   `packages/core/src/scheduling.ts` but the live Rust path never uses it. Found independently by
   two reviewers (agent-domain and architecture).

## Cross-cutting themes

**1. The transport is production-grade; the learning core is still fixture-grade.**
The voice pipeline (Cartesia/Gemini adapters, WS service, session auth, persistence) shows
disciplined engineering — sanitization, 429/fallback handling, cancellation, fail-closed stores,
fixture-enforced protocol contracts. But the domain logic that decides *what the student learns*
still carries synthetic-spike scaffolding on the live path: hardcoded due dates (above), naive
substring grading (`tool_executor.rs:86-133`), recaps fabricated from the question's term list
rather than performance (`tool_executor.rs:165-207`), fabricated "strong" concept-mastery writes
every turn (`agent-adapters/src/cartesia_gemini/runner.rs:795-853`), and a hardcoded biology
reply spoken live when Gemini returns no text (`runner.rs:726-731`).

**2. Several second-line defenses currently attest nothing.**
The release-gate layer genuinely gates where exercised, but: the advertised domain-purity gate
greps for Chef-Luca vocabulary, not I/O purity (`scripts/check-agent-domain-purity.sh:9-15`);
shell gates fail open if `rg`/`git` are missing (`|| true` swallows exit 127); the BAC-528 flag
is hardcoded `false` (`scripts/failure-control-harness.mjs:260`); the evidence-bundle HMAC has no
downstream verifier; live-smoke evidence is never bound to the release deploy identity; and the
hosted monitor's ≥2-consecutive-failure rollback trigger can never fire
(`scripts/hosted-monitor-runner.mjs:558`).

**3. Multi-turn and long-session realism is untested and broken in places.**
Beyond the frame-cap critical: multi-turn sessions never re-emit `QuestionStarted`, so the web
client drops every event after the first completed turn (`runner.rs:109-224`); the client has no
auto-reconnect for unclean closes; the server has no heartbeat or between-turn idle cap (a zombie
socket can lock a learner out for up to 6 h) and no write deadline on outbound frames.

**4. Public-hosting hardening gaps are consistent and enumerable.**
Spoofable left-most `X-Forwarded-For` keys the pre-auth per-IP session cap (found independently
by two reviewers); token-only public mode does zero auth at WS preflight; agent create responses
relay raw signed session tokens where the library-path stripping doesn't apply; uploads are
buffered in memory with no size cap; both runtime containers run as root; nonce rows and session
recorders grow unbounded.

**5. Privacy promises slightly outrun the code.**
Deletion of the most sensitive learner text is a tombstone, not a purge
(`agent/crates/data/src/postgres.rs:1221-1345`), which is weaker than what
`docs/data-governance.md` implies; the monitor container is provisioned with production secrets
(provider keys, session-signing secret) in modes that never use them.

## Suggested fix order

1. Stream bounded live-audio frames (prefer binary) with turn identity, backpressure, cancellation, an explicit end-of-turn, and independent per-frame/per-turn caps.
2. Replace `storage_due_at_for_status` fixture dates with the real scheduler; wire FSRS into the live path.
3. Re-emit `QuestionStarted` (or accept turn-scoped events) for multi-turn sessions.
4. Make the shell gates fail closed and make the purity gate check what it advertises.
5. Server heartbeat + write deadline + idle cap; client auto-reconnect.
6. Trust-boundary batch: XFF handling behind a trusted-proxy flag, strip tokens from create responses, body-size caps, non-root containers.
7. True purge path for learner excerpts to match data-governance wording.

## Refuted during verification

Two first-pass findings were killed by the adversarial pass and do not appear in the docs:
one mis-read of the domain crate's error taxonomy, and a claim that `structured_error` wrongly
bricks live sessions (refuted against the Rust server: every brain error is terminal server-side;
retained only as a contract-hygiene minor).
