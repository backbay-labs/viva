-- Plan 04's canonical learning persistence, stored as the typed objects Plan 04
-- publishes rather than as a second outcome model.
--
-- `outcome_json` and `resolution_json` hold the exact `viva.turn_outcome.v1` and
-- `viva.challenge_resolution.v1` serializations. Data does not split, rename, or
-- reinterpret their fields: the columns beside the JSON are the identity and
-- ordering keys the database itself has to enforce, and every one of them is
-- checked against the stored document so the two can never disagree.
--
-- No schedule or history table appears here. The selected D-01 seam is migration
-- 0015's `review_items` v1 columns, and this migration extends it transactionally
-- instead of creating a competing store.

CREATE TABLE learning_turn_outcomes (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    supersedes_response_id TEXT,
    outcome_version SMALLINT NOT NULL CHECK (outcome_version = 1),
    outcome_json JSONB NOT NULL CHECK (
        jsonb_typeof(outcome_json) = 'object'
        AND outcome_json ->> 'schema' = 'viva.turn_outcome.v1'
        AND outcome_json ->> 'response_id' = response_id
        AND outcome_json ->> 'question_id' = question_id
        AND outcome_json -> 'resolution' ->> 'kind' IN ('evaluated', 'deferred')
    ),
    payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, study_set_id, voice_session_id, response_id),
    FOREIGN KEY (study_set_id, question_id)
        REFERENCES study_questions (study_set_id, question_id)
        ON DELETE CASCADE
);

CREATE INDEX learning_turn_outcomes_session_order_idx
    ON learning_turn_outcomes (voice_session_id, recorded_at, response_id);

CREATE TABLE learning_challenge_resolutions (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    correction_id TEXT NOT NULL,
    challenged_response_id TEXT NOT NULL,
    replacement_response_id TEXT,
    resolution_version SMALLINT NOT NULL CHECK (resolution_version = 1),
    resolution_json JSONB NOT NULL CHECK (
        jsonb_typeof(resolution_json) = 'object'
        AND resolution_json ->> 'schema' = 'viva.challenge_resolution.v1'
        AND resolution_json ->> 'correction_id' = correction_id
        AND resolution_json ->> 'challenged_response_id' = challenged_response_id
    ),
    payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, study_set_id, voice_session_id, correction_id),
    FOREIGN KEY (user_id, study_set_id, voice_session_id, challenged_response_id)
        REFERENCES learning_turn_outcomes (
            user_id,
            study_set_id,
            voice_session_id,
            response_id
        )
        ON DELETE CASCADE
);

CREATE TABLE question_progression_cursors (
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    policy_id TEXT NOT NULL CHECK (policy_id IN ('ordered_v1', 'adaptive_v1')),
    progression_version SMALLINT NOT NULL CHECK (progression_version = 1),
    progression_json JSONB NOT NULL CHECK (jsonb_typeof(progression_json) = 'object'),
    revision BIGINT NOT NULL CHECK (revision >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, study_set_id, voice_session_id)
);

ALTER TABLE study_questions
    ADD COLUMN ingestion_ordinal BIGINT;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY study_set_id
               ORDER BY created_at ASC, id ASC
           ) AS ordinal
    FROM study_questions
)
UPDATE study_questions AS questions
SET ingestion_ordinal = ranked.ordinal
FROM ranked
WHERE questions.id = ranked.id;

ALTER TABLE study_questions
    ALTER COLUMN ingestion_ordinal SET NOT NULL;

CREATE UNIQUE INDEX study_questions_ingestion_ordinal_idx
    ON study_questions (study_set_id, ingestion_ordinal);

CREATE TABLE study_question_ingestion_cursors (
    study_set_id UUID PRIMARY KEY REFERENCES study_sets(id) ON DELETE CASCADE,
    next_ordinal BIGINT NOT NULL CHECK (next_ordinal >= 1)
);

INSERT INTO study_question_ingestion_cursors (study_set_id, next_ordinal)
SELECT sets.id, COALESCE(MAX(questions.ingestion_ordinal) + 1, 1)
FROM study_sets AS sets
LEFT JOIN study_questions AS questions ON questions.study_set_id = sets.id
GROUP BY sets.id;

-- The authored concept binding and grading rubric, stored beside the question they
-- belong to.
--
-- Plan 04's `LEARN-002` binds every `StudyQuestion` to a concept and a rubric, and
-- `select_next_question` returns that whole question. Until now both stores
-- recovered the pair by rule from fields they already persisted — one crate-private
-- derivation, identical on both backends, recorded in `data`'s crate root as an
-- interim standing in for exactly this migration. A derived value cannot represent
-- an authored one: a question whose concept is not `q-{concept}` and whose rubric
-- has more than the one derivable criterion has no way to be stored or read back.
-- The two columns below are that storage, and Plan 04's canonical
-- `agent/fixtures/learning-core/question-progression-v1.json` questions are what
-- proves they round-trip.
--
-- The backfill is the derivation itself, applied once, so no existing row changes
-- meaning: `concept_id` is the question id without its `q-` prefix, and the rubric
-- is the single required criterion over the question's own prompt and bound source.
-- `logical_source_id` mirrors the store's fixture id translation so a backfilled
-- rubric names its source exactly as the store does.
ALTER TABLE study_questions
    ADD COLUMN concept_id TEXT,
    ADD COLUMN rubric_json JSONB;

UPDATE study_questions AS questions
SET concept_id = derived.concept_id,
    rubric_json = jsonb_build_object(
        'policy_version', 'viva.semantic-rubric.v1',
        'criteria', jsonb_build_array(
            jsonb_build_object(
                'criterion_id', 'crit-' || derived.concept_id,
                'concept_id', derived.concept_id,
                'claim', COALESCE(questions.prompt, ''),
                'source_id', derived.logical_source_id,
                'required', TRUE
            )
        )
    )
FROM (
    SELECT
        inner_questions.id,
        CASE
            WHEN inner_questions.question_id LIKE 'q-%'
                 AND char_length(inner_questions.question_id) > 2
            THEN substring(inner_questions.question_id FROM 3)
            ELSE inner_questions.question_id
        END AS concept_id,
        CASE inner_questions.source_span_id::text
            WHEN '11111111-1111-4111-8111-111111111111' THEN 'biology-midterm'
            WHEN '22222222-2222-4222-8222-222222222222' THEN 'lec-5'
            WHEN '33333333-3333-4333-8333-333333333333' THEN 'src-lecture-5-slide-18'
            WHEN '44444444-4444-4444-8444-444444444444' THEN 'voice-session-1'
            ELSE inner_questions.source_span_id::text
        END AS logical_source_id
    FROM study_questions AS inner_questions
) AS derived
WHERE questions.id = derived.id;

ALTER TABLE study_questions
    ALTER COLUMN concept_id SET NOT NULL,
    ALTER COLUMN rubric_json SET NOT NULL;

ALTER TABLE study_questions
    ADD CONSTRAINT study_questions_rubric_is_object
    CHECK (
        jsonb_typeof(rubric_json) = 'object'
        AND rubric_json ->> 'policy_version' IS NOT NULL
        AND jsonb_typeof(rubric_json -> 'criteria') = 'array'
    );
