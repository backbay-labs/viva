# Rust Domain Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent-domain` enforce legal session state, sanitized and exhaustively typed failures, fail-closed persistence contracts, bounded answer evidence, fixture-safe audio construction, a selector-correct typed deletion-restore seam, and a machine-checked no-I/O/dependency policy.

**Architecture:** `agent-domain` remains the I/O-free owner of state, validation, failure, and port contracts. Adapters classify failures and validate phase emissions through these domain types; the service consumes typed terminal/durability decisions without substring parsing; stores implement explicit write outcomes and typed errors. If and only if D-04 selects `SOFT_DELETE_UNDO`, the domain also publishes validated soft-delete/restore values and fail-closed restore/finalizer ports; `CONFIRM_DELETE` compiles no such surface. This plan does not change learning authority, provider behavior, HTTP policy, or persistence implementation: Plans 04, 07, 08, and 09 consume the interfaces published here.

**Tech Stack:** Rust 2021, serde, thiserror, async-trait, Tokio channel/task handles, proptest, trybuild, Cargo metadata, cargo-udeps, cargo-mutants, Bun/Node test scripts.

**Spec:** `docs/superpowers/reviews/2026-08-23-rust-agent-domain.md`, `docs/superpowers/reviews/2026-08-23-architecture-review.md`, `docs/superpowers/reviews/2026-08-23-quality-and-tests-review.md`, and `docs/superpowers/reviews/2026-08-23-security-review.md`, reconciled against their cited Rust, shell, workflow, and manifest code on 2026-08-23.

---

## Global Constraints

### Findings closed here

| ID | Disposition | Contract/proof |
| --- | --- | --- |
| `DOMAIN-001` | `TESTED_FIX` | `agent:purity` inspects the domain dependency boundary and forbidden imports; Luca residue is a separately named gate. |
| `DOMAIN-002` | `TESTED_FIX` | Plan 06 integrates Plan 04 learning events/ports/exports/fixtures, then direct table/property/mutation tests pin every Plan 06 boundary. Plan 04 owns tool-executor grading, binding, recap, and scheduling tests. |
| `DOMAIN-003` | `TESTED_FIX` | One transition table plus an absorbing terminal state rejects illegal and post-terminal phase emission. |
| `DOMAIN-004` | `TESTED_FIX` | `BrainProviderFailure` fields are private; construction and custom deserialization both sanitize and validate. |
| `DOMAIN-005` | `BATCH_FIX` | Plan 04's one `study.rs` terminal-reason declaration generates serde strings, `as_str`, and `ALL`; Plan 06 parity-tests it and derives close text from the wire string. Date/scheduler duplication (both duplicate `storage_due_at_for_status` helpers) is Plan 03-owned under `CRIT-SCHED-01`, per ledger row `DOMAIN-MULTIPLAN-TERMINAL-SCHEDULE-01`. |
| `DOMAIN-006` | `TESTED_FIX` | Truth-bearing `StudyMemoryStore` defaults fail closed; session/usage writes return observable outcomes and typed errors. |
| `DOMAIN-007` | `BATCH_FIX` | Text-as-PCM is absent from the production API; every `AudioFrame` caches base64 once and returns it by reference. |
| `DOMAIN-008` | `TESTED_FIX` | `DigestOnly` requires a shape-valid digest; capture counts and duration are positive, mode-consistent, and bounded. |
| `DOMAIN-009` | `TESTED_FIX` | Brain/store failures are classified by enums at the domain boundary; Plans 07/08 delete message-substring classification. |
| `DOMAIN-010` | `BATCH_FIX` | A required unused-dependency gate detects stale Cargo entries; Plan 07 removes the five already-confirmed adapter dependencies. |
| `DOMAIN-011` | `TESTED_FIX`, conditional on D-04 | `CONFIRM_DELETE` compile-proves no restore types/ports; `SOFT_DELETE_UNDO` publishes exact validated receipt/input/outcome types plus fail-closed restore/finalizer ports for Plans 08/09. |

`DOMAIN-009`/`DOMAIN-010`/`DOMAIN-011` are plan-local task IDs; their ledger canonical rows are Agent-service R7 (`DOMAIN-009` alias), `ADAPTER-08` (Plan 07 owns removal; this plan owns only the gate), and the D-04 chain `DATA-016`/`SERVICE-018`/`WEBAPI-016`/`FRONTEND-004` respectively — the coordinator credits those rows, not new `DOMAIN-01x` rows.

### Decisions that are no longer blocked

1. `AnswerContentPolicy::DigestOnly` means exactly one durable content trace: `answer_digest_hmac` is required and is 64 lowercase hexadecimal characters (HMAC-SHA256 hex). `AnswerContentPolicy::None` forbids a digest.
2. Answer evidence bounds are domain constants: `MAX_ANSWER_BYTE_COUNT = 2_160_000` (45 seconds × 24,000 Hz × 2 PCM16 bytes), `MAX_ANSWER_CHAR_COUNT = 65_536`, and `MAX_ANSWER_DURATION_MS = 45_000`. Present counts must be non-zero. Audio byte counts must be even; typed capture requires both byte and character counts; audio capture forbids character counts.
3. Every truth-bearing default on `StudyMemoryStore` returns `PortErrorKind::Unavailable`. Capability/count defaults may still report unavailable/zero because they are observations, not claims that a read or write succeeded.
4. `record_voice_session` and `record_voice_usage` return `StudyStoreWriteOutcome`. Session writes may return `IdempotentReplay`; usage has no stable event key and therefore always returns `Inserted` after a successful insert. This plan does not invent false usage idempotency.
5. `TerminalSessionReason::as_str()` is the canonical terminal token. Serde names are generated from the same declaration. `close_reason()` is derived from `as_str()` and returns `String`.
6. Provider/store classification is data, not prose. Raw error messages remain diagnostics only and cannot select a terminal reason, retry policy, durability path, HTTP status, or alert class.
7. `D-04 DELETION_UX` is read only from the central coverage ledger and must equal `CONFIRM_DELETE` or `SOFT_DELETE_UNDO`. The former exposes no restore/finalizer domain API; the latter exposes the exact `viva.soft_delete_receipt.v1` and `viva.restore_study_set_outcome.v1` contracts in Task 3A. Missing, duplicate, or unresolved selection is a hard stop.
8. `D-03 MODE_GOAL_CONTRACT` is read only from the central coverage ledger and must equal `D-03A` or `D-03B`. Task 1A executes exactly the selected Plan 04 `LEARN-005A`/`LEARN-005B` domain-side handoff in Plan 06-owned files; an unrecorded D-03 blocks only Task 1A, never the decision-independent Tasks 0–8, and Task 1A's commit may land in this lane's second integration PR under the program's two-PR single-lane pattern.

### Hard ownership boundaries

- **Never modify:** `agent/crates/agent-domain/src/{study,tools,tool_executor}.rs`. Plan 04 permanently owns those files after Plan 03, plus its new learning modules/tests/fixtures.
- **Plan 04 owns:** `EvaluationRequest`, `AnswerEvaluator`, `EvaluationDecision::{Evaluated, Deferred}`, `EvaluationLabel`, validated `TurnOutcome`, `TurnOutcomeRecordReceipt`, `PersistedTurnOutcome`, `SessionLearningEvidence`, recap/progression policy, `BoundLearningIntentV1`, `SessionLearningPolicy`, `AuthenticatedStudyProjectionV1`, and the implementations that create those facts. The selected Plan 03 `review_schedule.rs` or `review_history.rs` remains the only D-01 v1 type/algorithm seam. Plan 06 consumes these contracts only through `brain.rs`, `ports.rs`, `lib.rs`, and `protocol_fixtures.rs` integration.
- **Plan 05 owns:** `agent/crates/agent-service/src/protocol.rs` and the protocol-v5 wire fixtures, including the lossless nonterminal `turn_deferred` mapping. Plan 06 publishes only the domain event.
- **Plan 07 owns:** `agent/crates/agent-adapters/**`, including runner/synthetic/STT/TTS/LLM call-site migrations and removal of unused adapter dependencies.
- **Plan 08 owns:** `agent/crates/agent-service/src/{ws,app,main,config,lib}.rs`; it consumes typed phases/failures/store errors and, only under D-04 `SOFT_DELETE_UNDO`, owns restore HTTP/finalizer runtime behavior. This plan does not modify `protocol.rs`.
- **Plan 09 owns:** `agent/crates/data/**`, `agent/crates/observe/**`, and migrations; it implements the port signatures and database constraints.
- **Plan 12 owns:** root `package.json`, `.github/workflows/validate.yml`, tool installation, and required-job wiring. This plan publishes commands and tests their combined-tree presence but does not edit or stage those files.
- **Plan 15 owns:** `README.md`, `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and final public claims. This plan publishes exact documentation facts but does not edit or stage those files.
- **Plan 06 owns:** `agent/crates/agent-domain/src/{brain,ports,lib,session_state}.rs`, conditional `agent/crates/agent-domain/src/deletion.rs`, `agent/crates/agent-domain/Cargo.toml`, `agent/crates/agent-domain/tests/protocol_fixtures.rs`, the Plan-06-specific tests/fixtures below, purity/residue scripts, and local semantic policy tests. Consumer and owner-file work is specified as a handoff, not silently folded into this plan.

### Published interfaces for Plans 04/05/07/08/09

```rust
pub enum BrainFailureClass {
    DeployDrain,
    SessionCap,
    TurnCap,
    LocalRateLimit,
    CostBudget,
    ProviderAuthFailure,
    QuotaRateFailure,
    Timeout,
    MalformedStream,
    NetworkDisconnect,
    SlowClient,
    Cancellation,
    PartialStageSuccess,
    DurabilityDegraded,
    ToolExecutorFailure,
    Rollback,
}

pub enum BrainFailureStage {
    Session,
    Store,
    Tools,
    Recap,
    Gemini,
    Provider,
    ProviderAuth,
    Websocket,
    Transport,
    PreLoop,
    Startup,
    SessionAuth,
    Deployment,
    Rollback,
}

pub struct BrainProviderFailureParts {
    pub failure_class: BrainFailureClass,
    pub stage: BrainFailureStage,
    pub retry_eligible: bool,
    pub latency_ms: u64,
    pub provider: String,
    pub model: String,
    pub metadata: String,
}

pub enum BrainError {
    Failure(Box<BrainProviderFailure>),
}

pub enum PortErrorKind {
    Unavailable,
    InvalidInput,
    Conflict,
    Durability,
    Internal,
}

#[must_use]
pub enum StudyStoreWriteOutcome {
    Inserted,
    IdempotentReplay,
}

async fn record_voice_session(
    &self,
    config: &SessionConfig,
) -> Result<StudyStoreWriteOutcome, PortError>;

async fn record_voice_usage(
    &self,
    event: VoiceUsageRecord,
) -> Result<StudyStoreWriteOutcome, PortError>;
```

Only when the recorded D-04 selector is `SOFT_DELETE_UNDO`, Task 3A additionally publishes private-field/custom-deserialized `SoftDeleteReceiptV1`, `RestoreStudySetInputV1`, `RestoreStudySetOutcomeKindV1::{Restored, AlreadyRestored}`, and `RestoreStudySetOutcomeV1`, plus:

```rust
async fn restore_study_set(
    &self,
    input: RestoreStudySetInputV1,
) -> Result<RestoreStudySetOutcomeV1, PortError>;

