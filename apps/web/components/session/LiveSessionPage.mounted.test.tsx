// The DOM must exist before React (or anything that reads `window` at import
// time) is loaded, so this stays the FIRST import in the file.
import "../../test/setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthenticatedStudyProjectionV1 } from "@viva/core";
import { act, StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  type BrowserSessionCredential,
  clearBrowserSessionCredential,
  type RenewBrowserSessionCredentialResult,
  readBrowserSessionCredential,
  replaceBrowserSessionCredential,
} from "../../lib/use-viva-agent-session";
import {
  type AuthenticatedStudyProjectionRequest,
  type AuthenticatedStudyProjectionResult,
  initialVivaAgentSessionState,
  VIVA_AGENT_READINESS_POLL_INTERVAL_MS,
  VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS,
  type VivaAgentReadinessProbe,
  type VivaAgentRetainedAudioTurn,
  type VivaAgentSessionController,
  type VivaAgentSessionControllerOptions,
  type VivaAgentSessionState,
} from "../../lib/viva-agent-client";
import {
  disclosureAcknowledgementKey,
  LiveSessionPage,
  type LiveSessionPageDependencies,
} from "./LiveSessionPage";

const ROUTE_IDENTITY = {
  sessionId: "voice-session-9",
  studySetId: "thermo-401",
  userId: "user-9",
} as const;

const ENTRY_URL =
  `https://viva.test/session?user_id=${ROUTE_IDENTITY.userId}` +
  `&study_set_id=${ROUTE_IDENTITY.studySetId}&session_id=${ROUTE_IDENTITY.sessionId}` +
  `&view=margin#session_token=viva1.access-from-url&fold=open`;

type ControllerRecord = {
  connects: string[];
  created: Array<{ sessionToken: string | null; token: string | null }>;
  refreshes: Array<string | null>;
};

function newControllerRecord(): ControllerRecord {
  return { connects: [], created: [], refreshes: [] };
}

function fakeControllerFactory(record: ControllerRecord) {
  return (options: VivaAgentSessionControllerOptions): VivaAgentSessionController => {
    record.created.push({
      sessionToken: options.sessionToken ?? null,
      token: options.token ?? null,
    });
    const state = initialVivaAgentSessionState();
    const socket = {} as WebSocket;
    return {
      acknowledgeAudio: () => {},
      cancel: () => {},
      cancelAudioTurn: () => {},
      close: () => {},
      connect: (reason) => {
        record.connects.push(reason ?? "session_bootstrap");
        return socket;
      },
      endAudioTurn: () => ({
        acceptedThroughSequence: null,
        error: { code: "socket_closed", message: "closed" },
        retainedFromSequence: 0,
        retryable: true,
        status: "socket_closed",
      }),
      getRetainedAudioTurn: () => null,
      getState: () => state,
      refreshSession: (input) => {
        record.refreshes.push(input?.sessionToken ?? null);
        return socket;
      },
      reset: () => {},
      retryPendingAudio: () => ({
        acceptedThroughSequence: null,
        error: { code: "socket_closed", message: "closed" },
        retainedFromSequence: 0,
        retryable: true,
        status: "socket_closed",
      }),
      sendAudioChunk: () => ({
        acceptedThroughSequence: null,
        error: { code: "socket_closed", message: "closed" },
        retainedFromSequence: 0,
        retryable: true,
        status: "socket_closed",
      }),
      sendText: () => true,
      sendTurnIntent: (input: { turnId: string }) => ({
        status: "sent" as const,
        turnId: input.turnId,
      }),
      stop: () => {},
      subscribe: () => () => {},
    };
  };
}

type RenewalRecord = {
  calls: Array<{ accessToken: string; refreshToken: string | null; reason: string }>;
};

function recordingRenewal(
  record: RenewalRecord,
  next: (call: number) => RenewBrowserSessionCredentialResult,
) {
  return async (input: {
    credential: BrowserSessionCredential;
    reason: "session_entry" | "auth_expired" | "transport_reconnect" | "browser_restore";
    signal: AbortSignal;
  }): Promise<RenewBrowserSessionCredentialResult> => {
    record.calls.push({
      accessToken: input.credential.accessToken,
      reason: input.reason,
      refreshToken:
        input.credential.mode === "retain-token-only" ? input.credential.refreshToken : null,
    });
    const result = next(record.calls.length);
    if (result.status === "renewed") replaceBrowserSessionCredential(result.credential);
    return result;
  };
}

function branchACredential(
  overrides: Partial<Extract<BrowserSessionCredential, { mode: "retain-token-only" }>> = {},
): Extract<BrowserSessionCredential, { mode: "retain-token-only" }> {
  return {
    accessToken: "viva1.access-a",
    identity: ROUTE_IDENTITY,
    mode: "retain-token-only",
    refreshExpiresAt: Date.parse("2026-08-26T12:00:00Z"),
    refreshToken: "viva-refresh1.credential-r1",
    revision: 1,
    sessionAbsoluteExpiresAt: Date.parse("2026-08-26T20:00:00Z"),
    ...overrides,
  };
}

const IDLE_PROBE: VivaAgentReadinessProbe = { status: "api_missing" };

/**
 * A deliberately NON-Biology projection: nothing in it can be produced by
 * `seedStudySets`, so any Biology string on screen would be a fabrication.
 */
function thermoProjection(
  overrides: Partial<AuthenticatedStudyProjectionV1> = {},
): AuthenticatedStudyProjectionV1 {
  return {
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
        dueAt: "2026-08-29T09:00:00.000Z",
        id: "enthalpy",
        label: "Enthalpy",
        lastReviewedAt: "2026-08-20T09:00:00.000Z",
        status: "shaky",
      },
      {
        dueAt: "2026-08-27T09:00:00.000Z",
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
        dueAt: "2026-08-29T09:00:00.000Z",
      },
      {
        authority: "server_persisted_fsrs",
        conceptId: "gibbs-free-energy",
        dueAt: "2026-08-27T09:00:00.000Z",
      },
    ],
    session: { goal: null, id: ROUTE_IDENTITY.sessionId, mode: "quiz" },
    studySet: {
      course: "CHEM-401",
      examLabel: "Oral final",
      id: ROUTE_IDENTITY.studySetId,
      ingestionStatus: "ready",
      title: "Thermodynamic State Functions",
    },
    version: 1,
    ...overrides,
  };
}

type ProjectionRecord = { calls: Array<{ accessToken: string; studySetId: string }> };

function recordingProjection(
  record: ProjectionRecord,
  next: (call: number) => AuthenticatedStudyProjectionResult,
): LiveSessionPageDependencies["fetchStudyProjection"] {
  return (async (input: AuthenticatedStudyProjectionRequest) => {
    record.calls.push({ accessToken: input.accessToken, studySetId: input.studySetId });
    return next(record.calls.length);
  }) as LiveSessionPageDependencies["fetchStudyProjection"];
}

function testDependencies(
  overrides: Partial<LiveSessionPageDependencies> = {},
): Partial<LiveSessionPageDependencies> {
  return {
    createAudioCaptureSource: (async () => {
      throw new Error("capture must not start without a gesture");
    }) as LiveSessionPageDependencies["createAudioCaptureSource"],
    createAudioPlaybackSink: (() => {
      throw new Error("playback must not start without a gesture");
    }) as LiveSessionPageDependencies["createAudioPlaybackSink"],
    fetchReadiness: (async () => IDLE_PROBE) as LiveSessionPageDependencies["fetchReadiness"],
    fetchStudyProjection: (async () => ({
      projection: thermoProjection(),
      status: "ready",
    })) as LiveSessionPageDependencies["fetchStudyProjection"],
    ...overrides,
  };
}

type ConsoleSpy = { calls: unknown[][]; restore: () => void };

function spyOnConsoleError(): ConsoleSpy {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console.error = original;
    },
  };
}

type HistorySpy = { urls: Array<string | URL | null | undefined>; restore: () => void };

function spyOnReplaceState(): HistorySpy {
  const original = window.history.replaceState.bind(window.history);
  const urls: Array<string | URL | null | undefined> = [];
  window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    urls.push(url);
    return original(data, unused, url ?? undefined);
  }) as typeof window.history.replaceState;
  return {
    restore: () => {
      window.history.replaceState = original as typeof window.history.replaceState;
    },
    urls,
  };
}

