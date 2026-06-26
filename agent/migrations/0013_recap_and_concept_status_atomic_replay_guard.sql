DELETE FROM session_recaps duplicate
USING session_recaps kept
WHERE duplicate.user_id = kept.user_id
  AND duplicate.study_set_id = kept.study_set_id
  AND duplicate.voice_session_id = kept.voice_session_id
  AND duplicate.strong_concepts = kept.strong_concepts
  AND duplicate.shaky_concepts = kept.shaky_concepts
  AND duplicate.missed_concepts = kept.missed_concepts
  AND duplicate.review_later = kept.review_later
  AND duplicate.source_span_ids = kept.source_span_ids
  AND duplicate.id > kept.id;

CREATE UNIQUE INDEX IF NOT EXISTS session_recaps_voice_session_payload_idx
    ON session_recaps (user_id, study_set_id, voice_session_id, strong_concepts, shaky_concepts, missed_concepts, review_later, source_span_ids);

CREATE TABLE IF NOT EXISTS concept_status_events (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL,
    concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    payload_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, study_set_id, voice_session_id, response_id, concept_id, payload_sha256)
);

CREATE INDEX IF NOT EXISTS concept_status_events_voice_session_idx
    ON concept_status_events (voice_session_id, created_at DESC);
