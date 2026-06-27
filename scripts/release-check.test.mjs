import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const releaseCheck = fs.readFileSync(new URL("./release-check.mjs", import.meta.url), "utf8");

test("release check runs the provider limiter behavior proof cited by the evidence artifact", () => {
  assert.match(releaseCheck, /provider_limiter_behavior_tests/);
  assert.match(
    releaseCheck,
    /websocket_provider_backoff_denies_next_answer_before_brain_input/,
  );
});
