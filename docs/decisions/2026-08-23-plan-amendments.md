# Coordinator-Ratified Plan Amendments

Recorded by the integration coordinator. Each amendment supersedes the quoted plan text for every consuming lane; lanes pick these up on rebase and via coordinator handoff notes. Workers never author amendments — they escalate, the coordinator ratifies.

## A-01 (2026-08-24) — Plan 03 Task 8A Step 3: `persist_review_schedule_decision` port signature

**Amended (ratified) signature** — replaces the five-parameter form locked in Plan 03 Task 8A Step 3:

```rust
async fn persist_review_schedule_decision(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    response_id: &str,
    concept_id: &str,
    decision: ReviewScheduleDecisionV1,
) -> Result<Value, PortError>;
```

**Rationale:** the locked five-parameter signature carried no idempotency key, while Plan 03 Task 8A Step 2 requires "replay of the same authorized response returns the exact stored decision" and Plan 04 LEARN-003A fixes "the authorized response identity is the existing idempotency source". `response_id` (inserted before `concept_id`) is the response-keyed idempotency identity. `ReviewScheduleDecisionV1` itself is unchanged. Escalated by the Plan 03 worker (amendment request preserved in lane evidence), independently verified by the branch reviewer on real PostgreSQL 16, ratified under Connor's 2026-08-24 execution directive.

**Downstream effect:** Plans 04 (LEARN-003A consumption), 06 (`ports.rs` preservation/export), and 09 (memory/Postgres overrides and conformance tests) consume, preserve, and implement the six-parameter form. Any plan text quoting the five-parameter form reads as amended.

## A-02 (2026-08-24) — Plan 03 Task 8A: migration `0015_review_schedule_decisions_v1.sql` additionally adds `study_sets.exam_at`

**Amended content:** `0015` also runs `ALTER TABLE study_sets ADD COLUMN IF NOT EXISTS exam_at TIMESTAMPTZ` (nullable, additive, no destructive down-migration).

**Rationale:** D-01's recorded UTC rule ("exact UTC instants, no calendar-day rounding") cannot be represented by the legacy `0001` `DATE` exam column, and Plan 03 may create only migration `0015` (Plan 09 is sole allocator afterward), so the column rides in `0015`.

**Downstream obligations:**
- Every writer of `study_sets` rows must populate `exam_at` (from the ingestion `exam_date` input interpreted per the D-01 UTC rule) or the D-01 exam cap has no input for that row — binds Plan 08 (ingestion handlers) and Plan 09 (stores/seed/backfill semantics).
- Plan 09 must not re-add or duplicate this column in `0016`–`0018` and treats it as part of the selected D-01 v1 seam.

## Coordinator notes attached to the same review pass (not amendments)

1. **Extended parallel-flake list** (baseline, full-workspace parallel load only; pass in isolation): in addition to `websocket_turn_cap_ignores_suppressed_stale_resolution_after_new_submission`, also `websocket_turn_cap_ignores_response_less_phase_after_new_submission` and `websocket_turn_cap_is_not_postponed_by_client_keepalives`. The 4 deterministic LANE_BASE reds are unchanged. Plan 08 owns the underlying timing sensitivity.
2. **Advisory-lock pool note:** `pg_advisory_xact_lock` in the schedule-decision write holds a pooled connection for the transaction duration; racers can occupy pool slots (pool=5). No deadlock. A bounded lock-wait timeout is a Plan 04/09 follow-up consideration when they take over scheduling behavior — recorded in the Plan 04 handoff.

## A-03 (2026-08-24) — Node 12A additionally carries the script protocol-constant bump

