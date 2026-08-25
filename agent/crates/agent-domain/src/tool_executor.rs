use std::sync::Arc;

use serde_json::{json, Value};

use crate::{
    decide_review_schedule, AnswerAttemptEnvelope, Clock, ConceptStatus, PortError,
    RecapSourceMoment, ReviewOutcomeV1, ReviewScheduleError, SessionConfig, StudyMemoryStore,
    StudyMode, StudyQuestion, StudySessionRecap, StudySourceReference, SystemClock, ToolProposal,
    ToolResult,
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
    clock: Arc<dyn Clock>,
}

impl VivaToolExecutor {
    /// Production composition: the authoritative scheduling instant comes from the
    /// system clock, never from a tool argument.
    pub fn new(store: Arc<dyn StudyMemoryStore>, session: AuthorizedStudySession) -> Self {
        Self::with_clock(store, session, Arc::new(SystemClock))
    }

    /// Test/composition path with an injected clock.
    pub fn with_clock(
        store: Arc<dyn StudyMemoryStore>,
        session: AuthorizedStudySession,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            store,
            session,
            clock,
        }
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
            "schedule_review_item" => self.schedule_review_item(response_id, &proposal).await?,
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
        let evaluation = crate::AnswerEvaluation {
            question_id,
            answer_text,
            label: label_for_status(&concept_status).to_owned(),
            concise_feedback,
            retry_prompt: question.follow_up,
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
        let source_id = string_arg(proposal.arguments(), "source_id")?;
        let correction_id = string_arg(proposal.arguments(), "correction_id")?;
        let source = self.canonical_source(&source_id).await?;
        let provided = source_from_args(proposal.arguments())?;
        if provided != source {
            return Err(ToolExecutionError::InvalidArguments(
                "challenge source tuple does not match deterministic retrieval".to_owned(),
            ));
        }
        Ok(json!({
            "correction_id": correction_id,
            "status": "source_rechecked",
            "source": source,
        }))
    }

    async fn schedule_review_item(
        &self,
        response_id: &str,
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
        // D-01: read the injected clock exactly once for this outcome, then take
        // every other authoritative input from the scoped store context.
        let now = self.clock.now();
        let context = self
            .store
            .review_scheduling_context(
                &self.session.user_id,
                &self.session.study_set_id,
                &concept_id,
            )
            .await?;
        let outcome = ReviewOutcomeV1 {
            status,
            hint_count: optional_count_arg(proposal.arguments(), "hint_count")?,
            miss_count: optional_count_arg(proposal.arguments(), "miss_count")?,
        };
        let decision = decide_review_schedule(now, &outcome, &context)?;
        // The store is the single authority on what is actually scheduled: it owns the
        // per-response replay guard, so on a replayed tool call it keeps the first
        // decision and returns that one. Reporting the locally recomputed decision here
        // would tell the model a due date that is not the one on record.
        let record = self
            .store
            .persist_review_schedule_decision(
                &self.session.user_id,
                &self.session.study_set_id,
                &self.session.voice_session_id,
                response_id,
                &concept_id,
                decision,
            )
            .await?;
        let mut result = record.clone();
        if let Value::Object(fields) = &mut result {
            fields.insert("record".to_owned(), record);
        }
        Ok(result)
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
    #[error("review scheduling error: {0}")]
    ReviewSchedule(#[from] ReviewScheduleError),
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

/// Hint and miss counts are D-01 provenance only: they are recorded when the
/// authorized outcome supplies them, stay `None` when it does not (never zero), and
/// can never move the rating or the scheduled date.
fn optional_count_arg(args: &Value, name: &str) -> Result<Option<u32>, ToolExecutionError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|count| u32::try_from(count).ok())
            .map(Some)
            .ok_or_else(|| {
                ToolExecutionError::InvalidArguments(format!(
                    "`{name}` must be a non-negative whole number when supplied"
                ))
            }),
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

fn source_from_args(args: &Value) -> Result<StudySourceReference, ToolExecutionError> {
    let confidence = match string_arg(args, "confidence")?.as_str() {
        "high" => crate::SourceConfidence::High,
        "medium" => crate::SourceConfidence::Medium,
        "low" => crate::SourceConfidence::Low,
        other => {
            return Err(ToolExecutionError::InvalidArguments(format!(
                "unknown source confidence `{other}`"
            )));
        }
    };
    Ok(StudySourceReference {
        source_id: string_arg(args, "source_id")?,
        document_id: string_arg(args, "document_id")?,
        span: string_arg(args, "span")?,
        excerpt: string_arg(args, "excerpt")?,
        confidence,
        retrieval_reason: string_arg(args, "retrieval_reason")?,
    })
}

fn required<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, ToolExecutionError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolExecutionError::InvalidArguments(format!("missing `{label}`")))
}

