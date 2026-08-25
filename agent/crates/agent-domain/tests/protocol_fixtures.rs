use std::collections::BTreeMap;

use agent_domain::{
    fixture_source_reference, AudioFrame, AuthenticatedStudyProjectionV1, BrainEvent,
    ChallengeResolution, EvaluationDeferralReason, EvaluationLabel, EvaluationRubricV1,
    PersistedTurnOutcome, ProgressionPolicyId, QuestionProgressionCursor,
    QuestionProgressionResult, SessionConfig, SessionLearningEvidence, SourceConfidence,
    SourceContext, StudyMode, StudyQuestion, ToolProposal, TurnOutcome, TurnResolution,
};
use agent_domain::{
    learning_outcome::{
        VIVA_CHALLENGE_RESOLUTION_SCHEMA, VIVA_SEMANTIC_RUBRIC_POLICY_VERSION,
        VIVA_TURN_OUTCOME_RECORD_SCHEMA, VIVA_TURN_OUTCOME_SCHEMA,
    },
    learning_recap::{StudySessionRecap, VIVA_STUDY_SESSION_RECAP_SCHEMA},
};
use serde::Deserialize;
use serde_json::{json, Value};

const TURN_OUTCOMES_FIXTURE: &str =
    include_str!("../../../fixtures/learning-core/turn-outcomes-v1.json");
const RECAPS_FIXTURE: &str = include_str!("../../../fixtures/learning-core/recaps-v1.json");
const QUESTION_PROGRESSION_FIXTURE: &str =
    include_str!("../../../fixtures/learning-core/question-progression-v1.json");
const STUDY_PROJECTION_FIXTURE: &str =
    include_str!("../../../fixtures/learning-core/study-projection-v1.json");

