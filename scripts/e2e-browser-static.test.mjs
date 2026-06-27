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
  assert.match(source, /const terminalReason =\s*terminalProof\?\.terminal_reason/);
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
