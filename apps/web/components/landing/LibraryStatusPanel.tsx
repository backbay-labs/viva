"use client";

import { MasteryRing } from "@viva/ui-web";
import { useEffect, useState } from "react";
import {
  deleteVivaSessionHistory,
  deleteVivaStudySet,
  exportVivaLibraryData,
  fetchVivaLibrarySnapshot,
} from "../../lib/viva-agent-client";
import { projectLibrarySnapshot, type VivaLibrarySnapshot } from "../../lib/viva-library";
import { librarySessionTarget } from "../../lib/viva-session-entry";

type LibraryProjection = ReturnType<typeof projectLibrarySnapshot>;
type LibraryRow = LibraryProjection["libraryRows"][number];
type SessionRow = LibraryProjection["sessionRows"][number];

export function LibraryStatusPanel({
  snapshot,
  now,
}: {
  snapshot?: VivaLibrarySnapshot | null;
  now?: Date;
}) {
  const [currentSnapshot, setCurrentSnapshot] = useState(snapshot ?? null);
  const [status, setStatus] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => setCurrentSnapshot(snapshot ?? null), [snapshot]);

  if (!currentSnapshot) return null;
  const projection = projectLibrarySnapshot(currentSnapshot, { now });
  const controlToken = projection.privacy.export.controlToken ?? undefined;
  const refreshLibrary = async () => {
    setCurrentSnapshot(
      await fetchVivaLibrarySnapshot({
        controlToken,
        userId: projection.userId,
      }),
    );
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
        controlToken,
        userId: projection.userId,
      });
      downloadJson(`viva-export-${projection.userId}.json`, exported);
    });
  const deleteStudySet = (row: LibraryRow) =>
    runControl("Delete source", async () => {
      await deleteVivaStudySet(row.id, {
        controlToken,
        userId: projection.userId,
      });
      await refreshLibrary();
    });
  const deleteSession = (row: SessionRow) =>
    runControl("Delete recap", async () => {
      await deleteVivaSessionHistory(row.studySetId, row.id, {
        controlToken,
        userId: projection.userId,
      });
      await refreshLibrary();
    });

  return (
    <section aria-label="Library" className="viva-library">
      <div className="viva-library__inner">
        <div className="viva-library__privacy">
          <div>
            <p>Privacy controls</p>
            <span>{projection.privacy.copy}</span>
          </div>
          <button
            disabled={!projection.privacy.export.available || busyAction === "Export data"}
            onClick={exportLibrary}
            type="button"
          >
            Export data
          </button>
        </div>
        {status ? (
          <p aria-live="polite" className="viva-library__status">
            {status}
          </p>
        ) : null}
        <div className="viva-library__section">
          <header className="viva-library__header">
            <h2>Library</h2>
            <span>{projection.libraryRows.length} server-owned sets</span>
          </header>
          <div className="viva-library__grid">
            {projection.libraryRows.map((row) => (
              <LibraryStudySetRow
                busy={busyAction === "Delete source"}
                key={row.id}
                onDelete={deleteStudySet}
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
            {projection.sessionRows.map((row) => (
              <article className="viva-library__row viva-library__row--session" key={row.id}>
                {row.mastery ? (
                  <MasteryRing
                    color="var(--sage)"
                    pct={row.mastery.strongPct}
                    size={52}
                    stroke={5}
                  />
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
                    disabled={!projection.privacy.export.available || busyAction === "Delete recap"}
                    onClick={() => deleteSession(row)}
                    type="button"
                  >
                    Delete recap
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function LibraryStudySetRow({
  busy,
  onDelete,
  row,
}: {
  busy: boolean;
  onDelete: (row: LibraryRow) => void;
  row: LibraryRow;
}) {
  const startTarget = libraryActionTarget(row, row.start);
  const resumeTarget = libraryActionTarget(row, row.resume);
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
          disabled={!row.start.available}
          onClick={() => navigateToSession(startTarget)}
          type="button"
        >
          Start
        </button>
        <button
          aria-label={`Resume ${row.title}`}
          className="viva-library__action--primary"
          data-session-target={resumeTarget}
          disabled={!row.resume.available}
          onClick={() => navigateToSession(resumeTarget)}
          type="button"
        >
          Resume
        </button>
        <button
          aria-label={`Delete source for ${row.title}`}
          className="viva-library__action--danger"
          disabled={!row.delete.available || busy}
          onClick={() => onDelete(row)}
          type="button"
        >
          Delete source
        </button>
      </div>
    </article>
  );
}

function libraryActionTarget(row: LibraryRow, action: LibraryRow["start"]) {
  if (!action.available) return "/session";
  return librarySessionTarget({
    sessionId: action.sessionId,
    sessionToken: action.sessionToken,
    studySetId: row.id,
    userId: row.userId,
  });
}

function navigateToSession(target: string) {
  if (typeof window !== "undefined") window.location.assign(target);
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
