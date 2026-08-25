//! D-01 `SERVER_PERSISTED_FSRS` conformance against the shared literal fixture.
//!
//! The fixture is the exact same bytes `packages/core` parses. It was derived
//! from py-fsrs 6.3.2 in a disposable environment (artifact digests are recorded
//! inside the fixture and in `docs/decisions/2026-08-23-d-01-review-scheduling-authority.md`)
//! and every literal was re-checked against the published FSRS-6 equations.
//!
//! No expected timestamp, interval, or memory-state value is written in this
//! file: every expectation is read from the JSON. If the pinned Rust crate ever
//! disagrees with a literal, D-01 is amended — the literal is never tuned.

use agent_domain::{
    decide_review_schedule, Clock, ConceptStatus, FixedClock, PersistedFsrsCardV1, ReviewOutcomeV1,
    ReviewScheduleDecisionV1, ReviewSchedulingContextV1, VIVA_REVIEW_EXAM_MARGIN_SECONDS,
    VIVA_REVIEW_SCHEDULE_POLICY_ID, VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

const FIXTURE_JSON: &str =
    include_str!("../../../../packages/core/src/review-scheduling-conformance-v1.json");

#[derive(Debug, Deserialize)]
struct Fixture {
    schema_version: u8,
    selected_authority: String,
    policy_id: String,
    fsrs: FixtureFsrs,
    status_ratings: BTreeMap<String, u8>,
    exam_margin_seconds: u64,
    memory_state_tolerance: FixtureTolerance,
    oracle: FixtureOracle,
    cases: Vec<FixtureCase>,
}

#[derive(Debug, Deserialize)]
struct FixtureFsrs {
    algorithm: String,
    parameters: Vec<f64>,
    desired_retention: f64,
    maximum_interval_days: u32,
    enable_fuzzing: bool,
    learning_steps: Vec<u64>,
    relearning_steps: Vec<u64>,
}

#[derive(Debug, Deserialize)]
struct FixtureTolerance {
    absolute: f64,
    relative: f64,
}

#[derive(Debug, Deserialize)]
struct FixtureOracle {
    pypi_package: String,
    version: String,
}

#[derive(Debug, Deserialize)]
struct FixtureCase {
    case_id: String,
    input: FixtureInput,
    expected: FixtureExpected,
}

#[derive(Debug, Deserialize)]
struct FixtureInput {
    graded_at: DateTime<Utc>,
    status: ConceptStatus,
    hint_count: Option<u32>,
    miss_count: Option<u32>,
    exam_at: Option<DateTime<Utc>>,
    prior_card: Option<PersistedFsrsCardV1>,
}

#[derive(Debug, Deserialize)]
struct FixtureExpected {
    decision: ReviewScheduleDecisionV1,
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE_JSON).expect("conformance fixture must parse fail-closed")
}

fn close_enough(tolerance: &FixtureTolerance, actual: f64, expected: f64) -> bool {
    (actual - expected).abs() <= tolerance.absolute + tolerance.relative * expected.abs()
}

fn assert_card_matches(
    case_id: &str,
    tolerance: &FixtureTolerance,
    actual: &PersistedFsrsCardV1,
    expected: &PersistedFsrsCardV1,
) {
    assert_eq!(
        actual.schema_version, expected.schema_version,
        "{case_id}: card schema_version"
    );
    assert_eq!(actual.due_at, expected.due_at, "{case_id}: card due_at");
    assert_eq!(
        actual.elapsed_days, expected.elapsed_days,
        "{case_id}: elapsed_days"
    );
    assert_eq!(
        actual.scheduled_days, expected.scheduled_days,
        "{case_id}: scheduled_days"
    );
    assert_eq!(actual.reps, expected.reps, "{case_id}: reps");
    assert_eq!(actual.lapses, expected.lapses, "{case_id}: lapses");
    assert_eq!(actual.state, expected.state, "{case_id}: state");
    assert_eq!(
        actual.last_review_at, expected.last_review_at,
        "{case_id}: last_review_at"
    );
    assert!(
        close_enough(tolerance, actual.stability, expected.stability),
        "{case_id}: stability {} is outside the recorded reconciliation bound around {}",
        actual.stability,
        expected.stability
    );
    assert!(
        close_enough(tolerance, actual.difficulty, expected.difficulty),
        "{case_id}: difficulty {} is outside the recorded reconciliation bound around {}",
        actual.difficulty,
        expected.difficulty
    );
}

