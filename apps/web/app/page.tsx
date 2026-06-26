import { LandingEntry } from "../components/landing/LandingEntry";
import {
  fetchVivaLibrarySnapshot,
  type VivaLibrarySnapshotOptions,
  vivaStaticExportEnabled,
} from "../lib/viva-agent-client";
import { browserInitialLibrarySnapshot, type VivaLibrarySnapshot } from "../lib/viva-library";
import {
  attachVivaLibraryControlTokensToLibrarySnapshot,
  attachVivaSessionBootstrapTokensToLibrarySnapshot,
} from "./api/viva-session/shared";

export const dynamic = "auto";

export default async function Page() {
  const initialLibrarySnapshot = await initialSnapshot();
  return <LandingEntry initialLibrarySnapshot={initialLibrarySnapshot} />;
}

async function initialSnapshot(): Promise<VivaLibrarySnapshot | null> {
  try {
    const config = serverLibrarySnapshotConfig();
    if (config.kind === "incomplete") return null;

    const snapshot = await fetchVivaLibrarySnapshot(
      config.kind === "ready" ? { ...config.options, cache: "no-store" } : {},
    );
    const filteredSnapshot =
      config.kind === "ready"
        ? filterInitialLibrarySnapshot(snapshot, {
            allowedStudySetIds: config.allowedStudySetIds,
            userId: config.options.userId ?? "",
          })
        : snapshot;
    const bootstrapSnapshot =
      config.kind === "ready"
        ? attachVivaSessionBootstrapTokensToLibrarySnapshot(filteredSnapshot, {
            allowedStudySetIds: config.allowedStudySetIds,
            userId: config.options.userId ?? "",
          })
        : filteredSnapshot;
    const browserSnapshot =
      config.kind === "ready"
        ? attachVivaLibraryControlTokensToLibrarySnapshot(bootstrapSnapshot, {
            allowedStudySetIds: config.allowedStudySetIds,
            userId: config.options.userId ?? "",
          })
        : bootstrapSnapshot;
    return browserInitialLibrarySnapshot(browserSnapshot as VivaLibrarySnapshot, {
      directSessionTokens: config.kind === "disabled",
      staticExport: vivaStaticExportEnabled(),
    });
  } catch {
    return null;
  }
}

type ServerLibrarySnapshotConfig =
  | { kind: "disabled" }
  | { kind: "incomplete" }
  | {
      allowedStudySetIds: Set<string>;
      kind: "ready";
      options: VivaLibrarySnapshotOptions;
    };

function serverLibrarySnapshotConfig(): ServerLibrarySnapshotConfig {
  const apiBaseUrl = process.env.VIVA_AGENT_HTTP_URL?.trim();
  const bearerToken = process.env.VIVA_AGENT_REST_BEARER_TOKEN?.trim();
  const userId = firstConfiguredValue("VIVA_SESSION_ALLOWED_USER_IDS");
  const allowedStudySetIds = configuredAllowlist("VIVA_SESSION_ALLOWED_STUDY_SET_IDS");
  const hasServerBootstrapConfig = Boolean(
    apiBaseUrl || bearerToken || userId || allowedStudySetIds,
  );
  if (!hasServerBootstrapConfig) return { kind: "disabled" };
  if (!apiBaseUrl || !bearerToken || !userId || !allowedStudySetIds) {
    return { kind: "incomplete" };
  }
  return {
    allowedStudySetIds,
    kind: "ready",
    options: { apiBaseUrl, bearerToken, userId },
  };
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
    privacy: filterInitialLibraryPrivacy(snapshot.privacy),
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

function filterInitialLibraryPrivacy(
  privacy: VivaLibrarySnapshot["privacy"],
): VivaLibrarySnapshot["privacy"] {
  return {
    ...privacy,
    export: {
      available: false,
      unavailable_reason: "allowlist_filtered_export_unavailable",
    },
  };
}
