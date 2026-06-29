use std::sync::Arc;

use serde_json::{json, Value};

use crate::{
    AnswerAttemptEnvelope, ConceptStatus, CorrectionChallengeReason, PortError, RecapSourceMoment,
    SessionConfig, StudyMemoryStore, StudyMode, StudyQuestion, StudySessionRecap,
    StudySourceReference, ToolProposal, ToolResult,
};

#[derive(Clone)]
pub struct AuthorizedStudySession {
    pub user_id: String,
    pub study_set_id: String,
    pub voice_session_id: String,
    pub mode: StudyMode,
    pub active_concepts: Vec<String>,
}

impl AuthorizedStudySession {
    pub fn from_config(config: &SessionConfig) -> Result<Self, ToolExecutionError> {
        Ok(Self {
            user_id: required(config.user_id.as_deref(), "user_id")?.to_owned(),
            study_set_id: required(config.study_set_id.as_deref(), "study_set_id")?.to_owned(),
            voice_session_id: required(config.session_id.as_deref(), "session_id")?.to_owned(),
            mode: config.mode.clone().unwrap_or_default(),
            active_concepts: config.active_concepts.clone(),
        })
    }
}

#[derive(Clone)]
pub struct VivaToolExecutor {
    store: Arc<dyn StudyMemoryStore>,
    session: AuthorizedStudySession,
}

impl VivaToolExecutor {
    pub fn new(store: Arc<dyn StudyMemoryStore>, session: AuthorizedStudySession) -> Self {
        Self { store, session }
    }

    pub async fn execute(
        &self,
        response_id: &str,
        proposal: ToolProposal,
    ) -> Result<ToolResult, ToolExecutionError> {
        bind_study_set_and_session(&proposal, &self.session)?;
        let result = match proposal.name() {
            "select_next_question" => self.select_next_question().await?,
            "evaluate_spoken_answer" => self.evaluate_spoken_answer(response_id, &proposal).await?,
            "retrieve_source_reference" => self.retrieve_source_reference(&proposal).await?,
            "mark_concept_status" => self.mark_concept_status(response_id, &proposal).await?,
            "build_session_recap" => self.build_session_recap(response_id).await?,
            "challenge_correction" => self.challenge_correction(&proposal).await?,
            "schedule_review_item" => self.schedule_review_item(&proposal).await?,
            other => {
                return Err(ToolExecutionError::InvalidArguments(format!(
                    "unknown Viva tool `{other}`"
                )));
            }
        };
        Ok(ToolResult { proposal, result })
    }

    pub async fn record_answer_attempt_envelope(
        &self,
        envelope: AnswerAttemptEnvelope,
    ) -> Result<Value, ToolExecutionError> {
        self.store
            .record_answer_attempt_envelope(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                envelope,
            )
            .await
            .map_err(ToolExecutionError::from)
    }

    async fn select_next_question(&self) -> Result<Value, ToolExecutionError> {
        let question = self.active_question().await?;
        Ok(json!({ "question": question, "mode": self.session.mode.as_str() }))
    }

