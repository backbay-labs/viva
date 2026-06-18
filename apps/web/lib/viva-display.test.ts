import { describe, expect, test } from "bun:test";
import { createStudySetPreview, type SessionRecap } from "@viva/core";
import { correctionQuote, recapStats, uploadPreviewSummary } from "./viva-display";

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
});