async fn finalize_expired_study_set_deletions(
    &self,
    limit: usize,
) -> Result<usize, PortError>;
```

Under `CONFIRM_DELETE`, none of these types or methods is declared or exported.

`BrainFailureClass::terminal_reason()` is exhaustive over the 16 current `TerminalSessionReason` variants. `BrainProviderFailure` exposes read-only accessors named `failure_class`, `stage`, `terminal_reason`, `retry_eligible`, `latency_ms`, `provider`, `model`, and `metadata`. `PortError` exposes `kind`, `port`, `id`, `reason`, and `is_durability`; its fields are private.

The current domain has no pre-existing failure-class or failure-stage enum to preserve: `BrainError` is a set of prose-bearing variants and `BrainProviderFailure` stores class/stage as `String`. The declarations above replace those string fields. Their serde tokens are the exact current runtime vocabulary: `deploy_drain`, `session_cap`, `turn_cap`, `local_rate_limit`, `cost_budget`, `provider_auth_failure`, `quota_rate_failure`, `timeout`, `malformed_stream`, `network_disconnect`, `slow_client`, `cancellation`, `partial_stage_success`, `durability_degraded`, `tool_executor_failure`, and `rollback`; stages are `session`, `store`, `tools`, `recap`, `gemini`, `provider`, `provider_auth`, `websocket`, `transport`, `pre_loop`, `startup`, `session_auth`, `deployment`, and `rollback`. Protocol-only observability labels such as `pending_evaluation`, `pre_loop_unavailable`, `session_bootstrap_unavailable`, and `session_auth_failure` (the pre-session admission classification at `ws.rs:2276`) do not become domain failure classes; Plan 08 keeps those non-terminal/pre-session protocol signals separate from typed `BrainError` classification.

`BrainProviderError` remains the protocol-compatible diagnostic envelope because `protocol.rs` is out of scope. Its `failure: Option<BrainProviderFailure>` is never classification authority by itself: production terminal paths in Plans 07/08 must populate `Some`, and `require_failure()` returns a typed `MissingTypedFailure` error for `None`. Plan 08 converts that invariant breach to an explicit typed `Rollback` failure and never examines `source` or `message`. The only permitted `failure: None` construction after integration is the structured-error serialization fixture inside `protocol.rs`.

This plan adds no `VoiceSessionRecord` and no timestamp or ordering field. `SessionConfig` remains the input to `record_voice_session`; Plan 09 owns database timestamps/order. Typed study-context reads defer to Plan 04's `AuthenticatedStudyProjectionV1` rather than introducing a competing domain projection here.

---

### Task 0: Integrate Plan 04 Learning Contracts Through Plan 06-Owned Boundaries (`DOMAIN-002`)

**Disposition:** `TESTED_FIX`; this task integrates authority owned by Plan 04 and does not redefine it.

**Files:**
- Modify: `agent/crates/agent-domain/src/brain.rs`
- Modify: `agent/crates/agent-domain/src/ports.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Modify: `agent/crates/agent-domain/tests/protocol_fixtures.rs`
- Read only: `agent/crates/agent-domain/src/{study,tools,tool_executor,learning_outcome,learning_recap,learning_progression,study_projection,review_schedule,review_history}.rs` (exactly one selected review module exists)
- Read only: `agent/crates/agent-domain/tests/learning_core.rs` (lands with Plan 04's `04b` node, after this lane merges)
- Read only: `agent/fixtures/learning-core/*.json`

- [ ] **Step 1: Record the exact Plan 03/04 source prerequisites and write RED integration assertions**

Require the coordinator-recorded Plan 03 selected D-01 scheduling commit. The Plan 04 module/fixture declarations below are decision-neutral type surface and are part of Plan 04's `04a` additive integration node per program Section 6 (not `04b`); Plan 04's `tests/learning_core.rs` rides only in `04b` and is deliberately not required on the tip for this task — this task's witnessed RED is the `protocol_fixtures` compile/test failure below. After `git fetch --all --prune && git rebase review-remediation/integration`, verify each exact path exists on the integration tip — `agent/crates/agent-domain/src/{learning_outcome,learning_recap,learning_progression,study_projection}.rs` and the four fixtures below. If any is missing, escalate to the coordinator (the `04a` node definition in program Section 6 names exactly these paths); do not proceed and do not substitute:

- `agent/fixtures/learning-core/turn-outcomes-v1.json`
- `agent/fixtures/learning-core/recaps-v1.json`
- `agent/fixtures/learning-core/question-progression-v1.json`
- `agent/fixtures/learning-core/study-projection-v1.json`

In Plan 06-owned `protocol_fixtures.rs`, add tests named `shared_turn_outcomes`, `shared_recaps`, `shared_question_progression`, and `shared_study_projection`. Each test deserializes the full canonical fixture into the Plan 04 type and asserts its exact schema discriminator; none redeclares a wire-only mirror. `shared_turn_outcomes` also enumerates the fixture's evaluated resolutions and proves every label deserializes through `EvaluationLabel`, round-trips as exactly `strong`, `mostly_correct`, `partially_correct`, `vague`, `wrong`, or `insufficient_evidence`, and is paired with rubric policy literal `viva.semantic-rubric.v1` rather than a free string. For each negative control, clone the included fixture into an in-memory `serde_json::Value`, inject an unknown key, and assert the Plan 04 deserializer/validator rejects it. Preserve the Plan 03 selected scheduling-conformance parser/test. Also complete Plan 05's legacy-fixture handoff in this file: migrate every reference to `fixtures/voice-protocol/session-config.json` to `fixtures/voice-protocol/v5/client-session-config-signed.json` — Plan 05 deletes the eleven legacy root fixtures after Plans 06/07/08/09/10 confirm their migrations, so no unversioned root fixture path may remain in `protocol_fixtures.rs`.

Add a `turn_deferred_is_a_typed_non_mastery_event` test that constructs the exact event below and asserts `response_id() == Some("response-deferred-1")`, with no `AnswerEvaluation`, `ConceptStatus`, schedule, recap, provider message, or generic JSON payload field.

- [ ] **Step 2: Run the combined prerequisite tests to verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_ -- --nocapture
```

Expected: Plan 04's source types exist, but the build is RED because Plan 06 has not declared/exported their modules, added the required `StudyMemoryStore` methods, or added `BrainEvent::TurnDeferred`. Plan 04's `tests/learning_core.rs` rides in `04b` (after this lane merges) and is not part of this RED; its combined run happens in Task 8's post-integration supplement. If a Plan 04 type/fixture itself is absent, return that defect to Plan 04 instead of creating a substitute in an owned file.

- [ ] **Step 3: Declare and export Plan 04 modules without moving their authority**

In `lib.rs`, declare Plan 04's modules and re-export the exact public seam:

```rust
pub mod learning_outcome;
pub mod learning_progression;
pub mod learning_recap;
pub mod study_projection;

pub use learning_outcome::{
    AnswerEvaluator, ChallengeDisposition, ChallengeResolution, ConceptStatusTransition,
    CriterionAssessment, CriterionAssessmentKind, EvaluationDecision, EvaluationDeferralReason,
    EvaluationError, EvaluationLabel, EvaluationRequest, EvaluationRubricV1, PersistedTurnOutcome,
    QuestionDisposition, RubricCriterionV1, TurnOutcome, TurnOutcomeRecordReceipt,
    TurnResolution,
};
pub use learning_progression::{
    ProgressionPolicyId, QuestionProgressionCursor, QuestionProgressionResult,
};
pub use learning_recap::{
    build_session_recap, ConceptLabel, RecapBuildError, RecapConceptOutcome,
    ReviewScheduleAuthority, ReviewScheduleSummary, SessionLearningEvidence, StudySessionRecap,
};
pub use study_projection::AuthenticatedStudyProjectionV1;
```

`EvaluationError` is the Plan 04-owned exhaustive enum `Unavailable | Timeout | MalformedResponse | ContractViolation` and contains no provider text. Plan 04 maps `Unavailable`/`Timeout` to `EvaluationDeferralReason::EvaluatorUnavailable` and `MalformedResponse`/`ContractViolation` to `InvalidEvaluatorOutput`; Plan 06 only re-exports it.

`EvaluationLabel` is the Plan 04-owned exhaustive snake_case enum `Strong | MostlyCorrect | PartiallyCorrect | Vague | Wrong | InsufficientEvidence`. `TurnResolution::Evaluated.label` is this enum, never `String`; Plan 04 alone derives it under literal policy `viva.semantic-rubric.v1` and its locked confidence/status/label boundaries. Plan 06 only re-exports and fixture-parses it.

`TurnOutcomeRecordReceipt` is the Plan 04-owned validated record receipt with the exact fields `schema: "viva.turn_outcome_record.v1"`, `response_id`, and `replayed`. `PersistedTurnOutcome` contains exactly `{ turn_outcome: TurnOutcome, record: TurnOutcomeRecordReceipt }`. Plan 06 re-exports both and uses the persisted wrapper as the successful store result; it does not derive `replayed` from prose or reconstruct either value at a consumer boundary.

Remove `StudySessionRecap` from `lib.rs`'s old `study` re-export list and export the Plan 04 `learning_recap::StudySessionRecap` shown above. Keep `StudyQuestion` on the existing `study` path after Plan 04 adds `concept_id` and `rubric`. Do not expose both recap versions under the same root name.

Preserve and re-export the selected Plan 03 D-01 types from its existing `review_schedule` or `review_history` module; do not create a second scheduler/history type. If Plan 04's compiled type list differs from this published handoff, stop and reconcile Plan 04 rather than adding aliases that hide drift.

- [ ] **Step 4: Add the branch-neutral atomic learning ports with fail-closed defaults**

In `StudyMemoryStore`, import Plan 04's types and add exactly:

```rust
async fn record_turn_outcome(
    &self,
    _user_id: &str,
    _study_set_id: &str,
    voice_session_id: &str,
    _outcome: TurnOutcome,
) -> Result<PersistedTurnOutcome, PortError> {
    Err(PortError::unavailable(
        "study_memory_store",
        voice_session_id,
        "record_turn_outcome is not implemented",
    ))
}

async fn session_learning_evidence(
    &self,
    _user_id: &str,
    _study_set_id: &str,
    voice_session_id: &str,
) -> Result<SessionLearningEvidence, PortError> {
    Err(PortError::unavailable(
        "study_memory_store",
        voice_session_id,
        "session_learning_evidence is not implemented",
    ))
}

async fn record_challenge_resolution(
    &self,
    _user_id: &str,
    _study_set_id: &str,
    voice_session_id: &str,
    _resolution: ChallengeResolution,
) -> Result<ChallengeResolution, PortError> {
    Err(PortError::unavailable(
        "study_memory_store",
        voice_session_id,
        "record_challenge_resolution is not implemented",
    ))
}

async fn select_next_question(
    &self,
    _user_id: &str,
    _study_set_id: &str,
    voice_session_id: &str,
    _response_id: &str,
    _policy: ProgressionPolicyId,
) -> Result<QuestionProgressionResult, PortError> {
    Err(PortError::unavailable(
        "study_memory_store",
        voice_session_id,
        "select_next_question is not implemented",
    ))
}

async fn authenticated_study_projection(
    &self,
    _user_id: &str,
    _study_set_id: &str,
    voice_session_id: &str,
) -> Result<AuthenticatedStudyProjectionV1, PortError> {
    Err(PortError::unavailable(
        "study_memory_store",
        voice_session_id,
        "authenticated_study_projection is not implemented",
    ))
}
```

These are intentional fail-closed compatibility boundaries for partial/test stores, not RED-only scaffolding and not acceptable production behavior. There is no successful default. Plan 03's selected D-01 port remains byte-for-byte authoritative. Plan 09 overrides all branch-neutral methods and the selected scheduling method for memory/Postgres.

- [ ] **Step 5: Add the one deferred event Plan 04 requires**

In `brain.rs`, add:

```rust
BrainEvent::TurnDeferred {
    response_id: String,
    question_id: String,
    reason: EvaluationDeferralReason,
    can_retry_same_question: bool,
}
```

Add this variant to `BrainEvent::response_id()`. Do not add a second evaluated-outcome event: Plans 04/07 derive the existing `AnswerEvaluated` and `ConceptStatus` events only from the persisted `TurnOutcome`. `TurnDeferred` carries no provider prose, feedback, confidence, status, schedule, or mastery.

- [ ] **Step 6: Verify GREEN on the combined Plan 03/04/06 tree**

Run:

```bash
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures -- --nocapture
cargo clippy --manifest-path agent/Cargo.toml -p agent-domain --all-targets -- -D warnings
```

Expected: PASS. Temporarily remove the `TurnDeferred` `response_id()` arm and verify the direct event test fails before restoring it. The in-memory unknown-field mutations are rejected without editing Plan 04-owned fixtures. Plan 04's `tests/learning_core.rs` lands in `04b` after this lane merges; once it is on the tree, Task 8's post-integration supplement additionally runs `cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core -- --nocapture`.

- [ ] **Step 7: Commit only Plan 06-owned integration files**

Run:

```bash
git add agent/crates/agent-domain/src/brain.rs agent/crates/agent-domain/src/ports.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/protocol_fixtures.rs
git commit -m "feat(agent-domain): integrate authoritative learning contracts"
```

**Handoff to Plan 04:** source types, algorithms, learning tests, and fixtures remain Plan 04-owned; its GREEN proof must name this Plan 06 commit as a combined-tree prerequisite.

**Handoff to Plans 05/07/08/09:** Plan 05 maps the domain event losslessly to its nonterminal `turn_deferred` protocol-v5 fixture. Plan 07 emits existing evaluated/status events only from `PersistedTurnOutcome.turn_outcome`, emits `TurnDeferred` for deferred resolution, and returns the exact persisted `{ turn_outcome, record }` pair as the tool result without fabricating `record.replayed`. Plan 08 handles that event explicitly in `ws.rs` provider-turn accounting and never invents learner facts or edits `protocol.rs`. Plan 09 overrides every new port, returns `PersistedTurnOutcome` from the same atomic outcome write, sets `record.schema` to `viva.turn_outcome_record.v1`, copies the validated outcome `response_id`, derives `record.replayed` from insert-versus-idempotent-replay truth, and preserves atomic outcome/transition/disposition/cursor behavior plus the selected D-01 authority. It adds `memory_learning_ports_override_fail_closed_defaults` and ignored `postgres_learning_ports_override_fail_closed_defaults`: each seeds the canonical learning fixtures, invokes all five methods, rejects any `PortErrorKind::Unavailable`, and asserts the complete returned `PersistedTurnOutcome` against the canonical outcome and expected receipt.

---

### Task 1: Enforce Session Transitions and One Terminal-Reason String Authority (`DOMAIN-003`, `DOMAIN-005`)

**Disposition:** `TESTED_FIX` for transitions; `BATCH_FIX` for string deduplication.

**Files:**
- Handoff prerequisite, Plan 04 modifies: `agent/crates/agent-domain/src/study.rs`
- Create: `agent/crates/agent-domain/src/session_state.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Create: `agent/crates/agent-domain/tests/session_state.rs`

- [ ] **Step 1: Receive and verify the exact Plan 04 `study.rs` prerequisite**

Plan 04 makes `StudySessionPhase` `Copy` and replaces the three manually synchronized terminal-reason representations with one declaration that generates the enum serde token, `TerminalSessionReason::ALL`, `as_str()`, `close_reason()`, and `Display`. It uses all 16 existing variants and wire strings without renaming any token:

```rust
macro_rules! define_terminal_session_reasons {
    ($( $variant:ident => $wire:literal ),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        pub enum TerminalSessionReason {
            $(#[serde(rename = $wire)] $variant),+
        }

        impl TerminalSessionReason {
            pub const ALL: [Self; define_terminal_session_reasons!(@count $($variant),+)] = [
                $(Self::$variant),+
            ];

            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }

            pub fn close_reason(self) -> String {
                self.as_str().replace('_', " ")
            }
        }
    };
    (@count $($variant:ident),+) => { <[()]>::len(&[$(define_terminal_session_reasons!(@one $variant)),+]) };
    (@one $variant:ident) => { () };
}
```

`Display` writes `as_str()` and adds no second match. Plan 04 provides the exact source commit containing this change. Before Plan 06 writes `session_state.rs`, run:

```bash
rg -n 'pub const ALL|pub const fn as_str|pub fn close_reason|impl .*Display.*TerminalSessionReason' agent/crates/agent-domain/src/study.rs
```

Expected: all four generated/public surfaces are present. Plan 04's `learning_core` suite covering them lands in `04b` and runs in Task 8's post-integration supplement, not here. Plan 06 does not edit or stage `study.rs`.

- [ ] **Step 2: Write the failing exhaustive transition and string-parity tests**

Create `tests/session_state.rs`. Enumerate all 36 ordered phase pairs, not only happy-path examples:

```rust
use agent_domain::{
    StudySessionPhase, StudySessionState, StudySessionTransitionError, TerminalSessionReason,
};

const PHASES: [StudySessionPhase; 6] = [
    StudySessionPhase::Ready,
    StudySessionPhase::Listening,
    StudySessionPhase::Thinking,
    StudySessionPhase::Feedback,
    StudySessionPhase::Correction,
    StudySessionPhase::Recap,
];

const LEGAL: [(StudySessionPhase, StudySessionPhase); 6] = [
    (StudySessionPhase::Ready, StudySessionPhase::Listening),
    (StudySessionPhase::Listening, StudySessionPhase::Thinking),
    (StudySessionPhase::Thinking, StudySessionPhase::Feedback),
    (StudySessionPhase::Feedback, StudySessionPhase::Correction),
    (StudySessionPhase::Correction, StudySessionPhase::Listening),
    (StudySessionPhase::Correction, StudySessionPhase::Recap),
];

#[test]
fn transition_table_is_exhaustive() {
    for from in PHASES {
        for to in PHASES {
            assert_eq!(
                from.can_transition_to(to),
                LEGAL.contains(&(from, to)),
                "unexpected transition {from:?} -> {to:?}",
            );
        }
    }
}

#[test]
fn terminal_state_is_absorbing() {
    let mut state = StudySessionState::ready();
    state.terminate(TerminalSessionReason::ProviderTimeout).unwrap();

    for next in PHASES {
        assert!(matches!(
            state.transition(next),
            Err(StudySessionTransitionError::AlreadyTerminal {
                reason: TerminalSessionReason::ProviderTimeout,
            })
        ));
    }
    assert!(matches!(
        state.terminate(TerminalSessionReason::Rollback),
        Err(StudySessionTransitionError::AlreadyTerminal {
            reason: TerminalSessionReason::ProviderTimeout,
        })
    ));
}

#[test]
fn terminal_tokens_serialize_from_one_authority() {
    for reason in TerminalSessionReason::ALL {
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            serde_json::Value::String(reason.as_str().to_owned()),
        );
        assert_eq!(reason.close_reason(), reason.as_str().replace('_', " "));
    }
}
```

Add cases proving `restart_after_cancellation()` moves `Listening`, `Thinking`, `Feedback`, or `Correction` back to `Listening`, but rejects `Recap` and any terminal state. This explicit method prevents a general backward transition from being treated as legal.

- [ ] **Step 3: Run the tests to verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test session_state
```

Expected: FAIL: the test target does not compile because `StudySessionState`, `StudySessionTransitionError`, and `can_transition_to` do not exist. (The terminal token/parity assertions live in the same file so the GREEN run in Step 5 witnesses them together; they cannot pass independently at RED time.)

- [ ] **Step 4: Implement the state machine in the Plan 06-owned module**

Create `src/session_state.rs`, import `StudySessionPhase` and `TerminalSessionReason` from Plan 04's module, and add the exact legal transition match from the test as an inherent implementation on the same-crate type. Add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StudySessionState {
    phase: StudySessionPhase,
    terminal_reason: Option<TerminalSessionReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum StudySessionTransitionError {
    #[error("illegal study session phase transition: {from:?} -> {to:?}")]
    Illegal {
        from: StudySessionPhase,
        to: StudySessionPhase,
    },
    #[error("study session is already terminal: {reason}")]
    AlreadyTerminal { reason: TerminalSessionReason },
}
```

`ready()` begins at `Ready`; `transition()` applies only the six pairs above; `restart_after_cancellation()` rejects `Ready`/`Recap`, resets other active phases to `Listening`, and rejects a terminal state; `terminate(reason)` sets phase `Recap` plus the reason; all mutators return the resulting phase or the typed error. Add read-only `phase()`, `terminal_reason()`, and `is_terminal()` accessors.

Put the phase table in `session_state.rs`, not `study.rs`:

```rust
impl StudySessionPhase {
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Ready, Self::Listening)
                | (Self::Listening, Self::Thinking)
                | (Self::Thinking, Self::Feedback)
                | (Self::Feedback, Self::Correction)
                | (Self::Correction, Self::Listening)
                | (Self::Correction, Self::Recap)
        )
    }
}
```

Do not redeclare Plan 04 learning types, terminal strings, or phase variants in this module.

- [ ] **Step 5: Export and verify GREEN**

Declare `mod session_state;` and export `StudySessionState` plus `StudySessionTransitionError` from `lib.rs`. Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test session_state
cargo clippy --manifest-path agent/Cargo.toml -p agent-domain --all-targets -- -D warnings
```

Expected: PASS. A mutation that allows `Ready -> Recap`, permits any transition after `terminate`, or changes a serde token is killed by the table/parity tests.

- [ ] **Step 6: Commit only the Plan 06-owned files**

Run:

```bash
git add agent/crates/agent-domain/src/session_state.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/session_state.rs
git commit -m "feat(agent-domain): enforce study session transitions"
```

**Handoff to Plan 04:** own `StudySessionPhase: Copy` plus the single `TerminalSessionReason` declaration/strings in `study.rs`; return its source commit before Plan 06 RED/GREEN execution.

**Handoff to Plans 07/08:** Plan 07 keeps one `StudySessionState` beside each adapter event stream and calls the state method before sending a phase. Plan 08 keeps the final emission-boundary state, derives implicit `InputSpeechStarted`/`Stopped` phases through it, uses `terminate(reason)` for terminal phase emission, and borrows the now-owned `String` when closing the WebSocket. Neither consumer may carry a second phase table.

---

### Task 1A: Execute the Selected D-03 Domain Binding (`LEARN-005` Handoff)

**Disposition:** decision-gated integration of Plan 04's selected `LEARN-005A`/`LEARN-005B` handoff. Execute exactly one branch. This task binds or removes mode/goal surface only in Plan 06-owned files; Plan 04 permanently owns `BoundLearningIntentV1`, `SessionLearningPolicy`, `StudyMode`, and every policy/algorithm behind them. An unrecorded D-03 blocks only this task: complete the rest of the plan and land this task's commit in the lane's second integration PR when Connor records the selector.

**Files (both branches):**
- Modify: `agent/crates/agent-domain/src/brain.rs`
- Modify: `agent/crates/agent-domain/src/session_state.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Modify: `agent/crates/agent-domain/tests/protocol_fixtures.rs`

- [ ] **Step 1: Read the recorded D-03 selector and stop on every non-executable state**

Run the Task 3A Step 1 checkpoint pattern against the `D-03` registry/recording rows, accepting only `D-03A` or `D-03B`:

```bash
git fetch --all --prune
git rebase review-remediation/integration
D03_MODE_GOAL="$(bun -e '
  const text = await Bun.file("docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md").text();
  const selectors = new Set();
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", ""));
    if (cells.length === 0) continue;
    if (cells[0] === "D-03" && (cells[2] === "D-03A" || cells[2] === "D-03B")) selectors.add(cells[2]);
    if (cells[0] === "D-03 MODE_GOAL_CONTRACT" && (cells[1] === "D-03A" || cells[1] === "D-03B")) selectors.add(cells[1]);
  }
  if (selectors.size !== 1) process.exit(64);
  console.log([...selectors][0]);
')" || {
  echo "BLOCKED: D-03 MODE_GOAL_CONTRACT is not recorded as an executable selector" >&2
  exit 64
}
```

Expected: print exactly `D-03A` or `D-03B`. Do not infer the branch from existing code, Plan 04's tree, or fixtures. The recorded selection lives in the coordinator's ledger commits on the integration branch; the `LANE_BASE_SHA` snapshot may predate it.

- [ ] **Step 2A (`D-03A` only): Bind the server-bound intent through Plan 06-owned files**

Run the RED witness first; it must fail while the binding is absent:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core bound_intent_ -- --nocapture
```

Then modify `brain.rs` and `session_state.rs` so `AuthorizedStudySession` receives only the server-bound `BoundLearningIntentV1` and never trusts `SessionConfig.mode`/`initial_goal` after admission; add `pub use study::{BoundLearningIntentV1, SessionLearningPolicy};` to the `lib.rs` export seam; and update `protocol_fixtures.rs` to parse the bound intent through the Plan 04 types without redeclaring them. Verify GREEN on the combined tree containing Plan 04's `LEARN-005A` commit:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core bound_intent_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core mode_policy_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures -- --nocapture
```

Expected: PASS; a forged client mode/goal cannot survive admission. Commit only the four owned files:

```bash
git add agent/crates/agent-domain/src/brain.rs agent/crates/agent-domain/src/session_state.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/protocol_fixtures.rs
git commit -m "feat(agent-domain): bind server-issued learning intent"
```

Skip Step 2B completely.

- [ ] **Step 2B (`D-03B` only): Remove unsupported mode and goal surface from Plan 06-owned files**

Run the RED witness first; it must fail while the removal is absent:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core quiz_only_ -- --nocapture
```

Then remove `Teach`, `Mock`, `Cram`, and `initial_goal` from `brain.rs` and any `session_state.rs` public session contract, keep only `StudyMode::Quiz` on the `lib.rs` export seam, and update the `protocol_fixtures.rs` parser to the single-mode contract. Verify GREEN on the combined tree containing Plan 04's `LEARN-005B` commit:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core quiz_only_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures -- --nocapture
rg -n 'initial_goal|StudyMode::(Teach|Mock|Cram)' agent/crates/agent-domain/src
```

Expected: tests PASS and the search returns no matches. Commit only the four owned files:

```bash
git add agent/crates/agent-domain/src/brain.rs agent/crates/agent-domain/src/session_state.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/protocol_fixtures.rs
git commit -m "refactor(agent-domain): expose one quiz session contract"
```

**Handoff to Plan 04:** `study.rs`/`tool_executor.rs` mode/goal authority, the `bound_intent_`/`quiz_only_` learning tests, and fixture updates remain Plan 04-owned; its selected-branch GREEN names this Plan 06 commit as a combined-tree prerequisite. Plans 08/10/11/13 own their `LEARN-005` consumer handoffs; Plan 06 publishes only this domain seam.

---

### Task 2: Make Failure Construction Sanitized, Typed, and Exhaustive (`DOMAIN-004`, `DOMAIN-009`)

**Disposition:** `TESTED_FIX`.

**Files:**
- Modify: `agent/crates/agent-domain/src/brain.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Create: `agent/crates/agent-domain/tests/failure_contract.rs`
- Create: `agent/crates/agent-domain/tests/compile_fail.rs`
- Create: `agent/crates/agent-domain/tests/ui/brain_provider_failure_struct_literal.rs`
- Create: `agent/crates/agent-domain/tests/ui/brain_provider_failure_struct_literal.stderr`
- Modify: `agent/crates/agent-domain/Cargo.toml`

- [ ] **Step 1: Write RED tests for enum classification, hostile deserialization, and private fields**

Add `trybuild = "1"` and `proptest = "1"` under `[dev-dependencies]` in the domain manifest. In `failure_contract.rs`, assert all 16 class-to-terminal mappings and exact `as_str()` values. Add a custom-deserialization adversary:

```rust
#[test]
fn hostile_failure_wire_values_are_sanitized_or_rejected() {
    let value = serde_json::json!({
        "failure_class": "timeout",
        "stage": "gemini",
        "terminal_reason": "provider_timeout",
        "retry_eligible": true,
        "latency_ms": 42,
        "provider": "gemini\nBearer secret-token",
        "model": "model🔥/../../raw_prompt",
        "metadata": "http_status=503\nraw_prompt=<secret> bearer.token",
    });
    let failure: agent_domain::BrainProviderFailure = serde_json::from_value(value).unwrap();

    assert_eq!(failure.failure_class(), agent_domain::BrainFailureClass::Timeout);
    assert_eq!(failure.stage(), agent_domain::BrainFailureStage::Gemini);
    assert_eq!(failure.terminal_reason(), TerminalSessionReason::ProviderTimeout);
    assert!(!failure
        .provider()
        .chars()
        .any(|character| matches!(character, '\n' | ' ')));
    assert!(failure.provider().len() <= 96);
    assert!(!failure.model().contains('🔥'));
    assert!(!failure.metadata().contains('\n'));
    assert!(failure.metadata().len() <= 240);
}
```

Add a mismatch case whose class is `timeout` but terminal reason is `provider_auth_failed`; custom deserialization must reject it. Add proptest cases generating arbitrary Unicode for provider/model/metadata and asserting the allowlists and byte/character caps after construction and deserialization.

Also add a `brain_usage_add_saturates_at_u64_max` test to `failure_contract.rs` with hand-derived expectations; this pins the ledger's `DOMAIN-002` saturation contract, which no other test covers. For each of the seven `BrainUsage` counters (`audio_input_tokens`, `cached_audio_input_tokens`, `audio_output_tokens`, `text_input_tokens`, `cached_text_input_tokens`, `text_output_tokens`, `source_grounded_correction_count`), start at `u64::MAX - 1`, add a usage with that counter set to `2`, and assert the result is exactly `u64::MAX` while every other counter is unchanged; include one normal-arithmetic row (for example `40 + 2 == 42`). This is a characterization pin of behavior that already saturates: its enforcement proof is the mutation control in the Acceptance matrix, not a RED run.

Also assert that `BrainProviderError::from_failure(failure).require_failure()` returns that typed failure, while deserializing the legacy protocol shape with no `failure` makes `require_failure()` return `BrainProviderErrorClassificationError::MissingTypedFailure`. This pins the protocol compatibility exception without letting absence become a message-classification fallback.

`compile_fail.rs` runs:

```rust
#[test]
fn failure_fields_cannot_be_bypassed_with_a_struct_literal() {
    trybuild::TestCases::new()
        .compile_fail("tests/ui/brain_provider_failure_struct_literal.rs");
}
```

The UI case attempts to populate every `BrainProviderFailure` field directly. Its checked-in stderr must fail on private fields, not on an unrelated missing import.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test failure_contract --test compile_fail
```

Expected: FAIL because classes/stages/accessors do not exist, public fields still permit a struct literal, and derived `Deserialize` bypasses sanitation.

- [ ] **Step 3: Introduce typed class/stage declarations and derive the terminal reason**

Use the same single-declaration pattern Plan 04 publishes for terminal reasons to define `BrainFailureClass` and `BrainFailureStage`, generating `ALL`, explicit serde names, and `as_str()`. `BrainFailureClass::terminal_reason()` must match every variant exactly:

```rust
impl BrainFailureClass {
    pub const fn terminal_reason(self) -> TerminalSessionReason {
        match self {
            Self::DeployDrain => TerminalSessionReason::Drained,
            Self::SessionCap => TerminalSessionReason::SessionCap,
            Self::TurnCap => TerminalSessionReason::TurnCap,
            Self::LocalRateLimit => TerminalSessionReason::RateLimit,
            Self::CostBudget => TerminalSessionReason::CostBudget,
            Self::ProviderAuthFailure => TerminalSessionReason::ProviderAuthFailed,
            Self::QuotaRateFailure => TerminalSessionReason::ProviderRateLimited,
            Self::Timeout => TerminalSessionReason::ProviderTimeout,
            Self::MalformedStream => TerminalSessionReason::ProviderMalformedStream,
            Self::NetworkDisconnect => TerminalSessionReason::ProviderNetworkDisconnect,
            Self::SlowClient => TerminalSessionReason::SlowClient,
            Self::Cancellation => TerminalSessionReason::ProviderCancelled,
            Self::PartialStageSuccess => TerminalSessionReason::PartialStageSuccess,
            Self::DurabilityDegraded => TerminalSessionReason::DurabilityDegraded,
            Self::ToolExecutorFailure => TerminalSessionReason::ToolExecutorFailure,
            Self::Rollback => TerminalSessionReason::Rollback,
        }
    }
}
```

`BrainProviderFailureParts` takes the typed class/stage and no longer accepts `terminal_reason`; the class is the single authority. Keep `retry_eligible` explicit because retryability can differ by status/attempt even within one class.

- [ ] **Step 4: Make fields private and route custom deserialization through the constructor**

Keep `Serialize`, remove derived `Deserialize`, and make all fields private. The constructor sanitizes provider/model/metadata and derives `terminal_reason`. Deserialize through a private wire struct that includes `terminal_reason`; reject any wire mismatch before calling `new(parts)`. Add the accessors listed in the published interface.

Replace the stringly `BrainError::{Connection, Protocol, StageFailure}` and `MissingApiKey` variants with:

```rust
#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    #[error("{0}")]
    Failure(Box<BrainProviderFailure>),
}

impl BrainError {
    pub fn from_failure(failure: BrainProviderFailure) -> Self {
        Self::Failure(Box::new(failure))
    }

    pub fn failure(&self) -> &BrainProviderFailure {
        match self { Self::Failure(failure) => failure }
    }

    pub fn terminal_reason(&self) -> TerminalSessionReason {
        self.failure().terminal_reason()
    }
}
```

Keep `BrainProviderError` wire-compatible for `protocol.rs`, but remove its unclassified `new` constructor. `from_stage_failure` (renamed `from_failure`) must always set `failure: Some(...)`, derive `source` from `provider()`, and derive the sanitized message from `Display`. Add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum BrainProviderErrorClassificationError {
    #[error("provider error is missing a typed failure")]
    MissingTypedFailure,
}

impl BrainProviderError {
    pub fn failure(&self) -> Option<&BrainProviderFailure> {
        self.failure.as_ref()
    }

    pub fn require_failure(
        &self,
    ) -> Result<&BrainProviderFailure, BrainProviderErrorClassificationError> {
        self.failure()
            .ok_or(BrainProviderErrorClassificationError::MissingTypedFailure)
    }
}
```

No domain code constructs a `BrainProviderError` with `failure: None`; only the out-of-scope protocol fixture retains that legacy wire shape.

- [ ] **Step 5: Verify GREEN and serialization stability**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test failure_contract --test compile_fail
cargo test --manifest-path agent/Cargo.toml -p agent-domain --lib brain
```

Expected: PASS. The JSON field names remain `failure_class`, `stage`, `terminal_reason`, `retry_eligible`, `latency_ms`, `provider`, `model`, and `metadata`; unsafe raw values cannot be constructed or deserialized.

- [ ] **Step 6: Commit the typed failure boundary**

Run:

```bash
git add agent/crates/agent-domain/Cargo.toml agent/crates/agent-domain/src/brain.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/failure_contract.rs agent/crates/agent-domain/tests/compile_fail.rs agent/crates/agent-domain/tests/ui/brain_provider_failure_struct_literal.rs agent/crates/agent-domain/tests/ui/brain_provider_failure_struct_literal.stderr
git commit -m "feat(agent-domain): type and sanitize runtime failures"
```

**Handoff to Plan 07:** every provider/store/tool error must construct `BrainProviderFailureParts` with enum class/stage before returning; invalid API-key headers are `ProviderAuthFailure` and non-retryable; STT/TTS/Gemini transport failures select a class at the status/protocol boundary; the live runner emits `BrainProviderError::from_failure` and never uses a fake/unclassified emitter.

**Handoff to Plan 08:** replace `terminal_reason_for_provider_message`, `provider_store_error_message_is_durability_degraded`, and all equivalent substring classifiers with `BrainError::terminal_reason()`, `require_failure()?.failure_class()`, and `PortError::kind()`. Replace failure-control and other runtime `failure: None` literals with typed failures. A missing failure is converted to `BrainFailureClass::Rollback` at stage `Websocket`, never classified from source/message. Update field reads to accessors. Protocol rendering remains source/message compatible and is not edited by this plan.

---

### Task 3: Make Store Errors and Defaults Fail Closed and Writes Observable (`DOMAIN-006`, part of `DOMAIN-009`)

**Disposition:** `TESTED_FIX`.

**Files:**
- Modify: `agent/crates/agent-domain/src/ports.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Create: `agent/crates/agent-domain/tests/store_contract.rs`
- Modify: `agent/crates/agent-domain/tests/compile_fail.rs`
- Create: `agent/crates/agent-domain/tests/ui/port_error_struct_pattern.rs`
- Create: `agent/crates/agent-domain/tests/ui/port_error_struct_pattern.stderr`
- Create: `agent/crates/agent-domain/tests/ui/study_store_write_outcome_unused.rs`
- Create: `agent/crates/agent-domain/tests/ui/study_store_write_outcome_unused.stderr`

- [ ] **Step 1: Write RED tests for typed errors, default methods, and write outcomes**

Add a `DefaultsProbeStore` in `store_contract.rs` that implements only the trait's required methods with explicit `PortError::unavailable` results. Exercise every default that currently claims a successful read/write:

```rust
#[tokio::test]
async fn incomplete_store_never_reports_successful_truth_or_mutation() {
    let store = DefaultsProbeStore;
    let config = fixture_session_config();

    assert_unavailable(store.record_voice_session(&config).await);
    assert_unavailable(store.pending_answer_attempts_for_session("voice-1").await);
    assert_unavailable(store.study_session_durable_counts("u", "s", "voice-1").await);
    assert_unavailable(store.answer_attempt_was_recorded("u", "s", "voice-1", "r").await);
    assert_unavailable(store.close_voice_session("voice-1", "drained").await);
    assert_unavailable(store.active_question("u", "s").await);
    assert_unavailable(store.record_voice_usage(fixture_usage()).await);
    assert_unavailable(
        store
            .record_turn_outcome("u", "s", "voice-1", fixture_turn_outcome())
            .await,
    );
    assert_unavailable(store.session_learning_evidence("u", "s", "voice-1").await);
    assert_unavailable(
        store
            .record_challenge_resolution("u", "s", "voice-1", fixture_challenge())
            .await,
    );
    assert_unavailable(
        store
            .select_next_question(
                "u",
                "s",
                "voice-1",
                "response-1",
                ProgressionPolicyId::OrderedV1,
            )
            .await,
    );
    assert_unavailable(store.authenticated_study_projection("u", "s", "voice-1").await);
}
```

Load `fixture_turn_outcome()` and `fixture_challenge()` from Plan 04's canonical `turn-outcomes-v1.json`; do not define simplified Plan 06 learning fixtures.

Also assert:

- `PortError::durability(...).kind() == PortErrorKind::Durability` and `is_durability()` is true.
- `Unavailable`, `InvalidInput`, `Conflict`, and `Internal` are not durability failures.
- private fields prevent downstream pattern matching on raw reason text for classification.
- `StudyStoreWriteOutcome` is `#[must_use]`.
- `StudyStoreWriteCounts::default().voice_usage == 0`.

Add `tests/ui/port_error_struct_pattern.rs`, which constructs a public error and then attempts `let PortError { reason, .. } = error;`. Extend `compile_fail.rs` to check this fixture and its checked-in stderr. The stderr must fail because `reason` is private, proving consumers cannot classify by destructuring diagnostic prose.

Add `tests/ui/study_store_write_outcome_unused.rs` with `#![deny(unused_must_use)]`; pass an outcome to a function whose body is only `outcome;`. Its checked-in stderr must fail on the `StudyStoreWriteOutcome` must-use diagnostic. This checks the enum attribute itself rather than merely relying on `Result`'s independent must-use behavior.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test store_contract --test compile_fail
```

Expected: FAIL because current defaults return `Ok`, `PortError` is stringly/public-patterned, write methods return `()`, and usage has no count.

- [ ] **Step 3: Replace string-classified `PortError` with a private structured error**

Implement:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PortErrorKind {
    Unavailable,
    InvalidInput,
    Conflict,
    Durability,
    Internal,
}

#[derive(Debug, thiserror::Error)]
#[error("{port} {kind} for {id}: {reason}")]
pub struct PortError {
    kind: PortErrorKind,
    port: &'static str,
    id: String,
    reason: String,
}
```

Implement `Display`/`as_str` for the kind, named constructors `unavailable`, `invalid_input`, `conflict`, `durability`, and `internal`, plus read-only accessors. Do not retain a generic `adapter()` constructor: a caller must choose a semantic kind.

- [ ] **Step 4: Change the session/usage write contract and all truth-bearing defaults**

Add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[must_use]
pub enum StudyStoreWriteOutcome {
    Inserted,
    IdempotentReplay,
}
```

Change `record_voice_session` and `record_voice_usage` to the published signatures. Add `voice_usage: usize` to `StudyStoreWriteCounts`.

Return `Err(PortError::unavailable(...))` from defaults for:

- `pending_answer_attempts_for_session`
- `record_voice_session`
- `study_session_durable_counts`
- `answer_attempt_was_recorded`
- `close_voice_session`
- `active_question`
- `record_voice_usage`
- `record_turn_outcome`
- `session_learning_evidence`
- `record_challenge_resolution`
- `select_next_question`
- `authenticated_study_projection`

Leave capability/count defaults and deliberately optional non-authoritative capability observations as values. Existing mutation/authorization defaults already fail closed and remain so.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test store_contract --test compile_fail
cargo clippy --manifest-path agent/Cargo.toml -p agent-domain --all-targets -- -D warnings
```

Expected: domain tests PASS. Workspace consumers are expected to fail to compile until Plans 07/08/09 apply the explicit handoffs below; do not weaken the default to restore compilation.

- [ ] **Step 6: Commit the domain port contract**

Run:

```bash
git add agent/crates/agent-domain/src/ports.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/store_contract.rs agent/crates/agent-domain/tests/compile_fail.rs agent/crates/agent-domain/tests/ui/port_error_struct_pattern.rs agent/crates/agent-domain/tests/ui/port_error_struct_pattern.stderr agent/crates/agent-domain/tests/ui/study_store_write_outcome_unused.rs agent/crates/agent-domain/tests/ui/study_store_write_outcome_unused.stderr
git commit -m "feat(agent-domain): fail closed study store contracts"
```

**Handoff to Plan 07:** consume or explicitly discard `StudyStoreWriteOutcome`; map pre-loop/tool store errors from `PortErrorKind`, never reason substrings.

**Handoff to Plan 08:** status/terminal/durability selection matches `PortErrorKind`; nonce reuse is `Conflict`, not `Unavailable` with an exact reason string. Readiness includes the new usage count.

**Handoff to Plan 09:** memory/Postgres return `Inserted` only for a real row/write-count increment; repeated `record_voice_session` returns `IdempotentReplay`; usage always inserts because no stable usage event ID exists; memory must retain sanitized usage or otherwise return a typed failure, never silently drop it; SQL/pool/transaction failures are `Durability`; semantic validation is `InvalidInput`; replay conflicts are `Conflict`. Database/store conformance tests assert count-to-row parity.

---

### Task 3A: Publish Exactly the Selected D-04 Domain Surface (`DOMAIN-011`)

**Disposition:** conditional `TESTED_FIX`. Execute exactly one branch. This task owns types and ports only; it defines no HTTP route, clock worker, SQL, transaction, migration, retention policy, or browser capability.

**Files under `CONFIRM_DELETE`:**
- Modify: `agent/crates/agent-domain/tests/compile_fail.rs`
- Create: `agent/crates/agent-domain/tests/ui/d04_restore_types_absent.rs`
- Create: `agent/crates/agent-domain/tests/ui/d04_restore_types_absent.stderr`
- Create: `agent/crates/agent-domain/tests/ui/d04_restore_methods_absent.rs`
- Create: `agent/crates/agent-domain/tests/ui/d04_restore_methods_absent.stderr`

**Files under `SOFT_DELETE_UNDO`:**
- Modify: `agent/crates/agent-domain/Cargo.toml`
- Create: `agent/crates/agent-domain/src/deletion.rs`
- Modify: `agent/crates/agent-domain/src/ports.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Create: `agent/crates/agent-domain/tests/deletion_contract.rs`
- Create: `agent/crates/agent-domain/tests/fixtures/deletion-contract-v1.json`
- Modify: `agent/crates/agent-domain/tests/store_contract.rs`

- [ ] **Step 1: Read the canonical selector and stop on every non-executable state**

Run exactly:

```bash
git fetch --all --prune
git rebase review-remediation/integration
D04_DELETION_UX="$(bun -e '
  const text = await Bun.file("docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md").text();
  const selectors = new Set();
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", ""));
    if (cells.length === 0) continue;
    if (cells[0] === "D-04" && (cells[2] === "CONFIRM_DELETE" || cells[2] === "SOFT_DELETE_UNDO")) selectors.add(cells[2]);
    if (cells[0] === "D-04 DELETION_UX" && (cells[1] === "CONFIRM_DELETE" || cells[1] === "SOFT_DELETE_UNDO")) selectors.add(cells[1]);
  }
  if (selectors.size !== 1) process.exit(64);
  console.log([...selectors][0]);
