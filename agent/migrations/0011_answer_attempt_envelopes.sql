ALTER TABLE answer_attempts
    ADD COLUMN IF NOT EXISTS response_id TEXT,
    ADD COLUMN IF NOT EXISTS submission_sequence INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS capture_mode TEXT NOT NULL DEFAULT 'typed',
    ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS byte_count BIGINT,
    ADD COLUMN IF NOT EXISTS char_count BIGINT,
    ADD COLUMN IF NOT EXISTS duration_ms BIGINT,
    ADD COLUMN IF NOT EXISTS client_generation_id TEXT,
    ADD COLUMN IF NOT EXISTS locale TEXT,
    ADD COLUMN IF NOT EXISTS capture_status TEXT NOT NULL DEFAULT 'accepted',
    ADD COLUMN IF NOT EXISTS answer_content_policy TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS answer_digest_hmac TEXT,
    ADD COLUMN IF NOT EXISTS transcript_status TEXT,
    ADD COLUMN IF NOT EXISTS transcript_confidence_bucket TEXT,
    ADD COLUMN IF NOT EXISTS pre_provider_state TEXT NOT NULL DEFAULT 'evaluation_only_compat',
    ADD COLUMN IF NOT EXISTS provider_attempt_id TEXT,
    ADD COLUMN IF NOT EXISTS terminal_reason TEXT,
    ADD COLUMN IF NOT EXISTS failure_class TEXT,
    ADD COLUMN IF NOT EXISTS stage TEXT,
    ADD COLUMN IF NOT EXISTS retry_eligible BOOLEAN;

UPDATE answer_attempts
SET response_id = COALESCE(response_id, id::text);

UPDATE answer_attempts
SET idempotency_key = COALESCE(
    idempotency_key,
    voice_session_id::text || ':' || question_id || ':' || submission_sequence::text || ':' || response_id
);

ALTER TABLE answer_attempts
    ALTER COLUMN response_id SET NOT NULL,
    ALTER COLUMN idempotency_key SET NOT NULL,
    ALTER COLUMN evaluation_label DROP NOT NULL,
    ALTER COLUMN concept_status DROP NOT NULL,
    ALTER COLUMN confidence_score DROP NOT NULL;

ALTER TABLE answer_attempts
    ADD CONSTRAINT answer_attempts_digest_policy_check
    CHECK (answer_digest_hmac IS NULL OR answer_content_policy = 'digest_only');

CREATE UNIQUE INDEX IF NOT EXISTS answer_attempts_voice_session_response_id_idx
    ON answer_attempts (voice_session_id, response_id);

CREATE UNIQUE INDEX IF NOT EXISTS answer_attempts_voice_session_idempotency_idx
    ON answer_attempts (voice_session_id, idempotency_key);
