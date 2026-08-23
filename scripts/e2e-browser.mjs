#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  buildFailureControlPlan,
  failureControlHarnessEvidence,
  failureControlScenarioMarker,
  failureControlSessionTargetForScenario,
  failureControlStartIdentity,
  isFailureControlSessionTokenScenario,
  parseFailureControlSessionTarget,
} from "./failure-control-harness.mjs";
import {
  buildHostedBrowserEvidence,
  HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS,
  hostedEvidenceStageForScenario,
  withHostedEvidenceAudit,
} from "./hosted-e2e-matrix.mjs";
import { auditTextArtifacts } from "./redaction-control.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.resolve(
  root,
  process.env.VIVA_E2E_ARTIFACT_DIR ?? "artifacts/e2e-browser",
);
const hostedWebUrl = optionalHostedHttpUrl("VIVA_E2E_HOSTED_WEB_URL");
const hostedAgentHttpUrl = optionalHostedHttpUrl("VIVA_E2E_HOSTED_AGENT_HTTP_URL");
const hostedAgentWsUrl = optionalHostedWsUrl("VIVA_E2E_HOSTED_AGENT_WS_URL");
const hostedMode = Boolean(hostedWebUrl || hostedAgentHttpUrl || hostedAgentWsUrl);
if (hostedMode && !(hostedWebUrl && hostedAgentHttpUrl && hostedAgentWsUrl)) {
  throw new Error(
    "Hosted browser E2E requires VIVA_E2E_HOSTED_WEB_URL, VIVA_E2E_HOSTED_AGENT_HTTP_URL, and VIVA_E2E_HOSTED_AGENT_WS_URL together.",
  );
}
const hostedRestBearerToken = process.env.VIVA_E2E_HOSTED_REST_BEARER_TOKEN?.trim() ?? "";
if (hostedMode && !hostedRestBearerToken) {
  throw new Error("Hosted browser E2E requires VIVA_E2E_HOSTED_REST_BEARER_TOKEN.");
}
const agentPort = hostedMode ? null : await freePort();
const webPort = hostedMode ? null : await freePort();
const agentUrl = hostedAgentHttpUrl ?? `http://127.0.0.1:${agentPort}`;
const webUrl = hostedWebUrl ?? `http://127.0.0.1:${webPort}`;
const wsUrl = hostedAgentWsUrl ?? `ws://127.0.0.1:${agentPort}/ws`;
const hostedAgentReadinessFetchOptions = hostedMode
  ? authenticatedHostedFetchOptions(hostedRestBearerToken)
  : undefined;
const agentProvider = process.env.VIVA_E2E_AGENT_PROVIDER ?? "synthetic";
const failureControlEnv = buildE2EFailureControlEnv();
const failureControlPlan = buildFailureControlPlan({
  env: { ...process.env, ...failureControlEnv },
});
const failureControlEvidence = failureControlHarnessEvidence(failureControlPlan);
const failureControlIdentity = failureControlPlan.enabled
  ? failureControlStartIdentity(failureControlPlan)
  : null;
const sessionTokenFailureScenario =
  failureControlPlan.enabled && isFailureControlSessionTokenScenario(failureControlPlan.scenario);
const allowedBrowserStoryProviders = new Set(["synthetic", "fake_cartesia_gemini"]);
const VIVA_VOICE_PROTOCOL_VERSION = 5;
const durableStateReleaseClaimed =
  process.env.VIVA_E2E_DURABLE_STATE_RELEASE_CLAIMED === "1" ||
  process.env.VIVA_RELEASE_DURABLE_STATE_CLAIMED === "1";
if (!allowedBrowserStoryProviders.has(agentProvider)) {
  throw new Error(
    `BAC-307 browser-story capture only supports non-live providers: ${[
      ...allowedBrowserStoryProviders,
    ].join(", ")}.`,
  );
}
const stopToRecap = process.env.VIVA_E2E_STOP_TO_RECAP === "1";
const hostedScenarioId =
  process.env.VIVA_E2E_HOSTED_SCENARIO_ID?.trim() || defaultHostedScenarioId();
