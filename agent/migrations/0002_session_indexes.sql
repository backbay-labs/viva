CREATE INDEX IF NOT EXISTS study_sets_user_updated_idx
    ON study_sets (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS study_documents_set_created_idx
    ON study_documents (study_set_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS source_spans_document_idx
    ON source_spans (document_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS voice_sessions_user_started_idx
    ON voice_sessions (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS answer_attempts_voice_session_idx
    ON answer_attempts (voice_session_id, created_at);

CREATE INDEX IF NOT EXISTS review_items_due_idx
    ON review_items (user_id, status, due_at);