#[cfg(test)]
mod review_schedule_tests {
    use super::*;
    use crate::{
        AnswerEvaluation, FixedClock, PersistedFsrsCardV1, ReviewScheduleCapReasonV1,
        ReviewScheduleDecisionV1, ReviewSchedulingContextV1, StudySourceReference,
        VIVA_REVIEW_SCHEDULE_POLICY_ID, VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
    };
    use chrono::{DateTime, Utc};
    use std::sync::Mutex;

    /// Literals copied from `packages/core/src/review-scheduling-conformance-v1.json`
    /// (`new-shaky-hinted-one-miss-no-exam` and `exam-inside-cap-window`). They are
    /// never regenerated from this code's own output.
    const GRADED_AT: &str = "2031-04-05T12:00:00.000Z";
    const SHAKY_DUE_AT: &str = "2031-04-07T12:00:00.000Z";
    const STRONG_DUE_AT: &str = "2031-04-13T12:00:00.000Z";
    const EXAM_INSIDE_WINDOW_AT: &str = "2031-04-09T06:00:00.000Z";
    const EXAM_INSIDE_WINDOW_DUE_AT: &str = "2031-04-08T06:00:00.000Z";

    fn instant(raw: &str) -> DateTime<Utc> {
        crate::parse_utc_instant(raw).expect("test instant parses")
    }

    #[derive(Default)]
    struct RecordingStore {
        exam_at: Option<DateTime<Utc>>,
        card: Mutex<Option<PersistedFsrsCardV1>>,
        decisions: Mutex<Vec<ReviewScheduleDecisionV1>>,
        legacy_due_dates: Mutex<Vec<String>>,
    }

    impl RecordingStore {
        fn with_exam(exam_at: &str) -> Self {
            Self {
                exam_at: Some(instant(exam_at)),
                ..Self::default()
            }
        }

        fn only_decision(&self) -> ReviewScheduleDecisionV1 {
            let decisions = self.decisions.lock().expect("decisions lock");
            assert_eq!(decisions.len(), 1, "exactly one decision must be persisted");
            decisions[0].clone()
        }
    }

    #[async_trait::async_trait]
    impl StudyMemoryStore for RecordingStore {
        async fn record_answer_evaluation(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _response_id: &str,
            _evaluation: AnswerEvaluation,
        ) -> Result<Value, PortError> {
            Ok(json!({}))
        }

        async fn source_reference(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _source_id: &str,
        ) -> Result<Option<StudySourceReference>, PortError> {
            Ok(None)
        }

        async fn study_context(
            &self,
            _user_id: &str,
            _study_set_id: &str,
        ) -> Result<Option<Value>, PortError> {
            Ok(None)
        }

        async fn record_concept_status(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _response_id: &str,
            _concept_id: &str,
            status: ConceptStatus,
        ) -> Result<ConceptStatus, PortError> {
            Ok(status)
        }

        async fn schedule_review_item(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _concept_id: &str,
            due_at: &str,
        ) -> Result<Value, PortError> {
            self.legacy_due_dates
                .lock()
                .expect("legacy lock")
                .push(due_at.to_owned());
            Ok(json!({ "due_at": due_at }))
        }

        async fn record_recap(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _response_id: &str,
            _recap: StudySessionRecap,
        ) -> Result<Value, PortError> {
            Ok(json!({}))
        }

        async fn review_scheduling_context(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _concept_id: &str,
        ) -> Result<ReviewSchedulingContextV1, PortError> {
            Ok(ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: self.exam_at,
                card: self.card.lock().expect("card lock").clone(),
            })
        }

