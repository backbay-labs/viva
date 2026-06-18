# Next Viva Execution Brainstorm

Date: 2026-06-15

Confidence: high on current repo state and task ordering; moderate on live provider details because those must be rechecked against official Cartesia and Gemini docs before any live smoke.

## Context

This brainstorm follows the completed synthetic E2E voice-agent slice. The current repo has a Rust agent workspace, a synthetic provider, WebSocket lifecycle/evidence tests, Cartesia/Gemini request/parser/fake-provider surfaces, a Next web app with a thin agent hook, and no default dependency on provider keys, network, or Postgres.

The team conclusion is blunt: do not move directly to live Cartesia/Gemini next. The next execution work should make the existing synthetic spine release-grade, server-trusted, and provider-shaped before `cartesia_gemini` becomes selectable.

Parallel agent inputs:
- Rust/runtime: harden server-owned identity, server-side tool execution, fake Cartesia/Gemini pipeline, event bridging, cancellation, and usage accounting.
- Product/frontend: make connected agent state authoritative, clean up session controls, expose source/correction trust, make upload honest, and keep audio opt-in explicit.
- Data/source integrity: fail closed on missing or forged identity, define canonical document/span/source IDs, add durable store only after trust boundaries, and reject malformed evaluations.
- QA/release: add CI/release gates, make the synthetic evidence pack a contract, expand WS/source negative tests, align docs/env modes, and keep Postgres/live smoke optional.

## Recommended Execution Order

### Slice 1: Trust And Release Floor

Goal: make the current synthetic agent safe to ship as a no-secret release surface.

1. Server-owned session identity
- Why now: `source_context` is stripped, but `user_id`, `study_set_id`, and fixture defaults can still become trusted if durable writes arrive too early.
- Key files: `agent/crates/agent-service/src/ws.rs`, `agent/crates/agent-service/src/config.rs`, `agent/crates/data/src/memory.rs`, `agent/crates/agent-domain/src/brain.rs`.
- Acceptance: WebSocket rejects or overwrites forged identity; missing `session_id`, `user_id`, or `study_set_id` cannot write outside explicit fixture tests; study-set access is checked before brain open; browser `source_context` remains stripped on initial config and refresh.
- Stop if: browser-controlled identity reaches source lookup or any durable path infers identity from default fixture IDs.

2. CI and no-secret release gates
- Why now: root scripts already define the intended validation gate, but release automation is not established.
- Key files: `package.json`, `.gitignore`, `agent/README.md`, future `.github/workflows/*`.
- Acceptance: CI runs `bun run validate`, including Rust fmt/clippy/test/build and `scripts/check-agent-domain-purity.sh`; no keys, network, or Postgres are required; generated artifacts stay ignored.
- Stop if: `agent/target`, `.next`, `.turbo`, env files, provider keys, network calls, or DB requirements enter the default gate.

3. Evidence pack as release contract
- Why now: the synthetic evidence pack exists; drift should fail both Rust and TypeScript tests.
- Key files: `agent/fixtures/voice-protocol/*`, `agent/crates/agent-service/tests/voice_ws.rs`, `packages/core/src/agent-contract.test.ts`.
- Acceptance: TS and Rust parse the same fixtures; real WS replay matches client frames, server frames, store snapshot, evidence events, and terminal reason exactly; evidence excludes raw audio, transcript text, answer text, secrets, and source excerpts.
- Stop if: fixture changes can be made manually without corresponding contract tests.

4. Connected UI fail-closed behavior
- Why now: connected sessions render agent data, but local mock fallback still risks looking authoritative.
- Key files: `apps/web/components/viva/VivaApp.tsx`, `apps/web/lib/use-viva-agent-session.ts`, `apps/web/lib/viva-agent-client.ts`.
- Acceptance: connected mode never treats `evaluateAnswer` or `buildSessionRecap` as authoritative; missing `recap_ready` becomes visible protocol/error state; stale/cancelled events do not show old output; provider internals do not leak into React.
- Stop if: a local mock answer or recap appears as a successful connected-agent result.

### Slice 2: Server Tooling And Source Integrity

Goal: make study actions server-owned and deterministic before provider-shaped runtime work.

