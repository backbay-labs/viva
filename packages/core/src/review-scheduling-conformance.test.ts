import { describe, expect, test } from "bun:test";
import fixtureJson from "./review-scheduling-conformance-v1.json";
import {
  decideReviewSchedule,
  type PersistedFsrsCardV1,
  parseReviewSchedulingConformanceFixture,
  type ReviewScheduleDecisionV1,
  VIVA_REVIEW_EXAM_MARGIN_SECONDS,
  VIVA_REVIEW_SCHEDULE_POLICY_ID,
  VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION,
  VIVA_REVIEW_STATUS_RATINGS,
} from "./scheduling";

/**
 * D-01 `SERVER_PERSISTED_FSRS` conformance.
 *
 * `review-scheduling-conformance-v1.json` was derived independently of both
 * production schedulers (py-fsrs 6.3.2 in a disposable virtualenv, artifact
 * digests recorded in the fixture) and every literal was re-checked against the
 * published FSRS-6 equations. Nothing in this file may be relaxed to match an
 * implementation; a disagreement is a D-01 amendment, not a fixture edit.
 */
const fixture = parseReviewSchedulingConformanceFixture(fixtureJson);

function withinMemoryStateTolerance(actual: number, expected: number): boolean {
  const bound =
    fixture.memory_state_tolerance.absolute +
    fixture.memory_state_tolerance.relative * Math.abs(expected);
  return Math.abs(actual - expected) <= bound;
}

function expectCardMatches(actual: PersistedFsrsCardV1, expected: PersistedFsrsCardV1): void {
  expect(actual.schema_version).toBe(expected.schema_version);
  expect(actual.due_at).toBe(expected.due_at);
  expect(actual.elapsed_days).toBe(expected.elapsed_days);
  expect(actual.scheduled_days).toBe(expected.scheduled_days);
  expect(actual.reps).toBe(expected.reps);
  expect(actual.lapses).toBe(expected.lapses);
  expect(actual.state).toBe(expected.state);
  expect(actual.last_review_at).toBe(expected.last_review_at);
  expect(withinMemoryStateTolerance(actual.stability, expected.stability)).toBe(true);
  expect(withinMemoryStateTolerance(actual.difficulty, expected.difficulty)).toBe(true);
}

function expectDecisionMatches(
  actual: ReviewScheduleDecisionV1,
  expected: ReviewScheduleDecisionV1,
): void {
  expect(actual.schema_version).toBe(expected.schema_version);
  expect(actual.policy_id).toBe(expected.policy_id);
  expect(actual.generated_at).toBe(expected.generated_at);
  expect(actual.status).toBe(expected.status);
  expect(actual.rating).toBe(expected.rating);
  expect(actual.hint_count).toBe(expected.hint_count);
  expect(actual.miss_count).toBe(expected.miss_count);
  expect(actual.exam_at).toBe(expected.exam_at);
  expect(actual.exam_margin_seconds).toBe(expected.exam_margin_seconds);
  expect(actual.uncapped_due_at).toBe(expected.uncapped_due_at);
  expect(actual.due_at).toBe(expected.due_at);
  expect(actual.cap_reason).toBe(expected.cap_reason);
  expectCardMatches(actual.card, expected.card);
}