const deterministicPartialRecapScenario = hostedScenarioId === "deterministic_partial_recap";
const traceRequested = process.env.VIVA_E2E_TRACE === "1";
if (hostedMode && traceRequested) {
  throw new Error("Hosted browser E2E cannot retain Playwright traces.");
}
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
const websocketUrls = [];
let browser;
let context;
let page;
let traceStarted = false;
let traceArtifact = null;
const storyFrames = [];
let hostedSecondTabIdentity = null;
let sessionUrlLifecycle = null;
let sourceFolioVisible = false;
let boundedSourceVisible = false;
let correctionMarginaliaVisible = false;
let writtenAnswerFallbackUsed = false;
let hostedWebSocketVerified = false;
let postAnswerSourceFolioVisible = false;
let postAnswerBoundedSourceVisible = false;
let secondTabSessionCap = null;
let postAnswerProtocolProof = {
  conceptId: null,
  conceptStatus: null,
  conceptStatusEventSeen: false,
  latencyMs: null,
  responseId: null,
  sourceReferenceEventSeen: false,
};
let failureControlTerminalProof = null;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  const agent = hostedMode
    ? null
    : spawnLogged(
        "agent",
        "cargo",
        ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service"],
        {
          VIVA_AGENT_BIND_ADDR: `127.0.0.1:${agentPort}`,
          VIVA_AGENT_PROVIDER: agentProvider,
          VIVA_VOICE_SESSION_TOKEN_SECRET: failureControlPlan.enabled
            ? failureControlEnv.VIVA_VOICE_SESSION_TOKEN_SECRET
            : "",
          VIVA_VOICE_WS_ALLOWED_ORIGINS: failureControlPlan.enabled ? webUrl : "",
          ...failureControlEnv,
        },
      );
  const agentReadiness = await waitForHttpJson(
    `${agentUrl}/ready`,
    (json) => {
      return json?.ready === true && json?.brain?.provider === agentProvider;
    },
    120_000,
    `${agentProvider} agent readiness`,
    hostedAgentReadinessFetchOptions,
  );

  const web = hostedMode
    ? null
    : spawnLogged(
        "web",
        "bun",
        [
          "run",
          "--cwd",
          "apps/web",
          "dev",
          "--",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(webPort),
        ],
        {
          NEXT_PUBLIC_VIVA_AGENT_WS_URL: wsUrl,
          NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: agentUrl,
          NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID: failureControlIdentity?.userId ?? "user-1",
          NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID:
            failureControlIdentity?.studySetId ?? "biology-midterm",
          NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID: "voice-session-1",
        },
      );
  await waitForHttp(webUrl, 120_000, "Next.js app");

  browser = await launchChromium();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(["microphone"], { origin: webUrl });
  if (traceRequested) {
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
    websocketUrls.push(socket.url());
    socket.on("framereceived", (frame) => recordServerFramePayload(frame.payload, serverEvents));
  });

  await capturePendingLocalPreview(page);
  await page.goto(webUrl, { waitUntil: "networkidle" });
  const startActionButton = failureControlPlan.enabled
    ? page.getByRole("button", { name: /^Start / }).first()
    : page.getByRole("button", { name: "Review missed concepts" });
  await startActionButton.waitFor({
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
  let manuscriptReady = false;
  if (failureControlPlan.enabled) {
    const signedStartTarget = await fetchSignedSessionStartTarget(
      page,
      failureControlStartIdentity(failureControlPlan),
    );
    const scenarioStartTarget = failureControlSessionTargetForScenario(
      signedStartTarget,
      failureControlPlan.scenario,
      {
        sessionSecret: failureControlEnv.VIVA_VOICE_SESSION_TOKEN_SECRET,
      },
    );
    if (scenarioStartTarget.preconsume_replay) {
      await consumeFailureControlReplayToken(page, signedStartTarget);
    }
    await navigateToSessionTarget(page, scenarioStartTarget.target);
  } else if (hostedMode) {
    const identity = hostedSyntheticIdentity();
    assertHostedSyntheticIdentity(identity);
    hostedSecondTabIdentity = identity;
    const signedStartTarget = await fetchSignedSessionStartTarget(page, identity);
    await navigateToSessionTarget(page, signedStartTarget);
  } else {
    await startActionButton.click();
  }
  await waitForSessionUrl(page, 20_000);
  if (sessionTokenFailureScenario) {
    failureControlTerminalProof = await waitForFailureControlTerminal(
      serverEvents,
      failureControlPlan,
      25_000,
    );
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(artifactDir, "failure-control-terminal.png"),
      fullPage: true,
    });
    storyFrames.push({
      id: "failure_control_terminal",
      kind: "browser_screen",
      screenshot: "failure-control-terminal.png",
      checks: ["auth_rejected", "sanitized_failure_control", "auth_material_recovery_path"],
    });
  } else {
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
    await page.getByRole("button", { name: "Acknowledge" }).click();
    await page.getByRole("button", { name: "Acknowledge" }).waitFor({
      state: "hidden",
      timeout: 10_000,
    });
    const listeningText =
      agentProvider === "synthetic"
        ? "Synthetic examiner is listening."
        : "Non-live provider test is listening.";
    await page.getByText(listeningText).waitFor({
      state: "visible",
      timeout: 20_000,
    });
    manuscriptReady = await isVisible(page.getByText(listeningText));
    if (hostedMode) {
      assertHostedWebSocketTarget(websocketUrls, wsUrl);
      hostedWebSocketVerified = true;
    }
    if (!failureControlPlan.enabled) {
      const secondTabTarget = hostedMode
        ? await fetchSignedSessionStartTarget(
            page,
            hostedSecondTabIdentity ?? hostedSyntheticIdentity(),
          )
        : page.url();
      secondTabSessionCap = await auditSecondTabSessionCap(context, secondTabTarget);
    }
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
      const answerResolutionStartedAt = Date.now();
      await page.getByRole("button", { name: /check it/i }).click();
      writtenAnswerFallbackUsed = await submitWrittenAnswerIfFallbackOpens(page);
      if (failureControlPlan.enabled) {
        failureControlTerminalProof = await waitForFailureControlTerminal(
          serverEvents,
          failureControlPlan,
          25_000,
        );
        await page.waitForTimeout(600);
        await page.screenshot({
          path: path.join(artifactDir, "failure-control-terminal.png"),
          fullPage: true,
        });
        storyFrames.push({
          id: "failure_control_terminal",
          kind: "browser_screen",
          screenshot: "failure-control-terminal.png",
          checks: ["terminal_reason", "sanitized_failure_control", "same_session_recovery_path"],
        });
      } else {
        postAnswerProtocolProof = await waitForPostAnswerProtocolProof(
          serverEvents,
          HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS,
          answerResolutionStartedAt,
        );
        if (requireCorrectionMarginalia) {
          await page.getByText("Marginalia", { exact: true }).waitFor({
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
            (await isVisible(page.getByText("Marginalia", { exact: true }).first())) &&
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
              page
                .getByText(conceptStatusText(postAnswerProtocolProof.conceptStatus), {
                  exact: false,
                })
                .first(),
            ));
          postAnswerBoundedSourceVisible =
            (await isVisible(
              page.getByText("Source citation is bounded to this span", { exact: false }).first(),
            )) && (await isVisible(page.getByText("Document span only", { exact: false }).first()));
          await redactSourceFolioForSanitizedScreenshot(page);
          await page.screenshot({
            path: path.join(artifactDir, "post-answer-source-folio.png"),
            fullPage: true,
          });
          await page.getByRole("button", { name: "Back to question" }).click();
        }
        await page.getByRole("button", { name: "End session" }).click();
      }
    }
  }
  const recapSummaryText =
    agentProvider === "synthetic"
      ? "Next, make the proton-gradient-to-ATP-synthase link explicit."
      : "The session stayed grounded to the server-owned source span.";
  let nextSessionRecommendationVisible = false;
  let recapPayloadVisible = false;
  if (!failureControlPlan.enabled) {
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
    nextSessionRecommendationVisible =
      (await isVisible(page.getByText("Next session", { exact: false }).first())) &&
      (await isVisible(page.getByText("core FSRS", { exact: false }).first()));
    const recapConceptProofVisible =
      stopToRecap ||
      (Boolean(postAnswerProtocolProof.conceptId) &&
        (await isVisible(
          page
            .getByText(conceptLabelText(postAnswerProtocolProof.conceptId), { exact: true })
            .first(),
        )));
    recapPayloadVisible =
      (await isVisible(page.getByText("Closing fold / Recap ready").first())) &&
      (await isVisible(page.getByText(recapSummaryText, { exact: false }).first())) &&
      recapConceptProofVisible &&
      (await isVisible(page.getByText("Conductor next action", { exact: false }).first()));
  }
  const shareVisible = await isVisible(page.getByRole("button", { name: "Share" }));
  const localScheduleVisible = await isVisible(
    page.getByRole("button", { name: /Schedule a short source-backed review tomorrow/ }),
  );
  if (!failureControlPlan.enabled) {
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
  }
  if (traceStarted) {
    await context.tracing.stop({ path: path.join(artifactDir, "trace.zip") });
    traceArtifact = "trace.zip";
    traceStarted = false;
  }
  sessionUrlLifecycle = await auditSessionUrlLifecycle(context);

  const browserStory = await buildBrowserStoryManifest({
    traceRetained: Boolean(traceArtifact),
  });
  const screenshots = [
    "pending-local-preview.png",
    "server-ready-study-set.png",
    ...(!sessionTokenFailureScenario ? ["session-ready.png", "source-folio.png"] : []),
    ...(correctionMarginaliaVisible ? ["correction-marginalia.png"] : []),
    ...(!failureControlPlan.enabled && !stopToRecap && requirePostAnswerSourceFolio
      ? ["post-answer-source-folio.png"]
      : []),
    ...(secondTabSessionCap ? ["second-tab-session-cap.png"] : []),
    ...(failureControlPlan.enabled
      ? ["failure-control-terminal.png"]
      : ["connected-terminal-fold.png"]),
  ];
  const deterministicPartialRecapTerminalProof =
    deterministicPartialRecapScenario && recapPayloadVisible
      ? terminalProofFromServerEvents(serverEvents, {
          failureClass: "partial_stage_success",
          scenarioId: hostedScenarioId,
          stage: "websocket",
          terminalReason: "partial_stage_success",
        })
      : null;
  const terminalProof = failureControlTerminalProof ?? deterministicPartialRecapTerminalProof;
  const terminalReason =
    terminalProof?.terminal_reason ??
    (deterministicPartialRecapScenario ? null : recapPayloadVisible ? "completed" : null);
  const hostedEvidenceStage = hostedEvidenceStageForScenario({
    deterministicPartialRecap: Boolean(deterministicPartialRecapTerminalProof),
    failureControlStage: terminalProof?.stage ?? null,
    recapVisible: recapPayloadVisible,
    scenarioId: hostedScenarioId,
  });
  let result = {
    artifact_dir: path.relative(root, artifactDir),
    agent_provider: agentProvider,
    agent_url: agentUrl,
    hosted_mode: hostedMode,
    hosted_session_identity: hostedMode
      ? {
          study_set_id: hostedSyntheticIdentity().studySetId,
          synthetic_user_id: hostedSyntheticIdentity().userId,
        }
      : null,
    hosted_websocket_verified: hostedWebSocketVerified,
    store: summarizeStore(agentReadiness?.store),
    durable_state_release_claimed: durableStateReleaseClaimed,
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
    second_tab_session_cap_observed: secondTabSessionCap?.terminal_reason === "session_cap",
    second_tab_session_cap: secondTabSessionCap,
    deterministic_partial_recap_terminal: deterministicPartialRecapTerminalProof,
    failure_control_harness: failureControlEvidence,
    failure_control_terminal: failureControlTerminalProof,
    written_answer_fallback_used: writtenAnswerFallbackUsed,
    local_only_actions_hidden: !shareVisible && !localScheduleVisible,
    session_url_lifecycle: sessionUrlLifecycle,
    hosted_e2e: buildHostedBrowserEvidence({
      agentUrl,
      controlMode: failureControlPlan.enabled ? "failure_control" : "none",
      deployIds: hostedDeployIds(),
      deploySha: hostedDeploySha(),
      failureClass: terminalProof?.failure_class ?? null,
      hostedMode,
      latencyMs: postAnswerProtocolProof.latencyMs,
      postgresDurability: hostedPostgresDurability(),
      provider: agentProvider,
      recapSuccess: recapPayloadVisible,
      runId: process.env.VIVA_HOSTED_RUN_ID?.trim() || null,
      scenarioId: hostedScenarioId,
      screenshots,
      stage: hostedEvidenceStage,
      terminalReason,
      tokenRefreshOutcome:
        sessionUrlLifecycle?.passed === true ? "canonicalized_visible_url" : "not_observed",
      trace: traceArtifact,
      webUrl,
    }),
    browser_story: browserStory,
    browser_story_artifact: "browser-story.json",
    console_errors: consoleErrors,
    page_errors: pageErrors,
    screenshots,
    trace: traceArtifact,
  };
  result = await writeAuditedBrowserStoryResult(result);

  if (legacyUploadVisible) throw new Error("Landing mounted the retired legacy upload app.");
  if (!sessionTokenFailureScenario && !manuscriptReady) {
    throw new Error("Landing did not enter the connected manuscript.");
  }
  if (failureControlPlan.enabled) {
    if (
      failureControlTerminalProof?.terminal_reason !== failureControlPlan.scenario.terminal_reason
    ) {
      throw new Error("Failure-control run did not observe the selected terminal reason.");
    }
    if (
      sessionTokenFailureScenario &&
      failureControlTerminalProof?.token_recovery_path_verified !== true
    ) {
      throw new Error("Failure-control token scenario did not prove the token recovery path.");
    }
    if (!sessionTokenFailureScenario && failureControlTerminalProof?.stage_verified !== true) {
      throw new Error("Failure-control provider scenario did not prove the scenario stage marker.");
    }
  } else if (deterministicPartialRecapScenario && !deterministicPartialRecapTerminalProof) {
    throw new Error(
      "Deterministic partial recap scenario did not observe partial_stage_success terminal proof.",
    );
  } else {
    if (!recapPayloadVisible)
      throw new Error("Connected fake-provider session did not render the recap_ready payload.");
    if (!nextSessionRecommendationVisible) {
      throw new Error("Connected session did not render next-session review recommendations.");
    }
    if (secondTabSessionCap?.terminal_reason !== "session_cap") {
      throw new Error("Connected session did not prove second-tab session_cap rejection.");
    }
  }
  if (!sessionTokenFailureScenario && !sourceFolioVisible) {
    throw new Error("Connected session did not render the Source Folio.");
  }
  if (!sessionTokenFailureScenario && !boundedSourceVisible) {
    throw new Error("Connected session did not render bounded source folio proof.");
  }
  if (!failureControlPlan.enabled && requireCorrectionMarginalia && !correctionMarginaliaVisible) {
    throw new Error("Connected session did not render correction marginalia.");
  }
  if (
    !failureControlPlan.enabled &&
    !stopToRecap &&
    requirePostAnswerSourceFolio &&
    !postAnswerSourceFolioVisible
  ) {
    throw new Error("Connected session did not render the post-answer Source Folio.");
  }
  if (
    !failureControlPlan.enabled &&
    !stopToRecap &&
    requirePostAnswerSourceFolio &&
    !postAnswerBoundedSourceVisible
  ) {
    throw new Error("Connected session did not render post-answer bounded source folio proof.");
  }
  if (
    !failureControlPlan.enabled &&
    !stopToRecap &&
    requirePostAnswerSourceFolio &&
    !postAnswerProtocolProof.sourceReferenceEventSeen
  ) {
    throw new Error("Post-answer Source Folio did not observe a source_reference event.");
  }
  if (
    !failureControlPlan.enabled &&
    !stopToRecap &&
    requirePostAnswerSourceFolio &&
    !postAnswerProtocolProof.conceptStatusEventSeen
  ) {
    throw new Error("Post-answer Source Folio did not observe a concept_status event.");
  }
  if (shareVisible || localScheduleVisible) {
    throw new Error("Connected manuscript exposed local-only Share or schedule actions.");
  }
  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(`Browser errors detected: ${[...consoleErrors, ...pageErrors].join(" | ")}`);
  }

  console.log(JSON.stringify(result, null, 2));
  web?.stop();
  agent?.stop();
} catch (error) {
  const sanitizedError = redactSensitiveDiagnostic(
    error instanceof Error ? error.message : String(error),
  );
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
        error: sanitizedError,
        console_errors: consoleErrors.map(redactSensitiveDiagnostic),
        page_errors: pageErrors.map(redactSensitiveDiagnostic),
        artifact_dir: path.relative(root, artifactDir),
      },
      null,
      2,
    )}\n`,
  ).catch(() => {});
  throw new Error(sanitizedError);
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) {
    child.stop();
  }
}

function redactSensitiveDiagnostic(value) {
  return String(value)
    .replace(/#session_token=[^\s"'<>)]*/gi, "#redacted-session-fragment")
    .replace(/[?&]session_token=[^&\s"'<>)]*/gi, "?redacted_session_param=1")
    .replace(/viva1\.[A-Za-z0-9._-]+/g, "redacted-viva-token")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer redacted");
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

async function fetchSignedSessionStartTarget(targetPage, identity) {
  return targetPage.evaluate(async ({ userId, studySetId }) => {
    const libraryParams = new URLSearchParams({ user_id: userId });
    const response = await fetch(
      `/api/viva-library/study-sets/library?${libraryParams.toString()}`,
      {
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new Error(`hosted library action fetch failed with HTTP ${response.status}`);
    }
    const snapshot = await response.json();
    const studySet = snapshot.study_sets?.find((entry) => entry.id === studySetId);
    const action = studySet?.actions?.start;
    if (!studySet?.user_id || !action?.session_bootstrap_token) {
      throw new Error("hosted library action fetch did not return a bootstrap capability");
    }
    const startResponse = await fetch("/api/viva-session/start", {
      body: JSON.stringify({
        session_bootstrap_token: action.session_bootstrap_token,
        study_set_id: studySet.id,
        user_id: studySet.user_id,
      }),
      cache: "no-store",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!startResponse.ok) {
      throw new Error(`hosted session bootstrap failed with HTTP ${startResponse.status}`);
    }
    const sessionPayload = await startResponse.json();
    if (
      !sessionPayload?.session?.session_id ||
      !sessionPayload.session.study_set_id ||
      !sessionPayload.session.user_id ||
      !sessionPayload.session_token
    ) {
      throw new Error("hosted session bootstrap did not return a signed session token");
    }
    const params = new URLSearchParams({
      user_id: sessionPayload.session.user_id,
      study_set_id: sessionPayload.session.study_set_id,
      session_id: sessionPayload.session.session_id,
    });
    return `/session?${params.toString()}#session_token=${encodeURIComponent(
      sessionPayload.session_token,
    )}`;
  }, identity);
}

async function navigateToSessionTarget(targetPage, target) {
  const targetUrl = new URL(target, webUrl);
  const webOrigin = new URL(webUrl).origin;
  if (targetUrl.origin !== webOrigin) {
    throw new Error("Hosted signed session target origin did not match configured web origin.");
  }
  try {
    await targetPage.evaluate((href) => {
      window.location.assign(href);
    }, targetUrl.toString());
  } catch (error) {
    throw new Error(
      `Hosted signed session navigation failed before load: ${redactSensitiveDiagnostic(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
}

async function waitForSessionUrl(targetPage, timeoutMs) {
  const webOrigin = new URL(webUrl).origin;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = new URL(targetPage.url());
    if (current.origin === webOrigin && current.pathname === "/session") return;
    await delay(100);
  }
  throw new Error("Timed out waiting for signed hosted session navigation.");
}