Plan 03's locked v5 bump necessarily breaks two baseline script tests that assert the Plan-12-owned scripts share the voice protocol version: `scripts/e2e-browser.mjs:65` (`VIVA_VOICE_PROTOCOL_VERSION = 4`) and `scripts/live-provider-smoke.mjs:13` (`PROTOCOL_VERSION = 4`). **Ratified:** integration node 12A additionally includes one commit changing exactly those two literals to `5`. The bump is only green on a post-Plan-03 tree, so it is authored on the 12A admission branch after the Plan 03 merge and admitted immediately after it (Plan 03 merge → 12A, no intervening lane merge; the 13A-lockfile constraint then applies to a later 12A-suffix commit as already recorded). The content is fully determined by this amendment; the coordinator applies it mechanically citing A-03, with Plan 12 retaining ownership (its Task 13/RELEASE-028 later replaces the literals with strict validator consumption). Latent-defect note from the Plan 03 escalation stands: `e2e-browser.mjs`'s failure-control replay-nonce path would have sent a v4 frame at a v5 server if the harness were enabled; the default release run never reaches it. Plan 12's Task 13 closes it structurally.

## W-01 (2026-08-24) — Merge-gate waiver: recorded baseline voice_ws failures do not block the Plan 03 merge

Plan 03 Task 9 Step 5 requires `bun run validate` green on the PR head. **Waived, exactly and only, for the seven coordinator-recorded baseline `voice_ws` names** (4 deterministic: audio_continuation_second_lease, provider_drains_queued_usage, queue_cancel_drops_pending_admission, queue_cancel_rearms_pre_answer_idle; 3 load-flaky: turn_cap_suppressed_stale_resolution, turn_cap_response_less_phase, turn_cap_not_postponed_by_keepalives). Basis: these are pre-existing at the audit baseline (hosted Validate red on `4d5d8276`), Plan 03's T9 evidence proves every failing Rust test observed is a strict subset of these names with zero new reds, and the failing area is Plan 08's permanent ownership (provider-queue/lease/turn-cap). Disposition owner: Plan 08's lane, whose SERVICE-001/002/006/008 work rewrites these paths; Plan 15's Level 2 gate still requires a fully green workspace on the frozen combined SHA, so this waiver expires there and cannot leak into release evidence. Any failure outside these seven names blocks the merge.

## A-04 (2026-08-24) — Node 12A admitted via sub-branch `review-remediation/12a`

Node 12A's lane branch (`review-remediation/12-release-ci`) had already advanced past the 12A boundary with baseline-safe Task 1–4 commits, so the 12A PR (#100) was cut from sub-branch `review-remediation/12a` carrying exactly the two 12A manifest/lock commits plus the A-03 constant bump, rebased onto the post-Plan-03 integration tip. Plan 15's expected-branch verification for node 12A reads as amended to accept `review-remediation/12a` (same lane worktree source; the program's split-node rule "commits/PRs from the same lane worktree, not extra owners or permanent branches" is preserved — the sub-branch is retired after Plan 15's capture). Lane 12 rebases over the duplicate commits at its 12B rebase.

## A-05 (2026-08-24) — Lanes commit deterministic lockfile deltas of plan-sanctioned dependency edits

