import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const REDACTED_VALUE = "[redacted]";

// Backstop denylist for generated artifacts. Structural redaction at logging and
// evidence boundaries is the primary defense; these markers catch regressions in
// changed PR code and generated evidence.
export const FORBIDDEN_EVIDENCE_MARKERS = Object.freeze([
  "pcm16_base64",
  "answer_text",
  "transcript_final",
  "source_context",
  "pasted_text",
  "session_token",
  "viva1.",
  "session-secret",
  "preload stroke volume cardiac output",
  "Stroke volume rises as ventricular preload",
  "NADH donates high-energy electrons",
  "received 4 PCM16 bytes",
  "CARTESIA_API_KEY",
  "GEMINI_API_KEY",
  "viva-release-check-cartesia-placeholder-key",
  "viva-release-check-gemini-placeholder-key",
  "Bearer ",
  "bearer.",
]);

export const FORBIDDEN_STRUCTURAL_FIELDS = Object.freeze([
  "answer_text",
  "answer_transcript",
  "api_key",
  "audio_blob",
  "audio_bytes",
  "authorization",
  "bearer",
  "password",
  "pcm16_base64",
  "pasted_text",
  "prompt",
  "raw_answer",
  "raw_audio",
  "raw_transcript",
  "secret",
  "session_token",
  "source_context",
  "source_excerpt",
  "token",
  "transcript_final",
  "transcript_text",
]);

const forbiddenStructuralFieldSet = new Set(
  FORBIDDEN_STRUCTURAL_FIELDS.map((field) => normalizeStructuralFieldName(field)),
);

const forbiddenCompoundStructuralFieldStems = [
  "answer",
  "answer_transcript",
  "raw_answer",
  "raw_audio",
  "raw_transcript",
  "prompt",
  "source_context",
  "source_excerpt",
  "transcript",
].map((field) => normalizeStructuralFieldName(field));

const forbiddenCompoundStructuralFieldTails = new Set([
  "base64",
  "blob",
  "body",
  "bytes",
  "content",
  "final",
  "payload",
  "text",
  "value",
]);

const ALLOWED_SANITIZED_BOOLEAN_PROOF_FIELDS = new Set([
  "back_forward_replayed_token",
  "bfcache_restore_replayed_token",
  "refresh_replayed_token",
]);

const SAFE_FORBIDDEN_MARKER_LITERALS = new Map([
  ["session_token", ["invalid_session_token", "session_token_nonce_store_unavailable"]],
]);

