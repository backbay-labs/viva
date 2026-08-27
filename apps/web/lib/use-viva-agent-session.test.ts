import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  type AgentStudySourceReference,
  type AuthenticatedStudyProjectionV1,
  parseVivaServerFrame,
  validateAuthenticatedStudyProjectionV1,
} from "@viva/core";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/v5/synthetic-runtime-session.json";
import {
  agentSourceToUiSource,
  type BrowserSessionCredential,
  browserSessionCredentialVault,
  clearBrowserSessionCredential,
  createVivaAgentAudioCommands,
  deriveVivaAgentUiState,
  readBrowserSessionCredential,
  refreshBrowserSessionToken,
  renewBrowserSessionCredential,
  replaceBrowserSessionCredential,
  studyProjectionToAgentSessionConfig,
  VIVA_SESSION_ENTRY_REFRESH_TIMEOUT_MS,
} from "./use-viva-agent-session";
import {
  initialVivaAgentSessionState,
  type VivaAgentSessionController,
  type VivaAudioSendResult,
  vivaAgentReducer,
} from "./viva-agent-client";

const THERMO_PROJECTION: AuthenticatedStudyProjectionV1 = {
  activeQuestion: {
    conceptId: "enthalpy",
    id: "q-enthalpy-1",
    prompt: "Why is enthalpy a state function?",
    sourceCitations: [
      {
        confidence: "high",
        documentId: "chem-lec-3",
        label: "Lecture 3 · slide 11",
        sourceId: "src-chem-lec-3-slide-11",
        span: "slide:11",
      },
    ],
  },
  concepts: [
    {
      dueAt: "2026-08-27T09:00:00.000Z",
      id: "enthalpy",
      label: "Enthalpy",
      lastReviewedAt: "2026-08-20T09:00:00.000Z",
      status: "shaky",
    },
    {
      dueAt: "2026-08-26T09:00:00.000Z",
      id: "gibbs-free-energy",
      label: "Gibbs free energy",
      lastReviewedAt: null,
      status: "missed",
    },
  ],
  questionProgress: { completed: 2, total: 5 },
  reviewSchedule: [
    {
      authority: "server_persisted_fsrs",
      conceptId: "enthalpy",
      dueAt: "2026-08-27T09:00:00.000Z",
    },
    {
      authority: "server_persisted_fsrs",
      conceptId: "gibbs-free-energy",
      dueAt: "2026-08-26T09:00:00.000Z",
    },
  ],
  session: { goal: null, id: "voice-session-9", mode: "quiz" },
  studySet: {
    course: "CHEM-401",
    examLabel: "Oral final",
    id: "thermo-401",
    ingestionStatus: "ready",
    title: "Thermodynamic State Functions",
  },
  version: 1,
};

