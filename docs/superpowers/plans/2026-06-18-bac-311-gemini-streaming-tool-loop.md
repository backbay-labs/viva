# BAC-311 Gemini Streaming Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for each behavior change and `superpowers:verification-before-completion` before closeout. Keep this checklist current as work proceeds.

**Goal:** Implement the Gemini `streamGenerateContent` transport under Viva's existing Cartesia/Gemini runner boundary so live Gemini SSE chunks can drive the existing server-owned tool loop and v1 meaning events.

**Provider contract:** The Google AI Gemini API supports `models/{model}:streamGenerateContent` with `alt=sse`; request bodies match `generateContent`, including `contents`, `tools`, `toolConfig`, `systemInstruction`, and `generationConfig`. Official API guidance now says API-key REST calls must send the key in the `x-goog-api-key` header, not in logged query strings. The newer Interactions API exists but is beta; BAC-311 explicitly targets stable `streamGenerateContent`.

**Stop rules:**
- Do not make `cartesia_gemini` selectable or mark it as `live_runtime`.
- Do not attempt network access in default tests.
- Do not log prompts, raw answers, transcripts, source excerpts, or tool-response payloads.
- Do not trust browser-provided tool results, source context, or identity.
- Do not compute FSRS schedules in the agent; emit the verdict/status only.
- Do not broaden BAC-311 into Cartesia Sonic, live smoke harness, selection gating, or ManuscriptIntent grammar.

**Architecture:** Add a Gemini SSE client layer below `CartesiaGeminiTransports::stream_gemini`. Unit-test it with a fake client that captures configured URL/key/body and returns SSE text. The real client uses `reqwest` with `x-goog-api-key`, posts JSON to `GeminiConfig::stream_url()`, reads SSE text, parses existing `GeminiStreamEvent`s, and maps provider/transport failures to sanitized `BrainError`s. Leave `GatedNoNetworkCartesiaGeminiTransports::authorize_open` unchanged.

---

### Task 1: Prove multi-line Gemini SSE parsing

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`

- [x] **Step 1: Write the failing test**

Add a test proving a multi-line SSE response containing text, function call, usage metadata, and `[DONE]` becomes the existing `GeminiStreamEvent` sequence.

- [x] **Step 2: Verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_gemini::llm::tests::parses_multiline_gemini_sse_stream -- --nocapture
```

Expected: FAIL because only single-line parsing exists.

- [x] **Step 3: Implement minimal code**

Add `parse_gemini_sse_stream` that iterates response lines and reuses `parse_gemini_sse_line`.

- [x] **Step 4: Verify GREEN**

Run the same focused test. Expected: PASS.

### Task 2: Prove configured authenticated stream transport without network

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`

- [x] **Step 1: Write the failing test**

Add a fake `GeminiSseClient` test proving the transport uses `GeminiConfig::stream_url()`, carries the configured API key out-of-query, preserves the JSON request body, and parses returned SSE events.

- [x] **Step 2: Verify RED**

Run focused LLM tests. Expected: FAIL because the client boundary does not exist.

- [x] **Step 3: Implement minimal code**

Add `GeminiSseClient`, `stream_gemini_with_client`, and a request context that exposes only URL/body/key to the client without logging secrets.

- [x] **Step 4: Verify GREEN**

Run focused LLM tests. Expected: PASS.

### Task 3: Prove provider and transport failures are sanitized

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`

- [x] **Step 1: Write failing tests**

Cover provider `error.message`, HTTP/transport failures, invalid SSE JSON, and empty responses. Assert failure text names Gemini/control context but does not include prompt text, raw answer text, source excerpts, request body, or key material.

- [x] **Step 2: Verify RED**

Run focused LLM tests. Expected: FAIL until error mapping exists.

- [x] **Step 3: Implement minimal code**

Map failures to `BrainError::Protocol`/`BrainError::Connection` with sanitized static messages. Never include request or response body in errors.

- [x] **Step 4: Verify GREEN**

Run focused LLM tests. Expected: PASS.

### Task 4: Wire gated live runner stream path

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [x] **Step 1: Write regression tests**

Assert `cartesia_gemini` remains configured-but-unselectable with keys and `open` still stops at the no-network gate. Add/keep coverage proving the fake runtime's tool loop executes only server-owned tools from the authorized session.

- [x] **Step 2: Verify RED where new assertions apply**

Run adapter tests. Expected: new live stream path is not wired yet.

- [x] **Step 3: Implement minimal code**

Route `GatedNoNetworkCartesiaGeminiTransports::stream_gemini` through the new Gemini HTTP SSE transport. Keep `authorize_open` unchanged.

- [x] **Step 4: Verify GREEN**

Run focused adapter tests. Expected: PASS.

### Task 5: Full validation and closeout

**Files:**
- All touched files.

- [x] **Step 1: Run focused coverage**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_gemini::llm -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini -- --nocapture
```

- [x] **Step 2: Run full validation**

```bash
bun run validate
```

- [x] **Step 3: Privacy and stop-rule scan**

```bash
rg -n "raw answer|raw transcript|raw audio|source excerpt|prompt|x-goog-api-key|GEMINI_API_KEY|selectable: true|live_runtime: true|FSRS|due_at" agent/crates/agent-adapters agent/crates/agent-service apps/web packages/core
```

Expected: only existing false positives, docs/tests, or explicit negative assertions.

- [ ] **Step 4: PR, review, merge, Linear**

Commit BAC-311 only, open a PR, add validation evidence, re-query review threads late, merge only when the gate is clear or an explicit admin override is justified, and move BAC-311 to Done with evidence.
