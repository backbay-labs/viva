import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchChromium,
  repoRoot,
  routeSyntheticSessionProjection,
  setCpuThrottlingRate,
  startSyntheticAgent,
  syntheticSessionUrl,
  withFrontendDevServer,
  withFrontendProductionServer,
} from "./frontend-harness.mjs";

/**
 * `scripts/frontend-performance.mjs` — mounts the real Next.js app through
 * `scripts/frontend-harness.mjs` and enforces `FRONTEND-008`/`FRONTEND-009`'s
 * visual-performance contract.
 *
 * Task 10 landed exactly one mode, `--policy-only`: mounted policy
 * data-attribute assertions for the landing `MuseGlyphCanvas` and the
 * `VisualEffectsControl` toggle, run against the dev server — no
 * production build, no CPU throttling, no perf-budget sampling.
 *
 * `--policy-only` deliberately does not mount `/session`: reaching a real
 * `LiveSessionShell` render (rather than its "Preparing your session…"
 * waiting state) requires a live agent-service connection, which
 * `frontend-harness.mjs` did not yet provide when Task 10 landed. Task 11
 * completes this file with the full production-mode sampling contract
 * (the bare invocation, no flag), landing on a real `/session` — now
 * reachable via `startSyntheticAgent`/`routeSyntheticSessionProjection` —
 * to reassert "simultaneously animated canvases on /session <= 1" against
 * the real, agent-connected DOM. See `frontend-harness.mjs`'s doc comments
 * for why that is the one same-origin call this harness intercepts, and
 * why every other signed capability in this app is unreachable from a
 * database-free agent.
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
 *
 * The bare mode (Task 11, `FRONTEND-009`):
 *
 * - refuses dev mode by construction — `withFrontendProductionServer`
 *   throws if `.next/BUILD_ID` is missing, so a caller must run
 *   `bun run --cwd apps/web build` first;
 * - samples `/` and a real, agent-connected `/session` at 375x667,
 *   device scale factor 3, `navigator.hardwareConcurrency` overridden to
 *   4 (via `context.addInitScript`, before any app code runs) and CDP
 *   `Emulation.setCPUThrottlingRate` at 4x;
 * - asserts each scenario's primary animating canvas already reports the
 *   `reduced` policy (DPR cap 1.5, 24fps) before sampling begins — proof
 *   the low-end emulation actually took effect, not merely a desktop-policy
 *   unit test;
 * - after a 3-second warm-up, samples 30 seconds per route (60 seconds
 *   total): rAF interval p95 (a wrapped `requestAnimationFrame`), total
 *   blocking time (a `PerformanceObserver` on `"longtask"`), JS heap growth
 *   across a CDP-forced `HeapProfiler.collectGarbage` before and after
 *   (`performance.memory.usedJSHeapSize`), cumulative layout shift (a
 *   `PerformanceObserver` on `"layout-shift"`, excluding entries with
 *   recent input), CSS/WOFF2/WebP transfer bytes and healthy-load PNG
 *   request count (CDP `Network` `encodedDataLength`, matching
 *   `frontend-accessibility.mjs`'s own established Network-domain pattern
 *   rather than Playwright's request/response events, which do not
 *   reliably distinguish a cache replay from a real transfer), and the
 *   simultaneously-animated-canvas count (`[data-render-mode="animated"]`);
 * - writes `artifacts/frontend-performance/result.json`
 *   (`viva.frontend_performance.v1`) with the exact git SHA, viewport, CPU
 *   rate, metric values, and pass/fail only — never transcript, answer,
 *   source text, tokens, URLs with credentials, or a browser trace.
 *
 * Every budget above is enforced by one small, exported, pure function
 * (`checkFrameIntervalP95` and its siblings below) so
 * `scripts/frontend-quality.test.mjs` can prove each threshold's direction
 * against a hostile fixture without a browser.
 */

const GLYPHS_READY_SELECTOR = ".viva-glyphs[data-render-mode]";
const TOGGLE_NAME = "Reduce visual effects";
const RESTORE_NAME = "Use system visual effects";

/* -------------------------------------------------------------------------
 * Task 11 (`FRONTEND-009`): the exact performance budget table, each a
 * small pure function so `frontend-quality.test.mjs` can prove its
 * threshold direction against a hostile fixture without a browser.
 * ---------------------------------------------------------------------- */

/** rAF interval p95 <= 50ms. */
export function checkFrameIntervalP95(p95Ms) {
  return p95Ms <= 50;
}

/** Total blocking time (`sum(max(0, longTask - 50))`) <= 300ms. */
export function checkTotalBlockingTime(totalBlockingTimeMs) {
  return totalBlockingTimeMs <= 300;
}

