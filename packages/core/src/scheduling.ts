import {
  createEmptyCard,
  FSRSAlgorithm,
  fsrs,
  type Grade,
  generatorParameters,
  Rating,
} from "ts-fsrs";
import type { ConceptStatus } from "./index";

/**
 * Spaced-repetition scheduling for Viva.
 *
 * There is exactly one authoritative calculator: `decideReviewSchedule`, which
 * implements the policy recorded in
 * `docs/decisions/2026-08-23-d-01-review-scheduling-authority.md` (D-01,
 * `SERVER_PERSISTED_FSRS`) and is mirrored byte-for-semantic-byte by
 * `agent-domain`'s `review_schedule.rs`. Both are pinned to the literal fixture in
 * `review-scheduling-conformance-v1.json`, which was derived from an independent
 * oracle (py-fsrs 6.3.2). If an implementation and that fixture disagree, D-01 is
 * amended — the fixture is never tuned.
 *
 * Recorded policy: FSRS-6 default weights, request retention 0.9, no fuzzing, and
 * no learning/relearning steps, so a graded outcome always yields a day-scale
 * interval (the manuscript talks in "tomorrow"/"in 3 days", never in minutes, and
 * never leaks raw stability/difficulty into the UI). `missed -> Again`,
 * `review -> Hard`, `shaky -> Good`, `strong -> Easy`. Hints and misses are
 * provenance only and cannot move the rating. Exam margin 86,400 s; a past exam
 * fails closed at the exam instant.
 *
 * `authoritativeAlgorithm` drives ts-fsrs at the algorithm level rather than
 * through its `Scheduler`, because the scheduler applies a display-oriented
 * cross-rating monotonicity constraint (again <= hard < good < easy) that is not
 * part of FSRS-6. Viva applies exactly one rating per outcome, so that constraint
 * would only introduce a silent divergence from the reference algorithm.
 * `enable_short_term` is left on so ts-fsrs evaluates the canonical FSRS-6
 * stability equations; no ts-fsrs learning step is ever used.
 */
const AUTHORITATIVE_PARAMETERS = generatorParameters({
  request_retention: 0.9,
  enable_fuzz: false,
  enable_short_term: true,
});
const authoritativeAlgorithm = new FSRSAlgorithm(AUTHORITATIVE_PARAMETERS);

/** Legacy UI-only estimator retained for label projection; never the authority. */
const scheduler = fsrs(generatorParameters({ enable_short_term: false }));

const DAY_MS = 86_400_000;

export const VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION = 1 as const;
export const VIVA_REVIEW_SCHEDULE_POLICY_ID = "viva.fsrs6-default.1" as const;
export const VIVA_REVIEW_EXAM_MARGIN_SECONDS = 86_400 as const;
export const VIVA_REVIEW_DESIRED_RETENTION = 0.9 as const;
export const VIVA_REVIEW_MAX_INTERVAL_DAYS = 36_500 as const;

export const VIVA_REVIEW_STATUS_RATINGS: Readonly<Record<ConceptStatus, 1 | 2 | 3 | 4>> = {
  missed: 1,
  review: 2,
  shaky: 3,
  strong: 4,
};

export type FsrsCardStateV1 = "new" | "learning" | "review" | "relearning";
export type ReviewScheduleCapReasonV1 = "exam_margin" | "past_exam";

/**
 * The persisted FSRS memory state for one concept. Field names are snake_case
 * because this is the wire/persistence envelope shared verbatim with `agent-domain`.
 *
 * `due_at` is the *uncapped* FSRS due instant, so a schedule pulled forward by the
 * exam margin never corrupts the next review's elapsed-day arithmetic.
 */
export type PersistedFsrsCardV1 = Readonly<{
  schema_version: 1;
  due_at: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: FsrsCardStateV1;
  last_review_at: string | null;
}>;

/** The authoritative, persisted scheduling decision for one graded outcome. */
export type ReviewScheduleDecisionV1 = Readonly<{
  schema_version: 1;
  policy_id: string;
  generated_at: string;
  status: ConceptStatus;
  rating: 1 | 2 | 3 | 4;
  hint_count: number | null;
  miss_count: number | null;
  exam_at: string | null;
  exam_margin_seconds: number;
  uncapped_due_at: string;
  due_at: string;
  cap_reason: ReviewScheduleCapReasonV1 | null;
  card: PersistedFsrsCardV1;
}>;

