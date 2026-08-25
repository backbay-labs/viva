import { describe, expect, test } from "bun:test";
import type { Concept, StudySet } from "@viva/core";

import type { VivaLibrarySnapshot } from "@/agent/shared-web";
import type { AppConfig } from "@/runtime/config";
import { loadLibrary, studySetForSession, weakestConcept } from "./library-client";

const cannedLibrarySnapshot: VivaLibrarySnapshot = {
  user_id: "user-1",
  privacy: {
    copy: "Voice recordings and transcripts are not saved.",
    export: { available: false, unavailable_reason: "control_token_unavailable" },
    export_contains_raw_provider_payloads: false,
    raw_audio_persistence: false,
    transcript_persistence: false,
    transcripts_saved: false,
    voice_recordings_saved: false,
  },
  study_sets: [
    {
      actions: {
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: false, unavailable_reason: "server_mutation_unavailable" },
        resume: { available: false, unavailable_reason: "no_open_session" },
        start: {
          available: true,
          session_id: "voice-session-new",
          session_token: "viva1.mobile-session",
        },
      },
      concept_count: 2,
      course: "Biology 201",
      documents: [
        {
          deleted: false,
          display_name: "Lecture 5.pdf",
          id: "lecture-5",
          processing_status: "ready",
          source_kind: "pdf",
        },
      ],
      id: "biology-midterm",
      ingestion_error: null,
      ingestion_status: "ready",
      question_count: 1,
      server_owned: true,
      title: "Biology Midterm",
      user_id: "user-1",
    },
    {
      actions: {
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: false, unavailable_reason: "server_mutation_unavailable" },
        resume: { available: false, unavailable_reason: "ingestion_processing" },
        start: { available: false, unavailable_reason: "ingestion_processing" },
      },
      concept_count: 0,
      course: null,
      documents: [],
      id: "chemistry-final",
      ingestion_error: null,
      ingestion_status: "processing",
      question_count: 0,
      server_owned: true,
      title: "Chemistry Final",
      user_id: "user-1",
    },
  ],
  sessions: [
    {
      next_review: {
        concept_id: "atp-synthase",
        label: "ATP synthase",
        persisted_due_at: "2026-08-25T13:00:00.000Z",
        source: "persisted_review_item",
        status: "missed",
      },
      recap: {
        missed_concepts: ["atp-synthase"],
        review_later: ["atp-synthase"],
        shaky_concepts: ["cellular-respiration"],
        strong_concepts: [],
        voice_session_id: "voice-session-old",
      },
      status: "closed",
      study_set_id: "biology-midterm",
      study_set_title: "Biology Midterm",
      terminal_reason: "completed",
      voice_session_id: "voice-session-old",
    },
  ],
};

const config: AppConfig = {
  agentHttpUrl: "http://127.0.0.1:4318",
  agentWsUrl: "ws://127.0.0.1:4318/ws",
  sessionToken: null,
  studySetId: "biology-midterm",
  userId: "user-1",
  wsOrigin: null,
};

describe("mobile library client", () => {
  test("loads and projects the direct agent snapshot with explicit configuration", async () => {
    const calls: Array<{ init?: RequestInit; input: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, input: String(input) });
      return new Response(JSON.stringify(cannedLibrarySnapshot), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as typeof fetch;

    const result = await loadLibrary(config, fetchImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("http://127.0.0.1:4318/study-sets/library?user_id=user-1");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(result.snapshot).toEqual(cannedLibrarySnapshot);
    expect(result.projection.libraryRows.map((row) => row.id)).toEqual([
      "biology-midterm",
      "chemistry-final",
    ]);
  });

  test("maps only server-owned metadata and leaves absent learning detail neutral", () => {
    const studySet = studySetForSession(cannedLibrarySnapshot, "biology-midterm");

    expect(studySet).toMatchObject({
      concepts: [],
      course: "Biology 201",
      examDateLabel: "Exam date unavailable",
      generatedCards: [],
      id: "biology-midterm",
      ingestionStatus: "ready",
      mastery: { review: 0, shaky: 0, strong: 0 },
      recommendedSession: "Recall plan unavailable",
      serverOwned: true,
      sessionId: "voice-session-new",
      sessionToken: "viva1.mobile-session",
      title: "Biology Midterm",
      userId: "user-1",
    });
    expect(studySet.docs).toEqual([
      {
        id: "lecture-5",
        kind: "pdf",
        name: "Lecture 5.pdf",
        processed: true,
        progress: 100,
      },
    ]);
    expect(weakestConcept(studySet)).toBeUndefined();
  });

  test("fails closed when the selected study set is absent", () => {
    expect(() => studySetForSession(cannedLibrarySnapshot, "unknown-set")).toThrow(
      "Study set unknown-set is unavailable in the library snapshot",
    );
  });

  test("selects the highest-miss concept and uses non-strong status as the tie-breaker", () => {
    const concepts: Concept[] = [
      concept("strong-three", "Strong", "strong", 3),
      concept("shaky-three", "Shaky", "shaky", 3),
      concept("missed-two", "Missed", "missed", 2),
    ];
    const studySet = { concepts } as StudySet;

    expect(weakestConcept(studySet)?.id).toBe("shaky-three");
  });
});

function concept(id: string, label: string, status: Concept["status"], misses: number): Concept {
  return {
    centrality: 0,
    id,
    label,
    misses,
    source: { confidence: "low", excerpt: "", label: "Source unavailable" },
    status,
  };
}
