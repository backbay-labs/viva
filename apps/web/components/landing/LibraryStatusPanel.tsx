"use client";

import { projectLibrarySnapshot, type VivaLibrarySnapshot } from "../../lib/viva-library";
import { librarySessionTarget } from "../../lib/viva-session-entry";

export function LibraryStatusPanel({
  snapshot,
  now,
}: {
  snapshot?: VivaLibrarySnapshot | null;
  now?: Date;
}) {
  if (!snapshot) return null;
  const projection = projectLibrarySnapshot(snapshot, { now });
  return (
    <section aria-label="Library" className="viva-library">
      <div className="viva-library__inner">
        <div className="viva-library__section">
          <header className="viva-library__header">
            <h2>Library</h2>
            <span>{projection.libraryRows.length} server-owned sets</span>
          </header>
          <div className="viva-library__grid">
            {projection.libraryRows.map((row) => (
              <LibraryStudySetRow key={row.id} row={row} />
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
              <article className="viva-library__row" key={row.id}>
                <div>
                  <h3>{row.studySetTitle}</h3>
                  <p>{row.statusLabel}</p>
                </div>
                <div className="viva-library__meta">
                  <span>{row.recapLabel}</span>
                  {row.nextReview ? (
                    <span>
                      {row.nextReview.label} · {row.nextReview.intervalLabel} · server schedule
                    </span>
                  ) : (
                    <span>No scheduled review</span>
                  )}
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
  row,
}: {
  row: ReturnType<typeof projectLibrarySnapshot>["libraryRows"][number];
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
          data-session-target={startTarget}
          disabled={!row.start.available}
          onClick={() => navigateToSession(startTarget)}
          type="button"
        >
          Start
        </button>
        <button
          aria-label={`Resume ${row.title}`}
          data-session-target={resumeTarget}
          disabled={!row.resume.available}
          onClick={() => navigateToSession(resumeTarget)}
          type="button"
        >
          Resume
        </button>
      </div>
    </article>
  );
}

function libraryActionTarget(
  row: ReturnType<typeof projectLibrarySnapshot>["libraryRows"][number],
  action: ReturnType<typeof projectLibrarySnapshot>["libraryRows"][number]["start"],
) {
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
