#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.resolve(
  root,
  process.env.VIVA_E2E_ARTIFACT_DIR ?? "artifacts/e2e-browser",
);
const agentPort = await freePort();
const webPort = await freePort();
const agentUrl = `http://127.0.0.1:${agentPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const wsUrl = `ws://127.0.0.1:${agentPort}/ws`;
const children = [];
const consoleErrors = [];
const pageErrors = [];
let browser;
let context;
let page;
let traceStarted = false;
let traceArtifact = null;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  const agent = spawnLogged(
    "agent",
    "cargo",
    ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service"],
    {
      VIVA_AGENT_BIND_ADDR: `127.0.0.1:${agentPort}`,
      VIVA_AGENT_PROVIDER: "fake_cartesia_gemini",
      VIVA_VOICE_SESSION_TOKEN_SECRET: "session-secret",
    },
  );
  await waitForHttpJson(
    `${agentUrl}/ready`,
    (json) => {
      return json?.ready === true && json?.brain?.provider === "fake_cartesia_gemini";
    },
    120_000,
    "fake-provider agent readiness",
  );

  const web = spawnLogged(
    "web",
    "bun",
    ["run", "--cwd", "apps/web", "dev", "--", "--hostname", "127.0.0.1", "--port", String(webPort)],
    {
      NEXT_PUBLIC_VIVA_AGENT_WS_URL: wsUrl,
      NEXT_PUBLIC_VIVA_API_URL: agentUrl,
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID: "user-1",
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID: "biology-midterm",
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID: "voice-session-1",
    },
  );
  await waitForHttp(webUrl, 120_000, "Next.js app");

  browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(["microphone"], { origin: webUrl });
  if (process.env.VIVA_E2E_TRACE === "1") {
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    traceStarted = true;
  }
  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(webUrl, { waitUntil: "networkidle" });
  await page.getByLabel("Course / study set name").fill("Local File Preview");
  await page.locator('input[type="file"]').setInputFiles({
    name: "local-preview-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Local file preview notes stay pending until server ingestion exists."),
  });
  await page.getByRole("button", { name: /Generate local preview/ }).click();
  await page.getByText("Local study preview").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByRole("button", { name: /Start first recall drill/ }).click();
  const agentUnavailable = page.getByRole("button", { name: "Agent unavailable" });
  await agentUnavailable.waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const pendingGate = await isVisible(agentUnavailable);
  await agentUnavailable.screenshot({
    path: path.join(artifactDir, "pending-local-preview.png"),
  });

  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: /New study set/ }).click();
  await page.getByLabel("Course / study set name").fill("Cardiac Physiology");
  await page
    .getByLabel("Paste notes")
    .fill(
      "preload stroke volume cardiac output contractility physiology notes. Stroke volume rises as ventricular preload increases until cardiac muscle reaches its optimal length.",
    );
  await page.getByRole("button", { name: /Generate local preview/ }).click();
  await page.getByText("Server study set").waitFor({ state: "visible", timeout: 20_000 });
  const serverPasteReadyNotice = page.getByText("Server paste ingestion ready.", { exact: true });
  await serverPasteReadyNotice.waitFor({ state: "visible", timeout: 20_000 });
  const serverPasteReady = await isVisible(page.getByText("Server study set"));
  await serverPasteReadyNotice.screenshot({
    path: path.join(artifactDir, "server-paste-ready.png"),
  });
  await page.getByRole("button", { name: /Start first recall drill/ }).click();
  await page.getByRole("button", { name: /Start 10-minute recall drill/ }).click();
  await page.getByText("Explain Preload using the uploaded notes.").waitFor({
    state: "visible",
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Use browser audio" }).click();
  await page.getByText("Session recap").waitFor({ state: "visible", timeout: 25_000 });
  await page.getByText("The session stayed grounded to the server-owned source span.").waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const connectedRecap = await isVisible(
    page.getByText("Review the missed terms before the next call.", { exact: false }),
  );
  const shareVisible = await isVisible(page.getByRole("button", { name: "Share" }));
  const localScheduleVisible = await isVisible(
    page.getByRole("button", { name: /Schedule a short source-backed review tomorrow/ }),
  );
  await page.getByText("Session recap", { exact: true }).screenshot({
    path: path.join(artifactDir, "connected-recap.png"),
  });
  if (traceStarted) {
    await context.tracing.stop({ path: path.join(artifactDir, "trace.zip") });
    traceArtifact = "trace.zip";
    traceStarted = false;
  }

  const result = {
    artifact_dir: path.relative(root, artifactDir),
    agent_url: agentUrl,
    web_url: webUrl,
    pending_gate: pendingGate,
    server_paste_ready: serverPasteReady,
    connected_recap: connectedRecap,
    local_only_actions_hidden: !shareVisible && !localScheduleVisible,
    console_errors: consoleErrors,
    page_errors: pageErrors,
    screenshots: ["pending-local-preview.png", "server-paste-ready.png", "connected-recap.png"],
    trace: traceArtifact,
  };
  await writeFile(path.join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

  if (!pendingGate) throw new Error("Pending local preview did not show the connected-agent gate.");
  if (!serverPasteReady)
    throw new Error("Server paste ingestion did not produce a ready study set.");
  if (!connectedRecap) throw new Error("Connected fake-provider session did not reach recap.");
  if (shareVisible || localScheduleVisible) {
    throw new Error("Connected recap exposed local-only Share or schedule actions.");
  }
  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(`Browser errors detected: ${[...consoleErrors, ...pageErrors].join(" | ")}`);
  }

  console.log(JSON.stringify(result, null, 2));
  web.stop();
  agent.stop();
} catch (error) {
  if (context && traceStarted) {
    await context.tracing.stop({ path: path.join(artifactDir, "trace.zip") }).catch(() => {});
    traceStarted = false;
  }
  if (page && process.env.VIVA_E2E_FAILURE_SCREENSHOT === "1") {
    await page
      .screenshot({ path: path.join(artifactDir, "failure.png"), fullPage: true })
      .catch(() => {});
  }
  await writeFile(
    path.join(artifactDir, "failure.json"),
    `${JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        console_errors: consoleErrors,
        page_errors: pageErrors,
        artifact_dir: path.relative(root, artifactDir),
      },
      null,
      2,
    )}\n`,
  ).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) {
    child.stop();
  }
}

function spawnLogged(name, command, args, extraEnv = {}) {
  const stdout = createWriteStream(path.join(artifactDir, `${name}.stdout.log`));
  const stderr = createWriteStream(path.join(artifactDir, `${name}.stderr.log`));
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let exited = false;
  let exitCode = null;
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code ?? signal;
      resolve(exitCode);
    });
  });
  const handle = {
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    exit,
    stop() {
      if (!exited) child.kill("SIGTERM");
      stdout.end();
      stderr.end();
    },
  };
  children.push(handle);
  return handle;
}

async function waitForHttp(url, timeoutMs, label) {
  await waitForHttpJson(url, () => true, timeoutMs, label);
}

async function waitForHttpJson(url, predicate, timeoutMs, label) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    const earlyExit = children.find((child) => child.exited && child.exitCode !== 0);
    if (earlyExit) {
      throw new Error(`${label} dependency exited early with ${earlyExit.exitCode}`);
    }
    try {
      const response = await fetch(url);
      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (response.ok && predicate(json, response)) return json;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function isVisible(locator) {
  try {
    return await locator.isVisible({ timeout: 1_000 });
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("Could not allocate a free local port"));
      });
    });
  });
}
