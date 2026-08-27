"use client";

import { MasteryRing } from "@viva/ui-web";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import {
  deleteVivaSessionHistory,
  deleteVivaStudySet,
  exportVivaLibraryData,
  fetchVivaLibrarySnapshot,
} from "../../lib/viva-agent-client";
import {
  type BrowserSessionCredentialVault,
  browserSessionCredentialVaultInputFromStartResponse,
  pendingBrowserSessionCredentialVault,
  projectLibrarySnapshot,
  type VivaLibrarySnapshot,
  type VivaSessionStartResponse,
  withVivaSessionStartTimeout,
} from "../../lib/viva-library";
import { librarySessionTarget } from "../../lib/viva-session-entry";

type LibraryProjection = ReturnType<typeof projectLibrarySnapshot>;
type LibraryRow = LibraryProjection["libraryRows"][number];

export type LibraryActionSessionTargetRow = {
  id: string;
  userId: string;
};

export type LibraryActionSessionTargetAction = {
  available: boolean;
  sessionId?: string | null;
  sessionBootstrapToken?: string | null;
  sessionToken?: string | null;
};

/**
 * D-04 `CONFIRM_DELETE` (`FRONTEND-004`): the single pending-deletion model
 * both a study-set/source row and a session-recap/history row share. `kind`
 * plus `rowId` name the exact target the open `role="alertdialog"` names and
 * the exact table endpoint a confirm issues; `submitting` is the network-in-
 * flight flag the confirm button disables on — the actual double-activation
 * guard is the synchronous `deletionSubmittingRef` in `LibraryStatusPanel`,
 * since two same-tick clicks can both observe this flag before either state
 * update commits.
 */
type PendingDeletion = {
  kind: "study_set" | "session_history";
  rowId: string;
  submitting: boolean;
};

