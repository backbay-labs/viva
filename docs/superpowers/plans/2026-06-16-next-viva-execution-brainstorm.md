# Next Viva Execution Brainstorm

Date: 2026-06-16
Status: planning document
Confidence: high on repo-derived ordering; moderate on live provider details because official Cartesia/Gemini docs must be rechecked before any live smoke.

## Context

This brainstorm follows the completed trust/release-floor slice. The repo now has a no-secret synthetic Rust agent, WebSocket trust boundaries, shared Rust/TS protocol fixtures, fake Cartesia/Gemini adapter lifecycle tests, honest upload previews, and default validation that does not require provider keys, network, mic hardware, Postgres, or live provider selection.

Parallel review inputs:

- Rust/runtime: force the fake Cartesia/Gemini runtime through the real `/ws` service boundary before considering live provider work.
- Web/product: prevent pending uploads and local demo state from masquerading as trusted connected-agent sessions; extract connected session states.
- Data/release: prove optional Postgres durability separately from default validation, harden migration/usage/evidence gates, and keep generated artifacts out of release surfaces.

The strongest conclusion is blunt: do not go live next. The next work should prove provider-shaped behavior through the real product and service path while preserving the no-secret default.

## Recommended Execution Order

### Slice 1: Fake Cartesia/Gemini Through Real WebSocket

Goal: make the no-network fake provider run through the same service/browser boundary as the future live provider.

1. Add a selectable `fake_cartesia_gemini` provider mode
- Why now: adapter tests prove Ink -> Gemini -> Sonic behavior below the service boundary, but `/ws` only runs `SyntheticBrain`.
- Key files: `agent/crates/agent-service/src/config.rs`, `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`, `agent/crates/agent-service/tests/voice_ws.rs`, `agent/README.md`, `agent/.env.example`.
- Acceptance: `VIVA_AGENT_PROVIDER=fake_cartesia_gemini` uses no keys/network, reports selectable true/live false, opens via `/ws`, and default remains `synthetic`. Live `cartesia_gemini` remains rejected.
- Stop if: live keys/network become required, default validation changes, or live `cartesia_gemini` becomes selectable.

2. Create fake-provider WebSocket evidence fixtures
- Why now: synthetic replay is contract-tested end to end; fake provider is still adapter-only.
- Key files: `agent/fixtures/voice-protocol/*`, `agent/crates/agent-service/tests/voice_ws.rs`, `packages/core/src/agent-contract.test.ts`, `agent/crates/observe/src/lib.rs`.
- Acceptance: Rust and TS parse the same fake-provider replay: client frames, server product frames, usage, store snapshot, evidence events, and terminal reason. Evidence excludes raw audio, transcript text, answer text, secrets, prompts, and unrestricted source text.
- Stop if: fake-provider tests pass only below WebSocket, fixtures can drift manually, or sensitive payloads enter evidence.

3. Make the server tool executor the single mutation path
- Why now: `VivaToolExecutor` validates tool/session/source boundaries, while synthetic still writes directly in its scripted flow.
- Key files: `agent/crates/agent-adapters/src/synthetic.rs`, `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`, `agent/crates/agent-domain/src/tool_executor.rs`, `agent/crates/data/src/memory.rs`.
- Acceptance: synthetic and fake Cartesia/Gemini both use the executor for question selection, evaluation, source retrieval, concept status, review scheduling, correction challenge, and recap. Store counts stay exact.
- Stop if: browser `tool_result` is trusted, duplicate writes appear, or source-backed correction bypasses deterministic source retrieval.

4. Replace fallback `BrainEvent` mapping with explicit product bridge
- Why now: protocol mapping still contains legacy transcript and unsupported-event fallbacks that are brittle for provider-shaped events.
- Key files: `agent/crates/agent-service/src/protocol.rs`, `agent/crates/agent-domain/src/brain.rs`, `packages/core/src/agent-contract.ts`, `apps/web/lib/viva-agent-client.ts`.
- Acceptance: browser happy paths receive only explicit Viva product events; usage/tool proposals stay internal; transcript partial vs final semantics are explicit and fixture-tested.
- Stop if: React sees provider internals, usage becomes a browser event, or fake runtime can emit unsupported browser events.

### Slice 2: Connected Product State And Upload Trust

Goal: make the web product honest about what is connected, pending, local-demo, or unavailable.

1. Gate connected sessions behind real study-set readiness
- Why now: user-created previews can still produce arbitrary study-set slugs while the agent trusts only configured fixture identity.
- Key files: `apps/web/components/viva/VivaApp.tsx`, `packages/core/src/index.ts`, `apps/web/lib/use-viva-agent-session.ts`.
- Acceptance: pending uploads cannot start a trusted connected-agent session unless explicitly mapped to a trusted server fixture; preview remains pending ingestion and never fabricates concepts/pages/sources.
- Stop if: browser-uploaded text/source metadata reaches trusted agent context or seeded demo Biology appears as user-uploaded content.

2. Extract connected session state machine
- Why now: local phase and agent phase still mix enough to create dead-end states around retry, stop, and another drill.
- Key files: `VivaApp.tsx`, `viva-agent-client.ts`, `use-viva-agent-session.ts`.
- Acceptance: explicit states for waiting prompt, answering, waiting feedback, correction, stopping, recap, and ended-without-recap; no mock recap/evaluation in connected mode; another drill reconnects or is honestly unavailable.
- Stop if: `evaluateAnswer` or `buildSessionRecap` can surface as connected-agent success.

