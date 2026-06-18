CREATE TABLE voice_usage_events (
    id UUID PRIMARY KEY,
    voice_session_id UUID REFERENCES voice_sessions(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    duration_seconds BIGINT NOT NULL,
    text_input_tokens BIGINT NOT NULL DEFAULT 0,
    text_output_tokens BIGINT NOT NULL DEFAULT 0,
    audio_input_tokens BIGINT NOT NULL DEFAULT 0,
    audio_output_tokens BIGINT NOT NULL DEFAULT 0,
    cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    first_audio_latency_ms BIGINT,
    answer_eval_latency_ms BIGINT,
    source_retrieval_latency_ms BIGINT,
    source_grounded_correction_count BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS voice_usage_events_session_idx
    ON voice_usage_events (voice_session_id, created_at DESC);