export function LibraryStatusPanel({
  navigate,
  now,
  sessionCredentialVault,
  snapshot,
  startFetchTimeoutMs,
}: {
  navigate?: (target: string) => void;
  now?: Date;
  sessionCredentialVault?: BrowserSessionCredentialVault;
  snapshot?: VivaLibrarySnapshot | null;
  /** Test-only override for the D-07 Branch A same-origin start fetch's abort bound; production always uses the locked `VIVA_SESSION_START_FETCH_TIMEOUT_MS` default. */
  startFetchTimeoutMs?: number;
}) {
  const [currentSnapshot, setCurrentSnapshot] = useState(snapshot ?? null);
  const [status, setStatus] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null);
  const dialogIdBase = useId();
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const initiatingDeleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const deletionSubmittingRef = useRef(false);

  useEffect(() => setCurrentSnapshot(snapshot ?? null), [snapshot]);

  // Moves focus to the confirm action whenever a dialog opens for a new
  // target. `pendingDeletion` is a fresh object on every state change
  // (open, the submitting flip, close), so this also re-runs on those — but
  // the guard only ever focuses on a truthy, not-yet-submitting value, and
  // this state machine never returns to `submitting: false` for the same
  // target once confirm has been clicked (it goes straight to `null`
  // instead), so it can never steal focus back mid-flight.
  useEffect(() => {
    if (pendingDeletion && !pendingDeletion.submitting) {
      confirmDeleteButtonRef.current?.focus();
    }
  }, [pendingDeletion]);

  if (!currentSnapshot) return null;
  const projection = projectLibrarySnapshot(currentSnapshot, { now });
  const exportControlToken = libraryActionControlToken(projection.privacy.export);
  const refreshLibrary = async () => {
    const nextSnapshot = await fetchVivaLibrarySnapshot({
      controlToken: exportControlToken,
      userId: projection.userId,
    });
    setCurrentSnapshot(nextSnapshot);
    return nextSnapshot;
  };
  const runControl = async (label: string, action: () => Promise<void>) => {
    setBusyAction(label);
    setStatus("");
    try {
      await action();
      setStatus(`${label} complete.`);
    } catch {
      setStatus(`${label} failed.`);
    } finally {
      setBusyAction(null);
    }
  };
  const exportLibrary = () =>
    runControl("Export data", async () => {
      const exported = await exportVivaLibraryData({
        controlToken: exportControlToken,
        userId: projection.userId,
      });
      downloadJson(`viva-export-${projection.userId}.json`, exported);
    });
  const registerInitiatingDeleteButtonRef = (key: string, element: HTMLButtonElement | null) => {
    if (element) initiatingDeleteButtonRefs.current.set(key, element);
    else initiatingDeleteButtonRefs.current.delete(key);
  };
  const focusInitiatingDeleteButton = (kind: PendingDeletion["kind"], rowId: string) => {
    initiatingDeleteButtonRefs.current.get(`${kind}:${rowId}`)?.focus();
  };
  /** The first click only ever opens named confirmation — never issues a DELETE. */
  const requestPendingDeletion = (kind: PendingDeletion["kind"], rowId: string) => {
    setPendingDeletion((current) =>
      current?.submitting ? current : { kind, rowId, submitting: false },
    );
  };
  const cancelPendingDeletion = () => {
    if (!pendingDeletion || pendingDeletion.submitting) return;
    const target = pendingDeletion;
    setPendingDeletion(null);
    focusInitiatingDeleteButton(target.kind, target.rowId);
  };
  const confirmPendingDeletion = async () => {
    // Synchronous, ref-based guard: two same-tick clicks both run before
    // either `setPendingDeletion`/`setBusyAction` update commits, so a state
    // read alone cannot stop the second one — this can.
    if (!pendingDeletion || deletionSubmittingRef.current) return;
    deletionSubmittingRef.current = true;
    const target = pendingDeletion;
    const label = target.kind === "study_set" ? "Delete source" : "Delete recap";
    setPendingDeletion({ ...target, submitting: true });
    setBusyAction(label);
    setStatus("");
    try {
      if (target.kind === "study_set") {
        const row = projection.libraryRows.find((candidate) => candidate.id === target.rowId);
        if (!row) throw new Error("study set row missing for pending deletion");
        await deleteVivaStudySet(row.id, {
          controlToken: libraryActionControlToken(row.delete),
          userId: projection.userId,
        });
      } else {
        const row = projection.sessionRows.find((candidate) => candidate.id === target.rowId);
        if (!row) throw new Error("session row missing for pending deletion");
        await deleteVivaSessionHistory(row.studySetId, row.id, {
          controlToken: libraryActionControlToken(row.delete),
          userId: projection.userId,
        });
      }
      setStatus(`${label} complete.`);
      await refreshLibrary();
      setPendingDeletion(null);
    } catch {
      setStatus(`${label} failed.`);
      setPendingDeletion(null);
      focusInitiatingDeleteButton(target.kind, target.rowId);
    } finally {
      setBusyAction(null);
      deletionSubmittingRef.current = false;
    }
  };
  const startLibrarySession = async (
    row: LibraryRow,
    actionName: "resume" | "start",
    action: LibraryRow["start"],
  ) => {
    setBusyAction(`${actionName}:${row.id}`);
    setStatus("");
    try {
      const outcome = await startServerSession(row, actionName, action, {
        navigate,
        refreshLibrary,
        sessionCredentialVault,
        timeoutMs: startFetchTimeoutMs,
      });
      if (!outcome.ok) setStatus(sessionStartFailureStatus(outcome.reason));
    } catch {
      setStatus("Session start failed.");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section aria-label="Library" className="viva-library">
      <div className="viva-library__inner">
        <div className="viva-library__privacy">
          <div>
            <p>Privacy controls</p>
            <span>{projection.privacy.copy}</span>
            <span>{projection.privacy.dataHandlingStatement}</span>
            <span>{projection.privacy.retentionStatement}</span>
            <span>{projection.privacy.deletionStatement}</span>
          </div>
          <button
            disabled={!projection.privacy.export.available || busyAction === "Export data"}
            onClick={exportLibrary}
            type="button"
          >
            Export data
          </button>
        </div>
        {/* Always mounted — never appearing/disappearing — so a screen reader
            reliably picks up an announcement without needing to notice a
            freshly-inserted live region. */}
        <p aria-live="polite" className="viva-library__status" role="status">
          {status}
        </p>
        <div className="viva-library__section">
          <header className="viva-library__header">
            <h2>Library</h2>
            <span>{projection.libraryRows.length} server-owned sets</span>
          </header>
          <div className="viva-library__grid">
            {projection.libraryRows.map((row) => (
              <LibraryStudySetRow
                busy={busyAction !== null}
                confirmDeleteButtonRef={confirmDeleteButtonRef}
                dialogIdBase={dialogIdBase}
                key={row.id}
                onCancelDelete={cancelPendingDeletion}
                onConfirmDelete={confirmPendingDeletion}
                onRequestDelete={requestPendingDeletion}
                onStartSession={startLibrarySession}
                pendingDeletion={pendingDeletion}
                registerInitiatingDeleteButtonRef={registerInitiatingDeleteButtonRef}
                row={row}
              />
            ))}
          </div>
        </div>

        <div className="viva-library__section">
          <header className="viva-library__header">
            <h2>Sessions</h2>
            <span>{projection.sessionRows.length} durable recaps</span>
          </header>
          <div className="viva-library__grid">
            {projection.sessionRows.map((row) => {
              const isPendingThisRow =
                pendingDeletion?.kind === "session_history" && pendingDeletion.rowId === row.id;
              return (
                <article className="viva-library__row viva-library__row--session" key={row.id}>
                  {row.mastery ? (
                    <div className="viva-library__mastery">
                      <MasteryRing
                        color="var(--sage)"
                        pct={row.mastery.strongPct}
                        size={52}
                        stroke={5}
                      />
                      <span className="viva-library__mastery-caption">held</span>
                    </div>
                  ) : (
                    <span className="viva-library__ring-placeholder" aria-hidden="true" />
                  )}
                  <div>
                    <h3>{row.studySetTitle}</h3>
                    <p>{row.statusLabel}</p>
                  </div>
                  <div className="viva-library__meta">
                    <span>{row.recapLabel}</span>
                    {row.nextReview ? (
                      <span className="viva-library__next-drill">
                        Next drill: {row.nextReview.label} · {row.nextReview.intervalLabel} · server
                        schedule
                      </span>
                    ) : (
                      <span>No scheduled review</span>
                    )}
                  </div>
                  <div className="viva-library__actions">
                    <button
                      aria-label={`Delete recap for ${row.studySetTitle}`}
                      className="viva-library__action--danger"
                      disabled={!row.delete.available || busyAction !== null}
                      onClick={() => requestPendingDeletion("session_history", row.id)}
                      ref={(element) =>
                        registerInitiatingDeleteButtonRef(`session_history:${row.id}`, element)
                      }
                      type="button"
                    >
                      Delete recap
                    </button>
                  </div>
                  {isPendingThisRow ? (
                    <DeleteConfirmDialog
                      confirmButtonRef={confirmDeleteButtonRef}
                      descriptionId={`${dialogIdBase}-session_history-${row.id}-description`}
                      descriptionText={`This permanently deletes the session recap for ${row.studySetTitle} and its schedule history. This cannot be undone.`}
                      onCancel={cancelPendingDeletion}
                      onConfirm={confirmPendingDeletion}
                      submitting={pendingDeletion?.submitting ?? false}
                      titleId={`${dialogIdBase}-session_history-${row.id}-title`}
                      titleText={`Delete ${row.studySetTitle} session recap?`}
                    />
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function libraryActionControlToken(action: {
  controlToken?: string | null;
  sameOriginControlToken?: string | null;
}): string | undefined {
  return action.controlToken?.trim() || action.sameOriginControlToken?.trim() || undefined;
}

function LibraryStudySetRow({
  busy,
  confirmDeleteButtonRef,
  dialogIdBase,
  onCancelDelete,
  onConfirmDelete,
  onRequestDelete,
  onStartSession,
  pendingDeletion,
  registerInitiatingDeleteButtonRef,
  row,
}: {
  busy: boolean;
  confirmDeleteButtonRef: RefObject<HTMLButtonElement | null>;
  dialogIdBase: string;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onRequestDelete: (kind: PendingDeletion["kind"], rowId: string) => void;
  onStartSession: (
    row: LibraryRow,
    actionName: "resume" | "start",
    action: LibraryRow["start"],
  ) => void;
  pendingDeletion: PendingDeletion | null;
  registerInitiatingDeleteButtonRef: (key: string, element: HTMLButtonElement | null) => void;
  row: LibraryRow;
}) {
  const startTarget = libraryActionSessionTarget(row, row.start);
  const resumeTarget = libraryActionSessionTarget(row, row.resume);
  const isPendingThisRow =
    pendingDeletion?.kind === "study_set" && pendingDeletion.rowId === row.id;
  return (
    <article className="viva-library__row">
      <div>
        <h3>{row.title}</h3>
        <p>{row.course ?? "No course"}</p>
      </div>
      <div className="viva-library__meta">
        <span>{row.statusLabel}</span>
        <span>{row.documentSummary}</span>
        <span>{row.detail}</span>
      </div>
      <div className="viva-library__actions">
        <button
          aria-label={`Start ${row.title}`}
          className="viva-library__action--primary"
          data-session-target={startTarget}
          disabled={!row.start.available || busy}
          onClick={() => onStartSession(row, "start", row.start)}
          type="button"
        >
          Start
        </button>
        <button
          aria-label={`Resume ${row.title}`}
          className="viva-library__action--primary"
          data-session-target={resumeTarget}
          disabled={!row.resume.available || busy}
          onClick={() => onStartSession(row, "resume", row.resume)}
          type="button"
        >
          Resume
        </button>
        <button
          aria-label={`Delete source for ${row.title}`}
          className="viva-library__action--danger"
          disabled={!row.delete.available || busy}
          onClick={() => onRequestDelete("study_set", row.id)}
          ref={(element) => registerInitiatingDeleteButtonRef(`study_set:${row.id}`, element)}
          type="button"
        >
          Delete source
        </button>
      </div>
      {isPendingThisRow ? (
        <DeleteConfirmDialog
          confirmButtonRef={confirmDeleteButtonRef}
          descriptionId={`${dialogIdBase}-study_set-${row.id}-description`}
          descriptionText={`This permanently deletes ${row.title}, its documents, and study progress. This cannot be undone.`}
          onCancel={onCancelDelete}
          onConfirm={onConfirmDelete}
          submitting={pendingDeletion?.submitting ?? false}
          titleId={`${dialogIdBase}-study_set-${row.id}-title`}
          titleText={`Delete ${row.title}?`}
        />
      ) : null}
    </article>
  );
}

/**
 * D-04 `CONFIRM_DELETE`'s one shared inline dialog: `role="alertdialog"`
 * named/described via `aria-labelledby`/`aria-describedby` (ids namespaced
 * off one `useId()` call in the parent, per row and kind — see
 * `PendingDeletion`), Escape wired locally so it never depends on a caller
 * remembering to forward the key event, and a `disabled` confirm action
 * that mirrors (but does not replace) the parent's synchronous double-
 * activation guard.
 */
function DeleteConfirmDialog({
  confirmButtonRef,
  descriptionId,
  descriptionText,
  onCancel,
  onConfirm,
  submitting,
  titleId,
  titleText,
}: {
  confirmButtonRef: RefObject<HTMLButtonElement | null>;
  descriptionId: string;
  descriptionText: string;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
  titleId: string;
  titleText: string;
}) {
  return (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="viva-library__delete-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      role="alertdialog"
    >
      <p className="viva-library__delete-dialog-title" id={titleId}>
        {titleText}
      </p>
      <p className="viva-library__delete-dialog-description" id={descriptionId}>
        {descriptionText}
      </p>
      <div className="viva-library__delete-dialog-actions">
        <button disabled={submitting} onClick={onCancel} type="button">
          Cancel
        </button>
        <button disabled={submitting} onClick={onConfirm} ref={confirmButtonRef} type="button">
          Delete
        </button>
      </div>
    </div>
  );
}

export function libraryActionSessionTarget(
  row: LibraryActionSessionTargetRow,
  action: LibraryActionSessionTargetAction,
  options: { includeSessionToken?: boolean } = {},
) {
  if (!action.available) return "/session";
  return librarySessionTarget({
    sessionId: action.sessionId,
    sessionToken: options.includeSessionToken ? action.sessionToken : undefined,
    studySetId: row.id,
    userId: row.userId,
  });
}

/**
 * Why a start attempt did not reach `/session`: `"unavailable"` means the
 * row's action was never available at all; `"start_failed"` covers a
 * rejected/malformed mint (including a bootstrap-expiry retry that still
 * failed, or one with no `refreshLibrary` to retry through); `"timed_out"`
 * is the D-07 Branch A 6000ms fetch bound firing on a hung mint — kept
 * distinct so the UI can surface an honest, explicit status instead of
 * folding a hang into the same generic failure message.
 */
export type StartServerSessionOutcome =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "start_failed" | "timed_out" };

export async function startServerSession(
  row: LibraryRow,
  actionName: "resume" | "start",
  action: LibraryRow["start"],
  options: {
    navigate?: (target: string) => void;
    refreshLibrary?: () => Promise<VivaLibrarySnapshot>;
    sessionCredentialVault?: BrowserSessionCredentialVault;
    timeoutMs?: number;
  } = {},
): Promise<StartServerSessionOutcome> {
  if (!action.available) return { ok: false, reason: "unavailable" };
  const navigate = options.navigate ?? navigateToSession;
  const vault = options.sessionCredentialVault ?? pendingBrowserSessionCredentialVault;
  if (action.sessionToken?.trim()) {
    // A direct session token already available on the snapshot (the D-06/
    // trust-contract fast path) never mints through `/api/viva-session/
    // start`, so it has no start response to hand the vault seam.
    navigate(
      libraryActionSessionTarget(row, action, {
        includeSessionToken: true,
      }),
    );
    return { ok: true };
  }
  const firstAttempt = await requestServerSession(row, actionName, action, options.timeoutMs);
  if (firstAttempt.ok) {
    completeServerSessionStart(vault, firstAttempt.startResponse, navigate, firstAttempt.target);
    return { ok: true };
  }
  if (firstAttempt.timedOut) return { ok: false, reason: "timed_out" };
  if (!firstAttempt.bootstrapCapabilityExpired || !options.refreshLibrary) {
    return { ok: false, reason: "start_failed" };
  }

  const refreshedSnapshot = await options.refreshLibrary();
  const refreshedProjection = projectLibrarySnapshot(refreshedSnapshot);
  const refreshedRow = refreshedProjection.libraryRows.find((candidate) => candidate.id === row.id);
  const refreshedAction = refreshedRow?.[actionName];
  if (!refreshedRow || !refreshedAction?.available) return { ok: false, reason: "start_failed" };
  if (refreshedAction.sessionToken?.trim()) {
    navigate(
      libraryActionSessionTarget(refreshedRow, refreshedAction, {
        includeSessionToken: true,
      }),
    );
    return { ok: true };
  }
  const retryAttempt = await requestServerSession(
    refreshedRow,
    actionName,
    refreshedAction,
    options.timeoutMs,
  );
  if (!retryAttempt.ok) {
    return { ok: false, reason: retryAttempt.timedOut ? "timed_out" : "start_failed" };
  }
  completeServerSessionStart(vault, retryAttempt.startResponse, navigate, retryAttempt.target);
  return { ok: true };
}

/**
 * Hands the complete start response to the credential-vault seam — Plan
 * 10's not-yet-published `replaceBrowserSessionCredential`, stood in for by
 * `pendingBrowserSessionCredentialVault` until it lands — strictly before
 * navigating away, exactly once per successful mint.
 */
function completeServerSessionStart(
  vault: BrowserSessionCredentialVault,
  startResponse: VivaSessionStartResponse,
  navigate: (target: string) => void,
  target: string,
) {
  const vaultInput = browserSessionCredentialVaultInputFromStartResponse(startResponse);
  if (vaultInput) vault.replaceBrowserSessionCredential(vaultInput);
  navigate(target);
}

/**
 * Discriminated shape `requestServerSession`'s bounded `operation` resolves
 * to internally, before being unwrapped back into that function's own return
 * shape. Keeping this inside the single `withVivaSessionStartTimeout` call
 * (rather than returning early from separate, independently-bounded steps)
 * is what keeps the fetch *and* both possible `response.json()` reads under
 * one shared deadline/abort signal — see that primitive's doc comment.
 */
type ServerSessionAttemptOutcome =
  | { bootstrapCapabilityExpired: boolean; kind: "failed" }
  | { kind: "invalid" }
  | { kind: "ok"; startResponse: VivaSessionStartResponse; target: string };

async function requestServerSession(
  row: LibraryRow,
  actionName: "resume" | "start",
  action: LibraryRow["start"],
  timeoutMs?: number,
): Promise<
  | { ok: true; startResponse: VivaSessionStartResponse; target: string }
  | { bootstrapCapabilityExpired: boolean; ok: false; timedOut: boolean }
> {
  const bounded = await withVivaSessionStartTimeout<ServerSessionAttemptOutcome>(
    async (signal) => {
      const response = await fetch("/api/viva-session/start", {
        body: JSON.stringify({
          session_id: actionName === "resume" ? action.sessionId : undefined,
          session_bootstrap_token: action.sessionBootstrapToken,
          study_set_id: row.id,
          user_id: row.userId,
        }),
        cache: "no-store",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        return {
          bootstrapCapabilityExpired:
            response.status === 403 && body?.error === "session_bootstrap_capability_required",
          kind: "failed",
        };
      }
      const payload = (await response.json()) as VivaSessionStartResponse;
      if (
        !payload.session?.session_id ||
        !payload.session.study_set_id ||
        !payload.session.user_id ||
        !payload.session_token
      ) {
        return { kind: "invalid" };
      }
      return {
        kind: "ok",
        startResponse: payload,
        target: librarySessionTarget({
          sessionId: payload.session.session_id,
          sessionToken: payload.session_token,
          studySetId: payload.session.study_set_id,
          userId: payload.session.user_id,
        }),
      };
    },
    { timeoutMs },
  );
  if (!bounded.ok) {
    return { bootstrapCapabilityExpired: false, ok: false, timedOut: true };
  }
  const outcome = bounded.value;
  if (outcome.kind === "failed") {
    return {
      bootstrapCapabilityExpired: outcome.bootstrapCapabilityExpired,
      ok: false,
      timedOut: false,
    };
  }
  if (outcome.kind === "invalid") {
    return { bootstrapCapabilityExpired: false, ok: false, timedOut: false };
  }
  return { ok: true, startResponse: outcome.startResponse, target: outcome.target };
}

function navigateToSession(target: string) {
  if (typeof window !== "undefined") window.location.assign(target);
}

function sessionStartFailureStatus(reason: "unavailable" | "start_failed" | "timed_out"): string {
  return reason === "timed_out" ? "Session start timed out." : "Session start failed.";
}

function downloadJson(filename: string, value: unknown) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
