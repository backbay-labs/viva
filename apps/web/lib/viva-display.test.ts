import { describe, expect, test } from "bun:test";
import {
  type ConceptStatus,
  createStudySetPreview,
  parseVivaClientFrame,
  parseVivaServerFrame,
  type SessionRecap,
  seedStudySets,
} from "@viva/core";
import fakeSessionFixture from "../../../agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-runtime-session.json";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/v5/synthetic-runtime-session.json";
import {
  correctionQuote,
  recapPlanFromSessionEvents,
  recapStats,
  reviewPlanFromRecap,
  uploadPreviewSummary,
} from "./viva-display";
import { projectConceptNodes } from "./viva-session-projection";

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
      missedConcepts: ["ATP synthase"],
      reviewLater: ["ATP synthase"],
      nextAction: "Review ATP synthase tomorrow",
      plan: [],
      sourceMoments: [],
    };

    const plan = reviewPlanFromRecap(recap, seedStudySets[0], new Date("2026-06-17T12:00:00Z"));

    expect(plan[0]?.label).toBe("ATP synthase");
    expect(plan[0]?.authority).toBe("core_fsrs");
    expect(plan[0]?.intervalLabel).toBe("tomorrow");
  });

  test("names only the binding cap when hint, exam proximity, and recency signals compete", () => {
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
    // D-01A truthful explanations: a cap is named only when it actually bound
    // the displayed date; the non-binding recency signal must not be claimed.
    expect(plan[0]?.explanation.join(" ")).not.toContain("session recency cap");
  });

  test("does not fuzzy-match recap labels into FSRS cards", () => {
    const recap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Recap",
      summary: "Summary",
      strongConcepts: [],
      shakyConcepts: [],
      missedConcepts: ["ATP"],
      reviewLater: ["ATP"],
      nextAction: "Review ATP tomorrow",
      plan: [],
      sourceMoments: [],
    };

    const plan = reviewPlanFromRecap(recap, seedStudySets[0], new Date("2026-06-17T12:00:00Z"));

    expect(plan).toEqual([]);
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
        "atp-synthase": "missed",
        nadh: "strong",
        "oxidative-phosphorylation": "shaky",
      },
      now: new Date("2026-06-17T12:00:00Z"),
      recap,
      studySet: seedStudySets[0],
    });

    expect(projection.recap?.strongConcepts).toEqual(["NADH"]);
    expect(projection.recap?.shakyConcepts).toEqual(["Oxidative phosphorylation"]);
    expect(projection.recap?.missedConcepts).toEqual(["ATP synthase"]);
    expect(projection.recap?.reviewLater).toEqual(["Oxidative phosphorylation", "ATP synthase"]);
    expect(projection.recap?.strongConcepts).not.toContain("Photosynthesis");
    expect(projection.recap?.nextAction).toBe(
      "Rebuild ATP synthase from the source, then answer it once without hints.",
    );
    expect(projection.recap?.nextAction).not.toContain("Fixture");
    expect(projection.reviewPlan[0]?.conceptId).toBe("atp-synthase");
    expect(projection.reviewPlan[0]?.label).toBe("ATP synthase");
    expect(projection.reviewPlan[0]?.authority).toBe("core_fsrs");
    expect(projection.reviewPlan[0]?.status).toBe("missed");
  });

  test("ignores orphan concept_status ids instead of inventing nodes or FSRS cards", () => {
    const recap: SessionRecap = {
      durationLabel: "Agent session",
      headline: "Fixture recap",
      summary: "Fixture summary",
      strongConcepts: [],
      shakyConcepts: [],
      missedConcepts: ["Fixture stale id"],
      reviewLater: ["Fixture stale id"],
      nextAction: "Fixture action that should not ship",
      plan: [],
      sourceMoments: [],
    };

    const projection = recapPlanFromSessionEvents({
      conceptStatuses: {
        "atp-yield": "missed",
        nadh: "strong",
      },
      now: new Date("2026-06-17T12:00:00Z"),
      recap,
      studySet: seedStudySets[0],
    });

    expect(projection.recap?.strongConcepts).toEqual(["NADH"]);
    expect(projection.recap?.missedConcepts).toEqual([]);
    expect(projection.recap?.reviewLater).toEqual([]);
    expect(projection.reviewPlan.map((item) => item.conceptId)).toEqual(["nadh"]);
  });

  test("maps shared fixture concept_status ids to one Mastery node and one FSRS card", () => {
    const biology = seedStudySets[0];
    const conceptIds = biology.concepts.map((concept) => concept.id);
    expect(new Set(conceptIds).size).toBe(conceptIds.length);

    for (const fixture of [fullSessionFixture, fakeSessionFixture]) {
      const activeConcepts = new Set(activeConceptIdsFromFixture(fixture));
      const statusEntries = conceptStatusEntriesFromFixture(fixture);
      const conceptStatuses = Object.fromEntries(statusEntries);
      const nodes = projectConceptNodes(biology.concepts, conceptStatuses);
      const projection = recapPlanFromSessionEvents({
        conceptStatuses,
        now: new Date("2026-06-17T12:00:00Z"),
        recap: emptyRecap(),
        studySet: biology,
      });

      expect(new Set(statusEntries.map(([conceptId]) => conceptId)).size).toBe(
        statusEntries.length,
      );
      expect(projection.reviewPlan).toHaveLength(statusEntries.length);

      for (const [conceptId, status] of statusEntries) {
        expect(activeConcepts.has(conceptId)).toBe(true);
        expect(conceptIds).toContain(conceptId);

        const matchingNodes = nodes.filter((node) => node.id === conceptId);
        expect(matchingNodes).toHaveLength(1);
        expect(matchingNodes[0]?.status).toBe(status);

        const matchingCards = projection.reviewPlan.filter((item) => item.conceptId === conceptId);
        expect(matchingCards).toHaveLength(1);
        expect(matchingCards[0]?.status).toBe(status);
      }
    }
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
        "atp-synthase": "missed",
        "cellular-respiration": "missed",
        "oxidative-phosphorylation": "shaky",
      },
      now: new Date("2026-06-17T12:00:00Z"),
      recap,
      studySet: seedStudySets[0],
    });

    expect(projection.recap?.missedConcepts).toEqual(["Cellular respiration", "ATP synthase"]);
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

function emptyRecap(): SessionRecap {
  return {
    durationLabel: "Agent session",
    headline: "Fixture recap",
    summary: "Fixture summary",
    strongConcepts: [],
    shakyConcepts: [],
    missedConcepts: [],
    reviewLater: [],
    nextAction: "Fixture action",
    plan: [],
    sourceMoments: [],
  };
}

function activeConceptIdsFromFixture(fixture: { client: unknown[] }): string[] {
  return fixture.client.flatMap((frame) => {
    const parsed = parseVivaClientFrame(frame);
    return parsed.type === "session_config" ? parsed.session.active_concepts : [];
  });
}

function conceptStatusEntriesFromFixture(fixture: {
  server: unknown[];
}): [string, ConceptStatus][] {
  return fixture.server.flatMap((frame) => {
    const parsed = parseVivaServerFrame(frame);
    if (parsed.type !== "event" || parsed.event.type !== "concept_status") {
      return [];
    }
    return [[parsed.event.concept_id, parsed.event.status]];
  });
}