function hostedSyntheticIdentity() {
  return {
    studySetId:
      process.env.VIVA_E2E_SYNTHETIC_STUDY_SET_ID?.trim() ||
      process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID?.trim() ||
      "biology-midterm",
    userId:
      process.env.VIVA_E2E_SYNTHETIC_USER_ID?.trim() ||
      process.env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID?.trim() ||
      "user-1",
  };
}

function defaultHostedScenarioId() {
  if (failureControlPlan.enabled) return failureControlPlan.scenario.id;
  if (agentProvider === "fake_cartesia_gemini") return "fake_provider_happy_path";
  return "happy_path";
}

function hostedDeployIds() {
  return {
    agent:
      process.env.VIVA_E2E_AGENT_DEPLOY_ID?.trim() ||
      process.env.VIVA_HOSTED_AGENT_DEPLOY_ID?.trim() ||
      null,
    web:
      process.env.VIVA_E2E_WEB_DEPLOY_ID?.trim() ||
      process.env.VIVA_HOSTED_WEB_DEPLOY_ID?.trim() ||
      null,
  };
}

function hostedDeploySha() {
  return (
    process.env.VIVA_E2E_DEPLOY_SHA?.trim() ||
    process.env.VIVA_HOSTED_DEPLOY_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    null
  );
}

