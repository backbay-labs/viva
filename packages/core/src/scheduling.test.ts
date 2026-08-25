import { describe, expect, test } from "bun:test";
import { Rating } from "ts-fsrs";
import {
  buildReviewSchedule,
  conceptStatusToRating,
  decideReviewSchedule,
  humanInterval,
  type PersistedFsrsCardV1,
  type ProjectedReviewScheduleItem,
  REVIEW_CAP_EXPLANATIONS,
  type ReviewScheduleInput,
  reviewIntervalFromProjection,
  scheduleConceptReview,
  VIVA_REVIEW_EXAM_MARGIN_SECONDS,
} from "./scheduling";

const NOW = new Date("2026-06-17T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const MATURE_CARD: PersistedFsrsCardV1 = {
  schema_version: 1,
  due_at: "2026-06-17T12:00:00.000Z",
  stability: 8.2956,
  difficulty: 5.2,
  elapsed_days: 0,
  scheduled_days: 8,
  reps: 1,
  lapses: 0,
  state: "review",
  last_review_at: "2026-06-09T12:00:00.000Z",
};

describe("conceptStatusToRating", () => {
  test("maps each concept status to the D-01 recorded FSRS rating", () => {
    expect(conceptStatusToRating("missed")).toBe(Rating.Again);
    expect(conceptStatusToRating("review")).toBe(Rating.Hard);
    expect(conceptStatusToRating("shaky")).toBe(Rating.Good);
    expect(conceptStatusToRating("strong")).toBe(Rating.Easy);
  });
});

describe("humanInterval", () => {
  test("renders calendar distance in warm, number-free-ish language", () => {
    expect(humanInterval(NOW, NOW)).toBe("today");
    expect(humanInterval(NOW, new Date(NOW.getTime() + DAY))).toBe("tomorrow");
    expect(humanInterval(NOW, new Date(NOW.getTime() + 5 * DAY))).toBe("in 5 days");
  });
});

