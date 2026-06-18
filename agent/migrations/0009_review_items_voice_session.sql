ALTER TABLE review_items
    ADD COLUMN IF NOT EXISTS voice_session_id UUID REFERENCES voice_sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS review_items_voice_session_due_idx
    ON review_items (user_id, study_set_id, voice_session_id, status, due_at);