export type ReviewScheduleDecisionInput = Readonly<{
  status: ConceptStatus;
  /** Injected grading instant. This module never reads `Date.now()`. */
  now: Date;
  hintCount?: number | null;
  missCount?: number | null;
  examAt?: Date | null;
  priorCard?: PersistedFsrsCardV1 | null;
}>;

export type ReviewScheduleInput = {
  conceptId: string;
  label: string;
  status: ConceptStatus;
  misses: number;
  hinted: boolean;
  centrality: number;
  now: Date;
  examDate?: Date;
  lastReviewedAt?: Date;
  advisorDueAt?: string;
  /** The persisted v1 card, so repeated reviews accumulate instead of restarting. */
  priorCard?: PersistedFsrsCardV1 | null;
};

export type ReviewScheduleItem = {
  conceptId: string;
  label: string;
  status: ConceptStatus;
  /** UI-facing date: the authoritative date, optionally pulled earlier for urgency. */
  dueAt: Date;
  /** The authoritative D-01 date that was persisted server-side. */
  authoritativeDueAt: Date;
  capReason: ReviewScheduleCapReasonV1 | null;
  card: PersistedFsrsCardV1;
  intervalLabel: string;
  priority: "urgent" | "soon" | "later";
  explanation: string[];
  authority: "core_fsrs";
  ignoredAdvisorDueAt?: string;
};

export function conceptStatusToRating(status: ConceptStatus): Grade {
  switch (status) {
    case "missed":
      return Rating.Again;
    case "review":
      return Rating.Hard;
    case "shaky":
      return Rating.Good;
    case "strong":
      return Rating.Easy;
  }
}

function toIsoMillis(value: Date): string {
  return new Date(value.getTime()).toISOString();
}

function elapsedDaysBetween(lastReviewAt: Date, now: Date): number {
  const elapsed = Math.floor((now.getTime() - lastReviewAt.getTime()) / DAY_MS);
  return elapsed > 0 ? elapsed : 0;
}

function assertFiniteCard(card: PersistedFsrsCardV1): void {
  if (card.schema_version !== VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION) {
    throw new Error(`unsupported review-schedule card schema version ${card.schema_version}`);
  }
  if (!Number.isFinite(card.stability) || card.stability < 0.001 || card.stability > 36_500) {
    throw new Error("persisted review card stability is out of range");
  }
  if (!Number.isFinite(card.difficulty) || card.difficulty < 1 || card.difficulty > 10) {
    throw new Error("persisted review card difficulty is out of range");
  }
}

/**
 * The single authoritative D-01 calculation. `now` is injected by the caller; this
 * function never reads a clock and never uses a fixed status-to-interval table.
 */
export function decideReviewSchedule(input: ReviewScheduleDecisionInput): ReviewScheduleDecisionV1 {
  const rating = VIVA_REVIEW_STATUS_RATINGS[input.status];
  const prior = input.priorCard ?? null;
  if (prior) assertFiniteCard(prior);

  const lastReviewAt = prior?.last_review_at ? new Date(prior.last_review_at) : null;
  const elapsedDays = lastReviewAt ? elapsedDaysBetween(lastReviewAt, input.now) : 0;
  const memory = prior ? { stability: prior.stability, difficulty: prior.difficulty } : null;

  const nextState = authoritativeAlgorithm.next_state(memory, elapsedDays, rating);
  const scheduledDays = authoritativeAlgorithm.next_interval(nextState.stability, elapsedDays);
  if (!Number.isFinite(scheduledDays) || scheduledDays < 1) {
    throw new Error("FSRS produced a non-schedulable interval");
  }

  const uncappedDueAt = new Date(input.now.getTime() + scheduledDays * DAY_MS);
  const examAt = input.examAt ?? null;
  let dueAt = uncappedDueAt;
  let capReason: ReviewScheduleCapReasonV1 | null = null;
  if (examAt) {
    if (examAt.getTime() <= input.now.getTime()) {
      dueAt = examAt;
      capReason = "past_exam";
    } else {
      const marginDueAt = new Date(examAt.getTime() - VIVA_REVIEW_EXAM_MARGIN_SECONDS * 1_000);
      if (marginDueAt.getTime() < uncappedDueAt.getTime()) {
        dueAt = marginDueAt;
        capReason = "exam_margin";
      }
    }
    if (dueAt.getTime() > examAt.getTime()) {
      throw new Error("review scheduling produced a review after the exam");
    }
  }

  const priorReps = prior?.reps ?? 0;
  const priorLapses = prior?.lapses ?? 0;
  const card: PersistedFsrsCardV1 = {
    schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
    due_at: toIsoMillis(uncappedDueAt),
    stability: nextState.stability,
    difficulty: nextState.difficulty,
    elapsed_days: elapsedDays,
    scheduled_days: scheduledDays,
    reps: priorReps + 1,
    lapses: prior && rating === 1 ? priorLapses + 1 : priorLapses,
    state: "review",
    last_review_at: toIsoMillis(input.now),
  };
  assertFiniteCard(card);

  return {
    schema_version: VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
    policy_id: VIVA_REVIEW_SCHEDULE_POLICY_ID,
    generated_at: toIsoMillis(input.now),
    status: input.status,
    rating,
    hint_count: input.hintCount ?? null,
    miss_count: input.missCount ?? null,
    exam_at: examAt ? toIsoMillis(examAt) : null,
    exam_margin_seconds: VIVA_REVIEW_EXAM_MARGIN_SECONDS,
    uncapped_due_at: toIsoMillis(uncappedDueAt),
    due_at: toIsoMillis(dueAt),
    cap_reason: capReason,
    card,
  };
}