function hostedPostgresDurability() {
  if (process.env.VIVA_E2E_POSTGRES_DURABLE === "1") return "durable";
  return hostedMode ? "hosted_not_asserted" : "loopback_not_asserted";
}

function assertHostedSyntheticIdentity(identity) {
  if (
    !/(synthetic|monitor|test)/i.test(identity.userId) ||
    /(learner|student)/i.test(identity.userId)
  ) {
    throw new Error("Hosted browser E2E requires a synthetic monitor user identity.");
  }
}

function assertHostedWebSocketTarget(urls, expectedUrl) {
  const expected = normalizeComparableWsUrl(expectedUrl);
  const observed = urls.map(normalizeComparableWsUrl);
  if (!observed.includes(expected)) {
    throw new Error(
      `Hosted browser E2E did not connect to configured agent WebSocket. Expected ${expected}; observed ${
        observed.map(redactedWebSocketUrl).join(", ") || "none"
      }`,
    );
  }
}

function normalizeComparableWsUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/g, "");
}

function redactedWebSocketUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/g, "");
}

async function consumeFailureControlReplayToken(targetPage, signedStartTarget) {
  const session = parseFailureControlSessionTarget(signedStartTarget);
  return targetPage.evaluate(
    async ({ protocolVersion, session, wsUrl }) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl, ["viva-voice"]);
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error("failure-control replay nonce preconsume timed out"));
        }, 10_000);
        let sentConfig = false;
        let observedQuestionMarker = false;
        socket.addEventListener("message", (event) => {
          let frame;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (frame?.type === "ready" && !sentConfig) {
            sentConfig = true;
            socket.send(
              JSON.stringify({
                type: "session_config",
                version: protocolVersion,
                session: {
                  active_concepts: [],
                  session_id: session.sessionId,
                  source_context: [],
                  study_set_id: session.studySetId,
                  user_id: session.userId,
                },
                session_token: session.sessionToken,
              }),
            );
            return;
          }
          if (frame?.type === "event" && frame.event?.type === "question_started") {
            observedQuestionMarker = true;
            socket.close();
          }
        });
        socket.addEventListener("close", () => {
          window.clearTimeout(timeout);
          if (!sentConfig || !observedQuestionMarker) {
            reject(
              new Error("failure-control replay nonce preconsume did not open a control turn"),
            );
            return;
          }
          resolve({ observed_question_marker: true, sanitized: true });
        });
        socket.addEventListener("error", () => {
          window.clearTimeout(timeout);
          reject(new Error("failure-control replay nonce preconsume websocket failed"));
        });
      }),
    { protocolVersion: VIVA_VOICE_PROTOCOL_VERSION, session, wsUrl },
  );
}

