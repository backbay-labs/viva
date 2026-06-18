CREATE TABLE study_sets (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    course TEXT,
    exam_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE study_documents (
    id UUID PRIMARY KEY,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    content_hash TEXT,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE source_spans (
    id UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES study_documents(id) ON DELETE CASCADE,
    locator JSONB NOT NULL,
    excerpt TEXT NOT NULL,
    embedding_ref TEXT,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE concepts (
    id UUID PRIMARY KEY,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    source_span_id UUID REFERENCES source_spans(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE voice_sessions (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    study_set_id UUID REFERENCES study_sets(id) ON DELETE SET NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

CREATE TABLE answer_attempts (
    id UUID PRIMARY KEY,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    concept_id UUID REFERENCES concepts(id) ON DELETE SET NULL,
    question_id TEXT NOT NULL,
    evaluation_label TEXT NOT NULL,
    concept_status TEXT NOT NULL,
    confidence_score DOUBLE PRECISION NOT NULL,
    source_span_id UUID REFERENCES source_spans(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE review_items (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    study_set_id UUID NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
    concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    due_at TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL
);
