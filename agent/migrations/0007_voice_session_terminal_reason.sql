ALTER TABLE voice_sessions
    ADD COLUMN IF NOT EXISTS terminal_reason TEXT;
