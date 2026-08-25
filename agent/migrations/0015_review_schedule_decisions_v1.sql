-- D-01 SERVER_PERSISTED_FSRS: persist the authoritative review schedule alongside
-- the review item, so a due date can never exist without the versioned decision
-- that produced it. Additive only; there is no destructive down-migration.

-- The exam instant is the other authoritative input to a D-01 decision, and it is
-- the one input the learner supplies. `study_sets.exam_date` (migration 0001) is a
-- calendar DATE, and D-01 states the UTC rule as "an exact UTC instant ... there is
-- no calendar-day rounding"; a DATE cannot hold that value, and nothing in the
-- repository ever wrote to it. `exam_at` is the authoritative column from here on.
-- `exam_date` is kept, still written as the calendar-day projection of `exam_at`,
-- and is never read back as a scheduling input. Plan 09 owns any later removal.
ALTER TABLE study_sets
    ADD COLUMN IF NOT EXISTS exam_at TIMESTAMPTZ;

ALTER TABLE review_items
    ADD COLUMN IF NOT EXISTS schedule_schema_version SMALLINT,
    ADD COLUMN IF NOT EXISTS schedule_policy_id TEXT,
    ADD COLUMN IF NOT EXISTS schedule_decision JSONB,
    ADD COLUMN IF NOT EXISTS schedule_card JSONB,
    ADD COLUMN IF NOT EXISTS schedule_generated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS schedule_cap_reason TEXT,
    ADD COLUMN IF NOT EXISTS schedule_response_id TEXT,
    ADD COLUMN IF NOT EXISTS schedule_payload_sha256 TEXT;

-- A row is either a complete v1 decision or carries no v1 fields at all.
ALTER TABLE review_items
    DROP CONSTRAINT IF EXISTS review_items_schedule_v1_complete;
ALTER TABLE review_items
    ADD CONSTRAINT review_items_schedule_v1_complete CHECK (
        (
            schedule_schema_version IS NULL
            AND schedule_policy_id IS NULL
            AND schedule_decision IS NULL
            AND schedule_card IS NULL
            AND schedule_generated_at IS NULL
        )
        OR (
            schedule_schema_version = 1
            AND schedule_policy_id IS NOT NULL
            AND schedule_decision IS NOT NULL
            AND schedule_card IS NOT NULL
            AND schedule_generated_at IS NOT NULL
        )
    );

ALTER TABLE review_items
    DROP CONSTRAINT IF EXISTS review_items_schedule_cap_reason_valid;
ALTER TABLE review_items
    ADD CONSTRAINT review_items_schedule_cap_reason_valid CHECK (
        schedule_cap_reason IS NULL
        OR schedule_cap_reason IN ('exam_margin', 'past_exam')
    );

-- The four known buggy fixed-date rows are marked superseded. No replacement date
-- is invented: the authoritative schedule is only ever recomputed from a real
-- graded outcome.
UPDATE review_items
SET status = 'superseded'
WHERE status = 'scheduled'
  AND schedule_decision IS NULL
  AND due_at IN (
      TIMESTAMPTZ '2026-06-18T09:00:00Z',
      TIMESTAMPTZ '2026-06-19T09:00:00Z',
      TIMESTAMPTZ '2026-06-20T09:00:00Z',
      TIMESTAMPTZ '2026-06-24T09:00:00Z'
  );

CREATE INDEX IF NOT EXISTS review_items_schedule_decision_v1_idx
    ON review_items (user_id, study_set_id, concept_id, schedule_generated_at DESC)
    WHERE schedule_schema_version = 1 AND status = 'scheduled';

CREATE INDEX IF NOT EXISTS review_items_schedule_session_v1_idx
    ON review_items (user_id, study_set_id, voice_session_id, due_at)
    WHERE schedule_schema_version = 1 AND status = 'scheduled';

-- Replay guard. `review_items_voice_session_concept_due_scheduled_idx` (migration
-- 0012) keys on due_at, which is recomputed from the wall clock on every call, so a
-- replayed tool call slips past it and writes a second scheduled review — and the
-- replay has already read the first decision's card back, so the persisted FSRS card
-- silently advances. The replay identity is the graded outcome instead: the model
-- response plus a digest of the status/rating/hint/miss inputs that produced it.
CREATE UNIQUE INDEX IF NOT EXISTS review_items_schedule_response_replay_idx
    ON review_items (
        user_id, study_set_id, voice_session_id, concept_id,
        schedule_response_id, schedule_payload_sha256
    )
    WHERE schedule_schema_version = 1
      AND status = 'scheduled'
      AND schedule_response_id IS NOT NULL
      AND schedule_payload_sha256 IS NOT NULL;
