// RELEASE-030 E2E extraction, further split (post-review-remediation amend):
// the story itself -- `runBrowserStory`, the single sequenced drive of every
// required page action and frame once the runtime module hands over a ready
// browser page and resolved agent/web addresses. Derived from
// `e2e-browser-story.mjs`.
//
// Kept as one module rather than split further: its nine inner helpers close
// over roughly a dozen shared per-run locals (`storyFrames`,
// `learningTruthVisible`, `capture.consoleErrors`/`pageErrors`, and the
// resolved addresses among them), and its ~600-line sequential body is the
// literal ordered story. Converting every closure capture into an explicit
// parameter across nine helpers and dozens of call sites is a real refactor,
// not a mechanical move -- and the only live characterization available on
// this tree reaches roughly the first 5% of this function before the
// pre-existing cross-lane CSP blocker in `apps/web/proxy.ts` (reported to
// the coordinator, not owned by this lane) stops the browser cold. That is
// not enough live signal to safely catch a parameter-wiring mistake in the
// unreached majority, so this file stays whole rather than risk an unflagged
// semantic change the way the first extraction pass did (`waitForHttp`
// dropping out of the hosted path). See `module-concentration-policy.json`'s
// `frozen_baseline_note` for why this file's ceiling is the ordinary ratchet
// formula, not the plan's 600-line target for the three plan-named modules
// themselves: it is a derived child of one of them, on the same standing
// every other lane's derived child already has in this policy (for example
// `agent/crates/agent-service/src/ws/tests.rs`).
import path from "node:path";
import {
  failureControlSessionTargetForScenario,
  failureControlStartIdentity,
  parseFailureControlSessionTarget,
} from "./failure-control-harness.mjs";
import {
  assertHostedSyntheticIdentity,
  hostedDeployIds,
  hostedDeploySha,
  hostedPostgresDurability,
  hostedSyntheticIdentity,
} from "./e2e-browser-plan.mjs";
import { delay } from "./e2e-browser-runtime.mjs";
import {
  buildHostedBrowserEvidence,
  HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS,
  hostedEvidenceStageForScenario,
} from "./hosted-e2e-matrix.mjs";
import { validatedVoiceFrameForRelease } from "./release-contract-validation.mjs";
import {
  assertHostedWebSocketTarget,
  bootstrapToken,
  conceptLabelText,
  conceptStatusText,
  failureControlReplayClientFrames,
  fetchSignedSessionStartTarget,
  isVisible,
  redactCorrectionMarginaliaForSanitizedScreenshot,
  redactRecapForSanitizedScreenshot,
  redactSensitiveDiagnostic,
  redactSourceFolioForSanitizedScreenshot,
  submitWrittenAnswerIfFallbackOpens,
  waitForCanonicalSessionUrl,
} from "./e2e-browser-story-actions.mjs";
import { pendingPreviewHtml } from "./e2e-browser-story-preview.mjs";
import {
  buildBrowserStoryManifest,
  recordServerFramePayload,
  summarizeStore,
  terminalProofFromServerEvents,
  waitForFailureControlTerminal,
  waitForPostAnswerProtocolProof,
  writeAuditedBrowserStoryResult,
} from "./e2e-browser-story-evidence.mjs";
import {
  collectVoiceTransportMatrix,
  summarizeFakeDeviceLongAudioProof,
} from "./e2e-browser-story-matrix.mjs";
import {
  summarizeLearningTruth,
  summarizeTerminalCopyProof,
} from "./e2e-browser-story-learning-truth.mjs";

// ---------------------------------------------------------------------------
// The story itself: page actions and required frames, driven once the runtime
// module hands over a ready browser page and resolved agent/web addresses.
// ---------------------------------------------------------------------------

/**
 * Drive the whole product story on an already-running local or hosted target
 * and return the sanitized, audited evidence result.
 *
 * `plan` is `buildE2EPlan()`'s frozen output; `runtime` bundles the resolved
 * addresses and Playwright handles `e2e-browser-runtime.mjs` produced;
 * `capture` is the shared mutable evidence container the entrypoint also
 * reads from its own catch block (`consoleErrors`, `pageErrors`,
 * `serverEvents`, `websocketUrls`, plus the `traceStarted`/`traceArtifact`
 * pair a mid-story failure must still be able to close out).
 */
