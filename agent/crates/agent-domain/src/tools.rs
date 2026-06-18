use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    ids::{CallId, ToolName},
    StudySourceReference,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ToolProposal {
    name: ToolName,
    arguments: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    call_id: Option<CallId>,
}

impl ToolProposal {
    pub fn new(name: impl Into<String>, arguments: Value) -> Self {
        Self {
            name: ToolName::new(name),
            arguments,
            call_id: None,
        }
    }

    pub fn select_next_question(
        study_set_id: impl Into<String>,
        voice_session_id: impl Into<String>,
        mode: impl Into<String>,
    ) -> Self {
        Self::new(
            "select_next_question",
            json!({
                "study_set_id": study_set_id.into(),
                "voice_session_id": voice_session_id.into(),
                "mode": mode.into(),
            }),
        )
    }

    pub fn evaluate_spoken_answer(
        study_set_id: impl Into<String>,
        voice_session_id: impl Into<String>,
        question_id: impl Into<String>,
        answer_text: impl Into<String>,
    ) -> Self {
        Self::new(
            "evaluate_spoken_answer",
            json!({
                "study_set_id": study_set_id.into(),
                "voice_session_id": voice_session_id.into(),
                "question_id": question_id.into(),
                "answer_text": answer_text.into(),
            }),
        )
    }

    pub fn retrieve_source_reference(
        study_set_id: impl Into<String>,
        voice_session_id: impl Into<String>,
        source_id: impl Into<String>,
    ) -> Self {
        Self::new(
            "retrieve_source_reference",
            json!({
                "study_set_id": study_set_id.into(),
                "voice_session_id": voice_session_id.into(),
                "source_id": source_id.into(),
            }),
        )
    }

    pub fn mark_concept_status(
        study_set_id: impl Into<String>,
        voice_session_id: impl Into<String>,
        concept_id: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        Self::new(
            "mark_concept_status",
            json!({
                "study_set_id": study_set_id.into(),
                "voice_session_id": voice_session_id.into(),
                "concept_id": concept_id.into(),
                "status": status.into(),
            }),
        )
    }

    pub fn build_session_recap(
        study_set_id: impl Into<String>,
        voice_session_id: impl Into<String>,
    ) -> Self {
        Self::new(
            "build_session_recap",
            json!({
                "study_set_id": study_set_id.into(),
                "voice_session_id": voice_session_id.into(),
            }),
        )
    }

    pub fn challenge_correction(
        study_set_id: impl Into<String>,
        voice_session_id: impl Into<String>,
        source: &StudySourceReference,
        correction_id: impl Into<String>,
        challenge_text: impl Into<String>,
    ) -> Self {
        Self::new(
            "challenge_correction",
            json!({
                "study_set_id": study_set_id.into(),
                "voice_session_id": voice_session_id.into(),
                "source_id": &source.source_id,
                "document_id": &source.document_id,
                "span": &source.span,
                "excerpt": &source.excerpt,
                "confidence": &source.confidence,
                "retrieval_reason": &source.retrieval_reason,
                "correction_id": correction_id.into(),
                "challenge_text": challenge_text.into(),
            }),
        )
    }

    pub fn schedule_review_item(
        study_set_id: impl Into<String>,
        voice_session_id: impl Into<String>,
        concept_id: impl Into<String>,
        due_at: impl Into<String>,
    ) -> Self {
        Self::new(
            "schedule_review_item",
            json!({
                "study_set_id": study_set_id.into(),
                "voice_session_id": voice_session_id.into(),
                "concept_id": concept_id.into(),
                "due_at": due_at.into(),
            }),
        )
    }

    pub fn name(&self) -> &str {
        self.name.as_str()
    }

    pub fn arguments(&self) -> &Value {
        &self.arguments
    }

    pub fn with_call_id(mut self, call_id: impl Into<String>) -> Self {
        self.call_id = Some(CallId::new(call_id));
        self
    }

    pub fn call_id(&self) -> Option<&str> {
        self.call_id.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub proposal: ToolProposal,
    pub result: Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ToolPlan {
    pub goal: String,
    pub steps: Vec<ToolProposal>,
}
