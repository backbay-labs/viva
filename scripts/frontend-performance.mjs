import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchChromium, repoRoot, withFrontendDevServer } from "./frontend-harness.mjs";

/**
 * `scripts/frontend-performance.mjs` — mounts the real Next.js app through
 * `scripts/frontend-harness.mjs` and enforces `FRONTEND-008`/`FRONTEND-009`'s
 * visual-performance contract.
 *
 * Task 10 lands exactly one mode, `--policy-only`: mounted policy
 * data-attribute assertions for the landing `MuseGlyphCanvas` and the
 * `VisualEffectsControl` toggle, run against the dev server. It proves the
 * shared `viva-effects` resolver (unchanged since Task 0) is actually
 * gathered from and applied to real browser/DOM state — no production
 * build, no CPU throttling, no perf-budget sampling. Task 11 completes the
 * full production-mode sampling contract.
 *
 * `--policy-only` deliberately does not mount `/session`: reaching a real
 * `LiveSessionShell` render (rather than its "Preparing your session…"
 * waiting state) requires a live agent-service connection, which
 * `frontend-harness.mjs` does not yet provide before Task 11's "real
 * synthetic Rust agent-service" work lands. The session-side claim this
 * mode still owns — that `session_muse` and Plan 10's `voice_trace` can
 * never both resolve to `animated` — is proven directly against the shared
 * resolver in `apps/web/lib/viva-effects.test.ts` instead (see
 * "session_muse never animates beside a live voice_trace canvas" there),
 * which is one of this task's own RED/GREEN commands. Task 11's full
 * production-sampling mode reasserts "simultaneously animated canvases on
 * /session <= 1" against the real, agent-connected DOM.
 *
 * Likewise, of the four required outcomes in Task 10's policy-integration
 * table, `--policy-only` exercises default/low-end/prefers-reduced-motion
 * and the explicit-preference toggle/reload path against the real browser;
 * `prefers-reduced-transparency` alone forcing the static policy is not
 * separately re-proven here because Playwright's `page.emulateMedia` has no
 * named option for that media feature (only `colorScheme`/`reducedMotion`/
 * `forcedColors`/`contrast`) — it is exhaustively covered, including its
 * precedence against every other signal, by the mounted
 * `viva-effects.test.ts` suite's fake per-query `matchMedia`.
 */

const GLYPHS_READY_SELECTOR = ".viva-glyphs[data-render-mode]";
const TOGGLE_NAME = "Reduce visual effects";
const RESTORE_NAME = "Use system visual effects";

/**
 * `withFrontendDevServer` hands back a `http://127.0.0.1:<port>` `baseUrl`.
 * Next.js dev's cross-origin dev-resource protection does not recognize a
 * bare `127.0.0.1` as the same origin as the `next dev` child's own bind
 * address, which blocks the HMR websocket handshake and — empirically —
 * leaves the page fully server-rendered but never client-hydrated (no React
 * root ever attaches; every policy data attribute and the toggle button
 * depend on client effects). Mirrors `frontend-accessibility.mjs`'s own
 * `toHydratableUrl`, which fixed the identical issue there without touching
 * `scripts/frontend-harness.mjs` (not owned by that task either).
 *
 * @param {string} baseUrl
 */
function toHydratableUrl(baseUrl) {
  return baseUrl.replace("127.0.0.1", "localhost");
}

async function gotoLandingReady(page, baseUrl) {
  await page.goto(toHydratableUrl(baseUrl), { waitUntil: "networkidle", timeout: 120_000 });
  await page.waitForSelector(".viva-hero", { state: "attached", timeout: 30_000 });
  await page.waitForSelector(GLYPHS_READY_SELECTOR, { state: "attached", timeout: 15_000 });
}

/** @param {import("playwright").Page} page */
async function glyphAttributes(page) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    return {
      dprCap: el.getAttribute("data-dpr-cap"),
      fpsBudget: el.getAttribute("data-fps-budget"),
      glyphScale: el.getAttribute("data-glyph-scale"),
      renderMode: el.getAttribute("data-render-mode"),
      vivaEffects: el.getAttribute("data-viva-effects"),
    };
  }, ".viva-glyphs");
}

/**
 * @param {string[]} failures
 * @param {string} label
 * @param {Record<string, string | null> | null} actual
 * @param {Record<string, string>} expected
 */
function expectAttrs(failures, label, actual, expected) {
  if (!actual) {
    failures.push(`[${label}] .viva-glyphs never rendered its policy data attributes`);
    return;
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      failures.push(
        `[${label}] expected ${key}=${value}, got ${actual[key]} (full: ${JSON.stringify(actual)})`,
      );
    }
  }
}