fn assert_decision_matches(
    case_id: &str,
    tolerance: &FixtureTolerance,
    actual: &ReviewScheduleDecisionV1,
    expected: &ReviewScheduleDecisionV1,
) {
    assert_eq!(
        actual.schema_version, expected.schema_version,
        "{case_id}: schema_version"
    );
    assert_eq!(actual.policy_id, expected.policy_id, "{case_id}: policy_id");
    assert_eq!(
        actual.generated_at, expected.generated_at,
        "{case_id}: generated_at"
    );
    assert_eq!(actual.status, expected.status, "{case_id}: status");
    assert_eq!(actual.rating, expected.rating, "{case_id}: rating");
    assert_eq!(
        actual.hint_count, expected.hint_count,
        "{case_id}: hint_count"
    );
    assert_eq!(
        actual.miss_count, expected.miss_count,
        "{case_id}: miss_count"
    );
    assert_eq!(actual.exam_at, expected.exam_at, "{case_id}: exam_at");
    assert_eq!(
        actual.exam_margin_seconds, expected.exam_margin_seconds,
        "{case_id}: exam_margin_seconds"
    );
    assert_eq!(
        actual.uncapped_due_at, expected.uncapped_due_at,
        "{case_id}: uncapped_due_at"
    );
    assert_eq!(actual.due_at, expected.due_at, "{case_id}: due_at");
    assert_eq!(
        actual.cap_reason, expected.cap_reason,
        "{case_id}: cap_reason"
    );
    assert_card_matches(case_id, tolerance, &actual.card, &expected.card);
}

#[test]
fn fixture_pins_the_selected_d01_authority_and_oracle() {
    let fixture = fixture();
    assert_eq!(fixture.schema_version, VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION);
    assert_eq!(fixture.selected_authority, "SERVER_PERSISTED_FSRS");
    assert_eq!(fixture.policy_id, VIVA_REVIEW_SCHEDULE_POLICY_ID);
    assert_eq!(fixture.exam_margin_seconds, VIVA_REVIEW_EXAM_MARGIN_SECONDS);
    assert_eq!(fixture.fsrs.algorithm, "FSRS-6");
    assert_eq!(fixture.fsrs.parameters.len(), 21);
    assert_eq!(fixture.fsrs.desired_retention, 0.9);
    assert_eq!(fixture.fsrs.maximum_interval_days, 36_500);
    assert!(!fixture.fsrs.enable_fuzzing);
    assert!(fixture.fsrs.learning_steps.is_empty());
    assert!(fixture.fsrs.relearning_steps.is_empty());
    assert_eq!(fixture.oracle.pypi_package, "fsrs");
    assert_eq!(fixture.oracle.version, "6.3.2");

    assert_eq!(
        fixture.status_ratings,
        BTreeMap::from([
            ("missed".to_owned(), 1),
            ("review".to_owned(), 2),
            ("shaky".to_owned(), 3),
            ("strong".to_owned(), 4),
        ])
    );
}

#[test]
fn fixture_is_not_a_disguised_fixed_status_interval_table() {
    let fixture = fixture();
    let intervals = fixture
        .cases
        .iter()
        .map(|case| case.expected.decision.card.scheduled_days)
        .collect::<BTreeSet<_>>();
    assert!(
        intervals.iter().any(|days| !matches!(days, 1 | 2 | 3 | 8)),
        "fixture only contains 1/2/3/8-day intervals, which is the forbidden fixed lookup"
    );
}

#[test]
fn rust_reproduces_every_conformance_case_from_the_shared_fixture() {
    let fixture = fixture();
    assert!(!fixture.cases.is_empty(), "fixture must contain cases");

    for case in &fixture.cases {
        let clock = FixedClock::new(case.input.graded_at);
        let outcome = ReviewOutcomeV1 {
            status: case.input.status.clone(),
            hint_count: case.input.hint_count,
            miss_count: case.input.miss_count,
        };
        let context = ReviewSchedulingContextV1 {
            schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at: case.input.exam_at,
            card: case.input.prior_card.clone(),
        };

        let decision = decide_review_schedule(clock.now(), &outcome, &context)
            .unwrap_or_else(|error| panic!("{}: {error}", case.case_id));

        assert_decision_matches(
            &case.case_id,
            &fixture.memory_state_tolerance,
            &decision,
            &case.expected.decision,
        );
    }
}

