ALTER TABLE answer_attempts
    ADD COLUMN IF NOT EXISTS misconception_fingerprint JSONB;

CREATE INDEX IF NOT EXISTS answer_attempts_misconception_fingerprint_idx
    ON answer_attempts ((misconception_fingerprint ->> 'digest'))
    WHERE misconception_fingerprint IS NOT NULL;
