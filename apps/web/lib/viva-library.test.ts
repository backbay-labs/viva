import { describe, expect, test } from "bun:test";
import {
  browserInitialLibrarySnapshot,
  browserSessionCredentialVaultInputFromStartResponse,
  fetchWithVivaSessionStartTimeout,
  pendingBrowserSessionCredentialVault,
  projectLibrarySnapshot,
  redactVivaLibrarySessionTokens,
  VIVA_SESSION_CREDENTIAL_VAULT_MODE,
  VIVA_SESSION_START_FETCH_TIMEOUT_MS,
  type VivaFetchTimers,
  type VivaLibrarySnapshot,
  type VivaSessionStartResponse,
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

  test("disables tokenless server session actions without a bootstrap capability", () => {
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
      available: false,
      unavailableReason: "session_capability_unavailable",
    });
    expect(projection.libraryRows[0]?.resume).toEqual({
      available: false,
      unavailableReason: "session_capability_unavailable",
    });
  });

  test("keeps signed bootstrap session actions available for same-origin start", () => {
    const readyStudySet = snapshot.study_sets[0];
    if (!readyStudySet) throw new Error("test fixture must include a ready study set");
    const bootstrapSnapshot: VivaLibrarySnapshot = {
      ...snapshot,
      study_sets: [
        {
          ...readyStudySet,
          actions: {
            ...readyStudySet.actions,
            resume: {
              available: true,
              session_bootstrap_token: "viva-bootstrap1.resume-capability",
              session_id: "open-session",
              session_token: null,
            },
            start: {
              available: true,
              session_bootstrap_token: "viva-bootstrap1.start-capability",
              session_id: "bootstrap-start-session",
              session_token: null,
            },
          },
        },
      ],
      sessions: [],
    };

    const projection = projectLibrarySnapshot(bootstrapSnapshot);

    expect(projection.libraryRows[0]?.start).toEqual({
      available: true,
      sessionBootstrapToken: "viva-bootstrap1.start-capability",
      sessionId: "bootstrap-start-session",
      sessionToken: undefined,
    });
    expect(projection.libraryRows[0]?.resume).toEqual({
      available: true,
      sessionBootstrapToken: "viva-bootstrap1.resume-capability",
      sessionId: "open-session",
      sessionToken: undefined,
    });
  });

  test("keeps signed same-origin control actions available without exposing raw control tokens", () => {
    const readyStudySet = snapshot.study_sets[0];
    if (!readyStudySet) throw new Error("test fixture must include a ready study set");
    const completedSession = snapshot.sessions[0];
    if (!completedSession) throw new Error("test fixture must include a completed session");
    const sameOriginSnapshot: VivaLibrarySnapshot = {
      ...snapshot,
      privacy: {
        ...snapshot.privacy,
        export: {
          available: false,
          unavailable_reason: "allowlist_filtered_export_unavailable",
        },
      },
      study_sets: [
        {
          ...readyStudySet,
          actions: {
            ...readyStudySet.actions,
            delete: { available: true, same_origin_control_token: "viva-control1.delete-source" },
          },
        },
      ],
      sessions: [
        {
          ...completedSession,
          actions: {
            delete: { available: true, same_origin_control_token: "viva-control1.delete-recap" },
          },
        },
      ],
    };

    const projection = projectLibrarySnapshot(sameOriginSnapshot);

    expect(projection.privacy.export.available).toBe(false);
    expect(projection.libraryRows[0]?.delete).toEqual({
      available: true,
      controlToken: undefined,
      sameOriginControlToken: "viva-control1.delete-source",
    });
    expect(projection.sessionRows[0]?.delete).toEqual({
      available: true,
      controlToken: undefined,
      sameOriginControlToken: "viva-control1.delete-recap",
    });
  });

  test("redacts session tokens from browser-bound snapshots while preserving control capabilities", () => {
    const redacted = redactVivaLibrarySessionTokens(snapshot);

    expect(redacted.study_sets[0]?.actions.start).toEqual({
      available: true,
      session_id: "start-session-1",
    });
    expect(redacted.study_sets[0]?.actions.resume).toEqual({
      available: false,
      unavailable_reason: "no_open_session",
    });
    expect(JSON.stringify(redacted)).not.toContain('"session_token"');
    expect(JSON.stringify(redacted)).not.toContain("viva1.start-token");
    expect(redacted.privacy.export).toEqual({
      available: true,
      control_token: "viva1.control-token",
    });
    expect(redacted.study_sets[0]?.actions.delete).toEqual({
      available: true,
      control_token: "viva1.control-token",
    });
    expect(snapshot.study_sets[0]?.actions.start).toEqual({
      available: true,
      session_id: "start-session-1",
      session_token: "viva1.start-token",
    });
  });

  test("preserves direct capability tokens only for static-export initial snapshots", () => {
    const serverful = browserInitialLibrarySnapshot(snapshot, { staticExport: false });
    const staticExport = browserInitialLibrarySnapshot(snapshot, { staticExport: true });

    expect(JSON.stringify(serverful)).not.toContain('"session_token"');
    expect(JSON.stringify(serverful)).not.toContain("viva1.start-token");
    expect(JSON.stringify(serverful)).not.toContain('"control_token"');
    expect(JSON.stringify(serverful)).not.toContain("viva1.control-token");
    expect(serverful.privacy.export).toEqual({
      available: true,
    });
    expect(serverful.study_sets[0]?.actions.delete).toEqual({
      available: true,
    });
    expect(staticExport.study_sets[0]?.actions.start).toEqual({
      available: true,
      session_id: "start-session-1",
      session_token: "viva1.start-token",
    });
    expect(staticExport.privacy.export).toEqual({
      available: true,
      control_token: "viva1.control-token",
    });
    expect(staticExport.study_sets[0]?.actions.delete).toEqual({
      available: true,
      control_token: "viva1.control-token",
    });
  });

  test("preserves direct session tokens for non-bootstrap initial snapshots only", () => {
    const directSessionSnapshot = browserInitialLibrarySnapshot(snapshot, {
      directSessionTokens: true,
      staticExport: false,
    });

    expect(directSessionSnapshot.study_sets[0]?.actions.start).toEqual({
      available: true,
      session_id: "start-session-1",
      session_token: "viva1.start-token",
    });
    expect(directSessionSnapshot.privacy.export).toEqual({
      available: true,
    });
    expect(directSessionSnapshot.study_sets[0]?.actions.delete).toEqual({
      available: true,
    });
    expect(JSON.stringify(directSessionSnapshot)).not.toContain('"control_token"');
    expect(JSON.stringify(directSessionSnapshot)).not.toContain("viva1.control-token");
  });

  test("preserves signed same-origin mutation controls in server-bootstrap snapshots", () => {
    const readyStudySet = snapshot.study_sets[0];
    if (!readyStudySet) throw new Error("test fixture must include a ready study set");
    const controlSnapshot: VivaLibrarySnapshot = {
      ...snapshot,
      study_sets: [
        {
          ...readyStudySet,
          actions: {
            ...readyStudySet.actions,
            delete: {
              available: true,
              control_token: "viva1.control-token",
              same_origin_control_token: "viva-control1.delete-source",
            },
          },
        },
      ],
    };
    const serverBootstrapSnapshot = browserInitialLibrarySnapshot(controlSnapshot, {
      staticExport: false,
    });

    expect(serverBootstrapSnapshot.study_sets[0]?.actions.delete).toEqual({
      available: true,
      same_origin_control_token: "viva-control1.delete-source",
    });
    expect(JSON.stringify(serverBootstrapSnapshot)).not.toContain('"control_token"');
    expect(JSON.stringify(serverBootstrapSnapshot)).not.toContain("viva1.control-token");
    expect(JSON.stringify(serverBootstrapSnapshot)).not.toContain('"session_token"');
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

/**
 * D-07 Branch A (`retain-token-only`, frontend session-bootstrap composition
 * half, `FRONTEND-011`): the pure helpers `LibraryStatusPanel.tsx` composes
 * around the same-origin `/api/viva-session/start` mint.
 *
 * `browserSessionCredentialVaultInputFromStartResponse` is the "small local
 * indirection" this task owns in place of Plan 10's not-yet-published
 * `replaceBrowserSessionCredential` (`apps/web/lib/use-viva-agent-session.ts`
 * has no such export in this tree yet — confirmed by reading that file
 * before writing this test). It shapes exactly the fields the plan names —
 * `session_token`, `refresh_token`, `refresh_expires_at`,
 * `session_absolute_expires_at`, identity, `mode: "retain-token-only"` —
 * from a start response, tolerating the refresh fields' current absence from
 * the real (Plan-11-owned, unmodified-by-this-task) route response so this
 * task's own behavior is provable today, not only once those fields exist.
 */
describe("D-07 Branch A session bootstrap composition (FRONTEND-011)", () => {
  describe("browserSessionCredentialVaultInputFromStartResponse", () => {
    test("builds the complete retain-token-only vault input from a full start response", () => {
      const response: VivaSessionStartResponse = {
        refresh_expires_at: "2026-09-01T00:00:00Z",
        refresh_token: "viva1.refresh-token",
        session: {
          session_id: "server-session",
          study_set_id: "biology-midterm",
          user_id: "user-1",
        },
        session_absolute_expires_at: "2026-09-23T00:00:00Z",
        session_token: "viva1.session-token",
      };

      expect(browserSessionCredentialVaultInputFromStartResponse(response)).toEqual({
        mode: "retain-token-only",
        refresh_expires_at: "2026-09-01T00:00:00Z",
        refresh_token: "viva1.refresh-token",
        session_absolute_expires_at: "2026-09-23T00:00:00Z",
        session_id: "server-session",
        session_token: "viva1.session-token",
        study_set_id: "biology-midterm",
        user_id: "user-1",
      });
    });

    test("carries null refresh/expiry fields when today's real start response omits them, rather than failing closed", () => {
      // Exactly today's real `handleVivaSessionStart` response shape
      // (`apps/web/app/api/viva-session/shared.ts`, not owned by this task):
      // `{ failure_class, session, session_token, token_refresh_outcome }`
      // only — no `refresh_token`/`refresh_expires_at`/
      // `session_absolute_expires_at` yet.
      const response: VivaSessionStartResponse = {
        session: {
          session_id: "server-session",
          study_set_id: "biology-midterm",
          user_id: "user-1",
        },
        session_token: "viva1.session-token",
      };

      expect(browserSessionCredentialVaultInputFromStartResponse(response)).toEqual({
        mode: "retain-token-only",
        refresh_expires_at: null,
        refresh_token: null,
        session_absolute_expires_at: null,
        session_id: "server-session",
        session_token: "viva1.session-token",
        study_set_id: "biology-midterm",
        user_id: "user-1",
      });
    });

    test("returns null when session_token is missing", () => {
      expect(
        browserSessionCredentialVaultInputFromStartResponse({
          session: { session_id: "s", study_set_id: "t", user_id: "u" },
        }),
      ).toBe(null);
    });

    test("returns null when session_token is blank", () => {
      expect(
        browserSessionCredentialVaultInputFromStartResponse({
          session: { session_id: "s", study_set_id: "t", user_id: "u" },
          session_token: "   ",
        }),
      ).toBe(null);
    });

    test("returns null when the session identity is missing entirely", () => {
      expect(browserSessionCredentialVaultInputFromStartResponse({ session_token: "x" })).toBe(
        null,
      );
    });

    test("returns null when session.session_id is missing", () => {
      expect(
        browserSessionCredentialVaultInputFromStartResponse({
          session: { study_set_id: "t", user_id: "u" },
          session_token: "x",
        }),
      ).toBe(null);
    });

    test("returns null when session.study_set_id is missing", () => {
      expect(
        browserSessionCredentialVaultInputFromStartResponse({
          session: { session_id: "s", user_id: "u" },
          session_token: "x",
        }),
      ).toBe(null);
    });

    test("returns null when session.user_id is missing", () => {
      expect(
        browserSessionCredentialVaultInputFromStartResponse({
          session: { session_id: "s", study_set_id: "t" },
          session_token: "x",
        }),
      ).toBe(null);
    });
  });

  describe("fetchWithVivaSessionStartTimeout", () => {
    test("locks the shared abort bound at exactly 6000ms", () => {
      expect(VIVA_SESSION_START_FETCH_TIMEOUT_MS).toBe(6000);
    });

    test("locks the vault mode constant at exactly retain-token-only", () => {
      expect(VIVA_SESSION_CREDENTIAL_VAULT_MODE).toBe("retain-token-only");
    });

    test("aborts a never-resolving fetch at the bound, proved with injected fake timers rather than a real wait", async () => {
      const timers = manualFakeTimers();
      const seenSignals: AbortSignal[] = [];
      const fetchImpl = ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            seenSignals.push(signal);
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        })) as typeof fetch;

      const resultPromise = fetchWithVivaSessionStartTimeout(
        fetchImpl,
        "/api/viva-session/start",
        { method: "POST" },
        { timers },
      );

      // The bound is scheduled synchronously, before any real time passes.
      expect(timers.scheduled).toEqual([{ delayMs: 6000 }]);
      expect(seenSignals).toHaveLength(1);
      expect(seenSignals[0]?.aborted).toBe(false);

      timers.fireAll();

      expect(seenSignals[0]?.aborted).toBe(true);
      expect(await resultPromise).toEqual({ ok: false, reason: "timeout" });
    });

    test("resolves normally and clears its timer when the fetch settles before the bound fires", async () => {
      const timers = manualFakeTimers();
      const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const fetchImpl = (async () => response) as typeof fetch;

      const result = await fetchWithVivaSessionStartTimeout(
        fetchImpl,
        "/api/viva-session/start",
        { method: "POST" },
        { timers },
      );

      expect(result).toEqual({ ok: true, response });
      expect(timers.scheduled).toEqual([{ delayMs: 6000 }]);
      expect(timers.cleared).toBe(true);
    });

    test("lets a genuine non-timeout fetch rejection propagate rather than mislabeling it a timeout", async () => {
      const timers = manualFakeTimers();
      const networkError = new Error("network down");
      const fetchImpl = (async () => {
        throw networkError;
      }) as typeof fetch;

      let caught: unknown;
      try {
        await fetchWithVivaSessionStartTimeout(
          fetchImpl,
          "/api/viva-session/start",
          { method: "POST" },
          { timers },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(networkError);
      expect(timers.cleared).toBe(true);
    });

    test("honors an explicit timeoutMs override for callers that need a shorter bound", async () => {
      const timers = manualFakeTimers();
      const fetchImpl = ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })) as typeof fetch;

      const resultPromise = fetchWithVivaSessionStartTimeout(
        fetchImpl,
        "/api/viva-session/start",
        { method: "POST" },
        { timeoutMs: 25, timers },
      );
      expect(timers.scheduled).toEqual([{ delayMs: 25 }]);
      timers.fireAll();
      expect(await resultPromise).toEqual({ ok: false, reason: "timeout" });
    });
  });

  describe("pendingBrowserSessionCredentialVault (Phase 13A local indirection placeholder)", () => {
    test("never logs, pending Plan 10's real replaceBrowserSessionCredential export", () => {
      const logCalls: unknown[][] = [];
      const original = { error: console.error, log: console.log, warn: console.warn };
      console.log = (...args: unknown[]) => logCalls.push(args);
      console.warn = (...args: unknown[]) => logCalls.push(args);
      console.error = (...args: unknown[]) => logCalls.push(args);
      try {
        expect(() =>
          pendingBrowserSessionCredentialVault.replaceBrowserSessionCredential({
            mode: "retain-token-only",
            refresh_expires_at: null,
            refresh_token: null,
            session_absolute_expires_at: null,
            session_id: "s",
            session_token: "t",
            study_set_id: "d",
            user_id: "u",
          }),
        ).not.toThrow();
      } finally {
        console.error = original.error;
        console.log = original.log;
        console.warn = original.warn;
      }
      expect(logCalls).toEqual([]);
    });
  });
});

/**
 * A manually-driven fake timer double for `fetchWithVivaSessionStartTimeout`:
 * `setTimeout` records the callback and delay instead of scheduling real
 * time, so `fireAll()` can deterministically trigger the abort bound in zero
 * wall-clock time. `cleared` proves `clearTimeout` was actually invoked
 * (the settle-before-bound and error-propagation paths must not leak a
 * pending timer).
 */
function manualFakeTimers(): VivaFetchTimers & {
  cleared: boolean;
  fireAll: () => void;
  scheduled: Array<{ delayMs: number }>;
} {
  const scheduled: Array<{ delayMs: number }> = [];
  const pending: Array<() => void> = [];
  let cleared = false;
  return {
    get cleared() {
      return cleared;
    },
    clearTimeout: () => {
      cleared = true;
    },
    fireAll: () => {
      for (const callback of pending.splice(0)) callback();
    },
    scheduled,
    setTimeout: (callback: () => void, delayMs: number) => {
      scheduled.push({ delayMs });
      pending.push(callback);
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    },
  };
}