async function auditSecondTabSessionCap(browserContext, targetUrl) {
  const tabEvents = [];
  const secondTab = await browserContext.newPage();
  secondTab.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  secondTab.on("pageerror", (error) => pageErrors.push(error.message));
  secondTab.on("websocket", (socket) => {
    socket.on("framereceived", (frame) => recordServerFramePayload(frame.payload, tabEvents));
  });
  try {
    await secondTab.goto(targetUrl, { waitUntil: "domcontentloaded" });
    const proof = await waitForSecondTabSessionCap(tabEvents, 15_000);
    await secondTab.waitForTimeout(600);
    await secondTab.screenshot({
      path: path.join(artifactDir, "second-tab-session-cap.png"),
      fullPage: true,
    });
    storyFrames.push({
      id: "second_tab_session_cap",
      kind: "browser_screen",
      screenshot: "second-tab-session-cap.png",
      checks: ["single_active_session", "second_tab_rejected", "session_cap_terminal"],
      note: "Verified a second live tab for the same learner and study set receives a sanitized session_cap terminal.",
    });
    return proof;
  } finally {
    await secondTab.close().catch(() => {});
  }
}

async function waitForSecondTabSessionCap(events, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const eventIndex = events.findIndex(
      (event) => event.type === "session_phase" && event.terminalReason === "session_cap",
    );
    if (eventIndex >= 0) {
      return {
        outcome: "rejected",
        terminal_reason: "session_cap",
        event_index: eventIndex,
        validation_run_id: validationRunId,
        sanitized: true,
      };
    }
    await delay(100);
  }
  const terminalReasons = events
    .filter((event) => event.type === "session_phase" && event.terminalReason)
    .map((event) => event.terminalReason)
    .join(" -> ");
  throw new Error(
    `Timed out waiting for second-tab session_cap terminal. Saw terminal: ${
      terminalReasons || "none"
    }`,
  );
}