describe("useVivaAgentSession adapter", () => {
  test("maps the authenticated projection straight into the signed session config", () => {
    const session = studyProjectionToAgentSessionConfig(THERMO_PROJECTION, "user-9");

    expect(session).toEqual({
      active_concepts: ["enthalpy", "gibbs-free-energy"],
      mode: "quiz",
      session_id: "voice-session-9",
      source_context: [],
      study_set_id: "thermo-401",
      user_id: "user-9",
    });
    // A-25's node-10 obligation: `initial_goal` is not a v5 `session_config`
    // member, so the session goal stays display state and never wire authority.
    expect("initial_goal" in session).toBe(false);
    expect("session_token" in session).toBe(false);
  });

  test("takes every session fact from the projection, never from a route id or a seed", () => {
    const session = studyProjectionToAgentSessionConfig(THERMO_PROJECTION, "user-9");
    const serialized = JSON.stringify(session);

    expect(serialized).not.toContain("biology");
    expect(serialized).not.toContain("oxidative-phosphorylation");
    expect(session.session_id).toBe(THERMO_PROJECTION.session.id);
    expect(session.study_set_id).toBe(THERMO_PROJECTION.studySet.id);
  });

  test("D-03 Branch B: mode comes from the projection and no default is injected", () => {
    const session = studyProjectionToAgentSessionConfig(THERMO_PROJECTION, "user-9");

    // Branch B is one honest oral exam: the projection carries the single
    // server-owned mode and a null goal, and the validator refuses anything
    // else. Nothing here supplies a client-side default for either.
    expect(session.mode).toBe(THERMO_PROJECTION.session.mode);
    expect(THERMO_PROJECTION.session.goal).toBe(null);
    expect(() =>
      validateAuthenticatedStudyProjectionV1({
        ...THERMO_PROJECTION,
        session: { ...THERMO_PROJECTION.session, goal: "cram the whole unit" },
      }),
    ).toThrow();
    expect(() =>
      validateAuthenticatedStudyProjectionV1({
        ...THERMO_PROJECTION,
        session: { ...THERMO_PROJECTION.session, mode: "teach" },
      }),
    ).toThrow();
  });

  test("two successive projections drive active concepts without a client-side transition", () => {
    const first = studyProjectionToAgentSessionConfig(THERMO_PROJECTION, "user-9");
    const second = studyProjectionToAgentSessionConfig(
      {
        ...THERMO_PROJECTION,
        concepts: [THERMO_PROJECTION.concepts[0]],
        reviewSchedule: [THERMO_PROJECTION.reviewSchedule[0]],
      } as AuthenticatedStudyProjectionV1,
      "user-9",
    );

    expect(first.active_concepts).toEqual(["enthalpy", "gibbs-free-energy"]);
    expect(second.active_concepts).toEqual(["enthalpy"]);
    expect({ ...first, active_concepts: [] }).toEqual({ ...second, active_concepts: [] });
  });

  test("preserves full source tuple when mapping agent source to UI source", () => {
    const source: AgentStudySourceReference = {
      confidence: "high",
      document_id: "lec-5",
      excerpt: "NADH source.",
      retrieval_reason: "server fixture source for oxidative phosphorylation",
      source_id: "src-lecture-5-slide-18",
      span: "slide:18",
    };

    expect(agentSourceToUiSource(source)).toEqual({
      confidence: "high",
      documentId: "lec-5",
      excerpt: "NADH source.",
      label: "Lecture 5 · Slide 18",
      retrievalReason: "server fixture source for oxidative phosphorylation",
      sourceId: "src-lecture-5-slide-18",
      span: "slide:18",
    });
  });

  test("derives UI state from shared synthetic session frames", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }

    const derived = deriveVivaAgentUiState(state);

    expect(derived.phase).toBe("recap");
    expect(derived.question?.prompt).toBe("Explain the role of NADH in oxidative phosphorylation.");
    expect(derived.evaluation?.source.sourceId).toBe("src-lecture-5-slide-18");
    expect(derived.currentSource?.sourceId).toBe("src-lecture-5-slide-18");
    expect(derived.currentConceptStatus).toBe("strong");
    expect(derived.recap?.sourceMoments[0]?.source.documentId).toBe("lec-5");
    expect(derived.recapState?.kind).toBe("complete");
    // `WEBSESSION-RECAP-01`: the session already produced its recap, so it is
    // terminal-success and no further answer can be submitted into it. The old
    // `true` here was the defect — an open socket alone was treated as an open
    // turn even after the last word of the session had been said.
    expect(derived.canSubmitAnswer).toBe(false);
  });

  test("renders the v2 recap as emitted and fabricates no study plan", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }

    const recap = deriveVivaAgentUiState(state).recap;

    if (!recap) throw new Error("expected a recap");
    expect(recap.headline).toBe("Strong concepts: 1 of 1.");
    expect(recap.strongConcepts).toEqual(["Oxidative phosphorylation"]);
    expect(recap.shakyConcepts).toEqual([]);
    expect(recap.missedConcepts).toEqual([]);
    expect(recap.reviewLater).toEqual([]);
    expect(recap.nextAction).toBe("Review the scheduled concepts on their due dates.");
    // v1's three-row "Now / Tomorrow / Next" timeline was a browser invention.
    // The v2 recap publishes a real review schedule instead, so nothing is
    // fabricated here.
    expect(recap.plan).toEqual([]);
  });

  test("a source moment whose response was never graded is dropped, never guessed", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }
    const graded = deriveVivaAgentUiState(state).recap;
    const ungraded = deriveVivaAgentUiState({ ...state, conceptStatusEvents: [] }).recap;

    expect(graded?.sourceMoments).toHaveLength(1);
    expect(graded?.sourceMoments[0]?.status).toBe("strong");
    expect(ungraded?.sourceMoments).toEqual([]);
  });

  test("derives validated manuscript intents for the scene reducer", () => {
    const derived = deriveVivaAgentUiState({
      ...initialVivaAgentSessionState(),
      manuscriptIntents: [
        {
          responseId: "response-1",
          intent: { type: "scene_intent", register: "examining", emphasis: "measured" },
        },
      ],
    });

    expect(derived.manuscriptIntents).toEqual([
      { type: "scene_intent", register: "examining", emphasis: "measured" },
    ]);
  });

  test("keeps generation metadata visible while pending submits disable duplicate answers", () => {
    const derived = deriveVivaAgentUiState({
      ...initialVivaAgentSessionState(),
      generation: {
        id: "session_bootstrap-1",
        reason: "session_bootstrap",
        sequence: 1,
      },
      pendingSubmission: {
        generationId: "session_bootstrap-1",
        kind: "text",
      },
      status: "open",
    });

    expect(derived.generationId).toBe("session_bootstrap-1");
    expect(derived.canSubmitAnswer).toBe(false);
  });
});

