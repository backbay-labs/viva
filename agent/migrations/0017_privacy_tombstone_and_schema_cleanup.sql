-- DATA-004/DATA-009/DATA-013: the deletion tombstone, the superseded recap index,
-- and the columns nothing writes.
--
-- `deleted_at` is the deletion authority. `ingestion_status` is not overloaded for
-- it: a status value would conflate "this ingestion failed" with "this learner
-- deleted their material", and only one of those may hide a study set from every
-- read. Active reads require `study_sets.deleted_at IS NULL`; the timestamp is what
-- deletion, seed refusal, and repeated idempotent deletes all key on.
--
-- This migration is decision-independent: it contains no `study_set_deletions`
-- table, no pending/expiry partial index, and no `study_sets.deletion_id`. That
-- undo schema has a writer only under D-04 = SOFT_DELETE_UNDO, and the recorded
-- selection is CONFIRM_DELETE, so under the DATA-SCHEMA-UNWRITTEN rule it is not
-- created here.

ALTER TABLE study_sets
    ADD COLUMN deleted_at TIMESTAMPTZ;

-- Superseded by `session_recaps_voice_session_unique_idx` in 0014. Leaving it in
-- place kept a btree row-size limit on recap content: a recap with enough concept
-- labels was refused by the database with an index error, which is not a learner
-- error and not a policy anyone chose.
DROP INDEX IF EXISTS session_recaps_voice_session_payload_idx;

-- DATA-SCHEMA-UNWRITTEN. Each column was added by an earlier migration and is bound
-- by no production INSERT or UPDATE; the facts they were meant to hold are carried
-- through sanitized evidence or session state instead. A column may come back only
-- with an already-merged typed writer and a durable test for that exact field.
ALTER TABLE answer_attempts
    DROP COLUMN IF EXISTS provider_attempt_id,
    DROP COLUMN IF EXISTS terminal_reason,
    DROP COLUMN IF EXISTS failure_class,
    DROP COLUMN IF EXISTS stage,
    DROP COLUMN IF EXISTS retry_eligible,
    DROP COLUMN IF EXISTS concept_id;
