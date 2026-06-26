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
});