/**
 * The hook's audio surface is the pure command factory the hook itself uses, so
 * the four v5 audio methods are provable without a DOM: `bun:test` has no DOM
 * environment at this base and this lane does not add one.
 */
describe("viva agent audio commands", () => {
  const sent: VivaAudioSendResult = { acceptedThroughSequence: 4, status: "sent" };
  const pending: VivaAudioSendResult = {
    acceptedThroughSequence: 4,
    retainedFromSequence: 5,
    status: "pending",
  };

  test("delegates the four audio methods to the controller and returns results unchanged", () => {
    const calls: string[] = [];
    const controller = {
      cancelAudioTurn: (turnId: string) => {
        calls.push(`cancel:${turnId}`);
      },
      endAudioTurn: (input: { turnId: string; finalSequence: number }) => {
        calls.push(`end:${input.turnId}:${input.finalSequence}`);
        return pending;
      },
      retryPendingAudio: () => {
        calls.push("retry");
        return sent;
      },
      sendAudioChunk: (input: { turnId: string; sequence: number; pcm16Bytes: Uint8Array }) => {
        calls.push(`chunk:${input.turnId}:${input.sequence}:${input.pcm16Bytes.byteLength}`);
        return sent;
      },
    } as unknown as VivaAgentSessionController;
    const commands = createVivaAgentAudioCommands(() => controller);

    expect(
      commands.sendAudioChunk({
        pcm16Bytes: new Uint8Array(960),
        sequence: 0,
        turnId: "turn-hook",
      }),
    ).toBe(sent);
    expect(commands.endAudioTurn({ finalSequence: 0, turnId: "turn-hook" })).toBe(pending);
    commands.cancelAudioTurn("turn-hook");
    expect(commands.retryPendingAudio()).toBe(sent);

    expect(calls).toEqual([
      "chunk:turn-hook:0:960",
      "end:turn-hook:0",
      "cancel:turn-hook",
      "retry",
    ]);
  });

  test("returns a retryable socket_closed result while no controller is mounted", () => {
    const commands = createVivaAgentAudioCommands(() => null);
    const disconnected = {
      code: "socket_closed",
      message: "Viva agent session is not connected",
    } as const;

    expect(
      commands.sendAudioChunk({ pcm16Bytes: new Uint8Array(2), sequence: 7, turnId: "turn-hook" }),
    ).toEqual({
      acceptedThroughSequence: null,
      error: disconnected,
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    });
    expect(commands.endAudioTurn({ finalSequence: 7, turnId: "turn-hook" })).toEqual({
      acceptedThroughSequence: null,
      error: disconnected,
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    });
    expect(commands.retryPendingAudio()).toEqual({
      acceptedThroughSequence: null,
      error: disconnected,
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    });
    expect(() => commands.cancelAudioTurn("turn-hook")).not.toThrow();
  });
});

/**
 * `WEBSESSION-AUTH-01` / `WEBSESSION-AUTH-02` — D-07 Branch A
 * (`retain-token-only`, recorded in
 * `agent/fixtures/voice-protocol/v5/auth-decision.json`).
 *
 * One authoritative credential, rotated atomically, bounded at 6,000 ms, held in
 * module memory only.
 */
