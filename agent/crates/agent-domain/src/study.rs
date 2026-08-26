use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{learning_outcome::EvaluationRubricV1, ConceptStatus, SourceConfidence};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
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

/// Compile-time proof that a close reason is exactly its wire token with each
/// underscore replaced by a space, so the two strings generated from one
/// declaration can never drift apart.
const fn close_text_matches_wire(wire: &str, close: &str) -> bool {
    let wire = wire.as_bytes();
    let close = close.as_bytes();
    if wire.len() != close.len() {
        return false;
    }
    let mut index = 0;
    while index < wire.len() {
        let expected = if wire[index] == b'_' {
            b' '
        } else {
            wire[index]
        };
        if close[index] != expected {
            return false;
        }
        index += 1;
    }
    true
}

/// The single terminal-reason declaration. One variant list generates the enum,
/// its serde token, [`TerminalSessionReason::ALL`], `as_str`, `close_reason`,
/// and `Display`, so no consumer may keep a second enum or string table.
macro_rules! define_terminal_session_reasons {
    ($( $variant:ident => $wire:literal, $close:literal ),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        pub enum TerminalSessionReason {
            $(#[serde(rename = $wire)] $variant),+
        }

        impl TerminalSessionReason {
            pub const ALL: [Self; define_terminal_session_reasons!(@count $($variant),+)] =
                [$(Self::$variant),+];

            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }

            pub fn close_reason(self) -> &'static str {
                match self {
                    $(Self::$variant => $close),+
                }
            }
        }

        $(const _: () = assert!(close_text_matches_wire($wire, $close));)+
    };
    (@count $($variant:ident),+) => {
        <[()]>::len(&[$(define_terminal_session_reasons!(@one $variant)),+])
    };
    (@one $variant:ident) => { () };
}

define_terminal_session_reasons! {
    Drained => "drained", "drained",
    SessionCap => "session_cap", "session cap",
    TurnCap => "turn_cap", "turn cap",
    RateLimit => "rate_limit", "rate limit",
    CostBudget => "cost_budget", "cost budget",
    ProviderAuthFailed => "provider_auth_failed", "provider auth failed",
    ProviderRateLimited => "provider_rate_limited", "provider rate limited",
    ProviderTimeout => "provider_timeout", "provider timeout",
    ProviderMalformedStream => "provider_malformed_stream", "provider malformed stream",
    ProviderNetworkDisconnect => "provider_network_disconnect", "provider network disconnect",
    SlowClient => "slow_client", "slow client",
    ProviderCancelled => "provider_cancelled", "provider cancelled",
    PartialStageSuccess => "partial_stage_success", "partial stage success",
    DurabilityDegraded => "durability_degraded", "durability degraded",
    ToolExecutorFailure => "tool_executor_failure", "tool executor failure",
    Rollback => "rollback", "rollback",
}

const _: () = assert!(TerminalSessionReason::ALL.len() == 16);

impl fmt::Display for TerminalSessionReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
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

/// One server-owned question.
///
/// `LEARN-002` added `concept_id` and `rubric`: the concept a question is bound
/// to and the criteria an answer is graded against are server facts carried with
/// the question, never values a provider may choose at evaluation time.
/// `expected_terms` remains a retrieval/authoring aid; nothing in the learning
/// authority grades against it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StudyQuestion {
    pub question_id: String,
    pub concept_id: String,
    pub prompt: String,
    pub expected_terms: Vec<String>,
    pub follow_up: String,
    pub rubric: EvaluationRubricV1,
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
        concept_id: "oxidative-phosphorylation".to_owned(),
        prompt: "Explain the role of NADH in oxidative phosphorylation.".to_owned(),
        expected_terms: vec![
            "electron donor".to_owned(),
            "electron transport chain".to_owned(),
            "proton gradient".to_owned(),
            "ATP synthase".to_owned(),
        ],
        follow_up: "Now connect that electron flow to ATP synthase in one precise sentence."
            .to_owned(),
        rubric: fixture_rubric(),
        source: fixture_source_reference(),
    }
}

pub fn fixture_rubric() -> EvaluationRubricV1 {
    EvaluationRubricV1 {
        policy_version: crate::learning_outcome::VIVA_SEMANTIC_RUBRIC_POLICY_VERSION.to_owned(),
        criteria: vec![
            crate::learning_outcome::RubricCriterionV1 {
                criterion_id: "crit-oxphos-donor".to_owned(),
                concept_id: "oxidative-phosphorylation".to_owned(),
                claim: "NADH donates high-energy electrons to the electron transport chain."
                    .to_owned(),
                source_id: "src-lecture-5-slide-18".to_owned(),
                required: true,
            },
            crate::learning_outcome::RubricCriterionV1 {
                criterion_id: "crit-oxphos-gradient".to_owned(),
                concept_id: "oxidative-phosphorylation".to_owned(),
                claim: "Electron flow pumps protons across the inner mitochondrial membrane."
                    .to_owned(),
                source_id: "src-lecture-5-slide-18".to_owned(),
                required: true,
            },
        ],
    }
}
