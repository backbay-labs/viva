import { describe, expect, test } from "bun:test";
import { createStudySetPreview, type SessionRecap, seedStudySets } from "@viva/core";
import {
  correctionQuote,
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
});
