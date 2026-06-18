# BAC-313 Live Runner Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gated live Cartesia/Gemini runner use the same authorized study-store/tool-executor path as the fake runtime, and ensure only final STT text drives answer evaluation and durable writes.

**Architecture:** Keep the existing shared `CartesiaGeminiRunner<T>` boundary. The service passes the built `StudyMemoryStore` into `CartesiaGeminiBrain`; the gated live runner remains unselectable/no-network, but if opened after the missing-key check it reaches the no-network transport gate with a real store attached. Audio STT handling preserves both interim and final transcripts, emits interim as `TranscriptDelta`, emits final as `TranscriptFinal`, and evaluates only final text.

**Tech Stack:** Rust agent crates (`agent-adapters`, `agent-service`), Tokio tests, existing in-memory `StudyMemoryStore`, existing fake/gated Cartesia/Gemini transports.

---

### Task 1: Prove final STT text is the evaluation authority

**Files:**
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`

- [x] **Step 1: Write the failing test**

Add a focused assertion to `fake_runtime_replays_provider_shaped_pipeline_without_live_selection` proving the fake Ink final transcript, not the interim byte-count text, becomes the evaluated answer:

```rust
assert!(events.iter().any(|event| matches!(
    event,
    BrainEvent::AnswerEvaluated { evaluation, .. }
        if evaluation.answer_text == "NADH donates electrons to the electron transport chain."
)));
assert!(events.iter().all(|event| !matches!(
    event,
    BrainEvent::AnswerEvaluated { evaluation, .. }
        if evaluation.answer_text == "received 4 PCM16 bytes"
)));
```

- [x] **Step 2: Verify the test fails**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini fake_runtime_replays_provider_shaped_pipeline_without_live_selection
```

Expected: FAIL because `evaluation.answer_text` is currently `received 4 PCM16 bytes`.

- [x] **Step 3: Implement the minimal fix**

In `CartesiaGeminiRunner::transcript_for_input`, stop replacing `final_text` with `interim_text` for `RunnerInput::Audio`. Return the transport transcript unchanged.

- [x] **Step 4: Verify the focused test passes**

Run the same focused cargo test. Expected: PASS.

### Task 2: Emit interim transcript without evaluating it

**Files:**
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`

- [x] **Step 1: Write the failing test**

Add a session-level test that sends audio through `FakeCartesiaGeminiRuntime::open`, expects a `TranscriptDelta` with `received 4 PCM16 bytes`, expects a `TranscriptFinal` with the provider final text, and asserts the durable answer attempt stores only the final text.

- [x] **Step 2: Verify the test fails**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini fake_runtime_session_emits_interim_delta_but_evaluates_only_final_transcript
```

Expected: FAIL because the session currently emits only `TranscriptFinal` and uses interim text.

- [x] **Step 3: Implement the minimal fix**

In `emit_turn`, after `transcript_for_input` succeeds, send `BrainEvent::TranscriptDelta` with `transcript.interim_text` before `BrainEvent::TranscriptFinal` when the interim text is non-empty and differs from final text. Keep `run_gemini_tool_loop` wired to `transcript.final_text`.

- [x] **Step 4: Verify the focused test passes**

Run the same focused cargo test. Expected: PASS.

### Task 3: Bind the live runner to the service study store

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- Modify: `agent/crates/agent-service/src/config.rs`
- Modify: `agent/crates/agent-service/src/config.rs` tests
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [x] **Step 1: Write the failing tests**

Add a service config test proving `build_brain` with `RealtimeProvider::CartesiaGemini` keeps the supplied store reachable in the gated live runner. Add an adapter test proving `CartesiaGeminiBrain` constructed with a store no longer fails with "opened without a study-memory store" before it reaches the gated no-network transport.

- [x] **Step 2: Verify the tests fail**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-service builds_gated_live_provider_with_study_store
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini cartesia_gemini_brain_open_uses_store_before_no_network_gate
```

Expected: FAIL because `build_brain` currently discards the store and `CartesiaGeminiBrain::new` has no store parameter.

- [x] **Step 3: Implement the minimal fix**

Change `CartesiaGeminiBrain::new` to accept `Arc<dyn StudyMemoryStore>` and initialize `CartesiaGeminiRunner::gated_live(store, config.clone())`. Change `CartesiaGeminiRunner::gated_live` to store `Some(store)`. Update all `CartesiaGeminiBrain::new` call sites and tests.

- [x] **Step 4: Verify the focused tests pass**

Run both focused cargo tests. Expected: PASS.

### Task 4: Full verification and PR

**Files:**
- All files changed by prior tasks.

- [x] **Step 1: Run focused Rust coverage**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini
cargo test --manifest-path agent/Cargo.toml -p agent-service config::
```

Expected: all pass.

- [x] **Step 2: Run full validation**

```bash
bun run validate
```

Expected: all TS, Rust, build, purity, and generated artifact hygiene checks pass.

- [x] **Step 3: Inspect privacy and stop-rule drift**

Run:

```bash
rg -n "raw transcript|raw audio|SpeechRecognition|textarea source of truth|three\\.js|pixi|rive" agent/crates/agent-adapters agent/crates/agent-service
```

Expected: no new live-runner behavior violates BAC-313 stop rules.

- [ ] **Step 4: Commit and open PR**

Commit with:

```bash
git add agent/crates/agent-adapters agent/crates/agent-service docs/superpowers/plans/2026-06-18-bac-313-live-runner-binding.md
git commit -m "BAC-313 fix live runner binding"
```

Commit body must include:

```text
Co-Authored-By: Codex <codex@openai.com>
```

Open a PR for BAC-313, request review, resolve every review thread, and merge only after the local validation and review-thread gates are clean.
