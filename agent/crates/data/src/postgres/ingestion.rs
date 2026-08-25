//! Ingestion: turning one learner upload into durable study-set rows
//! (`DATA-014`, `DATA-015`).
//!
//! Owned invariant: the generated record is the single source of truth, and the
//! whole of it commits or none of it does. Classification and decoding happen in
//! `memory::ingestion`, which both backends share, so a paste or file produces the
//! same concepts, questions, and source spans here as it does in memory; this
//! module owns only the durable half — one transaction per ingestion, one
//! surrogate UUID per logical id, and the ordinal allocation that makes ordered
//! progression deterministic.
//!
//! `postgres.rs` keeps the port methods and delegates their whole body here.

use super::*;

impl PostgresStudyStore {
    async fn insert_ingestion_artifacts(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        generated: &StudySetIngestionRecord,
        study_set_uuid: Uuid,
    ) -> Result<(), PortError> {
        for document in &generated.documents {
            sqlx::query(
                "INSERT INTO study_documents (id, study_set_id, display_name, source_kind, processing_status, deleted_at)
                 VALUES ($1, $2, $3, $4, $5, NULL)",
            )
            .bind(Self::uuid_for(&document.id)?)
            .bind(study_set_uuid)
            .bind(&document.display_name)
            .bind(&document.source_kind)
            .bind(document.processing_status.as_str())
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        for source in &generated.source_spans {
            sqlx::query(
                "INSERT INTO source_spans (
                    id, document_id, locator, excerpt, confidence, retrieval_reason, deleted_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, NULL)",
            )
            .bind(Self::uuid_for(&source.id)?)
            .bind(Self::uuid_for(&source.document_id)?)
            .bind(&source.locator)
            .bind(&source.excerpt)
            .bind(source_confidence_str(&source.confidence))
            .bind(&source.retrieval_reason)
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        for concept in &generated.concepts {
            sqlx::query(
                "INSERT INTO concepts (id, study_set_id, label, status, source_span_id, public_id)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(Uuid::new_v4())
            .bind(study_set_uuid)
            .bind(&concept.label)
            .bind(concept_status_str(&concept.status))
            .bind(Self::uuid_for(&concept.source_span_id)?)
            .bind(&concept.public_id)
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        for question in &generated.questions {
            // One ordinal per question, allocated in the same transaction as the
            // question it numbers. `created_at` cannot do this job: two questions
            // written by one statement share it, and the order Plan 04's ordered
            // progression walks has to be the order they were committed in.
            let ordinal = sqlx::query_scalar::<_, i64>(
                "INSERT INTO study_question_ingestion_cursors (study_set_id, next_ordinal)
                 VALUES ($1, 2)
                 ON CONFLICT (study_set_id) DO UPDATE
                 SET next_ordinal = study_question_ingestion_cursors.next_ordinal + 1
                 RETURNING next_ordinal - 1 AS allocated_ordinal",
            )
            .bind(study_set_uuid)
            .fetch_one(&mut **tx)
            .await
            .map_err(pg_error)?;
            sqlx::query(
                "INSERT INTO study_questions (
                    id, study_set_id, question_id, source_span_id, prompt, expected_terms,
                    follow_up, active, ingestion_ordinal, concept_id, rubric_json
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $10)",
            )
            .bind(Uuid::new_v4())
            .bind(study_set_uuid)
            .bind(&question.question_id)
            .bind(Self::uuid_for(&question.source.source_id)?)
            .bind(&question.prompt)
            .bind(&question.expected_terms)
            .bind(&question.follow_up)
            .bind(ordinal)
            .bind(&question.concept_id)
            .bind(
                serde_json::to_value(&question.rubric)
                    .map_err(|error| json_invariant("study_question_rubric_json", &error))?,
            )
            .execute(&mut **tx)
            .await
            .map_err(pg_error)?;
        }

        Ok(())
    }
}

/// The three ingestion port bodies. `postgres.rs` keeps the trait signatures; the
/// exam capture, generation, and the one transaction that commits every generated
/// artifact live here.
pub(super) async fn create_paste_study_set(
    store: &PostgresStudyStore,
    input: CreatePasteStudySet,
) -> Result<StudySetIngestionRecord, PortError> {
    let exam_at = crate::ingestion_exam_instant("postgres", input.exam_date.as_deref())?;
    let generated = generate_paste_study_set(input)?;
    let study_set_uuid = PostgresStudyStore::uuid_for(&generated.study_set.id)?;
    let mut tx = store.pool.begin().await.map_err(pg_error)?;

    sqlx::query(
        "INSERT INTO study_sets (
             id, user_id, title, course, ingestion_status, ingestion_error, exam_at, exam_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, ($7 AT TIME ZONE 'UTC')::date)",
    )
    .bind(study_set_uuid)
    .bind(&generated.study_set.user_id)
    .bind(&generated.study_set.title)
    .bind(&generated.study_set.course)
    .bind(generated.study_set.ingestion_status.as_str())
    .bind(&generated.study_set.ingestion_error)
    .bind(exam_at)
    .execute(&mut *tx)
    .await
    .map_err(pg_error)?;

    // One artifact writer for every ingestion path, so a column a new
    // migration adds cannot be bound on one path and silently missed on the
    // other.
    PostgresStudyStore::insert_ingestion_artifacts(&mut tx, &generated, study_set_uuid).await?;

    tx.commit().await.map_err(pg_error)?;
    Ok(generated)
}

pub(super) async fn create_file_study_set(
    store: &PostgresStudyStore,
    input: CreateFileStudySet,
) -> Result<StudySetIngestionRecord, PortError> {
    let exam_at = crate::ingestion_exam_instant("postgres", input.exam_date.as_deref())?;
    let generated = generate_file_study_set(input)?;
    let study_set_uuid = PostgresStudyStore::uuid_for(&generated.study_set.id)?;
    let mut tx = store.pool.begin().await.map_err(pg_error)?;

    sqlx::query(
        "INSERT INTO study_sets (
             id, user_id, title, course, ingestion_status, ingestion_error, exam_at, exam_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, ($7 AT TIME ZONE 'UTC')::date)",
    )
    .bind(study_set_uuid)
    .bind(&generated.study_set.user_id)
    .bind(&generated.study_set.title)
    .bind(&generated.study_set.course)
    .bind(generated.study_set.ingestion_status.as_str())
    .bind(&generated.study_set.ingestion_error)
    .bind(exam_at)
    .execute(&mut *tx)
    .await
    .map_err(pg_error)?;