/** JS heap growth after a forced GC <= 8 MiB. */
export function checkHeapGrowthBytes(heapGrowthBytes) {
  return heapGrowthBytes <= 8 * 1024 * 1024;
}

/** Cumulative layout shift <= 0.05. */
export function checkCumulativeLayoutShift(cumulativeLayoutShift) {
  return cumulativeLayoutShift <= 0.05;
}

/** Route CSS transfer <= 100 KiB. */
export function checkCssTransferBytes(cssTransferBytes) {
  return cssTransferBytes <= 100 * 1024;
}

/** WOFF2 transfer <= 300 KiB. */
export function checkWoff2TransferBytes(woff2TransferBytes) {
  return woff2TransferBytes <= 300 * 1024;
}

/** Muse WebP transfer <= 120 KiB. */
export function checkWebpTransferBytes(webpTransferBytes) {
  return webpTransferBytes <= 120 * 1024;
}

/** A healthy load never transfers the PNG fallback. */
export function checkHealthyPngRequestCount(healthyPngRequestCount) {
  return healthyPngRequestCount === 0;
}

/** At most one canvas may be simultaneously animated on a route. */
export function checkAnimatedCanvasCount(animatedCanvasCount) {
  return animatedCanvasCount <= 1;
}

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

const PERFORMANCE_RESULT_SCHEMA = "viva.frontend_performance.v1";
const PERFORMANCE_RESULT_PATH = path.join(repoRoot, "artifacts/frontend-performance/result.json");
const LOW_END_VIEWPORT = { width: 375, height: 667 };
const LOW_END_DEVICE_SCALE_FACTOR = 3;
const LOW_END_CPU_THROTTLING_RATE = 4;
const LOW_END_HARDWARE_CONCURRENCY = 4;
const WARMUP_MS = 3_000;
const SAMPLE_MS = 30_000;

function currentGitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
}

/**
 * Attaches a real CDP `Network` session (the same domain
 * `frontend-accessibility.mjs`'s `checkMuseFallbackRecovery` already uses,
 * for the identical reason: Playwright's own request/response events do
 * not reliably distinguish a cache replay from a real transfer) and
 * accumulates `encodedDataLength` — the actual wire bytes — per asset
 * class, correlating `Network.responseReceived` (url) with
 * `Network.loadingFinished` (`encodedDataLength`) by `requestId`.
 *
 * @param {import("playwright").Page} page
 */
async function trackNetworkTransfers(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const pendingByRequestId = new Map();
  const totals = { css: 0, healthyPngRequestCount: 0, webp: 0, woff2: 0 };
  cdp.on("Network.responseReceived", (event) => {
    pendingByRequestId.set(event.requestId, event.response.url);
  });
  cdp.on("Network.loadingFinished", (event) => {
    const url = pendingByRequestId.get(event.requestId);
    pendingByRequestId.delete(event.requestId);
    if (!url) return;
    const bytes = event.encodedDataLength ?? 0;
    if (url.endsWith(".css")) totals.css += bytes;
    else if (url.endsWith(".woff2")) totals.woff2 += bytes;
    else if (url.endsWith("/viva-muse.webp")) totals.webp += bytes;
    else if (url.endsWith("/viva-muse.png")) totals.healthyPngRequestCount += 1;
  });
  return totals;
}

/**
 * Samples `page` for `SAMPLE_MS` after installing rAF/long-task/layout-shift
 * instrumentation, and forces GC (CDP `HeapProfiler.collectGarbage`) both
 * immediately before and after the sampling window to measure real heap
 * growth rather than uncollected garbage. Instrumentation is installed via
 * `page.evaluate` rather than `context.addInitScript`: every metric here is
 * scoped to the sampling window itself (a `PerformanceObserver` only
 * reports entries occurring after `.observe()`, and only the steady-state
 * animation's own rAF calls matter), so it need not predate page load the
 * way `navigator.hardwareConcurrency` does.
 *
 * @param {import("playwright").Page} page
 */
