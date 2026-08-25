import { describe, expect, test } from "bun:test";

import { projectLibrarySnapshot, type VivaLibrarySnapshot } from "@/agent/shared-web";
import type { AppConfig } from "@/runtime/config";
import { homeDisplayState, homeModelFromLibrary, homeTodayCopy } from "./home-model";

const config: AppConfig = {
  agentHttpUrl: "http://127.0.0.1:4318",
  agentWsUrl: "ws://127.0.0.1:4318/ws",
  restBearerToken: null,
  sessionToken: null,
  studySetId: "biology-midterm",
  userId: "user-1",
  wsBearerToken: null,
  wsOrigin: null,
};

const cannedLibrarySnapshot: VivaLibrarySnapshot = {
  privacy: {
    copy: "Voice recordings and transcripts are not saved.",
    export: { available: false, unavailable_reason: "control_token_unavailable" },
    export_contains_raw_provider_payloads: false,
    raw_audio_persistence: false,
    transcript_persistence: false,
    transcripts_saved: false,
    voice_recordings_saved: false,
  },
  sessions: [
    {
      next_review: {
        concept_id: "atp-synthase",
        label: "ATP synthase",
        persisted_due_at: "2026-08-25T13:00:00.000Z",
        source: "persisted_review_item",
        status: "missed",
      },
      recap: null,
      status: "closed",
      study_set_id: "biology-midterm",
      study_set_title: "Biology Midterm",
      terminal_reason: "completed",
      voice_session_id: "voice-session-old",
    },
  ],
  study_sets: [
    studySet("biology-midterm", "Biology Midterm", "Biology 201"),
    studySet("chemistry-final", "Chemistry Final", null),
  ],
  user_id: "user-1",
};

