# Port Luca's Rust Cartesia/Gemini Voice Agent To Viva

Date: 2026-06-15
Status: planning only
Confidence: high on repo/source inventory, high on port shape, moderate on provider model defaults until live provider docs are rechecked during implementation.

## Objective

Copy the Rust realtime voice-agent spine from Luca into Viva and adapt it for Viva's voice-first study companion product.

Success means Viva gets a Rust agent lane that can eventually run this flow:

1. Browser captures microphone audio as PCM16.
2. Browser connects to a Rust `/ws` endpoint.
3. Rust streams audio to Cartesia Ink STT.
4. Rust sends final or eager user turns into Gemini `streamGenerateContent` with Viva study tools.
5. Rust streams Gemini text deltas into Cartesia Sonic TTS.
6. Rust sends PCM16 assistant audio, transcripts, source/correction events, and recap events back to the browser.
7. Viva preserves source-grounded study semantics rather than inheriting Luca's cooking/allergen domain.

No implementation was done in this planning pass.

## Source Truth

Inspected Viva:

- `package.json`
- `turbo.json`
- `README.md`
- `docs/REQUIREMENTS.md`
- `apps/web/components/viva/VivaApp.tsx`
- `packages/core/src/index.ts`
- `apps/web/lib/viva-flow.test.ts`

Inspected Luca:

- `../luca/agent/README.md`
- `../luca/agent/Cargo.toml`
- `../luca/agent/.env.example`
- `../luca/agent/crates/agent-adapters/src/cartesia_gemini/*`
- `../luca/agent/crates/agent-domain/src/*`
- `../luca/agent/crates/agent-service/src/*`
- `../luca/agent/crates/data/src/*`
- `../luca/agent/crates/observe/src/*`
- `../luca/agent/migrations/*`
- `../luca/research/DECISIONS.md`

Important correction: one subagent inspected a stale sibling path and reported that Rust Cartesia/Gemini was absent. The live source at `../luca/agent` does contain `crates/agent-adapters/src/cartesia_gemini/*`, and `../luca/agent/README.md` describes `CartesiaGemini` as the default realtime brain. Treat `../luca/agent` as source of truth.

## Team Findings

### Agent 1: Luca Source Inventory

Finding: copy the realtime voice spine, not the cooking product. Luca's reusable asset is its Rust workspace shape, Cartesia/Gemini adapter, domain realtime contracts, service startup, WebSocket auth/transport, cancellation handling, and metering.

Do not copy Luca's tools, KB, cooking session state, allergen safety logic, `/me` memory semantics, or Voice Lab plumbing as Viva defaults.

### Agent 2: Viva Integration Shape

Finding: put Rust at `agent/` as a sibling subsystem, not in `apps/*` or `packages/*`, and do not add it to Bun workspaces. Use Cargo as the Rust source of truth and root package scripts as convenience wrappers.

Viva currently has a small Bun/Turbo/Next shape with mocked study-set, evaluation, recap, and browser Web Speech behavior. There is no Rust workspace, no Postgres lane, no auth layer, and no real speech/model pipeline yet.

### Agent 3: Security, Ops, Verification

Finding: keep Luca's security and test discipline, then rename and re-scope it. The port must preserve bearer-token WebSocket auth, origin allowlists, session caps, no-secret tests, opt-in provider smoke tests, and domain-purity guards that prevent Luca cooking residue from leaking into Viva.

### Local Contract Pass

Finding: the active provider stack is not "Gemini Live native audio." The source named `CartesiaGemini` is a cascade:

- Cartesia Ink STT receives browser PCM16 24 kHz mic frames.
- Gemini receives text turns and streams model text/tool calls.
- Cartesia Sonic streams PCM16 24 kHz TTS audio back.

That pipeline is acceptable for Viva because oral recall needs tool reliability, source-grounded correction, and replayable study events more than native emotional prosody on day one.

## Executive Decision

Build a Viva Rust agent workspace by porting Luca's voice spine in this order:

1. Scaffold `agent/` with the same Cargo workspace discipline.
2. Port the generic realtime/domain contracts.
3. Port `cartesia_gemini` adapter as a unit with tests.
4. Port the Axum service and browser WebSocket transport.
5. Replace all Luca product semantics with Viva study semantics.
6. Add browser client integration behind the existing Viva session UI.
7. Add no-secret CI gates and opt-in live provider smoke tests.

The wrong implementation would copy the whole Luca agent tree and then "clean it up later." That would import allergen, recipe, pantry, cook-session, Voice Lab, and acoustic-spike assumptions into a study product. The first port PR should be smaller and stricter: make the generic voice loop compile, then add Viva tools.

## Current Viva Baseline

Viva today is:

- Bun workspaces for `apps/*` and `packages/*`.
- Turbo tasks for `dev`, `build`, `lint`, `typecheck`, and `test`.
- Next web app at `apps/web`.
- Local product state in `VivaApp.tsx`.
- `@viva/core` mock study-set generation, answer evaluation, and recap generation.
- Browser dictation through `SpeechRecognition` and playback through `speechSynthesis`.
- No backend API layer for documents/auth/model calls.
- No Rust workspace.
- No Postgres migrations.
- No real speech service integration.

The voice-agent port must therefore be additive. Do not make the existing UI wait on a production auth/doc-ingestion backend before the Rust spine can land.

## Luca Components To Copy Or Adapt

### Copy Mostly Verbatim

These are the high-value reusable pieces.

Rust workspace:

- `../luca/agent/Cargo.toml`
- `../luca/agent/Cargo.lock`
- workspace dependency/lint style
- Rust version constraint: `rust-version = "1.85"`

Cartesia/Gemini adapter:

- `crates/agent-adapters/src/cartesia_gemini/mod.rs`
- `cartesia_gemini/constants.rs`
- `cartesia_gemini/connect.rs`
- `cartesia_gemini/stt.rs`
- `cartesia_gemini/tts.rs`
- `cartesia_gemini/ink_runtime.rs`
- `cartesia_gemini/sonic_runtime.rs`
- `cartesia_gemini/input_forwarder.rs`
- `cartesia_gemini/runtime_types.rs`
- `cartesia_gemini/cancellation.rs`
- `cartesia_gemini/pipeline.rs`
- `cartesia_gemini/tests.rs`
- `crates/agent-adapters/tests/cartesia_gemini.rs`

Domain contracts:

- `crates/agent-domain/src/lib.rs` for `AudioFrame`
- `crates/agent-domain/src/brain.rs` for `RealtimeBrain`, `RealtimeSession`, `BrainInput`, `BrainEvent`, and `BrainUsage`
- `crates/agent-domain/src/ids.rs`
- generic parts of `crates/agent-domain/src/tools.rs`
- generic parts of `crates/agent-domain/src/ports.rs`

Service and WebSocket mechanics:

- `crates/agent-service/src/main.rs`
- `crates/agent-service/src/server.rs`
- generic parts of `crates/agent-service/src/config.rs`
- `crates/agent-service/src/app.rs`
- `crates/agent-service/src/routes/voice_ws.rs`
- `crates/agent-service/src/routes/health.rs`
- `crates/agent-service/src/ws/inbound.rs`
- `crates/agent-service/src/ws/outbound.rs`
- `crates/agent-service/src/ws/inflight.rs`
- generic parts of `crates/agent-service/src/ws/brain_bridge.rs`
- WebSocket lifecycle tests under `crates/agent-service/tests/app/voice_ws.rs`

Data/observability patterns:

- `crates/data/src/pool.rs`
- `crates/data/src/migrations.rs` shape only
- `crates/observe/src/meter.rs` shape
- `crates/observe/tests/meter.rs`

### Adapt Aggressively

These are useful patterns but contain Luca product assumptions.