Ratified at the node 06 merge (first recorded in the coordinator execution log; transcribed here for the authoritative record). When a plan sanctions a manifest/dependency edit (e.g. Plan 06's trybuild/proptest dev-dependencies), the lane commits the deterministic `Cargo.lock`/`bun.lock` delta **in the same commit** as the manifest edit, even where the plan's quoted `git add` list omits the lockfile. Plan 12 retains lockfile audit authority and reconciles all lock history at its 12B rebase. Basis: an integration tip whose manifests and lock disagree fails every `--frozen-lockfile`/`--locked` gate and poisons downstream lanes; the omission in plan text was mechanical, not a design choice. First application: node 06's `agent/Cargo.lock` (+221 lines), committed by the coordinator before merge.

## W-02 (2026-08-24) — Pre-authorized merge-gate waiver: labeled `quiz_only_` reds at the node 04B merge

Node 04B commits RED tests labeled `quiz_only_` whose GREEN is produced by Plan 06's Task 1A (D-03B `brain.rs` quiz-affordance removal), which merges immediately after 04B in lane 06's second PR. **Pre-authorized:** the 04B merge gate accepts exactly the labeled `quiz_only_` failures and nothing else; the waiver expires the moment 06 Task 1A merges, and Plan 15's Level 2 full-green gate is unaffected. Any red outside the labeled set blocks the 04B merge normally.

## A-06 (2026-08-25) — Plan 12 Step 4A3's lockfile-regeneration commit rides inside the node 13A admission

Plan 12 constraint 9(c)/Step 4A3 requires the Bun 1.3.3 `bun.lock` regeneration for Plan 13's Task 1/2 manifest commits to merge "immediately before 13A with no intervening lane merge". A lock regenerated on lane 12's tree cannot see Plan 13's manifests, so the constraint is unsatisfiable as literally written. **Ratified:** the regeneration commit is authored by the coordinator on the 13A admission branch (`review-remediation/13a`), directly on top of lane 13's head, with Bun 1.3.3 via `mise x bun@1.3.3`, and merges inside the 13A PR (#103, commit `6bffdf0`). The material invariant is preserved strictly: no integration tip ever carries the manifests without the matching lock, and `bun install --frozen-lockfile` is green on the admitted head. Plan 12 retains `bun.lock` ownership; lane 12 rebases over it at 12B. Observed delta: workspace-metadata only (ui-web `react` → peer/dev, `@viva/tokens` workspace dep).

## A-07 (2026-08-25) — Mechanical completion of a Plan-10-owned test fixture broken by Plan 03's type change

Plan 03's `ReviewScheduleItem` gained `authoritativeDueAt`/`capReason`/`card`; the pre-existing fixture in `apps/web/components/session/LiveSessionShell.test.tsx` (Plan-10-owned, outside Plan 03's temporary ownership — which is exactly why no lane updated it) left the integration tip's `apps/web` typecheck red with one error after the Plan 03 merge. **Ratified:** one coordinator-applied mechanical commit (`d1331c9`, inside the 13A admission) adds the three missing fields to the fixture literal with type-correct values consistent with its existing dates; no production code or assertion changes. Plan 10 retains ownership of the file and may freely rewrite the fixture at node 10. Basis: same category as A-03 (deterministic cross-lane fallout whose content is fully determined by the merged type).

## A-08 (2026-08-25) — Mechanical alignment of Plan-10-owned web surfaces broken by D-01A

LEARN-003A's locked step deleted `dueDateForStatus`/`reviewIntervalForStatus` from `packages/core` (client-side FSRS fabrication — the D-01 defect itself), leaving two Plan-10-owned surfaces stale: the dangling `conceptStatusVerdict` call site in `apps/web/lib/viva-session-projection.ts`, and a `viva-display.test.ts` assertion demanding the fabricated "session recency cap" claim that truthful cap explanations now correctly suppress. **Ratified:** two coordinator-applied commits inside the 04B admission (PR #104): the verdict renders the honest status label only, and the assertion now asserts the binding-cap-only semantics (including a negative assertion on the fabricated claim). A behavior-preserving shim was rejected because it would resurrect the outlawed client-side fabrication. Plan 10 owns both files wholesale at node 10 and builds the authoritative in-session review verdict there. Basis: A-03/A-07 category — deterministic cross-lane fallout; content determined by the recorded decision (D-01A truthfulness), not coordinator invention.

## W-04 (2026-08-25) — Known-red window: one TS5097 in `apps/web` typecheck between nodes 04B and 14A

Plan 04's locked TS steps mandate pure-ESM `.ts`-suffix imports in the new `packages/core` modules; the enabling `"allowImportingTsExtensions": true` in `tsconfig.base.json` is Plan 14's Task 2 Step 1–2 obligation (Phase 14A). **Recorded:** from the 04B merge until the 14A merge, `apps/web` typecheck carries exactly one error — TS5097 on `packages/core/src/learner-loop-contract.ts` — and merge gates treat exactly that error as the recorded known-red. Any other typecheck error blocks normally. Node 14A merges immediately after 04B, so the window is one node wide.


## A-09 (2026-08-25) — Plan 14 Task 3 Step 5 / Task 7 Step 4: bundle-isolation verification excludes source maps

The literal verification line `! rg -F "Try again using the phrase 'shuttle system'." apps/web/.next` reproducibly fails on every real `next build`: Turbopack embeds `packages/core/src/index.ts`'s full original text into server-only `*.js.map` `sourcesContent` whenever a server chunk imports anything from the file, and both the Phase-14A surface (index.ts keeps its full export surface, by plan design) and the plan's own Phase-14B target structure (`study-set.ts` keeps `createStudySetPreview` and `evaluateAnswer` co-located) put the needle in that original text permanently. The string appears in no static asset, no executable server JS, and no `sources[]`/`mappings` entry — only in debug-metadata `sourcesContent` (lane evidence task-3-step5-line4-verification.txt). **Ratified:** both occurrences of the literal line (Task 3 Step 5 fourth expectation, Task 7 Step 4) read as amended to `! rg -F "Try again using the phrase 'shuttle system'." apps/web/.next --glob '!*.map'`. The PACKAGE-02 completion criterion is unchanged and remains enforced by the committed isolation test's negative-control bundle proof (mutation-verified to detect an injected leak). No `next.config.ts` change is authorized by this amendment.

## A-10 (2026-08-25) — Plan 06 second PR: authorized Plan-04-file edits at the StudySessionRecap root swap, and related file-list exceedances

Plan 06's ownership boundary ("never modify study/tools/tool_executor.rs") is crossed by exactly two edits at the Task 0 Step 3 crate-root recap swap, both **ratified**: (1) the `record_recap` call site in `tool_executor.rs` persists the v2 recap directly — compile-forced (E0599 otherwise); (2) `study.rs` loses `StudySessionRecap::from_evidence_recap` — NOT compile-forced (verified by the branch reviewer: restoring it compiles clean under `-D warnings`), but it is the cleanup Plan 04's own recorded design built to happen at this swap (its doc comment named the swap the intended forcing function and the function a recorded LEARN-011-window cleanup), and no caller outside its doc and test remained. The in-tree shim doc originally overstated both edits as forced; corrected in the same admission. Also ratified under this amendment: Task 1A Step 2B's staging list reads as amended to include `tests/store_contract.rs` (compile-forced: its fixture named the removed `initial_goal`), and the unplanned public export `pub use study::StudySessionRecap as StudySessionRecapV1` is accepted as a labeled MIGRATION SHIM with a gate-enforced removal trigger — Plans 07/08/09 must retire it, and the retirement is added to their dispatch obligations.

## A-11 (2026-08-25) — Merged PROVENANCE.md rewording out of legacy-residue vocabulary

`apps/web/app/fonts/PROVENANCE.md:33` ("nothing in this recipe is committed…") trips `scripts/check-legacy-domain-residue.sh`'s correct `recipe` pattern, keeping `agent:residue` red on the tip since the 13A merge. **Ratified:** one coordinator commit rewords the line to "preparation procedure" (meaning preserved); the gate is not weakened. Plan 13 retains file ownership.

## Coordinator sequencing notes attached to the Plan 06 second PR (not amendments)

1. **Task 7 policy-test commit re-sequenced**: `scripts/rust-domain-quality-policy.test.mjs` asserts Plan 12B's `agent:deps:unused`/`agent:domain:mutants` commands and is red until they exist; Plan 06 Task 7 Step 5 itself gates that commit to "the same integration wave as 12b (or later)". The coordinator's earlier dispatch pulled it forward in error; the commit stays on lane 06's branch and merges at the 12B wave. The node-06-second-PR admission excludes it.
2. **Task 8 pattern defect (pre-recorded for its future dispatch)**: Task 8 Step 1's CONFIRM_DELETE absence grep includes `chrono\.workspace`, which now legitimately matches agent-domain's Cargo.toml because Plan 03's D-01 seam declares chrono. When Task 8 dispatches, the pattern reads as amended to drop `chrono\.workspace` (keeping `uuid\.workspace`).
