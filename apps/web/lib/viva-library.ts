import type { ConceptStatus, StudySetIngestionStatus } from "@viva/core";

export type VivaLibraryAction =
  | {
      available: true;
      session_id: string;
      session_token?: string | null;
    }
  | {
      available: false;
      unavailable_reason: string;
    };

export type VivaLibraryDocument = {
  id: string;
  display_name: string;
  source_kind: string;
  processing_status: StudySetIngestionStatus;
  deleted: boolean;
};

export type VivaLibraryStudySet = {
  id: string;
  user_id: string;
  title: string;
  course: string | null;
  ingestion_status: StudySetIngestionStatus;
  ingestion_error: string | null;
  server_owned: boolean;
  documents: VivaLibraryDocument[];
  concept_count: number;
  question_count: number;
  actions: {
    start: VivaLibraryAction;
    resume: VivaLibraryAction;
    archive: VivaLibraryAction;
    delete: VivaLibraryAction;
  };
};

export type VivaLibrarySessionRecap = {
  voice_session_id: string;
  strong_concepts: string[];
  shaky_concepts: string[];
  missed_concepts: string[];
  review_later: string[];
};

export type VivaLibraryNextReview = {
  concept_id: string;
  label: string;
  status: ConceptStatus;
  persisted_due_at: string;
  source: "persisted_review_item";
};

export type VivaLibrarySession = {
  voice_session_id: string;
  user_id?: string;
  study_set_id: string;
  study_set_title: string;
  status: string;
  terminal_reason: string | null;
  recap: VivaLibrarySessionRecap | null;
  next_review: VivaLibraryNextReview | null;
};

export type VivaLibrarySnapshot = {
  user_id: string;
  study_sets: VivaLibraryStudySet[];
  sessions: VivaLibrarySession[];
};

export type ProjectedLibraryAction = {
  available: boolean;
  sessionId?: string;
  sessionToken?: string | null;
  unavailableReason?: string;
};

export type ProjectedLibraryRow = {
  id: string;
  userId: string;
  title: string;
  course: string | null;
  statusLabel: string;
  detail: string;
  documentSummary: string;
  start: ProjectedLibraryAction;
  resume: ProjectedLibraryAction;
  archive: ProjectedLibraryAction;
  delete: ProjectedLibraryAction;
};

export type ProjectedSessionRow = {
  id: string;
  studySetId: string;
  studySetTitle: string;
  statusLabel: string;
  recapLabel: string;
  nextReview: ProjectedNextReview | null;
};

export type ProjectedNextReview = {
  conceptId: string;
  label: string;
  status: ConceptStatus;
  persistedDueAt: string;
  intervalLabel: string;
  source: string;
  authority: "server_persisted";
};

export type VivaLibraryProjection = {
  userId: string;
  libraryRows: ProjectedLibraryRow[];
  sessionRows: ProjectedSessionRow[];
};

export function projectLibrarySnapshot(
  snapshot: VivaLibrarySnapshot,
  _options: { now?: Date } = {},
): VivaLibraryProjection {
  return {
    userId: snapshot.user_id,
    libraryRows: snapshot.study_sets.map(projectStudySetRow),
    sessionRows: snapshot.sessions.map(projectSessionRow),
  };
}

function projectStudySetRow(studySet: VivaLibraryStudySet): ProjectedLibraryRow {
  return {
    id: studySet.id,
    userId: studySet.user_id,
    title: studySet.title,
    course: studySet.course,
    statusLabel: studySetStatusLabel(studySet),
    detail: studySetDetail(studySet),
    documentSummary: documentSummary(studySet.documents),
    start: projectAction(studySet.actions.start),
    resume: projectAction(studySet.actions.resume),
    archive: projectAction(studySet.actions.archive),
    delete: projectAction(studySet.actions.delete),
  };
}

function projectSessionRow(session: VivaLibrarySession): ProjectedSessionRow {
  return {
    id: session.voice_session_id,
    studySetId: session.study_set_id,
    studySetTitle: session.study_set_title,
    statusLabel: sessionStatusLabel(session),
    recapLabel: recapLabel(session.recap),
    nextReview: projectNextReview(session.next_review),
  };
}

function projectAction(action: VivaLibraryAction): ProjectedLibraryAction {
  if (!action.available) {
    return {
      available: false,
      unavailableReason: action.unavailable_reason,
    };
  }
  if (!action.session_token) {
    return {
      available: false,
      unavailableReason: "session_token_unavailable",
    };
  }
  return {
    available: true,
    sessionId: action.session_id,
    sessionToken: action.session_token,
  };
}

function studySetStatusLabel(studySet: VivaLibraryStudySet): string {
  switch (studySet.ingestion_status) {
    case "pending":
      return "Ingestion pending";
    case "processing":
      return "Ingestion processing";
    case "failed":
      return "Ingestion failed";
    case "ready":
      return studySet.documents.length > 0 &&
        studySet.documents.every((document) => document.deleted)
        ? "Source archived"
        : "Ready";
  }
}

function studySetDetail(studySet: VivaLibraryStudySet): string {
  if (studySet.ingestion_error) return studySet.ingestion_error;
  if (studySet.documents.length > 0 && studySet.documents.every((document) => document.deleted)) {
    return "Server source is archived or deleted";
  }
  return `${studySet.concept_count} concepts · ${studySet.question_count} active questions`;
}

function documentSummary(documents: VivaLibraryDocument[]): string {
  if (documents.length === 0) return "No source documents";
  const active = documents.filter((document) => !document.deleted).length;
  const deleted = documents.length - active;
  if (deleted === 0) return `${active} source${active === 1 ? "" : "s"}`;
  if (active === 0) return `${deleted} archived source${deleted === 1 ? "" : "s"}`;
  return `${active} active · ${deleted} archived`;
}

function sessionStatusLabel(session: VivaLibrarySession): string {
  if (session.status === "closed" && session.terminal_reason === "completed") return "Completed";
  if (session.status === "closed") return "Closed";
  if (session.status === "open") return "Open";
  return titleCase(session.status);
}

function recapLabel(recap: VivaLibrarySessionRecap | null): string {
  if (!recap) return "No recap yet";
  const bucketed = new Set([
    ...recap.strong_concepts,
    ...recap.shaky_concepts,
    ...recap.missed_concepts,
  ]);
  const reviewOnly = recap.review_later.filter((concept) => !bucketed.has(concept));
  const parts = [
    countLabel(recap.strong_concepts.length, "strong"),
    countLabel(recap.shaky_concepts.length, "shaky"),
    countLabel(recap.missed_concepts.length, "missed"),
    countLabel(reviewOnly.length, "review"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No recap topics";
}

function countLabel(count: number, label: string): string | null {
  return count > 0 ? `${count} ${label}` : null;
}

function projectNextReview(
  review: VivaLibraryNextReview | null,
): ProjectedSessionRow["nextReview"] {
  if (!review) return null;
  return {
    conceptId: review.concept_id,
    label: review.label,
    status: review.status,
    persistedDueAt: review.persisted_due_at,
    intervalLabel: persistedDueLabel(review.persisted_due_at),
    source: review.source,
    authority: "server_persisted",
  };
}

function persistedDueLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "server scheduled";
  const label = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
  return `due ${label}`;
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
