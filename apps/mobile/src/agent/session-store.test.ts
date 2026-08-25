import { describe, expect, test } from "bun:test";
import type { SessionRecap, StudySet } from "@viva/core";
import { sessionResultStore } from "@/agent/session-store";

const studySet: StudySet = {
  concepts: [],
  course: "Biology",
  docs: [],
  examDateLabel: "Friday",
  generatedCards: [],
  id: "biology-midterm",
  lastSessionLabel: "Never",
  mastery: { review: 0, shaky: 0, strong: 0 },
  recommendedSession: "Recall oxidative phosphorylation",
  title: "Biology Midterm",
};

const recap: SessionRecap = {
  durationLabel: "Agent session",
  headline: "Electron transport reviewed",
  missedConcepts: [],
  nextAction: "Review chemiosmosis",
  plan: [],
  reviewLater: ["chemiosmosis"],
  shakyConcepts: ["proton gradient"],
  sourceMoments: [],
  strongConcepts: ["NADH"],
  summary: "One strong concept and one review target.",
};

describe("sessionResultStore", () => {
  test("publishes the exact selected study set with the real recap", () => {
    sessionResultStore.clear();
    let notifications = 0;
    const unsubscribe = sessionResultStore.subscribe(() => {
      notifications += 1;
    });

    sessionResultStore.set({
      conceptStatuses: { nadh: "strong" },
      partialReason: "provider_timeout",
      recap,
      studySet,
      studySetTitle: studySet.title,
    });

    const stored = sessionResultStore.get();
    expect(stored?.studySet).toBe(studySet);
    expect(stored?.recap).toBe(recap);
    expect(stored?.conceptStatuses).toEqual({ nadh: "strong" });
    expect(stored?.partialReason).toBe("provider_timeout");
    expect(stored?.studySetTitle).toBe("Biology Midterm");
    expect(notifications).toBe(1);

    sessionResultStore.clear();
    expect(sessionResultStore.get()).toBeUndefined();
    expect(notifications).toBe(2);

    unsubscribe();
    sessionResultStore.set({ conceptStatuses: {}, studySet });
    expect(notifications).toBe(2);
    sessionResultStore.clear();
  });
});
