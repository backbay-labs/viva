import type { ConceptStatus, StudySetIngestionStatus } from "@viva/core";

export type VivaLibraryAction =
  | {
      available: true;
      session_id?: string | null;
      session_bootstrap_token?: string | null;
      session_token?: string | null;
      same_origin_control_token?: string | null;
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
  actions?: {
    delete?: VivaLibraryAction;
  };
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
  sameOriginControlToken?: string | null;
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
  delete: ProjectedLibraryAction;
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
  options: {
    directSessionTokens?: boolean;
    staticExport?: boolean;
  } = {},
): VivaLibrarySnapshot {
  return stripBrowserOnlyTokenFields(snapshot, {
    controlToken: !options.staticExport,
    sessionToken: !(options.staticExport || options.directSessionTokens),
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

/* --------------------------------------------------------------------- *
 * D-07 Branch A (`retain-token-only`, `FRONTEND-011`): same-origin session-
 * bootstrap composition. Branch A keeps `attachVivaSessionBootstrapTokensTo-
 * LibrarySnapshot`, `/api/viva-session/start`, and the landing bootstrap-
 * capability start/retry path (`LibraryStatusPanel.tsx`). This section holds
 * the pure logic that path composes around: the exact "complete start
 * response" shape a successful mint returns, a bounded (6000ms) timeout
 * wrapper around the start fetch — headers *and* body, one shared deadline —
 * so a hung mint can never hang the UI forever, and the "small local
 * indirection" this task owns in place of
 * Plan 10's not-yet-published `replaceBrowserSessionCredential`
 * (`apps/web/lib/use-viva-agent-session.ts` has no such export in this tree
 * — confirmed by reading that file before writing this code; Plan 10 wires
 * the real export into this seam once it exists, which is Phase 13B
 * integration work, not this task's). Nothing here reads `window`,
 * `localStorage`/`sessionStorage`, or calls `console.*` — the browser-bound
 * capability this composes around must never persist or log.
 * -------------------------------------------------------------------- */

/**
 * `POST /api/viva-session/start`'s response shape (`apps/web/app/api/viva-
 * session/shared.ts`, Plan-11-owned — not edited by this task). Today's real
 * route returns only `session`/`session_token`; the three optional fields
 * are the wire-level extension D-07 Branch A's retain-token-only refresh
 * contract will add. This type accepts either shape so the code below is
 * provably correct against both.
 */
export type VivaSessionStartResponse = {
  refresh_expires_at?: string;
  refresh_token?: string;
  session?: {
    session_id?: string;
    study_set_id?: string;
    user_id?: string;
  };
  session_absolute_expires_at?: string;
  session_token?: string;
};

/** D-07's selected branch, as a locked literal — never persisted, only ever handed to the vault seam. */
export const VIVA_SESSION_CREDENTIAL_VAULT_MODE = "retain-token-only" as const;

/**
 * The exact fields Plan 10's `replaceBrowserSessionCredential` must receive:
 * `session_token`, `refresh_token`, `refresh_expires_at`,
 * `session_absolute_expires_at`, identity, and the locked `mode`.
 */
export type BrowserSessionCredentialVaultInput = {
  mode: typeof VIVA_SESSION_CREDENTIAL_VAULT_MODE;
  refresh_expires_at: string | null;
  refresh_token: string | null;
  session_absolute_expires_at: string | null;
  session_id: string;
  session_token: string;
  study_set_id: string;
  user_id: string;
};

/** The in-memory credential-vault seam Plan 10's real hook will satisfy. */
export type BrowserSessionCredentialVault = {
  replaceBrowserSessionCredential: (input: BrowserSessionCredentialVaultInput) => void;
};

/**
 * Builds the complete vault input from a start response, or `null` when the
 * response lacks the minimum required fields (`session_token` and the full
 * session identity) to mint one at all. `refresh_token`/`refresh_expires_at`/
 * `session_absolute_expires_at` are optional in the response today — their
 * absence yields `null` fields here rather than rejecting the whole mint, so
 * this composes correctly against both today's real route response and its
 * eventual refresh-credential extension.
 */
export function browserSessionCredentialVaultInputFromStartResponse(
  response: VivaSessionStartResponse,
): BrowserSessionCredentialVaultInput | null {
  const sessionToken = trimmedOrNull(response.session_token);
  const sessionId = trimmedOrNull(response.session?.session_id);
  const studySetId = trimmedOrNull(response.session?.study_set_id);
  const userId = trimmedOrNull(response.session?.user_id);
  if (!sessionToken || !sessionId || !studySetId || !userId) return null;
  return {
    mode: VIVA_SESSION_CREDENTIAL_VAULT_MODE,
    refresh_expires_at: trimmedOrNull(response.refresh_expires_at),
    refresh_token: trimmedOrNull(response.refresh_token),
    session_absolute_expires_at: trimmedOrNull(response.session_absolute_expires_at),
    session_id: sessionId,
    session_token: sessionToken,
    study_set_id: studySetId,
    user_id: userId,
  };
}

/**
 * Phase-13A placeholder for Plan 10's not-yet-published
 * `replaceBrowserSessionCredential`. Every successful same-origin start
 * composes its call around this seam so the wiring is provable now; the
 * function itself stays inert (no storage, no network, no console output —
 * never a leak surface) until Plan 10's real export lands and this default
 * is swapped for it.
 */
export const pendingBrowserSessionCredentialVault: BrowserSessionCredentialVault = {
  replaceBrowserSessionCredential: () => {},
};

/** The shared 6000ms abort/timeout bound for the same-origin session-start mint and its expiry retry. */
export const VIVA_SESSION_START_FETCH_TIMEOUT_MS = 6000;

/** The client-injected `setTimeout`/`clearTimeout` pair `fetchWithVivaSessionStartTimeout` binds its abort to. */
export type VivaFetchTimers = {
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
};

const REAL_FETCH_TIMERS: VivaFetchTimers = {
  clearTimeout: (id) => clearTimeout(id),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

/** The exact fetch function shape `fetchWithVivaSessionStartTimeout` wraps — real `fetch` in production, an injectable double in tests. */
export type VivaBoundedFetch = (input: string, init: RequestInit) => Promise<Response>;

export type VivaBoundedFetchResult =
  | { ok: true; response: Response }
  | { ok: false; reason: "timeout" };

export type VivaBoundedOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" };

/**
 * The shared bound primitive `fetchWithVivaSessionStartTimeout` and
 * `LibraryStatusPanel.tsx`'s `requestServerSession` both build on: races
 * `operation(signal)` against `timeoutMs` (default
 * `VIVA_SESSION_START_FETCH_TIMEOUT_MS`, the plan's locked 6000ms policy —
 * the same value named for Plan 10's session-entry refresh timeout).
 * `signal` aborts exactly once, at the bound, and stays live for the whole
 * of `operation` — not only its first `await` — so a caller that chains a
 * response-body read (`response.json()`) after an already-settled fetch
 * inside the same `operation` still aborts at the bound if that read hangs;
 * the bound covers the complete round trip, not merely header arrival. Any
 * other rejection from `operation` propagates unchanged, so a genuine
 * network failure is never mislabeled a timeout. The timer is always
 * cleared, on every exit path, so a settled operation never leaves a
 * pending timer behind.
 */
export async function withVivaSessionStartTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; timers?: VivaFetchTimers } = {},
): Promise<VivaBoundedOperationResult<T>> {
  const timeoutMs = options.timeoutMs ?? VIVA_SESSION_START_FETCH_TIMEOUT_MS;
  const timers = options.timers ?? REAL_FETCH_TIMERS;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const value = await operation(controller.signal);
    return { ok: true, value };
  } catch (error) {
    if (timedOut) return { ok: false, reason: "timeout" };
    throw error;
  } finally {
    timers.clearTimeout(timeoutId);
  }
}

/**
 * Fetch-shaped convenience wrapper over `withVivaSessionStartTimeout`: bounds
 * only `fetchImpl`'s own settling (i.e. header arrival), handing back the raw
 * `Response` for the caller to read. Kept for callers that intentionally want
 * just the network step bounded; `LibraryStatusPanel.tsx`'s production start
 * flow instead calls `withVivaSessionStartTimeout` directly so its bound also
 * covers the response body read (see that primitive's doc comment).
 */
export async function fetchWithVivaSessionStartTimeout(
  fetchImpl: VivaBoundedFetch,
  input: string,
  init: RequestInit,
  options: { timeoutMs?: number; timers?: VivaFetchTimers } = {},
): Promise<VivaBoundedFetchResult> {
  const result = await withVivaSessionStartTimeout(
    (signal) => fetchImpl(input, { ...init, signal }),
    options,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
    delete: projectMutationAction(
      session.actions?.delete ?? {
        available: false,
        unavailable_reason: "server_mutation_unavailable",
      },
    ),
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
  if (!action.control_token && !action.same_origin_control_token) {
    return {
      available: false,
      unavailableReason: "control_token_unavailable",
    };
  }
  return {
    available: true,
    controlToken: action.control_token,
    sameOriginControlToken: action.same_origin_control_token,
  };
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