')" || {
  echo "BLOCKED: D-04 DELETION_UX is not recorded as an executable selector" >&2
  exit 64
}
```

The recorded D-04 selection lives in the coordinator's ledger commits on the integration branch; the `LANE_BASE_SHA` snapshot may predate it, so the fetch/rebase is mandatory before parsing. The parser accepts the selector from either recorded form — the `Current state` cell of the decision-registry `` | `D-04` | `` row replaced in place with exactly `CONFIRM_DELETE` or `SOFT_DELETE_UNDO`, or the second cell of a Program-Task-2-schema recording row (`| D-04 DELETION_UX | <selector> | Connor | ... |`) — and still exits 64 on zero or conflicting matches.

Expected: print exactly one executable selector. Do not infer the branch from existing code, feature flags, migrations, routes, or tests.

- [ ] **Step 2A (`CONFIRM_DELETE` only): Pin compile-time and route absence**

Do not create `deletion.rs`; do not add `chrono`/`uuid` to `agent-domain`; do not declare a deletion module; and do not add `restore_study_set` or `finalize_expired_study_set_deletions` to `StudyMemoryStore`.

Add two trybuild fixtures. `d04_restore_types_absent.rs` imports `SoftDeleteReceiptV1`, `RestoreStudySetInputV1`, `RestoreStudySetOutcomeKindV1`, and `RestoreStudySetOutcomeV1` from `agent_domain`; its checked-in stderr must contain unresolved-import diagnostics for all four names. `d04_restore_methods_absent.rs` calls both method names on `&dyn StudyMemoryStore`; its checked-in stderr must contain no-method diagnostics for both names. Register both with `tests/compile_fail.rs` only in this selected branch.

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test compile_fail -- --nocapture
rg -n 'mod deletion|SoftDeleteReceiptV1|RestoreStudySet(Input|Outcome)|restore_study_set|finalize_expired_study_set_deletions' agent/crates/agent-domain/src agent/crates/agent-domain/Cargo.toml
```

