import { describe, expect, test } from "bun:test";
import type { Concept, StudySet } from "@viva/core";
import { studySetToAgentSessionConfig, type VivaLibrarySnapshot } from "@/agent/shared-web";
import {
  createMobileSessionController,
  type MobileVivaSessionController,
} from "@/agent/use-mobile-viva-session";
import type { AppConfig } from "@/runtime/config";
import {
  decideMobileLibraryStart,
  fetchMobileAgentReadiness,
  loadLibrary,
  studySetForSession,
  weakestConcept,
} from "./library-client";

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
  restBearerToken: null,
  sessionToken: null,
  studySetId: "biology-midterm",
  userId: "user-1",
  wsBearerToken: null,
  wsOrigin: null,
};

type SocketListener = (event: Event & { data?: unknown }) => void;

class AuthFakeWebSocket {
  static instances: AuthFakeWebSocket[] = [];
  readonly listeners = new Map<string, SocketListener[]>();
  readonly sent: unknown[] = [];
  readyState = 0;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
  ) {
    AuthFakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  send(value: unknown): void {
    this.sent.push(value);
  }

  private emit(type: string, event: Event & { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

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

  test("uses the explicit REST bearer as the protected library bearer", async () => {
    const calls: Array<{ init?: RequestInit; input: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, input: String(input) });
      return new Response(JSON.stringify(cannedLibrarySnapshot), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as typeof fetch;

    await loadLibrary({ ...config, restBearerToken: "rest-bearer" }, fetchImpl);

    expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer rest-bearer" });
  });

  test("uses the REST bearer for protected health and readiness probes", async () => {
    const calls: Array<{ init?: RequestInit; input: string }> = [];
    const store = {
      available: true,
      backend: "memory",
      durable: false,
      nonce_replay_protection: false,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: false,
    };
    const brain = {
      configured: true,
      live_runtime: true,
      provider: "synthetic",
      selectable: true,
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ init, input: url });
      return new Response(
        JSON.stringify(
          url.endsWith("/health/brain")
            ? { brain, provider: "synthetic", status: "ready", store }
            : { brain, ready: true, store },
        ),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }) as typeof fetch;

    const probe = await fetchMobileAgentReadiness(
      { ...config, restBearerToken: "rest-bearer" },
      fetchImpl,
    );

    expect(probe.status).toBe("observed");
    expect(calls.map(({ input }) => input)).toEqual([
      "http://127.0.0.1:4318/health/brain",
      "http://127.0.0.1:4318/ready",
    ]);
    expect(calls.map(({ init }) => init?.headers)).toEqual([
      { authorization: "Bearer rest-bearer" },
      { authorization: "Bearer rest-bearer" },
    ]);
  });

  test("keeps static REST/WS bearers separate from the signed first-frame capability", async () => {
    const authConfig: AppConfig = {
      ...config,
      restBearerToken: "rest-static",
      sessionToken: "config-signed",
      wsBearerToken: "ws-static",
    };
    const calls: Array<{ init?: RequestInit; input: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, input: String(input) });
      return new Response(JSON.stringify(cannedLibrarySnapshot), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as typeof fetch;

    const loaded = await loadLibrary(authConfig, fetchImpl);
    const studySet = studySetForSession(loaded.snapshot, "biology-midterm", authConfig);
    AuthFakeWebSocket.instances = [];
    const controller: MobileVivaSessionController = createMobileSessionController({
      WebSocketImpl: AuthFakeWebSocket as unknown as typeof WebSocket,
      config: authConfig,
      session: studySetToAgentSessionConfig(studySet, {
        mode: "quiz",
        userId: authConfig.userId,
      }),
      sessionToken: studySet.sessionToken,
    });

    expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer rest-static" });
    controller.connect();
    const socket = AuthFakeWebSocket.instances[0];
    expect(socket?.protocols).toEqual(["viva-voice", `bearer.${btoa("ws-static")}`]);
    socket?.open();
    const firstFrame = JSON.parse(String(socket?.sent[0])) as {
      session_token?: string;
      type?: string;
    };
    expect(firstFrame.type).toBe("session_config");
    expect(firstFrame.session_token).toBe("viva1.mobile-session");
    expect(firstFrame.session_token).not.toBe("config-signed");
    expect("sendAudio" in controller).toBe(false);
    expect(socket?.sent.every((value) => typeof value === "string")).toBe(true);
  });

  test("maps only server-owned metadata and leaves absent learning detail neutral", () => {
    const studySet = studySetForSession(cannedLibrarySnapshot, "biology-midterm", config);

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
    expect(() => studySetForSession(cannedLibrarySnapshot, "unknown-set", config)).toThrow(
      "Study set unknown-set is unavailable in the library snapshot",
    );
  });

  test("admits only the fully ready trusted fixture when loopback cannot mint a token", () => {
    const snapshot = withStartAction(cannedLibrarySnapshot, {
      available: false,
      unavailable_reason: "session_token_unavailable",
    });

    expect(decideMobileLibraryStart(config, snapshot, "biology-midterm")).toEqual({
      authority: "trusted_loopback_unsigned",
      canStart: true,
    });
    expect(studySetForSession(snapshot, "biology-midterm", config)).toMatchObject({
      id: "biology-midterm",
      sessionId: undefined,
      sessionToken: undefined,
      userId: "user-1",
    });

    for (const loopbackConfig of [
      { ...config, agentHttpUrl: "http://localhost:4318", agentWsUrl: "ws://localhost:4318/ws" },
      { ...config, agentHttpUrl: "http://[::1]:4318", agentWsUrl: "ws://[::1]:4318/ws" },
    ]) {
      expect(decideMobileLibraryStart(loopbackConfig, snapshot, "biology-midterm")).toMatchObject({
        authority: "trusted_loopback_unsigned",
        canStart: true,
      });
    }
  });

  test("keeps direct-route unsigned admission fail-closed outside the exact fixture boundary", () => {
    const unsignedSnapshot = withStartAction(cannedLibrarySnapshot, {
      available: false,
      unavailable_reason: "session_token_unavailable",
    });
    const cases: Array<{ config?: AppConfig; label: string; snapshot?: VivaLibrarySnapshot }> = [
      {
        config: { ...config, agentHttpUrl: "http://agent.example" },
        label: "remote HTTP agent",
      },
      {
        config: { ...config, agentWsUrl: "ws://agent.example/ws" },
        label: "remote WebSocket agent",
      },
      {
        config: { ...config, agentHttpUrl: "http://127.0.0.1.example" },
        label: "loopback-looking remote hostname",
      },
      {
        config: { ...config, userId: "user-2" },
        label: "configured user mismatch",
      },
      {
        config: { ...config, studySetId: "chemistry-final" },
        label: "configured study-set mismatch",
      },
      {
        config: { ...config, sessionToken: "viva1.unrelated" },
        label: "configured token on an unsigned action",
      },
      {
        label: "snapshot user mismatch",
        snapshot: { ...unsignedSnapshot, user_id: "user-2" },
      },
      {
        label: "row user mismatch",
        snapshot: withStudySet(unsignedSnapshot, { user_id: "user-2" }),
      },
      {
        label: "non-server-owned row",
        snapshot: withStudySet(unsignedSnapshot, { server_owned: false }),
      },
      {
        label: "non-ready row",
        snapshot: withStudySet(unsignedSnapshot, { ingestion_status: "processing" }),
      },
      {
        label: "no active concepts",
        snapshot: withStudySet(unsignedSnapshot, { concept_count: 0 }),
      },
      {
        label: "no active questions",
        snapshot: withStudySet(unsignedSnapshot, { question_count: 0 }),
      },
      {
        label: "no ready source",
        snapshot: withStudySet(unsignedSnapshot, { documents: [] }),
      },
      {
        label: "genuinely unavailable action",
        snapshot: withStartAction(unsignedSnapshot, {
          available: false,
          unavailable_reason: "ingestion_processing",
        }),
      },
      {
        label: "malformed available action without a token",
        snapshot: withStartAction(unsignedSnapshot, {
          available: true,
          session_id: "voice-session-unbound",
        }),
      },
    ];

    for (const testCase of cases) {
      const decision = decideMobileLibraryStart(
        testCase.config ?? config,
        testCase.snapshot ?? unsignedSnapshot,
        "biology-midterm",
      );
      expect({ canStart: decision.canStart, label: testCase.label }).toEqual({
        canStart: false,
        label: testCase.label,
      });
      expect(() =>
        studySetForSession(
          testCase.snapshot ?? unsignedSnapshot,
          "biology-midterm",
          testCase.config ?? config,
        ),
      ).toThrow("cannot start");
    }
  });

  test("accepts a real signed start capability without weakening hosted admission", () => {
    const hostedConfig = {
      ...config,
      agentHttpUrl: "https://agent.example",
      agentWsUrl: "wss://agent.example/ws",
    };

    expect(
      decideMobileLibraryStart(hostedConfig, cannedLibrarySnapshot, "biology-midterm"),
    ).toEqual({
      authority: "signed_action",
      canStart: true,
    });
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

function withStartAction(
  snapshot: VivaLibrarySnapshot,
  start: VivaLibrarySnapshot["study_sets"][number]["actions"]["start"],
): VivaLibrarySnapshot {
  const first = snapshot.study_sets[0];
  if (!first) throw new Error("canned biology study set is missing");
  return withStudySet(snapshot, {
    actions: { ...first.actions, start },
  });
}

function withStudySet(
  snapshot: VivaLibrarySnapshot,
  patch: Partial<VivaLibrarySnapshot["study_sets"][number]>,
): VivaLibrarySnapshot {
  const first = snapshot.study_sets[0];
  if (!first) throw new Error("canned biology study set is missing");
  return {
    ...snapshot,
    study_sets: [{ ...first, ...patch }, ...snapshot.study_sets.slice(1)],
  };
}
