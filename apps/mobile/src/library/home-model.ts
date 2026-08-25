import type { VivaLibraryProjection, VivaLibrarySnapshot } from "@/agent/shared-web";
import type { AppConfig } from "@/runtime/config";
import { decideMobileLibraryStart, type MobileRuntimePlatform } from "./library-client";

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
  config: AppConfig,
  platform: MobileRuntimePlatform = "unknown",
): HomeLibraryModel {
  const row =
    projection.libraryRows.find(
      (candidate) => decideMobileLibraryStart(config, snapshot, candidate.id, platform).canStart,
    ) ?? projection.libraryRows[0];
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
  const startDecision = decideMobileLibraryStart(config, snapshot, row.id, platform);
  const nextReview = projection.sessionRows.find(
    (session) => session.studySetId === row.id && session.nextReview,
  )?.nextReview;

  return {
    canStart: startDecision.canStart,
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
