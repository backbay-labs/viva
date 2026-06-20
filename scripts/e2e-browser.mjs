#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const allowedBrowserStoryProviders = new Set(["synthetic", "fake_cartesia_gemini"]);
if (!allowedBrowserStoryProviders.has(agentProvider)) {
  throw new Error(
    `BAC-307 browser-story capture only supports non-live providers: ${[
      ...allowedBrowserStoryProviders,
    ].join(", ")}.`,
  );
}
const stopToRecap = process.env.VIVA_E2E_STOP_TO_RECAP === "1";
const validationRunId = `browser-story-${agentProvider}-${new Date()
  .toISOString()
  .replaceAll(/[:.]/g, "-")}`;
const requirePostAnswerSourceFolio =
  process.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO === undefined
    ? agentProvider === "synthetic"
    : process.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO === "1";
const requireCorrectionMarginalia = agentProvider === "synthetic" && !stopToRecap;
const children = [];
const consoleErrors = [];
const pageErrors = [];
const serverEvents = [];
let browser;
let context;
let page;
let traceStarted = false;
let traceArtifact = null;
const storyFrames = [];
let sourceFolioVisible = false;
let boundedSourceVisible = false;
let correctionMarginaliaVisible = false;
let postAnswerSourceFolioVisible = false;
let postAnswerBoundedSourceVisible = false;
let postAnswerProtocolProof = {
  conceptId: null,
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

  await capturePendingLocalPreview(page);
  await page.goto(webUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Review missed concepts" }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  const legacyUploadVisible = await isVisible(page.getByText("What are we studying?"));
  await page.screenshot({
    path: path.join(artifactDir, "server-ready-study-set.png"),
    fullPage: true,
  });
  storyFrames.push({
    id: "server_ready_study_set",
    kind: "browser_screen",
    screenshot: "server-ready-study-set.png",
    checks: ["server_owned_study_set", "library_entry", "ready_session_action"],
  });
  await page.getByRole("button", { name: "Review missed concepts" }).click();
  await page.waitForURL(`${webUrl}/session`, { timeout: 20_000 });
  // Scope to the visible heading: the prompt is also mirrored into an sr-only
  // aria-live paragraph (so assistive tech hears a new question), so a plain
  // getByText matches two nodes and trips strict mode. The heading is the one
  // the student actually reads.
  await page
    .getByRole("heading", { name: "Explain the role of NADH in oxidative phosphorylation." })
    .waitFor({
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
  await page.getByText("Source Folio", { exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.waitForTimeout(600);
  sourceFolioVisible =
    (await isVisible(page.getByText("Source Folio", { exact: true }).first())) &&
    (await isVisible(page.getByRole("button", { name: "Challenge citation" }).first()));
  boundedSourceVisible =
    (await isVisible(page.getByText("NADH donates", { exact: false }).first())) &&
    (await isVisible(page.getByText("Document span only", { exact: false }).first()));
  await redactSourceFolioForSanitizedScreenshot(page);
  await page.screenshot({
    path: path.join(artifactDir, "source-folio.png"),
    fullPage: true,
  });
  storyFrames.push({
    id: "active_synthetic_manuscript",
    kind: "browser_screen",
    screenshot: "source-folio.png",
    supporting_screenshots: ["session-ready.png"],
    checks: ["synthetic_brain_listening", "voice_trace_canvas", "source_folio", "marginalia"],
  });
  await page.getByRole("button", { name: "Back to question" }).click();

  if (stopToRecap) {
    await page.getByRole("button", { name: "End session" }).click();
  } else {
    await page.getByRole("button", { name: /check it/i }).click();
    postAnswerProtocolProof = await waitForPostAnswerProtocolProof(serverEvents, 25_000);
    if (requireCorrectionMarginalia) {
      await page.getByText("Marginalia").waitFor({
        state: "visible",
        timeout: 25_000,
      });
      await page.getByRole("button", { name: "Try again" }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await page.getByRole("button", { name: "Show source" }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await page.getByRole("button", { name: "Next question" }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await page.waitForTimeout(600);
      correctionMarginaliaVisible =
        (await isVisible(page.getByText("Marginalia").first())) &&
        (await isVisible(page.getByRole("button", { name: "Try again" }).first())) &&
        (await isVisible(page.getByRole("button", { name: "Show source" }).first())) &&
        (await isVisible(page.getByRole("button", { name: "Next question" }).first()));
      await redactCorrectionMarginaliaForSanitizedScreenshot(page);
      await page.screenshot({
        path: path.join(artifactDir, "correction-marginalia.png"),
        fullPage: true,
      });
      storyFrames.push({
        id: "correction_marginalia",
        kind: "browser_screen",
        screenshot: "correction-marginalia.png",
        checks: [
          "correction_note",
          "try_again_action",
          "show_source_action",
          "next_question_action",
        ],
      });
    }
    if (requirePostAnswerSourceFolio) {
      await page.getByRole("button", { name: "Show source" }).click();
      await page.getByText("Source Folio", { exact: true }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await page.waitForTimeout(600);
      postAnswerSourceFolioVisible =
        (await isVisible(page.getByText("Source Folio", { exact: true }).first())) &&
        (await isVisible(page.getByRole("button", { name: "Challenge citation" }).first())) &&
        (await isVisible(
          page.getByText(conceptStatusText(postAnswerProtocolProof.conceptStatus), {
            exact: false,
          }).first(),
        ));
      postAnswerBoundedSourceVisible =
        (await isVisible(page.getByText("NADH donates", { exact: false }).first())) &&
        (await isVisible(page.getByText("Document span only", { exact: false }).first()));
      await redactSourceFolioForSanitizedScreenshot(page);
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
  await page.getByText("Closing fold / Recap ready").waitFor({
    state: "visible",
    timeout: 25_000,
  });
  await page.getByText(recapSummaryText, { exact: false }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText("Review later").first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText("Next session", { exact: false }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText("core FSRS", { exact: false }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText("Lecture 5", { exact: false }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const nextSessionRecommendationVisible =
    (await isVisible(page.getByText("Next session", { exact: false }).first())) &&
    (await isVisible(page.getByText("core FSRS", { exact: false }).first()));
  const recapPayloadVisible =
    (await isVisible(page.getByText("Closing fold / Recap ready").first())) &&
    (await isVisible(page.getByText(recapSummaryText, { exact: false }).first())) &&
    Boolean(postAnswerProtocolProof.conceptId) &&
    (await isVisible(
      page.getByText(conceptLabelText(postAnswerProtocolProof.conceptId), { exact: true }).first(),
    )) &&
    (await isVisible(page.getByText("Conductor next action", { exact: false }).first()));
  const shareVisible = await isVisible(page.getByRole("button", { name: "Share" }));
  const localScheduleVisible = await isVisible(
    page.getByRole("button", { name: /Schedule a short source-backed review tomorrow/ }),
  );
  await page.getByText("Closing fold / Recap ready").first().scrollIntoViewIfNeeded();
  await redactRecapForSanitizedScreenshot(page);
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(artifactDir, "connected-terminal-fold.png"),
    fullPage: true,
  });
  storyFrames.push({
    id: "recap",
    kind: "browser_screen",
    screenshot: "connected-terminal-fold.png",
    checks: ["recap_ready", "server_schedule_visible", "next_session_recommendation"],
  });
  if (traceStarted) {
    await context.tracing.stop({ path: path.join(artifactDir, "trace.zip") });
    traceArtifact = "trace.zip";
    traceStarted = false;
  }

  const browserStory = await buildBrowserStoryManifest({
    traceRetained: Boolean(traceArtifact),
  });
  let result = {
    artifact_dir: path.relative(root, artifactDir),
    agent_provider: agentProvider,
    agent_url: agentUrl,
    stop_to_recap: stopToRecap,
    web_url: webUrl,
    legacy_upload_visible: legacyUploadVisible,
    manuscript_ready: manuscriptReady,
    conductor_terminal_fold: recapPayloadVisible,
    recap_payload_visible: recapPayloadVisible,
    next_session_recommendation_visible: nextSessionRecommendationVisible,
    source_folio_visible: sourceFolioVisible,
    bounded_source_visible: boundedSourceVisible,
    correction_marginalia_visible: correctionMarginaliaVisible,
    post_answer_source_folio_visible: postAnswerSourceFolioVisible,
    post_answer_bounded_source_visible: postAnswerBoundedSourceVisible,
    post_answer_source_reference_event_seen: postAnswerProtocolProof.sourceReferenceEventSeen,
    post_answer_concept_status_event_seen: postAnswerProtocolProof.conceptStatusEventSeen,
    post_answer_concept_id: postAnswerProtocolProof.conceptId,
    post_answer_protocol_response_id: postAnswerProtocolProof.responseId,
    local_only_actions_hidden: !shareVisible && !localScheduleVisible,
    browser_story: browserStory,
    browser_story_artifact: "browser-story.json",
    console_errors: consoleErrors,
    page_errors: pageErrors,
    screenshots: [
      "pending-local-preview.png",
      "server-ready-study-set.png",
      "session-ready.png",
      "source-folio.png",
      ...(correctionMarginaliaVisible ? ["correction-marginalia.png"] : []),
      ...(!stopToRecap && requirePostAnswerSourceFolio ? ["post-answer-source-folio.png"] : []),
      "connected-terminal-fold.png",
    ],
    trace: traceArtifact,
  };
  result = await writeAuditedBrowserStoryResult(result);

  if (legacyUploadVisible) throw new Error("Landing mounted the retired legacy upload app.");
  if (!manuscriptReady) throw new Error("Landing did not enter the connected manuscript.");
  if (!recapPayloadVisible)
    throw new Error("Connected fake-provider session did not render the recap_ready payload.");
  if (!nextSessionRecommendationVisible) {
    throw new Error("Connected session did not render next-session review recommendations.");
  }
  if (!sourceFolioVisible) {
    throw new Error("Connected session did not render the Source Folio.");
  }
  if (!boundedSourceVisible) {
    throw new Error("Connected session did not render bounded source folio proof.");
  }
  if (requireCorrectionMarginalia && !correctionMarginaliaVisible) {
    throw new Error("Connected session did not render correction marginalia.");
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

async function capturePendingLocalPreview(targetPage) {
  await targetPage.setContent(pendingPreviewHtml(), { waitUntil: "domcontentloaded" });
  await targetPage.screenshot({
    path: path.join(artifactDir, "pending-local-preview.png"),
    fullPage: true,
  });
  storyFrames.push({
    id: "pending_local_preview",
    kind: "structured_preview",
    screenshot: "pending-local-preview.png",
    checks: ["extraction_pending", "server_not_contacted", "sanitized_summary_only"],
    note: "Rendered from the sanitized pending-preview contract because the retired local upload UI is not mounted in the Listening Manuscript app.",
  });
}

async function redactSourceFolioForSanitizedScreenshot(targetPage) {
  await redactLocatorText(
    targetPage.locator(".source-folio__excerpt p").first(),
    "Bounded source excerpt redacted in sanitized browser-story artifact.",
  );
}

async function redactCorrectionMarginaliaForSanitizedScreenshot(targetPage) {
  await redactLocatorText(
    targetPage.locator(".correction__body").first(),
    "Learner-answer reference redacted in sanitized browser-story artifact.",
  );
  await redactLocatorText(
    targetPage.locator(".correction__explain").first(),
    "Source-grounded model explanation redacted in sanitized browser-story artifact.",
  );
}

async function redactRecapForSanitizedScreenshot(targetPage) {
  await redactLocatorText(
    targetPage.locator(".recap-fold .folio__excerpt").first(),
    "Session recap summary redacted in sanitized browser-story artifact.",
  );
  const sourceFooters = await targetPage.locator(".recap-fold .folio__footer").all();
  if (sourceFooters.length > 0) {
    await redactLocatorText(
      sourceFooters[0],
      "Bounded source moment redacted in sanitized browser-story artifact.",
    );
  }
}

async function redactLocatorText(locator, replacement) {
  if ((await locator.count()) === 0) return;
  await locator.evaluate((element, text) => {
    element.textContent = text;
  }, replacement);
}

function pendingPreviewHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Viva browser story pending preview</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #17211b;
        --muted: #5e6c62;
        --paper: #f7f2e8;
        --line: #cbbf9e;
        --accent: #327066;
        --panel: #fffaf0;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 900px;
        background:
          linear-gradient(90deg, rgba(50, 112, 102, 0.16) 0 1px, transparent 1px 100%),
          linear-gradient(180deg, rgba(203, 191, 158, 0.55) 0 1px, transparent 1px 100%),
          var(--paper);
        background-size: 72px 100%, 100% 36px;
        color: var(--ink);
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(1120px, calc(100vw - 96px));
        margin: 68px auto;
      }
      .eyebrow {
        color: var(--accent);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      h1 {
        margin: 16px 0 12px;
        max-width: 760px;
        font-size: 56px;
        line-height: 1.02;
        letter-spacing: 0;
      }
      .lede {
        max-width: 690px;
        color: var(--muted);
        font-size: 20px;
        line-height: 1.45;
      }
      .manuscript {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 300px;
        gap: 32px;
        align-items: start;
        margin-top: 54px;
      }
      .sheet,
      aside {
        border: 1px solid var(--line);
        background: rgba(255, 250, 240, 0.82);
        box-shadow: 0 20px 48px rgba(53, 44, 27, 0.12);
      }
      .sheet {
        min-height: 430px;
        padding: 42px 48px;
      }
      .row {
        display: grid;
        grid-template-columns: 140px minmax(0, 1fr);
        gap: 28px;
        padding: 20px 0;
        border-bottom: 1px solid rgba(203, 191, 158, 0.7);
      }
      .row:last-child {
        border-bottom: 0;
      }
      .label {
        color: var(--accent);
        font-size: 14px;
        font-weight: 700;
      }
      .value {
        font-size: 24px;
        line-height: 1.28;
      }
      aside {
        padding: 28px;
      }
      aside h2 {
        margin: 0 0 18px;
        font-size: 20px;
        letter-spacing: 0;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        border: 1px solid rgba(50, 112, 102, 0.34);
        padding: 10px 12px;
        color: var(--accent);
        font-weight: 700;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--accent);
      }
      ul {
        margin: 22px 0 0;
        padding-left: 20px;
        color: var(--muted);
        line-height: 1.65;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Listening Manuscript browser story</div>
      <h1>Local preview pending</h1>
      <p class="lede">
        Sanitized preview frame for a manuscript set before server readiness. It includes only
        structural state and contains no learner payload.
      </p>
      <section class="manuscript" aria-label="Pending local preview">
        <div class="sheet">
          <div class="row">
            <div class="label">Set state</div>
            <div class="value">Extraction pending</div>
          </div>
          <div class="row">
            <div class="label">Session</div>
            <div class="value">The Conductor waits for a server-ready study set.</div>
          </div>
          <div class="row">
            <div class="label">Evidence</div>
            <div class="value">Browser-rendered structured preview, no live provider, no microphone.</div>
          </div>
        </div>
        <aside>
          <h2>Audit boundary</h2>
          <div class="status"><span class="dot" aria-hidden="true"></span>Sanitized</div>
          <ul>
            <li>No raw media</li>
            <li>No learner response</li>
            <li>No prompts</li>
            <li>No full notes</li>
          </ul>
        </aside>
      </section>
    </main>
  </body>
</html>`;
}

async function buildBrowserStoryManifest({ traceRetained }) {
  return {
    schema: "viva.browser_story.v1",
    generated_at: new Date().toISOString(),
    validation_run_id: validationRunId,
    artifact_dir: path.relative(root, artifactDir),
    agent_provider: agentProvider,
    command_summary: {
      command: "bun run e2e:browser",
      provider: agentProvider,
      validation_run_id: validationRunId,
      artifact_dir: path.relative(root, artifactDir),
      browser: "playwright-chromium",
      capture_mode: "loopback-local",
      post_answer_source_folio_required: requirePostAnswerSourceFolio,
      stop_to_recap: stopToRecap,
    },
    fixture_hashes: await hashFixtureFiles(path.join(root, "agent/fixtures/voice-protocol")),
    frames: storyFrames,
    sanitized: true,
    trace_retained: traceRetained,
  };
}

async function writeAuditedBrowserStoryResult(baseResult) {
  const storyPath = path.join(artifactDir, "browser-story.json");
  const resultPath = path.join(artifactDir, "result.json");
  if (baseResult.trace) {
    await writeFile(storyPath, `${JSON.stringify(baseResult.browser_story, null, 2)}\n`);
    await writeFile(resultPath, `${JSON.stringify(baseResult, null, 2)}\n`);
    return baseResult;
  }
  let result = baseResult;
  for (let pass = 0; pass < 2; pass += 1) {
    await writeFile(storyPath, `${JSON.stringify(result.browser_story, null, 2)}\n`);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    const artifactAudit = await auditBrowserStoryArtifacts(artifactDir);
    result = {
      ...result,
      browser_story: {
        ...result.browser_story,
        artifact_audit: artifactAudit,
      },
    };
  }
  await writeFile(storyPath, `${JSON.stringify(result.browser_story, null, 2)}\n`);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
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

function conceptLabelText(conceptId) {
  const labels = {
    "atp-synthase": "ATP synthase",
    "cellular-respiration": "Cellular respiration",
    glycolysis: "Glycolysis",
    "krebs-cycle": "Krebs cycle",
    nadh: "NADH",
    "oxidative-phosphorylation": "Oxidative phosphorylation",
    photosynthesis: "Photosynthesis",
  };
  if (!conceptId || !labels[conceptId]) {
    throw new Error(`No canonical recap label is known for concept_id: ${conceptId ?? "missing"}`);
  }
  return labels[conceptId];
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
    conceptId: frame.event.concept_id ?? null,
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
      conceptId: conceptEvent?.conceptId ?? null,
      conceptStatus: conceptEvent?.conceptStatus ?? null,
      conceptStatusEventSeen: Boolean(conceptEvent),
      responseId: answerEvent.responseId,
      sourceReferenceEventSeen: Boolean(sourceEvent),
    };
  }
  return {
    conceptId: null,
    conceptStatus: null,
    conceptStatusEventSeen: false,
    responseId: null,
    sourceReferenceEventSeen: false,
  };
}

async function hashFixtureFiles(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const hashes = {};
  for (const name of names) {
    const bytes = await readFile(path.join(dir, name));
    hashes[name] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return hashes;
}

async function auditBrowserStoryArtifacts(dir) {
  const forbidden = [
    "pcm16_base64",
    "answer_text",
    "transcript_final",
    "source_context",
    "pasted_text",
    "session_token",
    "viva1.",
    "session-secret",
    "preload stroke volume cardiac output",
    "Stroke volume rises as ventricular preload",
    "NADH donates high-energy electrons",
    "received 4 PCM16 bytes",
    "CARTESIA_API_KEY",
    "GEMINI_API_KEY",
    "viva-release-check-cartesia-placeholder-key",
    "viva-release-check-gemini-placeholder-key",
    "Bearer ",
  ];
  let scanned_files = 0;
  for (const file of await listFiles(dir)) {
    if (file.endsWith(".zip")) {
      throw new Error(
        `Browser story artifact includes retained trace archive: ${path.relative(root, file)}`,
      );
    }
    if (!isTextArtifact(file)) continue;
    scanned_files += 1;
    const text = await readFile(file, "utf8");
    for (const needle of forbidden) {
      if (text.includes(needle)) {
        throw new Error(
          `Browser story artifact ${path.relative(root, file)} includes forbidden marker: ${needle}`,
        );
      }
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
      if (value && value.length >= 8 && text.includes(value)) {
        throw new Error(
          `Browser story artifact ${path.relative(root, file)} includes secret value from ${name}`,
        );
      }
    }
  }
  return {
    scanned_files,
    forbidden_hits: 0,
  };
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isTextArtifact(file) {
  return /\.(json|log|txt|stdout|stderr)$/i.test(file);
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