describe("scheduleConceptReview", () => {
  const base: ReviewScheduleInput = {
    conceptId: "nadh",
    label: "NADH",
    status: "strong",
    misses: 0,
    hinted: false,
    centrality: 50,
    now: NOW,
  };

  test("strong unaided answers schedule later than shaky answers", () => {
    const strong = scheduleConceptReview(base);
    const shaky = scheduleConceptReview({ ...base, status: "shaky" });

    expect(strong.dueAt.getTime()).toBeGreaterThan(shaky.dueAt.getTime());
    expect(strong.authority).toBe("core_fsrs");
    expect(strong.explanation).toContain("FSRS rating: Easy");
  });

  test("misses and high centrality pull weak concepts forward", () => {
    const item = scheduleConceptReview({
      ...base,
      status: "missed",
      misses: 3,
      centrality: 96,
    });

    expect(humanInterval(NOW, item.dueAt)).toBe("tomorrow");
    expect(item.priority).toBe("urgent");
    expect(item.explanation.join(" ")).toContain("3 prior misses");
    expect(item.explanation.join(" ")).toContain("high-centrality concept");
  });

  test("hint-assisted answers are scheduled sooner than unaided answers", () => {
    const unaided = scheduleConceptReview({ ...base, status: "strong", hinted: false });
    const hinted = scheduleConceptReview({ ...base, status: "strong", hinted: true });

    expect(hinted.dueAt.getTime()).toBeLessThan(unaided.dueAt.getTime());
    expect(hinted.explanation.join(" ")).toContain("hint-assisted");
  });

  test("near exams cap the interval before the exam date", () => {
    const item = scheduleConceptReview({
      ...base,
      status: "strong",
      examDate: new Date("2026-06-19T12:00:00.000Z"),
    });

    expect(item.dueAt.getTime()).toBeLessThanOrEqual(
      new Date("2026-06-18T12:00:00.000Z").getTime(),
    );
    expect(item.explanation.join(" ")).toContain("exam-near cap");
  });

  test("under-24-hour exams never schedule after the exam time", () => {
    const examDate = new Date("2026-06-18T09:00:00.000Z");
    const item = scheduleConceptReview({
      ...base,
      status: "strong",
      examDate,
    });

    expect(item.dueAt.getTime()).toBeLessThan(examDate.getTime());
    expect(item.explanation.join(" ")).toContain("exam-near cap");
  });

  test("high centrality pulls strong concepts forward", () => {
    const ordinary = scheduleConceptReview({ ...base, centrality: 35 });
    const central = scheduleConceptReview({ ...base, centrality: 96 });

    expect(central.dueAt.getTime()).toBeLessThan(ordinary.dueAt.getTime());
    expect(central.explanation.join(" ")).toContain("high-centrality concept");
  });

  test("stale session recency pulls concepts forward", () => {
    const recent = scheduleConceptReview({
      ...base,
      lastReviewedAt: new Date("2026-06-16T12:00:00.000Z"),
    });
    const stale = scheduleConceptReview({
      ...base,
      lastReviewedAt: new Date("2026-05-20T12:00:00.000Z"),
    });

    expect(stale.dueAt.getTime()).toBeLessThan(recent.dueAt.getTime());
    expect(stale.explanation.join(" ")).toContain("session recency cap");
  });

  test("no exam date still produces an explainable schedule", () => {
    const item = scheduleConceptReview({ ...base, examDate: undefined });

    expect(item.intervalLabel.length).toBeGreaterThan(0);
    expect(item.explanation.join(" ")).not.toContain("exam-near cap");
  });

  test("advisor due dates are ignored as authority", () => {
    const item = scheduleConceptReview({
      ...base,
      advisorDueAt: "2099-01-01T00:00:00Z",
    });

    expect(item.dueAt.toISOString()).not.toBe("2099-01-01T00:00:00.000Z");
    expect(item.ignoredAdvisorDueAt).toBe("2099-01-01T00:00:00Z");
  });

  test("a persisted prior card accumulates instead of restarting from an empty card", () => {
    const firstReview = scheduleConceptReview(base);
    const laterReview = scheduleConceptReview({ ...base, priorCard: MATURE_CARD });

    expect(laterReview.dueAt.getTime()).toBeGreaterThan(firstReview.dueAt.getTime());
    expect(laterReview.card.reps).toBe(MATURE_CARD.reps + 1);
    expect(laterReview.card.stability).toBeGreaterThan(MATURE_CARD.stability);
  });

  test("the displayed date carries the authoritative decision and never runs past it", () => {
    for (const status of ["strong", "shaky", "review", "missed"] as const) {
      const item = scheduleConceptReview({ ...base, status, centrality: 96, hinted: true });
      const authoritative = decideReviewSchedule({
        status,
        now: NOW,
        hintCount: null,
        missCount: null,
        examAt: null,
        priorCard: null,
      });

      expect(item.authoritativeDueAt.toISOString()).toBe(authoritative.due_at);
      expect(item.dueAt.getTime()).toBeLessThanOrEqual(item.authoritativeDueAt.getTime());
      expect(item.capReason).toBe(null);
    }
  });

  test("the exam cap is exactly the recorded D-01 86400-second margin", () => {
    const examDate = new Date("2026-06-24T09:00:00.000Z");
    const item = scheduleConceptReview({ ...base, status: "strong", examDate });

    expect(item.authoritativeDueAt.toISOString()).toBe(
      new Date(examDate.getTime() - VIVA_REVIEW_EXAM_MARGIN_SECONDS * 1000).toISOString(),
    );
    expect(item.capReason).toBe("exam_margin");
  });

  test("an already-past exam fails closed at the exam instant", () => {
    const examDate = new Date("2026-06-10T09:00:00.000Z");
    const item = scheduleConceptReview({ ...base, status: "strong", examDate });

    expect(item.authoritativeDueAt.toISOString()).toBe(examDate.toISOString());
    expect(item.dueAt.getTime()).toBeLessThanOrEqual(examDate.getTime());
    expect(item.capReason).toBe("past_exam");
  });

  test("hints and misses are provenance only and never move the authoritative rating", () => {
    const unaided = decideReviewSchedule({
      status: "strong",
      now: NOW,
      hintCount: 0,
      missCount: 0,
      examAt: null,
      priorCard: null,
    });
    const hinted = decideReviewSchedule({
      status: "strong",
      now: NOW,
      hintCount: 4,
      missCount: 7,
      examAt: null,
      priorCard: null,
    });

    expect(hinted.rating).toBe(unaided.rating);
    expect(hinted.due_at).toBe(unaided.due_at);
    expect(hinted.hint_count).toBe(4);
    expect(hinted.miss_count).toBe(7);
  });
});