3. Make correction/source/challenge actions real or hidden
- Why now: challenge, mark shaky, schedule, show source, and retry are product-defining, but some remain inert/local-only.
- Key files: `VivaApp.tsx`, `packages/core/src/agent-contract.ts`, `apps/web/lib/viva-display.ts`.
- Acceptance: source details preserve `source_id`, `document_id`, `span`, `retrieval_reason`, and `confidence`; retry returns to a valid answer state; server-backed actions have pending/success/error states or are hidden.
- Stop if: browser mutates concept status, recap, or source truth locally in connected mode.

4. Tighten mic/dictation honesty
- Why now: the product is voice-first, but current browser behavior is Web Speech dictation to text, not raw PCM capture into live provider audio.
- Key files: `VivaApp.tsx`, `viva-agent-client.ts`, `VivaApp.test.tsx`.
- Acceptance: copy says browser dictation/text fallback; denied/unsupported/insecure states remain first-class; connected mode sends final text only; no speech synthesis during connected sessions; tests require no real mic.
- Stop if: UI implies live provider STT/TTS, raw audio persistence, keys, network, or hardware.

### Slice 3: Optional Durable Store Proof

Goal: prove Postgres only as an opt-in durability lane, never a default validation dependency.

1. Seeded Postgres synthetic replay
- Why now: migrations apply, but a fresh durable store is not release-proven with seeded study data and canonical source rows.
- Key files: `agent/crates/data/src/postgres.rs`, `agent/crates/data/src/migrations.rs`, `agent/crates/agent-service/tests/*`, `agent/migrations/*.sql`.
- Acceptance: with `DATABASE_URL`, migrations run, fixture data seeds, synthetic replay writes `1/1/1/1/1`, `/ready` reports durable, canonical sources resolve, and `voice_usage_events` rows exist. Default validation skips DB.
- Stop if: default validation needs Postgres, seed stores raw docs/audio/transcripts/answers, or browser identity/source tuples become trusted.

2. Postgres parity and negative write matrix
- Why now: memory store has stronger forgery/source tests than durable store proof.
- Acceptance: Postgres rejects wrong user, wrong study set, bad session, inactive question, unknown concept, tombstoned document/span, forged source tuple, forged recap source, and session ownership changes with zero partial writes.
- Stop if: failed mutations leave rows, logical IDs bypass ownership checks, or Postgres diverges from memory without an explicit reason.

3. Migration drift and raw-payload gates
- Why now: migrations are represented both as static includes and `sqlx::migrate!`; unsafe schema changes should fail fast.
- Acceptance: tests assert migration file order/list matches includes, excerpt bounds remain enforced, and new migrations cannot silently add raw audio, transcript, document, prompt, or unrestricted answer/source payload columns.
- Stop if: released migrations are rewritten, destructive migrations are unlabeled, or unbounded user/source text lands in schema.

### Slice 4: Release And Hygiene Hardening

Goal: make validation and release evidence explicit without hiding important optional proof.

1. Promote usage/evidence into release artifacts
- Acceptance: release evidence includes sanitized usage counts, latency, token counts, cost estimate, and grounding counts; browser suppression of usage events is tested; usage persistence failure is not silently successful.
- Stop if: metrics become a side channel for user content or cost estimates are presented as billing-grade truth.

2. Split CI into default no-secret and opt-in durable gates
- Acceptance: default CI runs `bun run validate` with no keys/network/mic/Postgres; opt-in `workflow_dispatch` provisions Postgres and runs only durability/parity/replay tests.
- Stop if: provider keys, live network, Postgres, or bearer tokens enter default validation or Turbo global env.

3. Add generated-artifact hygiene validation
- Acceptance: release hygiene checks ignored generated dirs and excludes `.next`, `out`, `.turbo`, `node_modules`, `coverage`, and `agent/target` from source scans. The gate reports; it does not destructively clean.
- Stop if: generated artifacts can enter release diff or cause false source-policy failures.

## Best Next Goal Prompt

Execute Slice 1: Fake Cartesia/Gemini Through Real WebSocket for `/Users/connor/Medica/backbay/viva`. Re-derive state first with `git status --short --ignored`; preserve unrelated/generated files. Add a no-key/no-network `fake_cartesia_gemini` provider mode that is selectable and live_runtime=false, while keeping default `synthetic` and keeping live `cartesia_gemini` rejected. Route fake Ink -> Gemini function/tool -> Sonic behavior through the real `/ws` service boundary, create Rust/TS fixture/evidence contracts for that replay, and make provider-shaped events map only to explicit Viva product events. Keep server-side `VivaToolExecutor` as the single mutation path where practical. Verify with `bun run validate`, direct `cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws` when loopback is available, `cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini`, fixture-focused Bun tests, `scripts/check-agent-domain-purity.sh`, and subagent P0/P1/P2 review. Stop if live keys/network/Postgres/mic hardware enter default gates, live `cartesia_gemini` becomes selectable, browser identity/source/tool output becomes trusted, raw payloads enter evidence/persistence, provider internals leak into React, or generated artifacts enter the release diff.