function buildE2EFailureControlEnv() {
  const scenario =
    process.env.VIVA_E2E_FAILURE_CONTROL_SCENARIO ?? process.env.VIVA_FAILURE_CONTROL_SCENARIO;
  const enabled =
    process.env.VIVA_FAILURE_CONTROL_ENABLED === "1" ||
    Boolean(process.env.VIVA_E2E_FAILURE_CONTROL_SCENARIO);
  if (!enabled) return {};
  if (!scenario?.trim()) {
    throw new Error(
      "VIVA_E2E_FAILURE_CONTROL_SCENARIO is required when failure control is enabled",
    );
  }
  return {
    VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS:
      process.env.VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS ?? webUrl,
    VIVA_FAILURE_CONTROL_ENABLED: "1",
    VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY:
      process.env.VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY ?? "1",
    VIVA_FAILURE_CONTROL_SCENARIO: scenario.trim(),
    VIVA_FAILURE_CONTROL_SECRET:
      process.env.VIVA_FAILURE_CONTROL_SECRET ?? "local-e2e-failure-control-secret",
    VIVA_FAILURE_CONTROL_STUDY_SET_IDS:
      process.env.VIVA_FAILURE_CONTROL_STUDY_SET_IDS ?? "biology-midterm",
    VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS:
      process.env.VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS ?? "user-1",
    VIVA_VOICE_SESSION_TOKEN_SECRET:
      process.env.VIVA_VOICE_SESSION_TOKEN_SECRET ?? "local-e2e-session-token-secret",
  };
}

async function submitWrittenAnswerIfFallbackOpens(targetPage) {
  const answerInput = targetPage.getByRole("textbox", { name: "Student written answer" });
  if (!(await isVisible(answerInput))) return false;
  await answerInput.fill("NADH donates electrons to the electron transport chain.");
  await targetPage.getByRole("button", { name: "Submit written answer" }).click();
  return true;
}

