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

test("release check imports executed hosted monitor matrix results before finalizing", () => {
  assert.match(releaseCheck, /readHostedMonitorEvidence/);
  assert.match(releaseCheck, /hostedMonitorMatrixResults/);
  assert.match(releaseCheck, /results: hostedMonitorMatrixResults/);
});

test("release check restores shared structural redaction checks for evidence bundles", () => {
  assert.match(releaseCheck, /assertNoForbiddenEvidenceMarkers/);
  assert.match(releaseCheck, /assertNoForbiddenEvidenceMarkers\(evidence/);
});
