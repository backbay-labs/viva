import type { ConceptStatus, StudySetIngestionStatus } from "@viva/core";

export type VivaLibraryAction =
  | {
      available: true;
      session_id?: string | null;
      session_bootstrap_token?: string | null;
      session_token?: string | null;
      control_token?: string | null;
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

export type VivaLibraryPrivacy = {
  voice_recordings_saved: boolean;
  transcripts_saved: boolean;
  raw_audio_persistence: boolean;
  transcript_persistence: boolean;
  export_contains_raw_provider_payloads: boolean;
  export: VivaLibraryAction;
  copy: string;
  data_handling_statement?: string;
  retention_statement?: string;
  deletion_statement?: string;
};

export type VivaLibrarySnapshot = {
  user_id: string;
  privacy: VivaLibraryPrivacy;
  study_sets: VivaLibraryStudySet[];
  sessions: VivaLibrarySession[];
};

export type VivaLibraryExport = {
  user_id: string;
  privacy: VivaLibraryPrivacy;
  study_sets: Omit<VivaLibraryStudySet, "actions">[];
  sessions: VivaLibrarySession[];
};

export type ProjectedLibraryAction = {
  available: boolean;
  sessionId?: string;
  sessionBootstrapToken?: string | null;
  sessionToken?: string | null;
  controlToken?: string | null;
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

export type ProjectedSessionMastery = {
  strong: number;
  shaky: number;
  missed: number;
  total: number;
  strongPct: number;
};

export type ProjectedSessionRow = {
  id: string;
  studySetId: string;
  studySetTitle: string;
  statusLabel: string;
  recapLabel: string;
  mastery: ProjectedSessionMastery | null;
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

export type ProjectedLibraryPrivacy = {
  voiceRecordingsSaved: boolean;
  transcriptsSaved: boolean;
  rawAudioPersistence: boolean;
  transcriptPersistence: boolean;
  exportContainsRawProviderPayloads: boolean;
  export: ProjectedLibraryAction;
  copy: string;
  dataHandlingStatement: string;
  retentionStatement: string;
  deletionStatement: string;
};

export type VivaLibraryProjection = {
  userId: string;
  privacy: ProjectedLibraryPrivacy;
  libraryRows: ProjectedLibraryRow[];
  sessionRows: ProjectedSessionRow[];
};

export function projectLibrarySnapshot(
  snapshot: VivaLibrarySnapshot,
  _options: { now?: Date } = {},
): VivaLibraryProjection {
  return {
    userId: snapshot.user_id,
    privacy: projectPrivacy(snapshot.privacy),
    libraryRows: snapshot.study_sets.map(projectStudySetRow),
    sessionRows: snapshot.sessions.map(projectSessionRow),
  };
}

export function redactVivaLibrarySessionTokens(snapshot: VivaLibrarySnapshot): VivaLibrarySnapshot {
  return stripBrowserOnlyTokenFields(snapshot, {
    controlToken: false,
    sessionToken: true,
  }) as VivaLibrarySnapshot;
}

export function browserInitialLibrarySnapshot(
  snapshot: VivaLibrarySnapshot,
  options: { staticExport?: boolean } = {},
): VivaLibrarySnapshot {
  return stripBrowserOnlyTokenFields(snapshot, {
    controlToken: false,
    sessionToken: !options.staticExport,
  }) as VivaLibrarySnapshot;
}

function stripBrowserOnlyTokenFields(
  value: unknown,
  options: { controlToken: boolean; sessionToken: boolean },
): unknown {
  if (Array.isArray(value))
    return value.map((child) => stripBrowserOnlyTokenFields(child, options));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      (options.sessionToken && key === "session_token") ||
      (options.controlToken && key === "control_token")
    ) {
      continue;
    }
    output[key] = stripBrowserOnlyTokenFields(child, options);
  }
  return output;
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
    start: projectSessionAction(studySet.actions.start),
    resume: projectSessionAction(studySet.actions.resume),
    archive: projectMutationAction(studySet.actions.archive),
    delete: projectMutationAction(studySet.actions.delete),
  };
}

function projectSessionRow(session: VivaLibrarySession): ProjectedSessionRow {
  return {
    id: session.voice_session_id,
    studySetId: session.study_set_id,
    studySetTitle: session.study_set_title,
    statusLabel: sessionStatusLabel(session),
    recapLabel: recapLabel(session.recap),
    mastery: projectSessionMastery(session.recap),
    nextReview: projectNextReview(session.next_review),
  };
}

/**
 * Reduce a recap's graded buckets to the at-a-glance mastery a session card
 * rings: the share of graded concepts the student held. `review_later` is a
 * scheduling overlay (and overlaps the graded buckets), so it never inflates
 * the total. Returns null when nothing was graded, so the ring stays silent.
 */
function projectSessionMastery(
  recap: VivaLibrarySessionRecap | null,
): ProjectedSessionMastery | null {
  if (!recap) return null;
  const strong = recap.strong_concepts.length;
  const shaky = recap.shaky_concepts.length;
  const missed = recap.missed_concepts.length;
  const total = strong + shaky + missed;
  if (total === 0) return null;
  return { strong, shaky, missed, total, strongPct: Math.round((strong / total) * 100) };
}

function projectSessionAction(action: VivaLibraryAction): ProjectedLibraryAction {
  if (!action.available) {
    return {
      available: false,
      unavailableReason: action.unavailable_reason,
    };
  }
  if (!action.session_id) {
    return {
      available: false,
      unavailableReason: "session_id_unavailable",
    };
  }
  if (!action.session_token && !action.session_bootstrap_token) {
    return {
      available: false,
      unavailableReason: "session_capability_unavailable",
    };
  }
  return {
    available: true,
    sessionId: action.session_id ?? undefined,
    sessionBootstrapToken: action.session_bootstrap_token ?? undefined,
    sessionToken: action.session_token ?? undefined,
  };
}

function projectMutationAction(action: VivaLibraryAction): ProjectedLibraryAction {
  if (!action.available) {
    return {
      available: false,
      unavailableReason: action.unavailable_reason,
    };
  }
  if (!action.control_token) {
    return {
      available: false,
      unavailableReason: "control_token_unavailable",
    };
  }
  return { available: true, controlToken: action.control_token };
}

function projectPrivacy(privacy: VivaLibraryPrivacy): ProjectedLibraryPrivacy {
  return {
    voiceRecordingsSaved: privacy.voice_recordings_saved,
    transcriptsSaved: privacy.transcripts_saved,
    rawAudioPersistence: privacy.raw_audio_persistence,
    transcriptPersistence: privacy.transcript_persistence,
    exportContainsRawProviderPayloads: privacy.export_contains_raw_provider_payloads,
    export: projectMutationAction(privacy.export),
    copy: privacy.copy,
    dataHandlingStatement: privacy.data_handling_statement ?? privacy.copy,
    retentionStatement: privacy.retention_statement ?? privacy.copy,
    deletionStatement: privacy.deletion_statement ?? privacy.copy,
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
    case "retry":
      return "Ingestion retry needed";
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
