import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const E2E_BROWSER_PATH = "scripts/e2e-browser.mjs";
const AGENT_CONTRACT_PATH = "packages/core/src/agent-contract.ts";

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

test("hosted browser E2E uses the shared voice protocol version", async () => {
  const [browserSource, contractSource] = await Promise.all([
    readFile(E2E_BROWSER_PATH, "utf8"),
    readFile(AGENT_CONTRACT_PATH, "utf8"),
  ]);
  const browserVersion = numericConstant(browserSource, "VIVA_VOICE_PROTOCOL_VERSION");
  const contractVersion = numericConstant(contractSource, "VIVA_VOICE_PROTOCOL_VERSION");

  assert.equal(browserVersion, contractVersion);
});

function numericConstant(source, name) {
  const match = source.match(new RegExp(`const ${name} = (\\d+)`));
  assert(match, `missing numeric constant ${name}`);
  return Number(match[1]);
}

test("hosted browser E2E does not infer partial recap mode from stop-to-recap", async () => {
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(
    source,
    /const deterministicPartialRecapScenario = hostedScenarioId === "deterministic_partial_recap"/,
  );
  assert.doesNotMatch(source, /if \(stopToRecap\) return "deterministic_partial_recap"/);
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