function mountContainer(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

/**
 * Drains the effect chain the page's bootstrap actually uses: a zero-delay timer
 * arms the renewal, its resolution commits state, that commit arms the deferred
 * connect. Two rounds is one more than the deepest chain, so a passing assertion
 * means the work finished rather than that the harness stopped early.
 */
async function settle(rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

const mountedRoots: Array<{ unmount: () => void }> = [];

function trackRoot<T extends { unmount: () => void }>(root: T): T {
  mountedRoots.push(root);
  return root;
}

beforeEach(() => {
  clearBrowserSessionCredential();
  window.history.replaceState(null, "", ENTRY_URL);
});

afterEach(async () => {
  // A failed assertion skips the test's own unmount; without this, that page
  // stays mounted and its in-flight renewal rewrites the vault under the NEXT
  // test, turning one real failure into a cascade of misleading ones.
  await act(async () => {
    while (mountedRoots.length > 0) mountedRoots.pop()?.unmount();
  });
  clearBrowserSessionCredential();
});

describe("mounted-test runtime", () => {
  test("React 19 act, createRoot, and hydrateRoot all drive the shared DOM", async () => {
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    await act(async () => {
      root.render(
        <StrictMode>
          <p data-testid="smoke">mounted</p>
        </StrictMode>,
      );
    });
    expect(container.querySelector("[data-testid='smoke']")?.textContent).toBe("mounted");
    await act(async () => {
      root.unmount();
    });
    expect(container.innerHTML).toBe("");

    const hydrationHost = mountContainer();
    hydrationHost.innerHTML = renderToString(<p data-testid="hydrated">server</p>);
    const hydrated = hydrateRoot(hydrationHost, <p data-testid="hydrated">server</p>);
    await act(async () => {});
    expect(hydrationHost.querySelector("[data-testid='hydrated']")?.textContent).toBe("server");
    await act(async () => {
      hydrated.unmount();
    });
  });
});

describe("LiveSessionPage route identity and hydration (WEBSESSION-ROUTE-01)", () => {
  test("renders a neutral shell, mutates no URL during render, and hydrates without mismatch", async () => {
    const controllers = newControllerRecord();
    const renewals: RenewalRecord = { calls: [] };
    const dependencies = testDependencies({
      createAgentController: fakeControllerFactory(controllers),
      renewCredential: recordingRenewal(renewals, () => ({
        credential: branchACredential(),
        reason: "not_renewable",
        status: "retained",
      })),
    });

    const history = spyOnReplaceState();
    const consoleSpy = spyOnConsoleError();
    try {
      const serverHtml = renderToString(<LiveSessionPage dependencies={dependencies} />);
      // Render is pure: no history write, and no route identity leaked into the
      // server markup.
      expect(history.urls).toEqual([]);
      expect(serverHtml).not.toContain("viva1.access-from-url");
      expect(serverHtml).not.toContain(ROUTE_IDENTITY.studySetId);

      const container = mountContainer();
      container.innerHTML = serverHtml;
      const root = trackRoot(
        hydrateRoot(
          container,
          <StrictMode>
            <LiveSessionPage dependencies={dependencies} />
          </StrictMode>,
        ),
      );
      await settle();

      const hydrationWarnings = consoleSpy.calls.filter((call) =>
        /hydrat|did not match|server rendered/i.test(call.map(String).join(" ")),
      );
      expect(hydrationWarnings).toEqual([]);
      // Exactly one canonicalization after the committed mount, and it strips
      // the token from both query and fragment while preserving the rest.
      expect(history.urls).toHaveLength(1);
      expect(window.location.href).toBe(
        `https://viva.test/session?user_id=${ROUTE_IDENTITY.userId}` +
          `&study_set_id=${ROUTE_IDENTITY.studySetId}&session_id=${ROUTE_IDENTITY.sessionId}` +
          `&view=margin#fold=open`,
      );

      await act(async () => {
        root.unmount();
      });
    } finally {
      consoleSpy.restore();
      history.restore();
    }
  });

  test("connects exactly once, and only after the entry renewal settles", async () => {
    const controllers = newControllerRecord();
    const renewals: RenewalRecord = { calls: [] };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependencies = testDependencies({
      createAgentController: fakeControllerFactory(controllers),
      renewCredential: async (input) => {
        renewals.calls.push({
          accessToken: input.credential.accessToken,
          reason: input.reason,
          refreshToken:
            input.credential.mode === "retain-token-only" ? input.credential.refreshToken : null,
        });
        await gate;
        const credential = branchACredential({ accessToken: "viva1.access-b" });
        replaceBrowserSessionCredential(credential);
        return { credential, status: "renewed" };
      },
    });

    replaceBrowserSessionCredential(branchACredential());
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await settle();

    expect(controllers.connects).toEqual([]);
    release?.();
    await settle();

    expect(controllers.connects).toEqual(["session_bootstrap"]);
    // Every controller the mount created — including StrictMode's throwaway —
    // carries the renewed credential, never the pre-renewal one.
    expect(controllers.created.at(-1)?.sessionToken).toBe("viva1.access-b");
    expect(controllers.created.at(-1)?.token).toBe("viva1.access-b");

    await act(async () => {
      root.unmount();
    });
  });

  test("an identity-matched vault credential outranks the legacy URL access token", async () => {
    const controllers = newControllerRecord();
    const renewals: RenewalRecord = { calls: [] };
    const dependencies = testDependencies({
      createAgentController: fakeControllerFactory(controllers),
      renewCredential: recordingRenewal(renewals, () => ({
        credential: branchACredential(),
        reason: "not_renewable",
        status: "retained",
      })),
    });

    replaceBrowserSessionCredential(branchACredential());
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await settle();

    expect(renewals.calls.at(-1)?.accessToken).toBe("viva1.access-a");
    expect(renewals.calls.at(-1)?.refreshToken).toBe("viva-refresh1.credential-r1");
    expect(renewals.calls.at(-1)?.reason).toBe("session_entry");
    expect(controllers.created.at(-1)?.sessionToken).toBe("viva1.access-a");
    expect(controllers.created.map((entry) => entry.sessionToken)).not.toContain(
      "viva1.access-from-url",
    );

    await act(async () => {
      root.unmount();
    });
  });

  test("without a vault credential the URL access token is used but is not renewable", async () => {
    const controllers = newControllerRecord();
    const renewals: RenewalRecord = { calls: [] };
    const dependencies = testDependencies({
      createAgentController: fakeControllerFactory(controllers),
      renewCredential: recordingRenewal(renewals, () => ({
        credential: branchACredential({
          accessToken: "viva1.access-from-url",
          refreshToken: null,
        }),
        reason: "not_renewable",
        status: "retained",
      })),
    });

    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await settle();

    expect(renewals.calls.at(-1)?.accessToken).toBe("viva1.access-from-url");
    expect(renewals.calls.at(-1)?.refreshToken).toBeNull();
    expect(controllers.connects).toEqual(["session_bootstrap"]);

    await act(async () => {
      root.unmount();
    });
  });
});

describe("LiveSessionPage credential renewal (WEBSESSION-AUTH-01/02)", () => {
  test("browser lifecycle and manual recovery renew from the rotated credential only", async () => {
    const controllers = newControllerRecord();
    const renewals: RenewalRecord = { calls: [] };
    const rotations = [
      branchACredential({
        accessToken: "viva1.access-b",
        refreshToken: "viva-refresh1.credential-r2",
      }),
      branchACredential({
        accessToken: "viva1.access-c",
        refreshToken: "viva-refresh1.credential-r3",
      }),
      branchACredential({
        accessToken: "viva1.access-d",
        refreshToken: "viva-refresh1.credential-r4",
      }),
    ];
    const dependencies = testDependencies({
      createAgentController: fakeControllerFactory(controllers),
      renewCredential: recordingRenewal(renewals, (call) => ({
        credential: rotations[Math.min(call, rotations.length) - 1] ?? rotations[0],
        status: "renewed",
      })),
    });

    replaceBrowserSessionCredential(branchACredential());
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await settle();

    await act(async () => {
      const event = new Event("pageshow") as Event & { persisted?: boolean };
      Object.defineProperty(event, "persisted", { value: true });
      window.dispatchEvent(event);
    });
    await settle();

    await act(async () => {
      window.dispatchEvent(new Event("popstate"));
    });
    await settle();

    // Call 1 is the entry renewal (R1); every later renewal submits the
    // credential the previous rotation returned, and no path ever resubmits a
    // spent one.
    expect(renewals.calls.map((call) => call.refreshToken)).toEqual([
      "viva-refresh1.credential-r1",
      "viva-refresh1.credential-r2",
      "viva-refresh1.credential-r3",
    ]);
    expect(renewals.calls.map((call) => call.accessToken)).toEqual([
      "viva1.access-a",
      "viva1.access-b",
      "viva1.access-c",
    ]);
    expect(renewals.calls.map((call) => call.reason)).toEqual([
      "session_entry",
      "browser_restore",
      "browser_restore",
    ]);
    // The socket always carries the latest access token, never token A.
    expect(controllers.refreshes.at(-1)).toBe("viva1.access-d");
    expect(readBrowserSessionCredential()?.accessToken).toBe("viva1.access-d");

    await act(async () => {
      root.unmount();
    });
  });

  test("a terminal renewal leaves the socket closed and the vault empty", async () => {
    const controllers = newControllerRecord();
    const dependencies = testDependencies({
      createAgentController: fakeControllerFactory(controllers),
      renewCredential: async () => {
        clearBrowserSessionCredential();
        return { reason: "auth_terminal", status: "terminal" };
      },
    });

    replaceBrowserSessionCredential(branchACredential());
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await settle();

    expect(controllers.connects).toEqual([]);
    expect(readBrowserSessionCredential()).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  test("unmounting before the renewal settles aborts it and updates nothing", async () => {
    const controllers = newControllerRecord();
    let observedSignal: AbortSignal | undefined;
    let resolveRenewal: ((value: RenewBrowserSessionCredentialResult) => void) | undefined;
    const dependencies = testDependencies({
      createAgentController: fakeControllerFactory(controllers),
      renewCredential: (input) => {
        observedSignal = input.signal;
        return new Promise<RenewBrowserSessionCredentialResult>((resolve) => {
          resolveRenewal = resolve;
        });
      },
    });

    replaceBrowserSessionCredential(branchACredential());
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await settle();
    expect(observedSignal?.aborted).toBe(false);

    await act(async () => {
      root.unmount();
    });
    expect(observedSignal?.aborted).toBe(true);

    // A late resolution after unmount touches neither state nor the socket.
    await act(async () => {
      resolveRenewal?.({ credential: branchACredential(), status: "renewed" });
    });
    await settle();
    expect(controllers.connects).toEqual([]);
  });
});

describe("LiveSessionPage authenticated projection (WEBSESSION-DATA-01/PROGRESSION-01/MODE-01)", () => {
  async function mountWith(dependencies: Partial<LiveSessionPageDependencies>) {
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    replaceBrowserSessionCredential(branchACredential());
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await settle();
    return { container, root };
  }

  test("renders the server projection's own study set, concepts, progress, and schedule", async () => {
    const controllers = newControllerRecord();
    const projections: ProjectionRecord = { calls: [] };
    const { container } = await mountWith(
      testDependencies({
        createAgentController: fakeControllerFactory(controllers),
        fetchStudyProjection: recordingProjection(projections, () => ({
          projection: thermoProjection(),
          status: "ready",
        })),
        renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      }),
    );

    const markup = container.innerHTML;
    expect(markup).toContain("Thermodynamic State Functions");
    expect(markup).toContain("CHEM-401");
    expect(markup).toContain("Oral final");
    expect(markup).toContain("Enthalpy");
    expect(markup).toContain("Gibbs free energy");
    expect(markup).toContain("2 of 5 questions");
    // No Biology seed can reach this page any more: the projection is the only
    // read model, so there is nothing to overlay a fixture onto.
    expect(markup).not.toContain("Biology");
    expect(markup).not.toContain("biology-midterm");
    expect(markup).not.toContain("oxidative phosphorylation");
    expect(markup).not.toContain("Oxidative phosphorylation");

    expect(projections.calls).toHaveLength(1);
    expect(projections.calls[0]?.accessToken).toBe("viva1.access-a");
    expect(projections.calls[0]?.studySetId).toBe(ROUTE_IDENTITY.studySetId);
    expect(controllers.connects).toEqual(["session_bootstrap"]);
  });

  test("no socket opens until the projection validates", async () => {
    const controllers = newControllerRecord();
    let release: ((result: AuthenticatedStudyProjectionResult) => void) | undefined;
    const { container } = await mountWith(
      testDependencies({
        createAgentController: fakeControllerFactory(controllers),
        fetchStudyProjection: (() =>
          new Promise<AuthenticatedStudyProjectionResult>((resolve) => {
            release = resolve;
          })) as LiveSessionPageDependencies["fetchStudyProjection"],
        renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      }),
    );

    expect(controllers.connects).toEqual([]);
    expect(container.innerHTML).toContain("Preparing your session");

    await act(async () => {
      release?.({ projection: thermoProjection(), status: "ready" });
    });
    await settle();
    expect(controllers.connects).toEqual(["session_bootstrap"]);
  });

  test("a projection for another session is a sanitized pre-loop failure with zero sockets", async () => {
    const controllers = newControllerRecord();
    const { container } = await mountWith(
      testDependencies({
        createAgentController: fakeControllerFactory(controllers),
        fetchStudyProjection: (async () => ({
          projection: thermoProjection({
            session: {
              goal: null,
              id: "voice-session-other",
              mode: "quiz",
            },
          }),
          status: "ready",
        })) as LiveSessionPageDependencies["fetchStudyProjection"],
        renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      }),
    );

    expect(controllers.connects).toEqual([]);
    expect(container.innerHTML).toContain("invalid projection");
    expect(container.innerHTML).not.toContain("Thermodynamic State Functions");
    expect(container.innerHTML).not.toContain("Biology");
  });

  test("each sanitized failure cause renders its own pre-loop state and never connects", async () => {
    const cases: Array<[AuthenticatedStudyProjectionResult, string]> = [
      [{ cause: "unauthorized", status: "failed" }, "session auth terminal"],
      [{ cause: "not_found", status: "failed" }, "projection not found"],
      [{ cause: "rate_limited", retryAfterSeconds: 12, status: "failed" }, "rate limited"],
      [{ cause: "timeout", status: "failed" }, "projection timeout"],
      [{ cause: "invalid_projection", status: "failed" }, "invalid projection"],
      [{ cause: "unavailable", status: "failed" }, "projection unavailable"],
    ];
    for (const [result, statusLabel] of cases) {
      const controllers = newControllerRecord();
      const { container, root } = await mountWith(
        testDependencies({
          createAgentController: fakeControllerFactory(controllers),
          fetchStudyProjection: (async () =>
            result) as LiveSessionPageDependencies["fetchStudyProjection"],
          renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
        }),
      );

      expect(container.innerHTML).toContain(statusLabel);
      expect(controllers.connects).toEqual([]);
      await act(async () => {
        root.unmount();
      });
    }
  });

  test("a projection the server has not finished ingesting renders that status and stays closed", async () => {
    const controllers = newControllerRecord();
    const { container } = await mountWith(
      testDependencies({
        createAgentController: fakeControllerFactory(controllers),
        fetchStudyProjection: (async () => ({
          projection: thermoProjection({
            activeQuestion: null,
            studySet: {
              course: "CHEM-401",
              examLabel: "Oral final",
              id: ROUTE_IDENTITY.studySetId,
              ingestionStatus: "processing",
              title: "Thermodynamic State Functions",
            },
          }),
          status: "ready",
        })) as LiveSessionPageDependencies["fetchStudyProjection"],
        renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      }),
    );

    expect(controllers.connects).toEqual([]);
    expect(container.innerHTML).toContain("processing");
  });

  test("two successive server projections drive the question and progress with no client transition", async () => {
    const controllers = newControllerRecord();
    const projections: ProjectionRecord = { calls: [] };
    const { container } = await mountWith(
      testDependencies({
        createAgentController: fakeControllerFactory(controllers),
        fetchStudyProjection: recordingProjection(projections, (call) => ({
          projection:
            call === 1
              ? thermoProjection({
                  activeQuestion: null,
                  studySet: {
                    course: "CHEM-401",
                    examLabel: "Oral final",
                    id: ROUTE_IDENTITY.studySetId,
                    ingestionStatus: "processing",
                    title: "Thermodynamic State Functions",
                  },
                })
              : thermoProjection({
                  activeQuestion: {
                    conceptId: "gibbs-free-energy",
                    id: "q-gibbs-1",
                    prompt: "When is Gibbs free energy negative?",
                    sourceCitations: [],
                  },
                  questionProgress: { completed: 3, total: 5 },
                }),
          status: "ready",
        })),
        renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      }),
    );

    // The server's own ingestion status is stated, and no local `ready` is
    // written over it: one projection, no socket, no question.
    expect(projections.calls).toHaveLength(1);
    expect(controllers.connects).toEqual([]);
    expect(container.innerHTML).toContain("ingestion processing");
    expect(container.innerHTML).not.toContain("When is Gibbs free energy negative?");

    const retry = container.querySelector<HTMLButtonElement>(".session-preloop__action");
    if (!retry) throw new Error("expected an explicit projection refetch control");
    await act(async () => {
      retry.click();
    });
    await settle();

    // D-02: only a NEW server projection advances the question and the progress
    // counter. Between the two fetches the browser selected nothing, reordered
    // nothing, and inferred no exhaustion.
    expect(projections.calls).toHaveLength(2);
    expect(container.innerHTML).toContain("When is Gibbs free energy negative?");
    expect(container.innerHTML).toContain("3 of 5 questions");
    expect(container.innerHTML).not.toContain("2 of 5 questions");
    expect(controllers.connects).toEqual(["session_bootstrap"]);
  });

  test("D-03 Branch B: the page shows the server's one mode and offers no selector", async () => {
    const controllers = newControllerRecord();
    const { container } = await mountWith(
      testDependencies({
        createAgentController: fakeControllerFactory(controllers),
        renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      }),
    );

    // Branch B is one honest oral exam: the server's single mode is displayed as
    // stated and the null goal is reported as absent rather than filled in. The
    // page offers no mode selector and no free-text goal field, so there is no
    // learner intent left to discard.
    expect(container.innerHTML).toContain("quiz");
    expect(container.innerHTML).toContain("No goal recorded");
    expect(container.querySelector("select")).toBe(null);
    expect(container.querySelectorAll("input[type='text']")).toHaveLength(0);
    expect(controllers.connects).toEqual(["session_bootstrap"]);
  });
});

/**
 * A deterministic stand-in for the page's one scheduling seam. Nothing here
 * races the real event loop: a test advances virtual time itself, so "no socket
 * before 549 ms" is an assertion rather than a hope.
 */
type FakeReconnectClock = LiveSessionPageDependencies["reconnectClock"] & {
  advance: (ms: number) => void;
  pending: () => number[];
  setRandom: (value: number) => void;
};

function createFakeReconnectClock(random = 0): FakeReconnectClock {
  type Timer = { due: number; fn: () => void; id: number };
  let now = 0;
  let nextId = 1;
  let randomValue = random;
  const timers = new Map<number, Timer>();

  const clock: FakeReconnectClock = {
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => timer.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id);
        const next = due[0];
        if (!next) break;
        timers.delete(next.id);
        now = Math.max(now, next.due);
        next.fn();
      }
      now = target;
    },
    clearTimeout: ((id: unknown) => {
      timers.delete(Number(id));
    }) as typeof globalThis.clearTimeout,
    pending: () => [...timers.values()].map((timer) => timer.due - now),
    random: () => randomValue,
    setRandom: (value: number) => {
      randomValue = value;
    },
    setTimeout: ((fn: () => void, delay?: number) => {
      const id = nextId++;
      timers.set(id, { due: now + (delay ?? 0), fn, id });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout,
  };
  return clock;
}

type ProgrammableController = {
  factory: LiveSessionPageDependencies["createAgentController"];
  connects: string[];
  refreshes: Array<string | null>;
  retries: number;
  cancelledTurns: string[];
  retainedTurn: VivaAgentRetainedAudioTurn | null;
  push: (next: Partial<VivaAgentSessionState>) => void;
  state: () => VivaAgentSessionState;
};

/**
 * One controller instance whose state a test can push, so the page's recovery
 * effects observe real transitions instead of a frozen snapshot.
 */
function programmableController(): ProgrammableController {
  const listeners = new Set<(next: VivaAgentSessionState) => void>();
  let state = initialVivaAgentSessionState();
  const socket = {} as WebSocket;
  const closed = {
    acceptedThroughSequence: null,
    error: { code: "socket_closed", message: "closed" },
    retainedFromSequence: 0,
    retryable: true,
    status: "socket_closed",
  } as const;

  const record: ProgrammableController = {
    cancelledTurns: [],
    connects: [],
    factory: (() => ({
      acknowledgeAudio: () => {},
      cancel: () => {},
      cancelAudioTurn: (turnId: string) => {
        record.cancelledTurns.push(turnId);
      },
      close: () => {},
      connect: (reason?: string) => {
        record.connects.push(reason ?? "session_bootstrap");
        return socket;
      },
      endAudioTurn: () => closed,
      getRetainedAudioTurn: () => record.retainedTurn,
      getState: () => state,
      refreshSession: (input?: { reason?: string; sessionToken?: string | null }) => {
        record.refreshes.push(input?.sessionToken ?? null);
        record.connects.push(input?.reason ?? "token_refresh");
        return socket;
      },
      reset: () => {},
      retryPendingAudio: () => {
        record.retries += 1;
        return closed;
      },
      sendAudioChunk: () => closed,
      sendText: () => true,
      sendTurnIntent: () => ({ status: "sent", turnId: "turn-x" }),
      stop: () => {},
      subscribe: (listener: (next: VivaAgentSessionState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    })) as unknown as LiveSessionPageDependencies["createAgentController"],
    push: (next: Partial<VivaAgentSessionState>) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener(state);
    },
    refreshes: [],
    retainedTurn: null,
    retries: 0,
    state: () => state,
  };
  return record;
}

/** A complete v5 ready frame: the runtime copy reads its brain/store facts. */
const READY_FRAME = {
  brain: { configured: true, live_runtime: false, provider: "synthetic", selectable: true },
  input_encoding: "pcm_s16le",
  protocol: { preferred_version: 5, supported_versions: [5] },
  sample_rate_hz: 24_000,
  store: {
    available: true,
    backend: "in_memory",
    durable: false,
    nonce_replay_protection: true,
    raw_audio_persistence: false,
    transcript_persistence: false,
    uuid_schema_translation: true,
  },
  type: "ready",
  version: 5,
} as unknown as VivaAgentSessionState["ready"];

const RETAINED_TURN: VivaAgentRetainedAudioTurn = {
  acceptedThroughSequence: 2,
  endRequested: true,
  finalSequence: 2,
  retainedBytes: 6_144,
  retainedFromSequence: 0,
  turnId: "turn-retained-1",
};

describe("LiveSessionPage bounded recovery (WEBSESSION-RECOVERY-01 / WEBSESSION-AUDIO-01)", () => {
  async function mountRecovery(
    controller: ProgrammableController,
    clock: FakeReconnectClock,
    overrides: Partial<LiveSessionPageDependencies> = {},
  ) {
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    replaceBrowserSessionCredential(branchACredential());
    const dependencies = testDependencies({
      createAgentController: controller.factory,
      reconnectClock: clock,
      renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      ...overrides,
    });
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await drain(clock);
    return { container, root };
  }

  /** Runs the page's own zero-delay bootstrap chain on the fake clock. */
  async function drain(clock: FakeReconnectClock, ms = 0, rounds = 4) {
    for (let round = 0; round < rounds; round += 1) {
      await act(async () => {
        clock.advance(round === 0 ? ms : 0);
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 0);
        });
      });
    }
  }

  function closeUncleanly(controller: ProgrammableController) {
    controller.push({
      close: { code: 1006, wasClean: false },
      status: "closed",
      termination: { closeCode: 1006, kind: "transport", retryable: true },
    });
  }

  test("an unclean close reconnects after the lease grace, not before", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0.5);
    await mountRecovery(controller, clock);
    expect(controller.connects).toEqual(["session_bootstrap"]);

    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 0);

    await drain(clock, 549);
    expect(controller.connects).toEqual(["session_bootstrap"]);

    await drain(clock, 1);
    // Renewal → projection refetch → replacement generation, all inside the one
    // scheduled attempt. The first retry lands at 550 ms, past the 250 ms lease.
    expect(controller.connects).toEqual(["session_bootstrap", "socket_retry"]);
  });

  test("three bounded attempts run at 500/1000/2000 ms and then stop", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const { container } = await mountRecovery(controller, clock);

    for (const delay of [500, 1_000, 2_000]) {
      await act(async () => {
        closeUncleanly(controller);
      });
      await drain(clock, 0);
      await drain(clock, delay - 1);
      const before = controller.connects.length;
      await drain(clock, 1);
      expect({ after: controller.connects.length, delay }).toEqual({ after: before + 1, delay });
    }

    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 0);
    const afterThird = controller.connects.length;
    await drain(clock, 10_000);
    expect(controller.connects).toHaveLength(afterThird);
    expect(container.innerHTML).toContain("Connection lost");

    const retry = container.querySelector<HTMLButtonElement>("button.session-action--primary");
    expect(retry?.disabled).toBe(false);
  });

  test("a replacement generation that reaches ready resets the attempt budget", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    await mountRecovery(controller, clock);

    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 500);
    expect(controller.connects).toHaveLength(2);

    await act(async () => {
      controller.push({
        close: undefined,
        generation: { id: "gen-ready", reason: "socket_retry", sequence: 2 },
        ready: READY_FRAME,
        status: "open",
        termination: undefined,
      });
    });
    await drain(clock, 0);

    // Back to idle: the NEXT loss gets a full first attempt at 500 ms again.
    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 499);
    expect(controller.connects).toHaveLength(2);
    await drain(clock, 1);
    expect(controller.connects).toHaveLength(3);
  });

  test("no stop condition ever arms a retry timer", async () => {
    const stops: Array<[string, Partial<VivaAgentSessionState>]> = [
      ["terminal reason", { terminalReason: "session_cap" }],
      [
        "complete recap",
        {
          recap: {
            kind: "complete",
            recap: {
              concepts: [],
              deferred_turns: 0,
              headline: "h",
              next_action: "n",
              review_schedule: [],
              schema: "viva.study_session_recap.v2",
              source_moments: [],
              summary: "s",
              voice_session_id: ROUTE_IDENTITY.sessionId,
            },
          },
        },
      ],
      [
        "terminal structured error",
        {
          structuredErrors: [
            { terminalReason: "provider_malformed_stream", terminality: "terminal" },
          ],
          terminalReason: "provider_malformed_stream",
        },
      ],
      [
        "protocol termination",
        {
          termination: {
            closeCode: 1008,
            errorCode: "VOICE_CLIENT_FRAME_TOO_LARGE",
            kind: "protocol",
            retryable: false,
          },
        },
      ],
      ["clean 1000", { termination: { closeCode: 1000, kind: "normal", retryable: false } }],
    ];

    for (const [label, stop] of stops) {
      const controller = programmableController();
      const clock = createFakeReconnectClock(0);
      await mountRecovery(controller, clock);
      const before = controller.connects.length;

      await act(async () => {
        controller.push({ close: { code: 1006, wasClean: false }, status: "closed", ...stop });
      });
      await drain(clock, 10_000);

      expect({ connects: controller.connects.length, label }).toEqual({
        connects: before,
        label,
      });
    }
  });

  test("recovery renews the credential and refetches the projection before opening a socket", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const renewals: string[] = [];
    const projections: ProjectionRecord = { calls: [] };
    await mountRecovery(controller, clock, {
      fetchStudyProjection: recordingProjection(projections, () => ({
        projection: thermoProjection(),
        status: "ready",
      })),
      renewCredential: async ({ credential, reason }) => {
        renewals.push(reason);
        return { credential, status: "renewed" };
      },
    });
    expect(renewals).toEqual(["session_entry"]);
    expect(projections.calls).toHaveLength(1);

    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 500);

    expect(renewals).toEqual(["session_entry", "transport_reconnect"]);
    expect(projections.calls).toHaveLength(2);
    expect(controller.connects.at(-1)).toBe("socket_retry");
  });

  test("a failed renewal consumes one attempt, keeps the ledger, and opens no socket", async () => {
    const controller = programmableController();
    controller.retainedTurn = RETAINED_TURN;
    const clock = createFakeReconnectClock(0);
    const { container } = await mountRecovery(controller, clock, {
      renewCredential: async ({ credential, reason }) =>
        reason === "session_entry"
          ? { credential, status: "renewed" }
          : { credential, reason: "timeout", status: "retained" },
    });

    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 500);

    expect(controller.connects).toEqual(["session_bootstrap"]);
    expect(controller.retries).toBe(0);
    // The ledger is retained for manual recovery, and the copy is the sanitized
    // recovery state — never a fetch message, a close reason, or a claim that
    // the server received the spoken answer.
    expect(controller.cancelledTurns).toEqual([]);
    expect(container.innerHTML).toContain("Reconnecting");
    expect(container.innerHTML).toContain(
      "Your spoken answer is retained on this device for retry",
    );
    expect(container.innerHTML).not.toContain("received");
  });

  test("the retained turn is replayed exactly once, only after the replacement is ready", async () => {
    const controller = programmableController();
    controller.retainedTurn = RETAINED_TURN;
    const clock = createFakeReconnectClock(0);
    await mountRecovery(controller, clock);

    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 500);
    expect(controller.connects.at(-1)).toBe("socket_retry");
    expect(controller.retries).toBe(0);

    await act(async () => {
      controller.push({
        close: undefined,
        generation: { id: "gen-2", reason: "socket_retry", sequence: 2 },
        ready: undefined,
        status: "connecting",
        termination: undefined,
      });
    });
    await drain(clock, 0);
    expect(controller.retries).toBe(0);

    await act(async () => {
      controller.push({ ready: READY_FRAME, status: "open" });
    });
    await drain(clock, 0);
    expect(controller.retries).toBe(1);

    // Idempotent per generation: even a readiness flap that re-fires the replay
    // effect for the SAME generation must not resend the turn a second time.
    await act(async () => {
      controller.push({ phase: "listening" });
    });
    await drain(clock, 0);
    await act(async () => {
      controller.push({ ready: undefined, status: "connecting" });
    });
    await drain(clock, 0);
    await act(async () => {
      controller.push({ ready: READY_FRAME, status: "open" });
    });
    await drain(clock, 0);
    expect(controller.retries).toBe(1);
    expect(controller.cancelledTurns).toEqual([]);
  });

  test("exhaustion keeps the retained answer and offers one explicit replay", async () => {
    const controller = programmableController();
    controller.retainedTurn = RETAINED_TURN;
    const clock = createFakeReconnectClock(0);
    const { container } = await mountRecovery(controller, clock);

    for (const delay of [500, 1_000, 2_000]) {
      await act(async () => {
        closeUncleanly(controller);
      });
      await drain(clock, delay);
    }
    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 10_000);

    expect(container.innerHTML).toContain("Connection lost");
    expect(container.innerHTML).toContain(
      "Your spoken answer is retained on this device for retry",
    );
    expect(container.innerHTML).not.toContain("turn-retained-1");
    expect(controller.cancelledTurns).toEqual([]);

    const retry = container.querySelector<HTMLButtonElement>("button.session-action--primary");
    if (!retry) throw new Error("expected one manual recovery action");
    const connectsBefore = controller.connects.length;
    await act(async () => {
      retry.click();
    });
    await drain(clock, 0);
    expect(controller.connects.length).toBeGreaterThan(connectsBefore);

    await act(async () => {
      controller.push({
        generation: { id: "gen-manual", reason: "socket_retry", sequence: 9 },
        ready: READY_FRAME,
        status: "open",
      });
    });
    await drain(clock, 0);
    expect(controller.retries).toBe(1);
  });

  test("a terminal recap discards the retained turn through the controller", async () => {
    const controller = programmableController();
    controller.retainedTurn = RETAINED_TURN;
    const clock = createFakeReconnectClock(0);
    await mountRecovery(controller, clock);

    await act(async () => {
      controller.push({
        phase: "recap",
        recap: {
          kind: "partial",
          partialReason: "turn_cap",
          recap: {
            concepts: [],
            deferred_turns: 1,
            headline: "h",
            next_action: "n",
            review_schedule: [],
            schema: "viva.study_session_recap.v2",
            source_moments: [],
            summary: "s",
            voice_session_id: ROUTE_IDENTITY.sessionId,
          },
        },
        terminalReason: "turn_cap",
      });
    });
    await drain(clock, 0);

    expect(controller.cancelledTurns).toEqual([RETAINED_TURN.turnId]);
    expect(controller.retries).toBe(0);
  });

  test("unmount cancels the pending retry and opens nothing", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const { root } = await mountRecovery(controller, clock);

    await act(async () => {
      closeUncleanly(controller);
    });
    await drain(clock, 0);
    expect(clock.pending().length).toBeGreaterThan(0);

    await act(async () => {
      root.unmount();
    });
    const before = controller.connects.length;
    await act(async () => {
      clock.advance(10_000);
    });
    expect(controller.connects).toHaveLength(before);
  });
});