export function humanInterval(from: Date, to: Date): string {
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/**
 * UI-only status estimate for an unseen concept. Uncapped and card-free: it answers
 * "what does a first review of this status look like", never "when is this concept
 * due". Learner-facing schedules come from `scheduleConceptReview`.
 */
export function dueDateForStatus(status: ConceptStatus, now: Date): Date {
  const card = createEmptyCard(now);
  const { card: scheduled } = scheduler.next(card, now, conceptStatusToRating(status));
  return scheduled.due;
}

export function reviewIntervalForStatus(status: ConceptStatus, now: Date): string {
  return humanInterval(now, dueDateForStatus(status, now));
}

/**
 * Build the learner-facing review card for one concept.
 *
 * The date authority is `decideReviewSchedule`. The remaining urgency shaping
 * (hint, miss, centrality, session recency) is UI-only: it can pull the *displayed*
 * date earlier, never later, and never touches the persisted decision. Plan 04 owns
 * folding that shaping into the scheduling contract.
 */
export function scheduleConceptReview(input: ReviewScheduleInput): ReviewScheduleItem {
  const explanation: string[] = [];
  const decision = decideReviewSchedule({
    status: input.status,
    now: input.now,
    hintCount: null,
    missCount: null,
    examAt: input.examDate ?? null,
    priorCard: input.priorCard ?? null,
  });
  recordProvenance(input, decision, explanation);

  const authoritativeDueAt = new Date(decision.due_at);
  const dueAt = applyDisplayUrgencyCaps(authoritativeDueAt, input, explanation);
  const item: ReviewScheduleItem = {
    conceptId: input.conceptId,
    label: input.label,
    status: input.status,
    dueAt,
    authoritativeDueAt,
    capReason: decision.cap_reason,
    card: decision.card,
    intervalLabel: humanInterval(input.now, dueAt),
    priority: priorityFor(input.now, dueAt),
    explanation,
    authority: "core_fsrs",
  };

  if (input.advisorDueAt) {
    item.ignoredAdvisorDueAt = input.advisorDueAt;
  }

  return item;
}

export function buildReviewSchedule(inputs: ReviewScheduleInput[]): ReviewScheduleItem[] {
  return inputs
    .map(scheduleConceptReview)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.label.localeCompare(b.label));
}

function recordProvenance(
  input: ReviewScheduleInput,
  decision: ReviewScheduleDecisionV1,
  explanation: string[],
): void {
  explanation.push(`FSRS rating: ${ratingName(decision.rating)}`);
  if (input.hinted) {
    explanation.push("hint-assisted answer recorded as provenance; the rating is unchanged");
  }
  if (input.misses > 0) {
    explanation.push(`${input.misses} prior misses`);
  }
  if (input.centrality >= 90) {
    explanation.push("high-centrality concept");
  }
  if (input.lastReviewedAt) {
    explanation.push("session recency included");
  }
  if (input.priorCard) {
    explanation.push(`review ${decision.card.reps} of this concept`);
  }
  if (input.advisorDueAt) {
    explanation.push("advisor due date ignored");
  }
  if (decision.cap_reason === "exam_margin") {
    explanation.push("exam-near cap");
  }
  if (decision.cap_reason === "past_exam") {
    explanation.push("exam-near cap: the exam has already passed");
  }
}

function applyDisplayUrgencyCaps(
  authoritativeDueAt: Date,
  input: ReviewScheduleInput,
  explanation: string[],
): Date {
  const cap = capDays(input, explanation);
  if (cap === undefined) return authoritativeDueAt;
  return minDate(authoritativeDueAt, addDays(input.now, cap));
}

