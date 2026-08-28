#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { childEnvironmentFor } from "./child-environment.mjs";
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
import {
  awaitPortBound,
  freePort,
  installSignalCleanup,
  spawnManaged,
  spawnWithPortRetry,
  SUPERVISOR_DEFAULT_GRACE_MS,
} from "./process-supervisor.mjs";
import { auditTextArtifacts } from "./redaction-control.mjs";
import {
  isReleaseVoiceTerminalReason,
  RELEASE_VOICE_SERVER_FRAME_INVALID,
  ReleaseContractValidationError,
  releaseProtocolVersionFromServerFrame,
  validatedVoiceFrameForRelease,
} from "./release-contract-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.resolve(
  root,
  process.env.VIVA_E2E_ARTIFACT_DIR ?? "artifacts/e2e-browser",
);
const hostedWebUrl = optionalHostedHttpUrl("VIVA_E2E_HOSTED_WEB_URL");
const hostedAgentHttpUrl = optionalHostedHttpUrl("VIVA_E2E_HOSTED_AGENT_HTTP_URL");
const hostedAgentWsUrl = optionalHostedWsUrl("VIVA_E2E_HOSTED_AGENT_WS_URL");
const hostedMode = Boolean(hostedWebUrl || hostedAgentHttpUrl || hostedAgentWsUrl);
const hostedRestBearerToken = process.env.VIVA_E2E_HOSTED_REST_BEARER_TOKEN?.trim() ?? "";
// RELEASE-015: loopback ports are allocated inside main() through the shared
// bounded-retry boundary, not by an import-time `freePort()` probe whose
// socket is already closed by the time a child tries to bind it.
let agentPort = null;
let webPort = null;
let agentUrl = hostedAgentHttpUrl ?? null;
let webUrl = hostedWebUrl ?? null;
let wsUrl = hostedAgentWsUrl ?? null;
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
const durableStateReleaseClaimed =
  process.env.VIVA_E2E_DURABLE_STATE_RELEASE_CLAIMED === "1" ||
  process.env.VIVA_RELEASE_DURABLE_STATE_CLAIMED === "1";
const stopToRecap = process.env.VIVA_E2E_STOP_TO_RECAP === "1";
const hostedScenarioId =
  process.env.VIVA_E2E_HOSTED_SCENARIO_ID?.trim() || defaultHostedScenarioId();
const deterministicPartialRecapScenario = hostedScenarioId === "deterministic_partial_recap";
const traceRequested = process.env.VIVA_E2E_TRACE === "1";
const validationRunId = `browser-story-${agentProvider}-${new Date()
  .toISOString()
  .replaceAll(/[:.]/g, "-")}`;
const requirePostAnswerSourceFolio =
  process.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO === undefined
    ? agentProvider === "synthetic"
    : process.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO === "1";
const requireCorrectionMarginalia = agentProvider === "synthetic" && !stopToRecap;
const requireVoiceTransportMatrix = process.env.VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX === "1";
const loopbackTestSkipAllowed = process.env.VIVA_ALLOW_LOOPBACK_TEST_SKIP === "1";
/**
 * W-07: the local story's own signed-start identity and the loopback secrets
 * both tiers must agree on.
 *
 * These are constructed local literals, not credentials: the agent child and
 * the web child are both spawned by this process onto freshly allocated
 * loopback ports and are torn down with it. They exist because the merged
 * D-07 Branch A landing contract mints a real, HMAC-signed session token at the
 * web tier and the agent verifies it -- a shared secret IS the contract, and a
 * harness that omitted it could only ever exercise the retired unsigned entry.
 * Both tiers independently require 32-512 bytes and refuse placeholder-shaped
 * values, so these are long, obviously-local, non-secret-shaped literals.
 */
const LOCAL_STORY_IDENTITY = Object.freeze({
  studySetId: "biology-midterm",
  userId: "user-1",
});
const LOCAL_STORY_SESSION_TOKEN_SECRET = "viva-local-e2e-session-token-material-0000";
const LOCAL_STORY_BOOTSTRAP_TOKEN_SECRET = "viva-local-e2e-bootstrap-token-material-0";
const LOCAL_STORY_AGENT_SCOPED_BEARER = "viva-local-e2e-agent-scoped-read-material0";
/**
 * W-07: the disposable durable database the local signed-session story needs.
 *
 * Supplied by the caller (a disposable container locally; Task 17's
 * `scripts/ci-durable-postgres.sh` in CI). It is a connection URL the harness
 * passes through unchanged, never a value copied by name out of the ambient
 * environment.
 */
const localAgentDatabaseUrl = process.env.VIVA_E2E_AGENT_DATABASE_URL?.trim() || "";
const localSignedSessionMode = !hostedMode && Boolean(localAgentDatabaseUrl);
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
/**
 * LEARN-012: the story's own on-screen half of the eight learning truths.
 *
 * Every field starts at the value that FAILS its check, so a step the story
 * never reached can never be credited: the reduction is fail-closed by
 * construction, not by a later guard.
 */
const learningTruthVisible = {
  authenticatedEntry: false,
  deferredMasteryVisible: true,
  deferredRecoveryVisible: false,
  disconnectionCopyVisible: true,
  evaluatedTurnVisible: false,
  examAt: null,
  honestBeginActionVisible: false,
  modeGoalCommandVisible: true,
  modeSuggestionChipsVisible: true,
  questionPromptVisible: false,
  recapVisible: false,
  recapVisibleAfterClose: false,
  reviewAuthorityVisible: false,
  secondQuestionPromptVisible: false,
};
const requireLearningTruth =
  !failureControlPlan.enabled &&
  !stopToRecap &&
  process.env.VIVA_E2E_REQUIRE_LEARNING_TRUTH !== "0";

