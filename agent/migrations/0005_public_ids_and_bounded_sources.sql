ALTER TABLE concepts
    ADD COLUMN IF NOT EXISTS public_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS concepts_study_set_public_id_idx
    ON concepts (study_set_id, public_id)
    WHERE public_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS study_questions (
    id UUID PRIMARY KEY,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    source_span_id UUID REFERENCES source_spans(id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (study_set_id, question_id)
);

CREATE INDEX IF NOT EXISTS study_questions_active_idx
    ON study_questions (study_set_id, question_id)
    WHERE active;

ALTER TABLE source_spans
    ADD CONSTRAINT source_spans_excerpt_bounded
    CHECK (char_length(excerpt) <= 1000);
