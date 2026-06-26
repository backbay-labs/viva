import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addedLineViolatesRedactionAudit,
  assertNoForbiddenEvidenceMarkers,
  auditTextArtifacts,
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
    APIKey: "provider-key-acronym",
    cartesiaAPIKey: "cartesia-provider-key",
    controlToken: "opaque-control-token",
    duration_ms: 318,
    pastedText: "source text",
    promptContent: "question stem",
    rawAnswerText: "learner response compound",
    session_token: "viva1.signed.payload",
    sessionToken: "client token",
    sourceExcerptText: "chapter quote",
    stage: "gemini",
    token: "opaque-bearer-token",
    transcript_final: "learner said the raw answer aloud",
  });

  assert.deepEqual(redacted, {
    answer_text: "[redacted]",
    answerText: "[redacted]",
    apiKey: "[redacted]",
    APIKey: "[redacted]",
    cartesiaAPIKey: "[redacted]",
    controlToken: "[redacted]",
    duration_ms: 318,
    pastedText: "[redacted]",
    promptContent: "[redacted]",
    rawAnswerText: "[redacted]",
    session_token: "[redacted]",
    sessionToken: "[redacted]",
    sourceExcerptText: "[redacted]",
    stage: "gemini",
    token: "[redacted]",
    transcript_final: "[redacted]",
  });
  assert.doesNotMatch(JSON.stringify(redacted), /NADH|viva1|raw answer/i);
  assert.equal(redactForVivaLog({ message: "bearer lower-case-token" }).message, "[redacted]");
  assert.equal(
    redactForVivaLog({ protocols: "audio bearer.redacted-token" }).protocols,
    "[redacted]",
  );
});

test("per-PR redaction check targets changed logging and evidence code", () => {
  assert.equal(changedFileNeedsRedactionAudit("scripts/release-check.mjs"), true);
  assert.equal(changedFileNeedsRedactionAudit("scripts/redaction-control.mjs"), false);
  assert.equal(changedFileNeedsRedactionAudit("scripts/redaction-control-check.mjs"), false);
  assert.equal(changedFileNeedsRedactionAudit("scripts/redaction-control.test.mjs"), false);
  assert.equal(
    changedFileNeedsRedactionAudit("agent/crates/agent-service/tests/voice_ws.rs"),
    false,
  );
  assert.equal(changedFileNeedsRedactionAudit("apps/web/lib/viva-redaction.ts"), true);
  assert.equal(changedFileNeedsRedactionAudit("agent/crates/observe/src/lib.rs"), true);
  assert.equal(changedFileNeedsRedactionAudit("agent/fixtures/voice-protocol/session.json"), false);
  assert.equal(changedFileNeedsRedactionAudit("docs/data-governance.md"), false);
});

test("per-PR redaction check audits unsafe additions in runtime redaction boundary files", () => {
  assert.equal(
    changedFileNeedsRedactionAudit("apps/web/lib/viva-redaction.ts") &&
      addedLineViolatesRedactionAudit("  return { prompt };", {
        file: "apps/web/lib/viva-redaction.ts",
      }),
    true,
  );
  assert.equal(
    changedFileNeedsRedactionAudit("agent/crates/observe/src/lib.rs") &&
      addedLineViolatesRedactionAudit('  let detail = "raw_transcript=value";', {
        file: "agent/crates/observe/src/lib.rs",
      }),
    true,
  );
});

test("per-PR redaction check permits marker constants in runtime redaction boundary files", () => {
  assert.equal(
    addedLineViolatesRedactionAudit('    "session_token",', {
      file: "apps/web/lib/viva-redaction.ts",
    }),
    false,
  );
  assert.equal(
    addedLineViolatesRedactionAudit('    "raw_audio",', {
      file: "agent/crates/observe/src/lib.rs",
    }),
    false,
  );
  assert.equal(addedLineViolatesRedactionAudit('    "session_token",'), true);
  assert.equal(
    addedLineViolatesRedactionAudit('  const leak = "session_token";', {
      file: "apps/web/lib/viva-redaction.ts",
    }),
    true,
  );
});

test("per-PR redaction check rejects raw literal values in runtime redaction boundary files", () => {
  for (const line of [
    '    "viva1.secret-token",',
    '    "/session#session_token=value",',
    '    "Bearer sk_live_secret",',
    '    "NADH donates high-energy electrons",',
  ]) {
    assert.equal(
      addedLineViolatesRedactionAudit(line, {
        file: "apps/web/lib/viva-redaction.ts",
      }),
      true,
      line,
    );
  }
});

test("per-PR redaction check rejects marker constants with forbidden comment tails", () => {
  for (const line of [
    '    "session_token", // /session#session_token=value',
    '    "viva1.", // viva1.secret-token',
    '    "Bearer ", // Bearer sk_live_secret',
    '    "answer_text", // NADH donates high-energy electrons',
  ]) {
    assert.equal(
      addedLineViolatesRedactionAudit(line, {
        file: "apps/web/lib/viva-redaction.ts",
      }),
      true,
      line,
    );
  }
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
  assert.equal(forbiddenStructuralFieldInText("const detail = authorization;"), "authorization");
  assert.equal(forbiddenStructuralFieldInText("const detail = authorization"), "authorization");
  assert.equal(forbiddenStructuralFieldInText("return authorization"), "authorization");
  assert.equal(forbiddenStructuralFieldInText('headers["authorization"]'), "authorization");
  assert.equal(forbiddenStructuralFieldInText("record({ controlToken })"), "control_token");
  assert.equal(forbiddenStructuralFieldInText("Self { cartesiaAPIKey }"), "cartesia_api_key");
  assert.equal(forbiddenStructuralFieldInText("record({ promptContent })"), "prompt_content");
  assert.equal(forbiddenStructuralFieldInText("record({ rawAnswerText })"), "raw_answer_text");
  assert.equal(
    forbiddenStructuralFieldInText("record({ sourceExcerptText })"),
    "source_excerpt_text",
  );
  assert.equal(forbiddenStructuralFieldInText('{"message":"invalid session token"}'), undefined);
  assert.equal(forbiddenStructuralFieldInText("invalid session token"), undefined);
  assert.equal(addedLineViolatesRedactionAudit("  prompt_content_retained: true"), false);
});

