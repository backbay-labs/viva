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
