import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { VivaClientRenderErrorReport } from "../lib/viva-client-error-reporting";
import AppError from "./error";

const HOSTILE_STATE_SENTINEL = "HOSTILE_STATE_SENTINEL";
const HOSTILE_BEARER = "Bearer HOSTILE_BEARER";
const HOSTILE_URL =
  "https://evil.invalid/?session_token=viva1.hostile#state=HOSTILE_STATE_SENTINEL";
const HOSTILE_STRINGS = [
  HOSTILE_STATE_SENTINEL,
  HOSTILE_BEARER,
  HOSTILE_URL,
  "viva1.hostile",
  "session_token",
  "render failed near",
  "caused by",
];

/**
 * Mirrors `LandingEntry.test.tsx`'s mounted-DOM idiom for this repo's real
 * (non-`@testing-library`) happy-dom setup: a synthetic `Error` whose
 * `message`, `stack`, and `cause` are all built from `HOSTILE_STRINGS`, so a
 * checker that only sanitized *one* of those fields would still leak
 * through the others.
 */
function hostileError(digest: string | undefined): Error & { digest?: string } {
  const error = new Error(
    `render failed near ${HOSTILE_URL} with ${HOSTILE_BEARER} state=${HOSTILE_STATE_SENTINEL}`,
  ) as Error & { digest?: string };
  error.stack = `Error: ${HOSTILE_STATE_SENTINEL}\n    at ${HOSTILE_URL}\n    at Object.<anonymous>`;
  error.cause = new Error(`caused by ${HOSTILE_BEARER} ${HOSTILE_STATE_SENTINEL}`);
  if (digest !== undefined) error.digest = digest;
  return error;
}

/** Every `console.error` call recorded while `run` is executing, restored after. */
async function withCapturedConsoleError<T>(run: () => Promise<T>): Promise<{
  result: T;
  calls: unknown[][];
}> {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const result = await run();
    return { result, calls };
  } finally {
    console.error = original;
  }
}

function reportCallsAmong(calls: unknown[][]): VivaClientRenderErrorReport[] {
  return calls
    .filter(
      (args): args is [VivaClientRenderErrorReport] =>
        args.length === 1 &&
        typeof args[0] === "object" &&
        args[0] !== null &&
        (args[0] as { event?: unknown }).event === "viva_client_render_error",
    )
    .map((args) => args[0]);
}

async function waitForCondition(check: () => boolean, maxIterations = 50): Promise<void> {
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("AppError (FRONTEND-012, happy-dom, Strict Mode)", () => {
  test("renders generic recovery copy and a validated reference, with no hostile data anywhere and exactly one sanitized report", async () => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let container: HTMLDivElement | null = null;
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const error = hostileError("SAFE_REF_42");
      const resetCalls: number[] = [];

      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      const mountedContainer = container;

      const { calls: mountCalls } = await withCapturedConsoleError(() =>
        act(async () => {
          root?.render(
            <StrictMode>
              <AppError error={error} reset={() => resetCalls.push(1)} />
            </StrictMode>,
          );
        }),
      );

      // 1. generic recovery copy, the validated reference, and the one
      // "Try again" button using the shared primary-button class (whose
      // resolved 44x44 CSS px target is proven statically by
      // `scripts/frontend-quality.test.mjs`'s `checkTargetSize`, since this
      // boundary never mounts through the normal Playwright navigation
      // flow `scripts/frontend-accessibility.mjs` drives).
      expect(mountedContainer.textContent).not.toContain(HOSTILE_STATE_SENTINEL);
      expect(mountedContainer.textContent).toContain("Reference: SAFE_REF_42");
      const button = mountedContainer.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("expected a real Try again button in the mounted DOM");
      }
      expect(button.textContent?.trim()).toBe("Try again");
      expect(button.className).toBe("button button-primary");

      // 2. no hostile message/stack/cause/URL/bearer/state text anywhere in
      // the rendered DOM or in whatever this mount logged.
      const domSnapshot = mountedContainer.innerHTML;
      const loggedSnapshot = JSON.stringify(mountCalls);
      for (const hostile of HOSTILE_STRINGS) {
        expect(domSnapshot).not.toContain(hostile);
        expect(loggedSnapshot).not.toContain(hostile);
      }

      // 3. the default sink (console.error) received exactly one
      // structured report, even across Strict Mode's mount/cleanup/remount
      // effect replay.
      expect(reportCallsAmong(mountCalls)).toEqual([
        { event: "viva_client_render_error", reference: "SAFE_REF_42" },
      ]);

      // A rerender against the *same* error object must not add a second
      // report.
      const { calls: rerenderCalls } = await withCapturedConsoleError(() =>
        act(async () => {
          root?.render(
            <StrictMode>
              <AppError error={error} reset={() => resetCalls.push(1)} />
            </StrictMode>,
          );
        }),
      );
      expect(reportCallsAmong(rerenderCalls)).toEqual([]);

      // 4. a new Error object produces exactly one new report.
      const secondError = hostileError("SAFE_REF_43");
      const { calls: secondErrorCalls } = await withCapturedConsoleError(() =>
        act(async () => {
          root?.render(
            <StrictMode>
              <AppError error={secondError} reset={() => resetCalls.push(1)} />
            </StrictMode>,
          );
        }),
      );
      expect(reportCallsAmong(secondErrorCalls)).toEqual([
        { event: "viva_client_render_error", reference: "SAFE_REF_43" },
      ]);
      expect(mountedContainer.textContent).toContain("Reference: SAFE_REF_43");
      const domSnapshotAfterSecondError = mountedContainer.innerHTML;
      for (const hostile of HOSTILE_STRINGS) {
        expect(domSnapshotAfterSecondError).not.toContain(hostile);
      }

      // 5. activating "Try again" invokes reset exactly once and preserves
      // keyboard focus while pending.
      const retryButton = mountedContainer.querySelector("button");
      if (!(retryButton instanceof HTMLElement)) {
        throw new Error("expected the Try again button to still be mounted");
      }
      retryButton.focus();
      expect(document.activeElement).toBe(retryButton);
      await act(async () => {
        retryButton.click();
        await waitForCondition(() => resetCalls.length > 0);
      });
      expect(resetCalls).toEqual([1]);
      expect(document.activeElement).toBe(retryButton);
      await act(async () => {
        retryButton.click();
      });
      expect(resetCalls).toEqual([1]);
    } finally {
      if (root) {
        act(() => {
          root?.unmount();
        });
      }
      container?.remove();
      await GlobalRegistrator.unregister();
    }
  });

  test("a malformed digest renders no reference and reports reference: null", async () => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let container: HTMLDivElement | null = null;
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const error = hostileError("not-a-safe-ref!!");

      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      const mountedContainer = container;

      const { calls } = await withCapturedConsoleError(() =>
        act(async () => {
          root?.render(<AppError error={error} reset={() => {}} />);
        }),
      );

      expect(mountedContainer.textContent).not.toContain("Reference:");
      expect(reportCallsAmong(calls)).toEqual([
        { event: "viva_client_render_error", reference: null },
      ]);
    } finally {
      if (root) {
        act(() => {
          root?.unmount();
        });
      }
      container?.remove();
      await GlobalRegistrator.unregister();
    }
  });
});
