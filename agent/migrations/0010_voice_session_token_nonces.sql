CREATE TABLE IF NOT EXISTS voice_session_token_nonces (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL,
    nonce TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, study_set_id, voice_session_id, nonce)
);

CREATE INDEX IF NOT EXISTS voice_session_token_nonces_expiry_idx
    ON voice_session_token_nonces (expires_at);