describe("D-01 conformance fixture", () => {
  test("pins the selected authority, policy, mapping, and margin", () => {
    expect(fixture.schema_version).toBe(VIVA_REVIEW_SCHEDULE_SCHEMA_VERSION);
    expect(fixture.selected_authority).toBe("SERVER_PERSISTED_FSRS");
    expect(fixture.policy_id).toBe(VIVA_REVIEW_SCHEDULE_POLICY_ID);
    expect(fixture.exam_margin_seconds).toBe(VIVA_REVIEW_EXAM_MARGIN_SECONDS);
    expect(fixture.status_ratings).toEqual(VIVA_REVIEW_STATUS_RATINGS);
    expect(fixture.fsrs.desired_retention).toBe(0.9);
    expect(fixture.fsrs.enable_fuzzing).toBe(false);
    expect(fixture.oracle.pypi_package).toBe("fsrs");
    expect(fixture.oracle.version).toBe("6.3.2");
  });

  test("is not a disguised fixed 1/2/3/8-day status lookup", () => {
    const intervals = new Set(
      fixture.cases.map((row) => row.expected.decision.card.scheduled_days),
    );
    const beyondTheFixedTable = [...intervals].filter((days) => ![1, 2, 3, 8].includes(days));
    expect(beyondTheFixedTable.length).toBeGreaterThan(0);
  });

  test("covers every required D-01 coverage row", () => {
    const inputs = fixture.cases.map((row) => row.input);
    expect(new Set(inputs.map((row) => row.status))).toEqual(
      new Set(["missed", "review", "shaky", "strong"]),
    );
    expect(inputs.some((row) => row.prior_card === null)).toBe(true);
    expect(inputs.some((row) => row.prior_card?.state === "review")).toBe(true);
    expect(inputs.some((row) => row.hint_count === null)).toBe(true);
    expect(inputs.some((row) => row.hint_count === 0)).toBe(true);
    expect(inputs.some((row) => (row.hint_count ?? 0) > 0)).toBe(true);
    expect(inputs.some((row) => row.miss_count === null)).toBe(true);
    expect(inputs.some((row) => row.miss_count === 0)).toBe(true);
    expect(inputs.some((row) => row.miss_count === 1)).toBe(true);
    expect(inputs.some((row) => (row.miss_count ?? 0) > 1)).toBe(true);
    expect(inputs.some((row) => row.exam_at === null)).toBe(true);
    expect(inputs.some((row) => row.graded_at.startsWith("2032-02-29"))).toBe(true);
    expect(inputs.some((row) => row.graded_at.includes("T23:59:59"))).toBe(true);
    expect(inputs.some((row) => row.graded_at.includes("T00:00:00"))).toBe(true);

    const capReasons = fixture.cases.map((row) => row.expected.decision.cap_reason);
    expect(capReasons).toContain("exam_margin");
    expect(capReasons).toContain("past_exam");
    expect(capReasons).toContain(null);
  });

  test("no expected review is ever scheduled after its exam", () => {
    for (const row of fixture.cases) {
      const { exam_at: examAt, due_at: dueAt } = row.expected.decision;
      if (examAt === null) continue;
      expect(Date.parse(dueAt)).toBeLessThanOrEqual(Date.parse(examAt));
    }
  });

  test("rejects an unknown fixture schema version", () => {
    expect(() =>
      parseReviewSchedulingConformanceFixture({ ...fixtureJson, schema_version: 2 }),
    ).toThrow();
  });

  test("rejects a fixture whose cases are missing", () => {
    const { cases: _cases, ...withoutCases } = fixtureJson;
    expect(() => parseReviewSchedulingConformanceFixture(withoutCases)).toThrow();
  });
});

describe("decideReviewSchedule reproduces the independent fixture", () => {
  for (const row of fixture.cases) {
    test(row.case_id, () => {
      const decision = decideReviewSchedule({
        status: row.input.status,
        now: new Date(row.input.graded_at),
        hintCount: row.input.hint_count,
        missCount: row.input.miss_count,
        examAt: row.input.exam_at === null ? null : new Date(row.input.exam_at),
        priorCard: row.input.prior_card,
      });

      expectDecisionMatches(decision, row.expected.decision);
    });
  }

  test("reads only the injected instant, never the ambient wall clock", () => {
    const row = fixture.cases[0];
    if (row === undefined) throw new Error("fixture must contain at least one case");
    const first = decideReviewSchedule({
      status: row.input.status,
      now: new Date(row.input.graded_at),
      hintCount: row.input.hint_count,
      missCount: row.input.miss_count,
      examAt: null,
      priorCard: null,
    });
    const second = decideReviewSchedule({
      status: row.input.status,
      now: new Date(row.input.graded_at),
      hintCount: row.input.hint_count,
      missCount: row.input.miss_count,
      examAt: null,
      priorCard: null,
    });
    expect(second).toEqual(first);
    expect(first.generated_at).toBe(row.input.graded_at);
  });

  test("keeps unknown hint and miss provenance null instead of zero", () => {
    const decision = decideReviewSchedule({
      status: "shaky",
      now: new Date("2031-04-05T12:00:00.000Z"),
      examAt: null,
      priorCard: null,
    });
    expect(decision.hint_count).toBe(null);
    expect(decision.miss_count).toBe(null);
  });
});
