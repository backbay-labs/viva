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
