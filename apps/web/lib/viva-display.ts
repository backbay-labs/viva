import {
  buildReviewSchedule,
  type ConceptStatus,
  type ReviewScheduleItem,
  type SessionRecap,
  type StudySet,
} from "@viva/core";

export type RecapStat = {
  color: string;
  label: string;
  pct: number;
  topics: number;
};

export type ReviewPlanSignals = {
  hinted?: boolean;
  examDate?: Date;
  lastReviewedAt?: Date;
};

export type RecapPlanProjection = {
  recap?: SessionRecap;
  reviewPlan: ReviewScheduleItem[];
};

type RecapConceptSignal = {
  conceptId: string;
  label: string;
  status: ConceptStatus;
  misses: number;
  centrality: number;
};

export function uploadPreviewSummary(studySet: StudySet): {
  conceptLabel: string;
  overflowLabel: string;
} {
  return {
    conceptLabel:
      studySet.concepts.length > 0
        ? `${studySet.concepts.length} preview concepts`
        : "Awaiting real concept extraction",
    overflowLabel:
      studySet.concepts.length > 8 ? `+${studySet.concepts.length - 8} more` : "Extraction pending",
  };
}

export function recapStats(recap: SessionRecap): RecapStat[] {
  const total = Math.max(
    1,
    recap.strongConcepts.length + recap.shakyConcepts.length + recap.reviewLater.length,
  );
  const pct = (count: number) => Math.round((count / total) * 100);

  return [
    {
      color: "var(--sage)",
      label: "Strong",
      pct: pct(recap.strongConcepts.length),
      topics: recap.strongConcepts.length,
    },
    {
      color: "var(--amber)",
      label: "Shaky",
      pct: pct(recap.shakyConcepts.length),
      topics: recap.shakyConcepts.length,
    },
    {
      color: "var(--plum)",
      label: "Review tomorrow",
      pct: pct(recap.reviewLater.length),
      topics: recap.reviewLater.length,
    },
  ];
}

export function recapPlanFromSessionEvents({
  recap,
  studySet,
  conceptStatuses,
  now,
  signals = {},
}: {
  recap?: SessionRecap;
  studySet: StudySet;
  conceptStatuses: Record<string, ConceptStatus>;
  now: Date;
  signals?: ReviewPlanSignals;
}): RecapPlanProjection {
  if (!recap) return { recap: undefined, reviewPlan: [] };

  const conceptSignals = conceptSignalsFromStatuses(studySet, conceptStatuses);
  const reviewPlan = reviewPlanFromConceptSignals(conceptSignals, studySet, now, signals);

  return {
    recap: {
      ...recap,
      strongConcepts: labelsForStatus(conceptSignals, "strong"),
      shakyConcepts: labelsForStatus(conceptSignals, "shaky"),
      missedConcepts: labelsForStatus(conceptSignals, "missed"),
      reviewLater: conceptSignals
        .filter((concept) => concept.status !== "strong")
        .map((concept) => concept.label),
      nextAction: primaryNextAction(conceptSignals, reviewPlan),
    },
    reviewPlan,
  };
}

export function reviewPlanFromRecap(
  recap: SessionRecap,
  studySet: StudySet,
  now: Date,
  signals: ReviewPlanSignals = {},
): ReviewScheduleItem[] {
  const statusByLabel = new Map<string, ConceptStatus>();
  const examDate = signals.examDate ?? examDateFromLabel(studySet.examDateLabel, now);
  const lastReviewedAt =
    signals.lastReviewedAt ?? lastReviewedAtFromLabel(studySet.lastSessionLabel, now);
  for (const label of recap.strongConcepts) statusByLabel.set(label.toLowerCase(), "strong");
  for (const label of recap.shakyConcepts) statusByLabel.set(label.toLowerCase(), "shaky");
  for (const label of recap.missedConcepts) statusByLabel.set(label.toLowerCase(), "missed");
  for (const label of recap.reviewLater) {
    const key = label.toLowerCase();
    if (!statusByLabel.has(key)) statusByLabel.set(key, "review");
  }

  return buildReviewSchedule(
    [...statusByLabel].map(([key, status]) => {
      const concept =
        studySet.concepts.find((item) => item.label.toLowerCase() === key || item.id === key) ??
        studySet.concepts.find((item) => item.label.toLowerCase().includes(key));

      return {
        conceptId: concept?.id ?? key.replace(/\s+/g, "-"),
        label: concept?.label ?? key,
        status,
        misses: concept?.misses ?? (status === "missed" ? 1 : 0),
        hinted: signals.hinted === true,
        centrality: concept?.centrality ?? 50,
        now,
        examDate,
        lastReviewedAt,
      };
    }),
  );
}

