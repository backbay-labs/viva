import { createEmptyCard, fsrs, type Grade, generatorParameters, Rating } from "ts-fsrs";
import type { ConceptStatus } from "./index";

/**
 * Spaced-repetition scheduling for Viva, backed by FSRS (ts-fsrs, MIT, zero
 * runtime deps). Lives in @viva/core so the same scheduler is shared and
 * unit-testable; the agent stays the source of truth for what was learned.
 *
 * Short-term learning steps are disabled so a single in-session rating produces
 * a day-scale interval (the manuscript talks in "tomorrow"/"in 3 days", never in
 * minutes, and never leaks raw stability/difficulty numbers into the UI).
 */
const scheduler = fsrs(generatorParameters({ enable_short_term: false }));

export type ReviewScheduleInput = {
  conceptId: string;
  label: string;
  status: ConceptStatus;
  misses: number;
  hinted: boolean;
  centrality: number;
  now: Date;
  examDate?: Date;
  lastReviewedAt?: Date;
  advisorDueAt?: string;
};

export type ReviewScheduleItem = {
  conceptId: string;
  label: string;
  status: ConceptStatus;
  dueAt: Date;
  intervalLabel: string;
  priority: "urgent" | "soon" | "later";
  explanation: string[];
  authority: "core_fsrs";
  ignoredAdvisorDueAt?: string;
};

export function conceptStatusToRating(status: ConceptStatus): Grade {
  switch (status) {
    case "missed":
      return Rating.Again;
    case "shaky":
      return Rating.Hard;
    case "review":
      return Rating.Good;
    case "strong":
      return Rating.Easy;
  }
}

export function dueDateForStatus(status: ConceptStatus, now: Date): Date {
  const card = createEmptyCard(now);
  const { card: scheduled } = scheduler.next(card, now, conceptStatusToRating(status));
  return scheduled.due;
}

export function humanInterval(from: Date, to: Date): string {
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

export function reviewIntervalForStatus(status: ConceptStatus, now: Date): string {
  return humanInterval(now, dueDateForStatus(status, now));
}

export function scheduleConceptReview(input: ReviewScheduleInput): ReviewScheduleItem {
  const explanation: string[] = [];
  const rating = effectiveRating(input, explanation);
  const createdAt = input.lastReviewedAt ?? input.now;
  const card = createEmptyCard(createdAt);
  const { card: scheduled } = scheduler.next(card, input.now, rating);
  const dueAt = applyUrgencyCaps(scheduled.due, input, explanation);
  const item: ReviewScheduleItem = {
    conceptId: input.conceptId,
    label: input.label,
    status: input.status,
    dueAt,
    intervalLabel: humanInterval(input.now, dueAt),
    priority: priorityFor(input.now, dueAt),
    explanation,
    authority: "core_fsrs",
  };

  if (input.advisorDueAt) {
    item.ignoredAdvisorDueAt = input.advisorDueAt;
  }

  return item;
}

export function buildReviewSchedule(inputs: ReviewScheduleInput[]): ReviewScheduleItem[] {
  return inputs
    .map(scheduleConceptReview)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.label.localeCompare(b.label));
}

function effectiveRating(input: ReviewScheduleInput, explanation: string[]): Grade {
  let rating = conceptStatusToRating(input.status);
  explanation.push(`FSRS rating: ${ratingName(rating)}`);

  if (input.hinted && rating > Rating.Hard) {
    rating = Rating.Hard;
    explanation.push("hint-assisted answer lowered the rating");
  }

  if (input.misses >= 2 && rating > Rating.Hard) {
    rating = Rating.Hard;
    explanation.push(`${input.misses} prior misses lowered the rating`);
  } else if (input.misses > 0) {
    explanation.push(`${input.misses} prior misses`);
  }

  if (input.centrality >= 90) {
    explanation.push("high-centrality concept");
  }
  if (input.lastReviewedAt) {
    explanation.push("session recency included");
  }
  if (input.advisorDueAt) {
    explanation.push("advisor due date ignored");
  }

  return rating;
}

function applyUrgencyCaps(dueAt: Date, input: ReviewScheduleInput, explanation: string[]): Date {
  let capped = dueAt;
  const cap = capDays(input, explanation);
  if (cap !== undefined) {
    capped = minDate(capped, addDays(input.now, cap));
  }

  if (input.examDate) {
    const msToExam = input.examDate.getTime() - input.now.getTime();
    if (msToExam >= 0 && msToExam <= 3 * 86_400_000) {
      capped = minDate(capped, examCapDate(input.now, input.examDate));
      explanation.push("exam-near cap");
    }
  }

  return capped;
}

function capDays(input: ReviewScheduleInput, explanation: string[]): number | undefined {
  const caps: number[] = [];
  if (input.status === "missed") caps.push(1);
  if (input.hinted) caps.push(2);
  if (input.centrality >= 90) caps.push(input.status === "strong" ? 3 : 2);
  const recencyCap = recencyCapDays(input, explanation);
  if (recencyCap !== undefined) caps.push(recencyCap);
  return caps.length > 0 ? Math.min(...caps) : undefined;
}

function recencyCapDays(
  { lastReviewedAt, now }: ReviewScheduleInput,
  explanation: string[],
): number | undefined {
  if (!lastReviewedAt) return undefined;
  const daysSinceReview = Math.floor((now.getTime() - lastReviewedAt.getTime()) / 86_400_000);
  if (daysSinceReview >= 21) {
    explanation.push("session recency cap");
    return 2;
  }
  if (daysSinceReview >= 7) {
    explanation.push("session recency cap");
    return 3;
  }
  return undefined;
}

function examCapDate(now: Date, examDate: Date): Date {
  const dayBeforeExam = addDays(examDate, -1);
  if (dayBeforeExam.getTime() > now.getTime()) return dayBeforeExam;
  const hourBeforeExam = new Date(examDate.getTime() - 3_600_000);
  if (hourBeforeExam.getTime() > now.getTime()) return hourBeforeExam;
  return now;
}

function priorityFor(now: Date, dueAt: Date): ReviewScheduleItem["priority"] {
  const days = Math.round((dueAt.getTime() - now.getTime()) / 86_400_000);
  if (days <= 1) return "urgent";
  if (days <= 3) return "soon";
  return "later";
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function ratingName(rating: Grade): string {
  switch (rating) {
    case Rating.Again:
      return "Again";
    case Rating.Hard:
      return "Hard";
    case Rating.Good:
      return "Good";
    case Rating.Easy:
      return "Easy";
    default:
      return String(rating);
  }
}
