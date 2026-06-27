DELETE FROM session_recaps duplicate
USING session_recaps kept
WHERE duplicate.user_id = kept.user_id
  AND duplicate.study_set_id = kept.study_set_id
  AND duplicate.voice_session_id = kept.voice_session_id
  AND (
      duplicate.created_at < kept.created_at
      OR (duplicate.created_at = kept.created_at AND duplicate.id > kept.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS session_recaps_voice_session_unique_idx
    ON session_recaps (user_id, study_set_id, voice_session_id);
