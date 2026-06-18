# BAC-310 Cartesia Ink STT Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for each behavior change and `superpowers:verification-before-completion` before closeout. Keep this plan task-by-task with checkbox status.

**Goal:** Implement the server-side Cartesia Ink realtime STT transport for Viva's Cartesia/Gemini runner boundary while keeping live runtime unselectable until the later provider-readiness gate.

**Provider contract:** Cartesia Realtime STT Auto uses `wss://api.cartesia.ai/stt/turns/websocket` with `model`, `encoding`, `sample_rate`, and `cartesia_version` query parameters; server-side WebSocket clients authenticate with `Authorization: Bearer <CARTESIA_API_KEY>` or `X-Api-Key`; audio is sent as binary frames; a clean close is a JSON text frame with `{"type":"close"}`; transcripts arrive as `turn.update`, `turn.eager_end`, `turn.resume`, and `turn.end` events.

**Stop rules:**
- Do not make `cartesia_gemini` selectable or mark it as `live_runtime`.
- Do not attempt network access in default tests.
- Do not log, persist, or expose raw audio bytes or raw transcript buffers outside normal realtime `BrainEvent` transcript events.
- Do not emit server-side amplitude, RMS, VAD, or audio-derived telemetry.
- Do not broaden BAC-310 into Gemini or Sonic work.

**Architecture:** Add a small Ink transport layer below the existing `CartesiaGeminiTransports::transcribe_audio` boundary. Test the lower-level socket state machine with fake sockets so backpressure, provider errors, event mapping, close behavior, and transcript accumulation are covered without keys or network. Leave `GatedNoNetworkCartesiaGeminiTransports::authorize_open` unchanged so the live brain remains gated; expose a live Ink transport constructor/function for future runtime composition.

---

### Task 1: Prove authenticated Ink WebSocket request shape

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`

- [x] **Step 1: Write the failing test**

Add a unit test proving `InkConfig` builds a WebSocket request whose URI contains the auto-STT endpoint and required query values, and whose headers include a redacted-debug-safe server API key plus `Cartesia-Version`.

- [x] **Step 2: Verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_gemini::stt::tests::authenticated_request_uses_server_headers_and_required_query -- --nocapture
```

Expected: FAIL because no request builder exists yet.

- [x] **Step 3: Implement minimal code**

Add the request builder in `stt.rs`. Keep API keys out of `Debug` output by not storing request objects in config/debug structs.

- [x] **Step 4: Verify GREEN**

Run the same focused test. Expected: PASS.

### Task 2: Prove binary audio forwarding and close command

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`

- [x] **Step 1: Write the failing test**

Add a fake `InkSocket` test proving a single `AudioFrame` is forwarded as one binary message with exact PCM bytes and the turn closes with `{"type":"close"}`.

- [x] **Step 2: Verify RED**

Run the focused test. Expected: FAIL because the socket-driven turn runner does not exist.

- [x] **Step 3: Implement minimal code**

Add `InkSocket`, `InkTranscript`, and `transcribe_ink_turn` using `audio_frame_bytes(frame)`, a text close command, and no raw-byte formatting in errors.

- [x] **Step 4: Verify GREEN**

Run the same focused test. Expected: PASS.

### Task 3: Prove turn-event transcript mapping

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`

- [x] **Step 1: Write failing tests**

Add tests for `turn.update` -> interim transcript, `turn.eager_end` -> interim transcript, `turn.resume` -> abort speculative interim, and `turn.end` -> final transcript.

- [x] **Step 2: Verify RED**

Run focused STT tests. Expected: FAIL for the new accumulator behavior.

- [x] **Step 3: Implement minimal code**

Accumulate only the latest non-empty interim and the final `turn.end` text. On `turn.resume`, clear interim. Map `InkTranscript` into `RunnerTranscript` for the future live transport path.

- [x] **Step 4: Verify GREEN**

Run focused STT tests. Expected: PASS.

### Task 4: Prove provider error, backpressure, and abort surfaces

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`

- [x] **Step 1: Write failing tests**

Cover provider `error` events, send failures, receive failures, and socket close before `turn.end`. Assert errors include provider/control context but do not include PCM bytes or transcript text.

- [x] **Step 2: Verify RED**

Run focused STT tests. Expected: FAIL until the error mapping exists.

- [x] **Step 3: Implement minimal code**

Map errors to `BrainError::Connection` or `BrainError::Protocol` with sanitized messages. Return a protocol error if the socket closes without final transcript.

- [x] **Step 4: Verify GREEN**

Run focused STT tests. Expected: PASS.

### Task 5: Add live WebSocket adapter without enabling live selection

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [x] **Step 1: Write failing integration-adjacent tests**

Add tests proving `CartesiaGeminiBrain` remains configured-but-unselectable with keys, `open` still stops at the no-network gate, and the live Ink transport can be constructed/invoked through a fake socket without hitting Gemini or Sonic.

- [x] **Step 2: Verify RED**

Run adapter tests. Expected: new live transport path fails until wired.

- [x] **Step 3: Implement minimal code**

Add `LiveInkSttTransport`/helper using `tokio-tungstenite` and `futures-util` to connect, send binary audio, send close, read text events, and close the socket. Keep the existing `GatedNoNetworkCartesiaGeminiTransports::authorize_open` behavior unchanged.

- [x] **Step 4: Verify GREEN**

Run focused adapter tests. Expected: PASS.

### Task 6: Full validation and closeout

**Files:**
- All touched files.

- [x] **Step 1: Run focused coverage**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_gemini::stt -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini
```

- [x] **Step 2: Run full validation**

```bash
bun run validate
```

- [x] **Step 3: Privacy and stop-rule scan**

```bash
rg -n "raw audio|raw transcript|amplitude|RMS|vad|SpeechRecognition|selectable: true|live_runtime: true" agent/crates/agent-adapters agent/crates/agent-service apps/web packages/core
```

Expected: only existing false positives or explicit negative assertions.

- [ ] **Step 4: PR, review, merge, Linear**

Commit BAC-310 only, open a PR, add validation evidence, re-query review threads late, merge only when the gate is clear or an explicit admin override is justified, and move BAC-310 to Done with evidence.