    PostgresStudyStore::insert_ingestion_artifacts(&mut tx, &generated, study_set_uuid).await?;

    tx.commit().await.map_err(pg_error)?;
    Ok(generated)
}

pub(super) async fn retry_file_study_set(
    store: &PostgresStudyStore,
    input: CreateFileStudySet,
) -> Result<StudySetIngestionRecord, PortError> {
    let study_set_id = input
        .study_set_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            PortError::unavailable("postgres", "file_retry", "study_set_id is required")
        })?
        .to_owned();
    let study_set_uuid = PostgresStudyStore::uuid_for(&study_set_id)?;
    let exam_at = crate::ingestion_exam_instant("postgres", input.exam_date.as_deref())?;
    let row = sqlx::query(
        "SELECT title, course
             FROM study_sets
             WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(study_set_uuid)
    .bind(&input.user_id)
    .fetch_optional(&store.pool)
    .await
    .map_err(pg_error)?
    .ok_or_else(|| {
        PortError::unavailable(
            "postgres",
            format!("{}/{}", input.user_id, study_set_id),
            "study set is not available for this user",
        )
    })?;
    let generated = generate_file_study_set(CreateFileStudySet {
        user_id: input.user_id,
        study_set_id: Some(study_set_id),
        title: row.try_get("title").map_err(pg_error)?,
        course: row.try_get("course").map_err(pg_error)?,
        exam_date: input.exam_date,
        file_name: input.file_name,
        content_type: input.content_type,
        file_bytes: input.file_bytes,
        session_id: input.session_id,
    })?;

    let mut tx = store.pool.begin().await.map_err(pg_error)?;
    sqlx::query("DELETE FROM study_questions WHERE study_set_id = $1")
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
    sqlx::query("DELETE FROM concepts WHERE study_set_id = $1")
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
    sqlx::query(
        "DELETE FROM source_spans sp
         USING study_documents d
         WHERE sp.document_id = d.id AND d.study_set_id = $1",
    )
    .bind(study_set_uuid)
    .execute(&mut *tx)
    .await
    .map_err(pg_error)?;
    sqlx::query("DELETE FROM study_documents WHERE study_set_id = $1")
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
    // A retry re-ingests the file; it never re-asks the learner for the exam
    // date, and the production retry route always sends none. Writing that
    // absence verbatim would erase the only authoritative input D-01's exam cap
    // has, so an absent exam date leaves the recorded instant untouched — the
    // same rule title and course already follow.
    sqlx::query(
        "UPDATE study_sets
         SET title = $2,
             course = $3,
             ingestion_status = $4,
             ingestion_error = $5,
             exam_at = COALESCE($6, exam_at),
             exam_date = COALESCE(($6 AT TIME ZONE 'UTC')::date, exam_date)
         WHERE id = $1",
    )
    .bind(study_set_uuid)
    .bind(&generated.study_set.title)
    .bind(&generated.study_set.course)
    .bind(generated.study_set.ingestion_status.as_str())
    .bind(&generated.study_set.ingestion_error)
    .bind(exam_at)
    .execute(&mut *tx)
    .await
    .map_err(pg_error)?;

    PostgresStudyStore::insert_ingestion_artifacts(&mut tx, &generated, study_set_uuid).await?;

    // A retry replaces this set's documents, spans, concepts, and questions, so
    // every browser authorization derived from the previous ones stops being
    // authority in the same transaction that replaces them. The progression
    // cursor points into the replaced question bank and goes with them;
    // recorded outcomes and their challenge resolutions cascade from the
    // questions themselves.
    sqlx::query("DELETE FROM event_authorization_digests WHERE study_set_id = $1")
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;
    sqlx::query("DELETE FROM question_progression_cursors WHERE study_set_id = $1")
        .bind(study_set_uuid)
        .execute(&mut *tx)
        .await
        .map_err(pg_error)?;

    tx.commit().await.map_err(pg_error)?;
    Ok(generated)
}