describe("buildReviewSchedule", () => {
  test("sorts urgent review items before later strong concepts", () => {
    const items = buildReviewSchedule([
      {
        conceptId: "strong",
        label: "Strong concept",
        status: "strong",
        misses: 0,
        hinted: false,
        centrality: 35,
        now: NOW,
      },
      {
        conceptId: "missed",
        label: "Missed concept",
        status: "missed",
        misses: 2,
        hinted: true,
        centrality: 94,
        now: NOW,
      },
    ]);

    expect(items[0]?.conceptId).toBe("missed");
    expect(items[0]?.priority).toBe("urgent");
  });
});

/**
 * LEARN-003A: `explanation[]` is the learner/operator-facing reasoning trail, so a
 * cap entry may appear only when that cap actually lowered the running due date.
 * Each row names one candidate, an input that exercises it, and whether that
 * candidate is expected to bind.
 */
describe("cap explanation truthfulness", () => {
  const base: ReviewScheduleInput = {
    conceptId: "nadh",
    label: "NADH",
    status: "strong",
    misses: 0,
    hinted: false,
    centrality: 50,
    now: NOW,
  };

  const rows: ReadonlyArray<{
    candidate: keyof typeof REVIEW_CAP_EXPLANATIONS;
    name: string;
    input: ReviewScheduleInput;
    binds: boolean;
  }> = [
    {
      candidate: "exam",
      name: "an exam inside the strong interval",
      input: { ...base, examDate: new Date(NOW.getTime() + 3 * DAY) },
      binds: true,
    },
    {
      candidate: "exam",
      name: "an exam far past the strong interval",
      input: { ...base, examDate: new Date(NOW.getTime() + 60 * DAY) },
      binds: false,
    },
    {
      candidate: "exam",
      // The review's own example: a missed concept is already due tomorrow, so an
      // exam three days out changes nothing.
      name: "an exam beyond a missed concept already due tomorrow",
      input: { ...base, status: "missed", examDate: new Date(NOW.getTime() + 3 * DAY) },
      binds: false,
    },
    {
      candidate: "miss",
      name: "a missed concept whose FSRS date is already tomorrow",
      input: { ...base, status: "missed", misses: 3 },
      binds: false,
    },
    {
      candidate: "hint",
      name: "a hint on a strong eight-day interval",
      input: { ...base, hinted: true },
      binds: true,
    },
    {
      candidate: "hint",
      name: "a hint on a concept already due tomorrow",
      input: { ...base, status: "missed", hinted: true },
      binds: false,
    },
    {
      candidate: "centrality",
      name: "high centrality on a strong eight-day interval",
      input: { ...base, centrality: 96 },
      binds: true,
    },
    {
      candidate: "centrality",
      name: "high centrality behind a tighter hint cap",
      input: { ...base, centrality: 96, hinted: true },
      binds: false,
    },
    {
      candidate: "recency",
      name: "a stale last review on a strong eight-day interval",
      input: { ...base, lastReviewedAt: new Date(NOW.getTime() - 28 * DAY) },
      binds: true,
    },
    {
      candidate: "recency",
      name: "a stale last review behind an equal hint cap",
      input: { ...base, hinted: true, lastReviewedAt: new Date(NOW.getTime() - 28 * DAY) },
      binds: false,
    },
    {
      candidate: "recency",
      name: "a last review inside the recency window",
      input: { ...base, lastReviewedAt: new Date(NOW.getTime() - 1 * DAY) },
      binds: false,
    },
  ];

  for (const row of rows) {
    test(`${row.candidate}: ${row.name} ${row.binds ? "explains" : "explains nothing"}`, () => {
      const item = scheduleConceptReview(row.input);
      const entry = REVIEW_CAP_EXPLANATIONS[row.candidate];
      const matching = item.explanation.filter((line) => line.startsWith(entry));

      expect(matching.length).toBe(row.binds ? 1 : 0);
      if (row.binds) {
        const uncapped = decideReviewSchedule({
          status: row.input.status,
          now: row.input.now,
          hintCount: null,
          missCount: null,
          examAt: null,
          priorCard: null,
        });
        expect(item.dueAt.getTime()).toBeLessThan(new Date(uncapped.due_at).getTime());
      }
    });
  }

  test("a schedule with no binding cap explains no cap at all", () => {
    const item = scheduleConceptReview(base);

    for (const entry of Object.values(REVIEW_CAP_EXPLANATIONS)) {
      expect(item.explanation.some((line) => line.startsWith(entry))).toBe(false);
    }
    expect(item.dueAt.getTime()).toBe(item.authoritativeDueAt.getTime());
  });

  test("only the caps that lowered the date are explained when several apply", () => {
    // Exam-margin first (one day out), then nothing else can lower it further.
    const item = scheduleConceptReview({
      ...base,
      status: "missed",
      misses: 4,
      hinted: true,
      centrality: 99,
      lastReviewedAt: new Date(NOW.getTime() - 28 * DAY),
      examDate: new Date(NOW.getTime() + 3 * DAY),
    });

    for (const entry of Object.values(REVIEW_CAP_EXPLANATIONS)) {
      expect(item.explanation.some((line) => line.startsWith(entry))).toBe(false);
    }
    expect(humanInterval(NOW, item.dueAt)).toBe("tomorrow");
  });

  test("every cap explanation constant is distinct", () => {
    const entries = Object.values(REVIEW_CAP_EXPLANATIONS);
    expect(new Set(entries).size).toBe(entries.length);
  });
});

