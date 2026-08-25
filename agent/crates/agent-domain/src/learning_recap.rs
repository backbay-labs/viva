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

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    learning_outcome::{TurnOutcome, TurnResolution},
    parse_utc_instant, ConceptStatus, StudyQuestion,
};

/// Exact `StudySessionRecap::schema` value.
pub const VIVA_STUDY_SESSION_RECAP_SCHEMA: &str = "viva.study_session_recap.v2";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionLearningEvidence {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    /// The question this session's progression cursor is currently on, with the
    /// server-owned rubric that grades it.
    ///
    /// This is the session-scoped counterpart of the study set's global
    /// `StudyMemoryStore::active_question` shortcut. The shortcut takes no
    /// session and no cursor, so it always answers with the study set's *first*
    /// active question; once a session's ordered cursor advances past that
    /// question the shortcut names a different question than the one the server
    /// just asked. Only this field tracks the session.
    ///
    /// `None` means the session is not on a question — a fresh session before
    /// its first selection, or an exhausted one. A store that cannot report the
    /// cursor's question leaves it `None` and the turn fails closed: an answer
    /// is never graded against a question the server cannot confirm it asked.
    /// The recap fold ignores this field entirely; a recap stays a pure
    /// projection of `outcomes`.
    #[serde(default)]
    pub current_question: Option<StudyQuestion>,
    /// The questions this session's persisted `outcomes` were graded against,
    /// each with the server-owned rubric that graded it.
    ///
    /// The cursor names the answer the server is *currently* waiting for, so it
    /// cannot authorize a redelivery of a turn already recorded: that turn's own
    /// disposition is what moved the cursor off its question. A replay is bound
    /// from here instead, which is why this carries the question rather than
    /// only its identity — the replay recomputes the same payload, so the store
    /// keeps its per-response payload guard rather than being handed a value it
    /// must take on trust.
    ///
    /// One entry per distinct `question_id` among `outcomes` is enough; order is
    /// not read. A store that cannot report an entry leaves it out and the
    /// replay fails closed rather than grading against a question the server
    /// cannot confirm it asked. The recap fold ignores this field entirely.
    #[serde(default)]
    pub answered_questions: Vec<StudyQuestion>,
    pub outcomes: Vec<TurnOutcome>,
    pub concept_labels: Vec<ConceptLabel>,
    pub review_decisions: Vec<ReviewScheduleSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct ReviewScheduleSummary {
    pub concept_id: String,
    pub due_at: String,
    pub authority: ReviewScheduleAuthority,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecapConceptOutcome {
    pub concept_id: String,
    pub label: String,
    pub status: ConceptStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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

/// Fold persisted session evidence into the one recap the learner sees.
///
/// This function is total over its input and reads nothing else: no clock, no
/// store, no question, and no expected-term list. Given the same persisted rows
/// it returns the same recap, which is what makes a replay and a reconnect
/// produce identical output.
pub fn build_session_recap(
    evidence: &SessionLearningEvidence,
) -> Result<StudySessionRecap, RecapBuildError> {
    if evidence.user_id.trim().is_empty()
        || evidence.study_set_id.trim().is_empty()
        || evidence.voice_session_id.trim().is_empty()
    {
        return Err(RecapBuildError::EvidenceIdentityMismatch);
    }

    // A superseded outcome contributes nothing, and idempotent replay rows for one
    // response collapse to a single contribution.
    let superseded = evidence
        .outcomes
        .iter()
        .filter_map(|outcome| outcome.supersedes_response_id.as_deref())
        .collect::<BTreeSet<_>>();
    let mut counted = BTreeSet::new();
    let effective = evidence
        .outcomes
        .iter()
        .filter(|outcome| !superseded.contains(outcome.response_id.as_str()))
        .filter(|outcome| counted.insert(outcome.response_id.as_str()))
        .collect::<Vec<_>>();

    let mut labels = BTreeMap::new();
    for label in &evidence.concept_labels {
        if labels
            .insert(label.concept_id.as_str(), label.label.as_str())
            .is_some()
        {
            return Err(RecapBuildError::DuplicateConceptLabel {
                concept_id: label.concept_id.clone(),
            });
        }
    }

    let mut evaluated_turns = 0_u32;
    let mut deferred_turns = 0_u32;
    let mut first_evaluated: BTreeMap<&str, usize> = BTreeMap::new();
    let mut final_status: BTreeMap<&str, ConceptStatus> = BTreeMap::new();
    let mut source_moments = Vec::new();
    for (index, outcome) in effective.iter().enumerate() {
        match &outcome.resolution {
            TurnResolution::Evaluated {
                concept_transitions,
                ..
            } => {
                evaluated_turns += 1;
                for transition in concept_transitions {
                    first_evaluated
                        .entry(transition.concept_id.as_str())
                        .or_insert(index);
                    final_status
                        .insert(transition.concept_id.as_str(), transition.to_status.clone());
                }
                // A source moment exists only because an evaluated outcome cited
                // that source, so a source belonging to no outcome cannot appear.
                for source_id in &outcome.source_ids {
                    source_moments.push(RecapSourceMoment {
                        response_id: outcome.response_id.clone(),
                        source_id: source_id.clone(),
                    });
                }
            }
            // Counted, never graded: a deferral assigns no status.
            TurnResolution::Deferred { .. } => deferred_turns += 1,
        }
    }

    let mut ordered = first_evaluated.keys().copied().collect::<Vec<_>>();
    ordered.sort_by_key(|concept_id| (first_evaluated[concept_id], *concept_id));

    let mut concepts = Vec::with_capacity(ordered.len());
    for concept_id in ordered {
        // Labels join by exact concept ID. Two concepts may share a label, and a
        // missing label is an error rather than a fuzzy match or a bare ID.
        let label = labels
            .get(concept_id)
            .ok_or_else(|| RecapBuildError::MissingConceptLabel {
                concept_id: concept_id.to_owned(),
            })?;
        concepts.push(RecapConceptOutcome {
            concept_id: concept_id.to_owned(),
            label: (*label).to_owned(),
            status: final_status[concept_id].clone(),
        });
    }

    // Review entries come from the selected D-01 decisions only; this fold never
    // computes, adjusts, or invents a due date. Under D-01B the decision list is
    // exactly empty and the authenticated read layer attaches the schedule.
    let mut decisions = BTreeMap::new();
    for decision in &evidence.review_decisions {
        if decisions
            .insert(decision.concept_id.as_str(), decision)
            .is_some()
        {
            return Err(RecapBuildError::DuplicateReviewDecision {
                concept_id: decision.concept_id.clone(),
            });
        }
        let graded = concepts
            .iter()
            .any(|concept| concept.concept_id == decision.concept_id);
        if !graded || parse_utc_instant(&decision.due_at).is_none() {
            return Err(RecapBuildError::InvalidReviewDecision {
                concept_id: decision.concept_id.clone(),
            });
        }
    }
    let review_schedule = concepts
        .iter()
        .filter_map(|concept| decisions.get(concept.concept_id.as_str()))
        .map(|decision| (*decision).clone())
        .collect::<Vec<_>>();

    let graded = concepts.len();
    let strong = concepts
        .iter()
        .filter(|concept| concept.status == ConceptStatus::Strong)
        .count();
    let (headline, summary) = if graded == 0 {
        (
            "No graded concepts this session.".to_owned(),
            // Claims no strength, no weakness, and no review date.
            "No graded outcome was saved for this session.".to_owned(),
        )
    } else {
        (
            format!("Strong concepts: {strong} of {graded}."),
            format!(
                "Graded concepts: {graded}. Evaluated turns: {evaluated_turns}. \
                 Deferred turns: {deferred_turns}."
            ),
        )
    };
    let next_action = if !review_schedule.is_empty() {
        "Review the scheduled concepts on their due dates."
    } else if graded > 0 {
        "Keep answering to build more evidence."
    } else {
        "Answer one question to start building evidence."
    }
    .to_owned();

    Ok(StudySessionRecap {
        schema: VIVA_STUDY_SESSION_RECAP_SCHEMA.to_owned(),
        voice_session_id: evidence.voice_session_id.clone(),
        headline,
        summary,
        concepts,
        review_schedule,
        next_action,
        source_moments,
        deferred_turns,
    })
}
