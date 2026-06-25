import { LandingEntry } from "../components/landing/LandingEntry";
import {
  fetchVivaLibrarySnapshot,
  type VivaLibrarySnapshotOptions,
  vivaStaticExportEnabled,
} from "../lib/viva-agent-client";
import { browserInitialLibrarySnapshot, type VivaLibrarySnapshot } from "../lib/viva-library";
import { attachVivaSessionBootstrapTokensToLibrarySnapshot } from "./api/viva-session/shared";

export const dynamic = "force-dynamic";

export default async function Page() {
  const initialLibrarySnapshot = await initialSnapshot();
  return <LandingEntry initialLibrarySnapshot={initialLibrarySnapshot} />;
}

async function initialSnapshot(): Promise<VivaLibrarySnapshot | null> {
  try {
    const options = serverLibrarySnapshotOptions();
    const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
    if (options && !allowedStudySetIds) return null;
    const snapshot = await fetchVivaLibrarySnapshot(options ?? {});
    const filteredSnapshot =
      options && allowedStudySetIds
        ? filterInitialLibrarySnapshot(snapshot, {
            allowedStudySetIds,
            userId: options.userId ?? "",
          })
        : snapshot;
    const browserSnapshot = options
      ? attachVivaSessionBootstrapTokensToLibrarySnapshot(filteredSnapshot, {
          allowedStudySetIds,
          userId: options.userId ?? "",
        })
      : filteredSnapshot;
    return browserInitialLibrarySnapshot(browserSnapshot as VivaLibrarySnapshot, {
      staticExport: vivaStaticExportEnabled(),
    });
  } catch {
    return null;
  }
}

function serverLibrarySnapshotOptions(): VivaLibrarySnapshotOptions | null {
  const apiBaseUrl = process.env.VIVA_AGENT_HTTP_URL?.trim();
  const bearerToken = process.env.VIVA_AGENT_REST_BEARER_TOKEN?.trim();
  const userId = firstConfiguredValue("VIVA_SESSION_ALLOWED_USER_IDS");
  if (!apiBaseUrl || !bearerToken || !userId) return null;
  return { apiBaseUrl, bearerToken, userId };
}

function firstConfiguredValue(envName: string): string | null {
  return (
    process.env[envName]
      ?.split(",")
      .map((entry) => entry.trim())
      .find(Boolean) ?? null
  );
}

function configuredAllowlist(envName: string): Set<string> | null {
  const entries = process.env[envName]
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries?.length ? new Set(entries) : null;
}

function filterInitialLibrarySnapshot(
  snapshot: VivaLibrarySnapshot,
  filter: { allowedStudySetIds: Set<string>; userId: string },
): VivaLibrarySnapshot {
  return {
    ...snapshot,
    sessions: snapshot.sessions.filter(
      (session) =>
        session.user_id === filter.userId && filter.allowedStudySetIds.has(session.study_set_id),
    ),
    study_sets: snapshot.study_sets.filter(
      (studySet) =>
        studySet.user_id === filter.userId && filter.allowedStudySetIds.has(studySet.id),
    ),
    user_id: filter.userId,
  };
}