async function main() {
  assertHarnessConfiguration();
  const signals = installSignalCleanup({
    cleanup: async () => {
      await stopLocalChildren();
      process.exit(1);
    },
  });

  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });

  try {
    if (!hostedMode) {
      // The web child needs its port before the agent starts (the agent's
      // allowed-origin list names the web origin), and both are allocated
      // through the bounded-retry boundary rather than a bare freePort().
      webPort = await freePort();
      webUrl = `http://127.0.0.1:${webPort}`;
    }
    const agent = hostedMode ? null : await spawnLocalAgent();
    if (!hostedMode) {
      agentUrl = `http://127.0.0.1:${agentPort}`;
      wsUrl = `ws://127.0.0.1:${agentPort}/ws`;
    }
    const agentReadiness = await waitForHttpJson(
      `${agentUrl}/ready`,
      (json) => {
        return json?.ready === true && json?.brain?.provider === agentProvider;
      },
      120_000,
      `${agentProvider} agent readiness`,
      hostedAgentReadinessFetchOptions,
    );

    const web = hostedMode ? null : await spawnLocalWeb();
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
    // A-29.1 / D-03 Branch B: 13A removed the suggestion chips, so the hero
    // carries exactly one honest affordance. Its presence is the landing
    // contract's own visible check.
    const heroBeginAction = page.getByRole("button", { name: "Begin oral exam" });
    await heroBeginAction.waitFor({ state: "visible", timeout: 20_000 });
    // LEARN-012 assertion 8, D-03 Branch B half: the selected branch signs no
    // mode/goal contract, so the proof is that the removed command surface and
    // the removed unsigned suggestion chips are absent while the one honest
    // affordance is present. Each locator names an affordance 13A actually
    // deleted (`LandingHero.test.tsx` pins the same three).
    learningTruthVisible.honestBeginActionVisible = await isVisible(heroBeginAction);
    learningTruthVisible.modeGoalCommandVisible =
      (await isVisible(page.getByRole("textbox", { name: /Where should Viva begin\?/i }))) ||
      (await isVisible(page.getByText("Answer out loud", { exact: false })));
    learningTruthVisible.modeSuggestionChipsVisible = await isVisible(
      page.getByRole("button", { name: /^(Quiz Lecture 5|Mock viva|Review missed concepts)/ }),
    );
    // W-07: the hero action is NOT the session entry. Under the merged
    // D-03B/D-07A landing contract the only affordance that reaches
    // `POST /api/viva-session/start` is the library row's signed-start action;
    // the hero's `landingSessionTarget()` navigates to a bare `/session` with no
    // credential (the pre-D-03B auto-start flow, which no longer exists), which
    // is exactly why the old harness produced zero start POSTs. Both the local
    // and the failure-control entries now cross the same signed boundary.
    const startActionButton = page.getByRole("button", { name: /^Start / }).first();
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
    // LEARN-012 assertion 1, entry half: every branch above crossed the merged
    // signed-start boundary -- `POST /api/viva-session/start` -- so the identity
    // the session runs on is authenticated rather than asserted by the harness.
    learningTruthVisible.authenticatedEntry = true;
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
      // LEARN-012 assertion 1, visible half.
      learningTruthVisible.questionPromptVisible = true;
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
          // LEARN-012 assertion 2, visible half: the graded turn is on screen,
          // bound to the same response id the persisted concept status names.
          learningTruthVisible.evaluatedTurnVisible = await isVisible(
            page
              .getByText(conceptStatusText(postAnswerProtocolProof.conceptStatus), { exact: false })
              .first(),
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
              )) &&
              (await isVisible(page.getByText("Document span only", { exact: false }).first()));
            await redactSourceFolioForSanitizedScreenshot(page);
            await page.screenshot({
              path: path.join(artifactDir, "post-answer-source-folio.png"),
              fullPage: true,
            });
            await page.getByRole("button", { name: "Back to question" }).click();
          }
          await observeLearningTruthProgression(page);
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
      // LEARN-012 assertion 6, visible half. Node 10 retired the hard-coded
      // "core FSRS" label together with the client-side scheduler that produced
      // it; what a learner now reads beside the date is the projection's own
      // authority, and the raw D-01 identifier stays on `data-authority`. This
      // harness waited on the retired copy, so it could never have reached a
      // green recap on the merged tree.
      const recapAuthority = page.locator('[data-authority="server_persisted_fsrs"]').first();
      await recapAuthority.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByText("Saved review schedule", { exact: false }).first().waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await page.getByText("Lecture 5", { exact: false }).first().waitFor({
        state: "visible",
        timeout: 10_000,
      });
      nextSessionRecommendationVisible =
        (await isVisible(page.getByText("Next session", { exact: false }).first())) &&
        (await isVisible(recapAuthority));
      learningTruthVisible.reviewAuthorityVisible = nextSessionRecommendationVisible;
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
      learningTruthVisible.recapVisible = recapPayloadVisible;
      // LEARN-012 assertion 7: the recap must still be what the learner reads
      // AFTER the socket has closed. The session is over once the recap lands
      // (the page stops its clock and readiness probe), so this observation is
      // taken here, and it must not be displaced by disconnection copy.
      learningTruthVisible.recapVisibleAfterClose = recapPayloadVisible;
      learningTruthVisible.disconnectionCopyVisible =
        (await isVisible(page.getByText("unexpected close", { exact: false }))) ||
        (await isVisible(page.getByText("Reconnecting", { exact: false }))) ||
        (await isVisible(page.getByText("Connection lost", { exact: false })));
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
    const voiceTransportMatrix = await collectVoiceTransportMatrix();
    const learningTruth = summarizeLearningTruth({
      required: requireLearningTruth,
      events: serverEvents,
      visible: learningTruthVisible,
    });

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
      voice_transport_matrix: voiceTransportMatrix,
      learning_truth: learningTruth,
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
        throw new Error(
          "Failure-control provider scenario did not prove the scenario stage marker.",
        );
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
    if (
      !failureControlPlan.enabled &&
      requireCorrectionMarginalia &&
      !correctionMarginaliaVisible
    ) {
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
    if (!voiceTransportMatrix.passed) {
      throw new Error(
        `Required voice transport matrix did not pass: ${voiceTransportMatrix.failures.join(" | ")}`,
      );
    }
    // Plan 04 LEARN-012 Step 3's eight assertions, as required visible checks.
    // Every failure line is built from identifiers, closed-vocabulary members,
    // counts, and booleans, so it is safe in `failure.json` and in the rethrown
    // harness error.
    if (!learningTruth.passed) {
      throw new Error(
        `Required learning-truth checks did not pass: ${learningTruth.failures.join(" | ")}`,
      );
    }
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`Browser errors detected: ${[...consoleErrors, ...pageErrors].join(" | ")}`);
    }

    console.log(JSON.stringify(result, null, 2));
    await web?.stop({ graceMs: SUPERVISOR_DEFAULT_GRACE_MS });
    await agent?.stop({ graceMs: SUPERVISOR_DEFAULT_GRACE_MS });
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
    await stopLocalChildren();
    signals.uninstall();
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
    note: "D-09 Branch B: harness-authored structured preview kept as non-product evidence, rendered from the sanitized pending-preview contract because the retired local upload UI is not mounted in the Listening Manuscript app; this frame must never satisfy required product-frame or release-proof checks.",
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

/**
 * RELEASE-028: the manual browser WebSocket validates every decoded frame
 * through the published validator *before* branching on it.
 *
 * The page has no schema of its own and never receives validator source: the
 * Node side exposes one binding, and the page gets back either the validated,
 * reconstructed frame or the single stable sanitized code. Its own client frame
 * is built on the Node side from the server's validated `ready` frame, so the
 * version can never be a stale literal (A-03).
 */
