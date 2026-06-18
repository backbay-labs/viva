ALTER TABLE study_sets
    ADD COLUMN IF NOT EXISTS ingestion_status TEXT NOT NULL DEFAULT 'ready',
    ADD COLUMN IF NOT EXISTS ingestion_error TEXT;

ALTER TABLE study_documents
    ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'ready';

ALTER TABLE study_questions
    ADD COLUMN IF NOT EXISTS prompt TEXT,
    ADD COLUMN IF NOT EXISTS expected_terms TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS follow_up TEXT;

ALTER TABLE study_questions
    ADD CONSTRAINT study_questions_prompt_bounded
    CHECK (prompt IS NULL OR char_length(prompt) <= 500);

ALTER TABLE study_questions
    ADD CONSTRAINT study_questions_follow_up_bounded
    CHECK (follow_up IS NULL OR char_length(follow_up) <= 300);