Expected: trybuild PASS; the `rg` command returns no matches. The service-route absence proof is Plan 08's; it is executed on the combined tree in Task 8 Step 4A. Temporarily expose either a dummy type or dummy trait method and confirm the corresponding trybuild snapshot fails before restoring absence. Plan 06 owns only the compile proof; Plan 08 owns the route proof.

Commit only the absence tests:

```bash
git add agent/crates/agent-domain/tests/compile_fail.rs agent/crates/agent-domain/tests/ui/d04_restore_types_absent.rs agent/crates/agent-domain/tests/ui/d04_restore_types_absent.stderr agent/crates/agent-domain/tests/ui/d04_restore_methods_absent.rs agent/crates/agent-domain/tests/ui/d04_restore_methods_absent.stderr
git commit -m "test(agent-domain): pin confirm-delete restore absence"
```

Report the executed `CONFIRM_DELETE` branch and this commit to the coordinator, who records it in the ledger; workers do not edit the ledger. Skip Steps 2B–7B completely.

- [ ] **Step 2B (`SOFT_DELETE_UNDO` only): Write RED fixture, serde, constructor, and default-port tests**

Create `tests/fixtures/deletion-contract-v1.json` with exactly this object and no credential/token field:

```json
{
  "receipt": {
    "schema": "viva.soft_delete_receipt.v1",
    "deletion_id": "550e8400-e29b-41d4-a716-446655440000",
    "study_set_id": "7d9d7cf1-44fb-4b33-8ca6-c1ebf4d1ab01",
    "deleted_at": "2031-04-05T12:00:00Z",
    "undo_expires_at": "2031-04-05T12:00:30Z",
    "policy": "soft_delete_undo"
  },
  "restore_input": {
    "user_id": "learner-1",
    "study_set_id": "7d9d7cf1-44fb-4b33-8ca6-c1ebf4d1ab01",
    "deletion_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "outcomes": [
    {
      "schema": "viva.restore_study_set_outcome.v1",
      "deletion_id": "550e8400-e29b-41d4-a716-446655440000",
      "study_set_id": "7d9d7cf1-44fb-4b33-8ca6-c1ebf4d1ab01",
      "restored_at": "2031-04-05T12:00:29.999999Z",
      "outcome": "restored"
    },
    {
      "schema": "viva.restore_study_set_outcome.v1",
      "deletion_id": "550e8400-e29b-41d4-a716-446655440000",
      "study_set_id": "7d9d7cf1-44fb-4b33-8ca6-c1ebf4d1ab01",
      "restored_at": "2031-04-05T12:00:29.999999Z",
      "outcome": "already_restored"
    }
  ]
}
```

