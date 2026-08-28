// RELEASE-030 E2E extraction: behavioral tests for the pure plan/config
// reducers moved out of `e2e-browser.mjs` into `e2e-browser-plan.mjs`. Moved
// verbatim from `e2e-browser.test.mjs`; only the import path changed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHostedSyntheticIdentity,
  normalizeHostedHttpUrl,
  normalizeHostedWsUrl,
} from "./e2e-browser-plan.mjs";

test("hosted URL normalization strips credentials-bearing query, fragment, and trailing slash noise", () => {
  assert.equal(
    normalizeHostedHttpUrl("https://web.example.com/?session_token=leak#fragment", "TEST_URL"),
    "https://web.example.com",
  );
  assert.equal(
    normalizeHostedHttpUrl("https://web.example.com/app////", "TEST_URL"),
    "https://web.example.com/app",
  );
  assert.throws(
    () => normalizeHostedHttpUrl("ws://web.example.com", "TEST_URL"),
    /TEST_URL must use http:\/\/ or https:\/\//,
  );
  assert.equal(
    normalizeHostedWsUrl("wss://agent.example.com/ws?x=1", "WS_URL"),
    "wss://agent.example.com/ws",
  );
  assert.throws(
    () => normalizeHostedWsUrl("https://agent.example.com/ws", "WS_URL"),
    /WS_URL must use ws:\/\/ or wss:\/\//,
  );
});

test("hosted synthetic identity rejection refuses anything that could be a real learner", () => {
  assert.doesNotThrow(() => assertHostedSyntheticIdentity({ userId: "synthetic-monitor-1" }));
  assert.doesNotThrow(() => assertHostedSyntheticIdentity({ userId: "hosted-monitor" }));
  for (const userId of ["user-1", "learner-42", "synthetic-learner-1", "monitor-student"]) {
    assert.throws(
      () => assertHostedSyntheticIdentity({ userId }),
      /requires a synthetic monitor user identity/,
      `identity ${userId} must be refused`,
    );
  }
});
