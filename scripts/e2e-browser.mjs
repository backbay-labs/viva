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
const agentProvider = process.env.VIVA_E2E_AGENT_PROVIDER ?? "synthetic";
const stopToRecap = process.env.VIVA_E2E_STOP_TO_RECAP === "1";
const requirePostAnswerSourceFolio =
  process.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO === undefined
    ? agentProvider === "synthetic"
    : process.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO === "1";
const children = [];
const consoleErrors = [];
const pageErrors = [];
const serverEvents = [];
let browser;
let context;
let page;
let traceStarted = false;
let traceArtifact = null;
let sourceFolioVisible = false;
let boundedSourceVisible = false;
let postAnswerSourceFolioVisible = false;
let postAnswerBoundedSourceVisible = false;
let postAnswerProtocolProof = {
  conceptStatus: null,
  conceptStatusEventSeen: false,
  responseId: null,
  sourceReferenceEventSeen: false,
};

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  const agent = spawnLogged(
    "agent",
    "cargo",
    ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service"],
    {
      VIVA_AGENT_BIND_ADDR: `127.0.0.1:${agentPort}`,
      VIVA_AGENT_PROVIDER: agentProvider,
      VIVA_VOICE_SESSION_TOKEN_SECRET: "",
    },
  );
  await waitForHttpJson(
    `${agentUrl}/ready`,
    (json) => {
      return json?.ready === true && json?.brain?.provider === agentProvider;
    },
    120_000,
    `${agentProvider} agent readiness`,
  );

  const web = spawnLogged(
    "web",
    "bun",
    ["run", "--cwd", "apps/web", "dev", "--", "--hostname", "127.0.0.1", "--port", String(webPort)],
    {
      NEXT_PUBLIC_VIVA_AGENT_WS_URL: wsUrl,
      NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: agentUrl,
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID: "user-1",
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID: "biology-midterm",
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID: "voice-session-1",
    },
  );
  await waitForHttp(webUrl, 120_000, "Next.js app");

  browser = await launchChromium();
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
  page.on("websocket", (socket) => {
    socket.on("framereceived", (frame) => recordServerFramePayload(frame.payload, serverEvents));
  });

  await page.goto(webUrl, { waitUntil: "networkidle" });
  const legacyUploadVisible = await isVisible(page.getByText("What are we studying?"));
  await page.getByRole("button", { name: "Review missed concepts" }).click();
  await page.waitForURL(`${webUrl}/session`, { timeout: 20_000 });
  await page.getByText("Explain the role of NADH in oxidative phosphorylation.").waitFor({
    state: "visible",
    timeout: 20_000,
  });
  const listeningText =
    agentProvider === "synthetic"
      ? "Synthetic examiner is listening."
      : "Non-live provider test is listening.";
  await page.getByText(listeningText).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  const manuscriptReady = await isVisible(page.getByText(listeningText));
  await page.screenshot({
    path: path.join(artifactDir, "session-ready.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Show source" }).click();
  await page.getByText("Source Folio").waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.waitForTimeout(600);
  sourceFolioVisible =
    (await isVisible(page.getByText("Source Folio").first())) &&
    (await isVisible(page.getByRole("button", { name: "Challenge citation" }).first()));
  boundedSourceVisible =
    (await isVisible(page.getByText("NADH donates", { exact: false }).first())) &&
    (await isVisible(page.getByText("Document span only", { exact: false }).first()));
  await page.screenshot({
    path: path.join(artifactDir, "source-folio.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Back to question" }).click();

  if (stopToRecap) {
    await page.getByRole("button", { name: "End session" }).click();
  } else {
    await page.getByRole("button", { name: /check it/i }).click();
    postAnswerProtocolProof = await waitForPostAnswerProtocolProof(serverEvents, 25_000);
    if (requirePostAnswerSourceFolio) {
      await page.getByRole("button", { name: "Show source" }).waitFor({
        state: "visible",
        timeout: 25_000,
      });
      await page.getByRole("button", { name: "Show source" }).click();
      await page.getByText("Source Folio").waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await page.waitForTimeout(600);
      postAnswerSourceFolioVisible =
        (await isVisible(page.getByText("Source Folio").first())) &&
        (await isVisible(page.getByRole("button", { name: "Challenge citation" }).first())) &&
        (await isVisible(
          page.getByText(conceptStatusText(postAnswerProtocolProof.conceptStatus), {
            exact: false,
          }).first(),
        ));
      postAnswerBoundedSourceVisible =
        (await isVisible(page.getByText("NADH donates", { exact: false }).first())) &&
        (await isVisible(page.getByText("Document span only", { exact: false }).first()));
      await page.screenshot({
        path: path.join(artifactDir, "post-answer-source-folio.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Back to question" }).click();
    }
    await page.getByRole("button", { name: "End session" }).click();
  }
  const recapSummaryText =
    agentProvider === "synthetic"
      ? "Next, make the proton-gradient-to-ATP-synthase link explicit."
      : "The session stayed grounded to the server-owned source span.";
  await page.getByText("Recap ready").waitFor({
    state: "visible",
    timeout: 25_000,
  });
  await page.getByText(recapSummaryText, { exact: false }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText("Review later").waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText("Lecture 5", { exact: false }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const recapPayloadVisible =
    (await isVisible(page.getByText("Recap ready").first())) &&
    (await isVisible(page.getByText(recapSummaryText, { exact: false }).first())) &&
    (await isVisible(page.getByText("proton gradient", { exact: false }).first())) &&
    (await isVisible(page.getByText("Conductor next action", { exact: false }).first()));
  const shareVisible = await isVisible(page.getByRole("button", { name: "Share" }));
  const localScheduleVisible = await isVisible(
    page.getByRole("button", { name: /Schedule a short source-backed review tomorrow/ }),
  );
  await page.screenshot({
    path: path.join(artifactDir, "connected-terminal-fold.png"),
    fullPage: true,
  });
  if (traceStarted) {
    await context.tracing.stop({ path: path.join(artifactDir, "trace.zip") });
    traceArtifact = "trace.zip";
    traceStarted = false;
  }

  const result = {
    artifact_dir: path.relative(root, artifactDir),
    agent_provider: agentProvider,
    agent_url: agentUrl,
    stop_to_recap: stopToRecap,
    web_url: webUrl,
    legacy_upload_visible: legacyUploadVisible,
    manuscript_ready: manuscriptReady,
    conductor_terminal_fold: recapPayloadVisible,
    recap_payload_visible: recapPayloadVisible,
    source_folio_visible: sourceFolioVisible,
    bounded_source_visible: boundedSourceVisible,
    post_answer_source_folio_visible: postAnswerSourceFolioVisible,
    post_answer_bounded_source_visible: postAnswerBoundedSourceVisible,
    post_answer_source_reference_event_seen: postAnswerProtocolProof.sourceReferenceEventSeen,
    post_answer_concept_status_event_seen: postAnswerProtocolProof.conceptStatusEventSeen,
    post_answer_protocol_response_id: postAnswerProtocolProof.responseId,
    local_only_actions_hidden: !shareVisible && !localScheduleVisible,
    console_errors: consoleErrors,
    page_errors: pageErrors,
    screenshots: [
      "session-ready.png",
      "source-folio.png",
      ...(!stopToRecap && requirePostAnswerSourceFolio ? ["post-answer-source-folio.png"] : []),
      "connected-terminal-fold.png",
    ],
    trace: traceArtifact,
  };
  await writeFile(path.join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

  if (legacyUploadVisible) throw new Error("Landing mounted the retired legacy upload app.");
  if (!manuscriptReady) throw new Error("Landing did not enter the connected manuscript.");
  if (!recapPayloadVisible)
    throw new Error("Connected fake-provider session did not render the recap_ready payload.");
  if (!sourceFolioVisible) {
    throw new Error("Connected session did not render the Source Folio.");
  }
  if (!boundedSourceVisible) {
    throw new Error("Connected session did not render bounded source folio proof.");
  }
  if (!stopToRecap && requirePostAnswerSourceFolio && !postAnswerSourceFolioVisible) {
    throw new Error("Connected session did not render the post-answer Source Folio.");
  }
  if (!stopToRecap && requirePostAnswerSourceFolio && !postAnswerBoundedSourceVisible) {
    throw new Error("Connected session did not render post-answer bounded source folio proof.");
  }
  if (!stopToRecap && requirePostAnswerSourceFolio && !postAnswerProtocolProof.sourceReferenceEventSeen) {
    throw new Error("Post-answer Source Folio did not observe a source_reference event.");
  }
  if (!stopToRecap && requirePostAnswerSourceFolio && !postAnswerProtocolProof.conceptStatusEventSeen) {
    throw new Error("Post-answer Source Folio did not observe a concept_status event.");
  }
  if (shareVisible || localScheduleVisible) {
    throw new Error("Connected manuscript exposed local-only Share or schedule actions.");
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

async function launchChromium() {
  const options = {
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  };
  try {
    return await chromium.launch(options);
  } catch (error) {
    const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (
      process.platform === "darwin" &&
      error instanceof Error &&
      error.message.includes("Executable doesn't exist")
    ) {
      return await chromium.launch({ ...options, executablePath: systemChrome });
    }
    throw error;
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

function conceptStatusText(status) {
  switch (status) {
    case "strong":
      return "Strong";
    case "shaky":
      return "Shaky";
    case "missed":
      return "Missed";
    case "review":
      return "Review";
    default:
      return "Awaiting concept status";
  }
}

function recordServerFramePayload(payload, events) {
  const text =
    typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : String(payload);
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (frame?.type !== "event" || typeof frame.event?.type !== "string") return;

  events.push({
    conceptStatus: frame.event.status ?? null,
    responseId: frame.event.response_id ?? null,
    sourceId: frame.event.source?.source_id ?? null,
    type: frame.event.type,
  });
}

async function waitForPostAnswerProtocolProof(events, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const proof = postAnswerProtocolProofFromEvents(events);
    if (proof.sourceReferenceEventSeen && proof.conceptStatusEventSeen) return proof;
    await delay(100);
  }
  const eventTypes = events.map((event) => event.type).join(" -> ");
  throw new Error(
    `Timed out waiting for post-answer source_reference and concept_status events. Saw: ${eventTypes}`,
  );
}

function postAnswerProtocolProofFromEvents(events) {
  for (let answerIndex = events.length - 1; answerIndex >= 0; answerIndex -= 1) {
    const answerEvent = events[answerIndex];
    if (answerEvent.type !== "answer_evaluated" || !answerEvent.responseId) continue;

    const afterAnswer = events.slice(answerIndex + 1);
    const sourceEvent = afterAnswer.find(
      (event) =>
        event.type === "source_reference" &&
        event.responseId === answerEvent.responseId &&
        Boolean(event.sourceId),
    );
    const conceptEvent = afterAnswer.find(
      (event) =>
        event.type === "concept_status" &&
        event.responseId === answerEvent.responseId &&
        typeof event.conceptStatus === "string",
    );
    return {
      conceptStatus: conceptEvent?.conceptStatus ?? null,
      conceptStatusEventSeen: Boolean(conceptEvent),
      responseId: answerEvent.responseId,
      sourceReferenceEventSeen: Boolean(sourceEvent),
    };
  }
  return {
    conceptStatus: null,
    conceptStatusEventSeen: false,
    responseId: null,
    sourceReferenceEventSeen: false,
  };
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