function capDays(input: ReviewScheduleInput, explanation: string[]): number | undefined {
  const caps: number[] = [];
  if (input.status === "missed") caps.push(1);
  if (input.hinted) caps.push(2);
  if (input.centrality >= 90) caps.push(input.status === "strong" ? 3 : 2);
  const recencyCap = recencyCapDays(input, explanation);
  if (recencyCap !== undefined) caps.push(recencyCap);
  return caps.length > 0 ? Math.min(...caps) : undefined;
}

function recencyCapDays(
  { lastReviewedAt, now }: ReviewScheduleInput,
  explanation: string[],
): number | undefined {
  if (!lastReviewedAt) return undefined;
  const daysSinceReview = Math.floor((now.getTime() - lastReviewedAt.getTime()) / DAY_MS);
  if (daysSinceReview >= 21) {
    explanation.push("session recency cap");
    return 2;
  }
  if (daysSinceReview >= 7) {
    explanation.push("session recency cap");
    return 3;
  }
  return undefined;
}

function priorityFor(now: Date, dueAt: Date): ReviewScheduleItem["priority"] {
  const days = Math.round((dueAt.getTime() - now.getTime()) / DAY_MS);
  if (days <= 1) return "urgent";
  if (days <= 3) return "soon";
  return "later";
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function ratingName(rating: 1 | 2 | 3 | 4): string {
  switch (rating) {
    case 1:
      return "Again";
    case 2:
      return "Hard";
    case 3:
      return "Good";
    case 4:
      return "Easy";
  }
}

// ---------------------------------------------------------------------------
// Conformance fixture parsing (fail closed).
// ---------------------------------------------------------------------------

export type ReviewSchedulingConformanceCase = Readonly<{
  case_id: string;
  input: Readonly<{
    concept_id: string;
    graded_at: string;
    status: ConceptStatus;
    hint_count: number | null;
    miss_count: number | null;
    exam_at: string | null;
    prior_card: PersistedFsrsCardV1 | null;
  }>;
  expected: Readonly<{ decision: ReviewScheduleDecisionV1 }>;
}>;

export type ReviewSchedulingConformanceFixture = Readonly<{
  schema_version: 1;
  fixture_id: string;
  selected_authority: string;
  policy_id: string;
  fsrs: Readonly<{
    algorithm: string;
    parameters: readonly number[];
    desired_retention: number;
    maximum_interval_days: number;
    enable_fuzzing: boolean;
    learning_steps: readonly number[];
    relearning_steps: readonly number[];
  }>;
  status_ratings: Readonly<Record<ConceptStatus, 1 | 2 | 3 | 4>>;
  exam_margin_seconds: number;
  memory_state_tolerance: Readonly<{ absolute: number; relative: number }>;
  oracle: Readonly<{ name: string; pypi_package: string; version: string }>;
  cases: readonly ReviewSchedulingConformanceCase[];
}>;

function fixtureField(record: Record<string, unknown>, key: string): unknown {
  if (!(key in record)) throw new Error(`conformance fixture is missing \`${key}\``);
  return record[key];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`conformance fixture field \`${label}\` must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Parse the shared literal conformance fixture fail closed. Any unknown schema
 * version, missing section, or empty case list is rejected rather than defaulted.
 */
export function parseReviewSchedulingConformanceFixture(
  value: unknown,
): ReviewSchedulingConformanceFixture {
  const record = asRecord(value, "fixture");
  if (fixtureField(record, "schema_version") !== VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported conformance fixture schema version ${String(record.schema_version)}`,
    );
  }
  for (const key of [
    "fixture_id",
    "selected_authority",
    "policy_id",
    "fsrs",
    "status_ratings",
    "exam_margin_seconds",
    "memory_state_tolerance",
    "oracle",
    "cases",
  ]) {
    fixtureField(record, key);
  }
  const cases = record.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("conformance fixture must contain at least one case");
  }
  for (const row of cases) {
    const entry = asRecord(row, "case");
    fixtureField(entry, "case_id");
    asRecord(fixtureField(entry, "input"), "case.input");
    const decision = asRecord(
      fixtureField(asRecord(fixtureField(entry, "expected"), "case.expected"), "decision"),
      "case.expected.decision",
    );
    if (decision.schema_version !== VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION) {
      throw new Error("conformance fixture contains a non-v1 expected decision");
    }
  }
  return record as unknown as ReviewSchedulingConformanceFixture;
}
