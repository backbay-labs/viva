//! Session-scoped question progression (Plan 04 `LEARN-004B`, decision `D-02B`).
//!
//! Question selection is a session-scoped cursor, not the store's first active
//! question. Every selection returns a [`QuestionProgressionResult`] carrying the
//! server-owned ordinal, total, and cursor revision, so advance, retry, replay,
//! reconnect, and exhaustion are all observable facts rather than inferences.
//!
//! # Cursor contract consumed by the `[04b]` executor and store
//!
//! The shared fixture `agent/fixtures/learning-core/question-progression-v1.json`
//! pins these rules case by case:
//!
//! - `ProgressionPolicyId::OrderedV1` selects the first active, source-valid
//!   question by persisted ingestion ordinal that is not already completed;
//!   inactive or archived questions are skipped and never counted in `total`;
//! - `ordinal` is the selected question's 1-based position among the session's
//!   active questions and `total` is the count of those active questions;
//! - `QuestionDisposition::Advance` completes the current question,
//!   `RetryCurrent` and `Deferred` keep it — `Deferred` never adds it to
//!   `completed_question_ids`;
//! - `attempt_counts` increments once per selection of a question, so a retry
//!   reports `attempt` greater than one for the same `question_id`;
//! - `revision` advances monotonically with each cursor mutation; replaying an
//!   already-authorized response returns the stored result and the unchanged
//!   revision, and concurrent selections settle on a single revision;
//! - when every active question is completed the result is
//!   [`QuestionProgressionResult::Exhausted`], which carries no question — no
//!   fabricated fixture question is ever emitted to fill the gap.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::StudyQuestion;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressionPolicyId {
    OrderedV1,
    AdaptiveV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QuestionProgressionCursor {
    pub voice_session_id: String,
    pub policy: ProgressionPolicyId,
    pub current_question_id: Option<String>,
    pub completed_question_ids: Vec<String>,
    pub attempt_counts: BTreeMap<String, u32>,
    pub revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum QuestionProgressionResult {
    Selected {
        question: StudyQuestion,
        ordinal: u32,
        total: u32,
        selection_reason: String,
        revision: u64,
    },
    Retry {
        question: StudyQuestion,
        ordinal: u32,
        total: u32,
        attempt: u32,
        revision: u64,
    },
    Exhausted {
        completed: u32,
        total: u32,
        revision: u64,
    },
}
