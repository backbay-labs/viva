//! D-01 `SERVER_PERSISTED_FSRS` — the one authoritative review-scheduling calculator.
//!
//! Every recorded value here comes from
//! `docs/decisions/2026-08-23-d-01-review-scheduling-authority.md`:
//!
//! * FSRS-6 with the default 21-parameter weights, desired retention `0.9`, no
//!   fuzzing, and no learning/relearning steps (a graded outcome always produces a
//!   day-scale interval).
//! * `missed -> 1 Again`, `review -> 2 Hard`, `shaky -> 3 Good`, `strong -> 4 Easy`.
//!   Hints and misses are provenance only; they never move the rating.
//! * Every instant is an exact UTC instant serialized as RFC3339 with millisecond
//!   precision. No calendar-day rounding, no local time, no DST handling.
//! * Exam margin `86_400` seconds. For a future exam the scheduled `due_at` is
//!   `min(uncapped_due_at, exam_at - 86_400s)`, and `cap_reason = exam_margin` is
//!   recorded if and only if that cap strictly lowered `uncapped_due_at`.
//! * For an exam that is already past at grading time the decision fails closed with
//!   `due_at = exam_at` and `cap_reason = past_exam`.
//!
//! The literal conformance fixture at
//! `packages/core/src/review-scheduling-conformance-v1.json` was derived from an
//! independent oracle (py-fsrs 6.3.2). If this module and that fixture ever disagree,
//! D-01 is amended — the fixture is never tuned to this code.

use std::sync::OnceLock;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use fsrs::{MemoryState, FSRS};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::ConceptStatus;

/// The only supported persisted schema version for review scheduling.
pub const VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION: u8 = 1;
/// The D-01 policy identifier persisted with every decision.
pub const VIVA_REVIEW_SCHEDULE_POLICY_ID: &str = "viva.fsrs6-default.1";
/// D-01 exam margin: no review is scheduled inside the last 24 hours before an exam.
pub const VIVA_REVIEW_EXAM_MARGIN_SECONDS: u64 = 86_400;
/// D-01 FSRS desired retention.
pub const VIVA_REVIEW_DESIRED_RETENTION: f32 = 0.9;
/// D-01 FSRS maximum interval, in whole days.
pub const VIVA_REVIEW_MAX_INTERVAL_DAYS: u32 = 36_500;

const STABILITY_MIN: f64 = 0.001;
const STABILITY_MAX: f64 = 36_500.0;
const DIFFICULTY_MIN: f64 = 1.0;
const DIFFICULTY_MAX: f64 = 10.0;

/// Injected time. Production composes [`SystemClock`]; scheduling code never calls
/// `Utc::now()` directly and never reads the clock more than once per outcome.
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

/// The production clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// A frozen clock for tests and deterministic composition.
///
/// This exists so tests in every crate can pin the grading instant. It is never
/// wired into production composition: `VivaToolExecutor::new` and the synthetic
/// adapter's default construction both build a [`SystemClock`].
#[derive(Clone, Copy, Debug)]
pub struct FixedClock(DateTime<Utc>);