        async fn persist_review_schedule_decision(
            &self,
            _user_id: &str,
            _study_set_id: &str,
            _voice_session_id: &str,
            _response_id: &str,
            concept_id: &str,
            decision: ReviewScheduleDecisionV1,
        ) -> Result<Value, PortError> {
            decision
                .validate()
                .map_err(|error| PortError::adapter("test_store", error.to_string()))?;
            let summary = decision.public_summary(concept_id);
            *self.card.lock().expect("card lock") = Some(decision.card.clone());
            self.decisions
                .lock()
                .expect("decisions lock")
                .push(decision);
            Ok(summary)
        }
    }

    fn session() -> AuthorizedStudySession {
        AuthorizedStudySession {
            user_id: "user-1".to_owned(),
            study_set_id: "biology-midterm".to_owned(),
            voice_session_id: "voice-session-1".to_owned(),
            mode: StudyMode::Quiz,
            active_concepts: vec!["nadh".to_owned()],
        }
    }

    fn executor(store: Arc<RecordingStore>, now: &str) -> VivaToolExecutor {
        VivaToolExecutor::with_clock(store, session(), Arc::new(FixedClock::new(instant(now))))
    }

    fn proposal(status: &str) -> ToolProposal {
        ToolProposal::schedule_review_item("biology-midterm", "voice-session-1", "nadh", status)
    }

    #[tokio::test]
    async fn review_schedule_tool_persists_the_authoritative_decision_not_a_fixed_date() {
        let store = Arc::new(RecordingStore::default());
        let result = executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("shaky"))
            .await
            .expect("schedule_review_item succeeds");

        let decision = store.only_decision();
        assert_eq!(crate::format_rfc3339_millis(decision.due_at), SHAKY_DUE_AT);
        assert_eq!(decision.policy_id, VIVA_REVIEW_SCHEDULE_POLICY_ID);
        assert_eq!(decision.rating, 3);
        assert_eq!(decision.card.reps, 1);
        assert!(store
            .legacy_due_dates
            .lock()
            .expect("legacy lock")
            .is_empty());

        let encoded = serde_json::to_string(&result.result).expect("tool result serializes");
        assert!(!encoded.contains("2026-06-"), "{encoded}");
        assert!(!encoded.contains("stability"), "{encoded}");
        assert!(!encoded.contains("difficulty"), "{encoded}");
        assert_eq!(result.result["due_at"], SHAKY_DUE_AT);
        assert_eq!(result.result["policy_id"], VIVA_REVIEW_SCHEDULE_POLICY_ID);
        assert_eq!(result.result["schema_version"], 1);
    }

    #[tokio::test]
    async fn review_schedule_tool_maps_every_status_to_the_recorded_rating() {
        for (status, rating) in [("missed", 1), ("review", 2), ("shaky", 3), ("strong", 4)] {
            let store = Arc::new(RecordingStore::default());
            executor(Arc::clone(&store), GRADED_AT)
                .execute("response-1", proposal(status))
                .await
                .expect("schedule_review_item succeeds");
            assert_eq!(store.only_decision().rating, rating, "status={status}");
        }
    }

    #[tokio::test]
    async fn review_schedule_tool_uses_the_injected_clock_for_every_outcome() {
        let store = Arc::new(RecordingStore::default());
        executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("strong"))
            .await
            .expect("schedule_review_item succeeds");
        let decision = store.only_decision();
        assert_eq!(
            crate::format_rfc3339_millis(decision.generated_at),
            GRADED_AT
        );
        assert_eq!(crate::format_rfc3339_millis(decision.due_at), STRONG_DUE_AT);
    }

    #[tokio::test]
    async fn review_schedule_tool_advances_a_prior_card_instead_of_restarting_it() {
        let store = Arc::new(RecordingStore::default());
        executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("strong"))
            .await
            .expect("first outcome");
        let first = store.only_decision();

        let second_now = crate::format_rfc3339_millis(first.card.due_at);
        executor(Arc::clone(&store), &second_now)
            .execute("response-2", proposal("strong"))
            .await
            .expect("second outcome");

        let decisions = store.decisions.lock().expect("decisions lock").clone();
        assert_eq!(decisions.len(), 2);
        let second = &decisions[1];
        assert_eq!(second.card.reps, 2);
        assert_eq!(second.card.elapsed_days, first.card.scheduled_days);
        assert!(
            second.card.scheduled_days > first.card.scheduled_days,
            "a second strong review must schedule further out than the first"
        );
    }

    #[tokio::test]
    async fn review_schedule_tool_caps_at_the_recorded_exam_margin() {
        let store = Arc::new(RecordingStore::with_exam(EXAM_INSIDE_WINDOW_AT));
        executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("strong"))
            .await
            .expect("schedule_review_item succeeds");
        let decision = store.only_decision();
        assert_eq!(
            crate::format_rfc3339_millis(decision.due_at),
            EXAM_INSIDE_WINDOW_DUE_AT
        );
        assert_eq!(
            crate::format_rfc3339_millis(decision.uncapped_due_at),
            STRONG_DUE_AT
        );
        assert_eq!(
            decision.cap_reason,
            Some(ReviewScheduleCapReasonV1::ExamMargin)
        );
        assert!(decision.due_at <= decision.exam_at.expect("exam instant"));
    }

    #[tokio::test]
    async fn review_schedule_tool_never_schedules_after_the_exam() {
        for exam_at in [
            "2031-04-05T12:00:01.000Z",
            "2031-04-05T18:30:00.000Z",
            "2031-04-06T12:00:00.000Z",
            "2031-04-13T12:00:00.000Z",
            "2031-09-01T08:00:00.000Z",
        ] {
            let store = Arc::new(RecordingStore::with_exam(exam_at));
            executor(Arc::clone(&store), GRADED_AT)
                .execute("response-1", proposal("strong"))
                .await
                .expect("schedule_review_item succeeds");
            let decision = store.only_decision();
            assert!(
                decision.due_at <= instant(exam_at),
                "exam_at={exam_at} due_at={}",
                decision.due_at
            );
        }
    }

    #[tokio::test]
    async fn review_schedule_tool_fails_closed_for_an_already_past_exam() {
        let store = Arc::new(RecordingStore::with_exam("2031-03-30T09:15:00.000Z"));
        executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal("missed"))
            .await
            .expect("schedule_review_item succeeds");
        let decision = store.only_decision();
        assert_eq!(
            crate::format_rfc3339_millis(decision.due_at),
            "2031-03-30T09:15:00.000Z"
        );
        assert_eq!(
            decision.cap_reason,
            Some(ReviewScheduleCapReasonV1::PastExam)
        );
    }

    #[tokio::test]
    async fn review_schedule_tool_rejects_a_model_supplied_due_at() {
        let store = Arc::new(RecordingStore::default());
        let mut proposal = proposal("strong");
        let arguments = proposal.arguments().clone();
        let Value::Object(mut fields) = arguments else {
            panic!("tool arguments are an object");
        };
        fields.insert(
            "due_at".to_owned(),
            Value::String("2099-01-01T00:00:00Z".to_owned()),
        );
        proposal = ToolProposal::new("schedule_review_item", Value::Object(fields));

        let error = executor(Arc::clone(&store), GRADED_AT)
            .execute("response-1", proposal)
            .await
            .expect_err("model-supplied due_at must be rejected");
        assert!(matches!(error, ToolExecutionError::InvalidArguments(_)));
        assert!(store.decisions.lock().expect("decisions lock").is_empty());
    }

    #[tokio::test]
    async fn review_schedule_tool_records_hint_and_miss_provenance_without_moving_the_date() {
        let plain = Arc::new(RecordingStore::default());
        executor(Arc::clone(&plain), GRADED_AT)
            .execute("response-1", proposal("shaky"))
            .await
            .expect("plain outcome");
        let plain_decision = plain.only_decision();
        assert_eq!(plain_decision.hint_count, None);
        assert_eq!(plain_decision.miss_count, None);

        let annotated = Arc::new(RecordingStore::default());
        let Value::Object(mut fields) = proposal("shaky").arguments().clone() else {
            panic!("tool arguments are an object");
        };
        fields.insert("hint_count".to_owned(), json!(2));
        fields.insert("miss_count".to_owned(), json!(1));
        executor(Arc::clone(&annotated), GRADED_AT)
            .execute(
                "response-1",
                ToolProposal::new("schedule_review_item", Value::Object(fields)),
            )
            .await
            .expect("annotated outcome");
        let annotated_decision = annotated.only_decision();
        assert_eq!(annotated_decision.hint_count, Some(2));
        assert_eq!(annotated_decision.miss_count, Some(1));
        assert_eq!(annotated_decision.rating, plain_decision.rating);
        assert_eq!(annotated_decision.due_at, plain_decision.due_at);
    }

    #[tokio::test]
    async fn review_schedule_tool_rejects_negative_hint_or_miss_provenance() {
        let store = Arc::new(RecordingStore::default());
        let Value::Object(mut fields) = proposal("shaky").arguments().clone() else {
            panic!("tool arguments are an object");
        };
        fields.insert("miss_count".to_owned(), json!(-1));
        let error = executor(Arc::clone(&store), GRADED_AT)
            .execute(
                "response-1",
                ToolProposal::new("schedule_review_item", Value::Object(fields)),
            )
            .await
            .expect_err("negative provenance must be rejected");
        assert!(matches!(error, ToolExecutionError::InvalidArguments(_)));
        assert!(store.decisions.lock().expect("decisions lock").is_empty());
    }
}
