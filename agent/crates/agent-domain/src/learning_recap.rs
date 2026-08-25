//! Evidence-derived study session recap (Plan 04 `LEARN-001`).
//!
//! A recap is a pure projection of persisted [`SessionLearningEvidence`]. It
//! never inspects expected-term positions, never re-grades an answer, and never
//! invents a review date. Rebuilding a recap from the same persisted rows —
//! after a replay or a reconnect — must produce an identical value.
//!
//! # Fold contract consumed by `build_session_recap`
//!
//! The `[04b]` fold in this module implements exactly these rules; the shared
//! fixture `agent/fixtures/learning-core/recaps-v1.json` pins them case by case:
//!
//! - an outcome is *superseded* when another outcome in the same evidence names
//!   it in `supersedes_response_id`; superseded outcomes contribute nothing;
//! - outcomes repeated under one `response_id` (idempotent replay rows) collapse
//!   to a single contribution;
//! - `concepts` carries one entry per concept that has a final, nonsuperseded
//!   `ConceptStatusTransition`, taking that transition's `to_status`, ordered by
//!   the first evaluated outcome that touched the concept, then by `concept_id`;
//! - labels join by exact `concept_id`; a missing or duplicated label is an
//!   error, never a fuzzy match;
//! - `source_moments` carries `(response_id, source_id)` for every `source_id`
//!   recorded on a nonsuperseded evaluated outcome, in outcome order then
//!   `source_ids` order; deferred outcomes contribute none, so a source that
//!   belongs to no evaluated outcome can never appear;
//! - `review_schedule` is copied from `SessionLearningEvidence::review_decisions`
//!   in `concepts` order; entries for concepts absent from `concepts`, duplicate
//!   entries, and entries whose `due_at` is not a valid instant are errors;
//! - `deferred_turns` counts nonsuperseded deferred outcomes and assigns no
//!   status;
//! - copy is deterministic and truth preserving:
//!   - `headline` is `"Strong concepts: {strong} of {graded}."`, or exactly
//!     `"No graded concepts this session."` when nothing was graded;
//!   - `summary` is
//!     `"Graded concepts: {graded}. Evaluated turns: {evaluated}. Deferred turns: {deferred}."`,
//!     or exactly `"No graded outcome was saved for this session."` when nothing
//!     was graded — that sentence claims no strength, weakness, or review date;
//!   - `next_action` is `"Review the scheduled concepts on their due dates."`
//!     when a review schedule exists, `"Keep answering to build more evidence."`
//!     when concepts were graded without a schedule, and
//!     `"Answer one question to start building evidence."` otherwise.

use serde::{Deserialize, Serialize};

use crate::{learning_outcome::TurnOutcome, ConceptStatus};

/// Exact `StudySessionRecap::schema` value.
pub const VIVA_STUDY_SESSION_RECAP_SCHEMA: &str = "viva.study_session_recap.v2";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionLearningEvidence {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub outcomes: Vec<TurnOutcome>,
    pub concept_labels: Vec<ConceptLabel>,
    pub review_decisions: Vec<ReviewScheduleSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConceptLabel {
    pub concept_id: String,
    pub label: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewScheduleAuthority {
    ServerPersistedFsrs,
    CoreFsrsReadTime,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReviewScheduleSummary {
    pub concept_id: String,
    pub due_at: String,
    pub authority: ReviewScheduleAuthority,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecapConceptOutcome {
    pub concept_id: String,
    pub label: String,
    pub status: ConceptStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecapSourceMoment {
    pub response_id: String,
    pub source_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecapBuildError {
    EvidenceIdentityMismatch,
    DuplicateConceptLabel { concept_id: String },
    MissingConceptLabel { concept_id: String },
    DuplicateReviewDecision { concept_id: String },
    InvalidReviewDecision { concept_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudySessionRecap {
    pub schema: String, // exactly "viva.study_session_recap.v2"
    pub voice_session_id: String,
    pub headline: String,
    pub summary: String,
    pub concepts: Vec<RecapConceptOutcome>,
    pub review_schedule: Vec<ReviewScheduleSummary>,
    pub next_action: String,
    pub source_moments: Vec<RecapSourceMoment>,
    pub deferred_turns: u32,
}