describe("browser session credential vault (D-07 Branch A)", () => {
  const identity = {
    sessionId: "voice-session-9",
    studySetId: "thermo-401",
    userId: "user-9",
  } as const;

  function entryCredential(
    overrides: Partial<Extract<BrowserSessionCredential, { mode: "retain-token-only" }>> = {},
  ): Extract<BrowserSessionCredential, { mode: "retain-token-only" }> {
    return {
      accessToken: "viva1.access-a",
      identity,
      mode: "retain-token-only",
      refreshExpiresAt: null,
      refreshToken: "viva-refresh1.credential-r1",
      revision: 1,
      sessionAbsoluteExpiresAt: null,
      ...overrides,
    };
  }

  function rotationBody(overrides: Record<string, unknown> = {}) {
    return {
      failure_class: null,
      refresh_expires_at: "2026-08-26T12:00:00Z",
      refresh_token: "viva-refresh1.credential-r2",
      session: {
        session_id: identity.sessionId,
        study_set_id: identity.studySetId,
        user_id: identity.userId,
      },
      session_absolute_expires_at: "2026-08-26T20:00:00Z",
      session_token: "viva1.access-b",
      token_refresh_outcome: "refreshed",
      ...overrides,
    };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  }

  afterEach(() => {
    jest.useRealTimers();
    clearBrowserSessionCredential();
  });

  test("the rotation POST carries exactly the four Plan 11 fields and never the access token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await refreshBrowserSessionToken(entryCredential(), {
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init, url: String(url) });
        return jsonResponse(rotationBody());
      }) as typeof fetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/viva-session/refresh");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      refresh_token: "viva-refresh1.credential-r1",
      session_id: identity.sessionId,
      study_set_id: identity.studySetId,
      user_id: identity.userId,
    });
    expect(Object.keys(body)).not.toContain("session_token");
    expect(JSON.stringify(body)).not.toContain("viva1.access-a");
    expect(result.status).toBe("renewed");
  });

  test("a rotation replaces access token, refresh credential, and both RFC3339 expiries atomically", async () => {
    replaceBrowserSessionCredential(entryCredential());
    const result = await refreshBrowserSessionToken(entryCredential(), {
      fetchImpl: (async () => jsonResponse(rotationBody())) as typeof fetch,
    });

    expect(result.status).toBe("renewed");
    const stored = readBrowserSessionCredential();
    expect(stored?.mode).toBe("retain-token-only");
    expect(stored?.accessToken).toBe("viva1.access-b");
    if (stored?.mode !== "retain-token-only") throw new Error("expected a Branch A credential");
    expect(stored.refreshToken).toBe("viva-refresh1.credential-r2");
    expect(stored.refreshExpiresAt).toBe(Date.parse("2026-08-26T12:00:00Z"));
    expect(stored.sessionAbsoluteExpiresAt).toBe(Date.parse("2026-08-26T20:00:00Z"));
    expect(stored.identity).toEqual(identity);
  });

  test("a second rotation submits the rotated credential, never the spent one", async () => {
    const submitted: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      submitted.push(body.refresh_token);
      return jsonResponse(
        rotationBody({ refresh_token: `viva-refresh1.credential-after-${submitted.length}` }),
      );
    }) as typeof fetch;

    const first = await refreshBrowserSessionToken(entryCredential(), { fetchImpl });
    expect(first.status).toBe("renewed");
    const rotated = readBrowserSessionCredential();
    if (rotated?.mode !== "retain-token-only") throw new Error("expected a Branch A credential");
    await refreshBrowserSessionToken(rotated, { fetchImpl });

    expect(submitted).toEqual(["viva-refresh1.credential-r1", "viva-refresh1.credential-after-1"]);
  });

  const invalidRotations: Array<[string, Record<string, unknown>]> = [
    [
      "a missing field",
      (() => {
        const body = rotationBody() as Record<string, unknown>;
        delete body.refresh_token;
        return body;
      })(),
    ],
    ["an extra field", rotationBody({ session_hint: "extra" })],
    ["a wrong-typed instant", rotationBody({ refresh_expires_at: 1_800_000_000 })],
    ["a non-RFC3339 instant", rotationBody({ session_absolute_expires_at: "tomorrow" })],
    ["an unknown refresh outcome", rotationBody({ token_refresh_outcome: "rotated" })],
    ["a non-null failure class", rotationBody({ failure_class: "session_auth_failure" })],
    [
      "a mismatched identity",
      rotationBody({
        session: {
          session_id: "voice-session-other",
          study_set_id: "thermo-401",
          user_id: "user-9",
        },
      }),
    ],
  ];

  for (const [label, body] of invalidRotations) {
    test(`clears the vault and returns invalid_response for ${label}`, async () => {
      replaceBrowserSessionCredential(entryCredential());
      const result = await refreshBrowserSessionToken(entryCredential(), {
        fetchImpl: (async () => jsonResponse(body)) as typeof fetch,
      });

      expect(result).toEqual({ reason: "invalid_response", status: "terminal" });
      expect(readBrowserSessionCredential()).toBeNull();
    });
  }

  test("a terminal 401 clears the vault and never retains half a credential pair", async () => {
    replaceBrowserSessionCredential(entryCredential());
    const result = await refreshBrowserSessionToken(entryCredential(), {
      fetchImpl: (async () =>
        jsonResponse({ error: "session_auth_terminal" }, 401)) as typeof fetch,
    });

    expect(result).toEqual({ reason: "auth_terminal", status: "terminal" });
    expect(readBrowserSessionCredential()).toBeNull();
  });

  test("a 5xx retains the current credential rather than clearing it", async () => {
    const credential = entryCredential();
    const result = await refreshBrowserSessionToken(credential, {
      fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch,
    });

    expect(result).toEqual({ credential, reason: "unavailable", status: "retained" });
  });

  test("the 6,000 ms deadline aborts the request and retains the current credential", async () => {
    jest.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const credential = entryCredential();
    const pending = refreshBrowserSessionToken(credential, {
      fetchImpl: ((_url: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }) as typeof fetch,
    });

    jest.advanceTimersByTime(VIVA_SESSION_ENTRY_REFRESH_TIMEOUT_MS - 1);
    expect(observedSignal?.aborted).toBe(false);

    jest.advanceTimersByTime(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(await pending).toEqual({
      credential,
      reason: "timeout",
      status: "retained",
    });
  });

  test("an outer abort before the deadline cancels the request and renews nothing", async () => {
    replaceBrowserSessionCredential(entryCredential());
    const outer = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const credential = entryCredential();
    const pending = refreshBrowserSessionToken(credential, {
      fetchImpl: ((_url: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }) as typeof fetch,
      signal: outer.signal,
      // A deadline far past the unmount proves the abort — not the timer — is
      // what releases the request.
      timeoutMs: 600_000,
    });

    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(false);
    outer.abort();
    expect(observedSignal?.aborted).toBe(true);

    expect(await pending).toEqual({
      credential,
      reason: "unavailable",
      status: "retained",
    });
    // Neither half of the pair moved: the pre-abort credential is still the one
    // the vault holds.
    expect(readBrowserSessionCredential()?.accessToken).toBe("viva1.access-a");
  });

  test("a credential with no rotating refresh credential is not renewable and makes no request", async () => {
    let called = 0;
    const credential = entryCredential({ refreshToken: null });
    const result = await renewBrowserSessionCredential({
      credential,
      reason: "session_entry",
      signal: new AbortController().signal,
    });
    const direct = await refreshBrowserSessionToken(credential, {
      fetchImpl: (async () => {
        called += 1;
        return jsonResponse(rotationBody());
      }) as typeof fetch,
    });

    expect(result).toEqual({ credential, reason: "not_renewable", status: "retained" });
    expect(direct).toEqual({ credential, reason: "not_renewable", status: "retained" });
    expect(called).toBe(0);
  });

  test("the vault holds credentials in module memory only", () => {
    // Whatever host surfaces exist in this process, none of them may end up
    // holding the credential: the vault is module memory, full stop.
    const host = globalThis as typeof globalThis & {
      document?: { cookie?: string };
      localStorage?: Storage;
      location?: { href: string };
      sessionStorage?: Storage;
    };
    const before = {
      cookie: host.document?.cookie ?? "",
      href: host.location?.href ?? "",
      local: host.localStorage?.length ?? 0,
      session: host.sessionStorage?.length ?? 0,
    };

    replaceBrowserSessionCredential(entryCredential());

    expect(readBrowserSessionCredential()?.accessToken).toBe("viva1.access-a");
    expect(host.document?.cookie ?? "").toBe(before.cookie);
    expect(host.location?.href ?? "").toBe(before.href);
    expect(host.localStorage?.length ?? 0).toBe(before.local);
    expect(host.sessionStorage?.length ?? 0).toBe(before.session);

    replaceBrowserSessionCredential(null);
    expect(readBrowserSessionCredential()).toBeNull();
  });

  test("FRONTEND-011: the vault seam stores the complete start response", () => {
    browserSessionCredentialVault.replaceBrowserSessionCredential({
      mode: "retain-token-only",
      refresh_expires_at: "2026-08-26T12:00:00Z",
      refresh_token: "viva-refresh1.credential-from-start",
      session_absolute_expires_at: "2026-08-26T20:00:00Z",
      session_id: identity.sessionId,
      session_token: "viva1.access-from-start",
      study_set_id: identity.studySetId,
      user_id: identity.userId,
    });

    const stored = readBrowserSessionCredential();
    if (stored?.mode !== "retain-token-only") throw new Error("expected a Branch A credential");
    expect(stored.accessToken).toBe("viva1.access-from-start");
    expect(stored.refreshToken).toBe("viva-refresh1.credential-from-start");
    expect(stored.refreshExpiresAt).toBe(Date.parse("2026-08-26T12:00:00Z"));
    expect(stored.sessionAbsoluteExpiresAt).toBe(Date.parse("2026-08-26T20:00:00Z"));
    expect(stored.identity).toEqual(identity);
    expect(stored.revision).toBeGreaterThan(0);
  });
});
