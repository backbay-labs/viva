# Live Provider Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before each commit and final handoff. Keep every checkbox current. Do not batch RED and GREEN across tasks.

**Goal:** Make the Cartesia Ink -> Gemini tool loop -> Cartesia Sonic path honest, multi-turn, cancellable, connection-reusing, and genuinely streaming while preserving the fake runtime as an explicit fixture implementation rather than allowing fixture semantics to leak into live learner records or speech.

**Architecture:** Keep all provider I/O in `agent-adapters`. A `LiveCartesiaGeminiTransports` instance owns one shared `reqwest::Client`; each opened Viva realtime session owns its Cartesia connection state, including one session-duration Ink stream when the Plan 03 audio lifecycle permits it and one multiplexed Sonic WebSocket with a fresh context per response. The shared runner consumes Plan 04's persisted `TurnOutcome`, emits learning facts only from that returned outcome, validates phase transitions through Plan 06's `StudySessionState`, and consumes Plan 05's immutable protocol-v5 fixtures by manifest ID. Gemini and Sonic become incremental streams: final-pass Gemini text feeds Sonic continuations, and Sonic chunks become `AudioDelta` events before provider completion. Cancellation is cooperative long enough to send provider cancel/close control frames and is force-aborted only after a bounded cleanup deadline.

**Tech Stack:** Rust 2021; Tokio; `async-trait`; `futures-util`; `reqwest`; `tokio-tungstenite`; Serde; Plan 04 learning-core contracts; Plan 05 voice-protocol fixtures; Plan 06 typed failures and session-state interfaces.

**Spec:** The binding source corpus is `../reviews/2026-08-23-rust-agent-adapters.md`, `../reviews/2026-08-23-correctness-review.md`, `../reviews/2026-08-23-rust-agent-domain.md`, `../reviews/2026-08-23-reliability-and-performance-review.md`, `../reviews/2026-08-23-comprehensive-review-summary.md`, and `../reviews/index.md`, reconciled through `2026-08-23-review-remediation-finding-coverage-ledger.md`. Plans 03, 04, 05, and 06 publish the implementation-time contracts named below; if a reviewed baseline conflicts with their committed handoff, the committed dependency contract governs this lane.