impl FixedClock {
    pub fn new(instant: DateTime<Utc>) -> Self {
        Self(instant)
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FsrsCardStateV1 {
    New,
    Learning,
    Review,
    Relearning,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewScheduleCapReasonV1 {
    ExamMargin,
    PastExam,
}

/// The persisted FSRS memory state for one concept.
///
/// `due_at` is the *uncapped* FSRS due instant, so a schedule that was pulled
/// forward by the exam margin never corrupts the next review's elapsed-day maths.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedFsrsCardV1 {
    #[serde(deserialize_with = "deserialize_schema_version_v1")]
    pub schema_version: u8,
    #[serde(with = "rfc3339_millis")]
    pub due_at: DateTime<Utc>,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: u32,
    pub scheduled_days: u32,
    pub reps: u32,
    pub lapses: u32,
    pub state: FsrsCardStateV1,
    #[serde(with = "rfc3339_millis_option")]
    pub last_review_at: Option<DateTime<Utc>>,
}

impl PersistedFsrsCardV1 {
    pub fn validate(&self) -> Result<(), ReviewScheduleError> {
        if self.schema_version != VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION {
            return Err(ReviewScheduleError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        if !self.stability.is_finite() || !(STABILITY_MIN..=STABILITY_MAX).contains(&self.stability)
        {
            return Err(ReviewScheduleError::InvalidCard("stability out of range"));
        }
        if !self.difficulty.is_finite()
            || !(DIFFICULTY_MIN..=DIFFICULTY_MAX).contains(&self.difficulty)
        {
            return Err(ReviewScheduleError::InvalidCard("difficulty out of range"));
        }
        Ok(())
    }
}

/// The authoritative, persisted scheduling decision for one graded outcome.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewScheduleDecisionV1 {
    #[serde(deserialize_with = "deserialize_schema_version_v1")]
    pub schema_version: u8,
    pub policy_id: String,
    #[serde(with = "rfc3339_millis")]
    pub generated_at: DateTime<Utc>,
    pub status: ConceptStatus,
    pub rating: u8,
    pub hint_count: Option<u32>,
    pub miss_count: Option<u32>,
    #[serde(with = "rfc3339_millis_option")]
    pub exam_at: Option<DateTime<Utc>>,
    pub exam_margin_seconds: u64,
    #[serde(with = "rfc3339_millis")]
    pub uncapped_due_at: DateTime<Utc>,
    #[serde(with = "rfc3339_millis")]
    pub due_at: DateTime<Utc>,
    pub cap_reason: Option<ReviewScheduleCapReasonV1>,
    pub card: PersistedFsrsCardV1,
}

impl ReviewScheduleDecisionV1 {
    pub fn validate(&self) -> Result<(), ReviewScheduleError> {
        if self.schema_version != VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION {
            return Err(ReviewScheduleError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        if self.policy_id != VIVA_REVIEW_SCHEDULE_POLICY_ID {
            return Err(ReviewScheduleError::UnknownPolicy(self.policy_id.clone()));
        }
        if self.exam_margin_seconds != VIVA_REVIEW_EXAM_MARGIN_SECONDS {
            return Err(ReviewScheduleError::InvalidCard("exam margin drift"));
        }
        if self.rating != status_rating(&self.status) {
            return Err(ReviewScheduleError::InvalidCard(
                "rating does not match the recorded status mapping",
            ));
        }
        if let Some(exam_at) = self.exam_at {
            if self.due_at > exam_at {
                return Err(ReviewScheduleError::ExamInvariantViolated);
            }
        }
        self.card.validate()
    }

    /// The browser/tool-visible projection. Raw FSRS stability and difficulty never
    /// leave the server.
    pub fn public_summary(&self, concept_id: &str) -> serde_json::Value {
        serde_json::json!({
            "concept_id": concept_id,
            "due_at": format_rfc3339_millis(self.due_at),
            "policy_id": self.policy_id,
            "schema_version": self.schema_version,
            "cap_reason": self.cap_reason,
            "status": "scheduled",
        })
    }
}

/// Authoritative scheduling inputs the store owns. Never taken from tool arguments.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReviewSchedulingContextV1 {
    pub schema_version: u8,
    #[serde(with = "rfc3339_millis_option")]
    pub exam_at: Option<DateTime<Utc>>,
    pub card: Option<PersistedFsrsCardV1>,
}

impl ReviewSchedulingContextV1 {
    pub fn empty() -> Self {
        Self {
            schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
            exam_at: None,
            card: None,
        }
    }
}

/// The graded outcome. Hint and miss counts are provenance only: unknown stays
/// `None` and is never coerced to zero, and neither value can move `due_at`.
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewOutcomeV1 {
    pub status: ConceptStatus,
    pub hint_count: Option<u32>,
    pub miss_count: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReviewScheduleError {
    #[error("unsupported review-schedule schema version {0}; only v1 is accepted")]
    UnsupportedSchemaVersion(u8),
    #[error("unknown review-schedule policy `{0}`")]
    UnknownPolicy(String),
    #[error("invalid persisted review card: {0}")]
    InvalidCard(&'static str),
    #[error("FSRS engine rejected the scheduling input")]
    Engine,
    #[error("scheduling produced a review after the exam")]
    ExamInvariantViolated,
    #[error("review counters overflowed")]
    CounterOverflow,
}

/// D-01 status-to-rating mapping. This is the single definition; nothing else maps.
pub fn status_rating(status: &ConceptStatus) -> u8 {
    match status {
        ConceptStatus::Missed => 1,
        ConceptStatus::Review => 2,
        ConceptStatus::Shaky => 3,
        ConceptStatus::Strong => 4,
    }
}

fn engine() -> Result<&'static FSRS, ReviewScheduleError> {
    static ENGINE: OnceLock<Option<FSRS>> = OnceLock::new();
    ENGINE
        .get_or_init(|| FSRS::new(&[]).ok())
        .as_ref()
        .ok_or(ReviewScheduleError::Engine)
}

fn elapsed_days_between(last_review_at: DateTime<Utc>, now: DateTime<Utc>) -> u32 {
    let days = (now - last_review_at).num_days();
    if days <= 0 {
        0
    } else {
        u32::try_from(days).unwrap_or(u32::MAX)
    }
}

/// Compute the one authoritative decision for a graded outcome.
///
/// `now` is read from an injected [`Clock`] exactly once per outcome by the caller;
/// this function never reads a clock itself.
pub fn decide_review_schedule(
    now: DateTime<Utc>,
    outcome: &ReviewOutcomeV1,
    context: &ReviewSchedulingContextV1,
) -> Result<ReviewScheduleDecisionV1, ReviewScheduleError> {
    if context.schema_version != VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION {
        return Err(ReviewScheduleError::UnsupportedSchemaVersion(
            context.schema_version,
        ));
    }

    let rating = status_rating(&outcome.status);
    let prior = context.card.as_ref();
    if let Some(card) = prior {
        card.validate()?;
    }

    let elapsed_days = prior
        .and_then(|card| card.last_review_at)
        .map(|last_review_at| elapsed_days_between(last_review_at, now))
        .unwrap_or(0);
    let memory = prior.map(|card| MemoryState {
        stability: card.stability as f32,
        difficulty: card.difficulty as f32,
    });

    let next = engine()?
        .next_states(memory, VIVA_REVIEW_DESIRED_RETENTION, elapsed_days)
        .map_err(|_| ReviewScheduleError::Engine)?;
    let item = match rating {
        1 => next.again,
        2 => next.hard,
        3 => next.good,
        4 => next.easy,
        _ => return Err(ReviewScheduleError::InvalidCard("unmapped rating")),
    };

    if !item.interval.is_finite()
        || !item.memory.stability.is_finite()
        || !item.memory.difficulty.is_finite()
    {
        return Err(ReviewScheduleError::Engine);
    }

    let scheduled_days = u32::try_from(
        (item.interval.round() as i64).clamp(1, i64::from(VIVA_REVIEW_MAX_INTERVAL_DAYS)),
    )
    .map_err(|_| ReviewScheduleError::Engine)?;

    let uncapped_due_at = now
        .checked_add_signed(Duration::days(i64::from(scheduled_days)))
        .ok_or(ReviewScheduleError::CounterOverflow)?;

    let mut due_at = uncapped_due_at;
    let mut cap_reason = None;
    if let Some(exam_at) = context.exam_at {
        if exam_at <= now {
            due_at = exam_at;
            cap_reason = Some(ReviewScheduleCapReasonV1::PastExam);
        } else {
            let margin_due_at = exam_at
                .checked_sub_signed(Duration::seconds(
                    i64::try_from(VIVA_REVIEW_EXAM_MARGIN_SECONDS)
                        .map_err(|_| ReviewScheduleError::CounterOverflow)?,
                ))
                .ok_or(ReviewScheduleError::CounterOverflow)?;
            if margin_due_at < uncapped_due_at {
                due_at = margin_due_at;
                cap_reason = Some(ReviewScheduleCapReasonV1::ExamMargin);
            }
        }
        if due_at > exam_at {
            return Err(ReviewScheduleError::ExamInvariantViolated);
        }
    }

    let reps = prior
        .map(|card| card.reps)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(ReviewScheduleError::CounterOverflow)?;
    let prior_lapses = prior.map(|card| card.lapses).unwrap_or(0);
    let lapses = if prior.is_some() && rating == 1 {
        prior_lapses
            .checked_add(1)
            .ok_or(ReviewScheduleError::CounterOverflow)?
    } else {
        prior_lapses
    };

    let card = PersistedFsrsCardV1 {
        schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
        due_at: uncapped_due_at,
        stability: f64::from(item.memory.stability),
        difficulty: f64::from(item.memory.difficulty),
        elapsed_days,
        scheduled_days,
        reps,
        lapses,
        state: FsrsCardStateV1::Review,
        last_review_at: Some(now),
    };
    card.validate()?;

    let decision = ReviewScheduleDecisionV1 {
        schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
        policy_id: VIVA_REVIEW_SCHEDULE_POLICY_ID.to_owned(),
        generated_at: now,
        status: outcome.status.clone(),
        rating,
        hint_count: outcome.hint_count,
        miss_count: outcome.miss_count,
        exam_at: context.exam_at,
        exam_margin_seconds: VIVA_REVIEW_EXAM_MARGIN_SECONDS,
        uncapped_due_at,
        due_at,
        cap_reason,
        card,
    };
    decision.validate()?;
    Ok(decision)
}

/// The single serialization used for every persisted scheduling instant.
pub fn format_rfc3339_millis(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Parse a persisted UTC instant fail-closed. Accepts RFC3339 with an explicit
/// offset, or a bare `YYYY-MM-DD` calendar date read as midnight UTC.
pub fn parse_utc_instant(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
        return Some(parsed.with_timezone(&Utc));
    }
    chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|naive| DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

fn deserialize_schema_version_v1<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u8::deserialize(deserializer)?;
    if value != VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION {
        return Err(serde::de::Error::custom(format!(
            "unsupported review-schedule schema version {value}; only v1 is accepted"
        )));
    }
    Ok(value)
}

mod rfc3339_millis {
    use super::{format_rfc3339_millis, DateTime, Deserialize, Deserializer, Serializer, Utc};

    pub fn serialize<S>(value: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&format_rfc3339_millis(*value))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<DateTime<Utc>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        DateTime::parse_from_rfc3339(&raw)
            .map(|value| value.with_timezone(&Utc))
            .map_err(serde::de::Error::custom)
    }
}

mod rfc3339_millis_option {
    use super::{format_rfc3339_millis, DateTime, Deserialize, Deserializer, Serializer, Utc};

    pub fn serialize<S>(value: &Option<DateTime<Utc>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(value) => serializer.serialize_str(&format_rfc3339_millis(*value)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<DateTime<Utc>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Option::<String>::deserialize(deserializer)?;
        raw.map(|raw| {
            DateTime::parse_from_rfc3339(&raw)
                .map(|value| value.with_timezone(&Utc))
                .map_err(serde::de::Error::custom)
        })
        .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instant(raw: &str) -> DateTime<Utc> {
        parse_utc_instant(raw).expect("test instant parses")
    }

    fn outcome(status: ConceptStatus) -> ReviewOutcomeV1 {
        ReviewOutcomeV1 {
            status,
            hint_count: None,
            miss_count: None,
        }
    }

    #[test]
    fn review_schedule_maps_every_status_to_the_recorded_d01_rating() {
        assert_eq!(status_rating(&ConceptStatus::Missed), 1);
        assert_eq!(status_rating(&ConceptStatus::Review), 2);
        assert_eq!(status_rating(&ConceptStatus::Shaky), 3);
        assert_eq!(status_rating(&ConceptStatus::Strong), 4);
    }

    #[test]
    fn review_schedule_never_emits_a_fixed_june_2026_literal() {
        let now = instant("2031-04-05T12:00:00.000Z");
        for status in [
            ConceptStatus::Missed,
            ConceptStatus::Shaky,
            ConceptStatus::Review,
            ConceptStatus::Strong,
        ] {
            let decision =
                decide_review_schedule(now, &outcome(status), &ReviewSchedulingContextV1::empty())
                    .expect("decision");
            let encoded = serde_json::to_string(&decision).expect("serializes");
            assert!(!encoded.contains("2026-06-"), "{encoded}");
            assert!(decision.due_at > now);
        }
    }

    #[test]
    fn review_schedule_reads_the_injected_clock_exactly_once_per_outcome() {
        let now = instant("2031-04-05T12:00:00.000Z");
        let clock = FixedClock::new(now);
        let first = decide_review_schedule(
            clock.now(),
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("decision");
        let second = decide_review_schedule(
            clock.now(),
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("decision");
        assert_eq!(first, second);
        assert_eq!(first.generated_at, now);
    }

    #[test]
    fn review_schedule_grows_the_interval_across_reviews_instead_of_restarting() {
        let first_now = instant("2031-04-05T12:00:00.000Z");
        let first = decide_review_schedule(
            first_now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("first decision");

        let second_now = first.card.due_at;
        let second = decide_review_schedule(
            second_now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: None,
                card: Some(first.card.clone()),
            },
        )
        .expect("second decision");

        assert_eq!(second.card.reps, 2);
        assert_eq!(second.card.elapsed_days, first.card.scheduled_days);
        assert!(
            second.card.scheduled_days > first.card.scheduled_days,
            "second={} first={}",
            second.card.scheduled_days,
            first.card.scheduled_days
        );
        assert!(second.card.stability > first.card.stability);
    }

    #[test]
    fn review_schedule_counts_a_lapse_only_for_an_existing_card() {
        let now = instant("2031-04-05T12:00:00.000Z");
        let fresh = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Missed),
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("fresh decision");
        assert_eq!(fresh.card.lapses, 0);

        let lapsed = decide_review_schedule(
            instant("2031-04-20T12:00:00.000Z"),
            &outcome(ConceptStatus::Missed),
            &ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: None,
                card: Some(fresh.card.clone()),
            },
        )
        .expect("lapse decision");
        assert_eq!(lapsed.card.lapses, 1);
        assert_eq!(lapsed.card.reps, 2);
    }

    #[test]
    fn review_schedule_applies_the_exam_margin_only_when_it_strictly_lowers_the_due_date() {
        let now = instant("2031-04-05T12:00:00.000Z");
        let uncapped = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("uncapped");

        let boundary = uncapped.uncapped_due_at
            + Duration::seconds(i64::try_from(VIVA_REVIEW_EXAM_MARGIN_SECONDS).unwrap());
        let at_boundary = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: Some(boundary),
                card: None,
            },
        )
        .expect("boundary");
        assert_eq!(at_boundary.due_at, uncapped.uncapped_due_at);
        assert_eq!(at_boundary.cap_reason, None);

        let inside = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: Some(boundary - Duration::seconds(1)),
                card: None,
            },
        )
        .expect("inside");
        assert_eq!(
            inside.due_at,
            uncapped.uncapped_due_at - Duration::seconds(1)
        );
        assert_eq!(
            inside.cap_reason,
            Some(ReviewScheduleCapReasonV1::ExamMargin)
        );
        assert!(inside.due_at < inside.exam_at.expect("exam"));
    }

    #[test]
    fn review_schedule_fails_closed_for_an_exam_that_is_already_past() {
        let now = instant("2031-04-05T12:00:00.000Z");
        let exam_at = instant("2031-03-30T09:15:00.000Z");
        let decision = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Missed),
            &ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: Some(exam_at),
                card: None,
            },
        )
        .expect("past exam decision");
        assert_eq!(decision.due_at, exam_at);
        assert_eq!(
            decision.cap_reason,
            Some(ReviewScheduleCapReasonV1::PastExam)
        );
        assert!(decision.uncapped_due_at > now);
    }

    #[test]
    fn review_schedule_never_places_a_review_after_a_future_exam() {
        let now = instant("2031-04-05T12:00:00.000Z");
        for minutes in [1_i64, 59, 60, 1_439, 1_440, 1_441, 10_000] {
            let exam_at = now + Duration::minutes(minutes);
            let decision = decide_review_schedule(
                now,
                &outcome(ConceptStatus::Strong),
                &ReviewSchedulingContextV1 {
                    schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                    exam_at: Some(exam_at),
                    card: None,
                },
            )
            .expect("decision");
            assert!(decision.due_at <= exam_at, "minutes={minutes}");
        }
    }

    #[test]
    fn review_schedule_keeps_unknown_hint_and_miss_provenance_null() {
        let now = instant("2031-04-05T12:00:00.000Z");
        let unknown = decide_review_schedule(
            now,
            &ReviewOutcomeV1 {
                status: ConceptStatus::Shaky,
                hint_count: None,
                miss_count: None,
            },
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("unknown provenance");
        assert_eq!(unknown.hint_count, None);
        assert_eq!(unknown.miss_count, None);

        let known = decide_review_schedule(
            now,
            &ReviewOutcomeV1 {
                status: ConceptStatus::Shaky,
                hint_count: Some(3),
                miss_count: Some(0),
            },
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("known provenance");
        assert_eq!(known.hint_count, Some(3));
        assert_eq!(known.miss_count, Some(0));
        assert_eq!(known.rating, unknown.rating);
        assert_eq!(known.due_at, unknown.due_at);
    }

    #[test]
    fn review_schedule_rejects_a_non_v1_context_or_card() {
        let now = instant("2031-04-05T12:00:00.000Z");
        let result = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1 {
                schema_version: 2,
                exam_at: None,
                card: None,
            },
        );
        assert!(matches!(
            result,
            Err(ReviewScheduleError::UnsupportedSchemaVersion(2))
        ));

        let mut card = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("decision")
        .card;
        card.difficulty = 42.0;
        let result = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1 {
                schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
                exam_at: None,
                card: Some(card),
            },
        );
        assert!(matches!(result, Err(ReviewScheduleError::InvalidCard(_))));
    }

    #[test]
    fn review_schedule_public_summary_hides_raw_fsrs_memory_state() {
        let now = instant("2031-04-05T12:00:00.000Z");
        let decision = decide_review_schedule(
            now,
            &outcome(ConceptStatus::Strong),
            &ReviewSchedulingContextV1::empty(),
        )
        .expect("decision");
        let summary = decision.public_summary("concept-1");
        assert_eq!(summary["policy_id"], VIVA_REVIEW_SCHEDULE_POLICY_ID);
        assert_eq!(summary["schema_version"], 1);
        assert_eq!(summary["due_at"], format_rfc3339_millis(decision.due_at));
        let encoded = summary.to_string();
        assert!(!encoded.contains("stability"), "{encoded}");
        assert!(!encoded.contains("difficulty"), "{encoded}");
    }

    #[test]
    fn review_schedule_parses_calendar_dates_and_instants_fail_closed() {
        assert_eq!(
            parse_utc_instant("2031-04-05"),
            Some(instant("2031-04-05T00:00:00.000Z"))
        );
        assert_eq!(
            parse_utc_instant("2031-04-05T12:00:00Z"),
            Some(instant("2031-04-05T12:00:00.000Z"))
        );
        assert_eq!(parse_utc_instant(""), None);
        assert_eq!(parse_utc_instant("not-a-date"), None);
        assert_eq!(parse_utc_instant("2031-13-45"), None);
    }
}
