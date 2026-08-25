import type { VivaLibraryProjection, VivaLibrarySnapshot } from "@/agent/shared-web";

export type HomeLibraryModel = {
  canStart: boolean;
  contextLabel: string;
  studySetId: string | null;
  studySetTitle: string;
  weakConceptDetail: string;
  weakConceptId: string | null;
  weakConceptTitle: string;
};

const unavailableConcept = {
  weakConceptDetail: "Concept detail unavailable from library",
  weakConceptId: null,
  weakConceptTitle: "Concept detail unavailable",
} as const;

export function homeModelFromLibrary(
  projection: VivaLibraryProjection,
  snapshot: VivaLibrarySnapshot,
): HomeLibraryModel {
  const row =
    projection.libraryRows.find((candidate) => candidate.start.available) ??
    projection.libraryRows[0];
  if (!row) {
    return {
      canStart: false,
      contextLabel: "Exam date unavailable",
      studySetId: null,
      studySetTitle: "No study set available",
      ...unavailableConcept,
    };
  }

  const snapshotRow = snapshot.study_sets.find((studySet) => studySet.id === row.id);
  const nextReview = projection.sessionRows.find(
    (session) => session.studySetId === row.id && session.nextReview,
  )?.nextReview;

  return {
    canStart: row.start.available,
    contextLabel: snapshotRow?.course ?? "Exam date unavailable",
    studySetId: row.id,
    studySetTitle: row.title,
    ...(nextReview
      ? {
          weakConceptDetail: `${titleCase(nextReview.status)} · ${nextReview.intervalLabel}`,
          weakConceptId: nextReview.conceptId,
          weakConceptTitle: nextReview.label,
        }
      : unavailableConcept),
  };
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
