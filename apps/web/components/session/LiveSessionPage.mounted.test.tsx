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
  type VivaAgentReadinessProbe,
  type VivaAgentRetainedAudioTurn,
  type VivaAgentSessionController,
  type VivaAgentSessionControllerOptions,
  type VivaAgentSessionState,
} from "../../lib/viva-agent-client";
import { LiveSessionPage, type LiveSessionPageDependencies } from "./LiveSessionPage";

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
