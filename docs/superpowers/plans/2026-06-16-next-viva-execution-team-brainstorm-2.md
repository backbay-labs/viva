# Next Viva Execution Team Brainstorm 2

Date: 2026-06-16
Status: planning document
Confidence: high on repo-derived ordering; moderate on live Cartesia/Gemini details until official provider docs are rechecked immediately before live smoke work.

## Context

This document synthesizes five read-only planning agents launched after the latest comprehensive validation pass. Lanes covered:

- Rust realtime/backend runtime
- Web app and connected-agent UI
- Ingestion, study memory, and source-grounded learning quality
- CI, evidence, release readiness, and observability
- Security, privacy, deployment, and operational hardening

Current validated baseline:

- `fake_cartesia_gemini` is selectable, no-key, no-network, and works through the real `/ws` path.
- Live `cartesia_gemini` remains intentionally gated and should not become selectable by default.
- The browser connected flow can reach a source-backed connected recap through the fake provider.
- Pending local upload previews cannot start trusted connected-agent sessions.
- Optional Postgres durability works when explicitly configured.
- Default validation remains no-secret, no-provider-key, no-mic, no-Postgres, and no-live-network.

The consensus is blunt: the next execution should not be "turn on live Cartesia/Gemini." The product is still missing repeatable browser E2E, real browser audio I/O, production access hardening, and server-owned ingestion. Live provider enablement should remain behind a manual harness until those gates exist.

## Recommended Execution Order

### Slice 1: Make The Local Proof Repeatable

Goal: convert the successful manual/browser proof into an automated, no-secret release gate.

#### P0.1 Add Browser E2E For The Connected Fake Provider

Why: the local Playwright proof is not repeatable in CI yet. The app can regress back to blank connected states or local mock fallback without the current unit tests catching the full workflow.

Likely files:

- `package.json`
- `apps/web`
- `.github/workflows/validate.yml`
- new browser test support under `apps/web` or `scripts`

Acceptance:

- Add `bun run e2e:browser` or equivalent.
- It starts the Rust agent with `VIVA_AGENT_PROVIDER=fake_cartesia_gemini`.
- It starts the web app.
- It drives: upload preview -> pending preview gate -> library trusted set -> connected fake-provider session -> answer -> source-backed recap.
- It asserts pending preview shows `Agent unavailable`, connected recap shows agent recap text, and local-only `Share` / local schedule actions are absent in connected recap.
- It saves screenshot/trace artifacts.

Stop rule:

- Stop if the test requires real mic hardware, live provider keys, external network, Postgres, or arbitrary long sleeps.

#### P0.2 Add Explicit WebSocket Replay CI Step

Why: root Rust tests can allow loopback skip. Service-boundary replay should be a visible gate.

Likely files:

- `.github/workflows/validate.yml`
- `agent/crates/agent-service/tests/voice_ws.rs`
- `agent/README.md`

Acceptance:

- CI directly runs the real WebSocket replay tests for synthetic and fake provider.
- Bind failures are not silently reported as success in this explicit gate.
- Default `bun run validate` remains no-secret.

Stop rule:

- Stop if the step is flaky on clean Ubuntu or weakens the no-secret default.

#### P0.3 Add A Release Evidence Command

Why: validation passes, but release proof is scattered across test output, fixtures, and manual browser artifacts.

Likely files:

- `package.json`
- `scripts`
- `agent/fixtures/voice-protocol`
- `agent/crates/observe`

Acceptance:

- Add `bun run release:check` or similar.
- It composes validation, direct WebSocket replay, generated-artifact hygiene, provider gate assertions, and sanitized evidence checks.
- It produces a small evidence bundle: fixture hashes, provider readiness JSON, replay summaries, terminal reasons, usage counters, and browser E2E result.

Stop rule:

- Stop if release evidence includes raw audio, transcript text, answer text, secrets, prompts, or unrestricted source excerpts.

## Slice 2: Make The Browser Actually Voice-First

Goal: move from typed connected sessions and browser dictation toward the actual call loop, still without live provider requirements.

#### P0.4 Browser PCM Mic Streaming To Agent

Why: `sendAudio()` and audio protocol frames exist, and fake runtime accepts audio, but `VivaApp` still uses `SpeechRecognition` text dictation.

Likely files:

- `apps/web/components/viva/VivaApp.tsx`
- `apps/web/lib/viva-agent-client.ts`
- new `apps/web/lib/viva-audio-capture.ts`
- `packages/core/src/agent-contract.ts`