async function sampleScenario(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const heapBeforeBytes = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);

  await page.evaluate(() => {
    const state = { clsValue: 0, longTaskDurationsMs: [], rafTimestampsMs: [] };
    window.__vivaPerfSample = state;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      nativeRequestAnimationFrame((timeMs) => {
        state.rafTimestampsMs.push(timeMs);
        return callback(timeMs);
      });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTaskDurationsMs.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) state.clsValue += entry.value;
      }
    }).observe({ entryTypes: ["layout-shift"] });
  });

  await page.waitForTimeout(SAMPLE_MS);

  const sample = await page.evaluate(() => window.__vivaPerfSample);
  await cdp.send("HeapProfiler.collectGarbage");
  const heapAfterBytes = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);

  const intervals = [];
  for (let index = 1; index < sample.rafTimestampsMs.length; index++) {
    intervals.push(sample.rafTimestampsMs[index] - sample.rafTimestampsMs[index - 1]);
  }
  intervals.sort((a, b) => a - b);
  const p95Index =
    intervals.length > 0
      ? Math.min(intervals.length - 1, Math.ceil(intervals.length * 0.95) - 1)
      : 0;

  return {
    cumulativeLayoutShift: sample.clsValue,
    frameIntervalP95Ms: intervals.length > 0 ? intervals[p95Index] : 0,
    heapGrowthBytes: Math.max(0, heapAfterBytes - heapBeforeBytes),
    totalBlockingTimeMs: sample.longTaskDurationsMs.reduce(
      (sum, duration) => sum + Math.max(0, duration - 50),
      0,
    ),
  };
}

/**
 * Reads the primary animating canvas's policy data attributes for one
 * scenario — `.viva-glyphs` on `/` (`landing_muse`), `.voice-trace` on
 * `/session` (`voice_trace` — `.viva-glyphs` there is `session_muse`,
 * unconditionally static regardless of hardware, so asserting *it* reports
 * "reduced" would be a false failure; `checkAnimatedCanvasCount` below is
 * what proves the two canvases never animate together instead).
 *
 * @param {import("playwright").Page} page
 * @param {"landing" | "session"} scenario
 */
async function primaryCanvasPolicy(page, scenario) {
  const selector = scenario === "session" ? ".voice-trace" : ".viva-glyphs";
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return {
      dprCap: el?.getAttribute("data-dpr-cap") ?? null,
      fpsBudget: el?.getAttribute("data-fps-budget") ?? null,
      mode: el?.getAttribute("data-viva-effects") ?? null,
    };
  }, selector);
}

/**
 * The full production-mode sampling gate. Requires a completed
 * `apps/web` build (`withFrontendProductionServer` refuses otherwise),
 * a real synthetic agent-service for `/session`, and 4x CPU throttling
 * plus `hardwareConcurrency: 4` on every sampled page.
 */