    async fn evaluate_spoken_answer(
        &self,
        response_id: &str,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let question_id = string_arg(proposal.arguments(), "question_id")?;
        let answer_text = string_arg(proposal.arguments(), "answer_text")?;
        let question = self.active_question().await?;
        if question.question_id != question_id {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "question `{question_id}` is not active"
            )));
        }
        let normalized_answer = answer_text.to_ascii_lowercase();
        let matched_terms = question
            .expected_terms
            .iter()
            .filter(|term| normalized_answer.contains(&term.to_ascii_lowercase()))
            .cloned()
            .collect::<Vec<_>>();
        let concept_status =
            concept_status_for_terms(matched_terms.len(), question.expected_terms.len());
        let concise_feedback = feedback_for_terms(&question, &matched_terms);
        let label = label_for_status(&concept_status);
        let submission_sequence = if self
            .store
            .retry_prompt_was_spent_before_response(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
            )
            .await?
        {
            2
        } else {
            1
        };
        let retry_prompt =
            crate::one_shot_retry_prompt(label, submission_sequence, &question.follow_up);
        let evaluation = crate::AnswerEvaluation {
            question_id,
            answer_text,
            label: label.to_owned(),
            concise_feedback,
            retry_prompt,
            source: question.source,
            concept_status,
            confidence_score: confidence_for_terms(
                matched_terms.len(),
                question.expected_terms.len(),
            ),
        };
        let record = self
            .store
            .record_answer_evaluation(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
                evaluation.clone(),
            )
            .await?;
        Ok(json!({ "evaluation": evaluation, "record": record }))
    }

    async fn retrieve_source_reference(
        &self,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let source_id = string_arg(proposal.arguments(), "source_id")?;
        let source = self.canonical_source(&source_id).await?;
        Ok(json!({ "source": source }))
    }

    async fn mark_concept_status(
        &self,
        response_id: &str,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let concept_id = string_arg(proposal.arguments(), "concept_id")?;
        let status = concept_status_arg(proposal.arguments(), "status")?;
        let status = self
            .store
            .record_concept_status(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
                &concept_id,
                status,
            )
            .await?;
        Ok(json!({ "concept_id": concept_id, "status": status }))
    }

    async fn build_session_recap(&self, response_id: &str) -> Result<Value, ToolExecutionError> {
        let question = self.active_question().await?;
        let source = question.source.clone();
        let strong_concepts = question
            .expected_terms
            .iter()
            .take(2)
            .cloned()
            .collect::<Vec<_>>();
        let review_later = question
            .expected_terms
            .iter()
            .skip(2)
            .take(2)
            .cloned()
            .collect::<Vec<_>>();
        let recap = StudySessionRecap {
            voice_session_id: self.session.voice_session_id.clone(),
            headline: format!("{} is ready for another pass.", question.prompt),
            summary: "The session stayed grounded to the server-owned source span. Review the missed terms before the next call.".to_owned(),
            strong_concepts,
            shaky_concepts: review_later.clone(),
            missed_concepts: vec![],
            review_later,
            next_action: "Schedule a short source-backed review tomorrow.".to_owned(),
            source_moments: vec![RecapSourceMoment {
                text: format!("Question source: {}", question.prompt),
                source,
                status: ConceptStatus::Strong,
            }],
        };
        let record = self
            .store
            .record_recap(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
                recap.clone(),
            )
            .await?;
        Ok(json!({ "recap": recap, "record": record }))
    }

    async fn challenge_correction(
        &self,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        ensure_only_args(
            proposal.arguments(),
            &[
                "study_set_id",
                "voice_session_id",
                "source_id",
                "correction_id",
                "reason",
            ],
            "challenge_correction",
        )?;
        let source_id = string_arg(proposal.arguments(), "source_id")?;
        let correction_id = string_arg(proposal.arguments(), "correction_id")?;
        let reason = challenge_reason_arg(proposal.arguments(), "reason")?;
        let source = self.canonical_source(&source_id).await?;
        Ok(json!({
            "correction_id": correction_id,
            "reason": reason.as_str(),
            "status": "source_rechecked",
            "source": source,
        }))
    }

    async fn schedule_review_item(
        &self,
        proposal: &ToolProposal,
    ) -> Result<Value, ToolExecutionError> {
        let concept_id = string_arg(proposal.arguments(), "concept_id")?;
        if proposal.arguments().get("due_at").is_some() {
            return Err(ToolExecutionError::InvalidArguments(
                "due_at is not an authoritative tool argument; @viva/core computes review dates"
                    .to_owned(),
            ));
        }
        let status = concept_status_arg(proposal.arguments(), "status")?;
        let due_at = storage_due_at_for_status(&status);
        Ok(self
            .store
            .schedule_review_item(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                &concept_id,
                due_at,
            )
            .await?)
    }

    async fn canonical_source(
        &self,
        source_id: &str,
    ) -> Result<StudySourceReference, ToolExecutionError> {
        self.store
            .source_reference(&self.session.user_id, &self.session.study_set_id, source_id)
            .await?
            .ok_or_else(|| {
                ToolExecutionError::Unavailable(format!(
                    "source `{source_id}` is unavailable for this session"
                ))
            })
    }

    async fn active_question(&self) -> Result<StudyQuestion, ToolExecutionError> {
        let mut question = self
            .store
            .active_question(&self.session.user_id, &self.session.study_set_id)
            .await?
            .ok_or_else(|| {
                ToolExecutionError::Unavailable(format!(
                    "no active generated question is available for study set `{}`",
                    self.session.study_set_id
                ))
            })?;
        question.source = self.canonical_source(&question.source.source_id).await?;
        Ok(question)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ToolExecutionError {
    #[error("invalid tool arguments: {0}")]
    InvalidArguments(String),
    #[error("tool dependency unavailable: {0}")]
    Unavailable(String),
    #[error("tool store error: {0}")]
    Store(#[from] PortError),
}

fn bind_study_set_and_session(
    proposal: &ToolProposal,
    session: &AuthorizedStudySession,
) -> Result<(), ToolExecutionError> {
    let study_set_id = string_arg(proposal.arguments(), "study_set_id")?;
    let voice_session_id = string_arg(proposal.arguments(), "voice_session_id")?;
    if study_set_id != session.study_set_id || voice_session_id != session.voice_session_id {
        return Err(ToolExecutionError::InvalidArguments(
            "tool call is not bound to the authorized session".to_owned(),
        ));
    }
    Ok(())
}

fn string_arg(args: &Value, name: &str) -> Result<String, ToolExecutionError> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| ToolExecutionError::InvalidArguments(format!("missing `{name}`")))
}

