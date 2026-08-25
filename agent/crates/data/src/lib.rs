#![forbid(unsafe_code)]

mod memory;
mod migrations;
mod pool;
mod postgres;

pub use memory::{
    AnswerAttemptRecord, ConceptRecord, ConceptStatusRecord, FixtureIdTranslation,
    InMemoryStudyState, InMemoryStudyStore, PersistedAnswerEvaluation, PersistedRecapSourceMoment,
    PersistedSessionRecap, PersistedSourceReference, RecapRecord, ReviewItemRecord,
    ReviewScheduleDecisionRecord, SourceSpanRecord, StudyDocumentRecord, StudyQuestionRecord,
    StudySetRecord, VoiceSessionRecord,
};
pub use migrations::{
    assert_schema_has_no_raw_payload_columns, migration_sql, run_migrations, seed_postgres_fixture,
    FixtureSeedError,
};
pub use pool::{connect_pg, PgConfig};
pub use postgres::PostgresStudyStore;

/// The learner-supplied exam date, read fail-closed as the exact UTC instant D-01
/// schedules against. One implementation for both backends: a value one store
/// accepts and the other rejects is a scheduling input that disappears on exactly
/// one deployment.
///
/// `None` means the caller supplied nothing, which is never the same as clearing a
/// value the learner already recorded.
pub(crate) fn ingestion_exam_instant(
    backend: &'static str,
    exam_date: Option<&str>,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, agent_domain::PortError> {
    let Some(raw) = exam_date.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    agent_domain::parse_utc_instant(raw)
        .map(Some)
        .ok_or_else(|| {
            agent_domain::PortError::adapter(
                backend,
                "exam_date is not a parseable UTC instant or calendar date",
            )
        })
}
