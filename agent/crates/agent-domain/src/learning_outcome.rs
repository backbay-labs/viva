//! Versioned semantic evaluation and persisted turn-outcome boundary (Plan 04 `LEARN-002`).
//!
//! `TurnOutcome` is the only persistable learner fact produced by a spoken answer.
//! The evaluator returns an `EvaluationDecision`; the server rebinds it to the
//! authorized question, rubric, concepts, and sources before persistence. A
//! deferred evaluation is a persisted fact, not an invitation to invent a grade:
//! it carries no label, no confidence, and no `ConceptStatusTransition`.
//!
//! Answer text is deliberately absent from every persisted type in this module.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{ConceptStatus, StudyQuestion};

/// Exact `EvaluationRubricV1::policy_version` value.
pub const VIVA_SEMANTIC_RUBRIC_POLICY_VERSION: &str = "viva.semantic-rubric.v1";

/// Exact `TurnOutcome::schema` value.
pub const VIVA_TURN_OUTCOME_SCHEMA: &str = "viva.turn_outcome.v1";

/// Exact `TurnOutcomeRecordReceipt::schema` value.
pub const VIVA_TURN_OUTCOME_RECORD_SCHEMA: &str = "viva.turn_outcome_record.v1";

/// Exact `ChallengeResolution::schema` value.
pub const VIVA_CHALLENGE_RESOLUTION_SCHEMA: &str = "viva.challenge_resolution.v1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EvaluationRubricV1 {
    pub policy_version: String, // exactly "viva.semantic-rubric.v1"
    pub criteria: Vec<RubricCriterionV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RubricCriterionV1 {
    pub criterion_id: String,
    pub concept_id: String,
    pub claim: String,
    pub source_id: String,
    pub required: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EvaluationRequest {
    pub response_id: String,
    pub question: StudyQuestion,
    pub answer_text: String,
    pub transcript_confidence: Option<f32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriterionAssessmentKind {
    Satisfied,
    Contradicted,
    NotDemonstrated,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CriterionAssessment {
    pub criterion_id: String,
    pub assessment: CriterionAssessmentKind,
    pub confidence: f32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationLabel {
    Strong,
    MostlyCorrect,
    PartiallyCorrect,
    Vague,
    Wrong,
    InsufficientEvidence,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationDeferralReason {
    EmptyAnswer,
    TranscriptUncertain,
    EvaluatorUnavailable,
    InvalidEvaluatorOutput,
    InsufficientSemanticEvidence,
    ContradictoryEvidence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvaluationError {
    Unavailable,
    Timeout,
    MalformedResponse,
    ContractViolation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvaluationDecision {
    Evaluated {
        assessments: Vec<CriterionAssessment>,
        concise_feedback: String,
        retry_prompt: Option<String>,
    },
    Deferred {
        reason: EvaluationDeferralReason,
        can_retry_same_question: bool,
    },
}

#[async_trait]
pub trait AnswerEvaluator: Send + Sync {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationDecision, EvaluationError>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConceptStatusTransition {
    pub concept_id: String,
    pub from_status: ConceptStatus,
    pub to_status: ConceptStatus,
    pub criterion_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionDisposition {
    Advance,
    RetryCurrent,
    Deferred,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnResolution {
    Evaluated {
        label: EvaluationLabel,
        confidence: f32,
        assessments: Vec<CriterionAssessment>,
        concept_transitions: Vec<ConceptStatusTransition>,
        concise_feedback: String,
        retry_prompt: Option<String>,
        disposition: QuestionDisposition,
    },
    Deferred {
        reason: EvaluationDeferralReason,
        can_retry_same_question: bool,
        disposition: QuestionDisposition,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnOutcome {
    pub schema: String, // exactly "viva.turn_outcome.v1"
    pub response_id: String,
    pub question_id: String,
    pub rubric_policy_version: String,
    pub recorded_at: String, // authoritative RFC3339 UTC
    pub source_ids: Vec<String>,
    pub supersedes_response_id: Option<String>,
    pub resolution: TurnResolution,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TurnOutcomeRecordReceipt {
    pub schema: String, // exactly "viva.turn_outcome_record.v1"
    pub response_id: String,
    pub replayed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PersistedTurnOutcome {
    pub turn_outcome: TurnOutcome,
    pub record: TurnOutcomeRecordReceipt,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeDisposition {
    SourceConfirmed,
    ReevaluationRequired,
    Deferred,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ChallengeResolution {
    pub schema: String, // exactly "viva.challenge_resolution.v1"
    pub correction_id: String,
    pub challenged_response_id: String,
    pub source_id: String,
    pub disposition: ChallengeDisposition,
    pub replacement_response_id: Option<String>,
}