const SOURCE_AUDIT_SAFE_MARKER_OCCURRENCES = Object.freeze([
  {
    file: "agent/crates/agent-service/src/ws.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /\.claim_session_token_nonce\(/,
      /\.session_token_secret\.as_deref\(\)/,
      /initial\.session_token\.as_deref\(\)/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws.rs",
    marker: "token",
    patterns: Object.freeze([/let token = initial\.session_token\.as_deref\(\)/]),
  },
  {
    file: "agent/crates/agent-service/src/ws.rs",
    marker: "missing_api_key",
    patterns: Object.freeze([/BrainError::MissingApiKey => false/]),
  },
  {
    file: "apps/web/lib/viva-session-projection.ts",
    marker: "prompt",
    patterns: Object.freeze([/text: question\.prompt,/]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/llm.rs",
    marker: "api_key",
    patterns: Object.freeze([
      /api_key: "local-fixture"\.to_owned\(\),/,
      /api_key: "gemini-test-key"\.to_owned\(\),/,
      /assert_eq!\(capture\.api_key\.as_deref\(\), Some\("local-fixture"\)\);/,
      /assert_eq!\(capture\.api_key\.as_deref\(\), Some\("gemini-test-key"\)\);/,
      /api_key: Some\(request\.api_key\),/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/llm.rs",
    marker: "missing_api_key",
    patterns: Object.freeze([/BrainError::MissingApiKey => \(/]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs",
    marker: "api_key",
    patterns: Object.freeze([/api_key: "gemini-test-key"\.to_owned\(\),/]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /answer_text: "omitted",/,
      /"answer_text": "omitted",/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /config\.ws_access\.session_token_secret\.is_none\(\)/,
      /session_token_secret: Some\("session-secret"\.to_owned\(\)\)/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "session_token_secret",
    patterns: Object.freeze([/session_token_secret: Some\("session-secret"\.to_owned\(\)\)/]),
  },
  {
    file: "scripts/e2e-browser.mjs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /\.replace\(\/Bearer\\s\+\[A-Za-z0-9\._~\+\/=-\]\+\/gi, "Bearer redacted"\)/,
    ]),
  },
  {
    file: "scripts/e2e-browser.mjs",
    marker: "hosted_rest_bearer_token",
    patterns: Object.freeze([/process\.env\.VIVA_E2E_HOSTED_REST_BEARER_TOKEN/]),
  },
  {
    file: "scripts/e2e-browser.mjs",
    marker: "password",
    patterns: Object.freeze([/url\.password = ""/]),
  },
  {
    file: "scripts/e2e-browser.mjs",
    marker: "session_token",
    patterns: Object.freeze([
      /VIVA_VOICE_SESSION_TOKEN_SECRET: failureControlPlan\.enabled/,
      /failureControlEnv\.VIVA_VOICE_SESSION_TOKEN_SECRET/,
      /\.replace\(\/#session_token=/,
      /\.replace\(\/\[\?&\]session_token=/,
      /#session_token=\$\{encodeURIComponent\(/,
      /sessionPayload\.session_token/,
      /^\s*session_token: session\.sessionToken,?$/,
    ]),
  },
  {
    file: "scripts/e2e-browser.mjs",
    marker: "session_bootstrap_token",
    patterns: Object.freeze([
      /action\?\.session_bootstrap_token/,
      /^\s*session_bootstrap_token: action\.session_bootstrap_token,?$/,
    ]),
  },
  {
    file: "scripts/e2e-browser.mjs",
    marker: "viva_voice_session_token_secret",
    patterns: Object.freeze([
      /VIVA_VOICE_SESSION_TOKEN_SECRET: failureControlPlan\.enabled/,
      /failureControlEnv\.VIVA_VOICE_SESSION_TOKEN_SECRET/,
    ]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "bearer_token",
    patterns: Object.freeze([
      /^\s*const bearerToken = \($/,
      /^\s*if \(!bearerToken\) \{$/,
      /^\s*bearerToken,?$/,
    ]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "authorization",
    patterns: Object.freeze([/authorization: `AWS4-HMAC-SHA256 Credential=/]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "secret",
    patterns: Object.freeze([
      /hmac\(`AWS4\$\{secret\}`, dateStamp\)/,
      /^\s*secret: requiredValue\(env, "VIVA_VOICE_SESSION_TOKEN_SECRET"\),?$/,
      /^function signedLiveMonitorSession\(\{ secret, sessionId, studySetId, userId \}\) \{$/,
      /createHmac\("sha256", secret\)\.update\(payload\)\.digest\("base64url"\)/,
    ]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "session_token",
    patterns: Object.freeze([
      /VIVA_VOICE_SESSION_TOKEN_SECRET: requiredValue/,
      /^\s*secret: requiredValue\(env, "VIVA_VOICE_SESSION_TOKEN_SECRET"\),?$/,
      /^\s*\? \{ VIVA_LIVE_SMOKE_SESSION_TOKEN: liveConfig\.session\.signedSession \}$/,
      /^\s*VIVA_LIVE_SMOKE_SESSION_TOKEN: liveConfig\.session\.signedSession,?$/,
    ]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "viva1.",
    patterns: Object.freeze([/^\s*const payload = `viva1\.\$\{claimsPart\}`;$/]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "viva_voice_ws_bearer_token",
    patterns: Object.freeze([/^\s*VIVA_VOICE_WS_BEARER_TOKEN: liveConfig\.bearerToken,?$/]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "viva_live_smoke_session_token",
    patterns: Object.freeze([
      /^\s*\? \{ VIVA_LIVE_SMOKE_SESSION_TOKEN: liveConfig\.session\.signedSession \}$/,
      /^\s*VIVA_LIVE_SMOKE_SESSION_TOKEN: liveConfig\.session\.signedSession,?$/,
    ]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "viva_voice_session_token_secret",
    patterns: Object.freeze([
      /VIVA_VOICE_SESSION_TOKEN_SECRET: requiredValue/,
      /^\s*secret: requiredValue\(env, "VIVA_VOICE_SESSION_TOKEN_SECRET"\),?$/,
    ]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "viva_e2_e_hosted_rest_bearer_token",
    patterns: Object.freeze([/VIVA_E2E_HOSTED_REST_BEARER_TOKEN: requiredValue/]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "viva_failure_control_secret",
    patterns: Object.freeze([/VIVA_FAILURE_CONTROL_SECRET: requiredValue/]),
  },
  {
    file: "scripts/hosted-e2e-matrix.mjs",
    marker: "invalid_token",
    patterns: Object.freeze([
      /^\s*"invalid_token",?$/,
      /^\s*invalid_token: \["invalid_auth_material"\],?$/,
    ]),
  },
  {
    file: "scripts/hosted-e2e-matrix.mjs",
    marker: "expired_token",
    patterns: Object.freeze([
      /^\s*"expired_token",?$/,
      /^\s*expired_token: \["expired_auth_material"\],?$/,
    ]),
  },
  {
    file: "scripts/hosted-e2e-matrix.mjs",
    marker: "replayed_token",
    patterns: Object.freeze([
      /^\s*"replayed_token",?$/,
      /^\s*replayed_token: \["replayed_auth_material"\],?$/,
    ]),
  },
  {
    file: "scripts/hosted-e2e-matrix.mjs",
    marker: "malformed_token",
    patterns: Object.freeze([/^\s*malformed_token: \["malformed_auth_material"\],?$/]),
  },
  {
    file: "scripts/hosted-e2e-matrix.mjs",
    marker: "password",
    patterns: Object.freeze([/url\.password = ""/]),
  },
  {
    file: "scripts/production-release-gate.mjs",
    marker: "signing_secret",
    patterns: Object.freeze([
      /const signingSecret = stringOrNull\(env\.VIVA_RELEASE_BUNDLE_SIGNING_SECRET\);/,
      /signingSecret === null/,
      /createHmac\("sha256", signingSecret\)\.update\(payloadSha256\)\.digest\("hex"\)/,
      /signature_algorithm: signingSecret === null \? "sha256-self" : "hmac-sha256",/,
      /signature_key_present: signingSecret !== null,/,
      /pushUnless\(missing, "bundle_signing_secret", stringOrNull\(env\.VIVA_RELEASE_BUNDLE_SIGNING_SECRET\) !== null\);/,
    ]),
  },
  {
    file: "scripts/production-release-gate.mjs",
    marker: "viva_release_bundle_signing_secret",
    patterns: Object.freeze([
      /const signingSecret = stringOrNull\(env\.VIVA_RELEASE_BUNDLE_SIGNING_SECRET\);/,
      /pushUnless\(missing, "bundle_signing_secret", stringOrNull\(env\.VIVA_RELEASE_BUNDLE_SIGNING_SECRET\) !== null\);/,
    ]),
  },
  // A-12 (2026-08-25): coordinator-applied sanction rows for Plan 05's v5 wire
  // contract sources. Every pattern is an anchored literal of a reviewed line;
  // any new marker occurrence in these files still fails the audit. Plan 12
  // reconciles at 12B.
  {
    file: "agent/crates/agent-service/src/protocol.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*"answer_text",\s*$/,
      /^\s*require_wire_string\(evaluation\.get\("answer_text"\),\ format!\("\{path\}\.answer_text"\)\)\?;\s*$/,
      /^\s*Some\("answer_text"\)\ =>\ \{\s*$/,
      /^\s*ClientTurnIntent::AnswerText\ \{\ \.\.\ \}\ =>\ "answer_text",\s*$/,
      /^\s*let\ answer_text\ =\ fixture\.client\[1\]\["text"\]\s*$/,
      /^\s*\.send\(BrainInput::Text\(answer_text\)\)\s*$/,
      /^\s*"intent":\ \{\ "kind":\ "answer_text",\ "text":\ "NADH\ donates\ electrons\."\ \},\s*$/,
      /^\s*assert_eq!\(intents\[1\]\["intent"\]\["kind"\],\ json!\("answer_text"\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/protocol.rs",
    marker: "pcm16_base64",
    patterns: Object.freeze([
      /^\s*const\ PCM16_BASE64_PATH:\ \&str\ =\ "\$\.frame\.pcm16_base64";\s*$/,
      /^\s*require_only_wire_keys\(frame,\ \&\["pcm16_base64"\],\ \&format!\("\{path\}\.frame"\)\)\?;\s*$/,
      /^\s*frame\.get\("pcm16_base64"\),\s*$/,
      /^\s*format!\("\{path\}\.frame\.pcm16_base64"\),\s*$/,
      /^\s*\/\/\/\ Decodes\ `frame\.pcm16_base64`\ only\ long\ enough\ to\ enforce\ canonical\ padded\ base64\s*$/,
      /^\s*require_only_wire_keys\(frame,\ \&\["pcm16_base64"\],\ "\$\.frame"\)\?;\s*$/,
      /^\s*let\ Some\(encoded\)\ =\ frame\.get\("pcm16_base64"\)\ else\ \{\s*$/,
      /^\s*PCM16_BASE64_PATH,\s*$/,
      /^\s*VoiceProtocolDiagnostic::new\(VoiceProtocolDiagnosticCode::InvalidField,\ PCM16_BASE64_PATH\)\s*$/,
      /^\s*\/\/\/\ `pcm16_base64`\ is\ standard\ RFC\ 4648\ base64\ with\ padding\.\ Re\-encoding\ the\ decoded\s*$/,
      /^\s*"frame":\ \{\ "pcm16_base64":\ "AQIDBA=="\ \}\s*$/,
      /^\s*"frame":\ \{\ "pcm16_base64":\ encoded\ \},\s*$/,
      /^\s*assert_eq!\(diagnostic\.path,\ "\$\.frame\.pcm16_base64"\);\s*$/,
      /^\s*"frame":\ \{\ "pcm16_base64":\ "AQIDBA=="\ \},\s*$/,
      /^\s*let\ encoded\ =\ value\["frame"\]\["pcm16_base64"\]\s*$/,
      /^\s*assert_eq!\(audio_case\.path\.as_deref\(\),\ Some\("\$\.frame\.pcm16_base64"\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/protocol.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*const\ SESSION_CREDENTIAL_KEY:\ \&str\ =\ "session_token";\s*$/,
      /^\s*session_token:\ String,\s*$/,
      /^\s*let\ credential\ =\ configs\[0\]\["session_token"\]\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/protocol.rs",
    marker: "source_context",
    patterns: Object.freeze([
      /^\s*"source_context",\s*$/,
      /^\s*const\ SOURCE_CONTEXT_KEYS:\ \[\&str;\ 6\]\ =\ \[\s*$/,
      /^\s*const\ SOURCE_REFERENCE_KEYS:\ \[\&str;\ 6\]\ =\ SOURCE_CONTEXT_KEYS;\s*$/,
      /^\s*require_wire_array\(session\.get\("source_context"\),\ "\$\.session\.source_context"\)\?\s*$/,
      /^\s*let\ path\ =\ format!\("\$\.session\.source_context\[\{index\}\]"\);\s*$/,
      /^\s*require_only_wire_keys\(source,\ \&SOURCE_CONTEXT_KEYS,\ \&path\)\?;\s*$/,
      /^\s*"source_context"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/protocol.rs",
    marker: "transcript_final",
    patterns: Object.freeze([
      /^\s*"transcript_final",\s*$/,
      /^\s*"transcript_final"\ =>\ \{\s*$/,
      /^\s*let\ finals\ =\ session_events\(session,\ "transcript_final"\);\s*$/,
    ]),
  },
  {
    file: "packages/core/src/agent-contract.ts",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*answer_text:\ string;\s*$/,
      /^\s*\|\ \{\ kind:\ "answer_text";\ text:\ string\ \}\s*$/,
      /^\s*"answer_text",\s*$/,
      /^\s*answer_text:\ requireStringAt\(evaluation\.answer_text,\ `\$\{path\}\.answer_text`\),\s*$/,
      /^\s*if\ \(intent\.kind\ ===\ "answer_text"\)\ \{\s*$/,
      /^\s*return\ \{\ kind:\ "answer_text",\ text:\ requireStringAt\(intent\.text,\ "\$\.intent\.text"\)\ \};\s*$/,
    ]),
  },
  {
    file: "packages/core/src/agent-contract.ts",
    marker: "pcm16_base64",
    patterns: Object.freeze([
      /^\s*pcm16_base64:\ string;\s*$/,
      /^\s*frame:\ \{\ pcm16_base64:\ string\ \};\s*$/,
      /^\s*frame:\ \{\ pcm16_base64:\ input\.pcm16Base64\ \},\s*$/,
      /^\s*requireOnlyWireKeys\(frame,\ \["pcm16_base64"\],\ path\);\s*$/,
      /^\s*return\ \{\ pcm16_base64:\ requireNonEmptyStringAt\(frame\.pcm16_base64,\ `\$\{path\}\.pcm16_base64`\)\ \};\s*$/,
      /^\s*const\ PCM16_BASE64_PATH\ =\ "\$\.frame\.pcm16_base64";\s*$/,
      /^\s*\*\ Decodes\ `frame\.pcm16_base64`\ only\ long\ enough\ to\ enforce\ canonical\ padded\ base64\ and\s*$/,
      /^\s*requireOnlyWireKeys\(frame,\ \["pcm16_base64"\],\ "\$\.frame"\);\s*$/,
      /^\s*if\ \(!\("pcm16_base64"\ in\ frame\)\)\ \{\s*$/,
      /^\s*PCM16_BASE64_PATH,\s*$/,
      /^\s*"Missing\ pcm16_base64",\s*$/,
      /^\s*"Invalid\ pcm16_base64",\s*$/,
      /^\s*const\ encoded\ =\ frame\.pcm16_base64;\s*$/,
      /^\s*return\ \{\ pcm16_base64:\ encoded\ \};\s*$/,
      /^\s*\*\ `pcm16_base64`\ is\ standard\ RFC\ 4648\ base64\ with\ padding\.\ Re\-encoding\ the\ decoded\s*$/,
    ]),
  },
  {
    file: "packages/core/src/agent-contract.ts",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*prompt:\ string;\s*$/,
      /^\s*retry_prompt:\ string;\s*$/,
      /^\s*\["question_id",\ "concept_id",\ "prompt",\ "expected_terms",\ "follow_up",\ "rubric",\ "source"\],\s*$/,
      /^\s*prompt:\ requireNonEmptyStringAt\(question\.prompt,\ `\$\{path\}\.prompt`\),\s*$/,
      /^\s*"retry_prompt",\s*$/,
      /^\s*retry_prompt:\ requireNonEmptyStringAt\(evaluation\.retry_prompt,\ `\$\{path\}\.retry_prompt`\),\s*$/,
    ]),
  },
  {
    file: "packages/core/src/agent-contract.ts",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*const\ SESSION_CREDENTIAL_KEY\ =\ "session_token";\s*$/,
      /^\s*session_token:\ string;\s*$/,
      /^\s*session_token:\ signedCredential,\s*$/,
      /^\s*session_token:\ requireWireCredential\(frame\[SESSION_CREDENTIAL_KEY\]\),\s*$/,
    ]),
  },
  {
    file: "packages/core/src/agent-contract.ts",
    marker: "source_context",
    patterns: Object.freeze([
      /^\s*source_context:\ AgentSourceContext\[\];\s*$/,
      /^\s*"source_context",\s*$/,
      /^\s*source_context:\ requireArrayAt\(session\.source_context,\ "\$\.session\.source_context"\)\.map\(\s*$/,
      /^\s*\(source,\ index\)\ =>\ parseSourceContext\(source,\ `\$\.session\.source_context\[\$\{index\}\]`\),\s*$/,
      /^\s*source_context:\ config\.source_context,\s*$/,
    ]),
  },
  {
    file: "packages/core/src/agent-contract.ts",
    marker: "transcript_final",
    patterns: Object.freeze([
      /^\s*type:\ "transcript_final";\s*$/,
      /^\s*"transcript_final",\s*$/,
      /^\s*case\ "transcript_final":\s*$/,
      /^\s*type:\ "transcript_final",\s*$/,
    ]),
  },
]);

const AUDITED_FILE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx", ".rs", ".yml", ".yaml"]);

const RUNTIME_REDACTION_BOUNDARY_FILES = new Set([
  "apps/web/lib/viva-redaction.ts",
  "agent/crates/observe/src/lib.rs",
  "scripts/production-release-gate.mjs",
  "scripts/release-check.mjs",
]);

const RUNTIME_REDACTION_BOUNDARY_MARKER_CONSTANTS = new Map([
  [
    "apps/web/lib/viva-redaction.ts",
    new Set([
      "answer",
      "answer_text",
      "answer_transcript",
      "api_key",
      "audio_blob",
      "audio_bytes",
      "authorization",
      "bearer",
      "bearer.",
      "Bearer ",
      "CARTESIA_API_KEY",
      "GEMINI_API_KEY",
      "password",
      "pasted_text",
      "pcm16_base64",
      "prompt",
      "raw answer",
      "raw_answer",
      "raw_audio",
      "raw_transcript",
      "secret",
      "session_token",
      "source excerpt",
      "source_context",
      "source_excerpt",
      "token",
      "transcript",
      "transcript_final",
      "transcript_text",
      "viva1.",
    ]),
  ],
  [
    "agent/crates/observe/src/lib.rs",
    new Set([
      "answer_text",
      "answertext",
      "api_key",
      "apikey",
      "authorization",
      "bearer",
      "bearer ",
      "bearer.",
      "cartesia_api_key",
      "control_token",
      "controltoken",
      "gemini_api_key",
      "password",
      "pasted_text",
      "pastedtext",
      "pcm16_base64",
      "prompt_content",
      "promptcontent",
      "raw answer",
      "raw_answer_text",
      "rawanswertext",
      "raw_audio",
      "rawaudio",
      "raw_transcript",
      "rawtranscript",
      "secret",
      "session_token",
      "source excerpt",
      "source_context",
      "sourcecontext",
      "source_excerpt_text",
      "sourceexcerpttext",
      "token",
      "transcript_final",
      "transcriptfinal",
      "viva1.",
    ]),
  ],
  [
    "scripts/production-release-gate.mjs",
    new Set([
      "answer_text",
      "Bearer ",
      "CARTESIA_API_KEY",
      "GEMINI_API_KEY",
      "pasted_text",
      "pcm16_base64",
      "provider_prompt",
      "raw_prompt",
      "session-secret",
      "session_token",
      "source_context",
      "transcript_final",
      "viva1.",
    ]),
  ],
  [
    "scripts/release-check.mjs",
    new Set([
      "NADH donates high-energy electrons",
      "received 4 PCM16 bytes",
      "viva-release-check-cartesia-placeholder-key",
      "viva-release-check-gemini-placeholder-key",
    ]),
  ],
]);

export function redactForVivaLog(value) {
  return redactValue(value, null);
}

export function assertNoForbiddenEvidenceMarkers(
  value,
  { context = "evidence", env = process.env } = {},
) {
  const structuralHits = collectForbiddenStructuralFields(value);
  if (structuralHits.length > 0) {
    throw new Error(
      `${context} includes forbidden evidence field: ${structuralHits.slice(0, 5).join(", ")}`,
    );
  }
  assertNoForbiddenTextMarkers(serializedForAudit(value), { context, env });
}

export function assertNoForbiddenTextMarkers(
  text,
  { context = "artifact", env = process.env } = {},
) {
  const marker = forbiddenEvidenceMarkerInText(text);
  if (marker) {
    throw new Error(`${context} includes forbidden payload marker: ${marker}`);
  }
  for (const [name, value] of Object.entries(env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
    if (value && value.length >= 8 && text.includes(value)) {
      throw new Error(`${context} includes secret value from ${name}`);
    }
  }
}

export async function auditTextArtifacts(
  dirs,
  { rootDir = process.cwd(), context = "artifact", env = process.env, zipMessage } = {},
) {
  let scanned_files = 0;
  for (const dir of dirs) {
    for (const file of await listFiles(dir)) {
      const relative = path.relative(rootDir, file);
      if (file.endsWith(".zip")) {
        throw new Error(
          zipMessage?.(relative) ?? `${context} includes unsanitized trace archive: ${relative}`,
        );
      }
      if (!isTextArtifact(file)) continue;
      scanned_files += 1;
      const text = await readFile(file, "utf8");
      assertNoForbiddenStructuralTextFields(text, {
        context: `${context} ${relative}`,
      });
      assertNoForbiddenTextMarkers(text, {
        context: `${context} ${relative}`,
        env,
      });
    }
  }
  return {
    scanned_files,
    forbidden_hits: 0,
  };
}

export function changedFileNeedsRedactionAudit(file) {
  if (!file || file.startsWith("docs/")) return false;
  if (
    file.includes("/fixtures/") ||
    file.includes("/tests/") ||
    file.endsWith(".test.mjs") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx")
  ) {
    return false;
  }
  if (file === "scripts/redaction-control.mjs" || file === "scripts/redaction-control-check.mjs") {
    return false;
  }
  const extension = path.extname(file);
  if (!AUDITED_FILE_EXTENSIONS.has(extension)) return false;
  return /(^scripts\/|^apps\/web\/|^agent\/crates\/|^packages\/|^\.github\/workflows\/)/.test(file);
}

export function addedLineViolatesRedactionAudit(line, { file } = {}) {
  if (markerConstantAllowedInRuntimeRedactionBoundary(line, file)) return false;
  const evidenceMarker = forbiddenEvidenceMarkerInText(line);
  if (evidenceMarker && !sourceAuditEvidenceMarkerAllowed(line, file, evidenceMarker)) return true;
  const structuralField = forbiddenStructuralFieldInText(line);
  return Boolean(
    structuralField && !sourceAuditStructuralFieldAllowed(line, file, structuralField),
  );
}

export function forbiddenEvidenceMarkerInText(text) {
  const normalized = text.toLowerCase();
  return FORBIDDEN_EVIDENCE_MARKERS.find((marker) => {
    const normalizedMarker = marker.toLowerCase();
    let index = normalized.indexOf(normalizedMarker);
    while (index >= 0) {
      if (!safeForbiddenMarkerOccurrence(normalized, index, normalizedMarker)) return true;
      index = normalized.indexOf(normalizedMarker, index + normalizedMarker.length);
    }
    return false;
  });
}

export function forbiddenStructuralFieldInText(text) {
  const candidatePatterns = [
    { pattern: /(^|[{\s,])["']([A-Za-z_][A-Za-z0-9_-]*)["']\s*:/g, group: 2 },
    { pattern: /(^|[^A-Za-z0-9_$])([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]/g, group: 2 },
    { pattern: /[{,]\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[,}])/g, group: 1 },
    { pattern: /\[\s*["']([A-Za-z_][A-Za-z0-9_-]*)["']\s*\]/g, group: 1 },
    { pattern: /=\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[;,\])}]|$)/g, group: 1 },
    { pattern: /\breturn\s+([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[;,\])}]|$)/g, group: 1 },
    { pattern: /\.([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[;,\])}]|$)/g, group: 1 },
  ];
  for (const { pattern, group } of candidatePatterns) {
    let match = pattern.exec(text);
    while (match) {
      const normalized = normalizeStructuralFieldName(match[group]);
      if (allowedSanitizedBooleanProofFieldOccurrence(text, match, group, normalized)) {
        match = pattern.exec(text);
        continue;
      }
      if (isForbiddenStructuralField(normalized)) return normalized;
      match = pattern.exec(text);
    }
  }
  return undefined;
}

function assertNoForbiddenStructuralTextFields(text, { context = "artifact" } = {}) {
  const field = forbiddenStructuralFieldInText(text);
  if (field) {
    throw new Error(`${context} includes forbidden evidence field: ${field}`);
  }
}

function redactValue(value, key) {
  if (key && isForbiddenStructuralField(key)) return REDACTED_VALUE;
  if (typeof value === "string") {
    return forbiddenEvidenceMarkerInText(value)
      ? REDACTED_VALUE
      : value.replace(/\s+/g, " ").slice(0, 240);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, null));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function collectForbiddenStructuralFields(value, prefix = "") {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectForbiddenStructuralFields(entry, `${prefix}[${index}]`),
    );
  }
  if (!isRecord(value)) return [];
  const hits = [];
  for (const [key, entryValue] of Object.entries(value)) {
    const pathPrefix = prefix ? `${prefix}.${key}` : key;
    if (isForbiddenStructuralField(key)) {
      hits.push(pathPrefix);
      continue;
    }
    hits.push(...collectForbiddenStructuralFields(entryValue, pathPrefix));
  }
  return hits;
}

function isForbiddenStructuralField(key) {
  const normalized = normalizeStructuralFieldName(key);
  return (
    forbiddenStructuralFieldSet.has(normalized) ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_password") ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_token") ||
    isForbiddenCompoundStructuralField(normalized)
  );
}

function isForbiddenCompoundStructuralField(normalized) {
  return forbiddenCompoundStructuralFieldStems.some((stem) => {
    if (!normalized.startsWith(`${stem}_`)) return false;
    const tail = normalized
      .slice(stem.length + 1)
      .split("_")
      .at(-1);
    return Boolean(tail && forbiddenCompoundStructuralFieldTails.has(tail));
  });
}

function allowedSanitizedBooleanProofFieldOccurrence(text, match, group, normalized) {
  if (!ALLOWED_SANITIZED_BOOLEAN_PROOF_FIELDS.has(normalized)) return false;
  const matchedText = match[0];
  const field = match[group];
  const fieldOffset = matchedText.indexOf(field);
  if (fieldOffset < 0) return false;
  const fieldStart = match.index + fieldOffset;
  const preceding = text[fieldStart - 1] ?? "";
  if (preceding && !/[{"'\s,]/.test(preceding)) return false;
  const afterField = text.slice(fieldStart + field.length);
  return /^["']?\s*[:=]\s*(?:true|false)\s*(?=[,}\]\n\r]|$)/.test(afterField);
}

function sourceAuditEvidenceMarkerAllowed(line, file, marker) {
  return SOURCE_AUDIT_SAFE_MARKER_OCCURRENCES.some((entry) => {
    return (
      entry.file === file &&
      entry.marker === marker &&
      entry.patterns.some((pattern) => pattern.test(line))
    );
  });
}

function sourceAuditStructuralFieldAllowed(line, file, field) {
  return sourceAuditEvidenceMarkerAllowed(line, file, field);
}

function markerConstantAllowedInRuntimeRedactionBoundary(line, file) {
  if (!RUNTIME_REDACTION_BOUNDARY_FILES.has(file)) return false;
  const literal = /^\s*["']([^"']+)["']\s*,?\s*$/.exec(line)?.[1];
  if (!literal) return false;
  return RUNTIME_REDACTION_BOUNDARY_MARKER_CONSTANTS.get(file)?.has(literal) === true;
}

function safeForbiddenMarkerOccurrence(text, index, marker) {
  const safeLiterals = SAFE_FORBIDDEN_MARKER_LITERALS.get(marker);
  if (!safeLiterals) return false;
  return safeLiterals.some((literal) => {
    const markerOffset = literal.indexOf(marker);
    if (markerOffset < 0) return false;
    const literalStart = index - markerOffset;
    if (literalStart < 0) return false;
    if (text.slice(literalStart, literalStart + literal.length) !== literal) return false;
    const before = text[literalStart - 1] ?? "";
    const after = text[literalStart + literal.length] ?? "";
    return (!before || /["'\s:[,]/.test(before)) && (!after || /["'\s,}\]]/.test(after));
  });
}

function serializedForAudit(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isTextArtifact(file) {
  return /\.(json|log|txt|stdout|stderr)$/i.test(file);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStructuralFieldName(key) {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s]+/g, "_")
    .toLowerCase();
}