async function consumeFailureControlReplayToken(targetPage, signedStartTarget) {
  const session = parseFailureControlSessionTarget(signedStartTarget);
  const clientGenerationId = `${validationRunId}-replay-1`;
  const bindingName = "__vivaValidateServerFrameForRelease";
  const replaySession = {
    sessionId: session.sessionId,
    studySetId: session.studySetId,
    userId: session.userId,
    sessionToken: session.sessionToken,
  };

  await targetPage.exposeFunction(bindingName, (rawFrame) => {
    try {
      return { ok: true, frame: validatedVoiceFrameForRelease(rawFrame) };
    } catch (error) {
      return { ok: false, code: error?.code ?? "voice_server_frame_invalid" };
    }
  });
  await targetPage.exposeFunction(
    "__vivaReplaySessionConfigFrameForRelease",
    (readyFrame) =>
      failureControlReplayClientFrames({
        readyFrame,
        clientGenerationId,
        session: replaySession,
      }).sessionConfig,
  );

  return targetPage.evaluate(
    async ({ bindingName, wsUrl }) =>
      new Promise((resolve, reject) => {
        const validate = window[bindingName];
        const socket = new WebSocket(wsUrl, ["viva-voice"]);
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error("failure-control replay nonce preconsume timed out"));
        }, 10_000);
        let sentConfig = false;
        let observedQuestionMarker = false;
        let invalidFrameCode = null;
        socket.addEventListener("message", (event) => {
          let decoded;
          try {
            decoded = JSON.parse(String(event.data));
          } catch {
            invalidFrameCode = "voice_server_frame_invalid";
            return;
          }
          // Nothing below branches on the raw object: the validated
          // reconstruction is awaited first.
          void validate(decoded).then(async (result) => {
            if (!result.ok) {
              invalidFrameCode = result.code;
              return;
            }
            const frame = result.frame;
            if (frame.type === "ready" && !sentConfig) {
              sentConfig = true;
              const sessionConfig = await window.__vivaReplaySessionConfigFrameForRelease(decoded);
              socket.send(JSON.stringify(sessionConfig));
              return;
            }
            if (frame.type === "event" && frame.event.type === "question_started") {
              observedQuestionMarker = true;
              socket.close();
            }
          });
        });
        socket.addEventListener("close", () => {
          window.clearTimeout(timeout);
          if (invalidFrameCode) {
            reject(new Error(`failure-control replay observed ${invalidFrameCode}`));
            return;
          }
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
    { bindingName, wsUrl },
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

/**
 * LEARN-012 assertions 3 and 4: advance to a second question under the selected
 * D-02 progression, and observe a deferred turn's recovery surface.
 *
 * Both are observed rather than asserted here: the reduction in
 * `summarizeLearningTruth` is what decides, and it fails closed on anything
 * this function did not manage to see. The deferral surface is A-27.2's
 * display-only nudge -- reason copy and guidance, and deliberately no
 * client-side retry action, because answering again IS the retry.
 */
async function observeLearningTruthProgression(targetPage) {
  const nextQuestion = targetPage.getByRole("button", { name: "Next question" });
  if (await isVisible(nextQuestion)) {
    const startedBefore = serverEvents.filter((event) => event.type === "question_started").length;
    await nextQuestion.click();
    const advanced = await waitForServerEventCount("question_started", startedBefore + 1, 25_000);
    if (advanced) {
      const secondPrompt = serverEvents.filter((event) => event.type === "question_started").at(-1);
      // The heading is the `h1` a student reads. Its text is the prompt itself,
      // which never enters evidence -- only whether it became visible does.
      learningTruthVisible.secondQuestionPromptVisible =
        Boolean(secondPrompt?.questionId) &&
        (await isVisible(targetPage.locator("h1.question-stage__text").first()));
    }
  }
  if (serverEvents.some((event) => event.type === "turn_deferred")) {
    learningTruthVisible.deferredRecoveryVisible =
      (await isVisible(targetPage.getByText("That turn was not graded.", { exact: false }))) &&
      (await isVisible(
        targetPage.getByText("nothing was recorded against this concept", { exact: false }),
      ));
    // A-27.2: a deferral must render no mastery at all -- no status capsule
    // claiming a grade, and no client-side retry control.
    learningTruthVisible.deferredMasteryVisible =
      (await isVisible(targetPage.getByText("Concept status: strong", { exact: false }))) ||
      (await isVisible(targetPage.getByRole("button", { name: "Retry this question" })));
  }
}

/** Wait until the observed stream carries at least `count` events of `type`. */
async function waitForServerEventCount(type, count, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (serverEvents.filter((event) => event.type === type).length >= count) return true;
    await delay(100);
  }
  return false;
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

const SPAWN_LOGGED_ROLES = Object.freeze({
  agent: "local-browser-agent",
  audio: "local-browser-audio",
  web: "local-browser-web",
});

/**
 * RELEASE-015: `cargo run` and `bun run --cwd apps/web dev` are both wrappers.
 * Each execs a further process that owns the loopback port, so signalling the
 * wrapper's own pid left an agent-service or a Next dev server behind — which
 * the next run then either raced or, worse, talked to. Every local child is a
 * supervised process group, torn down with SIGTERM to the group, a bounded
 * grace, and SIGKILL only when the group refuses.
 */
function spawnLocalChild({ name, command, args, extraEnv = {}, logName = name }) {
  const role = SPAWN_LOGGED_ROLES[name];
  if (!role) {
    throw new Error(`spawnLocalChild: unknown local child "${name}"`);
  }
  const handle = spawnManaged({
    command,
    args,
    cwd: root,
    // RELEASE-029: the locally-spawned agent/web children never inherit this
    // process's own ambient environment — only the fixed operational
    // allowlist plus this role's own explicit, typed configuration.
    env: childEnvironmentFor(role, { parentEnv: process.env, explicit: extraEnv }),
    stdoutPath: path.join(artifactDir, `${logName}.stdout.log`),
    stderrPath: path.join(artifactDir, `${logName}.stderr.log`),
    label: `e2e ${logName}`,
  });
  children.push(handle);
  return handle;
}

async function stopLocalChildren() {
  for (const child of [...children].reverse()) {
    await child.stop({ graceMs: SUPERVISOR_DEFAULT_GRACE_MS }).catch(() => {});
  }
  children.length = 0;
}

async function spawnLocalAgent() {
  const started = await spawnWithPortRetry({
    label: "local agent-service",
    attempts: 2,
    start: ({ port }) => {
      agentPort = port;
      return spawnLocalChild({
        name: "agent",
        command: "cargo",
        args: ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service"],
        extraEnv: {
          VIVA_AGENT_BIND_ADDR: `127.0.0.1:${port}`,
          // W-07: signed-session mode is available to the local agent only over
          // a durable store, and its authenticated projection route only where
          // the scoped library-read credential exists beside the session-token
          // secret. Both ride the caller-supplied disposable database URL; with
          // no database the agent stays in its documented trusted-loopback mode
          // and `assertLocalSignedSessionSupport` refuses the story up front.
          VIVA_AGENT_DATABASE_URL: localAgentDatabaseUrl,
          VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN: localSignedSessionMode
            ? LOCAL_STORY_AGENT_SCOPED_BEARER
            : "",
          VIVA_AGENT_PROVIDER: agentProvider,
          VIVA_VOICE_SESSION_TOKEN_SECRET: failureControlPlan.enabled
            ? failureControlEnv.VIVA_VOICE_SESSION_TOKEN_SECRET
            : localSignedSessionMode
              ? LOCAL_STORY_SESSION_TOKEN_SECRET
              : "",
          VIVA_VOICE_WS_ALLOWED_ORIGINS: webUrl,
          ...failureControlEnv,
        },
      });
    },
    // A cold `cargo run` compiles the workspace before it binds anything.
    observeBind: ({ handle, port }) => awaitPortBound({ handle, port, timeoutMs: 600_000 }),
  });
  return started.value;
}

async function spawnLocalWeb() {
  return spawnLocalChild({
    name: "web",
    command: "bun",
    args: [
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
    extraEnv: {
      NEXT_PUBLIC_VIVA_AGENT_WS_URL: wsUrl,
      NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: agentUrl,
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID:
        failureControlIdentity?.userId ?? LOCAL_STORY_IDENTITY.userId,
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID:
        failureControlIdentity?.studySetId ?? LOCAL_STORY_IDENTITY.studySetId,
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID: "voice-session-1",
      // W-07: the merged D-07 Branch A server-side landing contract. Without
      // these the landing's Start action is structurally unavailable and no
      // page affordance can mint a session.
      VIVA_AGENT_HTTP_URL: agentUrl,
      VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN: LOCAL_STORY_AGENT_SCOPED_BEARER,
      // The landing server component reads the broad name for its own initial
      // snapshot fetch; the scoped names are what the route handlers use.
      VIVA_AGENT_REST_BEARER_TOKEN: LOCAL_STORY_AGENT_SCOPED_BEARER,
      VIVA_AGENT_SESSION_MINT_BEARER_TOKEN: LOCAL_STORY_AGENT_SCOPED_BEARER,
      VIVA_SESSION_ALLOWED_STUDY_SET_IDS:
        failureControlIdentity?.studySetId ?? LOCAL_STORY_IDENTITY.studySetId,
      VIVA_SESSION_ALLOWED_USER_IDS: failureControlIdentity?.userId ?? LOCAL_STORY_IDENTITY.userId,
      VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET: LOCAL_STORY_BOOTSTRAP_TOKEN_SECRET,
      VIVA_VOICE_SESSION_TOKEN_SECRET: failureControlPlan.enabled
        ? failureControlEnv.VIVA_VOICE_SESSION_TOKEN_SECRET
        : LOCAL_STORY_SESSION_TOKEN_SECRET,
      VIVA_WEB_CANONICAL_ORIGIN: webUrl,
      VIVA_WEB_SINGLE_INSTANCE: "1",
    },
  });
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
    const earlyExit = children.find(
      (child) => child.exitResult && (child.exitResult.code ?? child.exitResult.signal) !== 0,
    );
    if (earlyExit) {
      const status = earlyExit.exitResult.code ?? earlyExit.exitResult.signal;
      throw new Error(`${label} dependency exited early with ${status}`);
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

/**
 * RELEASE-028: nothing is read off a socket frame until the published strict
 * validator has accepted it.
 *
 * This reducer used to branch on a bare `JSON.parse` result — `frame.type`,
 * `frame.event.type`, `frame.event.terminal_reason` — and to read `frame.message`,
 * a member the v5 error frame does not have (the typed error moved under
 * `frame.error`). Both defects are structural: an unparsed or non-conforming
 * payload could set a terminal reason the story then reported as proof, and the
 * v4-shaped read silently produced `null` for every real auth rejection.
 */
function recordServerFramePayload(payload, events) {
  const text =
    typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : String(payload);
  let frame;
  try {
    frame = validatedVoiceFrameForRelease(JSON.parse(text));
  } catch (error) {
    // One stable sanitized code, never the offending payload.
    events.push({
      type: "invalid_server_frame",
      code: error?.code ?? "voice_server_frame_invalid",
      terminalReason: null,
    });
    return;
  }

  if (frame.type === "error") {
    events.push({
      errorCode: frame.error.code,
      // `error.message` is SERVER-authored free text. It is deliberately not
      // retained: `redactSensitiveDiagnostic` only strips token and bearer
      // shapes, so anything else in that string would reach `failure.json` and
      // the rethrown harness error verbatim. `code` is a closed typed
      // vocabulary and says everything a release diagnostic may say.
      retryable: frame.error.retryable,
      terminalReason: SESSION_AUTH_ERROR_CODES.has(frame.error.code)
        ? "session_auth_rejected"
        : null,
      type: "server_error",
    });
    return;
  }
  if (frame.type !== "event") return;

  const event = frame.event;
  events.push({
    conceptId: event.concept_id ?? event.question?.concept_id ?? null,
    conceptStatus: event.status ?? event.evaluation?.concept_status ?? null,
    responseId: event.response_id ?? null,
    sourceId: event.source?.source_id ?? null,
    terminalReason: isReleaseVoiceTerminalReason(event.terminal_reason)
      ? event.terminal_reason
      : null,
    type: event.type,
    // LEARN-012: the sanitized learning identifiers the truth reduction below
    // indexes. Every one is an identifier, a closed-vocabulary member, a
    // boolean, a count, or an RFC3339 instant -- never a prompt, transcript,
    // answer, feedback line, headline, or summary.
    ...learningTruthEventFields(event),
  });
}

/**
 * The sanitized learning-truth projection of one validated server event.
 *
 * Kept separate from the base record so the allowed-field decision is auditable
 * in one place: free text (`question.prompt`, `evaluation.answer_text`,
 * `evaluation.concise_feedback`, `recap.headline`, `recap.summary`,
 * `recap.next_action`, `concepts[].label`) is never copied out.
 */
function learningTruthEventFields(event) {
  switch (event.type) {
    case "question_started":
      return { questionId: event.question?.question_id ?? null, turnId: event.turn_id ?? null };
    case "turn_deferred":
      return {
        canRetrySameQuestion: event.can_retry_same_question === true,
        deferralReason: event.reason ?? null,
        questionId: event.question_id ?? null,
        turnId: event.turn_id ?? null,
      };
    case "answer_evaluated":
      return {
        evaluationLabel: event.evaluation?.label ?? null,
        questionId: event.evaluation?.question_id ?? null,
      };
    case "recap_ready":
      return {
        recapConcepts: (event.recap?.concepts ?? []).map((concept) => ({
          conceptId: concept.concept_id,
          status: concept.status,
        })),
        recapDeferredTurns: event.recap?.deferred_turns ?? null,
        recapPartial: event.partial === true,
        recapSchema: event.recap?.schema ?? null,
        reviewSchedule: (event.recap?.review_schedule ?? []).map((item) => ({
          authority: item.authority,
          conceptId: item.concept_id,
          dueAt: item.due_at,
        })),
      };
    default:
      return {};
  }
}

/** The typed v5 codes that mean "this session's credential was refused". */
const SESSION_AUTH_ERROR_CODES = new Set([
  "VOICE_AUTH_EXPIRED",
  "VOICE_AUTH_INVALID",
  "VOICE_AUTH_IDENTITY_MISMATCH",
  "VOICE_AUTH_REPLAYED",
]);

/**
 * RELEASE-028 / A-03: build the failure-control replay's client frames from the
 * protocol version the *server* advertised in its own validated `ready` frame.
 *
 * The recorded latent defect closed here: this path hand-wrote a
 * `session_config` frame at a local literal version and without
 * `client_generation_id`, so on a v5 server it was a v4 frame that would be
 * refused outright — invisible because the default release run never enables
 * the harness. There is no literal left to drift and no second schema: an
 * unacceptable ready frame throws before any client frame exists.
 */
function failureControlReplayClientFrames({ readyFrame, clientGenerationId, session }) {
  // The version is negotiated, so it may only come from the server's own
  // `ready` frame — not from whatever frame happened to arrive first.
  if (validatedVoiceFrameForRelease(readyFrame).type !== "ready") {
    throw new ReleaseContractValidationError(RELEASE_VOICE_SERVER_FRAME_INVALID);
  }
  const protocolVersion = releaseProtocolVersionFromServerFrame(readyFrame);
  return {
    protocolVersion,
    sessionConfig: {
      type: "session_config",
      version: protocolVersion,
      client_generation_id: clientGenerationId,
      session_token: session.sessionToken,
      session: {
        session_id: session.sessionId,
        user_id: session.userId,
        study_set_id: session.studySetId,
        mode: "quiz",
        source_context: [],
        active_concepts: [],
      },
    },
  };
}

/**
 * RELEASE-023: reduce the terminal claim out of the observed event stream. The
 * proof is an index into what the socket actually delivered, so a scenario flag
 * or a visible screen alone can never manufacture one.
 */
function terminalProofFromServerEvents(
  events,
  { failureClass, scenarioId, stage, terminalReason, validationRunId: runId = validationRunId },
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
    validation_run_id: runId,
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
  // Both halves are closed vocabularies: a sanitized terminal reason or the
  // typed v5 error code. No server-authored string reaches this text.
  const serverErrors = events
    .filter((event) => event.type === "server_error")
    .map((event) => event.terminalReason ?? event.errorCode)
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

/**
 * RELEASE-023: the post-answer proof is only as good as its binding. Both the
 * source reference and the concept status must name the *same* response id as
 * the evaluation and must arrive after it, so an earlier turn's events can
 * never be credited to this one.
 */
function postAnswerProtocolProofFromEvents(
  events,
  answerResolutionStartedAt = null,
  nowMs = Date.now(),
) {
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
          ? Math.max(0, nowMs - answerResolutionStartedAt)
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
  return value ? normalizeHostedHttpUrl(value, name) : null;
}

function optionalHostedWsUrl(name) {
  const value = process.env[name]?.trim();
  return value ? normalizeHostedWsUrl(value, name) : null;
}

/**
 * Hosted targets are compared and logged, so a configured URL is reduced to its
 * origin+path: query and fragment are exactly where a session token would ride.
 */
function normalizeHostedHttpUrl(value, name) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use http:// or https://`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.toString().replace(/\/$/g, "");
}

function normalizeHostedWsUrl(value, name) {
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

/**
 * Configuration that must hold before the story runs, checked here rather than
 * at import time so this module can be imported for its reducers alone.
 */
function assertHarnessConfiguration() {
  if (hostedMode && !(hostedWebUrl && hostedAgentHttpUrl && hostedAgentWsUrl)) {
    throw new Error(
      "Hosted browser E2E requires VIVA_E2E_HOSTED_WEB_URL, VIVA_E2E_HOSTED_AGENT_HTTP_URL, and VIVA_E2E_HOSTED_AGENT_WS_URL together.",
    );
  }
  if (hostedMode && !hostedRestBearerToken) {
    throw new Error("Hosted browser E2E requires VIVA_E2E_HOSTED_REST_BEARER_TOKEN.");
  }
  if (!allowedBrowserStoryProviders.has(agentProvider)) {
    throw new Error(
      `BAC-307 browser-story capture only supports non-live providers: ${[
        ...allowedBrowserStoryProviders,
      ].join(", ")}.`,
    );
  }
  if (hostedMode && traceRequested) {
    throw new Error("Hosted browser E2E cannot retain Playwright traces.");
  }
  assertLocalSignedSessionSupport();
}

/**
 * W-07: refuse a local run that cannot possibly reach an authenticated session,
 * up front and by name, instead of failing 20 seconds later on a disabled
 * button or an absent question heading.
 *
 * Three merged gates make a durable store a hard prerequisite of the local
 * story, and none of them belongs to this lane:
 *
 * 1. `validate_runtime_store_preflight` (agent-service config) refuses public
 *    signed-session mode over the in-memory store.
 * 2. Without a session-token secret the agent's library snapshot reports every
 *    start action `session_token_unavailable`, so the landing's Start control
 *    renders disabled and no affordance can reach `POST /api/viva-session/start`.
 * 3. The agent's authenticated projection route is constructed only where the
 *    scoped library-read credential and the session-token secret both exist,
 *    and `/session` opens its socket only once an
 *    `AuthenticatedStudyProjectionV1` has validated.
 *
 * The caller therefore supplies a disposable, migrated, fixture-seeded
 * Postgres. A run without one is refused rather than silently reduced to the
 * retired unsigned entry.
 */
function assertLocalSignedSessionSupport() {
  if (hostedMode || failureControlPlan.enabled || localSignedSessionMode) return;
  throw new Error(
    "Local browser E2E requires VIVA_E2E_AGENT_DATABASE_URL: a disposable, migrated, fixture-seeded PostgreSQL 16 URL. The merged agent refuses signed-session mode over a volatile store, its library snapshot then reports every start action session_token_unavailable, and /session opens no socket without an authenticated study projection -- so no local run without a durable store can reach an authenticated session.",
  );
}

// ---------------------------------------------------------------------------
// RELEASE-023: the required voice-transport matrix
//
// The claim this matrix has to support is specific: streamed microphone turns
// of 2, 10, and 45 seconds, captured at both common device rates, survive the
// production capture module, the production session controller, and the real
// Rust WebSocket service intact. Every cell is reduced out of the audio
// harness's own executed evidence; nothing here is satisfied by a screenshot,
// a flag, or a lower-layer unit test that matched zero cases.
// ---------------------------------------------------------------------------

export const VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS = Object.freeze([2, 10, 45]);
export const VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ = Object.freeze([44_100, 48_000]);
const VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES = 64 * 1024;
const VOICE_TRANSPORT_MAX_CHUNK_RAW_BYTES = 8_192;

/**
 * Project one `bun run e2e:browser:audio` result into matrix cells.
 *
 * A harness run that reported its own failures contributes nothing: a partly
 * broken run must leave a *missing* cell (which fails the matrix) rather than a
 * present-but-untrustworthy one.
 */
export function voiceTransportMatrixCellsFromAudioEvidence(result) {
  if (!result || result.evaluation?.passed !== true) return [];
  const observation = result.observation ?? {};
  const sourceRate =
    observation.capture_source_sample_rate_hz ?? result.source_sample_rate_hz ?? null;
  const turns = Array.isArray(observation.turns) ? observation.turns : [];
  return turns.map((turn) => ({
    duration_seconds: turn.seconds ?? null,
    source_sample_rate_hz: sourceRate,
    chunk_sample_rate_hz: observation.capture_target_sample_rate_hz ?? null,
    frames_sent: turn.chunks_sent ?? null,
    final_sequence: turn.final_sequence ?? null,
    max_chunk_raw_bytes: turn.max_chunk_raw_bytes ?? null,
    max_text_frame_bytes: result.max_text_frame_bytes ?? VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES,
    contiguous_sequence: turn.final_sequence === (turn.chunks_sent ?? 0) - 1,
    distinct_turn_ids: 1,
    turn_id: turn.turn_id ?? null,
    accepted_turn_id: turn.accepted_turn_id ?? null,
    accepted_final_sequence: turn.accepted_final_sequence ?? null,
    audio_end_status: turn.end_result_status ?? null,
    audio_turn_accepted_count: turn.acceptances ?? 0,
    transcript_final_count: Array.isArray(turn.transcripts) ? turn.transcripts.length : 0,
    answer_evaluated_count: turn.evaluations ?? 0,
    next_ready: turn.phase_after_turn === "correction" || turn.phase_after_turn === "question",
    closed_before_acceptance: turn.socket_status_after_turn !== "open",
    backpressure_reordered: Number(turn.chunk_send_statuses?.reordered ?? 0),
    backpressure_dropped: Number(
      (turn.chunk_send_statuses?.dropped ?? 0) + (turn.chunk_send_statuses?.socket_closed ?? 0),
    ),
    lower_layer_matches: 1,
  }));
}

/**
 * The required matrix contract. `required` is the caller's
 * `VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX` decision; when it is false the
 * summary is recorded but cannot fail the run.
 */
export function summarizeVoiceTransportMatrix({
  cells = [],
  negativeControl = null,
  required = false,
  loopbackSkipped = false,
} = {}) {
  const failures = [];
  const missing = [];
  const observed = new Map();
  for (const cell of cells) {
    observed.set(`${cell.source_sample_rate_hz}:${cell.duration_seconds}`, cell);
  }
  for (const rate of VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ) {
    for (const seconds of VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS) {
      if (!observed.has(`${rate}:${seconds}`)) {
        missing.push({ duration_seconds: seconds, source_sample_rate_hz: rate });
      }
    }
  }
  for (const entry of missing) {
    failures.push(
      `missing matrix cell: ${entry.duration_seconds}s at ${entry.source_sample_rate_hz} Hz`,
    );
  }
  if (loopbackSkipped) {
    failures.push("loopback proof was skipped: a skipped run can never satisfy the matrix");
  }
  for (const cell of cells) {
    failures.push(...voiceTransportCellFailures(cell));
  }
  if (!negativeControl || negativeControl.passed !== true || negativeControl.rejected !== true) {
    failures.push(
      "negative control missing: the pre-v5 single-frame (oversized single chunk) turn must be proven rejected",
    );
  }
  return {
    schema: "viva.voice_transport_matrix.v1",
    required,
    durations_seconds: [...VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS],
    source_sample_rates_hz: [...VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ],
    cells,
    negative_control: negativeControl,
    loopback_skipped: loopbackSkipped,
    missing_cells: missing,
    failures,
    passed: required ? failures.length === 0 : true,
    sanitized: true,
  };
}

function voiceTransportCellFailures(cell) {
  const label = `${cell.duration_seconds}s@${cell.source_sample_rate_hz}Hz`;
  const failures = [];
  const maxTextFrameBytes = cell.max_text_frame_bytes ?? VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES;
  if (maxTextFrameBytes > VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES) {
    failures.push(
      `${label}: serialized text frame exceeded the ${VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES}-byte cap`,
    );
  }
  if (
    (cell.max_chunk_raw_bytes ?? Number.POSITIVE_INFINITY) > VOICE_TRANSPORT_MAX_CHUNK_RAW_BYTES
  ) {
    failures.push(
      `${label}: an audio chunk exceeded the ${VOICE_TRANSPORT_MAX_CHUNK_RAW_BYTES}-byte cap`,
    );
  }
  if (cell.contiguous_sequence !== true) {
    failures.push(`${label}: production frame sequence was not contiguous`);
  }
  if (cell.distinct_turn_ids !== 1) {
    failures.push(`${label}: expected one turn identity, observed ${cell.distinct_turn_ids}`);
  }
  if (cell.audio_end_status !== "sent") {
    failures.push(`${label}: audio_end was ${cell.audio_end_status ?? "absent"}, expected "sent"`);
  }
  if (cell.audio_turn_accepted_count !== 1) {
    failures.push(
      `${label}: observed ${cell.audio_turn_accepted_count} audio_turn_accepted frames, expected exactly 1`,
    );
  }
  if (cell.accepted_turn_id !== cell.turn_id) {
    failures.push(
      `${label}: acceptance named turn ${cell.accepted_turn_id}, expected ${cell.turn_id}`,
    );
  }
  if (cell.accepted_final_sequence !== cell.final_sequence) {
    failures.push(
      `${label}: acceptance carried final_sequence ${cell.accepted_final_sequence}, expected ${cell.final_sequence}`,
    );
  }
  if (cell.transcript_final_count !== 1) {
    failures.push(
      `${label}: observed ${cell.transcript_final_count} final transcripts, expected exactly 1`,
    );
  }
  if (cell.answer_evaluated_count !== 1) {
    failures.push(
      `${label}: observed ${cell.answer_evaluated_count} evaluations, expected exactly 1`,
    );
  }
  if (cell.next_ready !== true) {
    failures.push(`${label}: the session did not reach recap or next question readiness`);
  }
  if (cell.closed_before_acceptance === true) {
    failures.push(`${label}: the socket closed before the turn was accepted`);
  }
  if ((cell.backpressure_reordered ?? 0) > 0) {
    failures.push(`${label}: backpressure reordered ${cell.backpressure_reordered} frames`);
  }
  if ((cell.backpressure_dropped ?? 0) > 0) {
    failures.push(`${label}: backpressure dropped ${cell.backpressure_dropped} frames`);
  }
  if ((cell.lower_layer_matches ?? 0) < 1) {
    failures.push(`${label}: the lower-layer proof matched zero cases`);
  }
  return failures;
}

/**
 * RELEASE-023: run the standalone audio harness (which this lane owns and which
 * Plan 15 also runs directly) once per required device capture rate, plus its
 * `oversized_single_chunk_negative_control`, and bind the reduced result into
 * the release browser evidence. The harness stays a separate command: it is the
 * only place the *production* capture module and session controller drive a
 * real browser WebSocket, and absorbing it here would delete that proof.
 */
async function collectVoiceTransportMatrix() {
  if (!requireVoiceTransportMatrix) {
    return summarizeVoiceTransportMatrix({
      required: false,
      loopbackSkipped: loopbackTestSkipAllowed,
    });
  }
  if (hostedMode) {
    throw new Error(
      "VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX needs the real local WebSocket boundary; it cannot be satisfied in hosted mode.",
    );
  }
  const cells = [];
  for (const rate of VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ) {
    const evidence = await runAudioHarness({
      name: `audio-matrix-${rate}`,
      args: ["run", "e2e:browser:audio", "--", "--source-rate", String(rate)],
    });
    cells.push(
      ...voiceTransportMatrixCellsFromAudioEvidence({ source_sample_rate_hz: rate, ...evidence }),
    );
  }
  const negativeEvidence = await runAudioHarness({
    name: "audio-negative-control",
    args: ["run", "e2e:browser:audio:negative"],
  });
  return summarizeVoiceTransportMatrix({
    cells,
    negativeControl: negativeControlProof(negativeEvidence),
    required: true,
    loopbackSkipped: loopbackTestSkipAllowed,
  });
}

/**
 * The negative control's own rejection is re-derived from the observation the
 * harness recorded, never taken from its `passed` flag alone.
 */
function negativeControlProof(evidence) {
  if (!evidence) return null;
  const observation = evidence.observation ?? {};
  return {
    case: evidence.case ?? "oversized-single-chunk",
    passed: evidence.evaluation?.passed === true,
    rejected:
      observation.audio_turn_accepted === false &&
      VOICE_TRANSPORT_REJECTION_CLOSE_CODES.includes(observation.close_code),
  };
}

// ---------------------------------------------------------------------------
// LEARN-012 Step 3 handoff: the eight learning-truth checks, made required
// visible checks of `bun run e2e:browser`.
//
// Plan 04's LEARN-012 Step 3 is BLOCKED until this lane confirms the harness
// asserts assertions 1-8 on one authenticated study identity. They are reduced
// here -- out of the observed server event stream and the story's own visible
// observations -- rather than asserted from a flag or credited to a screenshot,
// so a story that merely rendered something can never satisfy them.
// ---------------------------------------------------------------------------

/** The eight checks, in Plan 04's own order. */
export const LEARNING_TRUTH_CHECKS = Object.freeze([
  "projection_question_started",
  "evaluated_turn_persists_one_outcome",
  "deferred_turn_recovers_without_mastery",
  "second_question_advances_under_d02",
  "recap_equals_persisted_outcomes",
  "review_schedule_under_d01_authority",
  "completed_recap_dominates_close",
  "d03_mode_goal_bound_or_removed_ui_absent",
]);

/** D-01 `SERVER_PERSISTED_FSRS`. The rejected branch's authority is not accepted. */
const LEARNING_TRUTH_REVIEW_AUTHORITY = "server_persisted_fsrs";
/** The v2 recap schema the merged turn-outcome authority folds. */
const LEARNING_TRUTH_RECAP_SCHEMA = "viva.study_session_recap.v2";

/**
 * Reduce the eight learning truths.
 *
 * `events` are the sanitized records `recordServerFramePayload` produced;
 * `visible` are the story's own on-screen observations. Both halves are
 * required for every check that has both: an event without its visible
 * counterpart is not a learner-visible truth, and a visible surface without its
 * event is not bound to anything the server actually said.
 */
export function summarizeLearningTruth({ required, events = [], visible = {} }) {
  const failures = [];
  const checks = [];
  const record = (id, passed, detail) => {
    checks.push({ id, passed, detail });
    if (!passed) failures.push(`${id}: ${detail}`);
  };

  const questionStarts = events.filter((event) => event.type === "question_started");
  const evaluations = events.filter((event) => event.type === "answer_evaluated");
  const deferrals = events.filter((event) => event.type === "turn_deferred");
  const conceptStatuses = events.filter((event) => event.type === "concept_status");
  const recapIndex = events.findIndex((event) => event.type === "recap_ready");
  const recap = recapIndex < 0 ? null : events[recapIndex];

  // 1. A question from AuthenticatedStudyProjectionV1 starts.
  //
  // The socket that delivered it is itself the projection binding: `/session`
  // opens no socket until an AuthenticatedStudyProjectionV1 has been fetched,
  // identity-verified against the route identity, and reported `canConnect`.
  // What is asserted here is the other half -- that the started question is a
  // real, identified question of the authenticated entry, and that the learner
  // can see its prompt.
  const firstStart = questionStarts[0];
  record(
    "projection_question_started",
    Boolean(
      firstStart?.questionId &&
        firstStart.conceptId &&
        visible.authenticatedEntry === true &&
        visible.questionPromptVisible === true,
    ),
    firstStart
      ? `question_started question_id=${firstStart.questionId ?? "missing"} concept_id=${
          firstStart.conceptId ?? "missing"
        } authenticated_entry=${visible.authenticatedEntry === true} prompt_visible=${
          visible.questionPromptVisible === true
        }`
      : "no question_started event was observed on the authenticated session",
  );

  // 2. An evaluated turn persists exactly one TurnOutcome.
  const evaluatedResponseIds = evaluations.map((event) => event.responseId);
  const duplicateEvaluation = new Set(evaluatedResponseIds).size !== evaluatedResponseIds.length;
  const firstEvaluation = evaluations[0];
  const persistedStatus = firstEvaluation
    ? conceptStatuses.find((event) => event.responseId === firstEvaluation.responseId)
    : undefined;
  record(
    "evaluated_turn_persists_one_outcome",
    Boolean(
      firstEvaluation?.responseId &&
        !duplicateEvaluation &&
        persistedStatus?.conceptId &&
        persistedStatus.conceptStatus &&
        visible.evaluatedTurnVisible === true,
    ),
    firstEvaluation
      ? `evaluations=${evaluations.length} duplicate_response_id=${duplicateEvaluation} persisted_concept_status=${
          persistedStatus?.conceptStatus ?? "none"
        } visible=${visible.evaluatedTurnVisible === true}`
      : "no answer_evaluated event was observed",
  );

  // 3. A deferred turn renders recovery without mastery.
  const deferral = deferrals[0];
  const deferralWroteMastery = deferral
    ? events.some(
        (event) =>
          (event.type === "concept_status" || event.type === "answer_evaluated") &&
          event.responseId === deferral.responseId,
      )
    : false;
  record(
    "deferred_turn_recovers_without_mastery",
    Boolean(
      deferral?.deferralReason &&
        !deferralWroteMastery &&
        visible.deferredRecoveryVisible === true &&
        visible.deferredMasteryVisible === false,
    ),
    deferral
      ? `deferral_reason=${deferral.deferralReason ?? "missing"} can_retry=${
          deferral.canRetrySameQuestion === true
        } wrote_mastery=${deferralWroteMastery} recovery_visible=${
          visible.deferredRecoveryVisible === true
        } mastery_visible=${visible.deferredMasteryVisible === true}`
      : "no turn_deferred event was observed",
  );

  // 4. A second question advances under the selected D-02 (ordered progression).
  const startedQuestionIds = questionStarts.map((event) => event.questionId);
  const repeatedQuestion = new Set(startedQuestionIds).size !== startedQuestionIds.length;
  record(
    "second_question_advances_under_d02",
    Boolean(
      questionStarts.length >= 2 &&
        !repeatedQuestion &&
        startedQuestionIds.every(Boolean) &&
        visible.secondQuestionPromptVisible === true,
    ),
    `question_starts=${questionStarts.length} repeated_question_id=${repeatedQuestion} second_prompt_visible=${
      visible.secondQuestionPromptVisible === true
    }`,
  );

  // 5. The recap equals the persisted outcomes.
  const persistedByConcept = new Map();
  for (const event of conceptStatuses) {
    if (event.conceptId) persistedByConcept.set(event.conceptId, event.conceptStatus);
  }
  const recapByConcept = new Map(
    (recap?.recapConcepts ?? []).map((concept) => [concept.conceptId, concept.status]),
  );
  const recapMatchesPersisted =
    Boolean(recap) &&
    persistedByConcept.size > 0 &&
    persistedByConcept.size === recapByConcept.size &&
    [...persistedByConcept].every(
      ([conceptId, status]) => recapByConcept.get(conceptId) === status,
    );
  record(
    "recap_equals_persisted_outcomes",
    Boolean(
      recapMatchesPersisted &&
        recap?.recapSchema === LEARNING_TRUTH_RECAP_SCHEMA &&
        visible.recapVisible === true,
    ),
    recap
      ? `recap_schema=${recap.recapSchema ?? "missing"} persisted=${describeConceptMap(
          persistedByConcept,
        )} recap=${describeConceptMap(recapByConcept)} visible=${visible.recapVisible === true}`
      : "no recap_ready event was observed",
  );

  // 6. The review schedule uses the selected D-01 authority and obeys exam policy.
  const schedule = recap?.reviewSchedule ?? [];
  const wrongAuthority = schedule.filter(
    (item) => item.authority !== LEARNING_TRUTH_REVIEW_AUTHORITY,
  );
  const unparseableDueAt = schedule.filter((item) => !Number.isFinite(Date.parse(item.dueAt)));
  const examAtMs = Number.isFinite(Date.parse(visible.examAt ?? ""))
    ? Date.parse(visible.examAt)
    : null;
  const pastExam =
    examAtMs === null ? [] : schedule.filter((item) => Date.parse(item.dueAt) > examAtMs);
  record(
    "review_schedule_under_d01_authority",
    Boolean(
      schedule.length > 0 &&
        wrongAuthority.length === 0 &&
        unparseableDueAt.length === 0 &&
        pastExam.length === 0 &&
        visible.reviewAuthorityVisible === true,
    ),
    `schedule_entries=${schedule.length} wrong_authority=${wrongAuthority.length} unparseable_due_at=${
      unparseableDueAt.length
    } past_exam=${pastExam.length} exam_bound=${
      examAtMs === null ? "unknown" : visible.examAt
    } authority_visible=${visible.reviewAuthorityVisible === true}`,
  );

  // 7. The completed recap copy dominates socket close/disconnection.
  const afterRecap = recapIndex < 0 ? [] : events.slice(recapIndex + 1);
  const contradicting = afterRecap.filter(
    (event) => event.type === "server_error" || event.type === "invalid_server_frame",
  );
  record(
    "completed_recap_dominates_close",
    Boolean(
      recap &&
        recap.recapPartial === false &&
        contradicting.length === 0 &&
        visible.recapVisibleAfterClose === true &&
        visible.disconnectionCopyVisible === false,
    ),
    recap
      ? `partial=${recap.recapPartial} contradicting_events_after_recap=${
          contradicting.length
        } recap_after_close_visible=${
          visible.recapVisibleAfterClose === true
        } disconnection_copy_visible=${visible.disconnectionCopyVisible === true}`
      : "no recap_ready event was observed",
  );

  // 8. The selected D-03 branch. D-03 Branch B is quiz-only: Viva signs no
  //    mode/goal contract, so the proof is that the removed UI is absent and the
  //    one honest affordance is present.
  record(
    "d03_mode_goal_bound_or_removed_ui_absent",
    visible.honestBeginActionVisible === true &&
      visible.modeGoalCommandVisible === false &&
      visible.modeSuggestionChipsVisible === false,
    `honest_begin_visible=${visible.honestBeginActionVisible === true} mode_goal_command_visible=${
      visible.modeGoalCommandVisible === true
    } mode_suggestion_chips_visible=${visible.modeSuggestionChipsVisible === true}`,
  );

  return {
    required: required === true,
    passed: required === true ? failures.length === 0 : true,
    checks,
    failures,
    sanitized: true,
  };
}

function describeConceptMap(map) {
  return (
    [...map]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([conceptId, status]) => `${conceptId}=${status}`)
      .join(",") || "none"
  );
}

const VOICE_TRANSPORT_REJECTION_CLOSE_CODES = Object.freeze([1002, 1009]);
const AUDIO_HARNESS_RESULT_PATH = "artifacts/e2e-browser-audio/result.json";

async function runAudioHarness({ name, args }) {
  const child = spawnLocalChild({
    name: "audio",
    command: "bun",
    args,
    logName: name,
  });
  try {
    await child.ready;
    await child.exit.catch(() => null);
  } finally {
    await child.stop({ graceMs: SUPERVISOR_DEFAULT_GRACE_MS });
  }
  // The harness writes its own result.json even for a failing case; an absent
  // file is itself a missing cell, never a silently passed one.
  try {
    return JSON.parse(await readFile(path.join(root, AUDIO_HARNESS_RESULT_PATH), "utf8"));
  } catch {
    return null;
  }
}

function isDirectRun() {
  return (
    Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

export {
  assertHostedSyntheticIdentity,
  assertHostedWebSocketTarget,
  failureControlReplayClientFrames,
  normalizeComparableWsUrl,
  normalizeHostedHttpUrl,
  normalizeHostedWsUrl,
  postAnswerProtocolProofFromEvents,
  recordServerFramePayload,
  redactSensitiveDiagnostic,
  terminalProofFromServerEvents,
  waitForFailureControlTerminal,
};

if (isDirectRun()) {
  await main();
}