Acceptance:

- Browser code can capture mic audio after user gesture, convert/chunk to PCM16 24 kHz or a documented adapter format, and send audio frames through the existing controller.
- Unit tests use fake audio sources and require no real mic.
- Manual fake-provider flow can reach recap from audio input.
- No raw audio is logged or persisted.

Stop rule:

- Stop if default tests require mic hardware, provider keys, Postgres, or raw audio persistence.

#### P0.5 Agent Audio Playback Queue

Why: the reducer stores `audio_delta`, but the browser does not play assistant speech. That makes the current "voice call" mostly text UI.

Likely files:

- `apps/web/lib/viva-agent-client.ts`
- `apps/web/lib/use-viva-agent-session.ts`
- new `apps/web/lib/viva-audio-playback.ts`
- `apps/web/components/viva/VivaApp.tsx`

Acceptance:

- Unit tests decode queued PCM16 base64, order frames deterministically, and drain without blocking UI.
- Connected UI exposes speaking/responding state from received audio frames.
- Playback only starts after a user gesture.
- Cancellation clears queued audio for cancelled response IDs.

Stop rule:

- Stop if cancelled audio remains playable, autoplay fires before a gesture, or audio payloads are stored.

#### P0.6 Extract Connected Lifecycle State Machine

Why: start, retry, stop, reconnect, mode changes, and terminal close handling are spread across component state. This already produced a blank connected body once.

Likely files:

- `apps/web/components/viva/VivaApp.tsx`
- `apps/web/lib/use-viva-agent-session.ts`
- `apps/web/lib/viva-agent-client.ts`
- `apps/web/lib/viva-connected-actions.ts`

Acceptance:

- Explicit states for waiting prompt, answering, waiting feedback, correction, stopping, recap, ended-without-recap, disconnected, and reconnecting.
- FakeWebSocket tests cover close without recap, stop pending, reconnect, stale events, mode change during open, and another drill.
- Connected mode never treats `evaluateAnswer()` or `buildSessionRecap()` as connected success.

Stop rule:

- Stop if local demo state can masquerade as a connected-agent result.

## Slice 3: Build The Live-Shaped Runtime Without Enabling Live Provider

Goal: make the live runner real behind fake transports, so provider behavior is tested before keys/network enter the loop.

#### P0.7 Live Session Runner Behind Fake Transports

Why: fake provider proves provider-shaped behavior, but live `CartesiaGeminiBrain::open` is still intentionally gated. The next backend step is the runner, not selectable live runtime.

Likely files:

- `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`
- `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`
- `agent/crates/agent-domain/src/brain.rs`

Acceptance:

- No-network fake Ink/Gemini/Sonic transports drive one full session through the same runner intended for live.
- Tests cover STT turn finalization, Gemini text/tool stream, Sonic audio stream, cancellation, and writer failure.
- `cartesia_gemini` remains rejected unless a later explicit live gate is designed.

Stop rule:

- Stop if tests require provider keys/network or if live `cartesia_gemini` becomes selectable by default.

#### P0.8 Gemini Tool-Call Loop Through Server Executor

Why: live Gemini needs function-call -> execute -> function-response continuation. Server-side `VivaToolExecutor` must remain the only mutation path.

Likely files:

- `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- `agent/crates/agent-domain/src/tool_executor.rs`
- `agent/crates/data/src/memory.rs`
- `agent/crates/data/src/postgres.rs`

Acceptance:

- Fake Gemini SSE function calls execute server tools and return Gemini function responses.
- Unknown, unbound, or forged tool calls fail without writes.
- Browser `tool_result` remains rejected as untrusted.

Stop rule:

- Stop on any partial write after failed or forged tool execution.

#### P0.9 Cancellation And Barge-In Across Provider Stages

Why: the fake runtime covers pieces of cancellation, but live-shaped runner needs stage-wide behavior across Ink, Gemini, Sonic, and the WebSocket writer.

Likely files:

- `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`
- `agent/crates/agent-service/src/ws.rs`
- `agent/crates/agent-domain/src/brain.rs`

Acceptance:

- Tests prove cancel during Gemini stream, barge-in during Sonic audio, disconnect abort, stale-event suppression, and capacity release.
- Old audio, evaluation, source, and recap events do not reach the browser after cancellation.

Stop rule:

- Stop if stale provider events can update React after cancel/barge-in.

## Slice 4: Add Server-Owned Ingestion, Starting With Paste

Goal: stop relying on the hard-coded Biology fixture as the only trusted connected study set.

#### P0.10 Server-Owned Ingestion Lifecycle

Why: upload is still a local preview shell. Connected sessions trust only seeded fixture IDs.

Likely files:

- `agent/migrations`
- `agent/crates/data/src/memory.rs`
- `agent/crates/data/src/postgres.rs`
- `agent/crates/data/src/migrations.rs`
- `agent/crates/agent-service/src/app.rs`
- `packages/core/src/index.ts`
- `apps/web/components/viva/VivaApp.tsx`

Acceptance:

- A new server-owned study set has server ID, documents, and status `pending | processing | ready | failed`.
- Connected agent remains blocked until the study set is `ready`.
- UI shows queued/processing/failed/retry honestly.

Stop rule:

- Stop if browser pasted text, file metadata, identity, or source tuples become trusted agent authority.

#### P0.11 Paste-Text Ingestion Before PDF

Why: paste-only notes are the fastest real ingestion path and avoid PDF parsing ambiguity while contracts are still settling.

Likely files:

- new agent-service route
- `agent/crates/data/src/*`
- `packages/core/src/index.ts`
- `apps/web/components/viva/VivaApp.tsx`
- `apps/web/lib/use-viva-agent-session.ts`

Acceptance:

- A service test creates a study set from pasted notes.
- It writes document metadata, bounded source spans, concepts, and generated questions.
- UI sees `ready` and can start a connected fake-provider session for the new set.
- Browser sends no trusted source context.

Stop rule:

- Stop if hard-coded Biology fixture is still required for the newly ingested connected session.

#### P1.1 Bounded Source-Span Extraction

Why: source-grounded corrections depend on canonical `source_id`, `document_id`, `span`, excerpt, confidence, and retrieval reason.

Acceptance:

- Every generated concept and question cites a canonical bounded source span.
- Forged span/document/excerpt attempts are rejected.
- Migration/privacy gates still reject raw document, transcript, answer, audio, and unbounded source storage.

Stop rule:

- Stop if full pasted notes or full document text are persisted as agent memory.

#### P1.2 Question Bank Generation And Selection

Why: `select_next_question` must come from generated question rows, not `fixture_question()`.

Acceptance:

- Two-study-set tests prove question selection comes from active generated questions for the authorized study set.
- Wrong-set or inactive questions fail without writes.
- Fake provider asks a question generated from the ingested source.

Stop rule:

- Stop if oxidative-phosphorylation fixture behavior leaks into non-fixture study sets.

## Slice 5: Fail Closed Before Any Public Exposure

Goal: preserve local ease while preventing an unauthenticated public agent from starting.

#### P0.12 Production-Fail-Closed WebSocket Access

Why: `VoiceWsAccess::default()` is local-friendly. Public/non-loopback binds must not start without bearer auth and exact allowed origins.

Likely files:

- `agent/crates/agent-service/src/config.rs`
- `agent/crates/agent-service/src/ws.rs`
- `agent/.env.example`
- `.env.example`

Acceptance:

- Localhost remains easy.
- Production or non-loopback bind refuses boot unless auth and allowed origins are configured.
- Tests prove public bind cannot start unauthenticated.

Stop rule:

- Stop if a public bind can start with no bearer/origin protection.

#### P0.13 Signed Session Capability Tokens

Why: identity is still based on env/default fixture tuples and client-side public values. That is acceptable for local fixture proof, not for real users.

Likely files:

- `agent/crates/agent-service/src/ws.rs`
- `agent/crates/agent-service/src/app.rs`
- `apps/web/lib/use-viva-agent-session.ts`
- `apps/web/lib/viva-agent-client.ts`

Acceptance:

- Token claims bind `user_id`, `study_set_id`, `session_id`, expiry, and nonce.
- Forged config, expired token, wrong session, and wrong study set fail before brain open.
- `NEXT_PUBLIC_*` identity is no longer authoritative for connected sessions.

Stop rule:

- Stop if browser-controlled IDs can authorize a voice session.

#### P0.14 Real Readiness And Terminal State

Why: `/ready` should distinguish dependency failure from authorization/access denial, and durable sessions should not remain open forever after disconnects/timeouts.

Likely files:

- `agent/crates/agent-service/src/app.rs`
- `agent/crates/agent-service/src/ws.rs`
- `agent/crates/data/src/postgres.rs`
- `agent/migrations/0001_init.sql`

Acceptance:

- `/ready` probes Postgres when configured.
- DB outage returns dependency status, not access denial.
- client stop, idle timeout, disconnect, send failure, and brain open failure set durable session `ended_at` and terminal reason.

Stop rule:

- Stop if dependency failure is indistinguishable from user auth failure or opened sessions can remain permanently `open`.

## P1 Follow-Ups

1. Durable fake-provider Postgres parity
- Prove fake replay writes session, answer, concept status, review item, recap, and usage with `DATABASE_URL`.
- Keep default validation Postgres-free.

2. Sanitized evidence and privacy payload audit gate
- Extend evidence checks beyond migrations into logs, fixtures, usage, and release packs.
- Reject raw audio, transcripts, answer text, prompt text, secrets, and unbounded source text.

3. Voice-first UI pass
- Replace static timer and textarea-first connected layout with orb/mic-first call controls plus secondary typed fallback.
- Keep the UI narrow and study-call centered.

4. Sessions history and library persistence model
- Completing local or connected recap should create sanitized session history.
- Do not store raw transcript, answer text, source excerpts, or audio.

5. Review scheduler rules
- Compute due dates server-side from concept status, misses, hints, exam proximity, and concept centrality.
- Do not accept model/browser-provided due dates as authority.

6. Graceful shutdown and deploy draining
- SIGTERM should flip readiness false, reject new sessions, stop active sessions, release capacity, and close within a grace period.

7. Rate limits, quotas, and budget cutoffs
- Add per-user/IP session caps, bytes/minute, max turn duration, and estimated cost budget.
- Do not rate-limit the default synthetic/fake replay.

8. Deployment topology and runbook
- Document one blessed topology with `https/wss`, managed Postgres, secret injection, health checks, smoke commands, and rollback.

## P2 Later Work

1. PDF extraction pipeline
- Build only after paste ingestion proves the server-owned source/concept/question contract.

2. Learning-quality eval harness
- Golden fixtures for source recall, conflicts, low-confidence corrections, professor-specific discrepancies, and unsupported feedback.

3. Usage/cost accuracy from real provider metadata
- Parse real provider usage where available, but label costs as estimates.

4. Full account/RBAC integration
- Needed eventually, but not before signed voice capability tokens and fail-closed access.

5. Data retention and purge lifecycle
- Add TTLs, tombstone hard-delete after grace, and dry-run purge.

## Premature Or Rejected Work

- Making live `cartesia_gemini` selectable or default now.
- Requiring live provider keys, network, mic hardware, Postgres, or auth for default validation.
- Persisting raw audio, raw transcripts, answer text, full prompts, full documents, or unbounded source excerpts.
- Browser-originated `source_context`, source tuple, identity, or tool result as trusted authority.
- Full PDF/OCR/diagram ingestion before paste ingestion and source-span contracts.
- Google Drive, Canvas, Notion, payments, RBAC, SOC2, Kubernetes, or institutional admin work.
- Switching to Gemini native audio/live multimodal before the current Cartesia Ink -> Gemini text/tool -> Cartesia Sonic cascade is proven.
- Broad dashboard or analytics expansion. The MVP center is still the best 10-minute study call.

## Best Next Execution Prompt

Execute the next Viva slice in `/Users/connor/Medica/backbay/viva`: make the local connected fake-provider proof repeatable and voice-first without weakening the no-secret default. Start by re-deriving state with `git status --short --ignored` and preserve unrelated/generated files. Add a browser E2E gate that starts the Rust agent with `VIVA_AGENT_PROVIDER=fake_cartesia_gemini`, starts the Next app, proves pending local previews cannot connect, then drives trusted connected session -> answer -> source-backed recap with local-only actions hidden. In parallel, add the first browser audio layer: fakeable PCM mic capture into `sendAudio()` and an assistant PCM playback queue that is user-gesture gated, ordered, cancellable, and never persisted. Harden connected lifecycle tests around stop, close without recap, reconnect, stale events, and mode changes. Verify with forced TS tasks, Rust validation, direct WebSocket replay, generated-artifact hygiene, and the new browser E2E. Stop if live keys/network/Postgres/mic hardware become default requirements, live `cartesia_gemini` becomes selectable, browser identity/source/tool output becomes trusted, raw payloads enter persistence/evidence, or local demo output can masquerade as connected success.
