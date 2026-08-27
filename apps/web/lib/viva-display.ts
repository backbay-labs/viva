import {
  type AgentStudySetReadiness,
  type AuthenticatedStudyProjectionV1,
  type ConceptStatus,
  type ReviewScheduleAuthority,
  reviewDueAtFromProjection,
  reviewIntervalFromProjection,
  type SessionRecap,
  type StudySet,
} from "@viva/core";

export type RecapStat = {
  color: string;
  label: string;
  pct: number;
  topics: number;
};

/**
 * One learner-visible review entry, read ONLY from the persisted projection.
 *
 * `dueAt` is the server's own RFC3339 instant, carried through unchanged, and
 * `intervalLabel` is derived from that instant by the shared reader — never from
 * a status-shaped estimate. `authority` is rendered so a surface can never
 * silently disagree with the one D-01 selected.
 */
export type SessionReviewPlanItem = Readonly<{
  conceptId: string;
  label: string;
  status: ConceptStatus;
  dueAt: string;
  authority: ReviewScheduleAuthority;
  intervalLabel: string;
}>;

export type SessionReviewPlanProjection =
  | { status: "ready"; items: SessionReviewPlanItem[] }
  | { status: "invalid_projection" };

/**
 * `WEBSESSION-TASK10-LOCAL-DATE-01` / ledger Minor M2 (in-session half).
 *
 * The browser recomputes nothing. Each entry pairs the projection's persisted
 * `dueAt` with the label of the concept the projection itself names; a schedule
 * entry for a concept the projection does not carry is a sanitized
 * invalid-projection state, not a guessed label. `reviewIntervalFromProjection`
 * is the single reader, so the margin and any other surface reading the same
 * entry cannot disagree about the same concept's interval.
 */
export function sessionReviewPlanFromProjection(
  projection: AuthenticatedStudyProjectionV1,
  now: Date,
): SessionReviewPlanProjection {
  const conceptsById = new Map(projection.concepts.map((concept) => [concept.id, concept]));
  const items: SessionReviewPlanItem[] = [];
  for (const entry of projection.reviewSchedule) {
    const concept = conceptsById.get(entry.conceptId);
    if (!concept) return { status: "invalid_projection" };
    let intervalLabel: string | null;
    try {
      intervalLabel = reviewIntervalFromProjection(projection.reviewSchedule, entry.conceptId, now);
    } catch {
      // A duplicated entry, an unparseable instant, or an authority the recorded
      // decision did not select: refuse the whole projection rather than render
      // the entries that happened to parse.
      return { status: "invalid_projection" };
    }
    if (intervalLabel === null) return { status: "invalid_projection" };
    items.push({
      authority: entry.authority,
      conceptId: entry.conceptId,
      dueAt: entry.dueAt,
      intervalLabel,
      label: concept.label,
      status: concept.status,
    });
  }
  return { items, status: "ready" };
}

/** The persisted due instant for one concept, or `null` when none is scheduled. */
export function sessionReviewDueAt(
  projection: AuthenticatedStudyProjectionV1,
  conceptId: string,
): Date | null {
  return reviewDueAtFromProjection(projection.reviewSchedule, conceptId);
}

/**
 * Readiness derived from the AUTHENTICATED projection's ingestion status rather
 * than from a `StudySet` fixture. A projection the server marked anything but
 * `ready` cannot open a voice socket, and the page never overwrites that with a
 * local `ready`.
 */
export function studyProjectionReadiness(
  projection: AuthenticatedStudyProjectionV1,
): AgentStudySetReadiness {
  switch (projection.studySet.ingestionStatus) {
    case "ready":
      return {
        canConnect: true,
        message: "Connected agent is serving this server-owned study set.",
        reason: "trusted",
      };
    case "failed":
      return {
        canConnect: false,
        message: "Connected agent is unavailable because server ingestion failed.",
        reason: "failed_ingestion",
      };
    case "retry":
      return {
        canConnect: false,
        message: "Server ingestion is retrying; the session cannot open yet.",
        reason: "retry_ingestion",
      };
    case "processing":
      return {
        canConnect: false,
        message: "Server ingestion is still processing this study set.",
        reason: "processing_ingestion",
      };
    default:
      return {
        canConnect: false,
        message: "Server ingestion has not started for this study set.",
        reason: "pending_ingestion",
      };
  }
}

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

export function correctionQuote(answer: string): string {
  return answer.trim().length > 0 ? `"${answer}"` : "No browser transcript captured";
}
