DELETE FROM review_items duplicate
USING review_items kept
WHERE duplicate.status = 'scheduled'
  AND kept.status = 'scheduled'
  AND duplicate.voice_session_id IS NOT NULL
  AND kept.voice_session_id IS NOT NULL
  AND duplicate.user_id = kept.user_id
  AND duplicate.study_set_id = kept.study_set_id
  AND duplicate.voice_session_id = kept.voice_session_id
  AND duplicate.concept_id = kept.concept_id
  AND duplicate.due_at = kept.due_at
  AND duplicate.id > kept.id;

CREATE UNIQUE INDEX IF NOT EXISTS review_items_voice_session_concept_due_scheduled_idx
    ON review_items (user_id, study_set_id, voice_session_id, concept_id, due_at)
    WHERE status = 'scheduled' AND voice_session_id IS NOT NULL;
