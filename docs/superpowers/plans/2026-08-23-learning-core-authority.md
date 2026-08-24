# Viva Learning Core Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Viva's fixture-grade learning loop with one versioned, server-authoritative chain from semantic evaluation evidence through persisted turn outcomes, mastery transitions, question progression, recap, review scheduling, and the authenticated study projection consumed by every learner surface.

**Architecture:** The live evaluator returns a typed `EvaluationDecision`; `VivaToolExecutor` binds it to the authorized question/rubric/source and converts it to the only persistable learner fact, `TurnOutcome`. The store atomically persists the outcome and its `ConceptStatusTransition`s. Recaps are pure projections of persisted `SessionLearningEvidence`; they never inspect expected-term positions. Question selection returns a session-scoped `QuestionProgressionResult`, not the store's first active question. Review scheduling follows the D-01 branch selected by Connor, while both branches expose one typed server-owned read model. The browser consumes `AuthenticatedStudyProjectionV1` and formats facts; it cannot infer readiness, replace recap buckets, select a question, or compute a competing learner-visible due date.

**Tech Stack:** Rust 1.88, async-trait, serde/serde_json, Tokio, SQLx/Postgres, Bun, TypeScript 5.9, ts-fsrs 5.4.1, React/Next.js, shared JSON fixtures.

**Spec:** The binding source corpus is `../reviews/2026-08-23-architecture-review.md`, `../reviews/2026-08-23-correctness-review.md`, `../reviews/2026-08-23-rust-agent-domain.md`, `../reviews/2026-08-23-packages-shared.md`, `../reviews/2026-08-23-frontend-review.md`, `../reviews/2026-08-23-architecture-consistency.md`, `../reviews/2026-08-23-comprehensive-review-summary.md`, and `../reviews/index.md`, reconciled through `2026-08-23-review-remediation-finding-coverage-ledger.md`. When this plan is stricter than an older implementation plan, this plan governs the LEARN lane.

---

## Global Constraints

- This plan permanently owns `agent/crates/agent-domain/src/study.rs`, `agent/crates/agent-domain/src/tools.rs`, `agent/crates/agent-domain/src/tool_executor.rs`, Plan-04-created learning modules/tests/fixtures, `packages/core/src/scheduling.ts`, `packages/core/src/learner-loop-contract.json`, `packages/core/src/learner-loop-contract.ts`, and `packages/core/src/learner-recovery-copy.ts` after the `CRIT-SCHED-01` handoff. Any later plan needing those files must request an explicit handoff from the LEARN owner.
- Plan 06 permanently owns `agent/crates/agent-domain/src/brain.rs`, `agent/crates/agent-domain/src/ports.rs`, `agent/crates/agent-domain/src/lib.rs`, `agent/crates/agent-domain/Cargo.toml`, `agent/crates/agent-domain/tests/protocol_fixtures.rs`, and any new `agent/crates/agent-domain/src/session_state.rs`. Plan 04 specifies exact events, store methods, exports, and fixture mirrors below, but never edits or stages those Plan 06 files; GREEN requires the recorded Plan 06 SHA on the same combined tree.
- Plan 03 (`CRIT-SCHED-01`) owns the fixed June-2026 correction and the executable selected D-01 v1 seam: Branch A publishes/persists `PersistedFsrsCardV1` plus `ReviewScheduleDecisionV1` and may create `0015_review_schedule_decisions_v1.sql`; Branch B publishes/persists `ReviewHistoryEventV1` plus the `ReadTimeReviewProjectionV1` core projection and may create `0015_review_history_events_v1.sql`. Rebase on the recorded Plan 03 merge, consume the selected types/ports/conformance fixture/migration without redefining them, and preserve their historical v1 meaning. Plan 04 may extend the selected seam into outcomes, recaps, progression, and `AuthenticatedStudyProjectionV1`; it must not create a parallel scheduling schema, migration, store port, or algorithm implementation.
- The coordinator-owned coverage ledger is read-only to workers. Report decision, branch, commit, and proof to the coordinator; only the coordinator changes ledger status.
- Production code has no implicit fixture evaluator, fixture calendar, fixture question, fixture concept ID, default `Strong` status, or biology fallback. `SyntheticFixtureAnswerEvaluator` is permitted only under the explicit synthetic/fake construction path.
- A deferred evaluation is a persisted fact, not an invitation to invent a grade. It emits no mastery transition, schedule decision, or graded recap bucket.
- The model, browser, route, and adapter may propose inputs. None may persist a due date, concept status, recap bucket, active question, study identity, mode, or goal unless the selected server policy validates and binds it.
- Behavioral minors get their own RED/GREEN task and commit. The minor batch rule applies only to the nonbehavioral deep-freeze/fixture-boundary hardening in Task LEARN-010.
- No incomplete implementation, permissive compatibility fallback that fabricates learner facts, or tests that only mirror constructors are acceptable.
- Every filtered test gate in this plan (a `cargo test <filter>` or scoped `bun test` command) passes only when its output reports a nonzero executed-test count; a run reporting `running 0 tests`, or matching no test files, is a FAILED gate, never a vacuous pass.

## Decision register

All three rows begin `DECISION_REQUIRED`. Connor selects exactly one executable branch per row; workers may commit the branch-neutral RED tests and shared interfaces first, then stop at the named GREEN gate.

| Decision | Status / owner | Branch A | Branch B | Downstream effect |
| --- | --- | --- | --- | --- |
| D-01 — scheduling/exam authority | `DECISION_REQUIRED` / Connor | **D-01A (recommended, do not auto-select):** server-persisted FSRS card state and due date, with a pure Rust writer differentially checked against `@viva/core` | **D-01B:** persist ordered review evidence/status events only; an authenticated TypeScript server read path replays FSRS and owns `ReadTimeReviewProjectionV1` | Plan 03 implements the selected v1 persistence/projection slice; Plan 04 consumes and extends it; Plans 09, 11, and 10 implement only that selected shape |
| D-02 — question progression | `DECISION_REQUIRED` / Connor | **D-02A:** deterministic adaptive ranking from persisted weakness/due/centrality signals, with stable tie-breaking and explicit exhaustion | **D-02B:** deterministic ingestion-order progression, retry-current, and explicit exhaustion as the minimum honest multi-question scope | Plan 07 emits the returned question; Plan 09 persists the cursor; Plan 10 renders progress |
| D-03 — modes/goals | `DECISION_REQUIRED` / Connor | **D-03A (recommended, do not auto-select):** sign and bind normalized mode+goal into session authority and execute the defined mode policy | **D-03B:** remove unsupported mode/goal inputs; expose one honest `Begin oral exam` action backed by canonical internal `quiz` execution and no goal | Plans 08, 10, and 11 must either bind the selected values or remove them end-to-end |

## Integration nodes 04a/04b

The program DAG (program Section 6, `C03 → L04A → L06 → L04B`) splits this lane into two integration PRs from the same worktree, using the program's two-PR single-lane pattern:

- **04a — learning types** (merges after Plan 03, before Plan 06): the type-only portions of LEARN-002, LEARN-001, LEARN-004A/B, LEARN-005A, LEARN-007, and LEARN-008 — the new learning modules (`learning_outcome.rs`, `learning_recap.rs`, `learning_progression.rs`, `study_projection.rs`), the `study.rs`/`tools.rs` type extensions that reference only already-registered types, and the shared `agent/fixtures/learning-core/*` fixtures. No `tool_executor.rs` change and no `tests/learning_core.rs` content rides in 04a. Because Plan 06 owns `lib.rs`, the new module files land unregistered (and therefore uncompiled) in 04a; every 04a-staged file must compile without any Plan 06 commit, so `study.rs`/`tools.rs` extensions must be additive and self-contained, and all tests exercising the new modules land in 04b. A `study.rs`/`tools.rs` extension that references a type defined in a not-yet-registered module — LEARN-002's `StudyQuestion.rubric: EvaluationRubricV1` and LEARN-005A's `SessionLearningPolicy`/`BoundLearningIntentV1` — rides in that task's 04b commit instead, so every 04a-staged file still compiles on the post-04a integration tip; those tasks stage `study.rs` only in their 04b git-add lists.
- **04b — learning authority** (merges only after the recorded Plan 06 integration commit): every `tool_executor.rs` change, `tests/learning_core.rs`, the `packages/core` TypeScript commits, and all remaining behavior.

Each task's commit step therefore produces up to two commits with the exact staged paths it lists: a types commit (04a) and an executor/tests commit (04b). Tasks with no type-only portion (LEARN-003A/B, LEARN-005B, LEARN-006, LEARN-006A, LEARN-009, LEARN-010) commit only to 04b. The partition constrains commit content, not timing: a types commit created after the 04a PR has merged (for example a decision-gated task executed late) rides in 04b, and the 04a/04b split never delays a decision or blocks decision-independent work.

---

### Task LEARN-000: Rebase on CRIT-SCHED-01 and establish decision/ownership gates

**Files:**
- Read only: `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`
- Read only: `agent/crates/agent-domain/src/tool_executor.rs`
- Read only: `agent/crates/agent-adapters/src/synthetic.rs`
- Read only: `packages/core/src/scheduling.ts`

- [ ] **Step 1: Rebase on the exact coordinator-recorded CRIT-SCHED-01 merge**

Run:

```bash
git status --short
git rebase review-remediation/integration
plan03_merge_sha="$(rg -o 'Plan 03 merge SHA[^0-9a-f]*[0-9a-f]{40}' docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md | rg -o '[0-9a-f]{40}' | tail -1)"
test -n "$plan03_merge_sha"
git merge-base --is-ancestor "$plan03_merge_sha" HEAD
git rev-parse HEAD
```

Expected: rebase succeeds without discarding unrelated work, the ledger contains exactly recorded Plan 03 merge ancestry, and the ancestry check exits zero. Record the new exact head in execution notes. Do not substitute a guessed SHA. The coordinator must record the Plan 03 merge in the ledger as the literal line `Plan 03 merge SHA: <40-hex>`; if that line is absent, stop and request the coordinator add it in exactly that format — do not parse alternative phrasings and do not guess.

- [ ] **Step 2: Verify the selected v1 scheduling handoff instead of duplicating it**

Run:

```bash
rg -n '2026-06-(18|19|20|24)T09:00:00Z|storage_due_at_for_status' agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-adapters/src/synthetic.rs
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test review_scheduling_conformance -- --nocapture
d01_authority="$(sed -n 's/^Selected authority: `\([^`]*\)`$/\1/p' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md)"
case "$d01_authority" in
  SERVER_PERSISTED_FSRS)
    test -f agent/crates/agent-domain/src/review_schedule.rs
    test -f agent/migrations/0015_review_schedule_decisions_v1.sql
    rg -n 'PersistedFsrsCardV1|ReviewScheduleDecisionV1|review_scheduling_context|persist_review_schedule_decision' agent/crates/agent-domain agent/crates/data packages/core/src/scheduling.ts
    ;;
  EVENTS_PLUS_READ_TIME_PROJECTION)
    test -f agent/crates/agent-domain/src/review_history.rs
    test -f agent/migrations/0015_review_history_events_v1.sql
    rg -n 'ReviewHistoryEventV1|ReadTimeReviewProjectionV1|record_review_history_event|projectReviewHistoryAtReadTime' agent/crates/agent-domain agent/crates/data packages/core/src/scheduling.ts
    ;;
  *) exit 1 ;;