async function auditSessionUrlLifecycle(browserContext) {
  const auditPage = await browserContext.newPage();
  auditPage.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  auditPage.on("pageerror", (error) => pageErrors.push(error.message));
  await auditPage.addInitScript(() => {
    const tokenParamNames = ["session_token", "token"];
    const hasTokenParam = (search, hash) => {
      const searchParams = new URLSearchParams(search);
      const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
      const hashParams = rawHash.includes("=")
        ? new URLSearchParams(rawHash)
        : new URLSearchParams();
      return tokenParamNames.some((name) => searchParams.has(name) || hashParams.has(name));
    };
    window.__vivaSessionUrlBfcacheEvents = [];
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      window.__vivaSessionUrlBfcacheEvents.push({
        pathname: location.pathname,
        token_param_visible: hasTokenParam(location.search, location.hash),
      });
    });
  });

  const checks = [];
  try {
    for (const scenario of [
      ["initial_load", `/session#session_token=${bootstrapToken("initial")}`],
      ["expired_token", `/session#session_token=${bootstrapToken("expired")}`],
      ["replayed_token", `/session#session_token=${bootstrapToken("replayed")}`],
      ["malformed_token", "/session#session_token=%20%20"],
      ["no_token_canonical_url", "/session"],
    ]) {
      await auditPage.goto(`${webUrl}/`, { waitUntil: "domcontentloaded" });
      await auditPage.goto(`${webUrl}${scenario[1]}`, { waitUntil: "domcontentloaded" });
      checks.push(await waitForCanonicalSessionUrl(auditPage, scenario[0]));
    }

    await auditPage.goto(`${webUrl}/`, { waitUntil: "domcontentloaded" });
    await auditPage.goto(`${webUrl}/session#session_token=${bootstrapToken("history")}`, {
      waitUntil: "domcontentloaded",
    });
    checks.push(await waitForCanonicalSessionUrl(auditPage, "history_entry"));
    await auditPage.goBack({ waitUntil: "domcontentloaded" });
    await auditPage.waitForFunction(() => location.pathname === "/", undefined, {
      timeout: 10_000,
    });
    await auditPage.goForward({ waitUntil: "domcontentloaded" });
    const forwardCheck = await waitForCanonicalSessionUrl(auditPage, "back_forward_restore");
    checks.push(forwardCheck);
    const bfcacheEvents = await auditPage.evaluate(
      () => window.__vivaSessionUrlBfcacheEvents ?? [],
    );
    const bfcacheRestoreReplayedToken = bfcacheEvents.some((event) => event.token_param_visible);
    if (bfcacheRestoreReplayedToken) {
      throw new Error("BFCache restore replayed a token parameter in the visible session URL.");
    }
    await auditPage.reload({ waitUntil: "domcontentloaded" });
    const refreshCheck = await waitForCanonicalSessionUrl(auditPage, "refresh_recovery");
    checks.push(refreshCheck);
    await auditPage.waitForFunction(
      () =>
        document.querySelector('meta[name="referrer"]')?.getAttribute("content") === "no-referrer",
      undefined,
      { timeout: 10_000 },
    );

    storyFrames.push({
      id: "session_url_lifecycle",
      kind: "browser_url_audit",
      checks: checks.map((check) => check.id),
      note: "Verified /session canonical URL lifecycle without retaining token values in browser evidence.",
    });

    return {
      passed: true,
      checks: checks.map((check) => check.id),
      back_forward_replayed_token: forwardCheck.token_param_visible,
      bfcache_restore_observed: bfcacheEvents.length > 0,
      bfcache_restore_replayed_token: bfcacheRestoreReplayedToken,
      refresh_replayed_token: refreshCheck.token_param_visible,
      referrer_policy_meta: "no-referrer",
      token_values_redacted: true,
    };
  } finally {
    await auditPage.close().catch(() => {});
  }
}

function bootstrapToken(label) {
  return encodeURIComponent(`redacted-${label}-bootstrap`);
}

async function waitForCanonicalSessionUrl(targetPage, id) {
  await targetPage.waitForFunction(
    () => {
      const tokenParamNames = ["session_token", "token"];
      const searchParams = new URLSearchParams(location.search);
      const rawHash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
      const hashParams = rawHash.includes("=")
        ? new URLSearchParams(rawHash)
        : new URLSearchParams();
      return (
        location.pathname === "/session" &&
        tokenParamNames.every((name) => !searchParams.has(name) && !hashParams.has(name))
      );
    },
    undefined,
    { timeout: 10_000 },
  );
  const state = await targetPage.evaluate(() => {
    const tokenParamNames = ["session_token", "token"];
    const searchParams = new URLSearchParams(location.search);
    const rawHash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    const hashParams = rawHash.includes("=") ? new URLSearchParams(rawHash) : new URLSearchParams();
    return {
      pathname: location.pathname,
      token_param_visible: tokenParamNames.some(
        (name) => searchParams.has(name) || hashParams.has(name),
      ),
    };
  });
  if (state.pathname !== "/session" || state.token_param_visible) {
    throw new Error(`Session URL canonicalization failed for ${id}.`);
  }
  return { id, token_param_visible: state.token_param_visible };
}

async function redactSourceFolioForSanitizedScreenshot(targetPage) {
  await redactStudentHandForSanitizedScreenshot(targetPage);
  await redactLocatorText(
    targetPage.locator(".source-folio__excerpt p").first(),
    "Bounded source excerpt redacted in sanitized browser-story artifact.",
  );
}

async function redactCorrectionMarginaliaForSanitizedScreenshot(targetPage) {
  await redactStudentHandForSanitizedScreenshot(targetPage);
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
  await redactStudentHandForSanitizedScreenshot(targetPage);
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

async function redactStudentHandForSanitizedScreenshot(targetPage) {
  await redactLocatorText(
    targetPage.locator(".student-hand p").first(),
    "Student answer redacted in sanitized browser-story artifact.",
  );
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
      capture_mode: hostedMode ? "hosted" : "loopback-local",
      post_answer_source_folio_required: requirePostAnswerSourceFolio,
      stop_to_recap: stopToRecap,
    },
    fixture_hashes: await hashFixtureFiles(path.join(root, "agent/fixtures/voice-protocol")),
    frames: storyFrames,
    sanitized: true,
    trace_retained: traceRetained,
  };
}

function summarizeStore(store) {
  return {
    available: store?.available === true,
    backend: typeof store?.backend === "string" ? store.backend : null,
    durable: store?.durable === true,
    nonce_replay_protection: store?.nonce_replay_protection === true,
  };
}

