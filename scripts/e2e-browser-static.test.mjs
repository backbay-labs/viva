import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const E2E_BROWSER_PATH = "scripts/e2e-browser.mjs";

test("hosted browser E2E mints sessions through the same-origin bootstrap route", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(source, /\/api\/viva-library\/study-sets\/library/);
  assert.match(source, /\/api\/viva-session\/start/);
  assert.match(source, /session_bootstrap_token: action\.session_bootstrap_token/);
  assert.match(source, /sessionPayload\.session_token/);
  assert.doesNotMatch(source, /action\.session_token/);
});

test("hosted browser E2E keeps the REST bearer out of browser JavaScript", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.doesNotMatch(source, /async \(\{ restBearerToken, userId, studySetId \}\) =>/);
  assert.doesNotMatch(source, /headers\.authorization = `Bearer \$\{restBearerToken\}`/);
  assert.doesNotMatch(source, /\{ \.\.\.identity, restBearerToken: hostedRestBearerToken \}/);
});

test("hosted browser E2E authenticates the Node-side agent readiness probe", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(source, /authenticatedHostedFetchOptions\(hostedRestBearerToken\)/);
  assert.match(source, /headers\.set\("Authorization", \["Bearer", bearerToken\]\.join\(" "\)\)/);
  assert.match(
    source,
    /waitForHttpJson\(\s*`\$\{agentUrl\}\/ready`,[\s\S]*hostedAgentReadinessFetchOptions/,
  );
});

test("hosted browser E2E records only actually verified websocket and session-cap proof", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(source, /let hostedWebSocketVerified = false/);
  assert.match(source, /hostedWebSocketVerified = true/);
  assert.match(source, /hosted_websocket_verified: hostedWebSocketVerified/);
  assert.match(source, /const secondTabTarget = hostedMode/);
  assert.match(source, /await fetchSignedSessionStartTarget\(\s*page,\s*hostedSecondTabIdentity/);
  assert.match(
    source,
    /secondTabSessionCap = await auditSecondTabSessionCap\(context, secondTabTarget\)/,
  );
  assert.match(source, /\.\.\.\(secondTabSessionCap \? \["second-tab-session-cap\.png"\] : \[\]\)/);
  assert.doesNotMatch(source, /secondTabSessionCapProof/);
});

test("hosted browser E2E does not infer partial recap evidence from visible recap alone", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(source, /terminalProofFromServerEvents\(serverEvents/);
  assert.match(
    source,
    /deterministicPartialRecapScenario \? null : recapPayloadVisible \? "completed" : null/,
  );
  assert.match(
    source,
    /Deterministic partial recap scenario did not observe partial_stage_success terminal proof/,
  );
  assert.doesNotMatch(
    source,
    /deterministicPartialRecapScenario && recapPayloadVisible\s*\?\s*"partial_stage_success"/,
  );
});

test("RELEASE-028: the browser harness holds no protocol-version literal of its own", async () => {
  // A-03 recorded this file's `const VIVA_VOICE_PROTOCOL_VERSION = 4` going
  // stale against the shared contract, caught only by comparing two source
  // texts. Task 13 removed the literal: the version is now read out of the
  // server's own validated `ready` frame, which is the behavioral proof in
  // e2e-browser.test.mjs. The scan that remains only bans the literal coming
  // back.
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.doesNotMatch(source, /const VIVA_VOICE_PROTOCOL_VERSION = \d+/);
  assert.match(source, /releaseProtocolVersionFromServerFrame/);
  assert.match(source, /validatedVoiceFrameForRelease/);
});

test("RELEASE-028: the in-page WebSocket validates through one exposed binding, never a second browser schema", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(source, /exposeFunction\(bindingName/);
  assert.match(source, /const validate = window\[bindingName\]/);
  assert.match(source, /void validate\(decoded\)\.then/);
  // The page receives a validated reconstruction or a stable code -- never the
  // validator's own source and never its own allowed-key list.
  assert.doesNotMatch(source, /validateLearnerLoopContract\.toString\(\)/);
  assert.doesNotMatch(source, /parseVivaServerFrame\.toString\(\)/);
});

test("hosted browser E2E does not infer partial recap mode from stop-to-recap", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(
    source,
    /const deterministicPartialRecapScenario = hostedScenarioId === "deterministic_partial_recap"/,
  );
  assert.doesNotMatch(source, /if \(stopToRecap\) return "deterministic_partial_recap"/);
});

test("e2e-browser spawns every local child through the shared explicit child-environment constructor", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(source, /import \{ childEnvironmentFor \} from "\.\/child-environment\.mjs";/);
  assert.match(source, /agent: "local-browser-agent"/);
  assert.match(source, /web: "local-browser-web"/);
  assert.match(
    source,
    /env: childEnvironmentFor\(role, \{ parentEnv: process\.env, explicit: extraEnv \}\)/,
  );
  assert.doesNotMatch(source, /env: \{ \.\.\.process\.env, \.\.\.extraEnv \}/);
});

test("hosted browser E2E records answer-resolution latency evidence", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(source, /const answerResolutionStartedAt = Date\.now\(\)/);
  assert.match(
    source,
    /waitForPostAnswerProtocolProof\(\s*serverEvents,\s*HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS,\s*answerResolutionStartedAt/s,
  );
  assert.match(source, /HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS/);
  assert.match(source, /latencyMs: postAnswerProtocolProof\.latencyMs/);
  assert.match(source, /latencyMs:\s*null/);
});

test("D-09 Branch B: the harness-authored pending-preview frame is source-marked as non-product evidence", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(source, /id: "pending_local_preview"/);
  assert.match(source, /kind: "structured_preview"/);
  assert.match(source, /must never satisfy required product-frame or release-proof checks/);
});

test("RELEASE-015: the browser harness supervises its local children as process groups", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(
    source,
    /import \{[^}]*spawnManaged[^}]*\} from "\.\/process-supervisor\.mjs";/s,
  );
  assert.match(
    source,
    /import \{[^}]*spawnWithPortRetry[^}]*\} from "\.\/process-supervisor\.mjs";/s,
  );
  assert.match(source, /installSignalCleanup\(/);
  // The retired local primitives: a bare spawn(), a private freePort(), and
  // the stop() that ended log streams before the child had exited.
  assert.doesNotMatch(source, /import \{ spawn \} from "node:child_process";/);
  assert.doesNotMatch(source, /function freePort\(\)/);
  assert.doesNotMatch(source, /if \(!exited\) child\.kill\("SIGTERM"\)/);
});

test("RELEASE-023: the browser harness is import-safe so its reducers can be tested by running them", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  // The story runs only when this file is the process entrypoint; importing
  // it must not delete an artifact directory or spawn cargo/bun/Chromium.
  assert.match(source, /async function main\(\)/);
  assert.match(source, /if \(isDirectRun\(\)\) \{\s*await main\(\);/);
  assert.match(source, /^export \{/m);
});