esac
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
```

Expected: the literal calendar table is absent; the `CRIT-SCHED-01` injected-clock regression passes; exactly the selected v1 module, migration, store seam, projection, and independently derived conformance fixture exist; and the selected Plan 03 suite passes. If any check fails, stop and return the branch to Plan 03. Do not patch, recreate, or renumber its seam here.

- [ ] **Step 3: Ask the coordinator to record file ownership and all decisions**

The coverage ledger must state:

```text
LEARN permanent owner after CRIT-SCHED-01 handoff:
  agent/crates/agent-domain/src/study.rs
  agent/crates/agent-domain/src/tools.rs
  agent/crates/agent-domain/src/tool_executor.rs
  agent/crates/agent-domain/src/learning_outcome.rs
  agent/crates/agent-domain/src/learning_recap.rs
  agent/crates/agent-domain/src/learning_progression.rs
  agent/crates/agent-domain/src/study_projection.rs
  agent/crates/agent-domain/tests/learning_core.rs
  agent/fixtures/learning-core/*
  packages/core/src/scheduling.ts
  packages/core/src/learner-loop-contract.json
  packages/core/src/learner-loop-contract.ts
  packages/core/src/learner-recovery-copy.ts

D-01 = D-01A | D-01B
D-02 = D-02A | D-02B
D-03 = D-03A | D-03B
Decision owner = Connor
```

Also report these three items to the coordinator:

- Record the Plan 03 merge in the ledger as the literal line `Plan 03 merge SHA: <40-hex>` at Plan 03 merge time; LEARN-000 Step 1 parses exactly that format and has no fallback.
- Confirm Plan 06 Task 1A (rust-domain-integrity — the receiving D-03 task for the `brain.rs`/`session_state.rs` changes named in LEARN-005A/B) is recorded as the domain-side receiver before either D-03 GREEN gate is scheduled.
- Request a program Section 4 ownership row: `packages/core/src/learner-recovery-copy.ts` | None | Plan 04 | consumers import generated copy only.

Expected: each selected branch is recorded before its GREEN step. If a row remains `DECISION_REQUIRED`, execute only its RED tests and stop.

- [ ] **Step 4: Confirm this preflight creates no commit**

Run: `git status --short`

Expected: no change from this task.

---

### Task LEARN-002: Define the versioned semantic evaluation and persisted turn-outcome boundary

**Canonical IDs:** `LEARN-002`; this task also publishes the learning-core contract consumed by Plan 07's literal `ADAPTER-01` and `ADAPTER-02` tasks.

**Files:**
- Modify: `agent/crates/agent-domain/src/study.rs`
- Create: `agent/crates/agent-domain/src/learning_outcome.rs`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/brain.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/ports.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/lib.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/tests/protocol_fixtures.rs`
- Create: `agent/crates/agent-domain/tests/learning_core.rs`
- Create: `agent/fixtures/learning-core/turn-outcomes-v1.json`

- [ ] **Step 1: Write RED contract and adversarial tests**

Add tests that prove all of the following:

- `"NADH does not donate electrons"` cannot become `Strong` merely because substrings are present.
- A correct synonym can be accepted when the semantic evaluator satisfies the rubric criterion without repeating an expected term.
- A decision containing both satisfied and contradicted evidence cannot cross the `Strong` boundary.
- Empty input, uncertain transcript, evaluator unavailability, malformed evaluator output, incomplete criterion coverage, and internally contradictory evaluator output (the same `criterion_id` assessed both `Satisfied` and `Contradicted` within one decision) produce a persisted deferred outcome.
- A deferred outcome produces zero `ConceptStatusTransition`s.
- Evaluation labels and concept status bands are exhaustive and reachable at exact boundaries.
- Replaying the same `(voice_session_id, response_id)` returns the identical `TurnOutcome`; a changed payload for the same key fails closed.
- A correction challenge cannot mutate mastery unless a replacement `TurnOutcome` supersedes the challenged outcome.
- The shared fixture parses into Rust and contains evaluated, deferred, contradiction, synonym, replay, and challenge cases.

Use these exact public types and signatures in the RED tests:

```rust
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EvaluationRubricV1 {
    pub policy_version: String, // exactly "viva.semantic-rubric.v1"
    pub criteria: Vec<RubricCriterionV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RubricCriterionV1 {
    pub criterion_id: String,
    pub concept_id: String,
    pub claim: String,
    pub source_id: String,
    pub required: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EvaluationRequest {
    pub response_id: String,
    pub question: StudyQuestion,
    pub answer_text: String,
    pub transcript_confidence: Option<f32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriterionAssessmentKind {
    Satisfied,
    Contradicted,
    NotDemonstrated,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CriterionAssessment {
    pub criterion_id: String,
    pub assessment: CriterionAssessmentKind,
    pub confidence: f32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationLabel {
    Strong,
    MostlyCorrect,
    PartiallyCorrect,
    Vague,
    Wrong,
    InsufficientEvidence,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationDeferralReason {
    EmptyAnswer,
    TranscriptUncertain,
    EvaluatorUnavailable,
    InvalidEvaluatorOutput,
    InsufficientSemanticEvidence,
    ContradictoryEvidence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvaluationError {
    Unavailable,
    Timeout,
    MalformedResponse,
    ContractViolation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvaluationDecision {
    Evaluated {
        assessments: Vec<CriterionAssessment>,
        concise_feedback: String,
        retry_prompt: Option<String>,
    },
    Deferred {
        reason: EvaluationDeferralReason,
        can_retry_same_question: bool,
    },
}

#[async_trait]
pub trait AnswerEvaluator: Send + Sync {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationDecision, EvaluationError>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConceptStatusTransition {
    pub concept_id: String,
    pub from_status: ConceptStatus,
    pub to_status: ConceptStatus,
    pub criterion_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionDisposition {
    Advance,
    RetryCurrent,
    Deferred,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnResolution {
    Evaluated {
        label: EvaluationLabel,
        confidence: f32,
        assessments: Vec<CriterionAssessment>,
        concept_transitions: Vec<ConceptStatusTransition>,
        concise_feedback: String,
        retry_prompt: Option<String>,
        disposition: QuestionDisposition,
    },
    Deferred {
        reason: EvaluationDeferralReason,
        can_retry_same_question: bool,
        disposition: QuestionDisposition,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnOutcome {
    pub schema: String, // exactly "viva.turn_outcome.v1"
    pub response_id: String,
    pub question_id: String,
    pub rubric_policy_version: String,
    pub recorded_at: String, // authoritative RFC3339 UTC
    pub source_ids: Vec<String>,
    pub supersedes_response_id: Option<String>,
    pub resolution: TurnResolution,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TurnOutcomeRecordReceipt {
    pub schema: String, // exactly "viva.turn_outcome_record.v1"
    pub response_id: String,
    pub replayed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PersistedTurnOutcome {
    pub turn_outcome: TurnOutcome,
    pub record: TurnOutcomeRecordReceipt,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeDisposition {
    SourceConfirmed,
    ReevaluationRequired,
    Deferred,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ChallengeResolution {
    pub schema: String, // exactly "viva.challenge_resolution.v1"
    pub correction_id: String,
    pub challenged_response_id: String,
    pub source_id: String,
    pub disposition: ChallengeDisposition,
    pub replacement_response_id: Option<String>,
}
```

Plan-04-owned `learning_outcome.rs` defines every type in this block, including the exhaustive message-free `EvaluationError`; `study.rs` extends `StudyQuestion` with `concept_id: String` and `rubric: EvaluationRubricV1`. Do not persist `answer_text` in `TurnOutcome` or the shared fixture.

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_turn_outcomes -- --nocapture
```

Expected: FAIL because the versioned types, evaluator port, persisted outcome API, and fixture do not exist.

- [ ] **Step 3: Implement the evaluator boundary and fail-closed policy**

Implement `AnswerEvaluator` injection as a required `VivaToolExecutor` constructor argument; there is no default evaluator. `evaluate_spoken_answer` must:

1. Rebind session, question, answer text, rubric, concept IDs, and source IDs to server-owned values.
2. Call `AnswerEvaluator::evaluate` with the ephemeral answer.
3. Reject unknown/duplicate/missing criterion IDs, non-finite confidence, provider-selected concept IDs, and sources outside the question rubric.
4. Convert a complete evaluated decision to rubric-derived label/status transitions using the locked policy below. A contradiction on any criterion forbids `Strong`; a contradiction on a required criterion makes that concept `Missed` regardless of aggregate confidence.
5. Convert empty/uncertain/unavailable/invalid/incomplete/internally-contradictory decisions to `TurnResolution::Deferred` with no transitions. `EvaluationError::{Unavailable,Timeout}` maps to `EvaluationDeferralReason::EvaluatorUnavailable`; `EvaluationError::{MalformedResponse,ContractViolation}` maps to `EvaluationDeferralReason::InvalidEvaluatorOutput`; a decision assessing the same `criterion_id` both `Satisfied` and `Contradicted` maps to `EvaluationDeferralReason::ContradictoryEvidence`. No provider message is persisted.
6. Persist through the atomic store method below.
7. Return exactly `{"turn_outcome": outcome, "record": receipt}`. Consumers never infer learner facts from `record`.

The `viva.semantic-rubric.v1` mapping is exact and workers do not tune it:

- an answer empty after Unicode whitespace trimming becomes `EmptyAnswer` before provider invocation; a present transcript confidence that is non-finite, outside `[0.00, 1.00]`, or below `0.65` becomes `TranscriptUncertain`; absent transcript confidence is allowed and is not converted to certainty;
- every rubric must contain at least one required criterion per authorized concept;
- every assessment confidence must be finite and within `[0.00, 1.00]`; an out-of-range value is `InvalidEvaluatorOutput`, while any valid value below `0.60` defers the entire turn as `InsufficientSemanticEvidence` rather than forcing a grade;
- per concept, any required `Contradicted` assessment yields `Missed`; otherwise all required `Satisfied` with minimum confidence at least `0.85` yields `Strong`; all required `Satisfied` below `0.85`, or an optional contradiction, yields `Shaky`; at least half of required criteria `Satisfied` yields `Shaky`; at least one but fewer than half yields `Review`; zero yields `Missed`;
- overall `confidence` is the minimum confidence across required assessments;
- overall `label` is `Wrong` when any required criterion is contradicted; otherwise `Strong` when every transition is Strong; `MostlyCorrect` when every transition is Strong/Shaky and at least one is Shaky; `PartiallyCorrect` when at least half of all required criteria are satisfied; `Vague` when at least one but fewer than half are satisfied; and `InsufficientEvidence` when none are satisfied;
- criteria are counted by exact IDs, so duplicates, omissions, an empty required set, or a concept without a required criterion is `InvalidEvaluatorOutput`, not a denominator shortcut;
- a decision containing both a `Satisfied` and a `Contradicted` assessment for the same `criterion_id` is the one conflicting-duplicate exception to the duplicate-ID rule: it defers the entire turn as `ContradictoryEvidence`; a clean required-criterion `Contradicted` assessment is graded (`Missed`/`Wrong`), never deferred.
- `concise_feedback` must contain 1–480 Unicode scalar values after trim; `retry_prompt`, when present, must contain 1–240; control characters or overflow makes the evaluator output invalid, and neither field may contain source text not authorized by the rubric.

`SessionLearningEvidence` is defined in Task LEARN-001, which deliberately executes after this task; Plan 06's single port-integration commit lands only after both the LEARN-002 and LEARN-001 Plan 04 commits exist. Plan 06 adds these exact methods to `StudyMemoryStore` in `ports.rs`; additive defaults, if needed for explicitly partial/test stores, must return only `Err(PortError::unavailable(...))`, never `Ok` with a fabricated fact. Plan 04 calls them from `tool_executor.rs` but does not edit the trait file. Plans 07 and 09 update every production implementation on the combined tree, and Plan 09 tests invoke all five memory/Postgres overrides and reject `Unavailable` before LEARN-011/LEARN-012 record final post-merge GREEN (this is not a Plan 04 lane-merge precondition):

```rust
async fn record_turn_outcome(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    outcome: TurnOutcome,
) -> Result<PersistedTurnOutcome, PortError>;

async fn session_learning_evidence(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<SessionLearningEvidence, PortError>;

async fn record_challenge_resolution(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    resolution: ChallengeResolution,
) -> Result<ChallengeResolution, PortError>;
```

`record_turn_outcome` is the only production mutation for evaluated mastery: it atomically persists the outcome, applies its transitions with previous-status validation, and applies its `QuestionDisposition`. Its return serializes directly as `ToolResult.result = {"turn_outcome": persisted.turn_outcome, "record": persisted.record}`; `record` is an audit/idempotency receipt only and no consumer derives learner facts from it. `record_challenge_resolution` binds the challenged outcome and canonical source; only a later validated outcome whose `supersedes_response_id` matches may replace its mastery. Retire the live use of independent `record_answer_evaluation` and `record_concept_status`; retain temporary compatibility only behind explicit migration code that cannot be constructed by live/fake runners.

Plan 06 adds the exact deferred domain event to `brain.rs` and its only `lib.rs` export path:

```rust
BrainEvent::TurnDeferred {
    response_id: String,
    question_id: String,
    reason: EvaluationDeferralReason,
    can_retry_same_question: bool,
}
```

Its wire mirror is `turn_deferred`; Plan 05 adds only the active wire `turn_id` and copies these four domain fields losslessly. It carries no provider message, feedback, confidence, concept status, schedule, or mastery.

Plan 06 also makes `protocol_fixtures.rs` parse `agent/fixtures/learning-core/turn-outcomes-v1.json` into the Plan-04-owned `learning_outcome.rs` types. It must import those types; it must not redeclare a protocol-only `TurnOutcome`.

- [ ] **Step 4: Verify GREEN and run the negative control**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures -- --nocapture
rg -n 'normalized_answer\.contains|contains\(&term\.to_ascii_lowercase|concept_status_for_terms|feedback_for_terms' agent/crates/agent-domain/src
```

Expected: tests PASS on one combined tree containing the Plan 04 implementation commit and the recorded Plan 06 event/port/export/fixture commit, and the production substring grader search returns no matches. Temporarily make an evaluated fixture omit one required criterion and verify the invalid-output test fails before restoring it.

- [ ] **Step 5: Commit the branch-neutral outcome contract**

Run:

```bash
git add agent/crates/agent-domain/src/learning_outcome.rs agent/fixtures/learning-core/turn-outcomes-v1.json
git commit -m "feat(learning): add turn outcome types [04a]"
git add agent/crates/agent-domain/src/study.rs agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs
git commit -m "feat(learning): persist authoritative turn outcomes [04b]"
```

Expected: two Plan 04 commits partitioned per the Integration nodes 04a/04b section — the types commit (04a) and the executor/tests commit (04b) containing the observed RED tests and owned implementation. Record the separate Plan 06 SHA for `brain.rs`, `ports.rs`, `lib.rs`, and `protocol_fixtures.rs`; the 04b commit is not accepted GREEN until the combined-tree commands in Step 4 pass.

---

### Task LEARN-001: Build mastery and recap only from persisted session evidence

**Canonical ID:** `LEARN-001`.

**Files:**
- Modify: `agent/crates/agent-domain/src/study.rs`
- Create: `agent/crates/agent-domain/src/learning_recap.rs`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/ports.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/lib.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/tests/protocol_fixtures.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Create: `agent/fixtures/learning-core/recaps-v1.json`

- [ ] **Step 1: Write RED evidence-derived recap tests**

Cover:

- all-missed outcomes;
- mixed strong/shaky/missed outcomes across multiple questions;
- a session containing only deferred outcomes;
- an evaluated outcome followed by an idempotent replay;
- reconnect and rebuild from the same persisted rows;
- a superseded challenged outcome;
- no outcomes;
- two concepts with the same label but different IDs;
- a source moment whose source does not belong to an outcome.

Assert exact equality between the first recap and replay/reconnect recap, zero duplicated concepts, no term-position buckets, and no graded bucket for deferred/no-outcome cases.

Use these exact inputs/outputs:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionLearningEvidence {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub outcomes: Vec<TurnOutcome>,
    pub concept_labels: Vec<ConceptLabel>,
    pub review_decisions: Vec<ReviewScheduleSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConceptLabel {
    pub concept_id: String,
    pub label: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewScheduleAuthority {
    ServerPersistedFsrs,
    CoreFsrsReadTime,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReviewScheduleSummary {
    pub concept_id: String,
    pub due_at: String,
    pub authority: ReviewScheduleAuthority,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecapConceptOutcome {
    pub concept_id: String,
    pub label: String,
    pub status: ConceptStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecapSourceMoment {
    pub response_id: String,
    pub source_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecapBuildError {
    EvidenceIdentityMismatch,
    DuplicateConceptLabel { concept_id: String },
    MissingConceptLabel { concept_id: String },
    DuplicateReviewDecision { concept_id: String },
    InvalidReviewDecision { concept_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudySessionRecap {
    pub schema: String, // exactly "viva.study_session_recap.v2"
    pub voice_session_id: String,
    pub headline: String,
    pub summary: String,
    pub concepts: Vec<RecapConceptOutcome>,
    pub review_schedule: Vec<ReviewScheduleSummary>,
    pub next_action: String,
    pub source_moments: Vec<RecapSourceMoment>,
    pub deferred_turns: u32,
}

pub fn build_session_recap(
    evidence: &SessionLearningEvidence,
) -> Result<StudySessionRecap, RecapBuildError>;
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core recap_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_recaps -- --nocapture
```

Expected: FAIL because recap still uses `active_question().expected_terms` and the V2 fixture is absent.

- [ ] **Step 3: Implement the pure recap fold**

`VivaToolExecutor::build_session_recap` must call the exact Plan-06-owned `StudyMemoryStore::session_learning_evidence` method from LEARN-002, then the Plan-04-owned `learning_recap::build_session_recap`, then persist the returned recap through the Plan-06-owned store trait. Plan 06 exports `learning_recap` from `lib.rs` and parses `recaps-v1.json` in `protocol_fixtures.rs` without duplicating its types. The fold must:

- order concepts by first evaluated outcome then stable `concept_id`;
- use only final nonsuperseded transitions;
- join labels by exact concept ID, never fuzzy label matching;
- include a source moment only when its source ID appears on the corresponding persisted outcome;
- derive review entries from selected D-01 decisions/projections only. Under D-01A they come from persisted `ReviewScheduleDecisionV1` rows with `ServerPersistedFsrs` authority. Under D-01B, `SessionLearningEvidence.review_decisions` and the persisted `StudySessionRecap.review_schedule` are exactly empty — the authenticated TypeScript read layer (Plan 11) attaches the `CoreFsrsReadTime` schedule from `projectReviewHistoryAtReadTime` to the recap/projection response before render, and `recaps-v1.json` contains a D-01B case with an empty `review_schedule`;
- report deferred count without assigning status;
- use deterministic truth-preserving copy. For zero graded outcomes, the exact summary is `"No graded outcome was saved for this session."`; it must not claim strength, weakness, or a review date.

Delete `strong_concepts`, `shaky_concepts`, `missed_concepts`, and `review_later` as independent persisted arrays after protocol/data/web consumers migrate to `concepts` plus `review_schedule`. Do not temporarily write both V1 and V2 from different folds.

- [ ] **Step 4: Verify GREEN and fabrication controls**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core recap_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures -- --nocapture
rg -n 'expected_terms.*take|expected_terms.*skip|strong_concepts|review_later' agent/crates/agent-domain/src/tool_executor.rs
```

Expected: tests PASS on the recorded Plan 04 plus Plan 06 combined tree; search finds no expected-position recap logic or legacy bucket construction in `tool_executor.rs`.

- [ ] **Step 5: Commit**

Run:

```bash
git add agent/crates/agent-domain/src/study.rs agent/crates/agent-domain/src/learning_recap.rs agent/fixtures/learning-core/recaps-v1.json
git commit -m "feat(learning): add recap evidence types [04a]"
git add agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs
git commit -m "feat(learning): derive recaps from persisted outcomes [04b]"
```

Expected: the two Plan 04 commits (04a types, 04b executor/tests) and the separate Plan 06 port/export/fixture commit are all recorded; GREEN means the combined tree passes Step 4.

---

### Task LEARN-003A: Extend the selected Plan 03 D-01A v1 seam through learning outcomes

**Decision gate:** RED characterization may be written while D-01 is pending. Execute production GREEN only when the coverage ledger records `D-01 = D-01A`, the recorded Plan 03 merge selected `SERVER_PERSISTED_FSRS`, and LEARN-000 verified that merge as an ancestor; then skip LEARN-003B.

**Canonical IDs:** scheduling authority, `CORE-01`, exam-policy gap, cap-explanation drift, and learner-visible interval disagreement.

**Files:**
- Read/consume after Plan 03 handoff: `agent/crates/agent-domain/src/review_schedule.rs`
- Read/consume after Plan 03 handoff: `agent/migrations/0015_review_schedule_decisions_v1.sql`
- Read/consume after Plan 03 handoff: `packages/core/src/review-scheduling-conformance-v1.json`
- Read/consume after Plan 03 handoff: `packages/core/src/review-scheduling-conformance.test.ts`
- Modify after Plan 03 handoff: `packages/core/src/scheduling.ts`
- Modify after Plan 03 handoff: `packages/core/src/scheduling.test.ts`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Plan 06 handoff: preserve/export the selected Plan 03 types and `StudyMemoryStore::{review_scheduling_context,persist_review_schedule_decision}` from `ports.rs`/`lib.rs` without a parallel port

- [ ] **Step 1: Prove the Plan 03 D-01A prerequisite is GREEN before writing expansion tests**

Run:

```bash
rg -n '^Selected authority: `SERVER_PERSISTED_FSRS`$' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md
test -f agent/crates/agent-domain/src/review_schedule.rs
test -f agent/migrations/0015_review_schedule_decisions_v1.sql
test ! -e agent/migrations/0015_review_history_events_v1.sql
rg -n 'PersistedFsrsCardV1|ReviewScheduleDecisionV1|review_scheduling_context|persist_review_schedule_decision' agent/crates/agent-domain agent/crates/data packages/core/src/scheduling.ts
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain review_schedule -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_schedule_decision -- --nocapture
```

Expected: PASS against Plan 03's checked-in v1 contract, literal cross-language fixture, selected migration, and store methods. If this fails, return it to Plan 03. Do not add a second card/decision type, `apply_review_schedule` port, migration, fixture, parameter hash, or FSRS implementation in Plan 04.

- [ ] **Step 2: Write RED outcome-to-schedule integration tests**

In `learning_core.rs`, use Plan 03's exact `PersistedFsrsCardV1` and `ReviewScheduleDecisionV1` without redeclaration. Add cases proving:

- an evaluated `TurnOutcome` supplies its server-derived status to the selected scheduler, while a deferred outcome creates no decision;
- second and tenth reviews reload the prior persisted card and do not behave like a New card;
- replay of the same authorized response returns the exact stored decision without incrementing FSRS memory;
- a changed payload under the same idempotency identity fails closed;
- an exact persisted exam timestamp applies Plan 03's selected future/close/past-exam rule, while `examLabel` never affects calculation;
- recap `ReviewScheduleSummary`, concept `dueAt`, and `AuthenticatedStudyProjectionV1.reviewSchedule` all equal the same persisted decision and use `ServerPersistedFsrs` / `server_persisted_fsrs` authority;
- a model, adapter, browser, or route cannot supply `due_at`, card state, exam metadata, policy ID, or revision;
- a scheduling persistence failure returns a retryable internal failure and cannot produce a successful recap/progression response; retry repairs through Plan 03 idempotency rather than grading twice.

Also add a RED cap-explanation truthfulness table test to `packages/core/src/scheduling.test.ts`: for each cap candidate (exam, centrality, hint, miss, recency), an explanation entry is emitted only when that candidate strictly lowers the previously computed `dueAt`; a non-binding candidate emits no entry.

- [ ] **Step 3: Run the expansion tests to verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core scheduling_outcome_ -- --nocapture
bun test packages/core/src/scheduling.test.ts
```

Expected: FAIL because the Plan 03 critical slice is not yet bound to persisted `TurnOutcome`, evidence-derived recap, progression, and the v1 authenticated study projection.

- [ ] **Step 4: Extend the selected seam without changing its v1 meaning**

After a validated evaluated outcome is persisted, `VivaToolExecutor` loads `review_scheduling_context`, passes only authoritative outcome status/provenance plus the injected clock into Plan 03's `review_schedule.rs`, and persists through `persist_review_schedule_decision`. The authorized response identity is the existing idempotency source. Deferred outcomes skip this path. Tool results expose the existing browser-safe v1 summary only; raw stability/difficulty and store revision remain server-side.

Extend `packages/core/src/scheduling.ts` only with strict consumption/projection helpers required by `AuthenticatedStudyProjectionV1`; retain Plan 03's status/rating mapping, clock discipline, FSRS version, exam-margin rule, null-provenance meaning, and conformance literals unchanged. Make cap explanations truthful: compute each candidate cap date first, compare it against the previously computed `dueAt`, and push an explanation only for a binding candidate. Delete remaining uses of `dueDateForStatus` and `reviewIntervalForStatus` instead of adapting them.

Plan 06 keeps the Plan 03 methods in the single `StudyMemoryStore` trait and exports the selected module; it adds no synonymous method. Plan 09 extends the memory/Postgres implementations and outcome/reconnect transaction tests on `0015_review_schedule_decisions_v1.sql`; it must not create another review-card table or migration. Plans 11 and 10 receive only the persisted projection, never raw cards or a browser scheduler.

- [ ] **Step 5: Verify combined GREEN, differential parity, restart, and exam policy**

Run:

```bash
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test review_scheduling_conformance -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core scheduling_outcome_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_schedule_decision -- --nocapture
```

Expected: lane GREEN — every Plan-04-owned test PASSES on a tree containing only prior-DAG-node commits (the recorded Plan 03 merge and the recorded Plan 06 SHA), using Plan-04-owned in-test fake stores that implement the new `StudyMemoryStore` methods with real hand-derived behavior (fail-closed for unimplemented paths, never fabricated `Ok` facts). Change one outcome status before scheduling and one exam comparison independently; each mutation must fail the owning integration/conformance test before restore. Plan 03's v1 fixture remains byte-for-semantic-byte unchanged. Rerunning these commands on the combined tree containing Plan 09's store implementations is post-merge consumer verification owned by LEARN-011 Steps 2–3 and LEARN-012, not a Plan 04 merge precondition.

- [ ] **Step 6: Commit only the Plan 04 D-01A extension**

Run:

```bash
git add packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs
git commit -m "feat(learning): bind outcomes to persisted FSRS decisions"
```

Expected: no migration, Plan 03 conformance fixture, Plan 06-owned file, or new scheduling schema is staged. This commit belongs entirely to integration node 04b. Record the recorded Plan 03 merge and Plan 06 SHAs used for Step 5; only those two gate this lane's merge, and Plan 09's later SHA is recorded during LEARN-011 post-merge consumer verification.

---

### Task LEARN-003B: Extend the selected Plan 03 D-01B v1 seam through authenticated learning projections

**Decision gate:** RED characterization may be written while D-01 is pending. Execute production GREEN only when the coverage ledger records `D-01 = D-01B`, the recorded Plan 03 merge selected `EVENTS_PLUS_READ_TIME_PROJECTION`, and LEARN-000 verified that merge as an ancestor; then skip LEARN-003A.

**Files:**
- Read/consume after Plan 03 handoff: `agent/crates/agent-domain/src/review_history.rs`
- Read/consume after Plan 03 handoff: `agent/migrations/0015_review_history_events_v1.sql`
- Read/consume after Plan 03 handoff: `packages/core/src/review-scheduling-conformance-v1.json`
- Read/consume after Plan 03 handoff: `packages/core/src/review-scheduling-conformance.test.ts`
- Modify after Plan 03 handoff: `packages/core/src/scheduling.ts`
- Modify after Plan 03 handoff: `packages/core/src/scheduling.test.ts`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Plan 06 handoff: preserve/export Plan 03's `ReviewHistoryEventV1` and single `StudyMemoryStore::record_review_history_event` seam from `ports.rs`/`lib.rs` without a parallel history port

- [ ] **Step 1: Prove the Plan 03 D-01B prerequisite is GREEN before writing expansion tests**

Run:

```bash
rg -n '^Selected authority: `EVENTS_PLUS_READ_TIME_PROJECTION`$' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md
test -f agent/crates/agent-domain/src/review_history.rs
test -f agent/migrations/0015_review_history_events_v1.sql
test ! -e agent/migrations/0015_review_schedule_decisions_v1.sql
rg -n 'ReviewHistoryEventV1|ReadTimeReviewProjectionV1|record_review_history_event|projectReviewHistoryAtReadTime' agent/crates/agent-domain agent/crates/data packages/core/src/scheduling.ts
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain review_history -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_history_event -- --nocapture
```

Expected: PASS against Plan 03's immutable v1 event, core-only projection, selected migration, literal conformance fixture, and store method. If this fails, return it to Plan 03. Do not add a second event/projection type, `review_history` reader port, migration, fixture, or Rust due-date implementation in Plan 04.

- [ ] **Step 2: Write RED outcome-to-history-to-projection integration tests**

Use Plan 03's exact `ReviewHistoryEventV1`, `ReadTimeReviewProjectionV1`, and `projectReviewHistoryAtReadTime` without redeclaration. Add cases proving:

- an evaluated `TurnOutcome` appends exactly one identity-bound event and a deferred outcome appends none;
- null hint/miss provenance remains null, never zero;
- replay deduplicates by Plan 03's deterministic `event_id`, while changed replay payload fails closed;
- out-of-order, duplicate, unknown-version, non-finite, cross-user/study, excessive, and exam-metadata-mismatched history fails closed;
- recap and `AuthenticatedStudyProjectionV1` use the same one-time authenticated server projection with `CoreFsrsReadTime` / `core_fsrs_read_time` authority;
- raw history never crosses the same-origin proxy and no Rust/browser path computes or persists `due_at`;
- a history persistence failure cannot produce a successful recap/progression response, and retry appends no duplicate event.

Also add a RED cap-explanation truthfulness table test to `packages/core/src/scheduling.test.ts`: for each cap candidate (exam, centrality, hint, miss, recency), an explanation entry is emitted only when that candidate strictly lowers the previously computed `dueAt`; a non-binding candidate emits no entry.

- [ ] **Step 3: Run the expansion tests to verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core review_history_outcome_ -- --nocapture
bun test packages/core/src/scheduling.test.ts
```

Expected: FAIL because Plan 03's critical event slice is not yet bound to persisted outcome evidence, recap, progression, and `AuthenticatedStudyProjectionV1`.

- [ ] **Step 4: Extend the selected seam without adding a due-date writer**

After a validated evaluated outcome is persisted, `VivaToolExecutor` constructs Plan 03's event only from bound response/session/concept identity, outcome status, known provenance, injected time, persisted exam metadata, and recorded policy; it calls the existing `record_review_history_event`. Deferred outcomes skip it. Rust never creates `ReadTimeReviewProjectionV1` or accepts/returns a learner-visible due date from the tool. Consequently, under D-01B `SessionLearningEvidence.review_decisions` and the persisted `StudySessionRecap.review_schedule` are exactly empty; the authenticated TypeScript read layer (Plan 11) attaches the `CoreFsrsReadTime` schedule from `projectReviewHistoryAtReadTime` to the recap/projection response before render.

`packages/core/src/scheduling.ts` remains the only due-date calculator and reuses Plan 03's `projectReviewHistoryAtReadTime` with one captured server read time. Make its cap explanations truthful: compute each candidate cap date first, compare it against the previously computed `dueAt`, and push an explanation only for a binding candidate. Plan 11 calls it behind authenticated identity and returns only the browser-safe schedule embedded in `AuthenticatedStudyProjectionV1`; it rejects unknown history instead of falling back to legacy `review_items`. Plan 10 never receives raw history.

Plan 06 keeps the one Plan 03 append method in `StudyMemoryStore` and exports `review_history`; it adds no reader or synonymous append port. Plan 09 expands memory/Postgres outcome/reconnect/concurrency tests on `0015_review_history_events_v1.sql`; it must not add a due column, new history table, or second migration.

- [ ] **Step 5: Verify combined GREEN and absence of competing authority**

Run:

```bash
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core review_history_outcome_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_history_event -- --nocapture
rg -n 'schedule_review_item\(|due_at' agent/crates/agent-domain/src/tool_executor.rs
```

Expected: lane GREEN — every Plan-04-owned test PASSES on a tree containing only prior-DAG-node commits (the recorded Plan 03 merge and the recorded Plan 06 SHA), using Plan-04-owned in-test fake stores that implement the new `StudyMemoryStore` methods with real hand-derived behavior (fail-closed for unimplemented paths, never fabricated `Ok` facts); the search finds no Rust tool due-date writer. Reverse event order and leak raw events into a projection fixture independently; each owning test must fail before restore. Plan 03's v1 fixture remains unchanged. Rerunning these commands on the combined tree containing Plan 09's store implementations is post-merge consumer verification owned by LEARN-011 Steps 2–3 and LEARN-012, not a Plan 04 merge precondition.

- [ ] **Step 6: Commit only the Plan 04 D-01B extension**

Run:

```bash
git add packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs
git commit -m "feat(learning): bind outcomes to review history projection"
```

Expected: no migration, Plan 03 conformance fixture, Plan 06-owned file, Rust due-date schema, or parallel event/projection type is staged. This commit belongs entirely to integration node 04b. Record the recorded Plan 03 merge and Plan 06 SHAs used for Step 5; only those two gate this lane's merge, and Plan 09's later SHA is recorded during LEARN-011 post-merge consumer verification.

---

### Task LEARN-004B: Execute D-02B — deterministic ordered question progression

**Decision gate:** RED characterization may be written while D-02 is pending. Execute production GREEN only when the coverage ledger records `D-02 = D-02B`; then skip LEARN-004A.

**Canonical ID:** question progression / repeated active question.

**Files:**
- Modify: `agent/crates/agent-domain/src/study.rs`
- Create: `agent/crates/agent-domain/src/learning_progression.rs`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Create: `agent/fixtures/learning-core/question-progression-v1.json`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/ports.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/lib.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/tests/protocol_fixtures.rs`

- [ ] **Step 1: Write RED multi-question, retry, replay, reconnect, and exhaustion tests**

Define these exact types in Plan-04-owned `learning_progression.rs` for both D-02 branches; Plan 06 re-exports that module and imports the types into its store trait and fixture parser without redeclaration:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressionPolicyId {
    OrderedV1,
    AdaptiveV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QuestionProgressionCursor {
    pub voice_session_id: String,
    pub policy: ProgressionPolicyId,
    pub current_question_id: Option<String>,
    pub completed_question_ids: Vec<String>,
    pub attempt_counts: BTreeMap<String, u32>,
    pub revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum QuestionProgressionResult {
    Selected {
        question: StudyQuestion,
        ordinal: u32,
        total: u32,
        selection_reason: String,
        revision: u64,
    },
    Retry {
        question: StudyQuestion,
        ordinal: u32,
        total: u32,
        attempt: u32,
        revision: u64,
    },
    Exhausted {
        completed: u32,
        total: u32,
        revision: u64,
    },
}
```

Tests assert: q1 -> evaluated Advance -> q2 -> q3 -> Exhausted; RetryCurrent returns the same question and increments attempt; Deferred keeps the same question without completion; replay does not advance twice; reconnect resumes the cursor; archived/inactive questions are skipped; concurrent selection has one cursor revision; exhaustion emits no fabricated fixture question.

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core ordered_progression_ -- --nocapture`

Expected: FAIL because `active_question()` always returns the first active question and no cursor exists.

- [ ] **Step 3: Implement ordered session-scoped progression**

Plan 06 adds this exact method to the only `StudyMemoryStore` trait in `ports.rs`; any compatibility default is the fail-closed `Unavailable` rule from LEARN-002 and cannot satisfy production GREEN:

```rust
async fn select_next_question(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    policy: ProgressionPolicyId,
) -> Result<QuestionProgressionResult, PortError>;
```

Plan 09 implements it transactionally. `OrderedV1` selects the first active, source-valid question by persisted ingestion ordinal that is not completed. `record_turn_outcome` applies `QuestionDisposition` and cursor revision in the same transaction as outcome/mastery persistence. `VivaToolExecutor::select_next_question` returns `json!({ "progression": result, "mode": self.session.mode.as_str() })`; it never calls the global `active_question()` shortcut. Plan 06 parses `question-progression-v1.json` in `protocol_fixtures.rs` using the Plan 04 types and adds no second cursor/result representation.

- [ ] **Step 4: Verify GREEN and fixture parity**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core ordered_progression_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_question_progression -- --nocapture
```

Expected: lane GREEN — PASS on a tree containing only prior-DAG-node commits (the recorded Plan 03 merge and the recorded Plan 06 SHA), using a Plan-04-owned in-test fake store that implements `select_next_question` with real hand-derived behavior (fail-closed for unimplemented paths, never fabricated `Ok` facts). Mutate cursor revision in the replay fixture and confirm failure before restore. Rerunning on the combined tree containing Plan 09's transactional implementation is post-merge consumer verification owned by LEARN-011 Steps 2–3 and LEARN-012, not a Plan 04 merge precondition.

- [ ] **Step 5: Commit D-02B**

Run:

```bash
git add agent/crates/agent-domain/src/study.rs agent/crates/agent-domain/src/learning_progression.rs agent/fixtures/learning-core/question-progression-v1.json
git commit -m "feat(learning): add question progression types [04a]"
git add agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs
git commit -m "feat(learning): persist ordered question progression [04b]"
```

Expected: the two Plan 04 commits and the separate Plan 06 port/export/fixture commit are recorded; only the Plan 03/06 SHAs gate this lane's merge. Plan 09's transactional implementation is verified post-merge in LEARN-011, not as a Plan 04 merge precondition.

---

### Task LEARN-004A: Execute D-02A — deterministic adaptive question progression

**Decision gate:** RED characterization may be written while D-02 is pending. Execute production GREEN only when the coverage ledger records `D-02 = D-02A`; then skip LEARN-004B.

**Files:**
- Modify: `agent/crates/agent-domain/src/study.rs`
- Create: `agent/crates/agent-domain/src/learning_progression.rs`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Create: `agent/fixtures/learning-core/question-progression-v1.json`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/ports.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/lib.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/tests/protocol_fixtures.rs`

- [ ] **Step 1: Write the common RED tests plus adaptive ranking cases**

Use the exact types/signature from LEARN-004B. Add cases proving overdue missed beats overdue shaky; shaky beats review; review beats strong; higher misses then centrality break equal status/due; already-completed questions are excluded; questions asked in this session cannot repeat without `RetryCurrent`; ties resolve by ingestion ordinal then `question_id`; absent schedule data never invents overdue status.

The exact score is:

```text
status: missed=4000, shaky=3000, review=2000, strong=0
overdue: clamp(full overdue UTC days, 0, 30) * 100
prior misses: clamp(misses, 0, 20) * 50
centrality: clamp(centrality, 0, 100) * 10
asked this session without RetryCurrent: excluded
tie break: ingestion_ordinal ASC, question_id ASC
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core adaptive_progression_ -- --nocapture`

Expected: FAIL because adaptive ranking and cursor persistence do not exist.

- [ ] **Step 3: Implement the pure ranker and atomic cursor**

Add `rank_adaptive_questions(candidates, now) -> Vec<RankedQuestion>` to Plan-04-owned `learning_progression.rs` as a pure domain function. D-01's selected projection supplies exact due timestamps; missing due contributes zero overdue points. Plan 09 implements the same Plan-06-owned `select_next_question` port transactionally with `ProgressionPolicyId::AdaptiveV1`. The outcome transaction advances/retries/deferred exactly as in D-02B.

- [ ] **Step 4: Verify GREEN and anti-repetition controls**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core adaptive_progression_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_question_progression -- --nocapture
```

Expected: lane GREEN — PASS with stable byte-equivalent fixture output on a tree containing only prior-DAG-node commits (the recorded Plan 03 merge and the recorded Plan 06 SHA), using a Plan-04-owned in-test fake store that implements `select_next_question` with real hand-derived behavior (fail-closed for unimplemented paths, never fabricated `Ok` facts). Negate the `asked this session` exclusion and confirm the repetition test fails before restore. Rerunning on the combined tree containing Plan 09's transactional implementation is post-merge consumer verification owned by LEARN-011 Steps 2–3 and LEARN-012, not a Plan 04 merge precondition.

- [ ] **Step 5: Commit D-02A**

Run:

```bash
git add agent/crates/agent-domain/src/study.rs agent/crates/agent-domain/src/learning_progression.rs agent/fixtures/learning-core/question-progression-v1.json
git commit -m "feat(learning): add adaptive progression types [04a]"
git add agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs
git commit -m "feat(learning): persist adaptive question progression [04b]"
```

Expected: the two Plan 04 commits and the separate Plan 06 port/export/fixture commit are recorded; only the Plan 03/06 SHAs gate this lane's merge. Plan 09's transactional implementation is verified post-merge in LEARN-011, not as a Plan 04 merge precondition.

---

### Task LEARN-005A: Execute D-03A — sign, bind, and execute mode plus goal

**Decision gate:** RED characterization may be written while D-03 is pending. Execute production GREEN only when the coverage ledger records `D-03 = D-03A`; then skip LEARN-005B.

**Canonical ID:** discarded landing intent/non-quiz modes.

**Files:**
- Modify: `agent/crates/agent-domain/src/study.rs`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Modify: `agent/fixtures/learning-core/question-progression-v1.json`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/brain.rs`
- Plan 06 handoff: Create/modify `agent/crates/agent-domain/src/session_state.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/lib.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/tests/protocol_fixtures.rs`

- [ ] **Step 1: Write RED binding and policy tests**

Define:

```rust
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BoundLearningIntentV1 {
    pub mode: StudyMode,
    pub goal: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionLearningPolicy {
    pub progression_policy: ProgressionPolicyId,
    pub hints_allowed: bool,
    pub per_turn_feedback: bool,
    pub reveal_feedback_at_recap: bool,
    pub weak_or_due_only: bool,
}
```

RED cases prove a browser cannot change signed mode/goal; refresh/reconnect retains them; goal normalization trims/collapses whitespace, rejects controls, and limits to 240 Unicode scalar values; empty goal becomes `None`; every mode maps to the exact policy below; goal influences only server-side question relevance among authorized concepts and never changes identity/source.

Policy table:

| Mode | progression | hints | per-turn feedback | feedback at recap | weak/due filter |
| --- | --- | --- | --- | --- | --- |
| quiz | selected D-02 | yes | yes | no | no |
| teach | selected D-02 | yes | yes, after source explanation | no | no |
| mock | ordered | no | no | yes | no |
| cram | adaptive when D-02A, otherwise ordered filtered | yes | yes | no | yes |

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core bound_intent_ -- --nocapture`

Expected: FAIL because mode defaults to quiz, goal is browser-provided, and no behavior policy consumes either.

- [ ] **Step 3: Implement the branch-neutral domain policy and downstream binding contract**

Plan 04 defines `BoundLearningIntentV1` and `SessionLearningPolicy` in `study.rs`; `SessionLearningPolicy::from_bound_intent` implements the table, and `tool_executor.rs` makes question selection and feedback release consume it explicitly. `AuthorizedStudySession` is declared in Plan-04-owned `tool_executor.rs`, so Plan 04 itself changes it to receive only the server-bound value. Plan 06 changes `brain.rs`/`session_state.rs` so `SessionConfig.mode/initial_goal` are never trusted after admission; it exports the Plan 04 types and updates `protocol_fixtures.rs` without redefining them.

Plan 11 must add `mode` and normalized `goal` to bootstrap/access-token claims and mint them from the authenticated start request. Plan 08 must overwrite client session config from verified claims and reject mismatches. Plan 10 must send the selected values in the start request and render them from `AuthenticatedStudyProjectionV1`, not query parameters.

- [ ] **Step 4: Verify GREEN and forged-client controls**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core bound_intent_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core mode_policy_ -- --nocapture
```

Expected: lane GREEN — PASS on a tree containing only prior-DAG-node commits (the recorded Plan 03 merge and the recorded Plan 06 SHA), proving the forged-client rejection at the domain admission/policy boundary with Plan-04-owned tests. Change a signed mock session's client config to cram and confirm the admission/policy test rejects it. Verifying Plans 08/11 claim minting and binding on the combined tree is post-merge consumer verification owned by LEARN-011 Steps 2–3 and LEARN-012, not a Plan 04 merge precondition.

- [ ] **Step 5: Commit D-03A**

Run:

```bash
git add agent/fixtures/learning-core/question-progression-v1.json
git commit -m "feat(learning): add bound intent and session policy fixtures [04a]"
git add agent/crates/agent-domain/src/study.rs agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs
git commit -m "feat(learning): bind mode and goal to session policy [04b]"
```

Expected: record these two Plan 04 SHAs (04a types, 04b executor/tests) and the separate Plan 06 `brain.rs`/`session_state.rs`/export/fixture SHA; the 04b commit is not GREEN without the Step 4 proof.

---

### Task LEARN-005B: Execute D-03B — remove unsupported mode and goal affordances

**Decision gate:** RED characterization may be written while D-03 is pending. Execute production GREEN only when the coverage ledger records `D-03 = D-03B`; then skip LEARN-005A.

**Files:**
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Modify: `agent/fixtures/learning-core/question-progression-v1.json`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/brain.rs`
- Plan 06 handoff: Create/modify `agent/crates/agent-domain/src/session_state.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/lib.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/tests/protocol_fixtures.rs`

- [ ] **Step 1: Write RED single-engine contract tests**

Assert `SessionConfig` has no `initial_goal`, the wire/domain mode vocabulary is exactly `quiz`, non-quiz serialized input is rejected, `AuthorizedStudySession` cannot default an absent untrusted mode, and the authenticated projection always reports `{mode:"quiz", goal:null}`. The public landing label is owned by Plan 13 and is exactly `Begin oral exam`; no test may expose the internal `quiz` identifier as a second learner choice.

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core quiz_only_ -- --nocapture`

Expected: FAIL because four modes and `initial_goal` remain public.

- [ ] **Step 3: Collapse the domain contract and issue downstream removal handoffs**

Plan 06 removes `Teach`, `Mock`, `Cram`, and `initial_goal` from `brain.rs` and any `session_state.rs` public session contract, updates the single `lib.rs` export and fixture parser, and publishes only `StudyMode::Quiz`. `AuthorizedStudySession` is declared in Plan-04-owned `tool_executor.rs`, so Plan 04 itself removes its untrusted-mode defaulting and makes `tool_executor.rs::select_next_question` report mode `quiz`. Plan 11 removes mode/goal request/claim fields, Plan 13 replaces the ornamental landing command/suggestions with the one `Begin oral exam` action, Plan 10 consumes the resulting single-mode projection without presenting a selector, and Plan 08 removes dead adapter mode branches.

- [ ] **Step 4: Verify GREEN and repository vocabulary control**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core quiz_only_ -- --nocapture
rg -n 'initial_goal|StudyMode::(Teach|Mock|Cram)' agent/crates/agent-domain/src
```

Expected: lane GREEN — test PASS on a tree containing only prior-DAG-node commits (the recorded Plan 03 merge and the recorded Plan 06 SHA) and the search returns no matches in Plan-04/06-owned files. Verifying the Plans 08/10/11 removals on the combined tree is post-merge consumer verification owned by LEARN-011 Steps 2–3 and LEARN-012, not a Plan 04 merge precondition.

- [ ] **Step 5: Commit D-03B**

Run:

```bash
git add agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs agent/fixtures/learning-core/question-progression-v1.json
git commit -m "refactor(learning): expose one oral-exam engine"
```

Expected: this commit belongs entirely to integration node 04b. Record this Plan 04 SHA and the separate Plan 06 `brain.rs`/`session_state.rs`/export/fixture SHA; neither is GREEN without the Step 4 proof.

---

### Task LEARN-006: Validate the learner-loop JSON as unknown input and preserve action intent

**Canonical ID:** shared-package learner-loop validator and recovery-action integrity.

**Files:**
- Modify: `packages/core/src/learner-loop-contract.json`
- Modify: `packages/core/src/learner-loop-contract.ts`
- Modify: `packages/core/src/learner-loop-contract.test.ts`
- Modify: `packages/core/src/learner-recovery-copy.ts`
- Modify: `packages/core/src/learner-recovery-copy.test.ts`

- [ ] **Step 1: Write RED schema-drift and action-integrity tests**

Clone the raw JSON and independently mutate each of these fields: schema, authority, resolution kind, primary intent, next intent, `learner_safe`, `sanitized_evidence`, terminal reason, runtime copy cause, evidence field, max bounds, duplicate state ID, duplicate resolution key, duplicate runtime cause, and missing success mapping. Every mutation must throw a field-specific validation error.

Add a recovery entry whose primary action is `retry_agent` and next action is `disabled`; assert the generated primary and secondary actions retain their distinct intents.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.test.ts
```

Expected: FAIL because `as LearnerLoopContract` bypasses unknown-input validation, several allowlists/literal-true fields are unchecked, and secondary action reuses primary intent.

- [ ] **Step 3: Implement complete validation and explicit next intent**

Add exported constant allowlists for resolution kinds, authorities, and action intents. Change the public signature to:

```ts
export function validateLearnerLoopContract(value: unknown): LearnerLoopContract;
```

Reconstruct the returned object field-by-field after validating exact keys and nested types; remove the unchecked cast. Add `next_action_intent` to `LearnerLoopCopy` and every JSON state. Map recovery secondary action from `next_action_intent`, never `primary_action_intent`.

Keep the behavioral module directly loadable as pure Node ESM: every relative TypeScript import includes its `.ts` suffix, and JSON uses an import attribute:

```ts
import {
  type AgentTerminalSessionReason,
  VIVA_AGENT_TERMINAL_SESSION_REASONS,
} from "./agent-contract.ts";
import contractData from "./learner-loop-contract.json" with { type: "json" };
```

Call `validateLearnerLoopContract(contractData)` without an unchecked assertion. The module performs no filesystem, browser, or package-root side effect beyond validating the imported static JSON and exporting the frozen result.

Retain learner/operator separation: action intents are closed local commands; provider text, raw errors, secrets, transcripts, and source excerpts cannot enter copy.

This function in `learner-loop-contract.ts` is the sole learner-loop behavioral implementation behind the future `@viva/core/runtime-validation` subpath. After consumers migrate, Plan 14 may add only a pure re-export aggregator, package mapping, and package-boundary tests; it must not wrap, fork, or reimplement `validateLearnerLoopContract(value: unknown)`.

- [ ] **Step 4: Verify GREEN and mutation controls**

Run:

```bash
bun test packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.test.ts
node --experimental-strip-types --input-type=module -e 'const m = await import("./packages/core/src/learner-loop-contract.ts"); if (typeof m.validateLearnerLoopContract !== "function") process.exit(1)'
```

Expected: PASS under Bun and direct Node ESM. Remove one allowed authority from the validator set and confirm the canonical JSON import fails before restore.

- [ ] **Step 5: Commit the behavioral/schema fix separately**

Run:

```bash
git add packages/core/src/learner-loop-contract.json packages/core/src/learner-loop-contract.ts packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.ts packages/core/src/learner-recovery-copy.test.ts
git commit -m "fix(core): validate learner recovery intents"
```

---

### Task LEARN-006A: Remove the stale terminal union duplicate from runtime validation

**Canonical ID:** packages-shared minor 6 (`LEARN-006A` in the ledger); Plan 04 owns the behavioral cleanup and Plan 14 owns only package export wiring.

**Files:**
- Modify: `packages/core/src/learner-loop-contract.ts`
- Modify: `packages/core/src/learner-loop-contract.test.ts`
- Plan 14 handoff after this GREEN commit: Create `packages/core/src/runtime-validation.ts`
- Plan 14 handoff after this GREEN commit: Modify `packages/core/package.json`
- Plan 14 handoff after this GREEN commit: Modify package export-boundary tests for `@viva/core/runtime-validation`

- [ ] **Step 1: Write the RED single-authority terminal-reason test**

Require this exact exported runtime set and derived type:

```ts
export const VIVA_LEARNER_LOOP_TERMINAL_REASONS: readonly LearnerLoopTerminalReason[] = [
  ...VIVA_AGENT_TERMINAL_SESSION_REASONS,
  ...VIVA_PRE_LOOP_TERMINAL_REASONS,
];

export type LearnerLoopTerminalReason =
  | AgentTerminalSessionReason
  | VivaPreLoopTerminalReason;
```

The test asserts the array equals the two authoritative arrays in that order, has no duplicates, contains `durability_degraded` exactly once through `VIVA_AGENT_TERMINAL_SESSION_REASONS`, and is the only set used by `validateLearnerLoopContract`. It also calls `validateLearnerLoopContract` through the direct module with an `unknown` valid value and one unknown terminal reason.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
bun test packages/core/src/learner-loop-contract.test.ts
rg -n '\| "durability_degraded"|knownTerminalReasons\.add\("durability_degraded"\)|^[[:space:]]*"durability_degraded",$' packages/core/src/learner-loop-contract.ts
```

Expected: test FAIL because the exported composed allowlist is absent, and the search finds the stale explicit union/validator entry.

- [ ] **Step 3: Delete only the redundant arm and route validation through the composed allowlist**

Remove `| "durability_degraded"` from `LearnerLoopTerminalReason` and remove the explicit validator insertion. Export `VIVA_LEARNER_LOOP_TERMINAL_REASONS` from the two authoritative arrays and build the validator set from it. Do not remove `durability_degraded` from the agent contract or JSON state: it remains a valid agent terminal reason exactly once.

Plan 14 creates a pure-ESM `runtime-validation.ts` aggregator and maps `@viva/core/runtime-validation` to it. The aggregator uses explicit `.ts` relative specifiers and only re-exports behavior owned elsewhere: Plan 04's exports below plus Plan 05's `parseVivaServerFrame(value: unknown)`. Plan 14 adds no behavioral wrapper and does not modify either source behavior file.

The Plan 04 side of that subpath exports exactly:

```ts
export {
  validateLearnerLoopContract,
  VIVA_LEARNER_LOOP_CONTRACT,
  VIVA_LEARNER_LOOP_EVIDENCE_FIELDS,
  VIVA_LEARNER_LOOP_MAX_TURN_MS,
  VIVA_LEARNER_LOOP_TERMINAL_REASONS,
  VIVA_PRE_LOOP_TERMINAL_REASONS,
  VIVA_RUNTIME_COPY_CAUSES,
  type LearnerLoopAuthority,
  type LearnerLoopContract,
  type LearnerLoopCopy,
  type LearnerLoopEvidenceField,
  type LearnerLoopResolutionKind,
  type LearnerLoopState,
  type LearnerLoopTerminalReason,
  type RuntimeCopyCause,
  type VivaPreLoopTerminalReason,
} from "./learner-loop-contract.ts";
```

- [ ] **Step 4: Verify GREEN and the duplicate-removal control**

Run:

```bash
bun test packages/core/src/learner-loop-contract.test.ts
test "$(rg -c '"durability_degraded"' packages/core/src/agent-contract.ts)" -ge 1
test "$(rg -c '\| "durability_degraded"|^[[:space:]]*"durability_degraded",$' packages/core/src/learner-loop-contract.ts)" -eq 0
```

Expected: PASS; the direct learner-loop implementation has no redundant literal while the authoritative agent terminal vocabulary still contains the value. Temporarily remove `durability_degraded` from `VIVA_AGENT_TERMINAL_SESSION_REASONS` and confirm the exact-membership test fails before restore.

- [ ] **Step 5: Commit the Plan 04 behavioral cleanup**

Run:

```bash
git add packages/core/src/learner-loop-contract.ts packages/core/src/learner-loop-contract.test.ts
git commit -m "refactor(core): unify learner-loop terminal validation"
```

Expected: one Plan 04 commit with no `runtime-validation.ts` or `packages/core/package.json` change. Record the later Plan 14 pure-re-export/package-export SHA separately and rerun its Bun and direct-Node package-boundary import tests on the combined tree.

---

### Task LEARN-007: Make successful persisted recap dominate transport disconnection semantics

**Canonical IDs:** supporting contract/type work for `WEBSESSION-TERMINAL-01` (Plan 10 owns the canonical successful-recap-vs-disconnect fix) and the Plan 04 terminal-reason-declaration half of `DOMAIN-MULTIPLAN-TERMINAL-SCHEDULE-01`; this task is credited through those ledger rows, not as its own ledger row.

**Files:**
- Modify: `agent/crates/agent-domain/src/study.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Modify: `packages/core/src/learner-loop-contract.json`
- Modify: `packages/core/src/learner-loop-contract.ts`
- Modify: `packages/core/src/learner-loop-contract.test.ts`
- Modify: `packages/core/src/learner-recovery-copy.test.ts`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/brain.rs`
- Plan 06 handoff: Create/modify `agent/crates/agent-domain/src/session_state.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/lib.rs`

- [ ] **Step 1: Write RED success-state contract tests**

Add tests requiring a unique `session_completed` state with:

```json
{
  "id": "session_completed",
  "label": "Session completed",
  "stage": "recap",
  "resolution_kind": "success",
  "submitted_answer_resolution": true,
  "max_resolution_ms": 45000,
  "learner_safe": true,
  "authority": "durable_store_event",
  "sanitized_evidence": true,
  "runtime_copy_causes": ["recap_success"],
  "copy": {
    "capsule_label": "Session complete",
    "marginalia_title": "Session recap ready.",
    "marginalia_text": "Viva saved the evidence-backed recap and review plan.",
    "next_action_label": "Start a new session",
    "next_action_intent": "start_session",
    "primary_action_label": "Start a new session",
    "primary_action_intent": "start_session",
    "status_label": "session complete"
  },
  "operator_diagnostics": ["stage", "deploy_sha", "recap_success"]
}
```

Assert `session_completed` is not terminal, does not share a resolution key, and maps the new `recap_success` runtime cause.

Add Rust RED tests requiring `StudySessionPhase: Copy` and exactly one `TerminalSessionReason` declaration in Plan-04-owned `study.rs`. That declaration must expose `pub const ALL: [Self; 16]`, exhaustive `as_str`, exhaustive `close_reason`, serde snake-case parity, and `Display` equal to `as_str`. Plan-06-owned `brain.rs`/`session_state.rs` must import it and contain no second terminal-reason enum or string table.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core session_completion_ -- --nocapture
```

Expected: FAIL because the contract has no successful recap state/cause, `StudySessionPhase` is not `Copy`, and the one terminal-reason authority lacks `ALL`/`Display` parity.

- [ ] **Step 3: Add the exact success state and precedence contract**

Add `recap_success` to `VIVA_RUNTIME_COPY_CAUSES` and map it to the `session_completed` JSON state. In `study.rs`, derive `Copy` for `StudySessionPhase` and make the existing `TerminalSessionReason` the single declaration with `ALL`, `as_str`, `close_reason`, serde, and `Display` generated from that one exhaustive variant set. Plan 06 makes `brain.rs` and `session_state.rs` consume this authority, deletes any parallel declaration/mapping, and re-exports the Plan 04 type through `lib.rs`.

The Plan 10 consumer must pass `completion: { recapPersisted: true }` only after an authorized `recap_ready`. Its runtime projection checks completion before terminal reason, socket state, HTTP readiness, and `session_disconnected`; a later clean/unclean close cannot replace the successful copy. A controlled terminal with no persisted recap still uses its terminal recovery state.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun test packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core session_completion_ -- --nocapture
```

Expected: PASS on the recorded Plan 04 + Plan 06 combined tree. Add a temporary seventeenth terminal variant without updating parity and confirm the Rust test fails before restore.

- [ ] **Step 5: Commit**

Run:

```bash
git add agent/crates/agent-domain/src/study.rs
git commit -m "fix(learning): unify terminal reason declaration [04a]"
git add agent/crates/agent-domain/tests/learning_core.rs packages/core/src/learner-loop-contract.json packages/core/src/learner-loop-contract.ts packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.test.ts
git commit -m "fix(core): model successful session completion [04b]"
```

Expected: record these two Plan 04 SHAs (04a `study.rs` types, 04b tests/contract) and the separate Plan 06 `brain.rs`/`session_state.rs`/`lib.rs` SHA; the 04b commit is not GREEN without the combined-tree Step 4 proof.

---

### Task LEARN-008: Publish `AuthenticatedStudyProjectionV1` as the only session/library read model

**Canonical IDs:** server-owned study-set projection, fixture-overlay removal, and browser recap/schedule authority removal.

**Files:**
- Create: `packages/core/src/study-projection-contract.ts`
- Create: `packages/core/src/study-projection-contract.test.ts`
- Plan 14 handoff after consumer migration: Modify `packages/core/src/index.ts`
- Plan 14 handoff after consumer migration: Modify `packages/core/src/index.test.ts`
- Create: `agent/crates/agent-domain/src/study_projection.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/ports.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/src/lib.rs`
- Plan 06 handoff: Modify `agent/crates/agent-domain/tests/protocol_fixtures.rs`
- Create: `agent/fixtures/learning-core/study-projection-v1.json`

- [ ] **Step 1: Write RED TypeScript/Rust shared-fixture tests**

The exact TypeScript read model is:

```ts
export type AuthenticatedStudyProjectionV1 = {
  version: 1;
  studySet: {
    id: string;
    title: string;
    course: string | null;
    examLabel: string | null;
    ingestionStatus: StudySetIngestionStatus;
  };
  session: {
    id: string;
    mode: StudyMode;
    goal: string | null;
  };
  concepts: Array<{
    id: string;
    label: string;
    status: ConceptStatus;
    lastReviewedAt: string | null;
    dueAt: string | null;
  }>;
  activeQuestion: {
    id: string;
    conceptId: string;
    prompt: string;
    sourceCitations: Array<{
      sourceId: string;
      documentId: string;
      span: string;
      label: string;
      confidence: "high" | "medium" | "low";
    }>;
  } | null;
  questionProgress: {
    completed: number;
    total: number;
  };
  reviewSchedule: Array<{
    conceptId: string;
    dueAt: string;
    authority: "server_persisted_fsrs" | "core_fsrs_read_time";
  }>;
};

export function validateAuthenticatedStudyProjectionV1(
  value: unknown,
): AuthenticatedStudyProjectionV1;
```

The referenced closed aliases are exact: `StudySetIngestionStatus = "pending" | "processing" | "ready" | "failed" | "retry"`; `ConceptStatus = "strong" | "shaky" | "missed" | "review"`; under D-03A, `StudyMode = "quiz" | "teach" | "mock" | "cram"`; under D-03B, `StudyMode = "quiz"` and `goal` must be null. Plan 14 reconciles the existing root aliases after consumer migration; Plan 04's direct validator uses the selected closed allowlist and never accepts an unknown string merely because an upstream type was broader.

RED cases cover unknown/missing/extra fields; duplicate concepts; schedule/active-question references to unknown concepts; invalid dates; mixed scheduling authorities; completed greater than total; zero total with an active question; empty citations; route/session/study identity mismatch; non-ready set with an active question; and leaked expected terms/rubric/source excerpt/session token.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test packages/core/src/study-projection-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_study_projection -- --nocapture
```

Expected: FAIL because the contract/module/fixture do not exist.

- [ ] **Step 3: Implement strict reconstruction and Rust mirror**

Build the validator from `unknown`, require numeric literal `version: 1` and all other exact keys, normalize no learner facts, and return a deeply immutable object after Task LEARN-010. Add serde-equivalent Rust types in Plan-04-owned `study_projection.rs`. Plan 06 exports those types from `lib.rs`, imports them into `ports.rs`, and parses the identical fixture in `protocol_fixtures.rs`; it must not define a port-local projection mirror. After consumer migration, Plan 14 adds the `@viva/core` root export and owns its root-index tests; Plan 04 does not modify either root-index file.

Rules:

- projection identity comes from authenticated claims/store rows, never route overlay;
- `examLabel` is display copy only; D-01 uses the exact stored exam timestamp internally;
- `activeQuestion` intentionally excludes expected terms and rubric answers;
- every schedule and active question references an included concept;
- all review items use the one selected D-01 authority;
- concept `dueAt` equals its matching schedule item or is null when absent;
- a non-ready set has no active question and cannot start a session.

- [ ] **Step 4: Define downstream producer/proxy/consumer handoffs**

Plan 06 adds this exact method to the one `StudyMemoryStore` trait in `ports.rs`; any compatibility default is the fail-closed `Unavailable` rule from LEARN-002. Plan 09 implements concrete memory/Postgres overrides:

```rust
async fn authenticated_study_projection(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
) -> Result<AuthenticatedStudyProjectionV1, PortError>;
```

for both memory and Postgres with conformance/restart tests.

Plan 11 exposes an authenticated same-origin projection route, preserves claim-bound identity, validates the response with `validateAuthenticatedStudyProjectionV1`, and never forwards raw review history, rubric, source excerpt, or tokens.

Plan 10 blocks the session until this projection loads, renders skeleton/error for failure, removes the `seedStudySets[0]` route overlay, removes route-implied `ready`, removes browser recap bucket rewriting, removes browser schedule calculation, and makes both library/session format the same projection.

Plan 14 adds the `study-projection-contract.ts` root export and adjusts `packages/core/src/index.test.ts` only after Plans 09, 10, and 11 consume the direct contract successfully.

- [ ] **Step 5: Verify GREEN and leakage controls**

Run:

```bash
bun test packages/core/src/study-projection-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures shared_study_projection -- --nocapture
```

Expected: lane GREEN — PASS on a tree containing only prior-DAG-node commits (the recorded Plan 03 merge and the recorded Plan 06 SHA); any store behavior needed by these tests comes from a Plan-04-owned in-test fake implementing `authenticated_study_projection` with real hand-derived behavior (fail-closed for unimplemented paths, never fabricated `Ok` facts). Change fixture `version` from numeric `1` to a string and add `expectedTerms`; verify both validators reject each mutation independently before restore. Verifying Plan 09's concrete memory/Postgres overrides on the combined tree is post-merge consumer verification owned by LEARN-011 Steps 2–3 and LEARN-012, not a Plan 04 merge precondition.

- [ ] **Step 6: Commit the producer contract**

Run:

```bash
git add agent/crates/agent-domain/src/study_projection.rs agent/fixtures/learning-core/study-projection-v1.json
git commit -m "feat(learning): add study projection types [04a]"
git add packages/core/src/study-projection-contract.ts packages/core/src/study-projection-contract.test.ts
git commit -m "feat(core): publish authenticated study projection [04b]"
```

Expected: record these two Plan 04 SHAs (04a Rust types/fixture, 04b TypeScript contract) and the separate Plan 06 port/export/fixture SHA; the 04b commit is not GREEN without the Step 5 proof. Plan 14 remains the sole owner of root exports/tests.

---

### Task LEARN-009: Remove independent live mastery/schedule/recap tool writes

**Canonical IDs:** fabricated live mastery, fabricated live recap, and split learner authority.

**Files:**
- Modify: `agent/crates/agent-domain/src/tools.rs`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Modify: `agent/crates/agent-domain/tests/learning_core.rs`
- Modify: `agent/fixtures/learning-core/turn-outcomes-v1.json`

- [ ] **Step 1: Write RED tool-authorization tests**

Assert production tool proposals cannot independently call `mark_concept_status`, pass `due_at`, build a recap without persisted session evidence, select a fixture concept, or submit a recap payload. Assert the only allowed learner mutation sequence is evaluated/deferred `TurnOutcome` -> atomic transitions -> selected D-01 review evidence/decision -> recap projection.

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core tool_authority_ -- --nocapture`

Expected: FAIL while the seven-tool surface permits independent mastery/schedule/recap calls.

- [ ] **Step 3: Narrow the production tool surface**

Keep tool names only when their executor derives results from server state:

- `select_next_question` returns `QuestionProgressionResult`;
- `evaluate_spoken_answer` returns persisted `TurnOutcome`;
- `retrieve_source_reference` returns canonical source;
- `challenge_correction` returns a persisted challenge resolution;
- `build_session_recap` ignores model payload and folds stored evidence;
- scheduling is an internal post-outcome policy step, not a model-selected due date;
- independent `mark_concept_status` is removed from live tool declarations and accepted only in migration/fixture code if still required.

The adapter emits status/schedule/recap events from canonical returned records. It never issues a hardcoded `Strong` tool proposal.

- [ ] **Step 4: Verify GREEN and production/fixture separation**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core tool_authority_ -- --nocapture
rg -n 'mark_concept_status\(|"strong"|oxidative-phosphorylation|atp-synthase' agent/crates/agent-domain/src/tool_executor.rs
```

Expected: test PASS; no fixture IDs/default-strong production mutation remains.

- [ ] **Step 5: Commit**

Run:

```bash
git add agent/crates/agent-domain/src/tools.rs agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/learning_core.rs agent/fixtures/learning-core/turn-outcomes-v1.json
git commit -m "refactor(learning): enforce one learner mutation path"
```

---

### Task LEARN-010: Deep-freeze validated contracts and confine fixture helpers

**Disposition:** Nonbehavioral minor batch only.

**Files:**
- Modify: `packages/core/src/learner-loop-contract.ts`
- Modify: `packages/core/src/learner-loop-contract.test.ts`
- Modify: `packages/core/src/learner-recovery-copy.ts`
- Modify: `packages/core/src/learner-recovery-copy.test.ts`
- Modify: `packages/core/src/study-projection-contract.ts`
- Modify: `packages/core/src/study-projection-contract.test.ts`
- Modify: `packages/core/src/scheduling.ts`
- Modify: `packages/core/src/scheduling.test.ts`

- [ ] **Step 1: Write RED nested-mutation and fixture-import tests**

Attempt to mutate nested state copy, runtime causes, diagnostics, recovery actions, projection concepts/citations/schedule, and persisted FSRS state. Assert mutation throws in strict mode and subsequent reads remain byte-equivalent. Assert production exports contain no empty-card status-only estimate or fixture-calendar helper.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.test.ts packages/core/src/study-projection-contract.test.ts packages/core/src/scheduling.test.ts
```

Expected: FAIL because current `Object.freeze` is shallow and the validated learner-loop object is mutable.

- [ ] **Step 3: Implement one cycle-safe deep-freeze utility and honest exports**

Deep-freeze only reconstructed validated data, including nested arrays/objects. Freeze the learner-loop contract, recovery-copy contract, study projection, and schedule decisions. Remove `dueDateForStatus`/`reviewIntervalForStatus` if D-01A selected; under D-01B expose only Plan 03's authenticated `projectReviewHistoryAtReadTime`. Any scheduling fixture builder lives in a `.test.ts` helper, not the production module.

Do not batch `next_action_intent`, session-completed copy, or scheduling policy behavior here; those remain their own tested commits.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit the nonbehavioral minor batch**

Run:

```bash
git add packages/core/src/learner-loop-contract.ts packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.ts packages/core/src/learner-recovery-copy.test.ts packages/core/src/study-projection-contract.ts packages/core/src/study-projection-contract.test.ts packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts
git commit -m "chore(core): freeze validated learning contracts"
```

---

### Task LEARN-011: Complete downstream adapter, data, API, and web handoffs

**Files:** Consumer-owned files; LEARN workers do not edit them without an explicit file handoff.

This task and LEARN-012 are post-merge consumer verification, not Plan 04 merge preconditions: they run only after the consumer lanes (Plans 07/08/09/10/11/14) merge per the program DAG. The combined-tree requirements relocated here from LEARN-002 through LEARN-008 — Plan 09's production `StudyMemoryStore` overrides for all five methods rejecting `Unavailable`, Plans 08/11 D-03 claim minting/binding (or removal), and Plan 10 rendering — are verified here and in LEARN-012. The frozen combined checks remain Plan 15's.

| Consumer plan | Required files/interfaces | Acceptance proof returned to LEARN coordinator |
| --- | --- | --- |
| Plan 06 — domain integrity | `brain.rs`, `ports.rs`, `lib.rs`, `Cargo.toml`, `protocol_fixtures.rs`, optional `session_state.rs` | Imports Plan-04-owned `learning_outcome`, `learning_recap`, `learning_progression`, and `study_projection` types; adds the exact `BrainEvent::TurnDeferred` and named `StudyMemoryStore` methods; any additive partial/test-store default is fail-closed `Err(Unavailable)`, never a fabricated `Ok`; preserves the selected Plan 03 D-01 seam; parses shared fixtures without mirrors; consumes the single `study.rs` terminal-reason authority; combined-tree focused suites PASS |
| Plan 07 — adapters | `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`, live evaluator implementation, explicit `SyntheticFixtureAnswerEvaluator` | Live runner parses `ToolResult.result.turn_outcome`; Evaluated emits outcome/status, Deferred emits `BrainEvent::TurnDeferred`; selected D-03 policy controls feedback/hints; no default Strong, biology fallback, fixture recap, or adapter due date |
| Plan 08 — service runtime | `agent/crates/agent-service/src/ws.rs` and service tests | Consume Plan-05-owned `protocol.rs` constructors/voice fixtures; `turn_deferred`, V2 recap, progression, completion, and selected D-03 claim binding round-trip Rust/TS; second question events are not dropped; Plan 08 never edits `protocol.rs` |
| Plan 09 — data | memory/Postgres stores and migrations | Atomic outcome+transition+cursor persistence; extends only the selected Plan 03 v1 migration/store seam; creates no parallel scheduling table/schema/port; authenticated projection, replay, CAS, reconnect, restart, and memory/Postgres conformance |
| Plan 11 — web API | same-origin session/library routes and claim mint/refresh | Projection proxy is identity-bound and validated; D-01B replay is server-only if selected; D-03 claims are bound or removed |
| Plan 10 — web session/frontend | `LiveSessionPage.tsx`, `viva-display.ts`, `viva-session-projection.ts`, client reducer/types/tests | No seed overlay, route-ready inference, recap rewriting, browser schedule, or retry copy after persisted recap; exact projection identity and question progress render; the in-session verdict interval renders only the projection's `dueAt` for the same concept — no `reviewIntervalForStatus` call remains |
| Plan 14 — package/build contracts | `packages/core/src/index.ts`, `packages/core/src/index.test.ts`, `packages/core/src/runtime-validation.ts`, `packages/core/package.json`, package export-boundary tests | After consumer migration, add the projection root export/tests; publish a Node-loadable pure-ESM `@viva/core/runtime-validation` aggregator that re-exports Plan 04's exact learner-loop validator surface and Plan 05's `parseVivaServerFrame(value: unknown)` with explicit `.ts` specifiers and no behavioral wrapper; move demo `evaluateAnswer`, `buildSessionRecap`, `seedStudySets`, and `sampleQuestion` behind explicit fixture/test import or remove them; production root cannot import them accidentally |

- [ ] **Step 1: Give each consumer the exact contracts and selected decision branches**

Send the commit SHAs for Tasks LEARN-001 through LEARN-010, the recorded Plan 03 prerequisite, the Plan 06 integration, and the selected D-01/D-02/D-03 branches. Do not send prose-only names; link the compiled types and shared fixtures.

- [ ] **Step 2: Require consumer RED proof before accepting GREEN**

Each consumer reports the exact failing test demonstrating its old parallel authority, then the passing test on the integrated LEARN commit. A source grep alone is not sufficient.

- [ ] **Step 3: Run integrated focused suites after all handoffs land**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test learning_core -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters live_runner_emits_learning_events_only_from_persisted_turn_outcome -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters fake_and_synthetic_runtimes_consume_learning_core_fixture_outcomes -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data learning_ -- --nocapture
bun test packages/core/src/scheduling.test.ts packages/core/src/learner-loop-contract.test.ts packages/core/src/learner-recovery-copy.test.ts packages/core/src/study-projection-contract.test.ts apps/web/lib/viva-display.test.ts apps/web/lib/viva-session-projection.test.ts apps/web/lib/viva-library.test.ts
```

Also run the Plan 08 service learning suite using the exact test names obtained from Plan 08's handoff report; a filter that matches zero tests is a FAIL, so do not substitute a guessed `learning_core` filter.

Expected: all PASS on one integrated tree. Every filtered `cargo test` command above must report a nonzero executed-test count; a run reporting `running 0 tests` means that gate FAILED, not passed.

- [ ] **Step 4: Reject parallel facts mechanically**

Run:

```bash
rg -n 'seedStudySets\[0\]|recapPlanFromSessionEvents|normalized_answer\.contains|storage_due_at_for_status|dueDateForStatus|reviewIntervalForStatus|mark_concept_status\([^)]*"strong"' agent apps packages
```

Expected: no production matches. Explicit fixture/test matches must live under a named fixture/test module and be reviewed individually.

---

### Task LEARN-012: Run full learning-core acceptance, commit evidence, and hand off for integration

**Files:** All files touched by Tasks LEARN-001 through LEARN-010; no generated evidence artifacts are committed unless repository policy explicitly tracks them.

This task is post-merge consumer verification on the integrated tree after the LEARN-011 handoffs land; it is not a Plan 04 lane-merge precondition.

- [ ] **Step 1: Run full local verification**

Run:

```bash
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml --workspace --all-targets --all-features -- -D warnings
cargo test --manifest-path agent/Cargo.toml --workspace
bun test packages/core/src/*.test.ts
bun run validate
git diff --check origin/main...HEAD
git diff --check
```

Expected: all PASS.

- [ ] **Step 2: Run durable Postgres acceptance on an isolated database/schema**

Bring up Plan 09's disposable Postgres 16 instance, then run Plan 09's exact published learning-suite convention against it:

```bash
docker run --detach --rm \
  --name viva-data-postgres-learn \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_USER=viva \
  --env POSTGRES_PASSWORD=viva_test_only \
  --env POSTGRES_DB=viva_data_test \
  postgres:16-alpine
until docker exec viva-data-postgres-learn pg_isready --username viva --dbname viva_data_test; do sleep 1; done
cargo test --manifest-path agent/Cargo.toml -p data learning_ -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data record_turn_outcome -- --nocapture
DATA_POSTGRES_REQUIRED=1 DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
docker rm --force viva-data-postgres-learn
```

Expected: fresh migration, repeated startup, outcome replay, concurrent transition/CAS, progression reconnect, recap rebuild, selected scheduling branch, and authenticated projection all PASS, and the combined output lists each of Plan 09's ten named learning tests (`memory_record_turn_outcome_is_atomic_and_replay_safe`, `postgres_record_turn_outcome_is_atomic_and_replay_safe`, `postgres_record_turn_outcome_rolls_back_every_transition_on_failure`, `postgres_record_challenge_resolution_binds_existing_outcome_and_source`, `postgres_select_next_question_reconnect_and_replay_share_one_cursor`, `memory_learning_ports_override_fail_closed_defaults`, `postgres_learning_ports_override_fail_closed_defaults`, `postgres_memory_backend_session_learning_evidence_matches_fixture_bytes`, `postgres_memory_backend_progression_cursor_matches_selected_d02_contract`, `postgres_memory_backend_review_authority_matches_selected_d01_contract`) as executed — zero executed means this gate FAILED. A local in-memory pass does not substitute for this gate.

- [ ] **Step 3: Run browser-to-server truth acceptance**

Run Plan 12's `bun run e2e:browser` (the synthetic and fake-provider variants exactly as published by Plans 12/15) on the combined tree, and send Plan 12 an explicit harness handoff listing assertions 1–8 below as required visible checks; this step is `BLOCKED` until Plan 12 confirms the harness asserts them. The run must prove on the same authenticated study identity:

1. a question from `AuthenticatedStudyProjectionV1` starts;
2. an evaluated turn persists one `TurnOutcome`;
3. a deferred turn renders recovery without mastery;
4. a second question advances under selected D-02;
5. recap equals persisted outcomes;
6. review schedule uses selected D-01 authority and obeys exam policy;
7. completed recap copy dominates socket close/disconnection;
8. selected D-03 mode/goal is bound, or the removed UI is absent.

Expected: exact visible assertions pass; screenshot existence alone is insufficient.

- [ ] **Step 4: Run adversarial differential controls**

Temporarily and independently mutate one status boundary, one FSRS fixture output/sequence, one progression revision, one recap concept ID, one action intent, and one projection identity. Each owning test must fail. Restore after every mutation and rerun the focused suite.

- [ ] **Step 5: Report commits and proof to the coordinator**

Report the actual values without template markers:

```text
LEARN commits: exact commit SHAs from this execution
D-01 selected: the ledger-recorded branch
D-02 selected: the ledger-recorded branch
D-03 selected: the ledger-recorded branch
Rust focused/full proof: commands and exit statuses
TS focused/full proof: commands and exit statuses
Postgres proof: isolated database run identifier
Browser proof: artifact and run identifier
Adversarial controls: six observed failing mutation cases
Downstream consumer commits: exact Plan 06/07/08/09/10/11/14 SHAs
```

Only the coordinator updates LEARN rows in the coverage ledger. Do not mark complete from this plan file.

- [ ] **Step 6: Return any uncommitted fix to its owning atomic task**

Run: `git status --short`

Expected: clean for every LEARN-owned file. If integration exposed a scoped defect, reopen the owning task, repeat its RED/GREEN/mutation proof, and amend it with an explicit path list; do not create a miscellaneous catch-all commit and never use `git add .` in a mixed worktree.

---

## Self-Review

Coverage:

- Persisted scheduling and FSRS memory: Plan 03 D-01A v1 seam consumed/extended by LEARN-003A; immutable event/read-time projection alternative: Plan 03 D-01B v1 seam consumed/extended by LEARN-003B.
- Exam policy: the exact recorded Plan 03 D-01 future/close/past-exam rule is reused without a second policy definition.
- Versioned semantic evaluation, negation/contradiction/synonym/uncertainty: LEARN-002.
- Persisted evaluation/mastery/recap authority: LEARN-001 and LEARN-002.
- Removal of substring grading, expected-position recaps, and independent mastery writes: LEARN-001, LEARN-002, LEARN-009.
- Server-owned study/session projection: LEARN-008 and Plan 09/11/10 handoffs.
- Question progression: D-02A or D-02B, with retry/replay/reconnect/exhaustion.
- Learner-loop schema validation and recovery action integrity: LEARN-006.
- Stale `durability_degraded` union/validator duplication and the behavioral half of `@viva/core/runtime-validation`: LEARN-006A, with export-only Plan 14 handoff.
- Successful completion vs disconnection: LEARN-007 and Plan 10 handoff.
- Mode/goal decision: D-03A or D-03B; no worker choice.
- Fixture/production separation: LEARN-001, LEARN-002, LEARN-009, LEARN-010, adapter/Plan 14 handoffs.
- Shared cross-language fixtures: Plan 04 turn outcomes, recaps, progression, and authenticated projection plus the consumed Plan 03 scheduling conformance fixture.
- Critical predecessor: the fixed-date correction and selected D-01 v1 schema/port/migration/projection slice are explicitly excluded from reimplementation and verified as the `CRIT-SCHED-01` Plan 03 prerequisite.
- Minor batching: limited to nonbehavioral deep-freeze/fixture-boundary hardening in LEARN-010.

Authority invariant:

```text
authenticated study projection -> bound question/rubric/source
ephemeral answer -> AnswerEvaluator -> EvaluationDecision
EvaluationDecision + server bindings -> persisted TurnOutcome
TurnOutcome transaction -> concept transitions + question disposition
persisted session evidence -> StudySessionRecap
selected D-01 authority -> one review schedule
projection + recap -> browser formatting only
```

Completeness scan: no stub or permissive fallback is authorized by this plan.