describe("LiveSessionPage typed intents and D-08A disclosure (WEBSESSION-INTENT-01 / WEBSESSION-DISCLOSURE-01)", () => {
  type IntentRecord = {
    factory: LiveSessionPageDependencies["createAgentController"];
    intents: Array<{ intent: unknown; turnId: string }>;
    texts: string[];
    push: (next: Partial<VivaAgentSessionState>) => void;
  };

  function intentController(): IntentRecord {
    const listeners = new Set<(next: VivaAgentSessionState) => void>();
    let state = initialVivaAgentSessionState();
    const socket = {} as WebSocket;
    const closed = {
      acceptedThroughSequence: null,
      error: { code: "socket_closed", message: "closed" },
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    } as const;
    const record: IntentRecord = {
      factory: (() => ({
        acknowledgeAudio: () => {},
        cancel: () => {},
        cancelAudioTurn: () => {},
        close: () => {},
        connect: () => socket,
        endAudioTurn: () => closed,
        getRetainedAudioTurn: () => null,
        getState: () => state,
        refreshSession: () => socket,
        reset: () => {},
        retryPendingAudio: () => closed,
        sendAudioChunk: () => closed,
        sendText: (text: string) => {
          record.texts.push(text);
          return true;
        },
        sendTurnIntent: (input: { intent: unknown; turnId: string }) => {
          record.intents.push({ intent: input.intent, turnId: input.turnId });
          return { status: "sent", turnId: input.turnId };
        },
        stop: () => {},
        subscribe: (listener: (next: VivaAgentSessionState) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      })) as unknown as LiveSessionPageDependencies["createAgentController"],
      intents: [],
      push: (next: Partial<VivaAgentSessionState>) => {
        state = { ...state, ...next };
        for (const listener of listeners) listener(state);
      },
      texts: [],
    };
    return record;
  }

  const LIVE_READY = {
    brain: { configured: true, live_runtime: true, provider: "cartesia_gemini", selectable: true },
    input_encoding: "pcm_s16le",
    protocol: { preferred_version: 5, supported_versions: [5] },
    sample_rate_hz: 24_000,
    store: {
      available: true,
      backend: "in_memory",
      durable: false,
      nonce_replay_protection: true,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    },
    type: "ready",
    version: 5,
  } as unknown as VivaAgentSessionState["ready"];

  const SOURCE = {
    confidence: "high" as const,
    document_id: "chem-lec-3",
    excerpt: "Enthalpy is a state function.",
    retrieval_reason: "server fixture source",
    source_id: "src-chem-lec-3-slide-11",
    span: "slide:11",
  };

  /**
   * A benign playback sink. The disclosure gesture legitimately unlocks
   * playback, so the throwing default would mask the behaviour under test.
   */
  function inertPlaybackSink(): LiveSessionPageDependencies["createAudioPlaybackSink"] {
    return (() => ({
      cancel: () => {},
      cancelResponse: () => {},
      close: async () => {},
      enqueue: () => {},
      getOutputLevel: () => 0,
      getState: () => ({
        cancelledResponseIds: [],
        nextSequence: 0,
        queue: [],
        responding: false,
        scheduledFrameCount: 0,
        speaking: false,
      }),
      reset: () => {},
      unlock: async () => {},
    })) as unknown as LiveSessionPageDependencies["createAudioPlaybackSink"];
  }

  async function mountIntents(
    controller: IntentRecord,
    overrides: Partial<LiveSessionPageDependencies> = {},
  ) {
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    replaceBrowserSessionCredential(branchACredential());
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage
            dependencies={testDependencies({
              createAgentController: controller.factory,
              createAudioPlaybackSink: inertPlaybackSink(),
              renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
              ...overrides,
            })}
          />
        </StrictMode>,
      );
    });
    await settle();
    return { container, root };
  }

  function openSourceFolio(container: HTMLElement) {
    const buttons = [...container.querySelectorAll("button")];
    const showSource = buttons.find((button) => button.textContent?.includes("Show source"));
    if (!showSource) throw new Error("expected a Show source control");
    showSource.click();
  }

  test("Challenge citation sends one typed intent bound to the current response and source", async () => {
    const controller = intentController();
    const { container } = await mountIntents(controller);

    await act(async () => {
      controller.push({
        activeResponseId: "response-1",
        currentSource: SOURCE,
        ready: LIVE_READY,
        sources: [SOURCE],
        status: "open",
      });
    });
    await settle();

    // Under D-08A nothing live is eligible until the learner acknowledges.
    const acknowledge = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Acknowledge",
    );
    if (!acknowledge) throw new Error("expected the disclosure acknowledgment");
    await act(async () => {
      acknowledge.click();
    });
    await settle();

    await act(async () => {
      openSourceFolio(container);
    });
    await settle();

    const challenge = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Challenge citation"),
    );
    if (!challenge) throw new Error("expected a Challenge citation control");
    expect(challenge.disabled).toBe(false);
    await act(async () => {
      challenge.click();
    });
    await settle();

    expect(controller.texts).toEqual([]);
    expect(controller.intents).toHaveLength(1);
    expect(controller.intents[0]?.intent).toEqual({
      kind: "citation_challenge",
      response_id: "response-1",
      source_id: "src-chem-lec-3-slide-11",
    });
    expect(controller.intents[0]?.turnId.length).toBeGreaterThan(0);
    expect(JSON.stringify(controller.intents)).not.toContain("(challenge citation)");
    expect(JSON.stringify(controller.intents)).not.toContain("answer_text");
  });

  test("a stale challenge target disables the control instead of aiming at another response", async () => {
    const controller = intentController();
    const { container } = await mountIntents(controller);

    await act(async () => {
      controller.push({
        activeResponseId: "response-1",
        currentSource: SOURCE,
        ready: LIVE_READY,
        sources: [SOURCE],
        status: "open",
      });
    });
    await settle();
    const acknowledge = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Acknowledge",
    );
    await act(async () => {
      acknowledge?.click();
    });
    await settle();
    await act(async () => {
      openSourceFolio(container);
    });
    await settle();

    // The current response moves on while the folio is open.
    await act(async () => {
      controller.push({ activeResponseId: undefined, currentSource: undefined, sources: [] });
    });
    await settle();

    const challenge = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Challenge"),
    );
    if (!challenge) throw new Error("expected the challenge control to remain rendered");
    expect(challenge.disabled).toBe(true);
    await act(async () => {
      challenge.click();
    });
    await settle();
    expect(controller.intents).toEqual([]);
    expect(controller.texts).toEqual([]);
  });

  test("D-08A blocks microphone capture, typed answers, and challenges before acknowledgment", async () => {
    const controller = intentController();
    let captureCalls = 0;
    const { container } = await mountIntents(controller, {
      createAudioCaptureSource: (async () => {
        captureCalls += 1;
        throw new Error("capture must not be constructed before acknowledgment");
      }) as LiveSessionPageDependencies["createAudioCaptureSource"],
    });

    await act(async () => {
      controller.push({
        activeResponseId: "response-1",
        currentSource: SOURCE,
        ready: LIVE_READY,
        sources: [SOURCE],
        status: "open",
      });
    });
    await settle();

    // A pointer gesture anywhere would previously have started capture.
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    await settle();
    expect(captureCalls).toBe(0);

    await act(async () => {
      openSourceFolio(container);
    });
    await settle();
    const challenge = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Challenge"),
    );
    expect(challenge?.disabled).toBe(true);
    await act(async () => {
      challenge?.click();
    });
    await settle();
    expect(controller.intents).toEqual([]);
    expect(controller.texts).toEqual([]);
  });

  test("acknowledgment is a boolean scoped to this session, restored on a same-tab refresh", async () => {
    const key = disclosureAcknowledgementKey({
      scope: "all_live_provider_content",
      studySetId: ROUTE_IDENTITY.studySetId,
      voiceSessionId: ROUTE_IDENTITY.sessionId,
    });
    window.sessionStorage.clear();

    const first = intentController();
    const firstMount = await mountIntents(first);
    await act(async () => {
      first.push({ ready: LIVE_READY, status: "open" });
    });
    await settle();
    const acknowledge = [...firstMount.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Acknowledge",
    );
    await act(async () => {
      acknowledge?.click();
    });
    await settle();

    expect(window.sessionStorage.getItem(key)).toBe("1");
    // Only a boolean: no token, no identity, no transcript, no audio.
    const stored = Object.entries({ ...window.sessionStorage })
      .map(([storedKey, value]) => `${storedKey}=${String(value)}`)
      .join(" ");
    expect(stored).not.toContain("viva1.");
    expect(stored).not.toContain(ROUTE_IDENTITY.userId);

    await act(async () => {
      firstMount.root.unmount();
    });

    const second = intentController();
    const secondMount = await mountIntents(second);
    await act(async () => {
      second.push({ ready: LIVE_READY, status: "open" });
    });
    await settle();
    expect(
      [...secondMount.container.querySelectorAll("button")].some(
        (button) => button.textContent === "Acknowledge",
      ),
    ).toBe(false);
  });

  test("another session's acknowledgment is never inherited", async () => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      disclosureAcknowledgementKey({
        scope: "all_live_provider_content",
        studySetId: "some-other-set",
        voiceSessionId: "some-other-session",
      }),
      "1",
    );

    const controller = intentController();
    const { container } = await mountIntents(controller);
    await act(async () => {
      controller.push({ ready: LIVE_READY, status: "open" });
    });
    await settle();

    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Acknowledge",
      ),
    ).toBe(true);
  });
});