- `cartesia_gemini/llm.rs`: keep Gemini SSE, retry, conversation history, function-call parsing, and tool-result handling. Replace `luca_prompt` and cooking/allergen system guidance with Viva study guidance.
- `agent-service/src/realtime.rs`: keep provider selection, `NoopRealtimeBrain`, and transcript cumulative/incremental semantics. Replace `luca_realtime_tools()` with Viva study tools.
- `agent-service/src/config.rs`: keep auth, origin checks, session limits, strict realtime fallback, and composition-root style. Rename env vars and replace default tools, default user, memory, and sessions.
- `agent-service/src/ws/mod.rs`: keep session loop, idle timeout, writer task, brain event routing, and cleanup. Replace cooking-session restore, Voice Lab capture, timer nudges, and tool session context.
- `agent-service/src/ws/brain_bridge.rs`: keep response-id gating, stale-event suppression, cancellation tombstones, audio delta handling, transcript handling, and tool result round trip. Replace panel updates, safety confirmations, cooking session updates, and Voice Lab capture.
- `agent-service/src/web/cook_client.html`: useful as a local browser smoke-test pattern. Rename and reduce to a Viva voice client.
- `migrations/*.sql`: rewrite for Viva schema. Preserve the principle: agent-owned state may reference source/study IDs, but it should not become the authoritative source for uploaded document content.

### Exclude By Default

Do not copy these into Viva unless a later decision explicitly says so.

- `crates/kb/*`: Luca recipe/allergen KB reader.
- `crates/tools/src/tier1/kb.rs`
- `crates/tools/src/tier2/safety.rs`
- `crates/tools/src/tier2/confirm.rs`
- `crates/session/src/state.rs`: cooking session state machine.
- `crates/memory/src/me_client.rs`: Luca `/me` food-profile memory.
- `agent-adapters/src/luca_prompt.rs`: Chef/cooking prompt copy.
- Acoustic spike routes/tools unless Viva explicitly wants phone/laptop AEC evidence in the same form.
- Vision tools unless Viva later adds camera/document image capture during voice sessions.

## Proposed Viva Rust Workspace

Add this sibling workspace:

```text
agent/
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  .env.example
  README.md
  migrations/
    0001_init.sql
    0002_session_indexes.sql
    0003_voice_telemetry.sql
  crates/
    agent-domain/
    agent-adapters/
    agent-service/
    data/
    observe/
    study-session/
    study-tools/
```

Rationale:

- Keeps Cargo as the Rust source of truth.
- Avoids forcing Rust packages into Bun workspaces.
- Mirrors Luca closely enough that future diffs are understandable.
- Keeps the first port mechanical before Viva-specific semantics land.

Update `.gitignore`:

```text
agent/target/
agent/.env
agent/certs/
agent/target/acoustic-spike/
```

## Root Script Plan

Current `bun run validate` is TS-only. Add split validation:

```json
{
  "dev:agent": "cargo run --manifest-path agent/Cargo.toml -p agent-service",
  "agent:fmt": "cargo fmt --manifest-path agent/Cargo.toml --all -- --check",
  "agent:clippy": "cargo clippy --manifest-path agent/Cargo.toml --workspace --all-targets -- -D warnings",
  "agent:test": "cargo test --manifest-path agent/Cargo.toml --workspace",
  "agent:build": "cargo build --manifest-path agent/Cargo.toml --workspace",
  "validate:ts": "bun run typecheck && bun run lint && bun run test && bun run build",
  "validate:agent": "bun run agent:fmt && bun run agent:clippy && bun run agent:test && bun run agent:build",
  "validate": "bun run validate:ts && bun run validate:agent"
}
```

Do not put `CARTESIA_API_KEY`, `GEMINI_API_KEY`, `DATABASE_URL`, or bearer tokens in Turbo `globalEnv`. Add only frontend-visible runtime values:

```json
[
  "NODE_ENV",
  "NEXT_PUBLIC_VIVA_API_URL",
  "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
  "VIVA_AGENT_BASE_URL",
  "VIVA_ENV"
]
```

## Environment Contract

Add root `.env.example` later:

```sh
VIVA_ENV=local
VIVA_AGENT_BASE_URL=http://127.0.0.1:4318
NEXT_PUBLIC_VIVA_AGENT_WS_URL=ws://127.0.0.1:4318/ws
NEXT_PUBLIC_VIVA_API_URL=http://localhost:3000
```

Add `agent/.env.example`:

```sh
DATABASE_URL=postgres://localhost/viva_agent
BIND_ADDR=127.0.0.1:4318
VIVA_AGENT_PROVIDER=cartesia_gemini
VIVA_VOICE_WS_USER_TOKENS=user:local=change-me-for-local-dev
VIVA_VOICE_WS_ALLOW_UNAUTHENTICATED=
VIVA_VOICE_WS_ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000
MAX_VOICE_SESSIONS=16
MAX_VOICE_SESSIONS_PER_USER=1
STRICT_REALTIME=
CARTESIA_API_KEY=
GEMINI_API_KEY=
GEMINI_REALTIME_MODEL=
GEMINI_BASE_URL=
GEMINI_THINKING_LEVEL=low
CARTESIA_INK_MODEL=
CARTESIA_SONIC_MODEL=
CARTESIA_SONIC_VOICE_ID=
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=
TLS_CERT_PATH=
TLS_KEY_PATH=
RUST_LOG=agent_service=info,tower_http=info
```

Rename rules:

- `LUCA_REALTIME_BRAIN` -> `VIVA_AGENT_PROVIDER`
- `LUCA_VOICE_WS_USER_TOKENS` -> `VIVA_VOICE_WS_USER_TOKENS`
- `LUCA_VOICE_WS_ALLOW_UNAUTHENTICATED` -> `VIVA_VOICE_WS_ALLOW_UNAUTHENTICATED`
- `LUCA_VOICE_WS_ALLOWED_ORIGINS` -> `VIVA_VOICE_WS_ALLOWED_ORIGINS`
- `LUCA_USER_ID` -> `VIVA_USER_ID`
- `LUCA_PROACTIVE_ENABLED` -> `VIVA_PROACTIVE_ENABLED`
- `LUCA_RUN_CARTESIA_GEMINI_SMOKE` -> `VIVA_RUN_CARTESIA_GEMINI_SMOKE`

Remove or replace:

- `KB_SNAPSHOT_PATH`
- `ME_API_BASE_URL`
- `ME_USER_TOKENS`
- food/allergen/pantry/fridge envs
- Voice Lab envs unless Viva intentionally builds a public evaluation lab

## Browser Protocol

Preserve Luca's durable WebSocket shape but make frames versioned for Viva.

Client -> server:

```ts
type VivaClientFrame =
  | { v: 1; type: "client.session.start"; studySetId: string; mode: "quiz" | "teach" | "mock" | "cram" }
  | { v: 1; type: "client.audio"; audio: string; encoding: "pcm_s16le"; sampleRate: 24000 }
  | { v: 1; type: "client.answer.text"; text: string }
  | { v: 1; type: "client.control"; command: "barge_in" | "stop" | "end_session" }
  | { v: 1; type: "client.source.challenge"; sourceId: string; reason?: string };
```

Server -> client:

```ts
type VivaServerFrame =
  | { v: 1; type: "server.ready"; sessionId: string; userId: string; mode: string }
  | { v: 1; type: "session.phase"; phase: "ready" | "listening" | "thinking" | "feedback" | "correction" | "recap" }
  | { v: 1; type: "question.started"; question: VivaQuestion }
  | { v: 1; type: "transcript.delta"; speaker: "student" | "viva"; text: string; cumulative?: boolean }
  | { v: 1; type: "audio.ack"; bytes: number }
  | { v: 1; type: "audio.delta"; responseId?: string; seq?: number; audio: string }
  | { v: 1; type: "response.cancelled" }
  | { v: 1; type: "tts.fade_out"; durationMs: number; curve: "cosine" }
  | { v: 1; type: "tts.cancel" }
  | { v: 1; type: "answer.evaluated"; evaluation: VivaAnswerEvaluation }
  | { v: 1; type: "source.reference"; source: VivaSourceReference }
  | { v: 1; type: "concept.status"; conceptId: string; status: "strong" | "shaky" | "missed" | "review" }
  | { v: 1; type: "recap.ready"; recap: VivaSessionRecap }
  | { v: 1; type: "protocol.error" | "server.error"; code?: string; message: string };
```

Implementation notes:

- Binary PCM16 frames should remain supported for lower overhead.
- Text `client.audio` base64 frames are useful for tests and browser compatibility.
- Cartesia Ink partial transcripts are cumulative, so the server must keep the `cumulative` flag. The browser must replace the in-flight student partial instead of appending.
- Response-bound audio must carry `responseId` and `seq` so stale/cancelled audio can be suppressed.
- `response.cancelled` should be treated as a global playback clear by the client.
- `tts.fade_out` should precede `tts.cancel` on barge-in for a less jarring cut.

## Viva Study Tool Surface

Replace Luca's recipe/allergen tools with study tools.

Minimum v1 tools:

```text
select_next_question
evaluate_spoken_answer
retrieve_source_reference
mark_concept_status
challenge_correction
build_session_recap
schedule_review_item
```

Recommended tool contract:

- Every tool takes `study_set_id` and `voice_session_id` when applicable.
- Any correction that cites a source must return `source_id`, `document_id`, `span`, `excerpt`, `confidence`, and `retrieval_reason`.
- If the system cannot retrieve a defensible source, it must return an ungrounded/low-confidence correction rather than fabricate a citation.
- Tools should be deterministic where they update mastery, review schedule, or recap state.
- Model language can be flexible, but source IDs and concept-status changes must be structured and validated.

Viva's equivalent of Luca's P0 safety boundary is source integrity:

- The model may coach and explain freely.
- The model may not invent a source-backed correction.
- Corrections presented as course-grounded must pass through a deterministic `retrieve_source_reference` or `evaluate_spoken_answer` result.
- If source confidence is low, the UI must say so.

## Data Model Direction

Phase 1 can run against fixtures and in-memory stores. Phase 2 should use Postgres.

Proposed tables:

```sql
study_sets (
  id uuid primary key,
  user_id text not null,
  title text not null,
  course text,
  exam_date date,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

study_documents (
  id uuid primary key,
  study_set_id uuid not null,
  display_name text not null,
  source_kind text not null,
  content_hash text,
  deleted_at timestamptz,
  created_at timestamptz not null
);

source_spans (
  id uuid primary key,
  document_id uuid not null,
  locator jsonb not null,
  excerpt text not null,
  embedding_ref text,
  deleted_at timestamptz,
  created_at timestamptz not null
);

concepts (
  id uuid primary key,
  study_set_id uuid not null,
  label text not null,
  status text not null,
  source_span_id uuid,
  updated_at timestamptz not null
);

voice_sessions (
  id uuid primary key,
  user_id text not null,
  study_set_id uuid not null,
  mode text not null,
  status text not null,
  started_at timestamptz not null,
  ended_at timestamptz
);

answer_attempts (
  id uuid primary key,
  voice_session_id uuid not null,
  concept_id uuid,
  question jsonb not null,
  answer_text text,
  evaluation jsonb not null,
  source_span_id uuid,
  created_at timestamptz not null
);

review_items (
  id uuid primary key,
  user_id text not null,
  study_set_id uuid not null,
  concept_id uuid not null,
  due_at timestamptz not null,
  reason text not null,
  status text not null
);
```

Retention rules:

- Do not store raw audio by default.
- Store transcripts only if product requirements explicitly allow it.
- Source spans may store short excerpts; raw documents remain in the document lane.
- Deleting a document must tombstone or delete dependent source spans and make later corrections show source unavailable.
- Agent memory should store study progress and references, not copies of full uploaded materials.

## Frontend Integration

The existing `VivaApp.tsx` can be integrated incrementally:

1. Add `packages/core/src/agent-contract.ts` with TS frame types and fixtures.
2. Add `apps/web/lib/viva-agent-client.ts` for WebSocket connection, auth/subprotocol token support, PCM capture, and playback queue.
3. Keep Web Speech fallback for local unsupported browsers until Rust audio is stable.
4. Replace `startSession`, `submitAnswer`, `showCorrection`, and `finishSession` state transitions with server-driven frames.
5. Keep `@viva/core` mock functions as synthetic fixtures for no-secret local tests.

Do not route browser WebSockets through Next route handlers. The app has a static-export path, and WebSocket proxying through Next would complicate that. Browser should connect directly to `NEXT_PUBLIC_VIVA_AGENT_WS_URL`.

