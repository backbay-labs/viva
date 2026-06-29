ALTER TABLE answer_attempts
    ADD COLUMN IF NOT EXISTS misconception_fingerprint JSONB,
    ADD COLUMN IF NOT EXISTS retry_prompt_delivered BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE answer_attempts
SET retry_eligible = TRUE,
    retry_prompt_delivered = TRUE
WHERE evaluation_label IN (
    'partially correct',
    'vague',
    'wrong',
    'off-topic',
    'insufficient evidence'
)
  AND retry_eligible IS NULL;

UPDATE answer_attempts
SET retry_eligible = FALSE
WHERE evaluation_label IS NOT NULL
  AND retry_eligible IS NULL;

CREATE INDEX IF NOT EXISTS answer_attempts_misconception_fingerprint_idx
    ON answer_attempts ((misconception_fingerprint ->> 'digest'))
    WHERE misconception_fingerprint IS NOT NULL;
