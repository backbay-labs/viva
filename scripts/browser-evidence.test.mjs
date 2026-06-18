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
    next_session_recommendation_visible: true,
    source_folio_visible: true,
    bounded_source_visible: true,
    post_answer_source_folio_visible: true,
    post_answer_bounded_source_visible: true,
    post_answer_source_reference_event_seen: true,
    post_answer_concept_status_event_seen: true,
    local_only_actions_hidden: true,
    browser_story: completeBrowserStory(),
    console_errors: ["console failure"],
    page_errors: [],
  });

  assert.deepEqual(evidence, {
    artifact_dir: "artifacts/e2e-browser",
    legacy_upload_visible: false,
    manuscript_ready: true,
    conductor_terminal_fold: true,
    recap_payload_visible: true,
    next_session_recommendation_visible: true,
    source_folio_visible: true,
    bounded_source_visible: true,
    post_answer_source_folio_visible: true,
    post_answer_bounded_source_visible: true,
    post_answer_source_reference_event_seen: true,
    post_answer_concept_status_event_seen: true,
    local_only_actions_hidden: true,
    browser_story: {
      artifact_forbidden_hits: 0,
      command_summary_present: true,
      fixture_hash_count: 1,
      frame_ids: [
        "pending_local_preview",
        "server_ready_study_set",
        "active_synthetic_manuscript",
        "recap",
      ],
      sanitized: true,
      schema: "viva.browser_story.v1",
      screenshot_count: 4,
      trace_retained: false,
      validation_run_id: "browser-story-synthetic",
    },
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
          source_folio_visible: true,
          bounded_source_visible: true,
          post_answer_source_folio_visible: true,
          post_answer_bounded_source_visible: true,
          console_errors: [],
          page_errors: [],
        }),
      ),
    /recap_payload_visible/,
  );
});

test("rejects browser evidence without next-session review recommendations", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence({
          legacy_upload_visible: false,
          manuscript_ready: true,
          conductor_terminal_fold: true,
          recap_payload_visible: true,
          source_folio_visible: true,
          bounded_source_visible: true,
          post_answer_source_folio_visible: true,
          post_answer_bounded_source_visible: true,
          post_answer_source_reference_event_seen: true,
          post_answer_concept_status_event_seen: true,
          local_only_actions_hidden: true,
          browser_story: completeBrowserStory(),
          console_errors: [],
          page_errors: [],
        }),
      ),
    /next_session_recommendation_visible/,
  );
});

test("requires sanitized browser-story frames for the manuscript release artifact", () => {
  assert.doesNotThrow(() =>
    assertReleaseBrowserEvidence(normalizeBrowserEvidence(completeBrowserResult())),
  );
});

test("rejects browser evidence without every browser-story manuscript frame", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence(
          completeBrowserResult({
            browser_story: completeBrowserStory({ omitFrameId: "server_ready_study_set" }),
          }),
        ),
      ),
    /server_ready_study_set/,
  );
});

test("rejects browser-story artifacts without validation binding", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence(
          completeBrowserResult({
            browser_story: completeBrowserStory({ command_summary: undefined, fixture_hashes: {} }),
          }),
        ),
      ),
    /command_summary|fixture_hashes/,
  );
});

test("rejects browser-story artifacts with retained traces or forbidden audit hits", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence(
          completeBrowserResult({
            browser_story: completeBrowserStory({
              artifact_audit: { scanned_files: 8, forbidden_hits: 1 },
              trace_retained: true,
            }),
          }),
        ),
      ),
    /trace_retained|artifact_forbidden_hits/,
  );
});

test("rejects browser evidence that omits the bounded Source Folio proof", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence({
          legacy_upload_visible: false,
          manuscript_ready: true,
          conductor_terminal_fold: true,
          recap_payload_visible: true,
          local_only_actions_hidden: true,
          console_errors: [],
          page_errors: [],
        }),
      ),
    /source_folio_visible|bounded_source_visible/,
  );
});

test("rejects browser evidence that only proves the pre-answer source fallback", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence({
          legacy_upload_visible: false,
          manuscript_ready: true,
          conductor_terminal_fold: true,
          recap_payload_visible: true,
          source_folio_visible: true,
          bounded_source_visible: true,
          local_only_actions_hidden: true,
          console_errors: [],
          page_errors: [],
        }),
      ),
    /post_answer_source_folio_visible|post_answer_bounded_source_visible/,
  );
});

test("rejects post-answer Source Folio evidence without protocol event proof", () => {
  assert.throws(
    () =>
      assertReleaseBrowserEvidence(
        normalizeBrowserEvidence({
          legacy_upload_visible: false,
          manuscript_ready: true,
          conductor_terminal_fold: true,
          recap_payload_visible: true,
          source_folio_visible: true,
          bounded_source_visible: true,
          post_answer_source_folio_visible: true,
          post_answer_bounded_source_visible: true,
          local_only_actions_hidden: true,
          console_errors: [],
          page_errors: [],
        }),
      ),
    /post_answer_source_reference_event_seen|post_answer_concept_status_event_seen/,
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

function completeBrowserResult(overrides = {}) {
  return {
    artifact_dir: "artifacts/e2e-browser",
    legacy_upload_visible: false,
    manuscript_ready: true,
    conductor_terminal_fold: true,
    recap_payload_visible: true,
    next_session_recommendation_visible: true,
    source_folio_visible: true,
    bounded_source_visible: true,
    post_answer_source_folio_visible: true,
    post_answer_bounded_source_visible: true,
    post_answer_source_reference_event_seen: true,
    post_answer_concept_status_event_seen: true,
    local_only_actions_hidden: true,
    browser_story: completeBrowserStory(),
    console_errors: [],
    page_errors: [],
    ...overrides,
  };
}

function completeBrowserStory(overrides = {}) {
  const {
    artifact_audit = { scanned_files: 8, forbidden_hits: 0 },
    command_summary = {
      command: "bun run e2e:browser",
      provider: "synthetic",
      validation_run_id: "browser-story-synthetic",
    },
    fixture_hashes = {
      "synthetic-brain.json": {
        bytes: 1234,
        sha256: "6f3b31c1785f4bf02e4f7650d3674fa995c2f8d0979bf6f4628e1ea9fc4a3f55",
      },
    },
    omitFrameId,
    trace_retained = false,
  } = overrides;
  const frames = [
    {
      id: "pending_local_preview",
      screenshot: "pending-local-preview.png",
      kind: "structured_preview",
    },
    {
      id: "server_ready_study_set",
      screenshot: "server-ready-study-set.png",
      kind: "browser_screen",
    },
    {
      id: "active_synthetic_manuscript",
      screenshot: "source-folio.png",
      kind: "browser_screen",
    },
    {
      id: "recap",
      screenshot: "connected-terminal-fold.png",
      kind: "browser_screen",
    },
  ].filter((frame) => frame.id !== omitFrameId);

  return {
    schema: "viva.browser_story.v1",
    artifact_audit,
    command_summary,
    fixture_hashes,
    frames,
    sanitized: true,
    trace_retained,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) =>
          ![
            "artifact_audit",
            "command_summary",
            "fixture_hashes",
            "omitFrameId",
            "trace_retained",
          ].includes(key),
      ),
    ),
  };
}
