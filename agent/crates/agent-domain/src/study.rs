use serde::{Deserialize, Serialize};

use crate::{ConceptStatus, SourceConfidence};

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudySessionPhase {
    #[default]
    Ready,
    Listening,
    Thinking,
    Feedback,
    Correction,
    Recap,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionReason {
    Drained,
    SessionCap,
    TurnCap,
    RateLimit,
    CostBudget,
}

impl TerminalSessionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drained => "drained",
            Self::SessionCap => "session_cap",
            Self::TurnCap => "turn_cap",
            Self::RateLimit => "rate_limit",
            Self::CostBudget => "cost_budget",
        }
    }

    pub fn close_reason(self) -> &'static str {
        match self {
            Self::Drained => "drained",
            Self::SessionCap => "session cap",
            Self::TurnCap => "turn cap",
            Self::RateLimit => "rate limit",
            Self::CostBudget => "cost budget",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudySourceReference {
    pub source_id: String,
    pub document_id: String,
    pub span: String,
    pub excerpt: String,
    pub confidence: SourceConfidence,
    pub retrieval_reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyQuestion {
    pub question_id: String,
    pub prompt: String,
    pub expected_terms: Vec<String>,
    pub follow_up: String,
    pub source: StudySourceReference,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnswerEvaluation {
    pub question_id: String,
    pub answer_text: String,
    pub label: String,
    pub concise_feedback: String,
    pub retry_prompt: String,
    pub source: StudySourceReference,
    pub concept_status: ConceptStatus,
    pub confidence_score: f32,
}

impl AnswerEvaluation {
    pub fn validate_fail_closed(&self) -> Result<(), &'static str> {
        if self.question_id.trim().is_empty() {
            return Err("answer evaluation is missing question_id");
        }
        if !is_known_evaluation_label(&self.label) {
            return Err("answer evaluation label is not in the typed rubric");
        }
        if !self.confidence_score.is_finite() || !(0.0..=1.0).contains(&self.confidence_score) {
            return Err("answer evaluation confidence_score is outside 0..1");
        }
        if self.answer_text.trim().is_empty() && self.concept_status == ConceptStatus::Strong {
            return Err("empty answer cannot be marked strong");
        }
        Ok(())
    }
}

pub fn is_known_evaluation_label(label: &str) -> bool {
    matches!(
        label,
        "strong"
            | "mostly correct"
            | "partially correct"
            | "vague"
            | "wrong"
            | "off-topic"
            | "insufficient evidence"
    )
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecapSourceMoment {
    pub text: String,
    pub source: StudySourceReference,
    pub status: ConceptStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudySessionRecap {
    pub voice_session_id: String,
    pub headline: String,
    pub summary: String,
    pub strong_concepts: Vec<String>,
    pub shaky_concepts: Vec<String>,
    pub missed_concepts: Vec<String>,
    pub review_later: Vec<String>,
    pub next_action: String,
    pub source_moments: Vec<RecapSourceMoment>,
}

pub fn fixture_source_reference() -> StudySourceReference {
    StudySourceReference {
        source_id: "src-lecture-5-slide-18".to_owned(),
        document_id: "lec-5".to_owned(),
        span: "slide:18".to_owned(),
        excerpt: "NADH donates high-energy electrons to the electron transport chain. Electron flow pumps protons across the inner mitochondrial membrane, creating the gradient that drives ATP synthase.".to_owned(),
        confidence: SourceConfidence::High,
        retrieval_reason: "server fixture source for oxidative phosphorylation".to_owned(),
    }
}

pub fn fixture_question() -> StudyQuestion {
    StudyQuestion {
        question_id: "q-oxidative-phosphorylation-nadh".to_owned(),
        prompt: "Explain the role of NADH in oxidative phosphorylation.".to_owned(),
        expected_terms: vec![
            "electron donor".to_owned(),
            "electron transport chain".to_owned(),
            "proton gradient".to_owned(),
            "ATP synthase".to_owned(),
        ],
        follow_up: "Now connect that electron flow to ATP synthase in one precise sentence."
            .to_owned(),
        source: fixture_source_reference(),
    }
}
