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
            agent_domain::PortError::invalid_input(
                backend,
                "exam_date",
                "exam_date is not a parseable UTC instant or calendar date",
            )
        })
}

/// INTERIM DERIVATION — Plan 09 Task 6 replaces this with durable storage.
///
/// Plan 04's `LEARN-002` bound every `StudyQuestion` to a concept and a grading
/// rubric, but no migration through `0015` gives `study_questions` a concept or
/// rubric column. Both backends generate their questions through one function
/// whose question id is exactly `q-{concept public id}` and whose prompt is the
/// server-authored statement an answer has to satisfy, so the concept binding and
/// the single required criterion are recoverable — identically — from fields both
/// backends already persist. Deriving in one crate-private place keeps memory and
/// Postgres returning the same `StudyQuestion` (`DATA-011`) instead of letting one
/// backend invent a value the other cannot see.
///
/// Removal trigger: Plan 09 Task 6's canonical learning persistence, which stores
/// the authored concept binding and rubric alongside the question.
pub(crate) fn generated_question_concept_id(question_id: &str) -> String {
    question_id
        .strip_prefix("q-")
        .filter(|rest| !rest.is_empty())
        .unwrap_or(question_id)
        .to_owned()
}

pub(crate) fn generated_question_rubric(
    question_id: &str,
    prompt: &str,
    source_id: &str,
) -> agent_domain::EvaluationRubricV1 {
    let concept_id = generated_question_concept_id(question_id);
    agent_domain::EvaluationRubricV1 {
        policy_version: agent_domain::learning_outcome::VIVA_SEMANTIC_RUBRIC_POLICY_VERSION
            .to_owned(),
        criteria: vec![agent_domain::RubricCriterionV1 {
            criterion_id: format!("crit-{concept_id}"),
            concept_id,
            claim: prompt.to_owned(),
            source_id: source_id.to_owned(),
            required: true,
        }],
    }
}

/// The four label buckets migration `0004` stores for a session recap.
///
/// Plan 04's evidence-derived v2 [`agent_domain::StudySessionRecap`] carries typed
/// `concepts` and `review_schedule` instead; this is the projection Plan 04 itself
/// recorded (its retired `from_evidence_recap` fold), kept in one crate-private
/// place so both backends persist identical buckets from one canonical recap and
/// neither invents a second interpretation.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RecapLabelBuckets {
    pub(crate) strong: Vec<String>,
    pub(crate) shaky: Vec<String>,
    pub(crate) missed: Vec<String>,
    pub(crate) review_later: Vec<String>,
}

pub(crate) fn recap_label_buckets(recap: &agent_domain::StudySessionRecap) -> RecapLabelBuckets {
    let labels_with_status = |wanted: agent_domain::ConceptStatus| {
        recap
            .concepts
            .iter()
            .filter(|concept| concept.status == wanted)
            .map(|concept| concept.label.clone())
            .collect::<Vec<_>>()
    };
    RecapLabelBuckets {
        strong: labels_with_status(agent_domain::ConceptStatus::Strong),
        shaky: labels_with_status(agent_domain::ConceptStatus::Shaky),
        missed: labels_with_status(agent_domain::ConceptStatus::Missed),
        review_later: recap
            .review_schedule
            .iter()
            .filter_map(|item| {
                recap
                    .concepts
                    .iter()
                    .find(|concept| concept.concept_id == item.concept_id)
            })
            .map(|concept| concept.label.clone())
            .collect(),
    }
}