Create `tests/deletion_contract.rs` with these exact tests:

- `d04b_deletion_fixture_round_trips_exact_wire_contract` deserializes the entire fixture through the public domain types, asserts the two literal schemas, literal policy, exact field set, and both snake_case outcome tokens, then serializes to the byte-semantic same `serde_json::Value`.
- `d04b_deletion_deserialization_rejects_noncanonical_values` independently mutates unknown keys, either schema, policy, a braced/uppercase/nil/noncanonical deletion UUID, non-UTC/malformed/noncanonical timestamps, a 29.999999- or 30.000001-second receipt window, an unknown outcome, and empty/control-bearing subject IDs; every mutation must fail.
- `d04b_deletion_constructors_and_deserializers_share_validation` feeds the same invalid table through `try_new` and custom `Deserialize`; the constructor returns the exact `DeletionContractError` variant, while the serde error contains that variant's stable `Display` text and never the rejected value.
- `d04b_incomplete_store_fails_closed` invokes `restore_study_set(valid_input)`, `finalize_expired_study_set_deletions(1)`, and `finalize_expired_study_set_deletions(100)` on `DefaultsProbeStore`; all three return `PortErrorKind::Unavailable`, never `Ok`.
- `d04b_finalizer_limit_bounds_are_typed` invokes limits `0` and `101`; both return `PortErrorKind::InvalidInput` before an implementation/default backend call.

Also add these three calls to Task 3's `incomplete_store_never_reports_successful_truth_or_mutation` only in the selected Branch-B tree, so the complete partial-store audit remains one test.

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test deletion_contract --test store_contract -- --nocapture
```

Expected: RED because the deletion module, types, ports, validations, and fixture parser do not exist.

- [ ] **Step 3B: Implement exact private, validated deletion values**

Only under `SOFT_DELETE_UNDO`, add `chrono.workspace = true` and `uuid.workspace = true` to `agent-domain/Cargo.toml`. Create `src/deletion.rs` with these wire constants and public type names:

```rust
pub const SOFT_DELETE_RECEIPT_SCHEMA_V1: &str = "viva.soft_delete_receipt.v1";
pub const SOFT_DELETE_POLICY_V1: &str = "soft_delete_undo";
pub const RESTORE_STUDY_SET_OUTCOME_SCHEMA_V1: &str =
    "viva.restore_study_set_outcome.v1";
