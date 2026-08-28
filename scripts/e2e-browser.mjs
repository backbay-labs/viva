#!/usr/bin/env node
// RELEASE-030 E2E extraction: argument/env parsing, composition, top-level
// quarantine, and exit-code handling. `buildE2EPlan()` (pure config),
// `e2e-browser-runtime.mjs` (Playwright/local-service lifecycle), and
// `e2e-browser-story.mjs` (page actions, required frames, and evidence
// assembly) do the rest; this file sequences them and owns nothing else.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertHarnessConfiguration, buildE2EPlan } from "./e2e-browser-plan.mjs";
import {
  authenticatedHostedFetchOptions,
  freePort,
  launchChromium,
  spawnLocalAgent,
  spawnLocalWeb,
  stopLocalChildren,
  waitForHttp,
  waitForHttpJson,
} from "./e2e-browser-runtime.mjs";
import {
  recordServerFramePayload,
  redactSensitiveDiagnostic,
  runBrowserStory,
} from "./e2e-browser-story.mjs";
import { installSignalCleanup, SUPERVISOR_DEFAULT_GRACE_MS } from "./process-supervisor.mjs";

function isDirectRun() {
  return (
    Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

/** Wire the page's own console/error/websocket observation into `capture`. */
function wirePageCapture(page, capture) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      capture.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => capture.pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    capture.websocketUrls.push(socket.url());
    socket.on("framereceived", (frame) =>
      recordServerFramePayload(frame.payload, capture.serverEvents),
    );
  });
}

async function main() {
  const plan = buildE2EPlan();
  assertHarnessConfiguration(plan);
  const hostedAgentReadinessFetchOptions = plan.hostedMode
    ? authenticatedHostedFetchOptions(plan.hostedRestBearerToken)
    : undefined;

  let webPort = null;
  let agentUrl = plan.hostedAgentHttpUrl ?? null;
  let webUrl = plan.hostedWebUrl ?? null;
  let wsUrl = plan.hostedAgentWsUrl ?? null;
  let agent;
  let web;
  let browser;
  let context;
  let page;
  const capture = {
    consoleErrors: [],
    pageErrors: [],
    serverEvents: [],
    websocketUrls: [],
    traceStarted: false,
    traceArtifact: null,
  };

  const signals = installSignalCleanup({
    cleanup: async () => {
      await stopLocalChildren();
      process.exit(1);
    },
  });

  await rm(plan.artifactDir, { recursive: true, force: true });
  await mkdir(plan.artifactDir, { recursive: true });

  try {
    if (!plan.hostedMode) {
      // The web child needs its port before the agent starts (the agent's
      // allowed-origin list names the web origin), and both are allocated
      // through the bounded-retry boundary rather than a bare freePort().
      webPort = await freePort();
      webUrl = `http://127.0.0.1:${webPort}`;
    }
    if (!plan.hostedMode) {
      const spawned = await spawnLocalAgent(plan, { webUrl });
      agent = spawned.handle;
      agentUrl = `http://127.0.0.1:${spawned.port}`;
      wsUrl = `ws://127.0.0.1:${spawned.port}/ws`;
    }
    const agentReadiness = await waitForHttpJson(
      `${agentUrl}/ready`,
      (json) => json?.ready === true && json?.brain?.provider === plan.agentProvider,
      120_000,
      `${plan.agentProvider} agent readiness`,
      hostedAgentReadinessFetchOptions,
    );

    if (!plan.hostedMode) {
      web = await spawnLocalWeb(plan, { agentUrl, webUrl, wsUrl, webPort });
    }
    // Pre-extraction (931d2a6) this probe ran unconditionally, so a hosted run
    // also waits on the hosted web origin before Chromium ever launches. The
    // extraction accidentally nested it inside the local-only spawn block,
    // silently dropping hosted's bounded, typed readiness check. Restored here
    // (finding: e2e-browser.mjs waitForHttp hosted-mode regression).
    await waitForHttp(webUrl, 120_000, "Next.js app");

    browser = await launchChromium();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["microphone"], { origin: webUrl });
    if (plan.traceRequested) {
      await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
      capture.traceStarted = true;
    }
    page = await context.newPage();
    wirePageCapture(page, capture);

    const result = await runBrowserStory({
      plan,
      runtime: { agentReadiness, agentUrl, context, page, webUrl, wsUrl },
      capture,
    });

    console.log(JSON.stringify(result, null, 2));
    await web?.stop({ graceMs: SUPERVISOR_DEFAULT_GRACE_MS });
    await agent?.stop({ graceMs: SUPERVISOR_DEFAULT_GRACE_MS });
  } catch (error) {
    const sanitizedError = redactSensitiveDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    if (context && capture.traceStarted) {
      await context.tracing.stop({ path: path.join(plan.artifactDir, "trace.zip") }).catch(() => {});
      capture.traceStarted = false;
    }
    if (page && process.env.VIVA_E2E_FAILURE_SCREENSHOT === "1") {
      await page
        .screenshot({ path: path.join(plan.artifactDir, "failure.png"), fullPage: true })
        .catch(() => {});
    }
    await writeFile(
      path.join(plan.artifactDir, "failure.json"),
      `${JSON.stringify(
        {
          error: sanitizedError,
          console_errors: capture.consoleErrors.map(redactSensitiveDiagnostic),
          page_errors: capture.pageErrors.map(redactSensitiveDiagnostic),
          artifact_dir: path.relative(plan.root, plan.artifactDir),
        },
        null,
        2,
      )}\n`,
    ).catch(() => {});
    throw new Error(sanitizedError);
  } finally {
    await browser?.close().catch(() => {});
    await stopLocalChildren();
    signals.uninstall();
  }
}

if (isDirectRun()) {
  await main();
}