/**
 * LEARN-003A: the browser consumes the persisted D-01A schedule and formats it.
 * It never estimates an interval from a status, so a concept with no persisted
 * review has no interval to render at all.
 */
describe("reviewIntervalFromProjection", () => {
  const schedule: ProjectedReviewScheduleItem[] = [
    { conceptId: "nadh", dueAt: "2026-06-19T12:00:00.000Z", authority: "server_persisted_fsrs" },
    {
      conceptId: "atp-synthase",
      dueAt: "2026-06-25T12:00:00.000Z",
      authority: "server_persisted_fsrs",
    },
  ];

  test("renders the persisted due date for the named concept", () => {
    expect(reviewIntervalFromProjection(schedule, "nadh", NOW)).toBe("in 2 days");
    expect(reviewIntervalFromProjection(schedule, "atp-synthase", NOW)).toBe("in 8 days");
  });

  test("a concept with no persisted review has no interval, not an estimate", () => {
    expect(reviewIntervalFromProjection(schedule, "glycolysis", NOW)).toBe(null);
    expect(reviewIntervalFromProjection([], "nadh", NOW)).toBe(null);
  });

  test("rejects a duplicated concept instead of picking one", () => {
    expect(() =>
      reviewIntervalFromProjection(
        [
          schedule[0] as ProjectedReviewScheduleItem,
          { ...(schedule[0] as ProjectedReviewScheduleItem), dueAt: "2026-07-01T12:00:00.000Z" },
        ],
        "nadh",
        NOW,
      ),
    ).toThrow(/duplicate/i);
  });

  test("rejects an unparseable due date instead of rendering it", () => {
    expect(() =>
      reviewIntervalFromProjection(
        [{ conceptId: "nadh", dueAt: "friday", authority: "server_persisted_fsrs" }],
        "nadh",
        NOW,
      ),
    ).toThrow(/due date/i);
  });

  test("rejects an authority the recorded decision did not select", () => {
    expect(() =>
      reviewIntervalFromProjection(
        [
          {
            conceptId: "nadh",
            dueAt: "2026-06-19T12:00:00.000Z",
            authority: "core_fsrs_read_time" as ProjectedReviewScheduleItem["authority"],
          },
        ],
        "nadh",
        NOW,
      ),
    ).toThrow(/authority/i);
  });
});