/**
 * `WEBSESSION-READY-01` — the page is the SINGLE readiness poll owner.
 *
 * One in-flight probe, one armed timer, one abort controller. The next poll is
 * scheduled from the previous one's SETTLEMENT, so a probe slower than the five
 * second cadence can never be overlapped by its own successor, and going away
 * (unmount, projection failure, terminal recap) aborts the request rather than
 * letting it resolve into a dead component.
 */
describe("LiveSessionPage bounded readiness polling (WEBSESSION-READY-01)", () => {
  const OFFLINE_PROBE: VivaAgentReadinessProbe = {
    apiBaseUrl: "http://localhost:4318",
    error: "readiness endpoints did not answer within 4000 ms",
    status: "offline",
  };

  const OBSERVED_PROBE: VivaAgentReadinessProbe = {
    apiBaseUrl: "http://localhost:4318",
    health: {
      brain: { configured: true, live_runtime: false, provider: "synthetic", selectable: true },
      provider: "synthetic",
      status: "ok",
      store: {
        available: true,
        backend: "in_memory",
        durable: false,
        nonce_replay_protection: true,
        raw_audio_persistence: false,
        transcript_persistence: false,
        uuid_schema_translation: true,
      },
    },
    healthHttpStatus: 200,
    ready: {
      brain: { configured: true, live_runtime: false, provider: "synthetic", selectable: true },
      ready: true,
      store: {
        available: true,
        backend: "in_memory",
        durable: false,
        nonce_replay_protection: true,
        raw_audio_persistence: false,
        transcript_persistence: false,
        uuid_schema_translation: true,
      },
    },
    readyHttpStatus: 200,
    status: "observed",
  };

  type ReadinessRecord = {
    fetchReadiness: LiveSessionPageDependencies["fetchReadiness"];
    signals: Array<AbortSignal | null>;
    settle: (probe: VivaAgentReadinessProbe) => void;
    /** Probes that were started, including StrictMode's immediately-aborted one. */
    starts: () => number;
    /** Probes that are still live — the count an overlapping poll would raise. */
    live: () => number;
  };

  /** A probe the test settles by hand, so "no second poll yet" is provable. */
  function gatedReadiness(): ReadinessRecord {
    const signals: Array<AbortSignal | null> = [];
    type Waiter = { resolve: (probe: VivaAgentReadinessProbe) => void };
    const waiting: Waiter[] = [];
    return {
      fetchReadiness: (async (input?: { signal?: AbortSignal }) => {
        const signal = input?.signal ?? null;
        signals.push(signal);
        return await new Promise<VivaAgentReadinessProbe>((resolve) => {
          const waiter: Waiter = { resolve };
          waiting.push(waiter);
          signal?.addEventListener(
            "abort",
            () => {
              const index = waiting.indexOf(waiter);
              if (index >= 0) waiting.splice(index, 1);
              resolve(OFFLINE_PROBE);
            },
            { once: true },
          );
        });
      }) as LiveSessionPageDependencies["fetchReadiness"],
      live: () => waiting.length,
      settle: (probe) => {
        while (waiting.length > 0) waiting.shift()?.resolve(probe);
      },
      signals,
      starts: () => signals.length,
    };
  }

  /**
   * A faithful double for the real probe's own request boundary: an endpoint
   * that never answers becomes an `offline` FACT at the 4,000 ms deadline, and
   * an aborted probe resolves rather than hanging.
   */
  function deadlineReadiness(
    clock: FakeReconnectClock,
    probes: () => VivaAgentReadinessProbe,
  ): ReadinessRecord {
    const signals: Array<AbortSignal | null> = [];
    let inFlight = 0;
    return {
      fetchReadiness: (async (input?: { signal?: AbortSignal }) => {
        signals.push(input?.signal ?? null);
        inFlight += 1;
        const next = probes();
        return await new Promise<VivaAgentReadinessProbe>((resolve) => {
          const settle = (probe: VivaAgentReadinessProbe) => {
            inFlight -= 1;
            resolve(probe);
          };
          if (next.status === "observed") {
            settle(next);
            return;
          }
          const timer = clock.setTimeout(
            () => settle(next),
            VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS,
          );
          input?.signal?.addEventListener(
            "abort",
            () => {
              clock.clearTimeout(timer);
              settle(OFFLINE_PROBE);
            },
            { once: true },
          );
        });
      }) as LiveSessionPageDependencies["fetchReadiness"],
      live: () => inFlight,
      settle: () => {},
      signals,
      starts: () => signals.length,
    };
  }

  async function step(clock: FakeReconnectClock, ms = 0, rounds = 4) {
    for (let round = 0; round < rounds; round += 1) {
      await act(async () => {
        clock.advance(round === 0 ? ms : 0);
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 0);
        });
      });
    }
  }

  async function mountReadiness(
    clock: FakeReconnectClock,
    overrides: Partial<LiveSessionPageDependencies>,
  ) {
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    replaceBrowserSessionCredential(branchACredential());
    const controller = programmableController();
    const dependencies = testDependencies({
      createAgentController: controller.factory,
      reconnectClock: clock,
      renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      ...overrides,
    });
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await step(clock);
    return { container, controller, root };
  }

  /** The one element the bounded readiness count is allowed to live on. */
  function boundedReadinessElement(container: HTMLElement): Element | null {
    return container.querySelector("[data-consecutive-failures]");
  }

  test("never starts a second poll while the previous one is still settling", async () => {
    const clock = createFakeReconnectClock(0);
    const readiness = gatedReadiness();
    await mountReadiness(clock, { fetchReadiness: readiness.fetchReadiness });

    // Exactly ONE live probe: StrictMode's throwaway effect pass started one
    // too, and the committed pass aborted it rather than leaving two in flight.
    expect(readiness.live()).toBe(1);
    const started = readiness.starts();

    // The five-second wall-clock boundary passes with that probe still in
    // flight: an interval would have started a second one here.
    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS);
    expect(readiness.starts()).toBe(started);
    expect(readiness.live()).toBe(1);
    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS);
    expect(readiness.starts()).toBe(started);
    expect(readiness.live()).toBe(1);

    // Settlement is what arms the next start, a full interval later.
    await act(async () => {
      readiness.settle(OFFLINE_PROBE);
    });
    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS - 1);
    expect(readiness.starts()).toBe(started);
    await step(clock, 1);
    expect(readiness.starts()).toBe(started + 1);
    expect(readiness.live()).toBe(1);
  });

  test("unmount aborts the in-flight probe, leaves no timer, and updates nothing", async () => {
    const clock = createFakeReconnectClock(0);
    const readiness = gatedReadiness();
    const { container, root } = await mountReadiness(clock, {
      fetchReadiness: readiness.fetchReadiness,
    });

    expect(readiness.live()).toBe(1);
    const started = readiness.starts();

    await act(async () => {
      root.unmount();
    });
    // EVERY request this page started is aborted, and the loop owns no timer to
    // fire into a dead component.
    expect(readiness.signals.every((signal) => signal?.aborted === true)).toBe(true);
    expect(readiness.live()).toBe(0);
    expect(clock.pending()).toEqual([]);
    expect(container.innerHTML).toBe("");

    // A late answer to an aborted probe neither re-renders nor re-arms the loop.
    await act(async () => {
      readiness.settle(OFFLINE_PROBE);
    });
    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS * 3);
    expect(readiness.starts()).toBe(started);
    expect(container.innerHTML).toBe("");
  });

  test("three consecutive failed polls surface the bounded readiness state and reset on success", async () => {
    const clock = createFakeReconnectClock(0);
    let probe: VivaAgentReadinessProbe = OFFLINE_PROBE;
    const readiness = deadlineReadiness(clock, () => probe);
    const { container } = await mountReadiness(clock, {
      fetchReadiness: readiness.fetchReadiness,
    });

    const failures = () =>
      boundedReadinessElement(container)?.getAttribute("data-consecutive-failures") ?? null;

    // Poll 1 hits its own 4,000 ms deadline; the cadence stays 5,000 ms AFTER
    // that settlement, so each failed cycle costs 9,000 ms.
    const started = readiness.starts();
    await step(clock, VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS);
    expect(failures()).toBe(null);

    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS);
    expect(readiness.starts()).toBe(started + 1);
    await step(clock, VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS);
    expect(failures()).toBe(null);

    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS);
    expect(readiness.starts()).toBe(started + 2);
    await step(clock, VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS);
    expect(failures()).toBe("3");
    // The bounded state is a count on the READINESS STATUS ELEMENT — the ladder
    // that already states each readiness fact — not a page-owned paragraph
    // parked outside the landmark carrying whatever copy the ladder produced.
    const bounded = boundedReadinessElement(container);
    expect(bounded?.classList.contains("readiness-ladder")).toBe(true);
    expect(bounded?.getAttribute("aria-label")).toBe("Connected session readiness");
    expect(bounded?.closest("main")?.id).toBe("live-session-main");
    expect(container.querySelectorAll("main")).toHaveLength(1);

    // …and the copy beside it is the EXISTING sanitized readiness-unavailable
    // copy, stated in full rather than a generic "Agent unavailable" fragment.
    expect(container.textContent).toContain("Agent unavailable: service offline.");
    expect(bounded?.textContent).toContain("Could not reach /ready or /health/brain");
    // Not a new cadence and not a stopped loop.
    expect(readiness.live()).toBe(0);

    probe = OBSERVED_PROBE;
    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS);
    expect(readiness.starts()).toBe(started + 3);
    expect(failures()).toBe(null);
  });

  test("a live ready frame clears the bounded state instead of freezing a stale count", async () => {
    const clock = createFakeReconnectClock(0);
    const readiness = deadlineReadiness(clock, () => OFFLINE_PROBE);
    const { container, controller } = await mountReadiness(clock, {
      fetchReadiness: readiness.fetchReadiness,
    });

    const failures = () =>
      boundedReadinessElement(container)?.getAttribute("data-consecutive-failures") ?? null;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await step(clock, VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS);
      if (cycle < 2) await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS);
    }
    expect(failures()).toBe("3");

    // The socket's own ready frame is authoritative, so the poll owner stops —
    // and a torn-down loop must not leave its last failure count frozen on a
    // healthy session, describing an agent that is demonstrably answering.
    const startedBeforeReady = readiness.starts();
    await act(async () => {
      controller.push({ ready: READY_FRAME, status: "open" });
    });
    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS * 3);

    expect(failures()).toBe(null);
    expect(readiness.starts()).toBe(startedBeforeReady);
    expect(container.textContent).not.toContain("Agent unavailable");
  });

  test("a failed projection stops the readiness loop instead of polling a dead page", async () => {
    const clock = createFakeReconnectClock(0);
    const readiness = gatedReadiness();
    await mountReadiness(clock, {
      fetchReadiness: readiness.fetchReadiness,
      fetchStudyProjection: (async () => ({
        cause: "unavailable",
        status: "failed",
      })) as LiveSessionPageDependencies["fetchStudyProjection"],
    });

    const started = readiness.starts();
    expect(readiness.live()).toBe(0);
    expect(readiness.signals.every((signal) => signal?.aborted === true)).toBe(true);

    await act(async () => {
      readiness.settle(OFFLINE_PROBE);
    });
    await step(clock, VIVA_AGENT_READINESS_POLL_INTERVAL_MS * 3);
    expect(readiness.starts()).toBe(started);
  });
});

