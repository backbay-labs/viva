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