pub const SOFT_DELETE_UNDO_WINDOW_SECONDS: i64 = 30;
pub const MAX_DELETION_FINALIZE_BATCH: usize = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStudySetOutcomeKindV1 {
    Restored,
    AlreadyRestored,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SoftDeleteReceiptV1 {
    schema: &'static str,
    deletion_id: String,
    study_set_id: String,
    deleted_at: String,
    undo_expires_at: String,
    policy: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RestoreStudySetInputV1 {
    user_id: String,
    study_set_id: String,
    deletion_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RestoreStudySetOutcomeV1 {
    schema: &'static str,
    deletion_id: String,
    study_set_id: String,
    restored_at: String,
    outcome: RestoreStudySetOutcomeKindV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum DeletionContractError {
    #[error("invalid deletion schema")]
    InvalidSchema,
    #[error("invalid deletion policy")]
    InvalidPolicy,
    #[error("invalid deletion identifier: {field}")]
    InvalidIdentifier { field: &'static str },
    #[error("invalid deletion timestamp: {field}")]
    InvalidTimestamp { field: &'static str },
    #[error("soft-delete undo window must be exactly 30 seconds")]
    InvalidUndoWindow,
}
```

All fields remain private. Add these exact constructor signatures:

```rust
impl SoftDeleteReceiptV1 {
    pub fn try_new(
        deletion_id: String,
        study_set_id: String,
        deleted_at: String,
        undo_expires_at: String,
    ) -> Result<Self, DeletionContractError> {
        validate_deletion_id(&deletion_id)?;
        validate_subject_id("study_set_id", &study_set_id)?;
        let deleted = parse_canonical_utc("deleted_at", &deleted_at)?;
        let expires = parse_canonical_utc("undo_expires_at", &undo_expires_at)?;
        if expires - deleted != chrono::Duration::seconds(SOFT_DELETE_UNDO_WINDOW_SECONDS) {
            return Err(DeletionContractError::InvalidUndoWindow);
        }
        Ok(Self {
            schema: SOFT_DELETE_RECEIPT_SCHEMA_V1,
            deletion_id,
            study_set_id,
            deleted_at,
            undo_expires_at,
            policy: SOFT_DELETE_POLICY_V1,
        })
    }
}

impl RestoreStudySetInputV1 {
    pub fn try_new(
        user_id: String,
        study_set_id: String,
        deletion_id: String,
    ) -> Result<Self, DeletionContractError> {
        validate_subject_id("user_id", &user_id)?;
        validate_subject_id("study_set_id", &study_set_id)?;
        validate_deletion_id(&deletion_id)?;
        Ok(Self { user_id, study_set_id, deletion_id })
    }
}

impl RestoreStudySetOutcomeV1 {
    pub fn try_new(
        deletion_id: String,
        study_set_id: String,
        restored_at: String,
        outcome: RestoreStudySetOutcomeKindV1,
    ) -> Result<Self, DeletionContractError> {
        validate_deletion_id(&deletion_id)?;
        validate_subject_id("study_set_id", &study_set_id)?;
        parse_canonical_utc("restored_at", &restored_at)?;
        Ok(Self {
            schema: RESTORE_STUDY_SET_OUTCOME_SCHEMA_V1,
            deletion_id,
            study_set_id,
            restored_at,
            outcome,
        })
    }
}
```

Add borrowed accessors named exactly after every field; `schema()`/`policy()` return `&'static str`, string fields return `&str`, and `outcome()` returns the copy enum. Constructors set schema/policy literals rather than accepting them. `validate_deletion_id` uses `Uuid::parse_str`, rejects nil, and requires `parsed.to_string() == input`; `validate_subject_id` requires non-empty trim equality and no control characters. `parse_canonical_utc` parses RFC3339, requires UTC `Z`, requires an exact `SecondsFormat::AutoSi` round trip, and returns `DateTime<Utc>`. These helpers return only the field-specific `DeletionContractError` variants above and never include rejected input in error text.

Do not derive `Deserialize` directly on any public struct. Define private `#[serde(deny_unknown_fields)]` wire helpers, implement `Deserialize` by validating the incoming literal schema/policy and then calling the same `try_new` constructors. No constructor/deserializer stores unknown keys, credentials, tokens, client clocks, or raw invalid values. The enum's derived deserializer is exhaustive and snake_case.

In `lib.rs`, declare `mod deletion;` and re-export the four requested types, `DeletionContractError`, and the five constants. Do not expose the private wire helpers.

- [ ] **Step 4B: Add exact fail-closed `StudyMemoryStore` methods**

Import the deletion types into `ports.rs` and add exactly:

```rust
async fn restore_study_set(
    &self,
    input: RestoreStudySetInputV1,
) -> Result<RestoreStudySetOutcomeV1, PortError> {
    Err(PortError::unavailable(
        "study_memory_store",
        input.deletion_id(),
        "restore_study_set is not implemented",
    ))
}

async fn finalize_expired_study_set_deletions(
    &self,
    limit: usize,
) -> Result<usize, PortError> {
    if !(1..=MAX_DELETION_FINALIZE_BATCH).contains(&limit) {
        return Err(PortError::invalid_input(
            "study_memory_store",
            "deletion_finalize_limit",
            "limit must be between 1 and 100",
        ));
    }
    Err(PortError::unavailable(
        "study_memory_store",
        "deletion_finalizer",
        "finalize_expired_study_set_deletions is not implemented",
    ))
}
```

The default restore and every valid finalizer limit fail closed with `Unavailable`; zero and values over 100 return `InvalidInput`. Plan 09's overrides must apply the identical limit guard before backend access, then return a count no greater than the requested limit. No default returns `Restored`, `AlreadyRestored`, or zero.

- [ ] **Step 5B: Verify GREEN plus required negative controls**

Run:

```bash
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test deletion_contract --test store_contract -- --nocapture
cargo clippy --manifest-path agent/Cargo.toml -p agent-domain --all-targets -- -D warnings
```

Expected: PASS. Independently remove `deny_unknown_fields`, allow a noncanonical UUID, change the undo comparison from exact 30 seconds, return `Ok(0)` from the finalizer default, and relax `101`; each named test must fail before restoring the implementation.

- [ ] **Step 6B: Commit only the Branch-B domain contract**

Run:

```bash
git add agent/crates/agent-domain/Cargo.toml agent/crates/agent-domain/src/deletion.rs agent/crates/agent-domain/src/ports.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/deletion_contract.rs agent/crates/agent-domain/tests/fixtures/deletion-contract-v1.json agent/crates/agent-domain/tests/store_contract.rs
git commit -m "feat(agent-domain): publish bounded deletion restore ports"
```

Report the executed `SOFT_DELETE_UNDO` branch and this commit to the coordinator, who records it in the ledger; workers do not edit the ledger. Do not commit Branch-A absence fixtures on this branch.

- [ ] **Step 7B: Hand off implementation without moving authority**

**Handoff to Plan 09:** implement both memory and Postgres overrides and use the public constructors for every receipt/outcome. The internal restore input is exactly `{ user_id, study_set_id, deletion_id }`; the half-open database-time rule is `database_now < undo_expires_at`, equality is expired, and the window is exactly 30 seconds. First success returns `Restored`; replay returns `AlreadyRestored` with the original persisted `restored_at`. Both backends reject limits 0/101 as `InvalidInput`, return at most `limit`, and never reach Plan 06 defaults. The existing branch-neutral `delete_study_set -> Value` port must serialize `SoftDeleteReceiptV1` rather than hand-building JSON until a separately owned typed delete-port migration exists. Under `CONFIRM_DELETE`, skip Plan 09 Task 10 and implement neither override.

**Handoff to Plan 08:** under `SOFT_DELETE_UNDO`, deserialize the existing delete result through `SoftDeleteReceiptV1`, construct the internal restore input only from authenticated user ID, route study-set ID, and bounded deletion ID, and consume the typed outcome. Run finalization with limit 100 at durable startup, sequential five-second ticks, and before the owned request paths exactly as SERVICE-018 specifies. Under `CONFIRM_DELETE`, import none of these types, start no finalizer, and keep `restore_route_absent_when_confirm_delete_selected` GREEN. Plan 06 defines no HTTP status, handler, route, timer, health state, or shutdown behavior.

---

### Task 4: Enforce Digest Converse and Capture Bounds (`DOMAIN-008`)

**Disposition:** `TESTED_FIX`.

**Files:**
- Modify: `agent/crates/agent-domain/src/ports.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Create: `agent/crates/agent-domain/tests/answer_attempt_validation.rs`

- [ ] **Step 1: Write a complete RED boundary table**

Create one valid typed envelope and one valid audio envelope, then mutate one field per row. Cover exact lower/upper/over-bound values:

```rust
#[test]
fn answer_attempt_policy_and_size_boundaries_fail_closed() {
    let digest = "a".repeat(64);
    let cases = [
        (digest_only(None), false),
        (digest_only(Some("a".repeat(63))), false),
        (digest_only(Some("A".repeat(64))), false),
        (digest_only(Some("g".repeat(64))), false),
        (digest_only(Some(digest.clone())), true),
        (none_policy(Some(digest)), false),
        (typed_counts(Some(0), Some(1)), false),
        (typed_counts(Some(1), Some(0)), false),
        (typed_counts(Some(MAX_ANSWER_BYTE_COUNT), Some(MAX_ANSWER_CHAR_COUNT)), true),
        (typed_counts(Some(MAX_ANSWER_BYTE_COUNT + 1), Some(1)), false),
        (typed_counts(Some(1), Some(MAX_ANSWER_CHAR_COUNT + 1)), false),
        (audio_counts(Some(1), None), false),
        (audio_counts(Some(2), None), true),
    ];

    for (envelope, expected_valid) in cases {
        assert_eq!(envelope.validate_fail_closed().is_ok(), expected_valid);
    }
}
```

Add duration cases `0`, `1`, `45_000`, and `45_001`; typed capture with missing byte/char count; audio with any char count; and proptest asserting no string outside `[0-9a-f]{64}` is accepted under `DigestOnly`.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test answer_attempt_validation
```

Expected: FAIL because the converse, shape, mode, and numeric bounds are not enforced and constants are absent.

- [ ] **Step 3: Add constants and exact fail-closed validation**

Add and export:

```rust
pub const MAX_ANSWER_BYTE_COUNT: u64 = 2_160_000;
pub const MAX_ANSWER_CHAR_COUNT: u64 = 65_536;
pub const MAX_ANSWER_DURATION_MS: u64 = 45_000;
pub const ANSWER_DIGEST_HMAC_HEX_LENGTH: usize = 64;
```

In `validate_fail_closed`, validate identity fields first, then the policy/digest pair, then capture-mode field presence/absence, then positive inclusive bounds. Test ASCII bytes for digest shape; do not lowercase or trim an invalid digest into acceptance.

- [ ] **Step 4: Verify GREEN and persistence handoff compilation**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test answer_attempt_validation
cargo test --manifest-path agent/Cargo.toml -p agent-domain --lib
```

Expected: PASS. Every branch has both an accepted boundary and a rejected nearest neighbor.

- [ ] **Step 5: Commit the bounded validation contract**

Run:

```bash
git add agent/crates/agent-domain/src/ports.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/answer_attempt_validation.rs
git commit -m "fix(agent-domain): bound answer attempt evidence"
```

**Handoff to Plan 07:** runner envelopes must satisfy capture-mode field rules; if content policy remains `None`, they must not fabricate a digest.

**Handoff to Plan 09:** add matching Postgres `CHECK` constraints for policy converse, 64-char lowercase hex, positive/inclusive bounds, even audio bytes where capture mode is audio, and typed/audio field consistency. Both memory and Postgres must invoke domain validation before mutation; database rejection is defense in depth.

---

### Task 5: Remove Text-as-PCM Production API and Cache Base64 Once (`DOMAIN-007`)

**Disposition:** `BATCH_FIX` with regression/performance-shape tests.

**Files:**
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Modify: `agent/crates/agent-domain/tests/protocol_fixtures.rs`
- Create: `agent/crates/agent-domain/tests/audio_frame.rs`
- Create: `agent/crates/agent-domain/tests/ui/audio_frame_text_constructor.rs`
- Create: `agent/crates/agent-domain/tests/ui/audio_frame_text_constructor.stderr`
- Modify: `agent/crates/agent-domain/tests/compile_fail.rs`

- [ ] **Step 1: Write RED API-isolation and caching tests**

Add a trybuild case proving `AudioFrame::from_pcm16_text("hello")` is unavailable. Replace protocol fixture uses with explicit even byte slices.

In `audio_frame.rs` add:

```rust
#[test]
fn bytes_constructor_caches_one_base64_allocation() {
    let frame = AudioFrame::from_pcm16_bytes(vec![1_u8, 2, 3, 4]);
    let first = frame.pcm16_base64();
    let first_ptr = first.as_ptr();

    assert_eq!(first, "AQIDBA==");
    assert_eq!(frame.pcm16_base64().as_ptr(), first_ptr);
    assert_eq!(serde_json::to_string(&frame).unwrap(), r#"{"pcm16_base64":"AQIDBA=="}"#);
    assert_eq!(frame.pcm16_base64().as_ptr(), first_ptr);
}

#[test]
fn base64_constructor_preserves_the_validated_encoding() {
    let frame = AudioFrame::from_base64("AQIDBA==").unwrap();
    assert_eq!(frame.pcm16_bytes(), &[1, 2, 3, 4]);
    assert_eq!(frame.pcm16_base64(), "AQIDBA==");
}
```

Add an adapter-handoff assertion in the plan, not production code: any local `#[cfg(test)]` text fixture helper must reject odd byte length before calling `from_pcm16_bytes`.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test audio_frame --test compile_fail --test protocol_fixtures
```

Expected: FAIL because `pcm16_base64()` returns a fresh `String` for byte-built frames and the text constructor remains public.

- [ ] **Step 3: Store cached base64 for every frame**

Change the representation to:

```rust
#[derive(Clone, Debug)]
pub struct AudioFrame {
    pcm16: Bytes,
    pcm16_base64: Arc<str>,
}
```

`from_pcm16_bytes` converts to `Bytes`, encodes exactly once, and stores the `Arc<str>`. `from_base64` validates/decode once and stores the validated input. Change `pcm16_base64(&self) -> &str`; serialization borrows it. Equality remains decoded-byte equality.

Delete `from_pcm16_text` without a replacement in the public domain API. Tests/fake transports use explicit even byte fixtures or local `#[cfg(test)]` helpers. Do not add a feature that can accidentally unify into a production workspace build.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test audio_frame --test compile_fail --test protocol_fixtures
cargo clippy --manifest-path agent/Cargo.toml -p agent-domain --all-targets -- -D warnings
```

Expected: PASS; repeated access/serialization has a stable borrowed pointer, round trips retain decoded equality, unknown JSON fields remain tolerated, and the text constructor cannot compile.

- [ ] **Step 5: Commit the isolated audio API**

Run:

```bash
git add agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/tests/protocol_fixtures.rs agent/crates/agent-domain/tests/audio_frame.rs agent/crates/agent-domain/tests/compile_fail.rs agent/crates/agent-domain/tests/ui/audio_frame_text_constructor.rs agent/crates/agent-domain/tests/ui/audio_frame_text_constructor.stderr
git commit -m "refactor(agent-domain): isolate fixture audio construction"
```

**Handoff to Plan 07:** update adapter tests/fakes to explicit even PCM bytes or a local `#[cfg(test)] fn fixture_audio_frame(text: &str) -> Result<AudioFrame, &'static str>` that rejects odd byte length. Update call sites for borrowed `pcm16_base64()`; no production helper accepts text.

**Handoff to Plan 08:** `ws.rs` continues to construct from decoded bytes/base64 only and borrows `pcm16_base64()` where needed.

---

### Task 6: Replace the Luca Grep with a Real Purity Gate and Keep Residue Honest (`DOMAIN-001`)

**Disposition:** `TESTED_FIX`.

**Files:**
- Create: `scripts/check-agent-domain-purity.mjs`
- Create: `scripts/check-agent-domain-purity.test.mjs`
- Modify: `scripts/check-agent-domain-purity.sh`
- Create: `scripts/check-legacy-domain-residue.sh`
- Create: `scripts/shell-gates.test.mjs`
- Handoff only: root `package.json` and `.github/workflows/validate.yml` (Plan 12)
- Handoff only: `README.md`, `CONTRIBUTING.md`, and `.github/PULL_REQUEST_TEMPLATE.md` (Plan 15)

- [ ] **Step 1: Write RED behavioral tests against injected metadata/source fixtures**

Export pure helpers plus a CLI from `check-agent-domain-purity.mjs`. Tests must mutate inputs, not grep the script source:

```js
test("rejects an infrastructure dependency", () => {
  assert.throws(
    () => assertAgentDomainBoundary(metadataWithDependency("reqwest"), cleanSources),
    /reqwest.*not in the agent-domain allowlist/,
  );
});

test("rejects direct I/O imports", () => {
  for (const source of [
    "use std::fs::File;",
    "use std::net::TcpStream;",
    "use std::{fs, net};",
    "use tokio::{net::TcpStream, fs};",
    "use std::process::{Command, Stdio};",
    "tokio::net::TcpStream::connect(addr).await;",
    "std::process::Command::new(\"curl\");",
  ]) {
    assert.throws(() => assertAgentDomainBoundary(cleanMetadata, [source]), /forbidden I\/O/);
  }
});

test("cargo metadata failure is a gate failure", () => {
  assert.throws(() => runPurityGate({ spawn: failingSpawn }), /cargo metadata failed/);
});
```

Also test the exact allowed normal dependencies (`async-trait`, `base64`, `bytes`, `futures-util`, `serde`, `serde_json`, `thiserror`, `tokio`, plus pure validation dependencies `chrono` and `uuid` only when D-04 is `SOFT_DELETE_UNDO`) and permitted Tokio channel/task imports.

Also create `scripts/shell-gates.test.mjs`: `node:test` cases that spawn `/bin/sh scripts/check-legacy-domain-residue.sh` with a controlled `PATH` pointing at stub `rg` executables, asserting (a) a missing `rg` exits non-zero, (b) an `rg` exiting with status greater than 1 exits non-zero, (c) a planted forbidden residue token in a temp tree exits non-zero with the match printed, and (d) a clean tree exits 0. Under `CONFIRM_DELETE`, `Cargo.toml` contains neither conditional dependency even though the purity allowlist recognizes both as non-I/O libraries; Task 7's unused-dependency gate remains the independent absence backstop. A metadata package rename, missing `agent-domain`, unreadable source file, or unknown direct normal dependency must fail.

- [ ] **Step 2: Run RED script tests**

Run:

```bash
node --test scripts/check-agent-domain-purity.test.mjs scripts/shell-gates.test.mjs
```

Expected: FAIL because there is no executable metadata/source boundary implementation and no residue shell script yet exists for the shell-gate cases to spawn.

- [ ] **Step 3: Implement a fail-closed metadata/import gate**

The CLI runs:

```bash
cargo metadata --manifest-path agent/Cargo.toml --format-version 1 --no-deps
```

It must:

1. require a successful command and valid JSON;
2. find exactly one `agent-domain` package;
3. reject any normal direct dependency outside the checked-in allowlist;
4. reject path dependencies from infrastructure crates;
5. read every `.rs` file under `agent/crates/agent-domain/src` and reject `std::fs`, `std::net`, `std::process`, `tokio::fs`, `tokio::net`, `tokio::process`, and `tokio::signal` imports/usages; the scanner must normalize grouped `use` trees (or parse module paths) so `use std::{fs, ...}` and `use tokio::{net::..., ...}` are rejected, not only literal `std::fs`/`tokio::net` substrings;
6. print the inspected package, dependency list, and source-file count on success.

Keep `scripts/check-agent-domain-purity.sh` as a POSIX entrypoint that validates `node` is present and `exec node scripts/check-agent-domain-purity.mjs`. It contains no `|| true`.

Move the old cooking/Luca vocabulary check into `scripts/check-legacy-domain-residue.sh`, remove the dead docs exclusion, and apply the shared fail-closed shell contract from the RELEASE plan: missing `rg`, `rg` exit >1, or input traversal failure is fatal; only exit 1 means no match.

- [ ] **Step 4: Publish separately named command and documentation handoffs**

Plan 12 adds this exact root `package.json` fragment and makes `validate:agent` run both commands:

```json
"agent:purity": "scripts/check-agent-domain-purity.sh",
"agent:residue": "scripts/check-legacy-domain-residue.sh"
```

Plan 15 makes README/CONTRIBUTING/PR-template say:

- purity checks the domain dependency allowlist and forbidden I/O imports;
- residue checks removed Chef Luca/cooking vocabulary;
- neither gate claims to prove live behavior or adapter purity.

This plan does not edit either owner's files. `scripts/check-agent-domain-purity.test.mjs` verifies only the script's semantic boundary; Task 8 verifies Plan 12/15's combined-tree handoffs.

- [ ] **Step 5: Verify GREEN plus adversarial shell behavior**

Run:

```bash
node --test scripts/check-agent-domain-purity.test.mjs scripts/shell-gates.test.mjs
bun run agent:purity
sh scripts/check-legacy-domain-residue.sh
```

The `agent:residue` alias is Plan 12's handoff and is exercised via `bun run agent:residue` only in Task 8 on the combined tree; `agent:purity` exists at baseline and Task 6 rewrites its target script.

Expected: PASS. In the shell-gate test, missing/failing `rg` is red and a real forbidden residue match is red. In the purity test, injected `reqwest`, `sqlx`, `axum`, `std::fs`, or `tokio::net` is red.

- [ ] **Step 6: Commit the honest gates**

Run:

```bash
git add scripts/check-agent-domain-purity.mjs scripts/check-agent-domain-purity.test.mjs scripts/check-agent-domain-purity.sh scripts/check-legacy-domain-residue.sh scripts/shell-gates.test.mjs
git commit -m "build(agent): enforce the domain purity boundary"
```

**Handoff to Plan 12:** add `agent:purity` and `agent:residue` exactly as shown, include both in `validate:agent`, and preserve their non-zero exit status.

**Handoff to Plan 15:** publish the three claims above only after both commands pass on the frozen combined SHA.

---

### Task 7: Add Required Unused-Dependency and Focused Mutation Policy (`DOMAIN-002`, `DOMAIN-010`)

**Disposition:** `BATCH_FIX` with required negative controls.

**Files:**
- Create: `scripts/rust-domain-quality-policy.test.mjs`
- Handoff only: root `package.json` and `.github/workflows/validate.yml` (Plan 12)

- [ ] **Step 1: Write RED workflow-policy tests**

Import `parse` from the `yaml` package and add behavioral/static-structure tests that parse `package.json` plus `.github/workflows/validate.yml` into objects and require:

- `agent:deps:unused` invokes pinned `cargo +nightly-2026-04-21 udeps` for `--workspace --all-targets`;
- the workflow installs `cargo-udeps` version `0.1.60` and runs the command;
- `agent:domain:mutants` invokes `cargo-mutants` over the named domain invariants;
- the workflow installs `cargo-mutants` version `25.3.1` and runs the focused mutation command;
- command exit failures are not ignored and no `continue-on-error` is set.

Mutation controls in the test remove each command/install step from an in-memory workflow copy and assert validation fails. This prevents a source-string-only test from accepting commented or unreachable steps.

- [ ] **Step 2: Run RED policy test**

Run:

```bash
node --test scripts/rust-domain-quality-policy.test.mjs
```

Expected: FAIL. On a tree without Plan 12's `yaml` dependency the failure is `ERR_MODULE_NOT_FOUND` at import — a sequencing artifact, not the meaningful RED. The assertion-level RED (both required gates rejected by the parsed-object checks) is witnessable only on a tree that contains the `yaml@2.8.2` dev dependency; rerun there before claiming the RED discipline is satisfied.

- [ ] **Step 3: Hand Plan 12 the exact commands and required CI steps**

Plan 12 adds:

```json
"agent:deps:unused": "cargo +nightly-2026-04-21 udeps --manifest-path agent/Cargo.toml --workspace --all-targets",
"agent:domain:mutants": "cargo mutants --manifest-path agent/crates/agent-domain/Cargo.toml -p agent-domain -F 'response_id|can_transition_to|restart_after_cancellation|terminate|terminal_reason|require_failure|sanitize_stage_token|sanitize_stage_metadata|is_durability|pending_answer_attempts_for_session|record_voice_session|study_session_durable_counts|answer_attempt_was_recorded|close_voice_session|active_question|record_voice_usage|record_turn_outcome|session_learning_evidence|record_challenge_resolution|select_next_question|authenticated_study_projection|restore_study_set|finalize_expired_study_set_deletions|try_new|validate_fail_closed|pcm16_base64|from_base64' --timeout 120"
```

At baseline, `bun.lock` contains no `yaml` package at all. Plan 12 adds the YAML parser as a new direct root dev dependency, exactly `"yaml": "2.8.2"`, so the policy test does not rely on a transitive package; this plan requires that dependency (plus its `bun.lock` change) to land in Plan 12's early additive `12a` node alongside the happy-dom pins, not in `12b`; the program's `12a` description, its `L12A --> L06` edge, and Plan 12's Task 14 Step 4A2 now record exactly that. Plan 12 owns the resulting `bun.lock` change.

In its workflow, Plan 12 installs the pinned nightly, `cargo-udeps 0.1.60`, and `cargo-mutants 25.3.1 --locked`. It runs unused dependencies after Rust compile/tests and mutation after focused domain tests. The job is required, not advisory.

Plan 07 removes confirmed unused `base64`, `thiserror`, `tokio-util`, `tracing`, and `uuid` entries from `agent-adapters/Cargo.toml` unless a dependency gains a real source use in that plan. Do not add allowlists for known dead dependencies.

- [ ] **Step 4: Run the gates and prove negative controls**

Execute this step only on the combined tree in Task 8: the `agent:deps:unused`/`agent:domain:mutants` aliases, the pinned tools, and the workflow steps they assert are Plan 12's and do not exist at lane time. Run:

```bash
bun run agent:deps:unused
bun run agent:domain:mutants
node --test scripts/rust-domain-quality-policy.test.mjs
```

Expected:

- `cargo-udeps`: zero unused dependencies after Plans 07/08/09 have applied their manifest cleanups.
- `cargo-mutants`: zero missed mutants for the selected invariant functions; baseline tests pass.
- policy tests: PASS, and the in-memory removal mutations are rejected.

- [ ] **Step 5: Defer the policy commit to the post-integration PR**

Do not commit `scripts/rust-domain-quality-policy.test.mjs` in the initial lane PR: root `test:scripts` globs `scripts/*.test.mjs`, so committing it before Plan 12's `yaml` dependency exists would leave `bun run validate` — and therefore the combined integration tip — red from Plan 06's merge until `12b`, corrupting Level-1/2 evidence for every intervening lane merge. Keep the file in the lane worktree and stage/commit it only in Task 8 Step 5's second integration PR, which merges in the same integration wave as `12b` (or later); the policy assertions themselves stay RED until `12b` lands the commands/workflow.

**Handoff to Plan 12:** own the root commands, direct `yaml` dev dependency, pinned tool installation, required workflow steps, action pins, permissions, and all lockfile consequences. Apply the exact commands above; do not weaken them with allowlists, `continue-on-error`, or swallowed exits.

---

### Task 8: Integrate Plans 04/07/08/09/12/15 and Run the Frozen Combined-Tree Gate

**Disposition:** integration acceptance; no new domain authority.

**Execution context:** Tasks 0–7 complete this lane and its first integration PR. Task 8 is a post-integration verification pass: execute it only after Plans `04b`, 07, 08, 09, `12b`, and Plan 15's documentation/public-contract tasks have merged, in this lane's worktree rebased onto the integration tip; its Step 5 commit is a second, separately reviewed integration PR. This pass supplements — and must not replace or front-run — Plan 15's frozen combined checks.

**Files:**
- Verify all files touched by Tasks 0–7.
- Verify consumer files owned by Plans 04, 07, 08, and 09.
- Verify root `package.json` and `.github/workflows/validate.yml` handoffs owned by Plan 12.
- Verify `README.md`, `CONTRIBUTING.md`, and `.github/PULL_REQUEST_TEMPLATE.md` claims owned by Plan 15.
- Do not edit `agent/crates/agent-domain/src/{study,tools,tool_executor}.rs` or Plan 04's new learning modules/tests/fixtures in this plan.

- [ ] **Step 1: Check interface consumption with targeted searches**

Run:

```bash
rg -n 'BrainError::(Connection|Protocol|StageFailure)|terminal_reason_for_provider_message|provider_store_error_message_is_durability_degraded' agent/crates
rg -n 'BrainProviderFailure\s*\{' agent/crates --glob '*.rs' | rg -v '(pub struct|impl) BrainProviderFailure\s*\{'
rg -n 'PortError::adapter|PortError::(Unavailable|Adapter)\s*\{' agent/crates --glob '*.rs'
rg -n 'from_pcm16_text' agent/crates --glob '*.rs'
rg -n 'failure:\s*None' agent/crates --glob '*.rs' -g '!agent/crates/agent-service/src/protocol.rs'
rg -n 'async fn (record_voice_session|record_voice_usage)' agent/crates --glob '*.rs'
rg -n 'TurnDeferred|async fn (record_turn_outcome|session_learning_evidence|record_challenge_resolution|select_next_question|authenticated_study_projection)' agent/crates/agent-domain/src/{brain,ports}.rs
rg -n 'pub (struct|enum) (EvaluationLabel|TurnOutcome|TurnOutcomeRecordReceipt|PersistedTurnOutcome|SessionLearningEvidence|QuestionProgressionResult|AuthenticatedStudyProjectionV1)' agent/crates/agent-domain/src/{brain,ports,lib}.rs agent/crates/agent-domain/tests/protocol_fixtures.rs
rg -n 'agent:purity|agent:residue' README.md CONTRIBUTING.md .github/PULL_REQUEST_TEMPLATE.md
```

Rerun Task 3A Step 1's exact selector checkpoint, then run the selected source-surface proof:

```bash
case "$D04_DELETION_UX" in
  CONFIRM_DELETE)
    if rg -n 'mod deletion|SoftDeleteReceiptV1|RestoreStudySet(Input|Outcome)|restore_study_set|finalize_expired_study_set_deletions|chrono\.workspace|uuid\.workspace' agent/crates/agent-domain/src agent/crates/agent-domain/Cargo.toml; then
      echo "CONFIRM_DELETE must compile no restore domain surface" >&2
      exit 1
    fi
    cargo test --manifest-path agent/Cargo.toml -p agent-domain --test compile_fail -- --nocapture
    ;;
  SOFT_DELETE_UNDO)
    rg -n 'mod deletion|SoftDeleteReceiptV1|RestoreStudySetInputV1|RestoreStudySetOutcomeKindV1|RestoreStudySetOutcomeV1' agent/crates/agent-domain/src/{deletion,lib}.rs
    rg -n 'async fn (restore_study_set|finalize_expired_study_set_deletions)' agent/crates/agent-domain/src/ports.rs
    cargo test --manifest-path agent/Cargo.toml -p agent-domain --test deletion_contract --test store_contract -- --nocapture
    ;;
  *)
    echo "BLOCKED: D-04 selector missing before combined-tree proof" >&2
    exit 64
    ;;
esac
```

Expected:

- the first five commands produce no production matches; failure construction occurs only through `BrainProviderFailure::new(BrainProviderFailureParts { ... })` with typed fields;
- every store implementation uses the new write-outcome signatures;
- the seventh command finds Plan 06's event/port integration, while the eighth finds no duplicate Plan 04 learning-type declarations;
- the selected D-04 block either proves total domain API/dependency absence or exact typed Branch-B exports, ports, serde contracts, and fail-closed defaults;
- Plan 15's three public files name purity and residue separately and make only the claims handed off in Task 6;
- `study.rs`, `tools.rs`, `tool_executor.rs`, and Plan 04's learning modules/tests/fixtures have only Plan 04's intentional changes.

- [ ] **Step 2: Run focused domain and consumer suites**

Run:

```bash
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path agent/Cargo.toml -p agent-domain
cargo test --manifest-path agent/Cargo.toml -p agent-adapters
cargo test --manifest-path agent/Cargo.toml -p agent-service
cargo test --manifest-path agent/Cargo.toml -p data
node --test scripts/check-agent-domain-purity.test.mjs scripts/rust-domain-quality-policy.test.mjs scripts/shell-gates.test.mjs scripts/public-contract.test.mjs
bun run agent:purity
bun run agent:residue
```

Expected: all PASS. A Postgres test that exits early without `DATABASE_URL` is not durable proof and must not be reported as such.

- [ ] **Step 3: Run adversarial controls**

Run:

```bash
bun run agent:deps:unused
bun run agent:domain:mutants
bun run validate
git diff --check origin/main...HEAD
git diff --check
```

Expected: zero unused dependencies, zero missed selected mutants, full local validation PASS, and no whitespace errors.

- [ ] **Step 4: Run the Plan 09 durable conformance gate**

With the isolated Postgres 16 environment owned by Plan 09, run its exact store conformance command and verify:

```bash
cargo test --manifest-path agent/Cargo.toml -p data memory_learning_ports_override_fail_closed_defaults -- --exact --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_learning_ports_override_fail_closed_defaults -- --ignored --exact --test-threads=1 --nocapture
```

- inserted/replayed turn outcomes return the canonical `TurnOutcome` plus a `viva.turn_outcome_record.v1` receipt whose `response_id` matches and whose `replayed` bit matches row/count deltas;
- usage inserts increment row/count evidence exactly once;
- delete serialization cannot race a usage/session write;
- digest/count constraints match the domain boundary;
- typed `AuthenticatedStudyProjectionV1` is used instead of an unvalidated `serde_json::Value` read model;
- neither production backend reaches Plan 06's intentional fail-closed learning-port defaults.

Expected: PASS on the frozen combined SHA. If no database environment ran, record `not proven`; do not substitute in-memory green output.

- [ ] **Step 4A: Run the selected D-04 combined-tree proof**

Rerun Task 3A Step 1's exact selector checkpoint. Under `CONFIRM_DELETE`, run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test compile_fail -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service restore_route_absent_when_confirm_delete_selected -- --exact --nocapture
```

Expected: both absence proofs PASS, the service route returns `404`, and Task 3A's source-surface search remains empty. There is no deletion finalizer dependency, worker, readiness state, timer, or shutdown handle in the compiled service tree.

Under `SOFT_DELETE_UNDO`, run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test deletion_contract --test store_contract -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data study_set_restore_ -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_study_set_restore_ -- --ignored --test-threads=1 --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service authenticated_restore_ -- --nocapture
```

Expected: canonical serde and bounds PASS; memory/Postgres prove the half-open 30-second database-time boundary, first-write/replay outcome, restart/two-instance visibility, one restore/finalize winner, and selected D-05 finalization; the service consumes only the typed port and runs its owned route/finalizer tests. The required Postgres command must actually connect and execute. If it does not, record D-04 durable restore as `not proven` and do not close `DOMAIN-011`.

- [ ] **Step 5: Commit only integration fixes within this plan's ownership**

Rerun Task 3A Step 1's exact selector checkpoint immediately before staging, then run:

```bash
git add agent/crates/agent-domain/Cargo.toml \
  agent/crates/agent-domain/src/brain.rs \
  agent/crates/agent-domain/src/lib.rs \
  agent/crates/agent-domain/src/ports.rs \
  agent/crates/agent-domain/src/session_state.rs \
  agent/crates/agent-domain/tests/session_state.rs \
  agent/crates/agent-domain/tests/failure_contract.rs \
  agent/crates/agent-domain/tests/store_contract.rs \
  agent/crates/agent-domain/tests/answer_attempt_validation.rs \
  agent/crates/agent-domain/tests/audio_frame.rs \
  agent/crates/agent-domain/tests/protocol_fixtures.rs \
  agent/crates/agent-domain/tests/compile_fail.rs \
  agent/crates/agent-domain/tests/ui/brain_provider_failure_struct_literal.rs \
  agent/crates/agent-domain/tests/ui/brain_provider_failure_struct_literal.stderr \
  agent/crates/agent-domain/tests/ui/port_error_struct_pattern.rs \
  agent/crates/agent-domain/tests/ui/port_error_struct_pattern.stderr \
  agent/crates/agent-domain/tests/ui/study_store_write_outcome_unused.rs \
  agent/crates/agent-domain/tests/ui/study_store_write_outcome_unused.stderr \
  agent/crates/agent-domain/tests/ui/audio_frame_text_constructor.rs \
  agent/crates/agent-domain/tests/ui/audio_frame_text_constructor.stderr \
  scripts/check-agent-domain-purity.mjs \
  scripts/check-agent-domain-purity.test.mjs \
  scripts/check-agent-domain-purity.sh \
  scripts/check-legacy-domain-residue.sh \
  scripts/shell-gates.test.mjs \
  scripts/rust-domain-quality-policy.test.mjs \
  docs/superpowers/plans/2026-08-23-rust-domain-integrity.md

case "$D04_DELETION_UX" in
  CONFIRM_DELETE)
    git add agent/crates/agent-domain/tests/ui/d04_restore_types_absent.rs agent/crates/agent-domain/tests/ui/d04_restore_types_absent.stderr agent/crates/agent-domain/tests/ui/d04_restore_methods_absent.rs agent/crates/agent-domain/tests/ui/d04_restore_methods_absent.stderr
    ;;
  SOFT_DELETE_UNDO)
    git add agent/crates/agent-domain/src/deletion.rs agent/crates/agent-domain/tests/deletion_contract.rs agent/crates/agent-domain/tests/fixtures/deletion-contract-v1.json
    ;;
  *)
    echo "BLOCKED: D-04 selector missing before staging" >&2
    exit 64
    ;;
esac

git commit -m "test(agent-domain): close domain integrity gates"
```

Do not stage consumer files owned by Plans 04/07/08/09 or owner files assigned to Plans 12/15 in this commit. Their integration commits remain separately reviewable.

---

## Acceptance matrix

| Invariant | RED proof | GREEN proof | Mutation/negative control |
| --- | --- | --- | --- |
| Plan 04 learning seam | combined compile + four fixture parsers | typed event/ports/exports on one tree | Remove `TurnDeferred` response-ID arm or inject unknown fixture key; tests fail. |
| Evaluation label authority | fixture contains all six snake_case labels | typed `EvaluationLabel` under `viva.semantic-rubric.v1` | Replace evaluated label with `String` or accept provider label; compile/fixture tests fail. |
| Persisted turn receipt | store signature requires Plan 04 wrapper | canonical outcome plus truthful record receipt | Flip `replayed`, schema, or response ID; memory/Postgres exact conformance fails. |
| Learning-port production overrides | partial store returns `Unavailable` | memory/Postgres override all five methods | Remove one backend override; exact conformance test reaches default and fails. |
| Legal phase transition | 36-pair table | `session_state` test | Allow one illegal pair or post-terminal transition; test fails. |
| Terminal absorption | transition/terminate after timeout | typed `AlreadyTerminal` | Replace terminal guard; test fails for all six phases. |
| Terminal string authority | all variants serde/as_str/close parity | parity test | Change any token/close derivation; parity fails. |
| Failure sanitation | hostile Unicode/newline/marker JSON | constructor + custom Deserialize | Derived Deserialize/private-field removal fails property/trybuild tests. |
| Typed classification | all classes map to one terminal enum | class/stage tests + no-substring search | Swap timeout/auth mapping; tests fail. |
| `BrainUsage` saturation (`DOMAIN-002`) | characterization pin, no RED run | `brain_usage_add_saturates_at_u64_max` proves `u64::MAX` per counter plus one normal sum | Replace one `saturating_add` with `+` or cross-wire two counters; the hand-derived table fails. |
| Store fail-closed defaults | incomplete store calls | every truth-bearing call returns Unavailable | Restore `Ok(0/false/())`; contract test fails. |
| Write observability | insert/replay/count tables | store conformance | Increment count on replay or drop usage; row/count proof fails. |
| D-04 selector exclusivity | missing/duplicate/unselected ledger exits 64 | exactly one selected surface | Expose a restore symbol under `CONFIRM_DELETE` or omit one under `SOFT_DELETE_UNDO`; compile/source proof fails. |
| D-04 Branch-B values | exact fixture plus hostile serde table | private constructors and canonical round trip | Unknown key, wrong literal, UUID/time/window relaxation, or outcome drift fails. |
| D-04 Branch-B ports | incomplete store plus 0/1/100/101 table | memory/Postgres overrides and service consumption | Return `Ok(0)`, accept 101, or reach a default; domain/data proof fails. |
| Digest converse/shape | missing, upper, nonhex, wrong length | valid lowercase 64 hex | Relax any predicate; proptest/boundary table fails. |
| Capture bounds | 0/max/max+1 and mode matrix | exact constants | Off-by-one or odd PCM acceptance; boundary test fails. |
| Audio fixture isolation | compile-fail old constructor | bytes/base64 APIs only | Re-add text constructor; trybuild unexpectedly compiles. |
| Base64 caching | pointer stable across access/serde | borrowed `&str` | Recompute/return `String`; compile/runtime test fails. |
| Real purity | injected dependency/import failures | metadata/source gate | Add reqwest/sqlx/axum/std::fs/tokio::net; gate fails. |
| Unused dependencies | cargo-udeps | zero findings | Re-add one confirmed dead adapter dependency; job fails. |

## Self-review

- `study.rs`, `tools.rs`, `tool_executor.rs`, and Plan 04 learning modules/tests/fixtures are explicitly excluded; Plan 04 owns them permanently.
- No adapter, service, data, observe, migration, protocol, root-package, workflow, or public-documentation implementation is assigned to this plan; only exact handoff contracts are named.
- Every behavioral change has a RED test before GREEN implementation. `BATCH_FIX` is used only for deduplication, fixture API isolation/caching, direct test coverage, and dependency cleanup.
- Error and failure classification is exhaustive and typed before Plans 07/08 consume it. Sanitized strings are diagnostics, never authority.
- Every non-D-04 domain policy is resolved with numeric or enum-exact contracts; D-04 is an explicit hard selector whose two mutually exclusive compiled surfaces are fully specified.
- No unfinished marker, ignored failure, or best-effort write is accepted by this plan.
- Local green tests do not claim hosted, live-provider, durable Postgres, or release correctness.