/**
 * `WEBSESSION-TERMINAL-01` / `WEBSESSION-A11Y-01` / `WEBSESSION-A11Y-02`.
 *
 * The mounted route, not a fragment of it: one landmark, one keyboard entrance to
 * the turn stage, an explicit transcript disclosure the page owns, and a terminal
 * recap that stops the machinery while leaving the recap on screen.
 */
describe("LiveSessionPage terminal recap, landmarks, and transcript (WEBSESSION-TERMINAL-01)", () => {
  type PlaybackRecord = {
    factory: LiveSessionPageDependencies["createAudioPlaybackSink"];
    cancels: Array<string | null | undefined>;
    closes: number;
    enqueued: string[];
    resets: number;
  };

  function recordingPlayback(): PlaybackRecord {
    const record: PlaybackRecord = {
      cancels: [],
      closes: 0,
      enqueued: [],
      factory: (() => ({
        cancel: (responseId?: string | null) => {
          record.cancels.push(responseId);
        },
        close: async () => {
          record.closes += 1;
        },
        enqueue: (input: { responseId: string }) => {
          record.enqueued.push(input.responseId);
        },
        getOutputLevel: () => 0,
        getState: () => ({}),
        resetForGeneration: () => {
          record.resets += 1;
        },
        unlock: async () => ({}),
      })) as unknown as LiveSessionPageDependencies["createAudioPlaybackSink"],
      resets: 0,
    };
    return record;
  }

  const COMPLETE_RECAP = {
    concepts: [{ concept_id: "enthalpy", label: "Enthalpy", status: "strong" }],
    deferred_turns: 0,
    headline: "You held the state-function argument.",
    next_action: "Review the Gibbs derivation before the oral final.",
    review_schedule: [
      {
        authority: "server_persisted_fsrs",
        concept_id: "enthalpy",
        due_at: "2026-09-01T00:00:00Z",
      },
    ],
    schema: "viva.study_session_recap.v2",
    source_moments: [],
    summary: "The recap and review plan are saved.",
    voice_session_id: ROUTE_IDENTITY.sessionId,
  } as unknown as NonNullable<VivaAgentSessionState["recap"]>["recap"];

  const COMPLETE_RECAP_STATE = {
    kind: "complete",
    recap: COMPLETE_RECAP,
  } as unknown as VivaAgentSessionState["recap"];

  async function step(clock: FakeReconnectClock, ms = 0, rounds = 4) {
    for (let round = 0; round < rounds; round += 1) {
      await act(async () => {
        clock.advance(round === 0 ? ms : 0);
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 0);
        });
      });
    }
  }

  async function mountSession(
    controller: ProgrammableController,
    clock: FakeReconnectClock,
    overrides: Partial<LiveSessionPageDependencies> = {},
  ) {
    const container = mountContainer();
    const root = trackRoot(createRoot(container));
    replaceBrowserSessionCredential(branchACredential());
    const dependencies = testDependencies({
      createAgentController: controller.factory,
      reconnectClock: clock,
      renewCredential: async ({ credential }) => ({ credential, status: "renewed" }),
      ...overrides,
    });
    await act(async () => {
      root.render(
        <StrictMode>
          <LiveSessionPage dependencies={dependencies} />
        </StrictMode>,
      );
    });
    await step(clock);
    return { container, root };
  }

  function transcriptToggle(container: HTMLElement): HTMLButtonElement {
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      /transcript/i.test(button.textContent ?? ""),
    );
    if (!toggle) throw new Error("no transcript disclosure button");
    return toggle as HTMLButtonElement;
  }

  test("renders exactly one main landmark and one skip link into the turn stage", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const { container } = await mountSession(controller, clock);

    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelector("main")?.id).toBe("live-session-main");

    const skip = [...container.querySelectorAll("a")].filter(
      (link) => link.textContent?.trim() === "Skip to current question and answer",
    );
    expect(skip).toHaveLength(1);
    expect(skip[0]?.getAttribute("href")).toBe("#live-session-turn");

    const turn = container.querySelector("#live-session-turn");
    expect(turn).not.toBe(null);
    expect(turn?.getAttribute("tabindex")).toBe("-1");

    // Still exactly one main once the session has closed on its recap.
    await act(async () => {
      controller.push({ recap: COMPLETE_RECAP_STATE, ready: READY_FRAME, status: "open" });
    });
    await step(clock);
    expect(container.querySelectorAll("main")).toHaveLength(1);
  });

  test("the skip link is hidden until focused and moves focus to the turn stage", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const { container } = await mountSession(controller, clock);

    const skip = container.querySelector<HTMLAnchorElement>("a[href='#live-session-turn']");
    if (!skip) throw new Error("no skip link");

    // `.sr-only` is Plan 13's visually-hidden utility; carrying it is what keeps
    // the link out of the visual design until a keyboard reaches it.
    expect(skip.classList.contains("sr-only")).toBe(true);

    await act(async () => {
      skip.focus();
    });
    expect(document.activeElement === skip).toBe(true);
    expect(skip.classList.contains("sr-only")).toBe(false);

    await act(async () => {
      skip.click();
    });
    // Identity by id rather than by element, so a FAILING run reports the id it
    // found instead of trying to serialize the whole document graph.
    expect(document.activeElement?.id).toBe("live-session-turn");
    expect(document.activeElement?.className).toContain("live-session__stage");

    await act(async () => {
      skip.blur();
    });
    expect(skip.classList.contains("sr-only")).toBe(true);
  });

  test("the transcript disclosure is an explicit toggle the page owns", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const { container } = await mountSession(controller, clock);

    await act(async () => {
      controller.push({
        ready: READY_FRAME,
        status: "open",
        transcript: "NADH donates electrons.",
      });
    });
    await step(clock);

    const toggle = transcriptToggle(container);
    // A native button is what makes Enter and Space activate this control at all;
    // a `<details>`/`<summary>` or a div would not carry that guarantee.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.textContent).toContain("Show transcript");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    const regionId = toggle.getAttribute("aria-controls");
    expect(regionId).toBe("live-session-transcript");
    const region = container.querySelector(`#${regionId}`);
    expect(region).not.toBe(null);
    expect(region?.hasAttribute("hidden")).toBe(true);

    await act(async () => {
      toggle.focus();
      toggle.click();
    });

    expect(transcriptToggle(container).textContent).toContain("Hide transcript");
    expect(transcriptToggle(container).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(`#${regionId}`)?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(`#${regionId}`)?.textContent).toContain(
      "NADH donates electrons.",
    );

    await act(async () => {
      transcriptToggle(container).click();
    });
    expect(transcriptToggle(container).getAttribute("aria-expanded")).toBe("false");
    // Focus stays on the control that was activated, never lost to the document.
    expect(document.activeElement === transcriptToggle(container)).toBe(true);
  });

  test("a complete recap leaves only the approved next-session action", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const captures: number[] = [];
    const { container } = await mountSession(controller, clock, {
      createAudioCaptureSource: (async () => {
        captures.push(1);
        throw new Error("capture must not start after a recap");
      }) as LiveSessionPageDependencies["createAudioCaptureSource"],
      createAudioPlaybackSink: recordingPlayback().factory,
    });

    await act(async () => {
      controller.push({ ready: READY_FRAME, status: "open" });
    });
    await step(clock);
    // Acknowledging the disclosure is the gesture that lets capture be attempted
    // at all; the microphone then resolves as unavailable in this DOM, so the
    // typed-answer surface is required and present BEFORE the recap.
    const acknowledge = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Acknowledge",
    );
    await act(async () => {
      acknowledge?.click();
    });
    await step(clock);
    expect(container.querySelector("textarea")).not.toBe(null);
    // Before the recap the session offers no next-session action.
    expect(container.textContent).not.toContain("Start a new session");

    await act(async () => {
      controller.push({ recap: COMPLETE_RECAP_STATE, ready: READY_FRAME, status: "open" });
    });
    await step(clock);

    // The answer form is gone with the turn loop it belonged to…
    expect(container.querySelector("textarea")).toBe(null);
    // …no later gesture can reopen the microphone…
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      container.querySelector("button")?.click();
    });
    expect(captures).toEqual([]);
    // …and the only session-level action offered is the approved next session.
    expect(container.textContent).toContain("Start a new session");
  });

  test("a partial recap keeps its terminal reason and still ends the turn loop", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const { container } = await mountSession(controller, clock);

    await act(async () => {
      controller.push({
        close: { code: 1006, wasClean: false },
        recap: {
          kind: "partial",
          partialReason: "provider_timeout",
          recap: COMPLETE_RECAP,
        } as unknown as VivaAgentSessionState["recap"],
        status: "closed",
        termination: { closeCode: 1006, kind: "transport", retryable: true },
      });
    });
    await step(clock);

    // The terminal reason the SERVER named is what the learner reads — never
    // recovery copy over a session that is not coming back.
    expect(container.textContent).toContain("Provider timeout");
    expect(container.textContent).not.toContain("Reconnecting");
    expect(container.textContent).not.toContain("Connection lost");
    // The partial recap itself is still on screen, and the turn loop is over.
    expect(container.textContent).toContain("Closing fold");
    expect(container.querySelector("textarea")).toBe(null);
    expect(clock.pending()).toEqual([]);
  });

  test("a recap mid-recovery aborts the attempt instead of opening a new generation", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    let releaseRenewal: (() => void) | undefined;
    const renewalGate = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    let renewals = 0;
    await mountSession(controller, clock, {
      createAudioPlaybackSink: recordingPlayback().factory,
      renewCredential: async ({ credential }) => {
        renewals += 1;
        // The ENTRY renewal must settle so the page can bootstrap; only the
        // recovery renewal is held open.
        if (renewals > 1) await renewalGate;
        return { credential, status: "renewed" };
      },
    });

    // An unclean close arms the bounded recovery loop…
    await act(async () => {
      controller.push({
        close: { code: 1006, wasClean: false },
        status: "closed",
        termination: { closeCode: 1006, kind: "transport", retryable: true },
      });
    });
    await step(clock);
    // …and its first attempt starts, blocking on the credential renewal.
    await step(clock, 600);
    expect(renewals).toBeGreaterThan(1);
    const generationsBefore = controller.connects.length;

    // The recap lands while that renewal is still in flight. The SAME
    // termination object is retained, so nothing but the terminal effect itself
    // can stop the attempt.
    await act(async () => {
      controller.push({ recap: COMPLETE_RECAP_STATE });
    });
    await step(clock);
    await act(async () => {
      releaseRenewal?.();
    });
    await step(clock, 10_000);

    // No replacement generation was opened for a session that has ended.
    expect(controller.connects).toHaveLength(generationsBefore);
    expect(clock.pending()).toEqual([]);
  });

  test("a terminal recap closes the transcript, stops the machinery, and stays on screen", async () => {
    const controller = programmableController();
    const clock = createFakeReconnectClock(0);
    const playback = recordingPlayback();
    const { container } = await mountSession(controller, clock, {
      createAudioPlaybackSink: playback.factory,
    });

    await act(async () => {
      controller.push({
        audio: [{ frame: { pcm16_base64: "AAA=" }, responseId: "response-1" }],
        ready: READY_FRAME,
        status: "open",
        transcript: "NADH donates electrons.",
      } as unknown as Partial<VivaAgentSessionState>);
    });
    await step(clock);
    expect(playback.enqueued).toEqual(["response-1"]);

    await act(async () => {
      transcriptToggle(container).click();
    });
    expect(transcriptToggle(container).getAttribute("aria-expanded")).toBe("true");

    // An unclean close arms the bounded recovery loop first…
    await act(async () => {
      controller.push({
        close: { code: 1006, wasClean: false },
        status: "closed",
        termination: { closeCode: 1006, kind: "transport", retryable: true },
      });
    });
    await step(clock);
    expect(clock.pending().length).toBeGreaterThan(0);

    // …and then the recap lands, together with the terminal phase a deploy
    // drain sends right behind it.
    await act(async () => {
      controller.push({
        close: { code: 1001, wasClean: true },
        recap: COMPLETE_RECAP_STATE,
        status: "closed",
        terminalReason: "drained",
      });
    });
    await step(clock);

    // The recap is the session's last word: success copy, not a disconnect and
    // not the drain the transport happened to report after it.
    expect(container.textContent).toContain("Session complete");
    expect(container.textContent).not.toContain("Session drained");
    expect(container.textContent).toContain("You held the state-function argument.");
    expect(container.textContent).not.toContain("Retry agent");
    expect(container.textContent).not.toContain("Reconnecting");
    // …and the transcript disclosure is closed deterministically by the page.
    expect(transcriptToggle(container).getAttribute("aria-expanded")).toBe("false");
    // …playback is cancelled rather than left speaking over the recap.
    expect(playback.cancels).toContain(null);
    // …and no recovery timer survives the terminal state.
    expect(clock.pending()).toEqual([]);
  });
});
