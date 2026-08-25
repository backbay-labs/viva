#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(mobileRoot, "../..");
const playwrightModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "node_modules/playwright/index.mjs"),
).href;
const { chromium } = await import(playwrightModuleUrl);

const providers = ["synthetic", "fake_cartesia_gemini"];
const allowedMobileFrameTypes = new Set(["session_config", "text", "cancel", "stop"]);
const fixturePathForProvider = {
  fake_cartesia_gemini: path.join(
    repositoryRoot,
    "agent/fixtures/voice-protocol/fake-cartesia-gemini-study-session.json",
  ),
  synthetic: path.join(
    repositoryRoot,
    "agent/fixtures/voice-protocol/synthetic-study-session.json",
  ),
};
const retryAnswer =
  "NADH is an electron donor to the electron transport chain; electron flow builds the proton gradient that drives ATP synthase.";

for (const provider of providers) {
  await runProviderPhase(provider);
}

console.log("mobile live-loop e2e passed for synthetic and fake_cartesia_gemini");

async function runProviderPhase(provider) {
  const fixture = JSON.parse(await readFile(fixturePathForProvider[provider], "utf8"));
  const expected = fixtureExpectations(fixture, provider);
  const agentPort = await freePort();
  const webPort = await freePort();
  const agentHttpUrl = `http://127.0.0.1:${agentPort}`;
  const agentWsUrl = `ws://127.0.0.1:${agentPort}/ws`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const processes = [];
  const consoleErrors = [];
  const pageErrors = [];
  const agentSockets = [];
  const sentFrames = [];
  const receivedFrames = [];
  let fakeSpeakingObserved = false;
  let browser;

  console.log(`[${provider}] starting real agent on ${agentPort} and Expo web on ${webPort}`);

  try {
    const agent = spawnLogged(
      `${provider}:agent`,
      "cargo",
      ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service"],
      repositoryRoot,
      {
        CARTESIA_API_KEY: "",
        DATABASE_URL: "",
        GEMINI_API_KEY: "",
        VIVA_AGENT_BIND_ADDR: `127.0.0.1:${agentPort}`,
        VIVA_AGENT_DATABASE_URL: "",
        VIVA_AGENT_PROVIDER: provider,
        VIVA_VOICE_SESSION_TOKEN_SECRET: "",
        VIVA_VOICE_WS_ALLOWED_ORIGINS: webUrl,
        VIVA_VOICE_WS_BEARER_TOKEN: "",
      },
    );
    processes.push(agent);

    const readiness = await waitForJson(
      `${agentHttpUrl}/ready`,
      (body) => body?.ready === true && body?.brain?.provider === provider,
      120_000,
      `${provider} agent readiness`,
      agent,
    );
    assertEqual(readiness.brain.provider, provider, `${provider} readiness provider`);

    const libraryResponse = await fetch(
      `${agentHttpUrl}/study-sets/library?user_id=${encodeURIComponent(expected.userId)}`,
      { headers: { Origin: webUrl } },
    );
    if (!libraryResponse.ok) {
      throw new Error(
        `[${provider}] library snapshot failed with HTTP ${libraryResponse.status}: ${await libraryResponse.text()}`,
      );
    }
    const library = await libraryResponse.json();
    const studySet = library.study_sets?.find((row) => row.id === expected.studySetId);
    assert(studySet, `[${provider}] fixture study set is absent from the live library snapshot`);
    assert(
      studySet.actions?.start?.available === false,
      `[${provider}] unsigned loopback library unexpectedly issued a start capability`,
    );
    const expectedStudySetTitle = requiredString(
      studySet.title,
      `[${provider}] live library study-set title`,
    );

    const expo = spawnLogged(
      `${provider}:expo`,
      "bunx",
      ["expo", "start", "--web", "--port", String(webPort)],
      mobileRoot,
      {
        CI: "1",
        EXPO_NO_TELEMETRY: "1",
        EXPO_PUBLIC_VIVA_AGENT_HTTP_URL: agentHttpUrl,
        EXPO_PUBLIC_VIVA_AGENT_WS_URL: agentWsUrl,
        EXPO_PUBLIC_VIVA_STUDY_SET_ID: expected.studySetId,
        EXPO_PUBLIC_VIVA_USER_ID: expected.userId,
        EXPO_PUBLIC_VIVA_WS_ORIGIN: webUrl,
      },
    );
    processes.push(expo);
    await waitForHttp(webUrl, 120_000, `${provider} Expo web`, expo);

    browser = await chromium.launch({
      headless: process.env.VIVA_MOBILE_E2E_HEADED !== "1",
    });
    const context = await browser.newContext({ viewport: { height: 900, width: 430 } });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("websocket", (socket) => {
      if (normalizeWebSocketUrl(socket.url()) !== normalizeWebSocketUrl(agentWsUrl)) return;
      agentSockets.push(socket.url());
      socket.on("framesent", (frame) => sentFrames.push(frame.payload));
      socket.on("framereceived", (frame) => {
        receivedFrames.push(frame.payload);
      });
    });

    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    const liveTitle = page.getByText(expectedStudySetTitle, { exact: true }).first();
    await liveTitle.waitFor({ state: "visible", timeout: 30_000 });
    await assertExactText(liveTitle, expectedStudySetTitle, `${provider} Home study-set title`);

    const beginRecall = page.getByRole("button", { exact: true, name: "Begin recall" });
    await waitForAllDisabled(
      beginRecall,
      10_000,
      `[${provider}] Home did not fail closed when the live library start action was unavailable`,
    );

    // The loopback agent deliberately offers no browser session capability
    // without signed/durable mode, while signed mode deliberately rejects the
    // in-memory fixture store. The native simulator gate uses this same trusted
    // loopback deep link. Keep the caveat machine-readable and never fake a
    // library action in the browser.
    console.log(`[${provider}] trusted_loopback_direct_session=true`);
    await page.goto(`${webUrl}/session?studySetId=${encodeURIComponent(expected.studySetId)}`, {
      waitUntil: "domcontentloaded",
    });
    const sessionRoot = page.getByTestId("session-live-root");
    await sessionRoot.waitFor({ state: "visible", timeout: 30_000 });
    await assertExactText(
      page.getByTestId("session-question"),
      expected.prompt,
      `${provider} question prompt`,
    );
    assertEqual(
      await sessionRoot.getAttribute("data-viva-speaking"),
      "false",
      `${provider} initial playback state`,
    );

    await installSpeakingTransitionObserver(page);
    // This real post-navigation gesture both opens the typed composer and
    // unlocks Web Audio before the fake provider emits its audio delta.
    await page.getByRole("button", { exact: true, name: "Type answer" }).click();
    const answerInput = page.getByTestId("session-answer-input");
    await answerInput.waitFor({ state: "visible", timeout: 10_000 });
    await answerInput.fill(expected.answer);
    await page.getByTestId("session-submit").click();

    const evaluationEvent = await waitForReceivedEvent(
      receivedFrames,
      "answer_evaluated",
      30_000,
      provider,
    );
    assertEqual(
      evaluationEvent.evaluation?.concise_feedback,
      expected.feedback,
      `${provider} fixture evaluation feedback`,
    );

    if (provider === "synthetic") {
      const correction = page.getByTestId("session-correction");
      await correction.waitFor({ state: "visible", timeout: 30_000 });
      await correction.getByText(expected.feedback, { exact: true }).waitFor({
        state: "visible",
        timeout: 10_000,
      });

      // This is a real retry turn, not a no-op wait: open the retry composer,
      // submit a second typed frame, and wait for the second evaluation.
      await page.getByTestId("session-retry").click();
      await assertExactText(
        page.getByTestId("session-question"),
        expected.retryPrompt,
        "synthetic retry prompt",
      );
      await page.getByTestId("session-answer-input").fill(retryAnswer);
      await page.getByTestId("session-submit").click();
      await waitForReceivedEventCount(receivedFrames, "answer_evaluated", 2, 30_000, provider);
      await page.getByTestId("session-correction").waitFor({
        state: "visible",
        timeout: 30_000,
      });
      await page.getByTestId("session-end").click();
    } else {
      await waitForReceivedEvent(receivedFrames, "audio_delta", 30_000, provider);
      fakeSpeakingObserved = await waitForSpeakingObservation(page, 2_000);
    }

    const recapEvent = await waitForReceivedEvent(receivedFrames, "recap_ready", 30_000, provider);
    assertEqual(
      recapEvent.recap?.headline,
      expected.recapHeadline,
      `${provider} fixture recap event headline`,
    );
    const recapHeadline = page.getByTestId("recap-headline");
    await recapHeadline.waitFor({ state: "visible", timeout: 30_000 });
    await assertExactText(recapHeadline, expected.recapHeadline, `${provider} recap headline`);

    if (provider === "fake_cartesia_gemini") {
      const transitions = await page.evaluate(
        () => globalThis.__vivaMobileSpeakingTransitions ?? [],
      );
      const speakingIndex = transitions.indexOf("true");
      const returnedToIdle = transitions
        .slice(speakingIndex + 1)
        .some((state) => state === "false" || state === "absent");
      assert(
        fakeSpeakingObserved && speakingIndex >= 0 && returnedToIdle,
        `[${provider}] playback did not transition speaking -> idle/teardown: ${JSON.stringify(transitions)}`,
      );
      console.log(`[${provider}] fake_playback_speaking_observable=true`);
    }

    assertAgentWebSocketFrames(sentFrames, provider, expected.answer);
    if (provider === "synthetic") {
      assert(
        sentFrames.some((payload) => textFramePayload(payload) === retryAnswer),
        "[synthetic] Try Again did not send the typed retry answer",
      );
    }
    assert(agentSockets.length > 0, `[${provider}] no real agent WebSocket was observed`);
    assert(
      receivedEventCount(receivedFrames, "audio_delta") >=
        (provider === "fake_cartesia_gemini" ? 1 : 0),
      `[${provider}] expected fake-provider audio_delta was not observed`,
    );
    assertNoBrowserErrors(provider, consoleErrors, pageErrors);

    console.log(
      `[${provider}] passed: ${sentFrames.length} typed client frames, ${receivedFrames.length} server frames`,
    );
  } catch (error) {
    const processTails = processes
      .map((processRecord) => `\n--- ${processRecord.label} ---\n${processRecord.tail()}`)
      .join("");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${processTails}`);
  } finally {
    await browser?.close();
    for (const processRecord of processes.reverse()) {
      await stopProcess(processRecord.child);
    }
  }
}

function fixtureExpectations(fixture, provider) {
  const config = fixture.client.find((frame) => frame.type === "session_config")?.session;
  const question = fixtureEvent(fixture, "question_started")?.question;
  const evaluation = fixtureEvent(fixture, "answer_evaluated")?.evaluation;
  const recap = fixtureEvent(fixture, "recap_ready")?.recap;
  const answer =
    fixture.client.find((frame) => frame.type === "text")?.text ?? evaluation?.answer_text;
  return {
    answer: requiredString(answer, `[${provider}] fixture answer`),
    feedback: requiredString(
      evaluation?.concise_feedback,
      `[${provider}] fixture concise feedback`,
    ),
    prompt: requiredString(question?.prompt, `[${provider}] fixture question prompt`),
    recapHeadline: requiredString(recap?.headline, `[${provider}] fixture recap headline`),
    retryPrompt: requiredString(evaluation?.retry_prompt, `[${provider}] fixture retry prompt`),
    studySetId: requiredString(config?.study_set_id, `[${provider}] fixture study-set id`),
    userId: requiredString(config?.user_id, `[${provider}] fixture user id`),
  };
}

function fixtureEvent(fixture, eventType) {
  return fixture.server.find((frame) => frame.type === "event" && frame.event?.type === eventType)
    ?.event;
}

async function installSpeakingTransitionObserver(page) {
  await page.evaluate(() => {
    const states = [];
    const record = () => {
      const state =
        document
          .querySelector('[data-testid="session-live-root"]')
          ?.getAttribute("data-viva-speaking") ?? "absent";
      if (states.at(-1) !== state) states.push(state);
    };
    globalThis.__vivaMobileSpeakingTransitions = states;
    record();
    const observer = new MutationObserver(record);
    observer.observe(document.documentElement, {
      attributeFilter: ["data-viva-speaking"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    globalThis.__vivaMobileSpeakingObserver = observer;
  });
}

async function waitForSpeakingObservation(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => globalThis.__vivaMobileSpeakingTransitions?.includes("true") === true,
      undefined,
      { timeout: timeoutMs },
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Timeout")) return false;
    throw error;
  }
}

function assertAgentWebSocketFrames(payloads, provider, expectedAnswer) {
  assert(payloads.length > 0, `[${provider}] agent WebSocket sent no client frames`);
  const parsed = payloads.map((payload, index) => {
    assert(
      typeof payload === "string",
      `[${provider}] client frame ${index + 1} was binary instead of text JSON`,
    );
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      throw new Error(`[${provider}] client frame ${index + 1} was malformed JSON`);
    }
    assert(
      typeof frame === "object" && frame !== null && allowedMobileFrameTypes.has(frame.type),
      `[${provider}] client frame ${index + 1} used forbidden type ${JSON.stringify(frame?.type)}`,
    );
    assert(frame.type !== "audio", `[${provider}] mobile emitted an audio frame`);
    return frame;
  });
  assert(
    parsed.some((frame) => frame.type === "session_config"),
    `[${provider}] missing config`,
  );
  assert(
    parsed.some((frame) => frame.type === "text" && frame.text === expectedAnswer),
    `[${provider}] missing exact fixture answer text frame`,
  );
}

function textFramePayload(payload) {
  if (typeof payload !== "string") return undefined;
  try {
    const frame = JSON.parse(payload);
    return frame.type === "text" ? frame.text : undefined;
  } catch {
    return undefined;
  }
}

function serverEventPayload(payload) {
  if (typeof payload !== "string") return undefined;
  try {
    const frame = JSON.parse(payload);
    return frame.type === "event" ? frame.event : undefined;
  } catch {
    return undefined;
  }
}

function receivedEventCount(payloads, eventType) {
  return payloads.filter((payload) => serverEventPayload(payload)?.type === eventType).length;
}

async function waitForReceivedEvent(payloads, eventType, timeoutMs, provider) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = payloads
      .map(serverEventPayload)
      .find((candidate) => candidate?.type === eventType);
    if (event) return event;
    await delay(25);
  }
  throw new Error(`[${provider}] timed out waiting for server event ${eventType}`);
}

async function waitForReceivedEventCount(payloads, eventType, count, timeoutMs, provider) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (receivedEventCount(payloads, eventType) >= count) return;
    await delay(25);
  }
  throw new Error(`[${provider}] timed out waiting for ${count} ${eventType} events`);
}

async function assertExactText(locator, expected, label) {
  const deadline = Date.now() + 30_000;
  let actual;
  while (Date.now() < deadline) {
    await locator.waitFor({ state: "visible", timeout: 30_000 });
    actual = (await locator.textContent())?.trim();
    if (actual === expected) return;
    await delay(25);
  }
  assertEqual(actual, expected, label);
}

async function waitForAllDisabled(locator, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count();
    if (count > 0) {
      const disabled = await Promise.all(
        Array.from({ length: count }, (_, index) => locator.nth(index).isDisabled()),
      );
      if (disabled.every(Boolean)) return;
    }
    await delay(25);
  }
  throw new Error(message);
}

function assertNoBrowserErrors(provider, consoleErrors, pageErrors) {
  assert(
    consoleErrors.length === 0,
    `[${provider}] browser console errors:\n${consoleErrors.join("\n")}`,
  );
  assert(pageErrors.length === 0, `[${provider}] page errors:\n${pageErrors.join("\n")}`);
}

function normalizeWebSocketUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function spawnLogged(label, command, args, cwd, environment) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output += chunk.toString();
    if (output.length > 40_000) output = output.slice(-40_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("error", (error) => append(`\nspawn error: ${error.message}\n`));
  return { child, label, tail: () => output.slice(-12_000) };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalProcessGroup(child, "SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    signalProcessGroup(child, "SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  }
}

function signalProcessGroup(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForHttp(url, timeoutMs, label, processRecord) {
  return waitForJson(url, () => true, timeoutMs, label, processRecord, false);
}

async function waitForJson(url, predicate, timeoutMs, label, processRecord, parseJson = true) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (processRecord.child.exitCode !== null || processRecord.child.signalCode !== null) {
      throw new Error(
        `${label} process exited before readiness (${processRecord.child.exitCode ?? processRecord.child.signalCode})`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = parseJson ? await response.json() : {};
        if (predicate(body)) return body;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("failed to allocate a free loopback port"));
      });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