/// Fixture envelopes are the *file* shape, not a mirror of any Plan 04 type: every
/// learner value inside them is parsed by the authoritative Plan 04 declaration.
/// `deny_unknown_fields` makes each envelope reject an injected key so the negative
/// controls below observe a real rejection rather than a silently ignored field.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TurnOutcomesFixture {
    schema: String,
    rubric: EvaluationRubricV1,
    outcomes: BTreeMap<String, TurnOutcome>,
    persisted: BTreeMap<String, PersistedTurnOutcome>,
    challenges: BTreeMap<String, ChallengeResolution>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecapsFixture {
    schema: String,
    evidence: BTreeMap<String, SessionLearningEvidence>,
    recaps: BTreeMap<String, StudySessionRecap>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QuestionProgressionFixture {
    schema: String,
    policy: ProgressionPolicyId,
    voice_session_id: String,
    active_question_ids: Vec<String>,
    inactive_question_ids: Vec<String>,
    questions: BTreeMap<String, StudyQuestion>,
    cursors: BTreeMap<String, QuestionProgressionCursor>,
    results: BTreeMap<String, QuestionProgressionResult>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StudyProjectionFixture {
    schema: String,
    projections: BTreeMap<String, AuthenticatedStudyProjectionV1>,
}

fn fixture_value(raw: &str) -> Value {
    serde_json::from_str(raw).expect("learning-core fixture is valid JSON")
}

#[test]
fn protocol_fixtures_preserve_source_grounded_shapes() {
    let source = SourceContext {
        source_id: "source:lecture-5-slide-18".to_owned(),
        document_id: "doc:lecture-5".to_owned(),
        span: "slide=18".to_owned(),
        excerpt: "NADH donates high-energy electrons.".to_owned(),
        confidence: SourceConfidence::High,
        retrieval_reason: "direct concept overlap".to_owned(),
    };
    let proposal = ToolProposal::evaluate_spoken_answer(
        "biology-midterm",
        "voice-session-1",
        "q-oxidative-phosphorylation-nadh",
        "NADH gives electrons to the transport chain.",
    )
    .with_call_id("call-eval-1");

    assert_eq!(source.confidence, SourceConfidence::High);
    assert_eq!(proposal.name(), "evaluate_spoken_answer");
    assert_eq!(
        proposal.arguments()["answer_text"],
        "NADH gives electrons to the transport chain."
    );
}

#[test]
fn challenge_correction_carries_full_source_tuple() {
    let source = fixture_source_reference();
    let proposal = ToolProposal::challenge_correction(
        "biology-midterm",
        "voice-session-1",
        &source,
        "correction-1",
        "The slide says this differently.",
    );

    assert_eq!(proposal.arguments()["source_id"], "src-lecture-5-slide-18");
    assert_eq!(proposal.arguments()["document_id"], "lec-5");
    assert_eq!(proposal.arguments()["span"], "slide:18");
    assert_eq!(proposal.arguments()["confidence"], "high");
    assert_eq!(
        proposal.arguments()["retrieval_reason"],
        "server fixture source for oxidative phosphorylation"
    );
}

#[test]
fn shared_session_config_fixture_matches_rust_domain_types() {
    let config: SessionConfig = serde_json::from_str(include_str!(
        "../../../fixtures/voice-protocol/session-config.json"
    ))
    .expect("shared session config fixture is valid");

    assert_eq!(config.mode, Some(StudyMode::Quiz));
    assert_eq!(config.source_context[0].confidence, SourceConfidence::High);
}

#[test]
fn shared_turn_outcomes() {
    let fixture: TurnOutcomesFixture =
        serde_json::from_str(TURN_OUTCOMES_FIXTURE).expect("turn outcomes fixture parses");

    assert_eq!(fixture.schema, "viva.learning_core.turn_outcomes.v1");
    assert_eq!(
        fixture.rubric.policy_version,
        VIVA_SEMANTIC_RUBRIC_POLICY_VERSION
    );
    assert!(!fixture.rubric.criteria.is_empty());
    assert!(!fixture.outcomes.is_empty());
    assert!(!fixture.persisted.is_empty());
    assert!(!fixture.challenges.is_empty());

    let mut evaluated = 0_usize;
    let mut deferred = 0_usize;
    for (case, outcome) in &fixture.outcomes {
        assert_eq!(
            outcome.schema, VIVA_TURN_OUTCOME_SCHEMA,
            "outcome {case} must carry the authoritative turn-outcome schema",
        );
        assert_eq!(
            outcome.rubric_policy_version, VIVA_SEMANTIC_RUBRIC_POLICY_VERSION,
            "outcome {case} must be paired with the literal rubric policy",
        );
        match &outcome.resolution {
            TurnResolution::Evaluated { label, .. } => {
                evaluated += 1;
                // Every evaluated label is the Plan 04 enum, and round-trips through
                // exactly the six locked wire tokens — never a free string.
                let token = serde_json::to_value(label).expect("label serializes");
                let token = token.as_str().expect("label is a JSON string").to_owned();
                assert!(
                    matches!(
                        token.as_str(),
                        "strong"
                            | "mostly_correct"
                            | "partially_correct"
                            | "vague"
                            | "wrong"
                            | "insufficient_evidence"
                    ),
                    "outcome {case} label {token} is outside the locked rubric vocabulary",
                );
                let round_tripped: EvaluationLabel =
                    serde_json::from_value(Value::String(token.clone()))
                        .expect("label round-trips through EvaluationLabel");
                assert_eq!(
                    round_tripped, *label,
                    "outcome {case} label must round-trip"
                );
            }
            TurnResolution::Deferred { .. } => deferred += 1,
        }
    }
    assert!(evaluated > 0, "fixture must pin evaluated resolutions");
    assert!(deferred > 0, "fixture must pin deferred resolutions");

    for (case, persisted) in &fixture.persisted {
        assert_eq!(
            persisted.record.schema, VIVA_TURN_OUTCOME_RECORD_SCHEMA,
            "persisted case {case} must carry the record receipt schema",
        );
        assert_eq!(
            persisted.record.response_id, persisted.turn_outcome.response_id,
            "persisted case {case} receipt must copy the validated outcome response id",
        );
    }
    assert!(
        fixture
            .persisted
            .values()
            .any(|persisted| persisted.record.replayed),
        "fixture must pin an idempotent replay receipt",
    );

    for (case, challenge) in &fixture.challenges {
        assert_eq!(
            challenge.schema, VIVA_CHALLENGE_RESOLUTION_SCHEMA,
            "challenge case {case} must carry the challenge-resolution schema",
        );
    }
}

#[test]
fn shared_turn_outcomes_rejects_injected_unknown_key() {
    let mut value = fixture_value(TURN_OUTCOMES_FIXTURE);
    value
        .as_object_mut()
        .expect("turn outcomes fixture is an object")
        .insert("injected_unknown".to_owned(), json!(true));

    serde_json::from_value::<TurnOutcomesFixture>(value)
        .expect_err("an unknown envelope key must be rejected, not ignored");
}

#[test]
fn shared_turn_outcomes_rejects_unknown_resolution_discriminator() {
    let mut value = fixture_value(TURN_OUTCOMES_FIXTURE);
    value["outcomes"]["evaluated_strong"]["resolution"]["kind"] = json!("fabricated_mastery");

    serde_json::from_value::<TurnOutcomesFixture>(value)
        .expect_err("an unknown turn-resolution discriminator must be rejected");
}

#[test]
fn shared_turn_outcomes_rejects_unknown_evaluation_label() {
    let mut value = fixture_value(TURN_OUTCOMES_FIXTURE);
    value["outcomes"]["evaluated_strong"]["resolution"]["label"] = json!("brilliant");

    serde_json::from_value::<TurnOutcomesFixture>(value)
        .expect_err("a label outside the locked rubric vocabulary must be rejected");
}

#[test]
fn shared_recaps() {
    let fixture: RecapsFixture =
        serde_json::from_str(RECAPS_FIXTURE).expect("recaps fixture parses");

    assert_eq!(fixture.schema, "viva.learning_core.recaps.v1");
    assert!(!fixture.evidence.is_empty());
    assert_eq!(
        fixture.evidence.keys().collect::<Vec<_>>(),
        fixture.recaps.keys().collect::<Vec<_>>(),
        "every evidence case must have exactly one expected recap",
    );

    for (case, recap) in &fixture.recaps {
        assert_eq!(
            recap.schema, VIVA_STUDY_SESSION_RECAP_SCHEMA,
            "recap {case} must carry the authoritative recap schema",
        );
        let evidence = &fixture.evidence[case];
        assert_eq!(
            recap.voice_session_id, evidence.voice_session_id,
            "recap {case} must project its own session's evidence",
        );
    }

    for (case, evidence) in &fixture.evidence {
        for outcome in &evidence.outcomes {
            assert_eq!(
                outcome.schema, VIVA_TURN_OUTCOME_SCHEMA,
                "evidence {case} must carry authoritative turn outcomes",
            );
        }
    }
}

#[test]
fn shared_recaps_rejects_injected_unknown_key() {
    let mut value = fixture_value(RECAPS_FIXTURE);
    value
        .as_object_mut()
        .expect("recaps fixture is an object")
        .insert("injected_unknown".to_owned(), json!({ "due_at": "now" }));

    serde_json::from_value::<RecapsFixture>(value)
        .expect_err("an unknown envelope key must be rejected, not ignored");
}

/// Plan 06 Task 0 Step 3: the crate root publishes exactly one recap, and it is
/// Plan 04's evidence-derived recap — not the superseded bucket-array shape.
///
/// A consumer that writes `agent_domain::StudySessionRecap` must land on the type
/// the domain actually builds and persists. The superseded shape is still
/// declared while Plans 07/08/09 migrate their call sites, but only under its own
/// `StudySessionRecapV1` name, so one root name can never mean two recaps.
#[test]
fn crate_root_recap_is_the_evidence_derived_recap() {
    // Compiles only while the root name and Plan 04's declaration are one type.
    const _ROOT_IS_THE_LEARNING_RECAP: fn(
        agent_domain::learning_recap::StudySessionRecap,
    ) -> agent_domain::StudySessionRecap = |recap| recap;

    // ...and the superseded shape is a genuinely different type behind a name
    // that says which version it is.
    assert_ne!(
        std::any::TypeId::of::<agent_domain::StudySessionRecap>(),
        std::any::TypeId::of::<agent_domain::StudySessionRecapV1>(),
        "the two recap versions must not collapse into one type",
    );

    // The root path parses the canonical wire recap and reports the v2 schema.
    let value = fixture_value(RECAPS_FIXTURE);
    let raw = value["recaps"]["all_missed"].clone();
    let recap: agent_domain::StudySessionRecap =
        serde_json::from_value(raw).expect("the canonical recap parses through the root name");

    assert_eq!(recap.schema, VIVA_STUDY_SESSION_RECAP_SCHEMA);
    assert!(
        !recap.concepts.is_empty(),
        "the evidence-derived recap carries per-concept outcomes, not bucket arrays",
    );
}

/// Plan 06 Task 0 Step 3: the crate root republishes the locked `learning_recap`
/// block **entire**, so Plans 04/05/07/08/09 read one published path per name.
///
/// The recap type alone is not the seam: a consumer that can name the recap but
/// not the fold that produces it has to reach around `agent_domain::` into the
/// module path to build one, which is exactly the drift Step 3 locks the block to
/// prevent. Naming each entry through `agent_domain::` turns an omission from the
/// block into a compile error, and folding one canonical case through the root
/// path proves the published name is Plan 04's declaration and not a stub.
#[test]
fn crate_root_publishes_the_locked_learning_recap_seam() {
    // Task 0 Step 3's locked block, one crate-root path per exported name.
    const _BUILD_SESSION_RECAP: fn(
        &agent_domain::SessionLearningEvidence,
    ) -> Result<
        agent_domain::StudySessionRecap,
        agent_domain::RecapBuildError,
    > = agent_domain::build_session_recap;
    const _CONCEPT_LABEL: fn(agent_domain::ConceptLabel) -> agent_domain::ConceptLabel =
        |value| value;
    const _RECAP_CONCEPT_OUTCOME: fn(
        agent_domain::RecapConceptOutcome,
    ) -> agent_domain::RecapConceptOutcome = |value| value;
    const _REVIEW_SCHEDULE_AUTHORITY: fn(
        agent_domain::ReviewScheduleAuthority,
    ) -> agent_domain::ReviewScheduleAuthority = |value| value;
    const _REVIEW_SCHEDULE_SUMMARY: fn(
        agent_domain::ReviewScheduleSummary,
    ) -> agent_domain::ReviewScheduleSummary = |value| value;

    // The root-path fold is the authoritative one: Plan 04 owns full fold coverage
    // in `tests/learning_core.rs`; this pins that the published path reaches it.
    let fixture: RecapsFixture =
        serde_json::from_str(RECAPS_FIXTURE).expect("recaps fixture parses");
    let evidence = &fixture.evidence["mixed_strong_shaky_missed"];
    let built = agent_domain::build_session_recap(evidence)
        .expect("canonical evidence folds through the crate-root path");

    assert_eq!(
        built, fixture.recaps["mixed_strong_shaky_missed"],
        "the crate-root fold must produce the canonical recap, not a substitute",
    );
}

#[test]
fn shared_recaps_rejects_unknown_review_authority() {
    let mut value = fixture_value(RECAPS_FIXTURE);
    value["recaps"]["all_missed"]["review_schedule"][0]["authority"] = json!("client_guessed");

    serde_json::from_value::<RecapsFixture>(value)
        .expect_err("a review-schedule authority outside D-01 must be rejected");
}

#[test]
fn shared_question_progression() {
    let fixture: QuestionProgressionFixture = serde_json::from_str(QUESTION_PROGRESSION_FIXTURE)
        .expect("question progression fixture parses");

    assert_eq!(fixture.schema, "viva.learning_core.question_progression.v1");
    // D-02B: ordered progression is the selected policy.
    assert_eq!(fixture.policy, ProgressionPolicyId::OrderedV1);
    assert!(!fixture.voice_session_id.is_empty());
    assert!(!fixture.active_question_ids.is_empty());
    assert!(!fixture.inactive_question_ids.is_empty());

    for question_id in &fixture.active_question_ids {
        assert!(
            fixture.questions.contains_key(question_id),
            "active question {question_id} must be declared in the fixture",
        );
    }
    for cursor in fixture.cursors.values() {
        assert_eq!(cursor.policy, ProgressionPolicyId::OrderedV1);
    }

    let mut selected = 0_usize;
    let mut retried = 0_usize;
    let mut exhausted = 0_usize;
    for (case, result) in &fixture.results {
        match result {
            QuestionProgressionResult::Selected {
                question, total, ..
            } => {
                selected += 1;
                assert_eq!(
                    *total as usize,
                    fixture.active_question_ids.len(),
                    "case {case} must count only active questions",
                );
                assert!(fixture.questions.contains_key(&question.question_id));
            }
            QuestionProgressionResult::Retry {
                question, attempt, ..
            } => {
                retried += 1;
                assert!(*attempt > 1, "case {case} retry must report attempt > 1");
                assert!(fixture.questions.contains_key(&question.question_id));
            }
            QuestionProgressionResult::Exhausted {
                completed, total, ..
            } => {
                exhausted += 1;
                assert_eq!(
                    completed, total,
                    "case {case} exhaustion means every active question is completed",
                );
            }
        }
    }
    assert!(selected > 0 && retried > 0 && exhausted > 0);
}

#[test]
fn shared_question_progression_rejects_injected_unknown_key() {
    let mut value = fixture_value(QUESTION_PROGRESSION_FIXTURE);
    value
        .as_object_mut()
        .expect("question progression fixture is an object")
        .insert("injected_unknown".to_owned(), json!("adaptive"));

    serde_json::from_value::<QuestionProgressionFixture>(value)
        .expect_err("an unknown envelope key must be rejected, not ignored");
}

#[test]
fn shared_question_progression_rejects_unknown_result_discriminator() {
    let mut value = fixture_value(QUESTION_PROGRESSION_FIXTURE);
    value["results"]["exhausted_emits_no_question"]["result"] = json!("fabricated_question");

    serde_json::from_value::<QuestionProgressionFixture>(value)
        .expect_err("an unknown progression result discriminator must be rejected");
}

#[test]
fn shared_study_projection() {
    let fixture: StudyProjectionFixture =
        serde_json::from_str(STUDY_PROJECTION_FIXTURE).expect("study projection fixture parses");

    assert_eq!(fixture.schema, "viva.learning_core.study_projection.v1");
    assert!(!fixture.projections.is_empty());

    for (case, projection) in &fixture.projections {
        let rendered = serde_json::to_value(projection).expect("projection serializes");
        assert_eq!(
            rendered["version"],
            json!(1),
            "projection {case} must pin the literal version 1",
        );
        for item in &projection.review_schedule {
            assert!(
                projection
                    .concepts
                    .iter()
                    .any(|concept| concept.id == item.concept_id),
                "projection {case} schedules a concept it does not include",
            );
        }
        if let Some(question) = &projection.active_question {
            assert!(
                projection
                    .concepts
                    .iter()
                    .any(|concept| concept.id == question.concept_id),
                "projection {case} active question references an excluded concept",
            );
        }
    }
}

#[test]
fn shared_study_projection_rejects_injected_unknown_key() {
    let mut value = fixture_value(STUDY_PROJECTION_FIXTURE);
    value
        .as_object_mut()
        .expect("study projection fixture is an object")
        .insert("injected_unknown".to_owned(), json!(1));

    serde_json::from_value::<StudyProjectionFixture>(value)
        .expect_err("an unknown envelope key must be rejected, not ignored");
}

#[test]
fn shared_study_projection_rejects_unpinned_version() {
    let mut value = fixture_value(STUDY_PROJECTION_FIXTURE);
    value["projections"]["ready_session_with_active_question"]["version"] = json!(2);

    serde_json::from_value::<StudyProjectionFixture>(value)
        .expect_err("a projection version other than 1 must fail closed");
}

/// Two PCM16 samples. Plan 06 Task 5 (`DOMAIN-007`) deleted the text-as-PCM
/// constructor, so audio fixtures name their bytes explicitly and can never be an
/// odd-length buffer that only looks like audio.
const PCM16_FIXTURE_BYTES: [u8; 4] = [0x00, 0x01, 0xff, 0xfe];

#[test]
fn audio_frame_serializes_to_base64_contract() {
    let frame = AudioFrame::from_pcm16_bytes(PCM16_FIXTURE_BYTES.to_vec());
    let value = serde_json::to_value(&frame).expect("audio frame serializes");

    assert_eq!(value, json!({ "pcm16_base64": "AAH//g==" }));
    let decoded: AudioFrame = serde_json::from_value(value).expect("audio frame deserializes");
    assert_eq!(decoded.pcm16_bytes(), PCM16_FIXTURE_BYTES);
}

#[test]
fn brain_events_carry_response_ids_for_stale_suppression() {
    let event = BrainEvent::ResponseAudio {
        response_id: "response-1".to_owned(),
        frame: AudioFrame::from_pcm16_bytes(PCM16_FIXTURE_BYTES.to_vec()),
    };

    assert_eq!(event.response_id(), Some("response-1"));
}

#[test]
fn turn_deferred_is_a_typed_non_mastery_event() {
    let event = BrainEvent::TurnDeferred {
        response_id: "response-deferred-1".to_owned(),
        question_id: "q-etc-electron-flow".to_owned(),
        reason: EvaluationDeferralReason::EvaluatorUnavailable,
        can_retry_same_question: true,
    };

    assert_eq!(event.response_id(), Some("response-deferred-1"));

    let rendered = serde_json::to_value(&event).expect("turn deferred event serializes");
    let payload = rendered["TurnDeferred"]
        .as_object()
        .expect("turn deferred payload is an object");
    let mut fields = payload.keys().cloned().collect::<Vec<_>>();
    fields.sort();
    assert_eq!(
        fields,
        vec![
            "can_retry_same_question".to_owned(),
            "question_id".to_owned(),
            "reason".to_owned(),
            "response_id".to_owned(),
        ],
        "TurnDeferred carries no evaluation, concept status, schedule, recap, provider prose, or generic payload",
    );
    assert_eq!(payload["reason"], json!("evaluator_unavailable"));
    assert_eq!(payload["can_retry_same_question"], json!(true));
}