async function runFullPerformanceCheck() {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-performance");
  mkdirSync(artifactDir, { recursive: true });
  const failures = [];
  const scenarios = {};

  // `NEXT_PUBLIC_*` env cannot steer an already-built production bundle
  // (see `startSyntheticAgent`'s doc comment), so this binds the agent to
  // its fixed default port instead of a fresh one, and passes only the
  // server-side-only agent vars, which `next start` (unlike a client
  // bundle) still reads fresh from `process.env` per request.
  const agent = await startSyntheticAgent({ artifactDir, port: 4318 });
  try {
    await withFrontendProductionServer(
      {
        artifactDir,
        extraEnv: {
          VIVA_AGENT_HTTP_URL: agent.url,
          VIVA_AGENT_REST_BEARER_TOKEN: "local-frontend-harness-bearer",
          VIVA_SESSION_ALLOWED_STUDY_SET_IDS: "biology-midterm",
          VIVA_SESSION_ALLOWED_USER_IDS: "user-1",
        },
      },
      async ({ baseUrl }) => {
        const browser = await launchChromium();
        try {
          for (const scenario of /** @type {const} */ (["landing", "session"])) {
            const context = await browser.newContext({
              deviceScaleFactor: LOW_END_DEVICE_SCALE_FACTOR,
              viewport: LOW_END_VIEWPORT,
            });
            await context.addInitScript((hardwareConcurrency) => {
              Object.defineProperty(window.navigator, "hardwareConcurrency", {
                configurable: true,
                value: hardwareConcurrency,
              });
            }, LOW_END_HARDWARE_CONCURRENCY);
            const page = await context.newPage();
            try {
              await setCpuThrottlingRate(page, LOW_END_CPU_THROTTLING_RATE);
              const transfers = await trackNetworkTransfers(page);

              if (scenario === "session") {
                await routeSyntheticSessionProjection(page);
                await page.goto(toHydratableUrl(syntheticSessionUrl(baseUrl)), {
                  timeout: 120_000,
                  waitUntil: "load",
                });
                await page.waitForSelector(".voice-trace[data-render-mode]", { timeout: 30_000 });
              } else {
                await page.goto(toHydratableUrl(baseUrl), {
                  timeout: 120_000,
                  waitUntil: "networkidle",
                });
                await page.waitForSelector(GLYPHS_READY_SELECTOR, { timeout: 30_000 });
              }

              const policyBeforeSampling = await primaryCanvasPolicy(page, scenario);
              if (
                policyBeforeSampling.mode !== "reduced" ||
                policyBeforeSampling.dprCap !== "1.5" ||
                policyBeforeSampling.fpsBudget !== "24"
              ) {
                failures.push(
                  `[${scenario}] expected the reduced policy (mode=reduced, dprCap=1.5, ` +
                    `fpsBudget=24) before sampling under 4x throttle + hardwareConcurrency=4, ` +
                    `got ${JSON.stringify(policyBeforeSampling)}`,
                );
              }

              await page.waitForTimeout(WARMUP_MS);
              const sampled = await sampleScenario(page);
              const animatedCanvasCount = await page.evaluate(
                () => document.querySelectorAll('[data-render-mode="animated"]').length,
              );

              const result = {
                animatedCanvasCount,
                cssTransferBytes: transfers.css,
                cumulativeLayoutShift: sampled.cumulativeLayoutShift,
                frameIntervalP95Ms: sampled.frameIntervalP95Ms,
                healthyPngRequestCount: transfers.healthyPngRequestCount,
                heapGrowthBytes: sampled.heapGrowthBytes,
                totalBlockingTimeMs: sampled.totalBlockingTimeMs,
                webpTransferBytes: transfers.webp,
                woff2TransferBytes: transfers.woff2,
              };
              scenarios[scenario] = result;

              const budgetChecks = [
                [
                  checkFrameIntervalP95(result.frameIntervalP95Ms),
                  `rAF interval p95 ${result.frameIntervalP95Ms}ms > 50ms`,
                ],
                [
                  checkTotalBlockingTime(result.totalBlockingTimeMs),
                  `total blocking time ${result.totalBlockingTimeMs}ms > 300ms`,
                ],
                [
                  checkHeapGrowthBytes(result.heapGrowthBytes),
                  `JS heap growth ${result.heapGrowthBytes} bytes > 8 MiB`,
                ],
                [
                  checkCumulativeLayoutShift(result.cumulativeLayoutShift),
                  `cumulative layout shift ${result.cumulativeLayoutShift} > 0.05`,
                ],
                [
                  checkCssTransferBytes(result.cssTransferBytes),
                  `CSS transfer ${result.cssTransferBytes} bytes > 100 KiB`,
                ],
                [
                  checkWoff2TransferBytes(result.woff2TransferBytes),
                  `WOFF2 transfer ${result.woff2TransferBytes} bytes > 300 KiB`,
                ],
                [
                  checkWebpTransferBytes(result.webpTransferBytes),
                  `Muse WebP transfer ${result.webpTransferBytes} bytes > 120 KiB`,
                ],
                [
                  checkHealthyPngRequestCount(result.healthyPngRequestCount),
                  `${result.healthyPngRequestCount} PNG request(s) during a healthy load`,
                ],
                [
                  checkAnimatedCanvasCount(result.animatedCanvasCount),
                  `${result.animatedCanvasCount} simultaneously animated canvases`,
                ],
              ];
              for (const [ok, message] of budgetChecks) {
                if (!ok) failures.push(`[${scenario}] ${message}`);
              }
            } finally {
              await context.close();
            }
          }
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await agent.close();
  }

  const record = {
    cpuThrottlingRate: LOW_END_CPU_THROTTLING_RATE,
    gitSha: currentGitSha(),
    pass: failures.length === 0,
    scenarios,
    schema: PERFORMANCE_RESULT_SCHEMA,
    viewport: { ...LOW_END_VIEWPORT, deviceScaleFactor: LOW_END_DEVICE_SCALE_FACTOR },
  };
  writeFileSync(PERFORMANCE_RESULT_PATH, JSON.stringify(record, null, 2));

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

  if (args.length === 0) {
    const failures = await runFullPerformanceCheck();
    if (failures.length > 0) {
      console.error(`frontend-performance FAILED: ${failures.length} issue(s)`);
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(`frontend-performance OK: 0 issues. Evidence: ${PERFORMANCE_RESULT_PATH}`);
    return;
  }

  fail(
    "no recognized mode flag. Supported: --policy-only, or no flag at all for the full " +
      "production-build, CPU-throttled sampling mode.",
  );
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

// Task 11: only run the CLI when this file is executed directly, never
// when imported — `scripts/frontend-quality.test.mjs` imports this
// module's pure `checkFrameIntervalP95`/etc. exports specifically so it
// can test them without a browser or a 60-second production sampling run;
// an unguarded top-level `await main()` would trigger exactly that as an
// import side effect. Mirrors `scripts/dev-agent.mjs`'s own identical guard.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
