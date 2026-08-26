-- DATA-005: durable, deduplicated authorization digests for browser events.
--
-- Authorization for an evaluation, a concept-status change, or a session recap was
-- held in a process-local vector, so a restart or a second store instance forgot
-- which browser payload the server had actually authorized. The digest is the only
-- thing stored: no event JSON, no answer text, no learner-authored prose. It is
-- still learner-derived, so both D-05 branches delete it with the session and the
-- study set, and the cascades below make session/study-set deletion carry it away.

CREATE TABLE event_authorization_digests (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK (
        event_kind IN ('answer_evaluation', 'concept_status', 'study_session_recap')
    ),
    payload_sha256 CHAR(64) NOT NULL CHECK (
        payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (
        user_id,
        study_set_id,
        voice_session_id,
        response_id,
        event_kind,
        payload_sha256
    )
);

CREATE INDEX event_authorization_digests_session_lookup_idx
    ON event_authorization_digests (
        voice_session_id,
        response_id,
        event_kind,
        payload_sha256
    );
