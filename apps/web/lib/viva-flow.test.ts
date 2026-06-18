import { describe, expect, test } from "bun:test";
import { buildSessionRecap, createStudySetPreview, evaluateAnswer } from "@viva/core";

describe("Viva web prototype flow", () => {
  test("can create, evaluate, and recap a local study session", () => {
    const studySet = createStudySetPreview({
      courseName: "Biology Midterm",
      examDate: "2026-06-19",
      pastedText: "NADH donates electrons to the electron transport chain.",
      fileNames: ["Lecture 5.pdf"],
    });
    const evaluation = evaluateAnswer("NADH is an electron donor to the electron transport chain.");
    const recap = buildSessionRecap(evaluation);

    expect(studySet.docs.length).toBeGreaterThan(0);
    expect(evaluation.source.label).toContain("Lecture");
    expect(recap.nextAction).toBe("Schedule tomorrow's recall drill");
  });
});
