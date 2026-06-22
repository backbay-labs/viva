import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  addedLineViolatesRedactionAudit,
  assertNoForbiddenEvidenceMarkers,
  changedFileNeedsRedactionAudit,
  forbiddenStructuralFieldInText,
  redactForVivaLog,
} from "./redaction-control.mjs";

test("rejects evidence objects with raw answer or transcript fields", () => {
  assert.throws(
    () =>
      assertNoForbiddenEvidenceMarkers(
        {
          schema: "viva.test_evidence.v1",
          answer_text: "NADH donates electrons to the electron transport chain.",
          transcript_final: "learner said the raw answer aloud",
        },
        { context: "negative redaction fixture", env: {} },
      ),
    /negative redaction fixture.*answer_text/,
  );
});

test("redacts structurally forbidden log fields instead of serializing raw values", () => {
  const redacted = redactForVivaLog({
    answer_text: "NADH donates electrons to the electron transport chain.",
    answerText: "learner response",
    apiKey: "provider-key",
    duration_ms: 318,
    pastedText: "source text",
    session_token: "viva1.signed.payload",
    sessionToken: "client token",
    stage: "gemini",
    transcript_final: "learner said the raw answer aloud",
  });

  assert.deepEqual(redacted, {
    answer_text: "[redacted]",
    answerText: "[redacted]",
    apiKey: "[redacted]",
    duration_ms: 318,
    pastedText: "[redacted]",
    session_token: "[redacted]",
    sessionToken: "[redacted]",
    stage: "gemini",
    transcript_final: "[redacted]",
  });
  assert.doesNotMatch(JSON.stringify(redacted), /NADH|viva1|raw answer/i);
  assert.equal(redactForVivaLog({ message: "bearer lower-case-token" }).message, "[redacted]");
  assert.equal(redactForVivaLog({ protocols: "audio bearer.redacted-token" }).protocols, "[redacted]");
});

test("per-PR redaction check targets changed logging and evidence code", () => {
  assert.equal(changedFileNeedsRedactionAudit("scripts/release-check.mjs"), true);
  assert.equal(changedFileNeedsRedactionAudit("scripts/redaction-control.test.mjs"), false);
  assert.equal(changedFileNeedsRedactionAudit("agent/crates/agent-service/tests/voice_ws.rs"), false);
  assert.equal(changedFileNeedsRedactionAudit("apps/web/lib/viva-redaction.ts"), false);
  assert.equal(changedFileNeedsRedactionAudit("agent/crates/observe/src/lib.rs"), false);
  assert.equal(changedFileNeedsRedactionAudit("agent/fixtures/voice-protocol/session.json"), false);
  assert.equal(changedFileNeedsRedactionAudit("docs/data-governance.md"), false);
});

test("per-PR redaction check catches structural raw-payload fields", () => {
  assert.equal(
    redactForVivaLog({
      event: {
        prompt: "source-backed prompt should not be logged",
      },
    }).event.prompt,
    "[redacted]",
  );
  assert.equal(
    changedFileNeedsRedactionAudit("scripts/live-provider-smoke.mjs") &&
      addedLineViolatesRedactionAudit('  prompt: "raw"'),
    true,
  );
  assert.equal(forbiddenStructuralFieldInText("record({ prompt })"), "prompt");
  assert.equal(forbiddenStructuralFieldInText("record({ authorization })"), "authorization");
  assert.equal(forbiddenStructuralFieldInText("Self { api_key }"), "api_key");
  assert.equal(forbiddenStructuralFieldInText("record({ answerText })"), "answer_text");
  assert.equal(forbiddenStructuralFieldInText("record({ sessionToken })"), "session_token");
  assert.equal(addedLineViolatesRedactionAudit("  prompt_content_retained: true"), false);
});

test("per-PR redaction check fails when the configured base cannot be diffed", () => {
  const result = spawnSync(process.execPath, ["scripts/redaction-control-check.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      VIVA_REDACTION_BASE_REF: "refs/heads/definitely-missing-redaction-base",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to compute redaction diff from refs\/heads\/definitely-missing-redaction-base/);
});
