import { describe, expect, test } from "bun:test";
import { createStudySetPreview, type SessionRecap, seedStudySets } from "@viva/core";
import {
  correctionQuote,
  recapPlanFromSessionEvents,
  recapStats,
  reviewPlanFromRecap,
  uploadPreviewSummary,
} from "./viva-display";

describe("Viva display state", () => {
  test("keeps local upload preview honest while ingestion is pending", () => {
    const studySet = createStudySetPreview({
      courseName: "Biology Midterm",
      pastedText: "NADH notes",
      fileNames: ["Lecture 5.pdf"],
    });

    expect(uploadPreviewSummary(studySet)).toEqual({
      conceptLabel: "Awaiting real concept extraction",
      overflowLabel: "Extraction pending",
    });
  });

  test("computes recap stats from recap arrays without demo padding", () => {
    const recap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Recap",
      summary: "Summary",
      strongConcepts: ["nadh"],
      shakyConcepts: ["atp synthase"],
      missedConcepts: [],
      reviewLater: ["oxidative phosphorylation", "shuttle systems"],
      nextAction: "Review tomorrow",
      plan: [],
      sourceMoments: [],
    };

    expect(recapStats(recap)).toEqual([
      { color: "var(--sage)", label: "Strong", pct: 25, topics: 1 },
      { color: "var(--amber)", label: "Shaky", pct: 25, topics: 1 },
      { color: "var(--plum)", label: "Review tomorrow", pct: 50, topics: 2 },
    ]);
  });

  test("never substitutes source metadata for missing spoken transcript", () => {
    expect(correctionQuote("")).toBe("No browser transcript captured");
    expect(correctionQuote("NADH donates electrons")).toBe('"NADH donates electrons"');
  });

  test("builds core-owned next-session review plan from recap verdicts", () => {
    const recap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Recap",
      summary: "Summary",
      strongConcepts: ["NADH"],
      shakyConcepts: ["Oxidative phosphorylation"],
      missedConcepts: ["ATP yield"],
      reviewLater: ["ATP yield"],
      nextAction: "Review ATP yield tomorrow",
      plan: [],
      sourceMoments: [],
    };

    const plan = reviewPlanFromRecap(recap, seedStudySets[0], new Date("2026-06-17T12:00:00Z"));

    expect(plan[0]?.label).toBe("ATP yield");
    expect(plan[0]?.authority).toBe("core_fsrs");
    expect(plan[0]?.intervalLabel).toBe("tomorrow");
  });

  test("passes hint, exam proximity, and recency signals into recap review scheduling", () => {
    const recap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Recap",
      summary: "Summary",
      strongConcepts: ["NADH"],
      shakyConcepts: [],
      missedConcepts: [],
      reviewLater: [],
      nextAction: "Review NADH before the exam",
      plan: [],
      sourceMoments: [],
    };

    const plan = reviewPlanFromRecap(recap, seedStudySets[0], new Date("2026-06-17T12:00:00Z"), {
      hinted: true,
      lastReviewedAt: new Date("2026-05-20T12:00:00Z"),
    });

    expect(plan[0]?.label).toBe("NADH");
    expect(plan[0]?.explanation.join(" ")).toContain("hint-assisted");
    expect(plan[0]?.explanation.join(" ")).toContain("exam-near cap");
    expect(plan[0]?.explanation.join(" ")).toContain("session recency cap");
  });

  test("derives mixed recap buckets and next action from actual concept_status events", () => {
    const recap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Fixture recap",
      summary: "Fixture summary",
      strongConcepts: ["Photosynthesis"],
      shakyConcepts: [],
      missedConcepts: [],
      reviewLater: ["Photosynthesis"],
      nextAction: "Fixture action that should not ship",
      plan: [],
      sourceMoments: [],
    };

    const projection = recapPlanFromSessionEvents({
      conceptStatuses: {
        "atp-yield": "missed",
        nadh: "strong",
        "oxidative-phosphorylation": "shaky",
      },
      now: new Date("2026-06-17T12:00:00Z"),
      recap,
      studySet: seedStudySets[0],
    });

    expect(projection.recap?.strongConcepts).toEqual(["NADH"]);
    expect(projection.recap?.shakyConcepts).toEqual(["Oxidative phosphorylation"]);
    expect(projection.recap?.missedConcepts).toEqual(["ATP yield"]);
    expect(projection.recap?.reviewLater).toEqual(["Oxidative phosphorylation", "ATP yield"]);
    expect(projection.recap?.strongConcepts).not.toContain("Photosynthesis");
    expect(projection.recap?.nextAction).toBe(
      "Rebuild ATP yield from the source, then answer it once without hints.",
    );
    expect(projection.recap?.nextAction).not.toContain("Fixture");
    expect(projection.reviewPlan[0]?.conceptId).toBe("atp-yield");
    expect(projection.reviewPlan[0]?.label).toBe("ATP yield");
    expect(projection.reviewPlan[0]?.authority).toBe("core_fsrs");
    expect(projection.reviewPlan[0]?.status).toBe("missed");
  });

  test("derives all-strong recap action without inventing weak concepts", () => {
    const recap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "All strong",
      summary: "Summary",
      strongConcepts: [],
      shakyConcepts: ["Fixture weak item"],
      missedConcepts: [],
      reviewLater: ["Fixture weak item"],
      nextAction: "Review the fixture weak item",
      plan: [],
      sourceMoments: [],
    };

    const projection = recapPlanFromSessionEvents({
      conceptStatuses: {
        glycolysis: "strong",
        nadh: "strong",
      },
      now: new Date("2026-06-17T12:00:00Z"),
      recap,
      studySet: seedStudySets[0],
    });

    expect(projection.recap?.strongConcepts).toEqual(["Glycolysis", "NADH"]);
    expect(projection.recap?.shakyConcepts).toEqual([]);
    expect(projection.recap?.missedConcepts).toEqual([]);
    expect(projection.recap?.reviewLater).toEqual([]);
    expect(projection.recap?.nextAction).toBe(
      `Bank this pass; return to ${projection.reviewPlan[0]?.label} for spaced recall ${projection.reviewPlan[0]?.intervalLabel}.`,
    );
    expect(projection.reviewPlan.every((item) => item.status === "strong")).toBe(true);
  });

  test("prioritizes missed-heavy sessions by weakest scheduled concept", () => {
    const recap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Missed-heavy",
      summary: "Summary",
      strongConcepts: [],
      shakyConcepts: [],
      missedConcepts: [],
      reviewLater: [],
      nextAction: "Generic fixture action",
      plan: [],
      sourceMoments: [],
    };

    const projection = recapPlanFromSessionEvents({
      conceptStatuses: {
        "atp-yield": "missed",
        "cellular-respiration": "missed",
        "oxidative-phosphorylation": "shaky",
      },
      now: new Date("2026-06-17T12:00:00Z"),
      recap,
      studySet: seedStudySets[0],
    });

    expect(projection.recap?.missedConcepts).toEqual(["Cellular respiration", "ATP yield"]);
    expect(projection.reviewPlan[0]?.status).toBe("missed");
    expect(projection.recap?.nextAction).toBe(
      `Rebuild ${projection.reviewPlan[0]?.label} from the source, then answer it once without hints.`,
    );
  });

  test("returns no recap projection for no-recap early-end sessions", () => {
    const projection = recapPlanFromSessionEvents({
      conceptStatuses: {
        nadh: "shaky",
      },
      now: new Date("2026-06-17T12:00:00Z"),
      recap: undefined,
      studySet: seedStudySets[0],
    });

    expect(projection).toEqual({ recap: undefined, reviewPlan: [] });
  });
});
