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

export type HomeLibraryLoadState =
  | { kind: "error" }
  | { kind: "loading" }
  | { kind: "ready"; model: HomeLibraryModel };

export type HomeDisplayState = {
  activeStudySetId: string | null;
  displayModel: HomeLibraryModel;
};

export type HomeTodayCopy = {
  dateLabel: string;
  greeting: string;
};

const unavailableConcept = {
  weakConceptDetail: "Concept detail unavailable from library",
  weakConceptId: null,
  weakConceptTitle: "Concept detail unavailable",
} as const;

const loadingHomeModel = {
  canStart: false,
  contextLabel: "Checking study sets",
  studySetId: null,
  studySetTitle: "Opening your library",
  weakConceptDetail: "Waiting for live library data",
  weakConceptId: null,
  weakConceptTitle: "Concept detail unavailable",
} satisfies HomeLibraryModel;

const errorHomeModel = {
  canStart: false,
  contextLabel: "Agent offline",
  studySetId: null,
  studySetTitle: "Library unavailable",
  weakConceptDetail: "Live study data unavailable",
  weakConceptId: null,
  weakConceptTitle: "Concept detail unavailable",
} satisfies HomeLibraryModel;

export function homeDisplayState(state: HomeLibraryLoadState): HomeDisplayState {
  if (state.kind === "loading") {
    return { activeStudySetId: null, displayModel: loadingHomeModel };
  }
  if (state.kind === "error") {
    return { activeStudySetId: null, displayModel: errorHomeModel };
  }
  return {
    activeStudySetId: state.model.canStart ? state.model.studySetId : null,
    displayModel: state.model,
  };
}

export function homeTodayCopy(now: Date = new Date()): HomeTodayCopy {
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(now);
  const dayAndMonth = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
  }).format(now);
  const hour = now.getHours();
  const period = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return {
    dateLabel: `${weekday} · ${dayAndMonth}`,
    greeting: `Good ${period}.`,
  };
}

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