function reviewPlanFromConceptSignals(
  conceptSignals: RecapConceptSignal[],
  studySet: StudySet,
  now: Date,
  signals: ReviewPlanSignals,
): ReviewScheduleItem[] {
  const examDate = signals.examDate ?? examDateFromLabel(studySet.examDateLabel, now);
  const lastReviewedAt =
    signals.lastReviewedAt ?? lastReviewedAtFromLabel(studySet.lastSessionLabel, now);

  return buildReviewSchedule(
    conceptSignals.map((concept) => ({
      conceptId: concept.conceptId,
      label: concept.label,
      status: concept.status,
      misses: concept.misses,
      hinted: signals.hinted === true,
      centrality: concept.centrality,
      now,
      examDate,
      lastReviewedAt,
    })),
  );
}

function conceptSignalsFromStatuses(
  studySet: StudySet,
  conceptStatuses: Record<string, ConceptStatus>,
): RecapConceptSignal[] {
  const conceptOrder = new Map(studySet.concepts.map((concept, index) => [concept.id, index]));
  const concepts = Object.entries(conceptStatuses).map(([conceptId, status]) => {
    const concept = studySet.concepts.find((item) => item.id === conceptId);
    return {
      conceptId,
      label: concept?.label ?? humanizeConceptId(conceptId),
      status,
      misses: concept?.misses ?? (status === "missed" ? 1 : 0),
      centrality: concept?.centrality ?? 50,
    };
  });

  return concepts.sort(
    (left, right) =>
      (conceptOrder.get(left.conceptId) ?? Number.MAX_SAFE_INTEGER) -
        (conceptOrder.get(right.conceptId) ?? Number.MAX_SAFE_INTEGER) ||
      left.label.localeCompare(right.label),
  );
}

function labelsForStatus(concepts: RecapConceptSignal[], status: ConceptStatus): string[] {
  return concepts.filter((concept) => concept.status === status).map((concept) => concept.label);
}

function primaryNextAction(
  conceptSignals: RecapConceptSignal[],
  reviewPlan: ReviewScheduleItem[],
): string {
  if (conceptSignals.length === 0) {
    return "Finish the session to let the Conductor build a source-grounded review plan.";
  }

  const firstMissed = reviewPlan.find((item) => item.status === "missed");
  if (firstMissed) {
    return `Rebuild ${firstMissed.label} from the source, then answer it once without hints.`;
  }

  const firstWeak = reviewPlan.find((item) => item.status === "shaky" || item.status === "review");
  if (firstWeak) {
    return `Tighten ${firstWeak.label} ${firstWeak.intervalLabel} with one source-backed recall pass.`;
  }

  const firstStrong = reviewPlan[0];
  if (firstStrong) {
    return `Bank this pass; return to ${firstStrong.label} for spaced recall ${firstStrong.intervalLabel}.`;
  }

  return "Finish the session to let the Conductor build a source-grounded review plan.";
}

function humanizeConceptId(conceptId: string): string {
  return conceptId
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function correctionQuote(answer: string): string {
  return answer.trim().length > 0 ? `"${answer}"` : "No browser transcript captured";
}

function examDateFromLabel(label: string, now: Date): Date | undefined {
  if (/no exam/i.test(label)) return undefined;

  const weekdayMatch = label.match(
    /exam\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i,
  );
  if (weekdayMatch?.[1]) {
    const targetDay = weekdayIndex(weekdayMatch[1]);
    const currentDay = now.getUTCDay();
    const daysUntil = targetDay >= currentDay ? targetDay - currentDay : targetDay - currentDay + 7;
    return utcNoon(addDays(now, daysUntil));
  }

  const daysMatch = label.match(/exam\s+in\s+(\d+)\s+days?/i);
  if (daysMatch?.[1]) return utcNoon(addDays(now, Number(daysMatch[1])));

  const weeksMatch = label.match(/exam\s+in\s+(\d+)\s+weeks?/i);
  if (weeksMatch?.[1]) return utcNoon(addDays(now, Number(weeksMatch[1]) * 7));

  return undefined;
}

function lastReviewedAtFromLabel(label: string, now: Date): Date | undefined {
  const minutesMatch = label.match(/studied\s+(\d+)\s+minutes?\s+ago/i);
  if (minutesMatch?.[1]) return new Date(now.getTime() - Number(minutesMatch[1]) * 60_000);

  const hoursMatch = label.match(/studied\s+(\d+)\s+hours?\s+ago/i);
  if (hoursMatch?.[1]) return new Date(now.getTime() - Number(hoursMatch[1]) * 3_600_000);

  if (/studied\s+yesterday/i.test(label)) return addDays(now, -1);

  return undefined;
}

function weekdayIndex(day: string): number {
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(
    day.toLowerCase(),
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function utcNoon(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0, 0),
  );
}