1. Server-side Viva tool executor
- Why now: tool declarations exist, but browser `tool_result` must not become trusted authority.
- Key files: `agent/crates/agent-domain/src/tools.rs`, `agent/crates/agent-domain/src/ports.rs`, `agent/crates/data/src/memory.rs`, `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`.
- Acceptance: executor handles `select_next_question`, `evaluate_spoken_answer`, `retrieve_source_reference`, `mark_concept_status`, `build_session_recap`, `challenge_correction`, and `schedule_review_item`; arguments are validated; tool results come from `StudyMemoryStore`; tool proposals/results are not browser-authoritative events.
- Stop if: client `tool_result` is trusted or source-backed corrections bypass deterministic retrieval.

2. Source-integrity matrix for all mutating tools
- Why now: answer eval and recap have guardrails, but concept status, review scheduling, and correction challenge need the same checks.
- Key files: `agent/crates/data/src/memory.rs`, `agent/crates/agent-service/src/ws.rs`, `agent/crates/agent-domain/src/tools.rs`.
- Acceptance: wrong user, wrong study set, tombstoned document/span, forged recap source, forged challenge source, unknown concept, bad session, and browser `source_context` all fail without writes.
- Stop if: browser can alter excerpt, span, confidence, retrieval reason, or persisted source tuple.

3. Typed fail-closed answer evaluation
- Why now: labels and confidence need stricter domain validation before Gemini drives them.
- Key files: `agent/crates/agent-domain/src/study.rs`, `packages/core/src/agent-contract.ts`, `agent/crates/agent-adapters/src/synthetic.rs`, `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`.
- Acceptance: evaluation requires active `question_id`, canonical source, bounded confidence `0..1`, typed rubric label, and valid concept status; empty/wrong answers cannot be stored as strong; malformed tool output emits structured errors with no partial writes.
- Stop if: invalid evaluation can update memory or appear source-grounded.

4. Source and correction trust UI
- Why now: source-grounded correction is the product trust moment.
- Key files: `apps/web/components/viva/VivaApp.tsx`, `apps/web/lib/use-viva-agent-session.ts`, `packages/core/src/agent-contract.ts`.
- Acceptance: source chip is human-readable; correction view shows excerpt, confidence, retrieval reason, and low-confidence state; challenge action is either real with pending/result/error states or deliberately hidden; source tuple fields are preserved end to end.
- Stop if: low-confidence output sounds certain or any tuple field is dropped.

### Slice 3: Provider-Shaped Runtime Without Live Selection

Goal: prove the Cartesia/Gemini cascade through fake services before accepting live credentials.