/**
 * Assert that a write to deep-frozen data fails instead of silently succeeding.
 *
 * ES modules are always strict mode, so assigning to a frozen property — or
 * extending a frozen array — throws a `TypeError`. The engine's message differs
 * between assignment and extension, so the assertion is on the error type.
 */
function expectFrozenWrite(mutate: () => void): void {
  let thrown: unknown;
  try {
    mutate();
  } catch (error) {
    thrown = error;
  }
  expect(thrown instanceof TypeError ? "TypeError" : String(thrown)).toBe("TypeError");
}

/**
 * `LEARN-010` — a persisted scheduling decision and its FSRS card are facts.
 *
 * `decideReviewSchedule` is the one authority; its result is persisted verbatim
 * and mirrored into the recap, the concept `dueAt`, and the authenticated study
 * projection. A caller that can edit the returned decision — or the card inside
 * it — can make those four surfaces disagree about the same concept without any
 * store write. The same batch removes the uncapped status-only estimate: a
 * concept the server never scheduled has no interval, not a guess.
 */
describe("LEARN-010 immutable schedule decisions and honest exports", () => {
  const decisionInput = {
    status: "shaky" as const,
    now: NOW,
    hintCount: null,
    missCount: null,
    examAt: null,
    priorCard: null,
  };

  const scheduleInput: ReviewScheduleInput = {
    conceptId: "nadh",
    label: "NADH",
    status: "shaky",
    misses: 0,
    hinted: false,
    centrality: 40,
    now: NOW,
  };

  test("a persisted schedule decision cannot be rewritten after it is returned", () => {
    const decision = decideReviewSchedule(decisionInput);
    const before = JSON.stringify(decision);
    const mutable = decision as unknown as { due_at: string; policy_id: string };

    expect(Object.isFrozen(decision)).toBe(true);
    expectFrozenWrite(() => {
      mutable.due_at = "2099-01-01T00:00:00.000Z";
    });
    expectFrozenWrite(() => {
      mutable.policy_id = "viva.fixture.1";
    });

    expect(JSON.stringify(decision)).toBe(before);
  });

  test("the persisted FSRS card is frozen in the decision and in the schedule item", () => {
    const decision = decideReviewSchedule({ ...decisionInput, priorCard: MATURE_CARD });
    const before = JSON.stringify(decision.card);
    const card = decision.card as unknown as { stability: number; reps: number };

    expect(Object.isFrozen(decision.card)).toBe(true);
    expectFrozenWrite(() => {
      card.stability = 999;
    });
    expectFrozenWrite(() => {
      card.reps = 0;
    });
    expect(JSON.stringify(decision.card)).toBe(before);

    const item = scheduleConceptReview({ ...scheduleInput, priorCard: MATURE_CARD });
    const itemCard = item.card as unknown as { difficulty: number };

    expect(Object.isFrozen(item.card)).toBe(true);
    expectFrozenWrite(() => {
      itemCard.difficulty = 1;
    });
  });

  test("freezing the decision does not change the schedule it produces", () => {
    const item = scheduleConceptReview(scheduleInput);
    const decision = decideReviewSchedule(decisionInput);

    expect(item.authoritativeDueAt.toISOString()).toBe(decision.due_at);
    expect(item.card).toEqual(decision.card);
  });

  test("production exports carry no empty-card status-only estimate", async () => {
    const scheduling = await import("./scheduling");
    const exported = Object.keys(scheduling);

    expect(exported).not.toContain("dueDateForStatus");
    expect(exported).not.toContain("reviewIntervalForStatus");
    expect(exported.filter((name) => /ForStatus$/.test(name))).toEqual([]);
    expect(exported).toContain("reviewIntervalFromProjection");
    expect(exported).toContain("decideReviewSchedule");
  });
});