test("per-PR redaction check permits required auth source identifiers only in source audit", () => {
  assert.equal(
    addedLineViolatesRedactionAudit(
      "let claim_result = state.study_store.claim_session_token_nonce(claim).await;",
      {
        file: "agent/crates/agent-service/src/ws.rs",
      },
    ),
    false,
  );
  assert.equal(
    addedLineViolatesRedactionAudit(
      "let token = initial.session_token.as_deref().ok_or_else(|| {",
      {
        file: "agent/crates/agent-service/src/ws.rs",
      },
    ),
    false,
  );
  assert.equal(
    addedLineViolatesRedactionAudit("let leaked = evidence.session_token;", {
      file: "agent/crates/agent-service/src/ws.rs",
    }),
    true,
  );
  assert.throws(
    () =>
      assertNoForbiddenEvidenceMarkers({
        schema: "viva.generated_evidence.v1",
        session_token: "placeholder-session-material",
      }),
    /forbidden evidence field: session_token/,
  );
});

test("artifact audit catches structural sensitive fields even without denylist marker values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "viva-redaction-artifacts-"));
  try {
    const file = path.join(dir, "evidence.json");
    await writeFile(
      file,
      JSON.stringify({
        schema: "viva.generated_evidence.v1",
        controlToken: "opaque-control-value",
        APIKey: "opaque-provider-value",
        rawAnswerText: "plain learner content",
      }),
    );

    await assert.rejects(
      () => auditTextArtifacts([dir], { rootDir: dir, context: "artifact", env: {} }),
      /artifact .* includes forbidden evidence field:/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact audit permits sanitized auth failure copy that mentions token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "viva-redaction-safe-artifacts-"));
  try {
    const file = path.join(dir, "browser-story.json");
    await writeFile(
      file,
      JSON.stringify({
        schema: "viva.browser_story.v1",
        message: "invalid session token",
        terminalReason: "session_auth_rejected",
      }),
    );

    await assert.doesNotReject(() =>
      auditTextArtifacts([dir], { rootDir: dir, context: "artifact", env: {} }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence audit permits exact invalid-session terminal reason", () => {
  assert.doesNotThrow(() =>
    assertNoForbiddenEvidenceMarkers(
      {
        schema: "viva.terminal_evidence.v1",
        terminal_reason: "invalid_session_token",
      },
      { context: "terminal evidence", env: {} },
    ),
  );
  assert.throws(
    () =>
      assertNoForbiddenEvidenceMarkers(
        {
          schema: "viva.terminal_evidence.v1",
          detail: "invalid_session_token=value",
        },
        { context: "terminal evidence", env: {} },
      ),
    /terminal evidence includes forbidden payload marker: session_token/,
  );
});

test("artifact audit permits sanitized token lifecycle proof booleans", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "viva-redaction-token-proof-artifacts-"));
  try {
    const file = path.join(dir, "result.json");
    await writeFile(
      file,
      JSON.stringify({
        schema: "viva.browser_story_result.v1",
        session_url_audit: {
          back_forward_replayed_token: false,
          bfcache_restore_replayed_token: false,
          refresh_replayed_token: false,
          token_values_redacted: true,
        },
      }),
    );

    await assert.doesNotReject(() =>
      auditTextArtifacts([dir], { rootDir: dir, context: "Browser story artifact", env: {} }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact audit rejects token lifecycle proof fields with non-boolean values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "viva-redaction-token-proof-string-"));
  try {
    const file = path.join(dir, "result.json");
    await writeFile(
      file,
      JSON.stringify({
        schema: "viva.browser_story_result.v1",
        session_url_audit: {
          back_forward_replayed_token: "opaque-session-value",
        },
      }),
    );

    await assert.rejects(
      () =>
        auditTextArtifacts([dir], {
          rootDir: dir,
          context: "Browser story artifact",
          env: {},
        }),
      /Browser story artifact .* includes forbidden evidence field: back_forward_replayed_token/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact audit still rejects raw session URL token fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "viva-redaction-session-url-artifacts-"));
  try {
    const file = path.join(dir, "result.json");
    await writeFile(
      file,
      JSON.stringify({
        schema: "viva.browser_story_result.v1",
        session_url: "/session?session_token=value",
      }),
    );

    await assert.rejects(
      () =>
        auditTextArtifacts([dir], {
          rootDir: dir,
          context: "Browser story artifact",
          env: {},
        }),
      /Browser story artifact .* includes forbidden evidence field: session_token/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  assert.match(
    result.stderr,
    /Unable to compute redaction diff from refs\/heads\/definitely-missing-redaction-base/,
  );
});