async function writeAuditedBrowserStoryResult(baseResult) {
  const storyPath = path.join(artifactDir, "browser-story.json");
  const resultPath = path.join(artifactDir, "result.json");
  let result = baseResult;
  for (let pass = 0; pass < 2; pass += 1) {
    await writeFile(storyPath, `${JSON.stringify(result.browser_story, null, 2)}\n`);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    const artifactAudit =
      result.browser_story.trace_retained && !hostedMode
        ? skippedLocalTraceArtifactAudit()
        : await auditBrowserStoryArtifacts(artifactDir);
    result = withHostedEvidenceAudit(
      {
        ...result,
        browser_story: {
          ...result.browser_story,
          artifact_audit: artifactAudit,
        },
      },
      artifactAudit,
    );
  }
  await writeFile(storyPath, `${JSON.stringify(result.browser_story, null, 2)}\n`);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function skippedLocalTraceArtifactAudit() {
  return {
    forbidden_hits: 0,
    scanned_files: 0,
    skipped: "local_trace_retained",
  };
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

function authenticatedHostedFetchOptions(bearerToken) {
  const headers = new Headers();
  headers.set("Authorization", ["Bearer", bearerToken].join(" "));
  return { headers };
}

async function waitForHttpJson(url, predicate, timeoutMs, label, fetchOptions) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    const earlyExit = children.find((child) => child.exited && child.exitCode !== 0);
    if (earlyExit) {
      throw new Error(`${label} dependency exited early with ${earlyExit.exitCode}`);
    }
    try {
      const response = await fetch(url, fetchOptions);
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
  if (frame?.type === "error") {
    const sessionAuthError = isSessionAuthErrorMessage(frame.message);
    events.push({
      message: sessionAuthError ? frame.message : "[redacted]",
      terminalReason: sessionAuthError ? "session_auth_rejected" : null,
      type: "server_error",
    });
    return;
  }
  if (frame?.type !== "event" || typeof frame.event?.type !== "string") return;

  events.push({
    conceptId: frame.event.concept_id ?? null,
    conceptStatus: frame.event.status ?? null,
    responseId: frame.event.response_id ?? null,
    sourceId: frame.event.source?.source_id ?? null,
    terminalReason: frame.event.terminal_reason ?? null,
    type: frame.event.type,
  });
}

function isSessionAuthErrorMessage(message) {
  return message === "invalid session token" || message === "session auth failed";
}

function terminalProofFromServerEvents(
  events,
  { failureClass, scenarioId, stage, terminalReason },
) {
  const eventIndex = events.findIndex(
    (event) => event.type === "session_phase" && event.terminalReason === terminalReason,
  );
  if (eventIndex < 0) return null;
  return {
    scenario_id: scenarioId,
    failure_class: failureClass,
    stage,
    terminal_reason: terminalReason,
    event_index: eventIndex,
    validation_run_id: validationRunId,
    sanitized: true,
  };
}

async function waitForFailureControlTerminal(events, plan, timeoutMs) {
  const expectedTerminalReason = plan.scenario.terminal_reason;
  const scenarioMarker = failureControlScenarioMarker(plan.scenario);
  const tokenScenario = isFailureControlSessionTokenScenario(plan.scenario);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (tokenScenario) {
      const eventIndex = events.findIndex(
        (event) => event.type === "server_error" && event.terminalReason === expectedTerminalReason,
      );
      if (eventIndex >= 0) {
        return {
          scenario_id: plan.scenario.id,
          failure_class: plan.scenario.failure_class,
          stage: plan.scenario.stage,
          terminal_reason: expectedTerminalReason,
          event_index: eventIndex,
          token_recovery_path_verified: true,
          validation_run_id: validationRunId,
          sanitized: true,
        };
      }
    } else {
      const markerIndex = events.findIndex(
        (event) => event.type === "question_started" && event.responseId === scenarioMarker,
      );
      const eventIndex = events.findIndex(
        (event, index) =>
          index > markerIndex &&
          event.type === "session_phase" &&
          event.terminalReason === expectedTerminalReason,
      );
      if (markerIndex >= 0 && eventIndex >= 0) {
        return {
          scenario_id: plan.scenario.id,
          failure_class: plan.scenario.failure_class,
          stage: plan.scenario.stage,
          terminal_reason: expectedTerminalReason,
          event_index: eventIndex,
          scenario_marker_response_id: scenarioMarker,
          scenario_marker_event_index: markerIndex,
          stage_verified: true,
          validation_run_id: validationRunId,
          sanitized: true,
        };
      }
    }
    await delay(100);
  }
  const terminalReasons = events
    .filter((event) => event.type === "session_phase" && event.terminalReason)
    .map((event) => event.terminalReason)
    .join(" -> ");
  const serverErrors = events
    .filter((event) => event.type === "server_error")
    .map((event) => event.terminalReason ?? event.message)
    .join(" -> ");
  throw new Error(
    `Timed out waiting for failure-control ${plan.scenario.id} terminal reason ${expectedTerminalReason}. Saw terminal: ${
      terminalReasons || "none"
    }; server_errors: ${serverErrors || "none"}`,
  );
}

async function waitForPostAnswerProtocolProof(events, timeoutMs, answerResolutionStartedAt = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const proof = postAnswerProtocolProofFromEvents(events, answerResolutionStartedAt);
    if (proof.sourceReferenceEventSeen && proof.conceptStatusEventSeen) return proof;
    await delay(100);
  }
  const eventTypes = events.map((event) => event.type).join(" -> ");
  throw new Error(
    `Timed out waiting for post-answer source_reference and concept_status events. Saw: ${eventTypes}`,
  );
}

function postAnswerProtocolProofFromEvents(events, answerResolutionStartedAt = null) {
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
      latencyMs:
        Number.isFinite(answerResolutionStartedAt) && answerResolutionStartedAt > 0
          ? Math.max(0, Date.now() - answerResolutionStartedAt)
          : null,
      responseId: answerEvent.responseId,
      sourceReferenceEventSeen: Boolean(sourceEvent),
    };
  }
  return {
    conceptId: null,
    conceptStatus: null,
    conceptStatusEventSeen: false,
    latencyMs: null,
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
  return auditTextArtifacts([dir], {
    context: "Browser story artifact",
    rootDir: root,
    zipMessage: (relative) => `Browser story artifact includes retained trace archive: ${relative}`,
  });
}

function optionalHostedHttpUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use http:// or https://`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.toString().replace(/\/$/g, "");
}

function optionalHostedWsUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`${name} must use ws:// or wss://`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/g, "");
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