async function runPolicyOnlyCheck() {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-performance");
  mkdirSync(artifactDir, { recursive: true });
  const failures = [];
  await withFrontendDevServer({ artifactDir }, async ({ baseUrl }) => {
    const browser = await launchChromium();
    try {
      // 1. Default desktop landing_muse: DPR cap 2, 32fps, glyph scale 1.
      {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();
        try {
          await gotoLandingReady(page, baseUrl);
          expectAttrs(failures, "default desktop", await glyphAttributes(page), {
            dprCap: "2",
            fpsBudget: "32",
            glyphScale: "1",
            renderMode: "animated",
            vivaEffects: "full",
          });
        } finally {
          await context.close();
        }
      }

      // 2. Low-end hardwareConcurrency: DPR cap 1.5, 24fps, glyph scale 0.5,
      // still animated (`reduced` is not `static`).
      {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        await context.addInitScript(() => {
          Object.defineProperty(window.navigator, "hardwareConcurrency", {
            configurable: true,
            value: 4,
          });
        });
        const page = await context.newPage();
        try {
          await gotoLandingReady(page, baseUrl);
          expectAttrs(failures, "low-end hardwareConcurrency", await glyphAttributes(page), {
            dprCap: "1.5",
            fpsBudget: "24",
            glyphScale: "0.5",
            renderMode: "animated",
            vivaEffects: "reduced",
          });
        } finally {
          await context.close();
        }
      }

      // 3. prefers-reduced-motion: one static frame, no continuous rAF budget.
      {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();
        try {
          await page.emulateMedia({ reducedMotion: "reduce" });
          await gotoLandingReady(page, baseUrl);
          expectAttrs(failures, "prefers-reduced-motion", await glyphAttributes(page), {
            dprCap: "1.5",
            fpsBudget: "0",
            glyphScale: "0.5",
            renderMode: "static",
            vivaEffects: "static",
          });
        } finally {
          await context.close();
        }
      }

      // 4. Toggle interaction, root data-attribute, and reload persistence.
      {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();
        try {
          await gotoLandingReady(page, baseUrl);
          const before = await glyphAttributes(page);
          if (before?.renderMode !== "animated") {
            failures.push(
              `[toggle] expected the pre-toggle canvas to be animated, got ${before?.renderMode}`,
            );
          }

          await page.getByRole("button", { name: TOGGLE_NAME, exact: true }).click();
          const rootAttrAfterToggle = await page.evaluate(
            () => document.documentElement.dataset.vivaEffects,
          );
          if (rootAttrAfterToggle !== "reduced") {
            failures.push(
              `[toggle] expected html[data-viva-effects="reduced"] without reload, got ` +
                `${rootAttrAfterToggle}`,
            );
          }
          expectAttrs(failures, "toggle", await glyphAttributes(page), {
            dprCap: "1.5",
            fpsBudget: "0",
            renderMode: "static",
          });
          const restoreVisible = await page
            .getByRole("button", { name: RESTORE_NAME, exact: true })
            .isVisible();
          if (!restoreVisible) {
            failures.push(`[toggle] control label did not change to "${RESTORE_NAME}"`);
          }

          await page.reload({ waitUntil: "networkidle" });
          await page.waitForSelector(GLYPHS_READY_SELECTOR, { timeout: 15_000 });
          expectAttrs(failures, "reload persistence", await glyphAttributes(page), {
            renderMode: "static",
          });
          const restoreVisibleAfterReload = await page
            .getByRole("button", { name: RESTORE_NAME, exact: true })
            .isVisible();
          if (!restoreVisibleAfterReload) {
            failures.push(
              `[reload persistence] readVivaEffectsPreference did not restore the ` +
                `"${RESTORE_NAME}" label/static render after reload`,
            );
          }

          // Clearing the value removes the root attribute and dispatches the
          // same change event (observed here as the landing canvas returning
          // to `animated`, since no system reduced-motion signal is active).
          await page.getByRole("button", { name: RESTORE_NAME, exact: true }).click();
          const rootAttrAfterClear = await page.evaluate(
            () => document.documentElement.dataset.vivaEffects,
          );
          if (rootAttrAfterClear !== undefined) {
            failures.push(
              `[toggle] clearing the preference left html[data-viva-effects]=${rootAttrAfterClear}`,
            );
          }
          expectAttrs(failures, "cleared preference", await glyphAttributes(page), {
            renderMode: "animated",
          });
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  });
  return failures;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--policy-only")) {
    const failures = await runPolicyOnlyCheck();
    if (failures.length > 0) {
      console.error(`--policy-only FAILED: ${failures.length} issue(s)`);
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log("--policy-only OK: 0 issues");
    return;
  }

  fail(
    "no recognized mode flag. Supported so far: --policy-only. Task 11 adds the full " +
      "production-build, CPU-throttled sampling mode (the bare invocation with no flag).",
  );
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

await main();
