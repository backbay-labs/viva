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
  // A-15 (2026-08-25): coordinator-applied sanction rows for Plan 09's data-store
  // and observe sources (node 09 admission). Anchored literals of reviewed lines
  // only; new marker occurrences still fail. Plan 12 reconciles at 12B.
  {
    file: "agent/crates/data/src/lib.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*\/\/\/\ whose\ question\ id\ is\ exactly\ `q\-\{concept\ public\ id\}`\ and\ whose\ prompt\ is\ the\s*$/,
      /^\s*prompt:\ \&str,\s*$/,
      /^\s*claim:\ prompt\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*answer_text:\ "NADH\ donates\ electrons\."\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "NADH\ gives\ electrons\."\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "mitosis\ chromosome\ spindle"\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "photosynthesis\ chloroplast"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory.rs",
    marker: "authorization",
    patterns: Object.freeze([
      /^\s*\/\/\/\ `DATA\-015`:\ authorization\ —\ the\ canonical\ browser\-event\ digest\ and\ the\ nonce\s*$/,
      /^\s*mod\ authorization;\s*$/,
      /^\s*pub\(crate\)\ use\ authorization::\{\s*$/,
      /^\s*current_epoch_seconds,\ event_authorization_record,\ payload_sha256,\ ConceptStatusEventPayload,\s*$/,
      /^\s*EventAuthorizationKind,\ EventAuthorizationRecord,\ ReviewScheduleEventPayload,\s*$/,
      /^\s*\/\/\/\ `DATA\-005`:\ a\ set,\ not\ a\ log\.\ Authorization\ is\ only\ ever\ consulted\ by\s*$/,
      /^\s*pub\ event_authorizations:\ HashSet<EventAuthorizationRecord>,\s*$/,
      /^\s*authorization::evict_session_locked\(\&mut\ state,\ voice_session_id\);\s*$/,
      /^\s*authorization::authorize_question_started\(\s*$/,
      /^\s*authorization::authorize_answer_evaluation\(\s*$/,
      /^\s*authorization::authorize_source_reference\(\s*$/,
      /^\s*authorization::authorize_concept_status\(\s*$/,
      /^\s*authorization::authorize_manuscript_intent\(\s*$/,
      /^\s*authorization::authorize_recap\(\s*$/,
      /^\s*let\ authorization\ =\ event_authorization_record\(\s*$/,
      /^\s*EventAuthorizationKind::AnswerEvaluation,\s*$/,
      /^\s*\/\/\ a\ late\ authorization\ digest\.\s*$/,
      /^\s*authorization::record_locked\(\&mut\ state,\ authorization\);\s*$/,
      /^\s*EventAuthorizationKind::ConceptStatus,\s*$/,
      /^\s*if\ authorization::is_recorded_locked\(\&state,\ \&authorization\)\ \{\s*$/,
      /^\s*EventAuthorizationKind::StudySessionRecap,\s*$/,
      /^\s*\/\/\/\ progression\ effect,\ and\ its\ browser\ authorization\ digests,\ all\ under\ one\s*$/,
      /^\s*\/\/\/\ `DATA\-005`:\ the\ in\-memory\ authorization\ ledger\ is\ a\ set,\ not\ a\ log\.\s*$/,
      /^\s*\/\/\/\ Authorization\ is\ only\ ever\ consulted\ by\ membership,\ so\ an\ identical\ replay\s*$/,
      /^\s*async\ fn\ memory_authorization_replay_is_deduplicated_and_bounded\(\)\ \{\s*$/,
      /^\s*assert_eq!\(store\.snapshot\(\)\.event_authorizations\.len\(\),\ 3\);\s*$/,
      /^\s*\/\/\ Deduplication\ must\ not\ weaken\ live\ authorization\.\s*$/,
      /^\s*async\ fn\ close_voice_session_evicts_event_authorizations\(\)\ \{\s*$/,
      /^\s*assert_eq!\(store\.snapshot\(\)\.event_authorizations\.len\(\),\ 1\);\s*$/,
      /^\s*assert!\(store\.snapshot\(\)\.event_authorizations\.is_empty\(\)\);\s*$/,
      /^\s*state\.event_authorizations\.is_empty\(\),\s*$/,
      /^\s*"deletion\ must\ not\ be\ followed\ by\ a\ late\ authorization\ digest"\s*$/,
      /^\s*\/\/\/\ Both\ backends\ must\ leave\ the\ same\ authorization\ ledger\ behind\.\ A\ replay\s*$/,
      /^\s*\/\/\/\ performs\ no\ write,\ so\ it\ must\ not\ append\ a\ second\ authorization\ either\.\s*$/,
      /^\s*async\ fn\ review_schedule_decision_replay_records_exactly_one_authorization\(\)\ \{\s*$/,
      /^\s*store\.snapshot\(\)\.event_authorizations\.len\(\),\s*$/,
      /^\s*"a\ replay\ writes\ nothing,\ so\ it\ appends\ no\ second\ authorization"\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory.rs",
    marker: "owner_password",
    patterns: Object.freeze([
      /^\s*const\ OWNER_PASSWORD:\ \&\[u8\]\ =\ b"viva\-owner";\s*$/,
      /^\s*let\ owner_digest\ =\ md5\(\&padded_password\(OWNER_PASSWORD\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory.rs",
    marker: "password",
    patterns: Object.freeze([
      /^\s*const\ PDF_PASSWORD_PADDING:\ \[u8;\ 32\]\ =\ \[\s*$/,
      /^\s*fn\ padded_password\(password:\ \&\[u8\]\)\ \->\ \[u8;\ 32\]\ \{\s*$/,
      /^\s*let\ taken\ =\ password\.len\(\)\.min\(32\);\s*$/,
      /^\s*padded\[\.\.taken\]\.copy_from_slice\(\&password\[\.\.taken\]\);\s*$/,
      /^\s*padded\[taken\.\.\]\.copy_from_slice\(\&PDF_PASSWORD_PADDING\[\.\.32\ \-\ taken\]\);\s*$/,
      /^\s*\/\/\/\ test\ passwords\.\ Algorithms\ 2,\ 3,\ 4\ and\ 1\ from\ the\ PDF\ specification\.\s*$/,
      /^\s*const\ USER_PASSWORD:\ \&\[u8\]\ =\ b"viva\-user";\s*$/,
      /^\s*const\ OWNER_PASSWORD:\ \&\[u8\]\ =\ b"viva\-owner";\s*$/,
      /^\s*let\ owner_digest\ =\ md5\(\&padded_password\(OWNER_PASSWORD\)\);\s*$/,
      /^\s*let\ owner_entry\ =\ rc4\(\&owner_digest\[\.\.5\],\ \&padded_password\(USER_PASSWORD\)\);\s*$/,
      /^\s*key_input\.extend_from_slice\(\&padded_password\(USER_PASSWORD\)\);\s*$/,
      /^\s*let\ user_entry\ =\ rc4\(\&encryption_key,\ \&PDF_PASSWORD_PADDING\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*SESSION_TOKEN_NONCE_SKEW_SECONDS,\s*$/,
      /^\s*pub\ session_token_nonces:\ Vec<SessionTokenNonceClaim>,\s*$/,
      /^\s*async\ fn\ claim_session_token_nonce\(\s*$/,
      /^\s*self\.claim_session_token_nonce_at\(claim,\ current_epoch_seconds\(\)\)\s*$/,
      /^\s*\.claim_session_token_nonce\(session_nonce\)\s*$/,
      /^\s*assert_eq!\(store\.snapshot\(\)\.session_token_nonces\.len\(\),\ 1\);\s*$/,
      /^\s*assert!\(session_deleted\.session_token_nonces\.is_empty\(\)\);\s*$/,
      /^\s*\.claim_session_token_nonce\(study_nonce\)\s*$/,
      /^\s*assert!\(study_deleted\.session_token_nonces\.is_empty\(\)\);\s*$/,
      /^\s*assert!\(after\.session_token_nonces\.is_empty\(\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory.rs",
    marker: "user_password",
    patterns: Object.freeze([
      /^\s*const\ USER_PASSWORD:\ \&\[u8\]\ =\ b"viva\-user";\s*$/,
      /^\s*let\ owner_entry\ =\ rc4\(\&owner_digest\[\.\.5\],\ \&padded_password\(USER_PASSWORD\)\);\s*$/,
      /^\s*key_input\.extend_from_slice\(\&padded_password\(USER_PASSWORD\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/authorization.rs",
    marker: "authorization",
    patterns: Object.freeze([
      /^\s*\/\/!\ Authorization\ and\ nonces:\ what\ a\ browser\ event\ is\ allowed\ to\ claim\s*$/,
      /^\s*\/\/\/\ The\ one\ canonical\ authorization\ record\ both\ backends\ build\.\s*$/,
      /^\s*pub\(crate\)\ fn\ event_authorization_record<T:\ Serialize>\(\s*$/,
      /^\s*kind:\ EventAuthorizationKind,\s*$/,
      /^\s*\)\ \->\ Result<EventAuthorizationRecord,\ PortError>\ \{\s*$/,
      /^\s*Ok\(EventAuthorizationRecord\ \{\s*$/,
      /^\s*PortError::internal\(port,\ "event_authorization_payload",\ error\.to_string\(\)\)\s*$/,
      /^\s*pub\ enum\ EventAuthorizationKind\ \{\s*$/,
      /^\s*impl\ EventAuthorizationKind\ \{\s*$/,
      /^\s*pub\ struct\ EventAuthorizationRecord\ \{\s*$/,
      /^\s*pub\ kind:\ EventAuthorizationKind,\s*$/,
      /^\s*\/\/\/\ Record\ one\ authorization\ under\ the\ caller's\ already\-held\ state\ write\ lock\.\s*$/,
      /^\s*pub\(super\)\ fn\ record_locked\(state:\ \&mut\ InMemoryStudyState,\ record:\ EventAuthorizationRecord\)\ \{\s*$/,
      /^\s*state\.event_authorizations\.insert\(record\);\s*$/,
      /^\s*\/\/\/\ Whether\ this\ exact\ authorization\ is\ already\ on\ record,\ under\ the\ caller's\s*$/,
      /^\s*record:\ \&EventAuthorizationRecord,\s*$/,
      /^\s*state\.event_authorizations\.contains\(record\)\s*$/,
      /^\s*\.event_authorizations\s*$/,
      /^\s*\/\/\/\ The\ six\ authorization\ port\ bodies\.\ `memory\.rs`\ keeps\ the\ trait\ signatures;\ the\s*$/,
      /^\s*let\ authorization\ =\ event_authorization_record\(\s*$/,
      /^\s*EventAuthorizationKind::AnswerEvaluation,\s*$/,
      /^\s*if\ !state\.event_authorizations\.contains\(\&authorization\)\ \{\s*$/,
      /^\s*EventAuthorizationKind::ConceptStatus,\s*$/,
      /^\s*EventAuthorizationKind::StudySessionRecap,\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/authorization.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*pub\(crate\)\ const\ SESSION_TOKEN_NONCE_SKEW_SECONDS:\ u64\ =\ 60;\s*$/,
      /^\s*pub\(crate\)\ fn\ claim_session_token_nonce_at\(\s*$/,
      /^\s*\/\/\ `SESSION_TOKEN_NONCE_SKEW_SECONDS`,\ and\ dropping\ the\ nonce\ at\ `expires_at`\s*$/,
      /^\s*state\.session_token_nonces\.retain\(\|record\|\ \{\s*$/,
      /^\s*\.saturating_add\(SESSION_TOKEN_NONCE_SKEW_SECONDS\)\s*$/,
      /^\s*if\ state\.session_token_nonces\.iter\(\)\.any\(\|used\|\ \{\s*$/,
      /^\s*state\.session_token_nonces\.push\(claim\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/ingestion.rs",
    marker: "has_word_token",
    patterns: Object.freeze([
      /^\s*let\ mut\ has_word_token\ =\ false;\s*$/,
      /^\s*has_word_token\ =\ true;\s*$/,
      /^\s*alpha_count\ >=\ 3\ \&\&\ has_word_token\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/ingestion.rs",
    marker: "pasted_text",
    patterns: Object.freeze([
      /^\s*let\ pasted_text\ =\ required_text\(\&input\.pasted_text,\ "pasted_text"\)\?\.to_owned\(\);\s*$/,
      /^\s*let\ normalized\ =\ normalize_whitespace\(\&pasted_text\);\s*$/,
      /^\s*source_kind:\ "pasted_text"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/ingestion.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*let\ prompt\ =\ format!\(\s*$/,
      /^\s*let\ rubric\ =\ crate::generated_question_rubric\(\&question_id,\ \&prompt,\ \&source\.source_id\);\s*$/,
      /^\s*prompt,\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/ingestion.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*session_token:\ None,\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/learning.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*"answer_text",\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/learning.rs",
    marker: "authorization",
    patterns: Object.freeze([
      /^\s*\/\/!\ `SERVER_PERSISTED_FSRS`\ schedule,\ and\ the\ browser\ authorization\ digest\ are\ one\s*$/,
      /^\s*let\ authorization\ =\ event_authorization_record\(\s*$/,
      /^\s*EventAuthorizationKind::ReviewSchedule,\s*$/,
      /^\s*payload_sha256:\ authorization\.payload_sha256\.clone\(\),\s*$/,
      /^\s*\/\/\ The\ authorization\ ledger\ stays\ complete\ across\ every\ authorized\ write\ kind\.\s*$/,
      /^\s*state\.event_authorizations\.insert\(authorization\);\s*$/,
      /^\s*EventAuthorizationKind::AnswerEvaluation,\s*$/,
      /^\s*EventAuthorizationKind::ConceptStatus,\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/learning.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*"prompt_text",\s*$/,
      /^\s*"raw_prompt",\s*$/,
      /^\s*prompt:\ question\.prompt\.clone\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/privacy.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*state\.session_token_nonces\.retain\(\|record\|\ \{\s*$/,
      /^\s*\/\/\ session\ row\ is\ written\ —\ `claim_session_token_nonce`\ locks\ the\ study\ set\s*$/,
      /^\s*\.session_token_nonces\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/store_conformance.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*answer_text:\ "The\ gradient\ drives\ ATP\ synthase\."\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/store_conformance.rs",
    marker: "pasted_text",
    patterns: Object.freeze([
      /^\s*pasted_text:\ conformance_paste_text\(\),\s*$/,
      /^\s*pasted_text:\ conformance_canary_text\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/store_conformance.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*\/\/\/\ concept\ public\ ids,\ question\ ids\ and\ prompts,\ span\ text\ —\ is\ shared,\ and\ is\s*$/,
      /^\s*draft\.record_id\(\&format!\("\{label\}\.question\.prompt"\),\ \&question\.prompt\);\s*$/,
      /^\s*\/\/\/\ The\ whole\ value\ is\ the\ expectation\ —\ prompt,\ expected\ terms,\ follow\-up,\s*$/,
      /^\s*retry_prompt,\s*$/,
      /^\s*retry_prompt:\ question\.follow_up\.clone\(\),\s*$/,
      /^\s*\.any\(\|question\|\ question\.prompt\.contains\(CONFORMANCE_CANARY\)\)\s*$/,
      /^\s*seen\.insert\("question_prompt"\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/memory/store_conformance.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*memory::\{current_epoch_seconds,\ SESSION_TOKEN_NONCE_SKEW_SECONDS\},\s*$/,
      /^\s*\.claim_session_token_nonce\(live\.clone\(\)\)\s*$/,
      /^\s*let\ stale_expiry\ =\ fixture\.nonce_epoch\ \-\ \(SESSION_TOKEN_NONCE_SKEW_SECONDS\ \*\ 5\);\s*$/,
      /^\s*\.claim_session_token_nonce\(stale\.clone\(\)\)\s*$/,
      /^\s*\.claim_session_token_nonce\(nonce_claim\(\s*$/,
      /^\s*\.claim_session_token_nonce\(stale\)\s*$/,
      /^\s*\.claim_session_token_nonce\(live\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/migrations.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*"answer_text",\s*$/,
      /^\s*for\ forbidden\ in\ \["payload",\ "payload_json",\ "event_json",\ "answer_text"\]\ \{\s*$/,
      /^\s*assert!\(!sql\.contains\("answer_text\ TEXT"\)\);\s*$/,
      /^\s*answer_text:\ "NADH\ donates\ electrons\."\.to_owned\(\),\s*$/,
      /^\s*"resolution":\ \{\ "Answer_Text":\ "the\ learner\ said\ this"\ \}\s*$/,
      /^\s*Some\("answer_text"\)\s*$/,
      /^\s*answer_text:\ canary_text\("the\ learner's\ own\ words"\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/migrations.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*id,\ study_set_id,\ question_id,\ source_span_id,\ prompt,\ expected_terms,\ follow_up,\s*$/,
      /^\s*\.bind\(question\.prompt\)\s*$/,
      /^\s*"prompt_text",\s*$/,
      /^\s*"raw_prompt",\s*$/,
      /^\s*retry_prompt:\ question\.follow_up\.clone\(\),\s*$/,
      /^\s*retry_prompt:\ question\.follow_up,\s*$/,
      /^\s*prompt:\ format!\("Recall\ the\ ATP\ yield\ bound\ to\ \{concept_id\}\."\),\s*$/,
      /^\s*id,\ study_set_id,\ question_id,\ source_span_id,\ prompt,\ expected_terms,\s*$/,
      /^\s*\.bind\(\&question\.prompt\)\s*$/,
      /^\s*question\.prompt\ =\ canary_text\(\&question\.prompt\);\s*$/,
      /^\s*retry_prompt:\ canary_text\("which\ complex\ pumps\ first\?"\),\s*$/,
      /^\s*retry_prompt,\s*$/,
      /^\s*\*retry_prompt\ =\ Some\(canary_text\("say\ it\ once\ more\ with\ the\ complex"\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/migrations.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*"0010_voice_session_token_nonces\.sql",\s*$/,
      /^\s*include_str!\("\.\.\/\.\.\/\.\.\/migrations\/0010_voice_session_token_nonces\.sql"\),\s*$/,
      /^\s*assert!\(sql\.contains\("CREATE\ TABLE\ IF\ NOT\ EXISTS\ voice_session_token_nonces"\)\);\s*$/,
      /^\s*async\ fn\ postgres_session_token_nonce_claims_reject_replay\(\)\ \{\s*$/,
      /^\s*\.claim_session_token_nonce\(claim\.clone\(\)\)\s*$/,
      /^\s*assert_eq!\(session_token_nonce_rows\(\&pool,\ \&claim\)\.await,\ 1\);\s*$/,
      /^\s*\.claim_session_token_nonce_at\(claim\.clone\(\),\ NONCE_PRUNE_EARLIER_NOW\)\s*$/,
      /^\s*assert_eq!\(store\.snapshot\(\)\.session_token_nonces\.len\(\),\ 3\);\s*$/,
      /^\s*\.claim_session_token_nonce_at\(trigger\.clone\(\),\ NONCE_PRUNE_NOW\)\s*$/,
      /^\s*let\ retained\ =\ store\.snapshot\(\)\.session_token_nonces;\s*$/,
      /^\s*\.claim_session_token_nonce_at\(claim\.clone\(\),\ NONCE_PRUNE_NOW\)\s*$/,
      /^\s*\.claim_session_token_nonce_at\(late_expired,\ NONCE_PRUNE_NOW\)\s*$/,
      /^\s*assert_eq!\(store\.snapshot\(\)\.session_token_nonces\.len\(\),\ 4\);\s*$/,
      /^\s*store\.snapshot\(\)\.session_token_nonces\.is_empty\(\),\s*$/,
      /^\s*\.claim_session_token_nonce_at\(\s*$/,
      /^\s*assert_eq!\(store\.snapshot\(\)\.session_token_nonces\.len\(\),\ 2\);\s*$/,
      /^\s*assert_eq!\(session_token_nonce_rows\(\&pool,\ claim\)\.await,\ 1\);\s*$/,
      /^\s*session_token_nonce_rows\(\&pool,\ \&claims\[0\]\)\.await,\s*$/,
      /^\s*session_token_nonce_rows\(\&pool,\ \&claims\[1\]\)\.await,\s*$/,
      /^\s*session_token_nonce_rows\(\&pool,\ \&claims\[2\]\)\.await,\s*$/,
      /^\s*assert_eq!\(session_token_nonce_rows\(\&pool,\ \&trigger\)\.await,\ 1\);\s*$/,
      /^\s*\.claim_session_token_nonce_at\(late_expired\.clone\(\),\ NONCE_PRUNE_NOW\)\s*$/,
      /^\s*assert_eq!\(session_token_nonce_rows\(\&pool,\ \&late_expired\)\.await,\ 1\);\s*$/,
      /^\s*session_token_nonce_rows\(\&pool,\ claim\)\.await,\s*$/,
      /^\s*"INSERT\ INTO\ voice_session_token_nonces\s*$/,
      /^\s*sqlx::raw_sql\("ANALYZE\ voice_session_token_nonces"\)\s*$/,
      /^\s*"EXPLAIN\ DELETE\ FROM\ voice_session_token_nonces\ WHERE\ expires_at\ <\ \$1",\s*$/,
      /^\s*plan\.contains\("voice_session_token_nonces_expiry_idx"\),\s*$/,
      /^\s*"SELECT\ COUNT\(\*\)\ FROM\ voice_session_token_nonces\ WHERE\ nonce\ LIKE\ 'plan\-nonce\-%'",\s*$/,
      /^\s*\.claim_session_token_nonce\(session_delete_nonce\.clone\(\)\)\s*$/,
      /^\s*session_token_nonce_rows\(\&pool,\ \&session_delete_nonce\)\.await,\s*$/,
      /^\s*\.claim_session_token_nonce\(study_delete_nonce\.clone\(\)\)\s*$/,
      /^\s*session_token_nonce_rows\(\&pool,\ \&study_delete_nonce\)\.await,\s*$/,
      /^\s*AND\ query\ LIKE\ '%DELETE\ FROM\ voice_session_token_nonces%'",\s*$/,
      /^\s*sqlx::query\("LOCK\ TABLE\ voice_session_token_nonces\ IN\ EXCLUSIVE\ MODE"\)\s*$/,
      /^\s*async\ fn\ session_token_nonce_rows\(pool:\ \&sqlx::PgPool,\ claim:\ \&SessionTokenNonceClaim\)\ \->\ i64\ \{\s*$/,
      /^\s*FROM\ voice_session_token_nonces\s*$/,
      /^\s*"voice_session_token_nonces",\s*$/,
      /^\s*\.claim_session_token_nonce\(canary_nonce\(voice_session_id\)\)\s*$/,
      /^\s*assert!\(state\.session_token_nonces\.is_empty\(\)\);\s*$/,
      /^\s*"voice_session_token_nonces"\.to_owned\(\),\s*$/,
      /^\s*let\ _\ =\ nonce_store\.claim_session_token_nonce\(claim\)\.await;\s*$/,
      /^\s*\.claim_session_token_nonce\(canary_nonce\(session_id\)\)\s*$/,
      /^\s*"INSERT\ INTO\ voice_session_token_nonces\ \(\s*$/,
      /^\s*"SELECT\ COUNT\(\*\)\ FROM\ voice_session_token_nonces",\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/postgres.rs",
    marker: "authorization",
    patterns: Object.freeze([
      /^\s*validate_turn_outcome,\ ConceptStatusEventPayload,\ EventAuthorizationKind,\s*$/,
      /^\s*\/\/\/\ `DATA\-015`:\ authorization\ —\ the\ durable\ browser\-event\ digest\ and\ the\ nonce\s*$/,
      /^\s*mod\ authorization;\s*$/,
      /^\s*authorization::delete_session_digests\(\&mut\ tx,\ voice_session_uuid\)\.await\?;\s*$/,
      /^\s*authorization::authorize_question_started\(\s*$/,
      /^\s*authorization::authorize_answer_evaluation\(\s*$/,
      /^\s*authorization::authorize_source_reference\(\s*$/,
      /^\s*authorization::authorize_concept_status\(\s*$/,
      /^\s*authorization::authorize_manuscript_intent\(\s*$/,
      /^\s*authorization::authorize_recap\(\s*$/,
      /^\s*\/\/\ `DATA\-005`:\ the\ attempt\ row\ and\ the\ browser\ authorization\ digest\ commit\s*$/,
      /^\s*Self::insert_event_authorization\(\s*$/,
      /^\s*EventAuthorizationKind::AnswerEvaluation,\s*$/,
      /^\s*EventAuthorizationKind::ConceptStatus,\s*$/,
      /^\s*\/\/\ `DATA\-005`:\ the\ recap\ row\ and\ its\ browser\ authorization\ digest\ commit\s*$/,
      /^\s*EventAuthorizationKind::StudySessionRecap,\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/postgres.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*DELETED_ROW_CONSTANT,\ DELETED_STUDY_SET_TITLE,\ SESSION_TOKEN_NONCE_SKEW_SECONDS,\s*$/,
      /^\s*async\ fn\ claim_session_token_nonce\(\s*$/,
      /^\s*self\.claim_session_token_nonce_at\(claim,\ current_epoch_seconds\(\)\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/postgres/authorization.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*pub\(crate\)\ async\ fn\ claim_session_token_nonce_at\(\s*$/,
      /^\s*\/\/\ 0010's\ `voice_session_token_nonces_expiry_idx`\ serves\ it\ directly\.\s*$/,
      /^\s*i64::try_from\(now\.saturating_sub\(SESSION_TOKEN_NONCE_SKEW_SECONDS\)\)\.unwrap_or\(i64::MAX\);\s*$/,
      /^\s*sqlx::query\("DELETE\ FROM\ voice_session_token_nonces\ WHERE\ expires_at\ <\ \$1"\)\s*$/,
      /^\s*"INSERT\ INTO\ voice_session_token_nonces\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/postgres/ingestion.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*id,\ study_set_id,\ question_id,\ source_span_id,\ prompt,\ expected_terms,\s*$/,
      /^\s*\.bind\(\&question\.prompt\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/postgres/learning.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*prompt:\ row\.try_get\("prompt"\)\.map_err\(pg_error\)\?,\s*$/,
      /^\s*q\.prompt,\s*$/,
    ]),
  },
  {
    file: "agent/crates/data/src/postgres/privacy.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*"DELETE\ FROM\ voice_session_token_nonces\ WHERE\ user_id\ =\ \$1\ AND\ study_set_id\ =\ \$2",\s*$/,
      /^\s*"DELETE\ FROM\ voice_session_token_nonces\s*$/,
    ]),
  },
  {
    file: "agent/crates/observe/src/lib.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*"answer_text",\s*$/,
      /^\s*"raw_answer_text",\s*$/,
      /^\s*\/\/\ scans\ clean\ and\ filters\ to\ `answer_text`\.\ Scanning\ only\ the\ raw\ form\s*$/,
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
