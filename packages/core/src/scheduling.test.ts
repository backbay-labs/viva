import { describe, expect, test } from "bun:test";
import { Rating } from "ts-fsrs";
import {
  buildReviewSchedule,
  conceptStatusToRating,
  dueDateForStatus,
  humanInterval,
  type ReviewScheduleInput,
  reviewIntervalForStatus,
  scheduleConceptReview,
} from "./scheduling";

const NOW = new Date("2026-06-17T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("conceptStatusToRating", () => {
  test("maps each concept status to an FSRS rating", () => {
    expect(conceptStatusToRating("missed")).toBe(Rating.Again);
    expect(conceptStatusToRating("shaky")).toBe(Rating.Hard);
    expect(conceptStatusToRating("review")).toBe(Rating.Good);
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

describe("dueDateForStatus", () => {
  test("schedules every status into the future", () => {
    for (const status of ["strong", "shaky", "missed", "review"] as const) {
      expect(dueDateForStatus(status, NOW).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  test("a strong answer earns a longer interval than a missed one", () => {
    expect(dueDateForStatus("strong", NOW).getTime()).toBeGreaterThan(
      dueDateForStatus("missed", NOW).getTime(),
    );
  });
});

describe("reviewIntervalForStatus", () => {
  test("returns a non-empty human interval string", () => {
    const phrase = reviewIntervalForStatus("shaky", NOW);
    expect(phrase.length).toBeGreaterThan(0);
    expect(/today|tomorrow|day/.test(phrase)).toBe(true);
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
