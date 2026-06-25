import { describe, expect, test } from "bun:test";
import {
  browserInitialLibrarySnapshot,
  projectLibrarySnapshot,
  redactVivaLibrarySessionTokens,
  type VivaLibrarySnapshot,
} from "./viva-library";

const snapshot: VivaLibrarySnapshot = {
  user_id: "user-1",
  privacy: {
    copy: "Voice recordings and transcripts are not saved; Viva stores sanitized study meaning only.",
    data_handling_statement: "Viva stores sanitized session records and answer-attempt envelopes.",
    deletion_statement: "Delete recap removes session artifacts and nonce rows.",
    export: { available: true, control_token: "viva1.control-token" },
    export_contains_raw_provider_payloads: false,
    raw_audio_persistence: false,
    retention_statement: "Durable rows remain until deletion.",
    transcript_persistence: false,
    transcripts_saved: false,
    voice_recordings_saved: false,
  },
  study_sets: [
    {
      id: "biology-midterm",
      user_id: "user-1",
      title: "Biology Midterm",
      course: "Biology 201",
      ingestion_status: "ready",
      ingestion_error: null,
      server_owned: true,
      documents: [
        {
          id: "lec-5",
          display_name: "Lecture 5",
          source_kind: "pdf",
          processing_status: "ready",
          deleted: false,
        },
      ],
      concept_count: 2,
      question_count: 1,
      actions: {
        start: {
          available: true,
          session_id: "start-session-1",
          session_token: "viva1.start-token",
        },
        resume: { available: false, unavailable_reason: "no_open_session" },
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: true, control_token: "viva1.control-token" },
      },
    },
    {
      id: "pending-set",
      user_id: "user-1",
      title: "Pending Set",
      course: null,
      ingestion_status: "pending",
      ingestion_error: null,
      server_owned: true,
      documents: [],
      concept_count: 0,
      question_count: 0,
      actions: {
        start: { available: false, unavailable_reason: "ingestion_pending" },
        resume: { available: false, unavailable_reason: "ingestion_pending" },
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: false, unavailable_reason: "server_mutation_unavailable" },
      },
    },
    {
      id: "failed-set",
      user_id: "user-1",
      title: "Failed Set",
      course: null,
      ingestion_status: "failed",
      ingestion_error: "No usable source span",
      server_owned: true,
      documents: [],
      concept_count: 0,
      question_count: 0,
      actions: {
        start: { available: false, unavailable_reason: "ingestion_failed" },
        resume: { available: false, unavailable_reason: "ingestion_failed" },
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: false, unavailable_reason: "server_mutation_unavailable" },
      },
    },
    {
      id: "retry-set",
      user_id: "user-1",
      title: "Retry Set",
      course: null,
      ingestion_status: "retry",
      ingestion_error: "Upload failed; provide a fresh PDF to retry.",
      server_owned: true,
      documents: [
        {
          id: "retry-doc",
          display_name: "Retry lecture.pdf",
          source_kind: "pdf",
          processing_status: "retry",
          deleted: false,
        },
      ],
      concept_count: 0,
      question_count: 0,
      actions: {
        start: { available: false, unavailable_reason: "ingestion_retry" },
        resume: { available: false, unavailable_reason: "ingestion_retry" },
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: true, control_token: "viva1.control-token" },
      },
    },
    {
      id: "deleted-document-set",
      user_id: "user-1",
      title: "Deleted Document Set",
      course: null,
      ingestion_status: "ready",
      ingestion_error: null,
      server_owned: true,
      documents: [
        {
          id: "deleted-doc",
          display_name: "Archived lecture",
          source_kind: "pdf",
          processing_status: "ready",
          deleted: true,
        },
      ],
      concept_count: 0,
      question_count: 0,
      actions: {
        start: { available: false, unavailable_reason: "source_deleted" },
        resume: { available: false, unavailable_reason: "source_deleted" },
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: false, unavailable_reason: "server_mutation_unavailable" },
      },
    },
  ],
  sessions: [
    {
      voice_session_id: "voice-session-1",
      study_set_id: "biology-midterm",
      study_set_title: "Biology Midterm",
      status: "closed",
      terminal_reason: "completed",
      recap: {
        voice_session_id: "voice-session-1",
        strong_concepts: ["oxidative-phosphorylation"],
        shaky_concepts: ["nadh"],
        missed_concepts: [],
        review_later: ["nadh"],
      },
      next_review: {
        concept_id: "nadh",
        label: "NADH",
        status: "shaky",
        persisted_due_at: "2099-01-01T00:00:00Z",
        source: "persisted_review_item",
      },
    },
  ],
};

