import type { Concept, StudySet, UploadedDocument } from "@viva/core";

import {
  fetchVivaLibrarySnapshot,
  projectLibrarySnapshot,
  type VivaLibraryAction,
  type VivaLibraryDocument,
  type VivaLibraryProjection,
  type VivaLibrarySnapshot,
} from "@/agent/shared-web";
import type { AppConfig } from "@/runtime/config";

export type LoadedLibrary = {
  projection: VivaLibraryProjection;
  snapshot: VivaLibrarySnapshot;
};

export async function loadLibrary(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedLibrary> {
  const snapshot = await fetchVivaLibrarySnapshot({
    apiBaseUrl: config.agentHttpUrl,
    fetchImpl,
    userId: config.userId,
  });
  return { projection: projectLibrarySnapshot(snapshot), snapshot };
}

/**
 * The live `/study-sets/library` contract is deliberately metadata-only. It
 * exposes counts but no concept rows, exam date, mastery, or source excerpts.
 * Keep those core fields neutral instead of reconstructing learning state from
 * recap labels or inventing product defaults. A future authenticated study
 * projection can replace these explicit unavailable values field-by-field.
 */
export function studySetForSession(snapshot: VivaLibrarySnapshot, studySetId: string): StudySet {
  const row = snapshot.study_sets.find((studySet) => studySet.id === studySetId);
  if (!row) {
    throw new Error(`Study set ${studySetId} is unavailable in the library snapshot`);
  }

  const capability = sessionCapability(row.actions.start) ?? sessionCapability(row.actions.resume);
  const hasSessionHistory = snapshot.sessions.some((session) => session.study_set_id === row.id);

  return {
    concepts: [],
    course: row.course,
    docs: row.documents.map(documentForCore),
    examDateLabel: "Exam date unavailable",
    generatedCards: [],
    id: row.id,
    ingestionStatus: row.ingestion_status,
    lastSessionLabel: hasSessionHistory ? "Session history available" : "No session history",
    mastery: { review: 0, shaky: 0, strong: 0 },
    recommendedSession: "Recall plan unavailable",
    serverOwned: row.server_owned,
    sessionId: capability?.sessionId,
    sessionToken: capability?.sessionToken,
    title: row.title,
    userId: row.user_id,
  };
}

export function weakestConcept(studySet: StudySet): Concept | undefined {
  return studySet.concepts.reduce<Concept | undefined>((weakest, candidate) => {
    if (!weakest || candidate.misses > weakest.misses) return candidate;
    if (candidate.misses < weakest.misses) return weakest;
    if (weakest.status === "strong" && candidate.status !== "strong") return candidate;
    return weakest;
  }, undefined);
}

function documentForCore(document: VivaLibraryDocument): UploadedDocument {
  const processed = document.processing_status === "ready" && !document.deleted;
  return {
    id: document.id,
    kind: coreDocumentKind(document.source_kind),
    name: document.display_name,
    processed,
    progress: processed ? 100 : 0,
  };
}

function coreDocumentKind(sourceKind: string): UploadedDocument["kind"] {
  const normalized = sourceKind.trim().toLowerCase();
  if (normalized === "pdf") return "pdf";
  if (normalized.includes("slide") || normalized.includes("powerpoint")) return "slides";
  if (normalized.includes("transcript")) return "transcript";
  if (normalized.includes("paste")) return "pasted text";
  // The server's other current value is `file`, produced by text-file
  // ingestion. The legacy core enum calls the equivalent study note `notes`.
  return "notes";
}

function sessionCapability(
  action: VivaLibraryAction,
): { sessionId?: string; sessionToken?: string | null } | undefined {
  if (!action.available) return undefined;
  return {
    sessionId: action.session_id ?? undefined,
    sessionToken: action.session_token ?? action.session_bootstrap_token ?? undefined,
  };
}