export async function runBrowserStory({ plan, runtime, capture }) {
  const { page, context, agentUrl, webUrl, wsUrl, agentReadiness } = runtime;
  const {
    agentProvider,
    artifactDir,
    deterministicPartialRecapScenario,
    failureControlEnv,
    failureControlPlan,
    hostedMode,
    hostedScenarioId,
    requireCorrectionMarginalia,
    requireLearningTruth,
    requirePostAnswerSourceFolio,
    requireVoiceTransportMatrix,
    root,
    sessionTokenFailureScenario,
    stopToRecap,
    validationRunId,
  } = plan;
  const { consoleErrors, pageErrors, serverEvents } = capture;
  const storyFrames = [];
  let hostedSecondTabIdentity = null;
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

  /** Wait until the observed stream carries at least `count` events of `type`. */
  async function waitForServerEventCount(type, count, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (serverEvents.filter((event) => event.type === type).length >= count) return true;
      await delay(100);
    }
    return false;
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
      validationRunId,
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
      assertHostedWebSocketTarget(capture.websocketUrls, wsUrl);
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
          validationRunId,
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
  let terminalRetryContradictionVisible = false;
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
    // Ledger row 598 / `WEBSESSION-TERMINAL-01`'s retry-labeled half of "no
    // disconnect/retry contradiction", observed at the identical point.
    terminalRetryContradictionVisible =
      (await isVisible(page.getByText("Reconnect", { exact: true }))) ||
      (await isVisible(page.getByRole("button", { name: "Try again" }))) ||
      (await isVisible(page.getByRole("button", { name: "Retry this question" })));
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
  if (capture.traceStarted) {
    await context.tracing.stop({ path: path.join(artifactDir, "trace.zip") });
    capture.traceArtifact = "trace.zip";
    capture.traceStarted = false;
  }
  const sessionUrlLifecycle = await auditSessionUrlLifecycle(context);
  const voiceTransportMatrix = await collectVoiceTransportMatrix(plan);
  const fakeDeviceLongAudioProof = summarizeFakeDeviceLongAudioProof(voiceTransportMatrix);
  const learningTruth = summarizeLearningTruth({
    required: requireLearningTruth,
    events: serverEvents,
    visible: learningTruthVisible,
  });
  const requireTerminalCopyProof = !failureControlPlan.enabled && !stopToRecap;
  const terminalCopyProof = summarizeTerminalCopyProof({
    disconnectionCopyVisible: learningTruthVisible.disconnectionCopyVisible,
    recapVisible: recapPayloadVisible,
    required: requireTerminalCopyProof,
    retryContradictionVisible: terminalRetryContradictionVisible,
  });

  const browserStory = await buildBrowserStoryManifest(
    { traceRetained: Boolean(capture.traceArtifact) },
    plan,
    storyFrames,
  );
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
          validationRunId,
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
    durable_state_release_claimed: plan.durableStateReleaseClaimed,
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
    failure_control_harness: plan.failureControlEvidence,
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
      postgresDurability: hostedPostgresDurability(hostedMode),
      provider: agentProvider,
      recapSuccess: recapPayloadVisible,
      runId: process.env.VIVA_HOSTED_RUN_ID?.trim() || null,
      scenarioId: hostedScenarioId,
      screenshots,
      stage: hostedEvidenceStage,
      terminalReason,
      tokenRefreshOutcome:
        sessionUrlLifecycle?.passed === true ? "canonicalized_visible_url" : "not_observed",
      trace: capture.traceArtifact,
      webUrl,
    }),
    voice_transport_matrix: voiceTransportMatrix,
    frontend_c8_fake_device_long_audio: fakeDeviceLongAudioProof,
    frontend_c9_terminal_copy: terminalCopyProof,
    learning_truth: learningTruth,
    browser_story: browserStory,
    browser_story_artifact: "browser-story.json",
    console_errors: consoleErrors,
    page_errors: pageErrors,
    screenshots,
    trace: capture.traceArtifact,
  };
  result = await writeAuditedBrowserStoryResult(result, plan);

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
  // Ledger row 597 / `CRIT-AUDIO-01` (Frontend C8): the canonical fake-device
  // long-audio cell, named on its own so a matrix that happened to pass
  // without ever exercising it (impossible today, since it is one of the six
  // required cells, but a future matrix shape change could split it out)
  // cannot silently stop proving this specific alias.
  if (!fakeDeviceLongAudioProof.passed) {
    throw new Error(
      `Required CRIT-AUDIO-01 fake-device long-audio proof (ledger row 597) did not pass: ${fakeDeviceLongAudioProof.failures.join(" | ")}`,
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
  // Ledger row 598 / `WEBSESSION-TERMINAL-01` (Frontend C9): a successful
  // recap must never share the screen with disconnect or retry copy.
  if (!terminalCopyProof.passed) {
    throw new Error(
      `Required WEBSESSION-TERMINAL-01 terminal-copy proof (ledger row 598) did not pass: ${terminalCopyProof.failures.join(" | ")}`,
    );
  }
  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(`Browser errors detected: ${[...consoleErrors, ...pageErrors].join(" | ")}`);
  }

  return result;
}