describe("Viva library projection", () => {
  test("renders server-owned study set rows with privacy controls", () => {
    const projection = projectLibrarySnapshot(snapshot, {
      now: new Date("2026-06-17T12:00:00Z"),
    });

    expect(projection.privacy.voiceRecordingsSaved).toBe(false);
    expect(projection.privacy.transcriptsSaved).toBe(false);
    expect(projection.privacy.exportContainsRawProviderPayloads).toBe(false);
    expect(projection.privacy.export.available).toBe(true);
    expect(projection.privacy.copy).toContain("Voice recordings and transcripts are not saved");
    expect(projection.privacy.dataHandlingStatement).toContain("answer-attempt envelopes");
    expect(projection.privacy.retentionStatement).toContain("until deletion");
    expect(projection.privacy.deletionStatement).toContain("nonce rows");
    expect(projection.libraryRows.map((row) => row.id)).toEqual([
      "biology-midterm",
      "pending-set",
      "failed-set",
      "retry-set",
      "deleted-document-set",
    ]);
    expect(projection.libraryRows[0]?.statusLabel).toBe("Ready");
    expect(projection.libraryRows[0]?.start.available).toBe(true);
    expect(projection.libraryRows[0]?.start.sessionToken).toBe("viva1.start-token");
    expect(projection.libraryRows[0]?.delete.available).toBe(true);
    expect(projection.libraryRows[0]?.delete.sessionToken).toBeUndefined();
    expect(projection.libraryRows[0]?.delete.controlToken).toBe("viva1.control-token");
    expect(projection.libraryRows[1]?.statusLabel).toBe("Ingestion pending");
    expect(projection.libraryRows[2]?.statusLabel).toBe("Ingestion failed");
    expect(projection.libraryRows[2]?.detail).toBe("No usable source span");
    expect(projection.libraryRows[3]?.statusLabel).toBe("Ingestion retry needed");
    expect(projection.libraryRows[3]?.detail).toBe("Upload failed; provide a fresh PDF to retry.");
    expect(projection.libraryRows[3]?.start.available).toBe(false);
    expect(projection.libraryRows[3]?.delete.available).toBe(true);
    expect(projection.libraryRows[4]?.statusLabel).toBe("Source archived");
    expect(projection.libraryRows[4]?.start.available).toBe(false);
    expect(projection.libraryRows[4]?.delete.available).toBe(false);
    expect(projection.libraryRows[4]?.archive.unavailableReason).toBe(
      "server_mutation_unavailable",
    );
  });

  test("keeps tokenless server session actions bootstrap-capable for same-origin start", () => {
    const readyStudySet = snapshot.study_sets[0];
    if (!readyStudySet) throw new Error("test fixture must include a ready study set");
    const unsignedSnapshot: VivaLibrarySnapshot = {
      ...snapshot,
      study_sets: [
        {
          ...readyStudySet,
          actions: {
            ...readyStudySet.actions,
            resume: { available: true, session_id: "open-session", session_token: null },
            start: { available: true, session_id: "unsigned-start-session", session_token: null },
          },
        },
      ],
      sessions: [],
    };

    const projection = projectLibrarySnapshot(unsignedSnapshot);

    expect(projection.libraryRows[0]?.start).toEqual({
      available: true,
      sessionId: "unsigned-start-session",
      sessionToken: undefined,
    });
    expect(projection.libraryRows[0]?.resume).toEqual({
      available: true,
      sessionId: "open-session",
      sessionToken: undefined,
    });
  });

  test("redacts start and resume session tokens from browser-bound snapshots", () => {
    const redacted = redactVivaLibrarySessionTokens(snapshot);

    expect(redacted.study_sets[0]?.actions.start).toEqual({
      available: true,
      session_id: "start-session-1",
    });
    expect(redacted.study_sets[0]?.actions.resume).toEqual({
      available: false,
      unavailable_reason: "no_open_session",
    });
    expect(JSON.stringify(redacted)).not.toContain("session_token");
    expect(JSON.stringify(redacted)).not.toContain("viva1.start-token");
    expect(snapshot.study_sets[0]?.actions.start).toEqual({
      available: true,
      session_id: "start-session-1",
      session_token: "viva1.start-token",
    });
  });

  test("preserves direct session tokens only for static-export initial snapshots", () => {
    const serverful = browserInitialLibrarySnapshot(snapshot, { staticExport: false });
    const staticExport = browserInitialLibrarySnapshot(snapshot, { staticExport: true });

    expect(JSON.stringify(serverful)).not.toContain("session_token");
    expect(JSON.stringify(serverful)).not.toContain("viva1.start-token");
    expect(staticExport.study_sets[0]?.actions.start).toEqual({
      available: true,
      session_id: "start-session-1",
      session_token: "viva1.start-token",
    });
  });

  test("formats completed-session next review from the persisted server schedule only", () => {
    const projection = projectLibrarySnapshot(snapshot, {
      now: new Date("2026-06-17T12:00:00Z"),
    });

    const session = projection.sessionRows[0];
    expect(session?.statusLabel).toBe("Completed");
    expect(session?.recapLabel).toBe("1 strong · 1 shaky");
    expect(session?.nextReview?.conceptId).toBe("nadh");
    expect(session?.nextReview?.authority).toBe("server_persisted");
    expect(session?.nextReview?.intervalLabel).toBe("due Jan 1, 2099");
    expect(session?.nextReview?.persistedDueAt).toBe("2099-01-01T00:00:00Z");
  });

  test("derives a session mastery ring shape from the graded recap buckets", () => {
    const projection = projectLibrarySnapshot(snapshot, {
      now: new Date("2026-06-17T12:00:00Z"),
    });

    const mastery = projection.sessionRows[0]?.mastery;
    // strong 1 / shaky 1 / missed 0 -> 2 graded -> 50% held. review_later overlaps
    // shaky and is a scheduling overlay, so it never inflates the graded total.
    expect(mastery).not.toBe(null);
    expect(mastery?.strong).toBe(1);
    expect(mastery?.shaky).toBe(1);
    expect(mastery?.missed).toBe(0);
    expect(mastery?.total).toBe(2);
    expect(mastery?.strongPct).toBe(50);
  });

  test("leaves session mastery null when a recap graded nothing", () => {
    const noRecapSnapshot: VivaLibrarySnapshot = {
      ...snapshot,
      sessions: [
        {
          voice_session_id: "voice-session-2",
          study_set_id: "biology-midterm",
          study_set_title: "Biology Midterm",
          status: "closed",
          terminal_reason: "completed",
          recap: null,
          next_review: null,
        },
      ],
    };

    const projection = projectLibrarySnapshot(noRecapSnapshot);
    expect(projection.sessionRows[0]?.mastery).toBe(null);
  });
});