#[test]
fn no_conformance_case_ever_schedules_a_review_after_its_exam() {
    let fixture = fixture();
    for case in &fixture.cases {
        let Some(exam_at) = case.input.exam_at else {
            continue;
        };
        let clock = FixedClock::new(case.input.graded_at);
        let outcome = ReviewOutcomeV1 {
            status: case.input.status.clone(),
            hint_count: case.input.hint_count,
            miss_count: case.input.miss_count,
        };
        let context = ReviewSchedulingContextV1 {
            schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at: Some(exam_at),
            card: case.input.prior_card.clone(),
        };
        let decision = decide_review_schedule(clock.now(), &outcome, &context)
            .unwrap_or_else(|error| panic!("{}: {error}", case.case_id));
        assert!(
            decision.due_at <= exam_at,
            "{}: due_at {} is after exam_at {}",
            case.case_id,
            decision.due_at,
            exam_at
        );
    }
}

#[test]
fn decisions_round_trip_through_the_versioned_json_envelope() {
    let fixture = fixture();
    for case in &fixture.cases {
        let clock = FixedClock::new(case.input.graded_at);
        let outcome = ReviewOutcomeV1 {
            status: case.input.status.clone(),
            hint_count: case.input.hint_count,
            miss_count: case.input.miss_count,
        };
        let context = ReviewSchedulingContextV1 {
            schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at: case.input.exam_at,
            card: case.input.prior_card.clone(),
        };
        let decision = decide_review_schedule(clock.now(), &outcome, &context)
            .unwrap_or_else(|error| panic!("{}: {error}", case.case_id));

        let encoded = serde_json::to_string(&decision).expect("decision serializes");
        let decoded: ReviewScheduleDecisionV1 =
            serde_json::from_str(&encoded).expect("decision round-trips");
        assert_decision_matches(
            &case.case_id,
            &FixtureTolerance {
                absolute: 0.0,
                relative: 0.0,
            },
            &decoded,
            &decision,
        );
    }
}

#[test]
fn unknown_schema_versions_are_rejected_fail_closed() {
    let mut value: serde_json::Value =
        serde_json::from_str(FIXTURE_JSON).expect("fixture parses as JSON");
    let decision = value["cases"][0]["expected"]["decision"].clone();

    let mut bad_decision = decision.clone();
    bad_decision["schema_version"] = serde_json::json!(2);
    assert!(
        serde_json::from_value::<ReviewScheduleDecisionV1>(bad_decision).is_err(),
        "a v2 decision envelope must be rejected, not silently accepted as v1"
    );

    let mut bad_card = decision["card"].clone();
    bad_card["schema_version"] = serde_json::json!(0);
    assert!(
        serde_json::from_value::<PersistedFsrsCardV1>(bad_card).is_err(),
        "a v0 card envelope must be rejected, not silently accepted as v1"
    );

    value["cases"][0]["expected"]["decision"]["cap_reason"] = serde_json::json!("unknown_reason");
    assert!(
        serde_json::from_value::<ReviewScheduleDecisionV1>(
            value["cases"][0]["expected"]["decision"].clone()
        )
        .is_err(),
        "an unknown cap reason must be rejected, not mapped to null"
    );
}

#[test]
fn timestamps_serialize_as_utc_rfc3339_with_millisecond_precision() {
    let fixture = fixture();
    let case = fixture.cases.first().expect("fixture has cases");
    let clock = FixedClock::new(case.input.graded_at);
    let outcome = ReviewOutcomeV1 {
        status: case.input.status.clone(),
        hint_count: case.input.hint_count,
        miss_count: case.input.miss_count,
    };
    let context = ReviewSchedulingContextV1 {
        schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
        exam_at: case.input.exam_at,
        card: case.input.prior_card.clone(),
    };
    let decision = decide_review_schedule(clock.now(), &outcome, &context).expect("decision");
    let encoded = serde_json::to_value(&decision).expect("decision serializes");

    for key in ["generated_at", "uncapped_due_at", "due_at"] {
        let value = encoded[key].as_str().expect("timestamp is a string");
        assert!(
            value.ends_with('Z') && value.len() == "2031-04-05T12:00:00.000Z".len(),
            "{key} must be RFC3339 UTC with millisecond precision, got {value}"
        );
    }
}
