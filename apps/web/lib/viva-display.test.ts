import { describe, expect, test } from "bun:test";
import {
  type AuthenticatedStudyProjectionV1,
  createStudySetPreview,
  type SessionRecap,
} from "@viva/core";
import {
  correctionQuote,
  recapStats,
  sessionReviewDueAt,
  sessionReviewPlanFromProjection,
  studyProjectionReadiness,
  uploadPreviewSummary,
} from "./viva-display";

const NOW = new Date("2026-08-26T09:00:00.000Z");

function thermoProjection(
  overrides: Partial<AuthenticatedStudyProjectionV1> = {},
): AuthenticatedStudyProjectionV1 {
  return {
    activeQuestion: {
      conceptId: "enthalpy",
      id: "q-enthalpy-1",
      prompt: "Why is enthalpy a state function?",
      sourceCitations: [],
    },
    concepts: [
      {
        dueAt: "2026-08-29T09:00:00.000Z",
        id: "enthalpy",
        label: "Enthalpy",
        lastReviewedAt: "2026-08-20T09:00:00.000Z",
        status: "shaky",
      },
      {
        dueAt: "2026-08-27T09:00:00.000Z",
        id: "gibbs-free-energy",
        label: "Gibbs free energy",
        lastReviewedAt: null,
        status: "missed",
      },
    ],
    questionProgress: { completed: 2, total: 5 },
    reviewSchedule: [
      {
        authority: "server_persisted_fsrs",
        conceptId: "enthalpy",
        dueAt: "2026-08-29T09:00:00.000Z",
      },
      {
        authority: "server_persisted_fsrs",
        conceptId: "gibbs-free-energy",
        dueAt: "2026-08-27T09:00:00.000Z",
      },
    ],
    session: { goal: null, id: "voice-session-9", mode: "quiz" },
    studySet: {
      course: "CHEM-401",
      examLabel: "Oral final",
      id: "thermo-401",
      ingestionStatus: "ready",
      title: "Thermodynamic State Functions",
    },
    version: 1,
    ...overrides,
  };
}

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

  test("renders each review entry from the projection's own persisted dueAt", () => {
    const plan = sessionReviewPlanFromProjection(thermoProjection(), NOW);

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("expected a ready plan");
    expect(plan.items).toEqual([
      {
        authority: "server_persisted_fsrs",
        conceptId: "enthalpy",
        dueAt: "2026-08-29T09:00:00.000Z",
        intervalLabel: "in 3 days",
        label: "Enthalpy",
        status: "shaky",
      },
      {
        authority: "server_persisted_fsrs",
        conceptId: "gibbs-free-energy",
        dueAt: "2026-08-27T09:00:00.000Z",
        intervalLabel: "tomorrow",
        label: "Gibbs free energy",
        status: "missed",
      },
    ]);
  });

  test("one projection entry renders one interval, whichever surface reads it", () => {
    const projection = thermoProjection();
    const plan = sessionReviewPlanFromProjection(projection, NOW);

    if (plan.status !== "ready") throw new Error("expected a ready plan");
    // Ledger Minor M2: the verdict surface and the schedule surface read the
    // same persisted entry through the same reader, so they cannot disagree.
    expect(sessionReviewDueAt(projection, "enthalpy")?.toISOString()).toBe(
      "2026-08-29T09:00:00.000Z",
    );
    expect(plan.items[0]?.dueAt).toBe(projection.reviewSchedule[0]?.dueAt);
    expect(sessionReviewDueAt(projection, "not-a-concept")).toBe(null);
  });

  test("a schedule entry for an unknown concept is an invalid projection, not a guessed label", () => {
    const plan = sessionReviewPlanFromProjection(
      thermoProjection({
        reviewSchedule: [
          {
            authority: "server_persisted_fsrs",
            conceptId: "entropy",
            dueAt: "2026-08-29T09:00:00.000Z",
          },
        ],
      }),
      NOW,
    );

    expect(plan).toEqual({ status: "invalid_projection" });
  });

  test("an unparseable persisted instant refuses the whole plan", () => {
    const plan = sessionReviewPlanFromProjection(
      thermoProjection({
        reviewSchedule: [
          { authority: "server_persisted_fsrs", conceptId: "enthalpy", dueAt: "not-a-date" },
        ],
      }),
      NOW,
    );

    expect(plan).toEqual({ status: "invalid_projection" });
  });

  test("readiness is derived from the projection's ingestion status, never a fixture", () => {
    expect(studyProjectionReadiness(thermoProjection())).toEqual({
      canConnect: true,
      message: "Connected agent is serving this server-owned study set.",
      reason: "trusted",
    });
    for (const [ingestionStatus, reason] of [
      ["pending", "pending_ingestion"],
      ["processing", "processing_ingestion"],
      ["retry", "retry_ingestion"],
      ["failed", "failed_ingestion"],
    ] as const) {
      const readiness = studyProjectionReadiness(
        thermoProjection({
          activeQuestion: null,
          studySet: { ...thermoProjection().studySet, ingestionStatus },
        }),
      );
      expect(readiness.canConnect).toBe(false);
      expect(readiness.reason).toBe(reason);
    }
  });
});
