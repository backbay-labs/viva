// The DOM must exist before React (or anything that reads `window` at import
// time) is loaded, so this stays the FIRST import in the file.
import "../../test/setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  initialVivaAgentSessionState,
  type VivaAgentReadinessProbe,
  type VivaAgentSessionController,
  type VivaAgentSessionControllerOptions,
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