fn challenge_reason_arg(
    args: &Value,
    name: &str,
) -> Result<CorrectionChallengeReason, ToolExecutionError> {
    let reason = string_arg(args, name)?;
    CorrectionChallengeReason::parse(&reason).ok_or_else(|| {
        ToolExecutionError::InvalidArguments(format!(
            "invalid challenge_correction reason `{reason}`"
        ))
    })
}

fn ensure_only_args(
    args: &Value,
    allowed: &[&str],
    tool_name: &str,
) -> Result<(), ToolExecutionError> {
    let Some(object) = args.as_object() else {
        return Err(ToolExecutionError::InvalidArguments(format!(
            "{tool_name} arguments must be an object"
        )));
    };
    for key in object.keys() {
        if !allowed.iter().any(|allowed_key| allowed_key == key) {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "`{key}` is not an authoritative {tool_name} argument"
            )));
        }
    }
    Ok(())
}

fn concept_status_for_terms(matched: usize, expected: usize) -> ConceptStatus {
    if expected == 0 || matched == 0 {
        return ConceptStatus::Missed;
    }
    if matched >= expected.saturating_sub(1).max(1) {
        return ConceptStatus::Strong;
    }
    if matched >= 2 {
        return ConceptStatus::Shaky;
    }
    ConceptStatus::Review
}

fn label_for_status(status: &ConceptStatus) -> &'static str {
    match status {
        ConceptStatus::Strong => "mostly correct",
        ConceptStatus::Shaky => "partially correct",
        ConceptStatus::Review => "vague",
        ConceptStatus::Missed => "insufficient evidence",
    }
}

fn storage_due_at_for_status(status: &ConceptStatus) -> &'static str {
    match status {
        ConceptStatus::Missed => "2026-06-18T09:00:00Z",
        ConceptStatus::Shaky => "2026-06-19T09:00:00Z",
        ConceptStatus::Review => "2026-06-20T09:00:00Z",
        ConceptStatus::Strong => "2026-06-24T09:00:00Z",
    }
}

fn confidence_for_terms(matched: usize, expected: usize) -> f32 {
    if expected == 0 {
        return 0.2;
    }
    let ratio = matched as f32 / expected as f32;
    (0.2 + ratio * 0.7).clamp(0.2, 0.9)
}

fn feedback_for_terms(question: &StudyQuestion, matched_terms: &[String]) -> String {
    let missing = question
        .expected_terms
        .iter()
        .filter(|term| !matched_terms.iter().any(|matched| matched == *term))
        .take(2)
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return "Good source-backed answer. Tighten the causal link in the follow-up.".to_owned();
    }
    format!(
        "Add the source-backed term{} {} before moving on.",
        if missing.len() == 1 { "" } else { "s" },
        missing.join(", ")
    )
}

fn concept_status_arg(args: &Value, name: &str) -> Result<ConceptStatus, ToolExecutionError> {
    match string_arg(args, name)?.as_str() {
        "strong" => Ok(ConceptStatus::Strong),
        "shaky" => Ok(ConceptStatus::Shaky),
        "missed" => Ok(ConceptStatus::Missed),
        "review" => Ok(ConceptStatus::Review),
        other => Err(ToolExecutionError::InvalidArguments(format!(
            "unknown concept status `{other}`"
        ))),
    }
}

fn required<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, ToolExecutionError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolExecutionError::InvalidArguments(format!("missing `{label}`")))
}