1. Fake Cartesia/Gemini runtime pipeline
- Why now: parsers and request builders exist, but there is no provider-shaped runtime bridge yet.
- Key files: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`, `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`, `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`, `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`.
- Acceptance: no-network fake runtime proves PCM/audio input -> Ink transcript -> Gemini SSE text/function/usage -> server tool executor -> Sonic audio -> product `BrainEvent`s.
- Stop if: `VIVA_AGENT_PROVIDER=cartesia_gemini` becomes accepted, live network/keys enter default tests, or the live provider becomes selectable.

2. Runtime event bridge cleanup
- Why now: normal provider-shaped events should not become browser structured errors.
- Key files: `agent/crates/agent-domain/src/brain.rs`, `agent/crates/agent-service/src/protocol.rs`, `agent/crates/observe/src/lib.rs`.
- Acceptance: usage and telemetry stay internal; legacy fake response IDs disappear from happy paths; cumulative transcript, response IDs, stale audio, and cancellation semantics are explicit and fixture-tested.
- Stop if: happy-path fake runtime emits `unsupported brain event`, provider internals leak into React, or TS/Rust fixtures drift.

3. Cancellation, backpressure, and task abort tests
- Why now: live-style STT/LLM/TTS has multiple concurrent tasks and bounded streams.
- Key files: `agent/crates/agent-domain/src/brain.rs`, `agent/crates/agent-service/src/ws.rs`, `agent/crates/agent-service/tests/voice_ws.rs`.
- Acceptance: tests cover barge-in during TTS, cancel during Gemini tool call, disconnect aborting all provider tasks, writer failure releasing capacity, stale event suppression, text/binary oversize close codes, auth/origin rejection, keepalive, and terminal evidence.
- Stop if: tests rely on arbitrary sleeps or leaked tasks survive session close.

### Slice 4: Product First-Run And Optional Durability

Goal: make the product path honest and optionally durable without changing default validation.

1. Honest upload and study-set funnel
- Why now: the app still starts from demo-like seeded materials.
- Key files: `apps/web/components/viva/VivaApp.tsx`, `packages/core/src/index.ts`, `apps/web/app/globals.css`.
- Acceptance: no prefilled demo upload by default; paste/file/empty/unsupported/too-large states are visible; processing has failure recovery; preview shows docs, concept count, recommended drill, and one dominant CTA; UI does not claim real document understanding before ingestion is real.
- Stop if: browser-supplied document/source text becomes trusted agent context.

2. Browser audio opt-in
- Why now: the controller can send audio frames, but UI should not accidentally imply production audio.
- Key files: `VivaApp.tsx`, `apps/web/lib/viva-agent-client.ts`, `packages/core/src/agent-contract.ts`.
- Acceptance: explicit mic permission flow; denied/unsupported/insecure-origin states; text fallback remains first-class; no tests require real mic hardware; no raw audio persistence claim.
- Stop if: default tests need hardware, provider keys, network, or saved raw audio.

3. Gated Postgres `StudyMemoryStore`
- Why now: migrations and pool helpers exist, but runtime is intentionally in-memory.
- Key files: `agent/crates/data/src/pool.rs`, `agent/crates/data/src/migrations.rs`, `agent/migrations/*.sql`, `agent/crates/agent-service/src/config.rs`.
- Acceptance: `DATABASE_URL` selects Postgres only in explicit mode; `/ready` reports durable only when configured; default validation skips DB; schema guard still rejects raw audio, transcript text, answer text, full document text, and unrestricted source excerpts.
- Stop if: default validation requires Postgres or durable mode stores raw payloads.

4. Sanitized usage and grounding metrics
- Why now: usage/evidence types exist, but runtime persistence is not complete.
- Key files: `agent/crates/observe/src/lib.rs`, `agent/crates/agent-service/src/ws.rs`, `agent/migrations/0003_voice_telemetry.sql`.
- Acceptance: rows record provider, model, duration, latency, token counts, cost estimate, and source-grounded correction counts only; health/evidence summarize counts without sensitive payloads.
- Stop if: metrics become a side channel for raw transcript, prompt, answer, or source text.

## Verification Gates

Default gates:
- `bun run validate`
- `cargo test --manifest-path agent/Cargo.toml --workspace`
- Targeted Rust WS/evidence/source-integrity tests
- Targeted Bun tests for `agent-contract`, `viva-agent-client`, `use-viva-agent-session`, and `VivaApp`
- `scripts/check-agent-domain-purity.sh`
- `git status --short --ignored` to confirm generated artifacts remain ignored

Optional gates only after explicit configuration:
- Postgres migration apply test behind `DATABASE_URL` or an explicit DB flag.
- Live Cartesia/Gemini smoke only after fake-provider runtime, source-integrity, and no-secret gates are green, with fresh official provider-doc verification.

## Non-Negotiable Stop Rules

- Do not select `cartesia_gemini` as a runtime provider yet.
- Do not require provider keys, paid network calls, mic hardware, or Postgres for default validation.
- Do not trust browser `source_context`, browser identity, browser tool results, or browser-supplied source tuples.
- Do not log or persist raw audio, transcript text, answer text, secrets, full document text, or unrestricted source excerpts.
- Do not let connected UI use local mock evaluation/recap as successful agent output.
- Do not let a source-backed correction appear unless deterministic server source retrieval validates it.
- Do not let generated artifacts enter the release diff.

## Best Next Goal Prompt

Execute Slice 1: Trust And Release Floor for `/Users/connor/Medica/backbay/viva`. Re-derive state first with `git status --short`, preserve unrelated/generated files, and keep `synthetic` as the only selectable provider. Implement server-owned session identity or strict rejection of forged/missing `session_id`, `user_id`, and `study_set_id`; keep browser `source_context` stripped on initial config and refresh; add no-secret CI/release gate automation; promote the synthetic evidence pack to a Rust/TS release contract; and harden connected UI so missing `recap_ready` is a visible protocol state, never a mock success. Default validation must not need keys, network, mic hardware, or Postgres. Verify with `bun run validate`, targeted Rust WS/evidence tests, targeted TS client/hook/UI tests, `scripts/check-agent-domain-purity.sh`, and a generated-artifact status check. Stop if live provider selection appears, browser identity/source/tool output becomes trusted, raw payloads enter evidence or persistence, or generated artifacts enter the diff.