## Implementation Phases

### Phase 0: Freeze The Source Inventory

Tasks:

- Record the Luca source commit/branch in the implementation PR.
- Copy only from `../luca/agent`, excluding `target/`.
- Decide whether crate names stay generic (`agent-domain`) or become branded (`viva-agent-domain`). Prefer branded names if the first implementation can absorb the rename cleanly.

Acceptance:

- Planning doc links the exact source files.
- No `target/`, `.env`, certs, or generated artifacts copied.

### Phase 1: Scaffold Rust Workspace

Tasks:

- Add `agent/Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.env.example`, and README.
- Add minimal crates: `agent-domain`, `agent-service`, `agent-adapters`, `data`, `observe`.
- Add `NoopRealtimeBrain` or `SyntheticBrain`.
- Add `/live`, `/ready`, `/health`, and `/ws` stubs.
- Wire root package scripts.

Acceptance:

```sh
bun run validate:ts
bun run agent:fmt
bun run agent:clippy
bun run agent:test
bun run agent:build
```

All pass without provider keys and without Postgres if the DB tests are feature-gated.

### Phase 2: Port Cartesia/Gemini Adapter

Tasks:

- Copy `cartesia_gemini/*` as a unit.
- Replace Luca system instruction with Viva study prompt.
- Rename env keys.
- Keep fake provider servers and parser tests.
- Add opt-in live smoke flag.

Acceptance:

```sh
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini
VIVA_RUN_CARTESIA_GEMINI_SMOKE=1 cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini -- --ignored
```

Default tests use fake servers. Live smoke only runs when explicit env flag and keys exist.

### Phase 3: Port WebSocket Transport

Tasks:

- Port `/ws` upgrade, bearer/subprotocol auth, origin allowlist, session caps, frame size guards.
- Port inbound audio handling.
- Port outbound bounded writer and priority cancellation queue.
- Port response-id stale-event suppression.
- Add Viva frame contract tests.

Acceptance:

- Missing bearer token returns `401` when auth is configured.
- Wrong origin returns `403`.
- Session cap returns `503`.
- Oversized text/audio frames are rejected.
- Synthetic audio produces `audio.ack`.
- Synthetic provider can emit `audio.delta`.
- Barge-in sends `tts.fade_out`, `tts.cancel`, and `response.cancelled`.

### Phase 4: Replace Domain Tools

Tasks:

- Add Viva `SessionConfig`: `user_id`, `study_set_id`, `mode`, `initial_goal`, `source_context`, `active_concepts`.
- Add study tools: `select_next_question`, `evaluate_spoken_answer`, `retrieve_source_reference`, `mark_concept_status`, `build_session_recap`, `schedule_review_item`.
- Replace Luca cooking panels with Viva source/correction/recap events.
- Add source-integrity fail-closed behavior.

Acceptance:

- No `recipe`, `ingredient`, `allergen`, `pantry`, `fridge`, `cook`, `temperature`, `KB_SNAPSHOT_PATH`, `LUCA_*`, or `Chef Luca` strings remain outside historical docs or explicitly named migration notes.
- A correction with a source must include source id, span, excerpt, confidence, and retrieval reason.
- A correction without a source is marked low confidence or ungrounded.

### Phase 5: Add Data Layer

Tasks:

- Port Postgres pool.
- Add Viva migrations.
- Add session and study memory stores.
- Add deletion/tombstone semantics for documents, spans, transcripts, and recaps.
- Add usage metering.

Acceptance:

- Migration tests apply cleanly.
- Schema tests enforce no raw audio column and no unrestricted raw document copy in agent tables.
- Deleting/tombstoning a document makes dependent source references unavailable.
- Meter reports provider/model, voice minutes, estimated cost, latency fields, and source-grounded correction count.

### Phase 6: Integrate Web Client

Tasks:

- Add TS frame types in `@viva/core`.
- Add fixture parity tests with Rust.
- Add `viva-agent-client`.
- Add PCM capture/playback.
- Connect existing session UI to server frames.
- Keep local mock fallback behind a development flag.

Acceptance:

- Browser opens Rust `/ws`.
- Browser receives `server.ready`.
- Browser streams audio or fixture audio.
- UI phase follows server frames.
- Source/correction cards render from server events.
- Recap screen can be produced from `recap.ready`.

### Phase 7: Live Provider And Mobile Hardening

Tasks:

- Run opt-in Cartesia/Gemini smoke.
- Verify provider model names and API versions against current official docs.
- Test laptop browser microphone/speaker loop.
- Test phone browser over HTTPS with local certs if mobile is in scope.
- Add rate limits and provider budget logging.

Acceptance:

- Live smoke shows first-audio latency, barge-in behavior, usage/cost record, and no secret leakage in logs.
- Phone test either passes with browser direct transport or produces a documented LiveKit/WebRTC follow-up decision.

## Verification Gates

Default no-secret gate:

```sh
bun run validate
```

Expanded local Rust gate:

```sh
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path agent/Cargo.toml --workspace
cargo build --manifest-path agent/Cargo.toml --workspace
```

Contract parity:

```sh
bun test packages/core/src/agent-contract.test.ts apps/web/lib/viva-agent-client.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain protocol_fixtures
```

Domain purity:

```sh
rg -n "LUCA_|Chef Luca|recipe|ingredient|allergen|pantry|fridge|cook|temperature|KB_SNAPSHOT_PATH" agent packages apps
```

Provider smoke, opt-in only:

```sh
VIVA_RUN_CARTESIA_GEMINI_SMOKE=1 \
CARTESIA_API_KEY=... \
GEMINI_API_KEY=... \
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini -- --ignored
```

## Risks

1. Blind copying Luca imports the wrong product. The dangerous residue is cooking, allergen safety, recipe KBs, pantry memory, and Voice Lab capture contracts.
2. Provider names may drift. The live code has defaults such as Cartesia API version and Gemini model constants; implementation must recheck official provider docs before live smoke.
3. Viva has no auth layer yet. The agent must start with explicit local bearer tokens and origin allowlists, not an unauthenticated production path.
4. Browser audio is non-trivial. Current Viva uses Web Speech APIs, not PCM streaming/playback.
5. Mobile may require HTTPS and stronger AEC decisions. Do not assume thin browser WebSocket audio is production mobile-ready.
6. Transcript and source retention can become privacy debt. Store references and short excerpts first; store raw transcript/audio only behind an explicit retention decision.
7. TS/Rust contract drift is likely without shared fixtures. Add contract fixtures before UI integration.
8. Cost gates can silently become paid tests. All live provider tests must be env-flagged and skipped by default.

## Stop Rules

Do not implement beyond the Rust scaffold until these are true:

- The `CartesiaGemini` adapter compiles and fake-provider tests pass.
- The Viva frame contract is written in TS and Rust.
- The replacement Viva tool surface is agreed in code or plan.
- There is a domain-purity check preventing Luca cooking terms from entering the shipped agent.

Do not run live provider smoke until these are true:

- `CARTESIA_API_KEY` and `GEMINI_API_KEY` are explicitly supplied.
- `VIVA_RUN_CARTESIA_GEMINI_SMOKE=1` is set.
- Provider model/API constants have been rechecked.
- Logs are confirmed not to print secrets, full transcripts, or raw document text.

## Recommended First Implementation PR

Scope:

- Add `agent/` Cargo workspace.
- Add `agent-domain`, `agent-adapters`, `agent-service`, `data`, and `observe`.
- Port `AudioFrame`, `RealtimeBrain`, `BrainInput`, `BrainEvent`, `NoopRealtimeBrain`.
- Port `cartesia_gemini` adapter and fake-provider tests.
- Add service `/live`, `/ready`, `/health/brain`, and `/ws` with synthetic provider.
- Add root validation scripts.
- Add domain-purity check.

Out of scope:

- Real document ingestion.
- Production auth.
- Postgres-backed study documents.
- Mobile AEC decision.
- Full UI rewrite.
- Live provider smoke unless explicitly requested after no-secret tests pass.

This keeps the first PR reviewable while proving the hard mechanical question: the Rust voice loop can exist in Viva and preserve Luca's realtime spine without inheriting Luca's cooking product.
