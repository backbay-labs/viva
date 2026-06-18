ALTER TABLE source_spans
    ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'medium',
    ADD COLUMN IF NOT EXISTS retrieval_reason TEXT NOT NULL DEFAULT 'postgres source span';

CREATE TABLE session_recaps (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    strong_concepts TEXT[] NOT NULL DEFAULT '{}',
    shaky_concepts TEXT[] NOT NULL DEFAULT '{}',
    missed_concepts TEXT[] NOT NULL DEFAULT '{}',
    review_later TEXT[] NOT NULL DEFAULT '{}',
    source_span_ids UUID[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_recaps_voice_session_idx
    ON session_recaps (voice_session_id, created_at DESC);