**Provider lifecycle facts rechecked on 2026-08-23:** Cartesia documents one multiplexed Sonic WebSocket for many generations, a new context for each conversational turn, and an explicit context cancel message. Cartesia also documents that a cancel may not stop a request already generating, so the client must suppress cancelled-context chunks and close on terminal cleanup/timeout rather than treating the cancel write as an acknowledgement. Gemini documents `streamGenerateContent` as an SSE response whose chunks should be consumed incrementally. Recheck these pinned provider contracts immediately before implementation: [Cartesia TTS WebSocket](https://docs.cartesia.ai/api-reference/tts/websocket), [Cartesia contexts and cancellation](https://docs.cartesia.ai/use-the-api/tts-websocket/contexts), [Cartesia connection limits](https://docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts), and [Gemini streaming content](https://ai.google.dev/api/generate-content).

---

## Finding coverage

| Plan ID | Review finding(s) closed | Required proof |
| --- | --- | --- |
| ADAPTER-01 | ADP Important 1-2 (canonical); removes the adapter-side reachability of COR-02/COR-06 scaffolding — canonical closure of COR-02 is Plan 03 `CRIT-SCHED-01` (D-01-blocked) and of COR-06 is Plan 04 `LEARN-PAIR-001-002`; this lane records supporting evidence only | Live and fake runners consume persisted `TurnOutcome`; no adapter fabricates mastery, scheduling, recap, biology copy, or confidence |
| ADAPTER-02 | ADP Important 3 | Every accepted turn has a distinct `QuestionStarted` before any response-bound event; Plan 05 two-turn fixture parity. The client-side staleness-guard second-turn integration proof is owned by Plan 10 (`apps/web/lib/viva-agent-client.ts`); this lane records the adapter-side half and links Plan 10's test in the ledger row |
| ADAPTER-03 | ADP Important 4 | Sonic cancel is sent for the active context; timeout/error/session stop closes sockets; cancelled audio is suppressed |
| ADAPTER-04 | ADP Important 5, connection half | One `reqwest::Client` pool is shared; one Sonic socket serves multiple response contexts; session connection teardown is bounded |
| ADAPTER-05 | ADP Important 5, buffering half | Gemini SSE is parsed before EOF and Sonic frames are emitted before `done`; no full-body/full-audio buffering remains |
| ADAPTER-06 | ADP Important 6 and Minor 5 | Live errors use Plan 06 typed failures; invalid credentials are nonretryable; primary/fallback HTTP and Cartesia Ink/Sonic HTTP/WS diagnostics expose only bounded allowlisted metadata; no live event says `fake provider` |
| ADAPTER-07 | ADP Minor 1 and 4 | Confidence is provider-supplied or explicit unknown; STT query values are encoded and cannot inject parameters |
| ADAPTER-08 | ADP Minor 2-3 | `cargo udeps` is clean; unreachable fallback/budget branches are removed or made live and correctly attributed; trusted source context is either used or deleted |
| ADAPTER-09 | COR-08/REL-04 boundary | Browser resampling remains Plan 03/Plan 10-owned unless Plan 03 explicitly transfers an adapter-side stateful resampler seam |
| ADAPTER-10 | Cross-language parity | Adapter tests consume immutable learning-core v1 and voice-protocol v5 fixtures plus local mutation/differential controls |
| ADAPTER-11 | ARC-05; QLT-09; REL-07 | Frozen before/after traces prove the provider-concentrated runner was extracted along session, Gemini, Sonic, Ink, and event-projection invariants with no semantic change |

No row is optional. ADAPTER-09 normally closes by proving that no adapter resampler was transferred and that this lane did not edit browser audio code.

---

## Global Constraints

Implementation must not start until the following plans have landed on the integration base in this order:

1. `docs/superpowers/plans/2026-08-23-expedited-critical-path.md` (Plan 03) publishes the bounded audio lifecycle and hands adapter files to this lane.
2. `docs/superpowers/plans/2026-08-23-learning-core-authority.md` (Plan 04) publishes the LEARN interfaces and `agent/fixtures/learning-core/*-v1.json` fixtures.
3. `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md` (Plan 05) freezes `agent/fixtures/voice-protocol/v5/manifest.json` and its referenced fixtures.
4. `docs/superpowers/plans/2026-08-23-rust-domain-integrity.md` (Plan 06) publishes typed failures, private/sanitized failure accessors, `BrainError::Failure`, `StudySessionState`, and the final production `AudioFrame` constructors/accessors.

Plan 05 owns `agent/fixtures/voice-protocol/**` permanently. This lane consumes those fixtures and requests fixture changes from the Plan 05 owner; it never edits them. The pre-handoff repository contract is v4. Plan 03 chose the audio-lifecycle break and Plan 05 froze it as protocol v5; the adapter lane consumes v5 but did not create that version. Strict v5 rejects legacy-v4 envelopes.

The Plan 05 manifest must expose these exact immutable inputs:

- `agent/fixtures/voice-protocol/v5/manifest.json`, schema `viva.voice-fixtures.manifest.v1`, `protocol_version: 5`, `supported_versions: [5]`, and `legacy_v4_disposition: "reject"`;
- `agent/fixtures/voice-protocol/v5/auth-decision.json`;
- `agent/fixtures/voice-protocol/v5/client-session-config-signed.json`;
- `agent/fixtures/voice-protocol/v5/client-session-refresh.json`;
- `agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json`;
- `agent/fixtures/voice-protocol/v5/turn-intents.json`;
- `agent/fixtures/voice-protocol/v5/turn-outcomes.json` (manifest ID `VOICE-SERVER-TURN-OUTCOMES`, whose cases cover all six deferral reasons);
- `agent/fixtures/voice-protocol/v5/server-ready.json`;
- `agent/fixtures/voice-protocol/v5/terminal-sequences.json`;
- `agent/fixtures/voice-protocol/v5/transport-outcomes.json`;
- `agent/fixtures/voice-protocol/v5/synthetic-two-turn-session.json`;
- `agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json`;
- `agent/fixtures/voice-protocol/v5/client-differential-cases.json`;
- `agent/fixtures/voice-protocol/v5/server-differential-cases.json`;
- `agent/fixtures/session-token/v1/vectors.json`, referenced by the v5 manifest.

Plan 04 must expose these exact read-only fixtures:

- `agent/fixtures/learning-core/turn-outcomes-v1.json`;
- `agent/fixtures/learning-core/recaps-v1.json`;
- `agent/fixtures/learning-core/question-progression-v1.json`.

There is no `review-scheduling` fixture under `agent/fixtures/learning-core`. The scheduling conformance corpus is `packages/core/src/review-scheduling-conformance-v1.json` (Plan 03-created, Plan 04-owned); this lane never derives or asserts schedule dates, so it does not consume that corpus and must not invent an adapter-side scheduling fixture.

After the Plan 03 handoff, this lane is the permanent implementation owner of:

- `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`;
- `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`;
- `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`;
- `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`;
- adapter-local support in `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs` and `constants.rs`;
- `agent/crates/agent-adapters/src/synthetic.rs`;
- `agent/crates/agent-adapters/tests/cartesia_gemini.rs`; every integration test/helper in this plan is added to that file, module-local tests remain inside the exact source file named by their task, and the only new production modules authorized here are Task 11's `session.rs` and `projection.rs`;
- `agent/crates/agent-adapters/Cargo.toml` for dependency cleanup.

This lane must never edit:

- `agent/crates/agent-service/src/protocol.rs`;
- `packages/core/src/agent-contract.ts`;
- `agent/crates/agent-service/src/ws.rs`;
- `agent/crates/agent-domain/src/tool_executor.rs`;
- `agent/fixtures/voice-protocol/**`;
- `agent/fixtures/learning-core/**`;
- any `agent/crates/data/**`, `apps/web/**`, or other data/web surface.

If a consumed interface or fixture is insufficient, stop that task, write the failing adapter test, and hand the exact missing contract to the owning Plan 04/05/06 lane. Do not patch across the boundary.

Plan 04 is the sole learning-authority seam. It publishes `EvaluationRequest`; `AnswerEvaluator::evaluate(&EvaluationRequest) -> Result<EvaluationDecision, EvaluationError>`; `EvaluationDecision::{Evaluated, Deferred}`; derived `EvaluationLabel`; persisted `TurnOutcome` with `TurnResolution::{Evaluated, Deferred}`, `CriterionAssessment`, `ConceptStatusTransition`, and `QuestionDisposition`; `PersistedTurnOutcome { turn_outcome: TurnOutcome, record: TurnOutcomeRecordReceipt }`; atomic `StudyMemoryStore::record_turn_outcome`; `SessionLearningEvidence`; `build_session_recap`; and `QuestionProgressionResult`. `TurnOutcomeRecordReceipt` is exactly `{ schema: "viva.turn_outcome_record.v1", response_id, replayed }`. This lane implements the live provider-backed evaluator, but the Plan 04 executor binds and validates the provider assessments/feedback, derives `EvaluationLabel` and status under `viva.semantic-rubric.v1`, creates/persists the outcome, and returns the serialized `PersistedTurnOutcome` as `ToolResult.result = { "turn_outcome": outcome, "record": receipt }`. The adapter deserializes that wrapper and consumes `turn_outcome`; it never converts the provider decision directly into learner facts and never inspects `record` for them. `SyntheticFixtureAnswerEvaluator` is constructible only by explicit fake/synthetic runtime builders.

Decision gate: `D-02 QUESTION_PROGRESSION` affects this lane. The coverage ledger gates `ADAPTER-01` on D-02. Task 1 RED tests and characterization may be written before D-02 is recorded, but Task 1 GREEN implementation of question-progression consumption (the `QuestionDisposition`/`QuestionProgressionResult` wiring) may not begin until the coordinator has recorded Connor's D-02 selection in the coverage ledger — which is implied by, and must be re-verified at, the Plan 04 dependency handoff in Task 0. Do not substitute a worker-local progression choice for the recorded selection.

Plan 06 removes `AudioFrame::from_pcm16_text`, caches base64 for every production constructor, and exposes `pcm16_base64(&self) -> &str`. Production adapter code must use only the byte/base64 constructors and that borrowed accessor. Any text-shaped PCM fixture helper belongs under `#[cfg(test)]` in `agent-adapters`, must reject an odd byte length, and must not become a shared domain feature.

---

### Task 0: Prove the dependency handoff before starting lane work

**Files:**
- Read: `docs/superpowers/plans/2026-08-23-expedited-critical-path.md`
- Read: `docs/superpowers/plans/2026-08-23-learning-core-authority.md`
- Read: `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md`
- Read: `docs/superpowers/plans/2026-08-23-rust-domain-integrity.md`
- Read: `docs/superpowers/reviews/2026-08-23-rust-agent-adapters.md`
- Read: `docs/superpowers/reviews/2026-08-23-correctness-review.md`
- Read: `docs/superpowers/reviews/2026-08-23-rust-agent-domain.md`
- Read: `docs/superpowers/reviews/2026-08-23-reliability-and-performance-review.md`
- Read: `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`
- Read: `docs/superpowers/reviews/index.md`
- Read: `agent/fixtures/voice-protocol/v5/manifest.json`
- Read: `agent/fixtures/learning-core/turn-outcomes-v1.json`
- Read: `agent/fixtures/learning-core/recaps-v1.json`
- Read: `agent/fixtures/learning-core/question-progression-v1.json`
- Modify: none

- [ ] **Step 1: Verify every dependency document exists on the current integration base**

Run:

```bash
test -f docs/superpowers/plans/2026-08-23-expedited-critical-path.md
test -f docs/superpowers/plans/2026-08-23-learning-core-authority.md
test -f docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md
test -f docs/superpowers/plans/2026-08-23-rust-domain-integrity.md
git log -1 --format='%H %s' -- docs/superpowers/plans/2026-08-23-expedited-critical-path.md
git log -1 --format='%H %s' -- docs/superpowers/plans/2026-08-23-learning-core-authority.md
git log -1 --format='%H %s' -- docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md
git log -1 --format='%H %s' -- docs/superpowers/plans/2026-08-23-rust-domain-integrity.md
```

Expected: every `test` exits 0 and every `git log` prints a committed dependency SHA. An untracked plan or fixture is not a handoff. Also verify the coordinator's coverage ledger records Connor's selected `D-02 QUESTION_PROGRESSION` branch before starting Task 1 Step 3; while it still reads `DECISION_REQUIRED`, Task 1 RED tests may proceed but the question-progression GREEN wiring is blocked.

- [ ] **Step 2: Verify the frozen fixture versions and referenced paths**

Run:

```bash
jq -e '.schema == "viva.voice-fixtures.manifest.v1" and .protocol_version == 5 and .supported_versions == [5] and .legacy_v4_disposition == "reject"' agent/fixtures/voice-protocol/v5/manifest.json
jq -r '.fixtures[].path' agent/fixtures/voice-protocol/v5/manifest.json | while IFS= read -r fixture; do case "$fixture" in agent/fixtures/*) ;; *) exit 1 ;; esac; case "/$fixture/" in *'/../'*|*'/./'*) exit 1 ;; esac; test -f "$fixture"; done
test -f agent/fixtures/learning-core/turn-outcomes-v1.json
test -f agent/fixtures/learning-core/recaps-v1.json
test -f agent/fixtures/learning-core/question-progression-v1.json
```

Expected: all commands exit 0. Do not add fallback discovery for v4 files.

- [ ] **Step 3: Record the resampling ownership decision**

Run:

```bash
rg -n "resampl|adapter-side|agent-adapters|handoff" docs/superpowers/plans/2026-08-23-expedited-critical-path.md
```

Default decision: browser capture and stateful 44.1/48 kHz resampling remain owned by Plan 03 and Plan 10. This lane receives normalized 24 kHz PCM through the frozen v5 lifecycle and edits no browser file. Only an explicit Plan 03 statement transferring an adapter-side resampler interface activates the conditional work in Task 9.

- [ ] **Step 4: Verify the coordinator-created lane branch**

Run:

```bash
git status --short
git branch --show-current
```

Expected: the current branch is `review-remediation/07-live-adapters` (created by the coordinator from `LANE_BASE_SHA` in the `.worktrees/07-live-adapters` worktree), and the status output contains no unresolved changes to adapter-owned files. Do not create a new branch. Preserve unrelated user work. Do not make a gate-only commit.

---

### Task 1: Bind the runner to Plan 04 outcomes and Plan 06 session state (ADAPTER-01)

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- Modify: `agent/crates/agent-adapters/src/synthetic.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [ ] **Step 1: Write RED tests for evaluated and deferred outcomes**

Add these focused tests:

```rust
#[tokio::test]
async fn live_runner_emits_learning_events_only_from_persisted_turn_outcome()

#[tokio::test]
async fn deferred_turn_emits_recovery_without_mastery_schedule_or_graded_recap()

#[tokio::test]
async fn live_empty_model_output_fails_without_biology_speech_or_sonic_call()

#[tokio::test]
async fn fake_and_synthetic_runtimes_consume_learning_core_fixture_outcomes()

#[tokio::test]
async fn live_gemini_evaluator_returns_typed_model_decisions_without_grading()

#[tokio::test]
async fn live_runtime_injects_provider_evaluator_not_synthetic()

#[tokio::test]
async fn live_gemini_evaluator_rejects_provider_supplied_label()
```

The evaluated test must load a complete evaluated case from `turn-outcomes-v1.json`, make the scripted Gemini transport call `evaluate_spoken_answer`, and let the real `VivaToolExecutor` return a serialized `PersistedTurnOutcome` with exactly two top-level members: the complete persisted `TurnOutcome` under `turn_outcome`, and `TurnOutcomeRecordReceipt { schema: "viva.turn_outcome_record.v1", response_id, replayed }` under `record`. Assert that the adapter deserializes the wrapper, validates the receipt schema and matching response ID, uses only `turn_outcome` for learner facts, and emits `AnswerEvaluated` plus every `ConceptStatus` exactly as returned, including a non-`strong` transition. Give `record.response_id` a different marker value in a negative control and assert a typed contract failure occurs before any event, transition, disposition, schedule, or recap is emitted. Assert that no extra transition or review write appears.

The deferred test must load a deferred case from `turn-outcomes-v1.json`. It must assert `BrainEvent::TurnDeferred` exactly copies `response_id`, `question_id`, `EvaluationDeferralReason`, and `can_retry_same_question` from the persisted outcome, and that `AnswerEvaluated`, `ConceptStatus`, review writes, normal graded `RecapReady`, and Sonic calls are absent. Plan 08 maps that domain event to the deferred cases in Plan 05 fixture `VOICE-SERVER-TURN-OUTCOMES` (`turn-outcomes.json`); this lane must not add a wire variant.

The empty-model test must use a non-biology question and an evaluated outcome, then return a final Gemini stream containing usage/tool completion but no text. Assert a typed malformed/empty response failure, zero Sonic calls, and absence of `proton gradient`, `ATP synthase`, `oxidative-phosphorylation`, and `atp-synthase` from every emitted string.

The fake/synthetic test must prove both fixture runtimes obtain scheduling and recap facts from Plan 04 fixtures/`SyntheticFixtureAnswerEvaluator`, not adapter-local dates or term positions.

The live-evaluator test must send a complete server-bound `EvaluationRequest` through a recording Gemini HTTP transport and deserialize an explicit evaluated response containing only assessments/feedback and an explicit deferred response into `EvaluationDecision` without deriving a label, grade, status, concept ID, schedule, or recap in the adapter. A malformed, empty, incomplete-criteria, non-finite, or provider-labeled response returns typed `EvaluationError`; the Plan 04 executor is responsible for converting unavailable/invalid evaluation to a persisted deferred outcome and deriving `EvaluationLabel`. The label-rejection test injects each snake_case label string (`strong`, `mostly_correct`, `partially_correct`, `vague`, `wrong`, `insufficient_evidence`) into an otherwise valid provider `EvaluationDecision::Evaluated` JSON object and asserts every case is rejected rather than mapped or ignored. The construction-boundary test must prove the live runner receives the provider-backed evaluator and that `SyntheticFixtureAnswerEvaluator` is available only through named fake/synthetic builders, never a default or environment-controlled live fallback.

- [ ] **Step 2: Verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_runner_emits_learning_events_only_from_persisted_turn_outcome -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters deferred_turn_emits_recovery_without_mastery_schedule_or_graded_recap -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_empty_model_output_fails_without_biology_speech_or_sonic_call -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters fake_and_synthetic_runtimes_consume_learning_core_fixture_outcomes -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_gemini_evaluator_returns_typed_model_decisions_without_grading -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_runtime_injects_provider_evaluator_not_synthetic -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_gemini_evaluator_rejects_provider_supplied_label -- --nocapture
```

Expected failures on the reviewed code:

- `emit_deterministic_study_tool_events` writes `strong` and schedules a second concept regardless of the returned evaluation;
- empty Gemini output becomes the hardcoded ATP-synthase sentence and calls Sonic;
- deferred outcomes have no safe branch;
- fake/synthetic paths still derive fixture mastery/biology recap data outside the Plan 04 outcome/evidence seam.

Plan 03 may already have removed the fixed June-2026 scheduling helper before this mandatory rebase. If so, that portion is a GREEN regression guard, not RED evidence for this task; the evaluator/outcome, fabricated mastery/recap, and deferred-event assertions must still fail before Task 1 implementation.

- [ ] **Step 3: Implement the minimum authoritative-outcome flow**

Make `run_gemini_tool_loop` return a small adapter-local result containing provider response text plus the `TurnOutcome` obtained by deserializing `ToolResult.result` as `PersistedTurnOutcome`. Validate the receipt schema and require `record.response_id == turn_outcome.response_id`, but never inspect `PersistedTurnOutcome.record` for learner facts.

Implement the provider-backed `AnswerEvaluator` in `llm.rs` through the existing injectable Gemini HTTP seam; Task 4 later moves that seam onto the shared connection pool without changing evaluator semantics. Serialize only Plan 04's server-bound `EvaluationRequest`; require the provider response to deserialize into one of the two `EvaluationDecision` variants; preserve criterion IDs/assessments and explicit deferral reasons; reject any provider-supplied label field; and return typed `EvaluationError` for transport, empty, malformed, non-finite, duplicate, unknown, incomplete, or labeled output. Do not calculate or map an `EvaluationLabel`, score, or status in the adapter. Wire that evaluator into the live `VivaToolExecutor` construction path; wire `SyntheticFixtureAnswerEvaluator` only through explicit fake/synthetic constructors.

For `TurnResolution::Evaluated`:

- emit `AnswerEvaluated` only from the evaluation carried by the persisted outcome;
- emit `ConceptStatus` only by iterating the outcome's `ConceptStatusTransition` values;
- do not call `mark_concept_status` or `schedule_review_item` from the adapter;
- build the recap only through Plan 04 `session_learning_evidence` plus `build_session_recap`;
- use `QuestionDisposition`/`QuestionProgressionResult` rather than reselecting the same active question by fixture convention.

For `TurnResolution::Deferred`:

- emit `BrainEvent::TurnDeferred` with only the four Plan 04 fields;
- emit no evaluated/mastery/review facts and no normal graded recap;
- do not call Sonic.

Delete `emit_deterministic_study_tool_events` as a production learning-authority stage. Split transport/output emission from learning-event emission so source/audio/phase work cannot recreate it under a new name. Delete the empty-response biology fallback; live empty text is a typed provider failure. Fake response text must come from the fake fixture outcome/question, not a shared runner fallback.

Remove runner-level confidence defaults. `TranscriptFinal.confidence` is the provider's parsed value or `None`; typed text input also uses `None` because it is not an STT confidence score. The Plan 05 v5 fake fixture requires explicit `null`, not 0.91.

Replace raw phase sends in runner and synthetic paths with a helper backed by Plan 06 `StudySessionState`. A rejected transition becomes a typed domain failure before any invalid phase is emitted.

- [ ] **Step 4: Add negative controls**

In the tests, clone the loaded evaluated outcome and mutate its transition from `review` to `strong`; assert the parity helper rejects the mutation. Clone the deferred outcome and inject a concept transition; assert fail-closed validation rejects it. Run a live session with `active_concepts: []`; assert no fixture concept IDs are substituted.

- [ ] **Step 5: Verify GREEN and scan for the removed authorities**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_runner_emits_learning_events_only_from_persisted_turn_outcome -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters deferred_turn_emits_recovery_without_mastery_schedule_or_graded_recap -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_empty_model_output_fails_without_biology_speech_or_sonic_call -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters fake_and_synthetic_runtimes_consume_learning_core_fixture_outcomes -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_gemini_evaluator_returns_typed_model_decisions_without_grading -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_runtime_injects_provider_evaluator_not_synthetic -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_gemini_evaluator_rejects_provider_supplied_label -- --nocapture
rg -n 'emit_deterministic_study_tool_events|storage_due_at_for_status|mark_concept_status\(|schedule_review_item\(|Some\(0\.91|Some\(1\.0|Good\. Now connect the proton gradient' agent/crates/agent-adapters/src
```

Expected: all focused tests pass and the scan returns no adapter-owned learning authority, fixed due-date helper, confidence default, or shared biology fallback. Fixture data may contain biology terms only inside immutable JSON fixtures, not as live fallback code. The scan covers production and in-file `#[cfg(test)]` code alike: rewrite in-src test modules so scripted provider text comes from fixture-derived values, and write provider-supplied confidence test values as something other than the removed default literals (for example `0.42`); a remaining hit in any `src` file fails the gate.

- [ ] **Step 6: Commit**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/src/cartesia_gemini/llm.rs agent/crates/agent-adapters/src/cartesia_gemini/mod.rs agent/crates/agent-adapters/src/synthetic.rs agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "refactor(adapter): consume authoritative turn outcomes"
```

---

### Task 2: Re-emit `QuestionStarted` for every accepted turn (ADAPTER-02)

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [ ] **Step 1: Write the two-turn RED test from the frozen fixture**

Add:

```rust
#[tokio::test]
async fn fake_cartesia_two_turns_match_manifest_question_correlation()
```

Resolve the fixture through its published manifest ID `VOICE-FAKE-CARTESIA-GEMINI-TWO-TURN-SESSION` (path `agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json`) via the manifest resolver — never by bypassing it — and extract the adapter-owned event sequence. Fail the test if that ID is missing or duplicated. Complete response-1 normally, submit response-2 without barge-in, and assert:

- response-1 and response-2 each have exactly one `QuestionStarted`;
- the response IDs are distinct and equal the fixture values;
- response-2 `QuestionStarted` is the first response-bound event for response-2;
- every later response-2 transcript, outcome, source, audio, completion, and recap event carries response-2;
- no response-1 event occurs after response-2 starts except an explicitly fixture-authorized terminal event.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini fake_cartesia_two_turns_match_manifest_question_correlation -- --nocapture
```

Expected: FAIL because the current runner emits `QuestionStarted` only once during `open`.

- [ ] **Step 3: Implement the minimum correlation fix**

Move question-start emission into the per-turn acceptance path. The initial ready/question order remains `Ready -> QuestionStarted(response-1)`. For every later accepted turn, emit `QuestionStarted(new_response_id)` before recording or emitting any other response-bound event. Do not re-emit on ignored `ToolResult`, context-refresh, unsupported proactive input, `Stop`, or a cancel that creates no replacement response.

Keep `submission_sequence`, `turn_id` from the Plan 03 lifecycle, `client_generation_id`, and `response_id` correlated; do not derive one identifier from stale session state.

- [ ] **Step 4: Add a local mutation control**

Clone the expected two-turn event projection, delete response-2 `QuestionStarted`, and assert the parity helper returns an error. Mutate response-2's `response_id` to response-1 and assert the same helper returns an error. These controls must pass because rejection is expected; do not edit the frozen fixture.

- [ ] **Step 5: Verify GREEN**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini fake_cartesia_two_turns_match_manifest_question_correlation -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini fake_runtime_open_barge_in_cancels_old_response_and_accepts_new_turn -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini fake_runtime_session_completes_after_correction_phase -- --nocapture
```

Expected: all pass. Update existing barge-in expectations to require the replacement `QuestionStarted` rather than silently skipping it. The client-side staleness-guard second-turn integration proof for ADAPTER-02 is owned by Plan 10 (`apps/web/lib/viva-agent-client.ts`); this lane records the adapter-side half and links Plan 10's test in the ledger row.

- [ ] **Step 6: Commit**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "fix(adapter): correlate every provider turn"
```

---

### Task 3: Send Cartesia cancel and close controls before aborting (ADAPTER-03)

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [ ] **Step 1: Write RED lifecycle tests**

Add exact tests:

```rust
#[tokio::test]
async fn sonic_barge_in_sends_context_cancel_before_replacement_context()

#[tokio::test]
async fn sonic_timeout_sends_cancel_and_clean_close()

#[tokio::test]
async fn ink_timeout_after_connect_closes_the_socket()

#[tokio::test]
async fn cancelled_sonic_context_never_emits_audio_even_when_provider_finishes_it()
```

Use recording fake sockets with barriers, not sleeps. The Sonic barge-in record must be exactly ordered:

1. generation message(s) for `response-1`;
2. `{ "context_id": "response-1", "cancel": true }`;
3. generation message(s) for `response-2` on a fresh context.

The provider-finish negative control sends an audio chunk and `done` for response-1 after cancel, followed by a response-2 chunk. Assert only response-2 reaches `BrainEvent::AudioDelta`.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters sonic_barge_in_sends_context_cancel_before_replacement_context -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters sonic_timeout_sends_cancel_and_clean_close -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters ink_timeout_after_connect_closes_the_socket -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cancelled_sonic_context_never_emits_audio_even_when_provider_finishes_it -- --nocapture
```

Expected: FAIL because `cancel_sonic_context` is test-only, the runner aborts the task immediately, and outer timeouts drop sockets without cleanup.

- [ ] **Step 3: Implement cooperative cancellation with bounded cleanup**

Make `cancel_sonic_context` production code. Replace the active response's bare `AtomicBool + AbortHandle` cancellation path with a cooperative cancellation signal that the STT/Gemini/TTS stage can select on. On explicit cancel, barge-in, or stop:

- if a Sonic context exists, send `sonic_cancel_request(context_id)`;
- mark the context cancelled before reading any later frames;
- suppress/drain its later frames without treating them as replacement audio;
- close the provider socket on session stop, stage timeout, fatal provider error, or failed cancel/drain;
- wait only the adapter cleanup timeout, then abort the task if it cannot finish.

For Ink and Sonic, move the timeout inside the scope that owns the connected socket so timeout cleanup can call `close_quietly`. A timeout before connect has no socket to close; a timeout after connect must record a close attempt. Cleanup failure must not replace the original sanitized terminal classification.

Do not claim a Sonic cancel stops in-flight generation: provider documentation says an already-generating request may finish. Correctness comes from emitting the cancel, suppressing the cancelled context, and closing on terminal cleanup.

- [ ] **Step 4: Verify GREEN and run cancellation regressions**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters sonic_barge_in_sends_context_cancel_before_replacement_context -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters sonic_timeout_sends_cancel_and_clean_close -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters ink_timeout_after_connect_closes_the_socket -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cancelled_sonic_context_never_emits_audio_even_when_provider_finishes_it -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini fake_runtime_open_cancel_aborts_active_tool_write_before_commit -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --test cartesia_gemini fake_runtime_session_barge_in_during_sonic_audio_suppresses_old_audio -- --nocapture
```

Expected: all pass; the pre-provider answer envelope durability behavior remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/src/cartesia_gemini/stt.rs agent/crates/agent-adapters/src/cartesia_gemini/tts.rs agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "fix(adapter): cancel and close Cartesia contexts"
```

---

### Task 4: Reuse provider clients and session connections (ADAPTER-04)

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [ ] **Step 1: Write RED reuse/isolation tests**

Add:

```rust
#[tokio::test]
async fn gemini_two_pass_tool_loop_reuses_one_http_connection_pool()

#[tokio::test]
async fn sonic_two_turns_use_one_socket_and_distinct_contexts()

#[tokio::test]
async fn provider_connections_are_session_scoped_and_closed_on_stop()

#[tokio::test]
async fn dead_provider_socket_is_not_returned_to_the_next_turn()
```

For Gemini, use a local keep-alive HTTP server that counts accepted TCP connections and serves two `streamGenerateContent` requests. Assert two requests and one accepted connection. Do not test only `Arc` pointer identity.

For Sonic, use a connector with `connect_count`. Run two completed turns and assert `connect_count == 1`, two distinct context IDs, and one final close on session stop. Open a second Viva learner session and assert it receives its own provider session state rather than sharing contexts or unread frames.

For the dead-socket negative control, make the first socket close unexpectedly after response-1; assert response-2 connects a replacement and never writes to the closed socket.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters gemini_two_pass_tool_loop_reuses_one_http_connection_pool -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters sonic_two_turns_use_one_socket_and_distinct_contexts -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters provider_connections_are_session_scoped_and_closed_on_stop -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters dead_provider_socket_is_not_returned_to_the_next_turn -- --nocapture
```

Expected: FAIL because each Gemini call constructs a new `reqwest::Client` and each Cartesia stage dials and closes a new WebSocket.

- [ ] **Step 3: Implement explicit client/session ownership**

Make `ReqwestGeminiSseClient` constructible from a shared `reqwest::Client`; store it on `LiveCartesiaGeminiTransports`. Remove `ReqwestGeminiSseClient::default()` from `stream_gemini_http_with_attempt_events`. `LiveCartesiaGeminiTransports` becomes `Clone` through `Arc`, not `Copy`.

Create adapter-local session transport state when `CartesiaGeminiRunner::open` succeeds. It must not be a process-global pool keyed by learner IDs. The state owns:

- one session-duration Sonic WebSocket, with one new context ID per response and multiplex-aware routing;
- one Ink stream for the session when the Plan 03 v5 lifecycle supplies continuous turn audio to the auto-turn endpoint; otherwise an explicit short-lived Ink connection whose limitation is documented and tested, never an accidental reconnect hidden by the trait;
- connection health and a single close path invoked by Stop/session drop/fatal error.

Do not keep idle STT sockets beyond the Viva realtime session. Cartesia counts idle STT sockets against concurrency and closes idle STT/TTS sockets at documented limits.

- [ ] **Step 4: Verify GREEN**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters gemini_two_pass_tool_loop_reuses_one_http_connection_pool -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters sonic_two_turns_use_one_socket_and_distinct_contexts -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters provider_connections_are_session_scoped_and_closed_on_stop -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters dead_provider_socket_is_not_returned_to_the_next_turn -- --nocapture
```

Expected: all pass with causal counters; no test depends on a timing threshold.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/src/cartesia_gemini/llm.rs agent/crates/agent-adapters/src/cartesia_gemini/stt.rs agent/crates/agent-adapters/src/cartesia_gemini/tts.rs agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "perf(adapter): reuse live provider connections"
```

---

### Task 5: Stream Gemini SSE into Sonic and emit first audio before completion (ADAPTER-05)

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [ ] **Step 1: Write RED causal-streaming tests**

Add:

```rust
#[tokio::test]
async fn gemini_sse_emits_first_event_before_http_body_eof()

#[tokio::test]
async fn split_sse_records_are_reassembled_without_buffering_the_body()

#[tokio::test]
async fn sonic_emits_first_audio_delta_before_done()

#[tokio::test]
async fn final_gemini_text_continuations_feed_sonic_before_gemini_eof()

#[tokio::test]
async fn first_pass_or_unevaluated_text_is_never_spoken()
```

Use channels/barriers:

- the fake HTTP body yields one complete SSE record, then blocks before EOF; the test must receive the corresponding `GeminiStreamEvent` while EOF is still blocked;
- a second test splits `data: {"candidates":[{"content":{"parts":[{"text":"first safe response"}]}}]}\n\n` across arbitrary byte boundaries and proves exactly one parsed event;
- the fake Sonic socket yields one chunk, then blocks before `done`; the runner must emit `AudioDelta` while `done` is blocked;
- the final-pass pipeline yields two Gemini text parts and proves Sonic receives them as `continue: true` inputs followed by one explicit `continue: false` finalizer;
- a first-pass text part adjacent to an evaluation tool call must not reach Sonic, and a deferred/no-outcome pass must open no Sonic context.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters gemini_sse_emits_first_event_before_http_body_eof -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters split_sse_records_are_reassembled_without_buffering_the_body -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters sonic_emits_first_audio_delta_before_done -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters final_gemini_text_continuations_feed_sonic_before_gemini_eof -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters first_pass_or_unevaluated_text_is_never_spoken -- --nocapture
```

Expected: tests block or fail because `GeminiSseResponse` owns a full `String`, success uses `response.text()`, `synthesize_sonic_context` returns `Vec<AudioFrame>`, and the runner emits frames only after Sonic `done`.

- [ ] **Step 3: Implement incremental transport types**

Change the Gemini client response body from `String` to a fallible byte stream. Add a bounded incremental SSE decoder that:

- preserves incomplete UTF-8/SSE records between chunks;
- accepts CRLF and LF record boundaries;
- enforces a maximum single event size;
- emits each parsed `GeminiStreamEvent` immediately;
- keeps the existing 16 KiB bound for non-success error bodies;
- preserves fallback-attempt metadata and the one shared stage deadline.

Incremental processing makes the former inner tool-budget check live. Reserve tool stages as calls arrive, attribute any budget failure to `active_gemini.model_id`, and remove the obsolete pre-buffer batch scan and unreachable `last_rate_limit` post-loop error.

Change Sonic synthesis from `Result<Vec<AudioFrame>, BrainError>` to an adapter-local stream/callback that yields each decoded frame. The runner forwards it immediately as `BrainEvent::AudioDelta`. Feed only final-pass, post-outcome Gemini text into Sonic continuations; finish with `continue: false`. Do not wait for Gemini EOF to start a safe final response, and do not speak any first-pass/tool-planning text.

- [ ] **Step 4: Add malformed-stream and cancellation controls**

Split invalid JSON across chunks and assert one typed malformed-stream failure with no raw body text. Cancel after the first Sonic frame, then deliver more frames and `done`; assert no post-cancel frame is emitted and the provider cleanup from Task 3 still runs.

- [ ] **Step 5: Verify GREEN and prohibit re-buffering**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters gemini_sse_emits_first_event_before_http_body_eof -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters split_sse_records_are_reassembled_without_buffering_the_body -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters sonic_emits_first_audio_delta_before_done -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters final_gemini_text_continuations_feed_sonic_before_gemini_eof -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters first_pass_or_unevaluated_text_is_never_spoken -- --nocapture
rg -n 'response\.text\(\)|Result<Vec<AudioFrame>|let mut frames = Vec::new\(\)' agent/crates/agent-adapters/src/cartesia_gemini
```

Expected: all focused tests pass and the scan finds none of the removed success-path buffering forms. A bounded `Vec<u8>` for non-2xx error bodies remains allowed.

- [ ] **Step 6: Commit**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/src/cartesia_gemini/llm.rs agent/crates/agent-adapters/src/cartesia_gemini/tts.rs agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "perf(adapter): stream Gemini and Sonic incrementally"
```

---

### Task 6: Replace fake/string-classified live errors with typed failures (ADAPTER-06)

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [ ] **Step 1: Write RED typed-failure tests**

Add:

```rust
#[tokio::test]
async fn live_envelope_store_failure_is_typed_durability_degraded()

#[tokio::test]
async fn invalid_gemini_header_is_nonretryable_provider_auth_failure()

#[tokio::test]
async fn cartesia_auth_header_failures_are_nonretryable_and_stage_specific()

#[tokio::test]
async fn live_failures_never_emit_fake_provider_labels()

#[tokio::test]
async fn gemini_primary_and_fallback_http_diagnostics_are_bounded_and_redacted()

#[tokio::test]
async fn cartesia_ink_and_sonic_handshake_http_diagnostics_are_bounded_and_redacted()

#[tokio::test]
async fn cartesia_ink_and_sonic_websocket_diagnostics_are_bounded_and_redacted()
```

For the store test, make `record_answer_attempt_envelope` return the Plan 06 typed durable-store error before provider I/O. Assert failure class `DurabilityDegraded`, stage `Store`, terminal reason `DurabilityDegraded`, `retry_eligible == true`, and no provider call.

For invalid Gemini header input, call the client with a non-ASCII control value that `HeaderValue` rejects. Assert class `ProviderAuthFailure`, stage `Gemini`, `retry_eligible == false`, one attempt only, and no key bytes in `Debug`, display, metadata, or events. Repeat the status test for HTTP 401 and 403.

For Cartesia, assert invalid authorization header construction classifies at Ink or Sonic before connect and is never retried as a network disconnect.

The Gemini HTTP test must run the primary attempt and at least one fallback attempt. Each local HTTP response returns a different status and a 256 KiB body containing unique raw-body, prompt, audio, bearer-token, URL, and query-string markers. Assert the emitted failures retain the active model, typed `Gemini` stage, status-derived class/retry eligibility, safe numeric HTTP status, and one allowlisted diagnostic code, while none of either response body or any marker appears in `Debug`, `Display`, serialized failure, emitted event, or fallback event.

The Cartesia handshake test must exercise Ink and Sonic WebSocket upgrades rejected with HTTP 401, 403, 429, and 500. Give each rejection the same hostile oversized marker body and marker-bearing request URL/query. Assert source/stage remain typed as Cartesia plus `Ink` or `Sonic`; auth is not retry-eligible, rate/network failures follow the typed policy, and only the numeric status plus an allowlisted diagnostic code survive.

The connected-WebSocket test must exercise Ink and Sonic provider `error` messages and close frames. Use a standard close code with a 123-byte hostile reason containing transcript, prompt, audio, token, URL, and query markers; also inject an unknown provider error code containing those markers. Assert only the numeric close code or normalized provider-error category survives, the close reason/raw provider code is discarded, and no emitted metadata exceeds Plan 06's 240-byte bound.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_envelope_store_failure_is_typed_durability_degraded -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters invalid_gemini_header_is_nonretryable_provider_auth_failure -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_auth_header_failures_are_nonretryable_and_stage_specific -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_failures_never_emit_fake_provider_labels -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters gemini_primary_and_fallback_http_diagnostics_are_bounded_and_redacted -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_ink_and_sonic_handshake_http_diagnostics_are_bounded_and_redacted -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_ink_and_sonic_websocket_diagnostics_are_bounded_and_redacted -- --nocapture
```

Expected: FAIL because generic runner errors call `emit_fake_provider_error`, the envelope write has no failure taxonomy, and Gemini primary-attempt sanitization erases the auth cause into a retryable connection failure.

- [ ] **Step 3: Construct failures at the source**

Consume Plan 06 `BrainFailureClass`, `BrainFailureStage`, private `BrainProviderFailure` accessors, and `BrainError::Failure`. Delete live message-substring classification (`provider_failure_classification` and store-message durability scanning). Map known facts directly:

- missing/invalid credential or HTTP 401/403 -> provider auth, `retry_eligible = false`;
- HTTP 429/quota -> rate/quota, `retry_eligible = true` under the existing bounded fallback policy;
- connect/read close -> network disconnect, `retry_eligible = true`;
- provider/schema/SSE parse -> malformed stream, retryability from the typed policy;
- explicit timeout -> timeout, `retry_eligible = true`;
- executor/store durable failure -> durability degraded, store stage;
- user cancellation -> cancellation, without converting it into an incident error event.

Give `CartesiaGeminiTransports` an explicit live-versus-fixture mode or error-emission method so generic runner code cannot accidentally choose the fake emitter. Retain fake wording only inside `FakeCartesiaGeminiTransports`/fake runtime tests. Live `BrainProviderError` must be built from the typed failure and sanitized accessors.

- [ ] **Step 4: Implement bounded allowlisted provider metadata and leak controls**

Add one adapter-local metadata builder shared by `llm.rs`, `stt.rs`, and `tts.rs`. It accepts only typed source/stage, optional numeric HTTP status or WebSocket close code, retry eligibility, and one closed diagnostic enum. Its serialized metadata must be at most 240 bytes and use only canonical ASCII keys. The closed codes are:

- `gemini_http_auth`, `gemini_http_rate_limited`, `gemini_http_rejected`;
- `cartesia_ink_http_auth`, `cartesia_ink_http_rate_limited`, `cartesia_ink_http_rejected`, `cartesia_ink_ws_closed`, `cartesia_ink_provider_error`;
- `cartesia_sonic_http_auth`, `cartesia_sonic_http_rate_limited`, `cartesia_sonic_http_rejected`, `cartesia_sonic_ws_closed`, `cartesia_sonic_provider_error`.

Do not accept a free-form diagnostic-code string. Never pass an HTTP error body, WebSocket close reason, provider error message/code, request URL/query, prompt, transcript, answer, audio/base64, token/header, or raw transport error into `BrainProviderFailureParts`, metadata, event messages, or fallback events. A known HTTP status may survive only as its integer; a WebSocket close may survive only as its integer close code. Unknown provider diagnostics collapse to the stage-specific `*_provider_error`, `*_http_rejected`, or `*_ws_closed` code.

Inject unique API-key, transcript, answer, provider-body, database-DSN, prompt, audio, URL, and query markers into every tested error source. Serialize each emitted error/failure/fallback event and assert no marker occurs. Assert typed source, stage, status-or-close-code, retry eligibility, and the allowlisted diagnostic code remain so redaction does not destroy classification.

- [ ] **Step 5: Verify GREEN and prohibit string classification**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_envelope_store_failure_is_typed_durability_degraded -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters invalid_gemini_header_is_nonretryable_provider_auth_failure -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_auth_header_failures_are_nonretryable_and_stage_specific -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_failures_never_emit_fake_provider_labels -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters gemini_primary_and_fallback_http_diagnostics_are_bounded_and_redacted -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_ink_and_sonic_handshake_http_diagnostics_are_bounded_and_redacted -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_ink_and_sonic_websocket_diagnostics_are_bounded_and_redacted -- --nocapture
rg -n 'emit_fake_provider_error|provider_failure_classification|port_error_is_durability_degraded|fake provider turn failed' agent/crates/agent-adapters/src/cartesia_gemini
```

Expected: tests pass. Scan results are confined to an explicitly fake-only function/module and fake tests; no generic/live call site or message classifier remains. Every primary/fallback HTTP and Ink/Sonic HTTP/WS failure exposes only typed source/stage/status-or-close-code/retry eligibility plus a closed diagnostic code, with metadata at most 240 bytes.

- [ ] **Step 6: Commit**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/src/cartesia_gemini/llm.rs agent/crates/agent-adapters/src/cartesia_gemini/stt.rs agent/crates/agent-adapters/src/cartesia_gemini/tts.rs agent/crates/agent-adapters/src/cartesia_gemini/mod.rs agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "fix(adapter): emit typed live provider failures"
```

---

### Task 7: Encode STT URLs and remove fabricated confidence (ADAPTER-07)

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [ ] **Step 1: Write RED URL/confidence tests**

Add:

```rust
#[test]
fn ink_endpoint_percent_encodes_every_query_value_without_parameter_injection()

#[test]
fn ink_numeric_environment_values_fail_closed_when_malformed()

#[tokio::test]
async fn transcript_confidence_is_provider_value_or_explicit_unknown()
```

Set `language` to `en US#fragment`, `min_volume` to `0.05&language=de`, and `max_silence_duration_secs` to `0.7?model=forged`. Parse the resulting URL and assert there is exactly one of each required query key and the decoded values equal the original strings; no injected `language=de` or `model=forged` pair exists.

For environment parsing, set the numeric fields to `NaN`, `inf`, `-0.1`, and `0.7&x=1` in isolated config tests. Assert invalid values are rejected or the documented safe defaults remain; do not silently accept operator-controlled query syntax.

For confidence, run fake v5, live Ink with `None`, and live Ink with a provider numeric value. Assert v5 fake emits explicit unknown, live unknown remains unknown, and the numeric value is preserved exactly. Mutate numeric values to NaN, -0.1, and 1.1 and assert fail-closed rejection.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters ink_endpoint_percent_encodes_every_query_value_without_parameter_injection -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters ink_numeric_environment_values_fail_closed_when_malformed -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters transcript_confidence_is_provider_value_or_explicit_unknown -- --nocapture
```

Expected: URL injection values corrupt the current formatted query, env values remain free-form strings, and fake/live runner defaults invent confidence.

- [ ] **Step 3: Implement typed URL construction**

Build the endpoint with `reqwest::Url`/URL query-pair APIs rather than `format!`. Parse `min_volume` and `max_silence_duration_secs` into finite bounded numeric config values in `from_env`, then serialize through query pairs. Preserve keys in headers, never URLs.

Keep confidence optional throughout `InkEvent -> InkTranscript -> RunnerTranscript -> BrainEvent`. Parse it only when the provider event schema supplies a finite value in `[0, 1]`; otherwise use `None`. Do not use text-input certainty as an STT score.

- [ ] **Step 4: Verify GREEN**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters ink_endpoint_percent_encodes_every_query_value_without_parameter_injection -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters ink_numeric_environment_values_fail_closed_when_malformed -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters transcript_confidence_is_provider_value_or_explicit_unknown -- --nocapture
```

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/stt.rs agent/crates/agent-adapters/src/cartesia_gemini/mod.rs agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "fix(adapter): validate STT configuration and confidence"
```

---

### Task 8: Remove dead branches and unused dependencies (ADAPTER-08)

**Files:**
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/Cargo.toml`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

- [ ] **Step 1: Write characterization and reachability tests**

Add:

```rust
#[tokio::test]
async fn exhausted_rate_limit_attempts_return_the_last_typed_failure()

#[tokio::test]
async fn streamed_final_pass_tool_call_reports_the_promoted_active_model()

#[test]
fn gemini_request_carries_only_server_trusted_source_context()
```

The rate-limit test covers primary plus all fallbacks and asserts the final typed failure and all fallback events without relying on an unreachable post-loop return. The final-pass test first promotes a fallback, then streams a forbidden final-pass tool call and asserts failure metadata names the promoted model. The source-context test proves the runner uses the authorized question/source context through `push_user_text_with_source_context` and does not admit browser-provided source data.

- [ ] **Step 2: Verify the characterization tests and capture current unused dependencies**

`cargo +nightly udeps` needs a nightly toolchain and the cargo-udeps binary. If not installed, first run `rustup toolchain install nightly` and `cargo install cargo-udeps --locked`; if installation is impossible in this environment, run `cargo machete agent/crates/agent-adapters` as the dependency linter and record the substitution in the ledger evidence. The same bootstrap or recorded substitution applies to every later `cargo +nightly udeps` invocation in this plan.

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters exhausted_rate_limit_attempts_return_the_last_typed_failure -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters streamed_final_pass_tool_call_reports_the_promoted_active_model -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters gemini_request_carries_only_server_trusted_source_context -- --nocapture
cargo +nightly udeps --manifest-path agent/Cargo.toml -p agent-adapters --all-targets
```

Expected: at least the promoted-model/source-context tests fail or reveal the dead path; `cargo udeps` reports `base64`, `thiserror`, `tracing`, and `uuid` unused. `tokio-util` may remain only if Task 3 uses `CancellationToken`; otherwise it must also be removed.

- [ ] **Step 3: Simplify after the streaming refactor**

Delete the unreachable `last_rate_limit`/post-loop branch and structure attempts around the guaranteed primary config. Keep one reachable, streamed per-call budget check using `active_gemini.model_id`; delete the obsolete full-vector preflight duplicate. Wire `push_user_text_with_source_context` to the server-authorized question source; if Plan 04's `EvaluationRequest` already injects the identical context into Gemini and the method is redundant, delete the method plus trusted-source declaration together. Do not leave an uncalled half-integration.

Remove every dependency that remains unused after Tasks 1-7. Do not keep `tracing` on the theory that spans may be useful later; either add actual sanitized provider-stage spans with tests in this task or remove it. This plan chooses removal. Keep `tokio-util` only for the concrete cancellation token implementation from Task 3.

- [ ] **Step 4: Verify GREEN and dependency honesty**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters exhausted_rate_limit_attempts_return_the_last_typed_failure -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters streamed_final_pass_tool_call_reports_the_promoted_active_model -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters gemini_request_carries_only_server_trusted_source_context -- --nocapture
cargo +nightly udeps --manifest-path agent/Cargo.toml -p agent-adapters --all-targets
cargo clippy --manifest-path agent/Cargo.toml -p agent-adapters --all-targets -- -D warnings
```

Expected: all tests pass; `cargo udeps` reports no unused normal dependency; clippy passes without unreachable/dead-code allowances added for this work.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/llm.rs agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/Cargo.toml agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "chore(adapter): remove dead provider scaffolding"
```

---

### Task 9: Resolve the resampling boundary exactly once (ADAPTER-09)

**Files:**
- Default branch: modify no files
- Conditional transfer only: modify `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs` and adapter tests
- Never modify: `apps/web/lib/viva-audio-capture.ts` or any web test

- [ ] **Step 1: Execute the Plan 03 ownership decision**

If Plan 03 did not explicitly publish an adapter-owned resampler seam, run:

```bash
git diff --name-only -- apps/web/lib/viva-audio-capture.ts apps/web/lib/viva-audio-capture.test.ts
```

Expected: no output. Mark the conditional steps below `N/A — Plan 03/Plan 10 browser-owned` and proceed to Task 10. The adapter consumes the frozen v5 24 kHz PCM lifecycle as supplied.

- [ ] **Step 2: Conditional RED tests only if Plan 03 transferred the seam**

If and only if the handoff explicitly makes resampling adapter-owned, add adapter-local tests:

```rust
#[test]
fn stateful_resampler_preserves_45_second_duration_at_44100_to_24000()

#[test]
fn stateful_resampler_preserves_phase_across_irregular_callback_boundaries()

#[test]
fn stateful_resampler_matches_one_shot_and_chunked_output_at_48000_to_24000()
```

Use a 45-second deterministic sine signal, irregular input chunks `[127, 128, 255, 64, 511]`, and one continuous resampler instance. Assert output length differs from the exact rational target by at most one sample, boundary phase does not reset, and chunked output matches one-shot output within the documented quantization tolerance. A negative control must reset the resampler per chunk and prove the test detects the known drift.

- [ ] **Step 3: Conditional implementation**

Implement a session/turn-owned resampler in `stt.rs` that carries fractional source position and the prior boundary sample. Reset only at the lifecycle boundary Plan 03 specifies, never per incoming chunk. Do not create another browser resampler and do not change protocol sample-rate semantics.

- [ ] **Step 4: Conditional verification and commit**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters stateful_resampler_preserves_45_second_duration_at_44100_to_24000 -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters stateful_resampler_preserves_phase_across_irregular_callback_boundaries -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters stateful_resampler_matches_one_shot_and_chunked_output_at_48000_to_24000 -- --nocapture
git add agent/crates/agent-adapters/src/cartesia_gemini/stt.rs agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "fix(adapter): preserve streaming resampler phase"
```

Do not create this commit when the task is N/A.

---

### Task 10: Lock fixture parity and differential controls (ADAPTER-10)

**Files:**
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`
- Read only: `agent/fixtures/voice-protocol/v5/manifest.json`
- Read only: `agent/fixtures/voice-protocol/v5/auth-decision.json`
- Read only: `agent/fixtures/voice-protocol/v5/client-session-config-signed.json`
- Read only: `agent/fixtures/voice-protocol/v5/client-session-refresh.json`
- Read only: `agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json`
- Read only: `agent/fixtures/voice-protocol/v5/turn-intents.json`
- Read only: `agent/fixtures/voice-protocol/v5/turn-outcomes.json`
- Read only: `agent/fixtures/voice-protocol/v5/server-ready.json`
- Read only: `agent/fixtures/voice-protocol/v5/terminal-sequences.json`
- Read only: `agent/fixtures/voice-protocol/v5/transport-outcomes.json`
- Read only: `agent/fixtures/voice-protocol/v5/synthetic-two-turn-session.json`
- Read only: `agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json`
- Read only: `agent/fixtures/voice-protocol/v5/client-differential-cases.json`
- Read only: `agent/fixtures/voice-protocol/v5/server-differential-cases.json`
- Read only: `agent/fixtures/session-token/v1/vectors.json`
- Read only: `agent/fixtures/learning-core/turn-outcomes-v1.json`
- Read only: `agent/fixtures/learning-core/recaps-v1.json`
- Read only: `agent/fixtures/learning-core/question-progression-v1.json`

All six tests named in Step 1, the manifest resolver, mutation helpers, and the `#[cfg(test)]` PCM helper are added only to `agent/crates/agent-adapters/tests/cartesia_gemini.rs`. Create no additional unit-test module, fixture, snapshot, or helper file in this task.

- [ ] **Step 1: Add one manifest-driven parity harness**

Add an adapter-test helper that loads `agent/fixtures/voice-protocol/v5/manifest.json`, validates schema/version/disposition, resolves a fixture by exact manifest ID, and returns the referenced JSON. It must fail for duplicate IDs, path escape outside `agent/fixtures`, missing paths, wrong kind, v4 envelopes, or any envelope version other than 5.

Add:

```rust
#[test]
fn adapter_fixture_manifest_is_strict_v5_and_complete()

#[tokio::test]
async fn synthetic_two_turn_adapter_projection_matches_voice_fixture()

#[tokio::test]
async fn fake_cartesia_two_turn_adapter_projection_matches_voice_fixture()

#[test]
fn adapter_consumes_voice_differential_cases_without_redefining_diagnostics()

#[test]
fn adapter_consumes_learning_core_v1_outcomes_recaps_and_progression()

#[test]
fn adapter_pcm16_fixture_helper_rejects_odd_byte_length()
```

Project only adapter-owned `BrainEvent` semantics from the frozen server fixtures; do not duplicate the service's wire-envelope mapper in this crate. Compare event kind, turn/response correlation, outcome resolution, confidence nullability, cancellation/terminal ordering relevant to the runner, and fixture-specified learner facts.

Keep the PCM fixture helper inside adapter test code under `#[cfg(test)]`. Prove that it accepts an even byte sequence, rejects an odd sequence before constructing `AudioFrame`, and that production adapter code uses Plan 06's byte/base64 constructors plus borrowed `pcm16_base64()` accessor. Do not restore `AudioFrame::from_pcm16_text` or add a fixtures feature to `agent-domain`.

- [ ] **Step 2: Add mutation controls inside the tests**

Clone fixture values in memory and assert the parity/differential helpers reject each mutation:

- version 5 -> 4;
- second-turn response ID -> first-turn response ID;
- remove second `QuestionStarted`;
- `confidence: null` -> `0.91` in fake Cartesia fixture;
- deferred outcome plus injected `concept_status`;
- provider auth retryable false -> true;
- cancellation context ID -> replacement context ID;
- evaluated outcome transition/status or recap bucket changed from the Plan 04 fixture.

The source fixtures remain untouched.

- [ ] **Step 3: Verify focused parity**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters adapter_fixture_manifest_is_strict_v5_and_complete -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters synthetic_two_turn_adapter_projection_matches_voice_fixture -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters fake_cartesia_two_turn_adapter_projection_matches_voice_fixture -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters adapter_consumes_voice_differential_cases_without_redefining_diagnostics -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters adapter_consumes_learning_core_v1_outcomes_recaps_and_progression -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters adapter_pcm16_fixture_helper_rejects_odd_byte_length -- --nocapture
```

Expected: all pass, including controls whose success means the mutation was rejected.

- [ ] **Step 4: Commit the parity harness**

```bash
git add agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "test(adapter): lock provider fixture parity"
```

- [ ] **Step 5: Preserve the immutable fixture boundary**

Run:

```bash
git diff --name-only review-remediation/integration...HEAD -- agent/fixtures/voice-protocol agent/fixtures/learning-core
```

Expected: no output. This command compares against the lane's merge-base with the integration branch, not `main`; upstream Plan 03-06 work merged into `review-remediation/integration` must not appear as this lane's edits. If fixture parity is wrong, return the failing projection and mutation evidence to the Plan 04 or Plan 05 owner; do not edit either fixture tree.

---

### Task 11: Extract provider responsibilities along invariant boundaries (ADAPTER-11)

**Files:**
- Create: `agent/crates/agent-adapters/src/cartesia_gemini/session.rs`
- Create: `agent/crates/agent-adapters/src/cartesia_gemini/projection.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/stt.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/tts.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/mod.rs`
- Modify: `agent/crates/agent-adapters/tests/cartesia_gemini.rs`

This task starts only after Tasks 1-10 are GREEN. It is an invariant-guided extraction, not a line-count exercise: there is no file-size target, and the extraction commit may not alter event order/payloads, provider requests, fallback choice, retry policy, timeout/cancel/close behavior, outcome projection, or public adapter construction.

- [ ] **Step 1: Freeze GREEN characterization before moving code**

Add:

```rust
#[tokio::test]
async fn two_turn_live_orchestration_trace_is_stable_across_extraction()

#[tokio::test]
async fn evaluated_deferred_cancel_and_error_projection_trace_is_stable()

#[tokio::test]
async fn primary_fallback_ink_and_sonic_call_trace_is_stable()

#[test]
fn adapter_module_dependency_direction_is_enforced()
```

The first trace must use the frozen two-turn voice and learning fixtures and record the ordered domain-event projection: variant, phase, turn/response/question identity, outcome resolution, source identity, audio sequence/context, cancellation, and terminal state. The second trace covers one evaluated outcome, one durable deferred outcome, one barge-in, one typed HTTP failure, and one typed WebSocket close without snapshotting raw provider strings. The provider-call trace records only stage, attempt ordinal, selected model, Sonic context/continuation/finalizer, cancel/close, and call count. Serialize each trace canonically and assert exact values in code before extraction; do not write generated snapshots into Plan 04/05 fixture trees.

The dependency-direction test must enforce the post-extraction contract described in Step 4. Before modules exist, encode the rules in a helper that accepts an explicit module/source map and prove one negative control per forbidden edge is rejected; after extraction, run it against the real source files.

- [ ] **Step 2: Verify and commit the characterization-only baseline**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters two_turn_live_orchestration_trace_is_stable_across_extraction -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters evaluated_deferred_cancel_and_error_projection_trace_is_stable -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters primary_fallback_ink_and_sonic_call_trace_is_stable -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters adapter_module_dependency_direction_is_enforced -- --nocapture
git add agent/crates/agent-adapters/tests/cartesia_gemini.rs
git commit -m "test(adapter): freeze provider responsibility traces"
```

Expected: all characterization tests pass against the behavior-fixed pre-extraction code. This is intentionally GREEN characterization, not a fabricated RED test.

- [ ] **Step 3: Extract responsibilities without changing semantics**

Use these exact ownership boundaries:

- `session.rs` owns open/turn acceptance, per-turn correlation, active response state, cooperative cancellation, stage deadlines, session stop/drop, and the single bounded cleanup path;
- `llm.rs` owns Gemini HTTP/SSE decoding, primary/fallback attempts, the provider-backed `AnswerEvaluator`, and typed Gemini failure construction; it emits no `BrainEvent` and owns no session phase;
- `stt.rs` owns Ink URL/request/socket/transcript behavior and typed Ink failure construction; it emits no learning event;
- `tts.rs` owns the session Sonic socket, response contexts, continuations/finalizer, cancel/drain/close, incremental `AudioFrame` delivery, and typed Sonic failure construction; it emits no learning outcome or phase;
- `projection.rs` is provider-I/O-free and converts persisted `TurnOutcome`, source/audio results, and legal `StudySessionState` transitions into domain events; it never parses provider JSON or constructs HTTP/WebSocket requests;
- `runner.rs` remains the thin orchestration layer that orders durable admission, evaluator/tool execution, transport streams, projection, and cleanup through the extracted interfaces. It does not decode SSE/WebSocket frames, build provider URLs/headers, classify raw transport messages, or recreate learner facts.

Move code along those boundaries. Prefer private structs/enums and crate-private traits; do not add a generic framework or duplicate provider state merely to shrink `runner.rs`. Do not change any characterization/parity expectation in this step. If moving code exposes a semantic defect, stop, add a separate RED/GREEN behavior task before this extraction, and return to the last GREEN extraction base.

- [ ] **Step 4: Run structural negative controls and identical-trace proof**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-adapters two_turn_live_orchestration_trace_is_stable_across_extraction -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters evaluated_deferred_cancel_and_error_projection_trace_is_stable -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters primary_fallback_ink_and_sonic_call_trace_is_stable -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters adapter_module_dependency_direction_is_enforced -- --nocapture
rg -n 'reqwest|tokio_tungstenite|InkSocket|SonicSocket|GeminiSse' agent/crates/agent-adapters/src/cartesia_gemini/projection.rs
rg -n 'BrainEvent|StudySessionState|TurnOutcome' agent/crates/agent-adapters/src/cartesia_gemini/llm.rs agent/crates/agent-adapters/src/cartesia_gemini/stt.rs agent/crates/agent-adapters/src/cartesia_gemini/tts.rs
rg -n 'parse_ink|parse_sonic|parse_sse|streamGenerateContent|websocket_endpoint|authorization' agent/crates/agent-adapters/src/cartesia_gemini/runner.rs
```

Expected: all four tests pass with the exact pre-extraction traces. All three scans return no forbidden responsibility edge. The dependency test's deliberately mutated source maps are rejected, proving the test would catch a boundary regression.

- [ ] **Step 5: Commit the semantic-no-op extraction**

```bash
git add agent/crates/agent-adapters/src/cartesia_gemini/session.rs agent/crates/agent-adapters/src/cartesia_gemini/projection.rs agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/src/cartesia_gemini/llm.rs agent/crates/agent-adapters/src/cartesia_gemini/stt.rs agent/crates/agent-adapters/src/cartesia_gemini/tts.rs agent/crates/agent-adapters/src/cartesia_gemini/mod.rs
git commit -m "refactor(adapter): separate provider responsibilities"
```

The commit contains no fixture/test expectation update and no behavior change. Review it as moves plus private interface rewiring; a smaller file is not acceptance evidence.

- [ ] **Step 6: Run the full adapter and workspace gate**

```bash
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml -p agent-adapters --all-targets -- -D warnings
cargo test --manifest-path agent/Cargo.toml -p agent-adapters --all-targets -- --nocapture
cargo +nightly udeps --manifest-path agent/Cargo.toml -p agent-adapters --all-targets
VIVA_ALLOW_LOOPBACK_TEST_SKIP=1 cargo test --manifest-path agent/Cargo.toml --workspace
bun run validate
git diff --check
```

Expected: all commands pass on one combined tree. Default tests make no provider network call and require no live keys.

- [ ] **Step 7: Run boundary and removed-scaffolding scans**

```bash
git diff --name-only review-remediation/integration...HEAD
rg -n 'Good\. Now connect the proton gradient|Some\(0\.91|storage_due_at_for_status|emit_deterministic_study_tool_events|fake provider turn failed' agent/crates/agent-adapters/src
rg -n 'response\.text\(\)|Result<Vec<AudioFrame>|from_pcm16_text' agent/crates/agent-adapters/src/cartesia_gemini agent/crates/agent-adapters/src/synthetic.rs
git diff --name-only review-remediation/integration...HEAD -- agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts agent/crates/agent-service/src/ws.rs agent/crates/agent-domain/src/tool_executor.rs agent/fixtures apps/web agent/crates/data
```

The two `git diff` commands compare against the lane's merge-base with `review-remediation/integration`, not `main`, so upstream Plan 03-06 work already merged into the integration branch never counts as this lane's edits.

Expected:

- the first list contains only adapter-owned files and this plan's authorized commits;
- removed-scaffolding/buffering scans return no hit in any `src` file — these scans cover production and in-file `#[cfg(test)]` code alike, so in-src test modules must use fixture-derived provider text and non-default confidence literals (for example `0.42`);
- the forbidden-boundary diff returns no output.

- [ ] **Step 8: Prepare the exact handoff**

Handoff to the integration owner with:

- branch `review-remediation/07-live-adapters` and every commit SHA in order;
- the Plan 03/04/05/06 dependency SHAs used;
- SHA-256 hashes of `voice-protocol/v5/manifest.json` and all three learning-core v1 fixtures;
- focused/full command results from Task 10 Steps 3-5 and Task 11 Steps 2, 4, 6, and 7;
- the ADAPTER-01 through ADAPTER-11 coverage table marked pass/fail with evidence test names;
- before/after canonical trace hashes proving the extraction changed no event or provider-call semantics;
- explicit resampling disposition: `Plan 03/10 browser-owned` or the transferred adapter interface and conditional commit SHA;
- explicit remaining evidence gap: local/fake transports prove semantics, cancellation, reuse, and causal streaming, but real Cartesia/Gemini behavior remains unverified until the separately authorized live smoke runs against the exact integrated deploy.

Do not edit Plan 04/05 fixtures during handoff. If fixture parity is wrong, return the failing projection and mutation evidence to the owning lane.

---

## Final acceptance gate

The adapter lane is complete only when all of the following are true on the same integrated tree:

- Live learner facts and recap data come only from Plan 04 persisted `TurnOutcome`/`SessionLearningEvidence`.
- Deferred/empty/uncertain decisions create no mastery, review schedule, graded recap, or unrelated speech.
- Every turn starts with its own correlated `QuestionStarted` and matches the frozen two-turn fixture.
- Explicit cancel/barge-in sends Cartesia context cancel, suppresses late cancelled audio, and closes on terminal cleanup/timeout.
- One shared reqwest pool and session-scoped provider sockets pass causal reuse/isolation tests.
- Gemini and Sonic deliver first safe events before stream completion; success paths no longer buffer full bodies/audio.
- Auth errors are typed and nonretryable; durable-store errors are typed durability failures; primary/fallback HTTP and Cartesia Ink/Sonic HTTP/WS failures expose only typed fields plus bounded allowlisted metadata; live events contain no fake-provider label or secrets.
- STT URLs cannot inject query parameters and confidence is provider-supplied or explicit unknown.
- Session, Gemini evaluation/streaming, Ink, Sonic streaming/cancellation, and event projection are separated along enforced dependency directions; before/after traces prove the extraction is a semantic no-op rather than a size-only split.
- `cargo udeps`, clippy, adapter tests, the Rust workspace, `bun run validate`, fixture differentials, and mutation controls all pass.
- No forbidden protocol/domain/service/data/web/fixture file was edited by this lane.
- Completion is reported as local/integrated adapter proof, not as live-provider proof; release/live confidence remains blocked until exact-deploy hosted evidence exists.
