import {
  type Concept,
  DEFAULT_TRUSTED_AGENT_STUDY_SET_ID,
  type StudySet,
  type UploadedDocument,
} from "@viva/core";

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

export type MobileLibraryStartDecision =
  | {
      authority: "signed_action" | "trusted_loopback_unsigned";
      canStart: true;
    }
  | {
      canStart: false;
      reason:
        | "action_unavailable"
        | "configured_token_conflicts_with_unsigned_action"
        | "identity_mismatch"
        | "invalid_signed_action"
        | "not_server_owned"
        | "study_set_missing"
        | "study_set_not_ready"
        | "trusted_fixture_mismatch"
        | "unsigned_agent_not_loopback";
    };

const TRUSTED_LOOPBACK_USER_ID = "user-1";

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
 * Decide whether one exact library row can cross the mobile session boundary.
 *
 * In unsigned loopback mode the server returns `session_token_unavailable`
 * only after its server-owned, ingestion, source-deletion, and question-count
 * gates pass. Mobile rechecks those observable gates and admits only the fixed
 * `user-1` / `biology-midterm` fixture over loopback HTTP and WebSocket URLs.
 * It does not mint a token or reinterpret any other unavailable action.
 */
export function decideMobileLibraryStart(
  config: AppConfig,
  snapshot: VivaLibrarySnapshot,
  studySetId: string,
): MobileLibraryStartDecision {
  const row = snapshot.study_sets.find((studySet) => studySet.id === studySetId);
  if (!row) return denied("study_set_missing");
  if (snapshot.user_id !== config.userId || row.user_id !== config.userId) {
    return denied("identity_mismatch");
  }
  if (!row.server_owned) return denied("not_server_owned");

  const activeDocuments = row.documents.filter((document) => !document.deleted);
  if (
    row.ingestion_status !== "ready" ||
    row.concept_count <= 0 ||
    row.question_count <= 0 ||
    activeDocuments.length === 0 ||
    activeDocuments.some((document) => document.processing_status !== "ready")
  ) {
    return denied("study_set_not_ready");
  }

  const action = row.actions.start;
  if (action.available) {
    const sessionId = action.session_id?.trim();
    const sessionToken = (action.session_token ?? action.session_bootstrap_token)?.trim();
    return sessionId && sessionToken
      ? { authority: "signed_action", canStart: true }
      : denied("invalid_signed_action");
  } else if (action.unavailable_reason !== "session_token_unavailable") {
    return denied("action_unavailable");
  }

  if (config.sessionToken) {
    return denied("configured_token_conflicts_with_unsigned_action");
  }
  if (
    !isLoopbackAgentUrl(config.agentHttpUrl, ["http:", "https:"]) ||
    !isLoopbackAgentUrl(config.agentWsUrl, ["ws:", "wss:"])
  ) {
    return denied("unsigned_agent_not_loopback");
  }
  if (
    config.userId !== TRUSTED_LOOPBACK_USER_ID ||
    config.studySetId !== DEFAULT_TRUSTED_AGENT_STUDY_SET_ID ||
    row.user_id !== TRUSTED_LOOPBACK_USER_ID ||
    row.id !== DEFAULT_TRUSTED_AGENT_STUDY_SET_ID
  ) {
    return denied("trusted_fixture_mismatch");
  }
  return { authority: "trusted_loopback_unsigned", canStart: true };
}

/**
 * The live library contract contains counts, not concept rows, exam dates,
 * mastery, or excerpts. Keep those required core fields explicitly neutral;
 * the authenticated study projection can replace them when it ships.
 */
export function studySetForSession(
  snapshot: VivaLibrarySnapshot,
  studySetId: string,
  config: AppConfig,
): StudySet {
  const row = snapshot.study_sets.find((studySet) => studySet.id === studySetId);
  if (!row) {
    throw new Error(`Study set ${studySetId} is unavailable in the library snapshot`);
  }

  const decision = decideMobileLibraryStart(config, snapshot, studySetId);
  if (!decision.canStart) {
    throw new Error(`Study set ${studySetId} cannot start (${decision.reason})`);
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

function denied(
  reason: Extract<MobileLibraryStartDecision, { canStart: false }>["reason"],
): MobileLibraryStartDecision {
  return { canStart: false, reason };
}

function isLoopbackAgentUrl(value: string, protocols: readonly string[]): boolean {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets[0] === "127" &&
      octets.every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}
