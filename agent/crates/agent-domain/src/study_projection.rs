//! `AuthenticatedStudyProjectionV1` — the only session/library read model
//! (Plan 04 `LEARN-008`).
//!
//! These types are the Rust half of the cross-language contract whose
//! TypeScript half is `packages/core/src/study-projection-contract.ts`. Both
//! sides parse the identical shared fixture
//! `agent/fixtures/learning-core/study-projection-v1.json`, so the wire shape is
//! camelCase on both sides.
//!
//! # Rules the producer must satisfy
//!
//! - projection identity comes from authenticated claims and store rows, never
//!   from a route overlay;
//! - `exam_label` is display copy only; review scheduling uses the exact stored
//!   exam timestamp internally and never this string;
//! - `active_question` deliberately excludes expected terms, rubric answers, and
//!   source excerpts — a citation carries only its identifiers, span, label, and
//!   confidence;
//! - every review-schedule entry and the active question reference a concept
//!   included in `concepts`;
//! - every review item uses the one selected D-01 authority;
//! - a concept's `due_at` equals its matching review-schedule entry, or is
//!   `None` when the concept has no schedule entry;
//! - a study set that is not `StudySetIngestionStatus::Ready` has no active
//!   question and cannot start a session.

use serde::{Deserialize, Serialize};

use crate::{
    learning_recap::ReviewScheduleAuthority, ConceptStatus, SourceConfidence, StudyMode,
    StudySetIngestionStatus,
};

/// The literal projection version. Any value other than numeric `1` — including
/// the string `"1"` and any later version number — fails closed on parse.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct StudyProjectionVersionV1;

impl TryFrom<u64> for StudyProjectionVersionV1 {
    type Error = String;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if value == 1 {
            Ok(Self)
        } else {
            Err(format!(
                "authenticated study projection version must be 1, got {value}"
            ))
        }
    }
}

impl From<StudyProjectionVersionV1> for u64 {
    fn from(_: StudyProjectionVersionV1) -> Self {
        1
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AuthenticatedStudyProjectionV1 {
    pub version: StudyProjectionVersionV1,
    pub study_set: StudyProjectionStudySetV1,
    pub session: StudyProjectionSessionV1,
    pub concepts: Vec<StudyProjectionConceptV1>,
    pub active_question: Option<StudyProjectionActiveQuestionV1>,
    pub question_progress: StudyProjectionQuestionProgressV1,
    pub review_schedule: Vec<StudyProjectionReviewItemV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StudyProjectionStudySetV1 {
    pub id: String,
    pub title: String,
    pub course: Option<String>,
    pub exam_label: Option<String>,
    pub ingestion_status: StudySetIngestionStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StudyProjectionSessionV1 {
    pub id: String,
    pub mode: StudyMode,
    pub goal: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StudyProjectionConceptV1 {
    pub id: String,
    pub label: String,
    pub status: ConceptStatus,
    pub last_reviewed_at: Option<String>,
    pub due_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StudyProjectionActiveQuestionV1 {
    pub id: String,
    pub concept_id: String,
    pub prompt: String,
    pub source_citations: Vec<StudyProjectionSourceCitationV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StudyProjectionSourceCitationV1 {
    pub source_id: String,
    pub document_id: String,
    pub span: String,
    pub label: String,
    pub confidence: SourceConfidence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StudyProjectionQuestionProgressV1 {
    pub completed: u32,
    pub total: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StudyProjectionReviewItemV1 {
    pub concept_id: String,
    pub due_at: String,
    pub authority: ReviewScheduleAuthority,
}
