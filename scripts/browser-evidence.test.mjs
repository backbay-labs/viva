import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseBrowserEvidence,
  normalizeBrowserEvidence,
  shouldSkipMissingBrowserResult,
} from "./browser-evidence.mjs";

test("normalizes connected recap browser evidence from the current e2e schema", () => {
  const evidence = normalizeBrowserEvidence({
    artifact_dir: "artifacts/e2e-browser",
    legacy_upload_visible: false,
    manuscript_ready: true,
    conductor_terminal_fold: true,
    recap_payload_visible: true,
    local_only_actions_hidden: true,
    console_errors: ["console failure"],
    page_errors: [],
  });

  assert.deepEqual(evidence, {
    artifact_dir: "artifacts/e2e-browser",
    legacy_upload_visible: false,
    manuscript_ready: true,
    conductor_terminal_fold: true,
    recap_payload_visible: true,
    local_only_actions_hidden: true,
    console_error_count: 1,
    page_error_count: 0,
  });
  assert.equal("pending_gate" in evidence, false);
  assert.equal("server_paste_ready" in evidence, false);
  assert.equal("connected_recap" in evidence, false);
});

test("does not infer recap payload evidence from the older terminal-fold field", () => {
  const evidence = normalizeBrowserEvidence({
    conductor_terminal_fold: true,
    local_only_actions_hidden: true,
    manuscript_ready: true,
    legacy_upload_visible: false,
  });

  assert.equal(evidence.conductor_terminal_fold, true);
  assert.equal(evidence.recap_payload_visible, false);
});

test("rejects stale browser evidence before release evidence is written", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence({
          legacy_upload_visible: false,
          manuscript_ready: true,
          conductor_terminal_fold: true,
          local_only_actions_hidden: true,
          console_errors: [],
          page_errors: [],
        }),
      ),
    /recap_payload_visible/,
  );
});

test("rejects unsafe browser evidence before release evidence is written", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence({
          legacy_upload_visible: true,
          manuscript_ready: true,
          conductor_terminal_fold: true,
          recap_payload_visible: true,
          local_only_actions_hidden: false,
          console_errors: ["boom"],
          page_errors: [],
        }),
      ),
    /legacy_upload_visible|local_only_actions_hidden|console_error_count/,
  );
});

test("only missing browser result files are skippable in release-check skip mode", () => {
  const missing = Object.assign(new Error("no result"), { code: "ENOENT" });
  const validation = new Error("Browser E2E release evidence is incomplete");

  assert.equal(shouldSkipMissingBrowserResult(missing, "1"), true);
  assert.equal(shouldSkipMissingBrowserResult(validation, "1"), false);
  assert.equal(shouldSkipMissingBrowserResult(missing, undefined), false);
});
