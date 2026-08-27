import { afterAll, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * The one mounted-test DOM for `@viva/web`.
 *
 * Imported as the FIRST dependency of a mounted suite so the suite's whole
 * lifecycle — install, per-test reset, teardown — is declared before any of its
 * own hooks, and so a root-invoked `bun test apps/web/...` and a
 * workspace-invoked `bun run --cwd apps/web test` install exactly the same
 * environment regardless of Bun's current working directory.
 *
 * The DOM is installed in `beforeAll` and removed in `afterAll` rather than at
 * import time. Bun shares one global object across the whole run and loads every
 * matched test file before running any of them, so an import-time registration
 * would leak a live `window`/`document` into suites that must run WITHOUT one —
 * server-render assertions, and `LandingEntry.test.tsx`'s own per-test
 * `GlobalRegistrator.register()`, which throws on an already-registered DOM.
 * File-scoped hooks keep each mounted suite's DOM to that suite.
 */
export const VIVA_TEST_DOM_ORIGIN = "https://viva.test";

export const VIVA_TEST_DOM_DEFAULT_URL = `${VIVA_TEST_DOM_ORIGIN}/session`;

type VivaTestDomHost = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

/** Registers the shared DOM if this process does not already have one. */
export function installVivaTestDom(url: string = VIVA_TEST_DOM_DEFAULT_URL): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ height: 800, url, width: 1280 });
  }
  // React 19 refuses to run `act` without this flag and warns on every update
  // applied outside one; setting it is what makes an un-acted update a test
  // failure rather than a silently swallowed race.
  (globalThis as VivaTestDomHost).IS_REACT_ACT_ENVIRONMENT = true;
}

/** Tears the shared DOM down so a later non-DOM suite starts clean. */
export async function uninstallVivaTestDom(): Promise<void> {
  (globalThis as VivaTestDomHost).IS_REACT_ACT_ENVIRONMENT = false;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
}

/**
 * Returns the DOM to the state a fresh test expects: empty body, canonical
 * location with no leftover query/fragment, empty history state, and empty
 * per-tab storage. Credentials never reach storage in production either — this
 * clears it so a test that wrongly wrote one cannot pass on the next test's
 * leftovers.
 */
export function resetVivaTestDom(url: string = VIVA_TEST_DOM_DEFAULT_URL): void {
  if (typeof document === "undefined") return;
  document.body.replaceChildren();
  window.history.replaceState(null, "", url);
  window.sessionStorage.clear();
  window.localStorage.clear();
}

/** Points the shared DOM at `url` without leaving a history entry behind. */
export function setVivaTestDomLocation(url: string): void {
  window.history.replaceState(null, "", url);
}

beforeAll(() => {
  installVivaTestDom();
});

afterEach(() => {
  resetVivaTestDom();
});

afterAll(async () => {
  await uninstallVivaTestDom();
});