describe("homeModelFromLibrary", () => {
  test("keeps loading and failed library states neutral and non-startable", () => {
    expect(homeDisplayState({ kind: "loading" })).toMatchObject({
      activeStudySetId: null,
      displayModel: { canStart: false, studySetId: null, studySetTitle: "Opening your library" },
    });
    expect(homeDisplayState({ kind: "error" })).toMatchObject({
      activeStudySetId: null,
      displayModel: { canStart: false, studySetId: null, studySetTitle: "Library unavailable" },
    });
  });

  test("formats the current local date and a neutral time-dependent greeting", () => {
    expect(homeTodayCopy(new Date(2026, 7, 25, 8))).toEqual({
      dateLabel: "Tuesday · 25 August",
      greeting: "Good morning.",
    });
    expect(homeTodayCopy(new Date(2026, 7, 25, 14)).greeting).toBe("Good afternoon.");
    expect(homeTodayCopy(new Date(2026, 7, 25, 20)).greeting).toBe("Good evening.");
  });

  test("uses study-set metadata and the real persisted next-review signal", () => {
    const projection = projectLibrarySnapshot(cannedLibrarySnapshot, {
      now: new Date("2026-08-24T13:00:00.000Z"),
    });

    expect(homeModelFromLibrary(projection, cannedLibrarySnapshot, config)).toEqual({
      canStart: true,
      contextLabel: "Biology 201",
      studySetId: "biology-midterm",
      studySetTitle: "Biology Midterm",
      weakConceptDetail: "Missed · due Aug 25, 2026",
      weakConceptId: "atp-synthase",
      weakConceptTitle: "ATP synthase",
    });
  });

  test("labels concept and exam detail unavailable instead of fabricating snapshot fields", () => {
    const chemistry = cannedLibrarySnapshot.study_sets.find(
      (studySet) => studySet.id === "chemistry-final",
    );
    if (!chemistry) throw new Error("canned chemistry study set is missing");
    const snapshot = {
      ...cannedLibrarySnapshot,
      sessions: [],
      study_sets: [
        {
          ...chemistry,
          course: null,
        },
      ],
    };
    const projection = projectLibrarySnapshot(snapshot);

    expect(homeModelFromLibrary(projection, snapshot, config)).toEqual({
      canStart: false,
      contextLabel: "Exam date unavailable",
      studySetId: "chemistry-final",
      studySetTitle: "Chemistry Final",
      weakConceptDetail: "Concept detail unavailable from library",
      weakConceptId: null,
      weakConceptTitle: "Concept detail unavailable",
    });
  });

  test("chooses a startable study set instead of routing Home into an unavailable row", () => {
    const snapshot = {
      ...cannedLibrarySnapshot,
      study_sets: [...cannedLibrarySnapshot.study_sets].reverse(),
    };

    expect(homeModelFromLibrary(projectLibrarySnapshot(snapshot), snapshot, config)).toMatchObject({
      canStart: true,
      studySetId: "biology-midterm",
      studySetTitle: "Biology Midterm",
    });
  });

  test("enables the explicit trusted-loopback unsigned row even when web projection rejects it", () => {
    const first = cannedLibrarySnapshot.study_sets[0];
    if (!first) throw new Error("canned biology study set is missing");
    const snapshot = {
      ...cannedLibrarySnapshot,
      study_sets: [
        {
          ...first,
          actions: {
            ...first.actions,
            start: {
              available: false as const,
              unavailable_reason: "session_token_unavailable",
            },
          },
        },
      ],
    };
    const projection = projectLibrarySnapshot(snapshot);
    expect(projection.libraryRows[0]?.start).toMatchObject({ available: false });

    expect(homeModelFromLibrary(projection, snapshot, config)).toMatchObject({
      canStart: true,
      studySetId: "biology-midterm",
    });
  });

  test("threads Android runtime authority into emulator-host admission", () => {
    const first = cannedLibrarySnapshot.study_sets[0];
    if (!first) throw new Error("canned biology study set is missing");
    const snapshot = {
      ...cannedLibrarySnapshot,
      study_sets: [
        {
          ...first,
          actions: {
            ...first.actions,
            start: {
              available: false as const,
              unavailable_reason: "session_token_unavailable",
            },
          },
        },
      ],
    };
    const projection = projectLibrarySnapshot(snapshot);
    const androidEmulatorConfig = {
      ...config,
      agentHttpUrl: "http://10.0.2.2:4318",
      agentWsUrl: "ws://10.0.2.2:4318/ws",
    };

    expect(homeModelFromLibrary(projection, snapshot, androidEmulatorConfig)).toMatchObject({
      canStart: false,
    });
    expect(
      homeModelFromLibrary(projection, snapshot, androidEmulatorConfig, "android"),
    ).toMatchObject({
      canStart: true,
      studySetId: "biology-midterm",
    });
  });

  test("returns an explicitly empty model when the library has no study sets", () => {
    const snapshot = { ...cannedLibrarySnapshot, sessions: [], study_sets: [] };

    expect(homeModelFromLibrary(projectLibrarySnapshot(snapshot), snapshot, config)).toEqual({
      canStart: false,
      contextLabel: "Exam date unavailable",
      studySetId: null,
      studySetTitle: "No study set available",
      weakConceptDetail: "Concept detail unavailable from library",
      weakConceptId: null,
      weakConceptTitle: "Concept detail unavailable",
    });
  });
});

function studySet(
  id: string,
  title: string,
  course: string | null,
): VivaLibrarySnapshot["study_sets"][number] {
  const canStart = id === "biology-midterm";
  return {
    actions: {
      archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
      delete: { available: false, unavailable_reason: "server_mutation_unavailable" },
      resume: { available: false, unavailable_reason: "no_open_session" },
      start: canStart
        ? {
            available: true,
            session_id: "voice-session-new",
            session_token: "viva1.mobile-session",
          }
        : { available: false, unavailable_reason: "session_unavailable" },
    },
    concept_count: canStart ? 2 : 0,
    course,
    documents: canStart
      ? [
          {
            deleted: false,
            display_name: "Lecture 5.pdf",
            id: "lecture-5",
            processing_status: "ready",
            source_kind: "pdf",
          },
        ]
      : [],
    id,
    ingestion_error: null,
    ingestion_status: "ready",
    question_count: canStart ? 1 : 0,
    server_owned: true,
    title,
    user_id: "user-1",
  };
}
