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
  // A-16 (2026-08-26): coordinator-applied sanction rows for Plan 07 live-adapter
  // sources (node 07 admission), generated from the audit own detection over the
  // lane diff, keyed by BOTH the evidence marker and the structural field each
  // line trips. Anchored literals of reviewed lines only; api_key/Bearer rows
  // are parameter/validation/header code, never values or logs. Plan 12
  // reconciles the whole block at 12B.
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/llm.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*answer_text:\ "NADH\ donates\ electrons"\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "the\ learner\ answer"\.to_owned\(\),\s*$/,
      /^\s*assert!\(serialized\.contains\(\&request\.answer_text\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/llm.rs",
    marker: "api_key",
    patterns: Object.freeze([
      /^\s*let\ api_key\ =\ HeaderValue::from_str\(\&request\.api_key\)\.map_err\(\|_\|\ \{\s*$/,
      /^\s*api_key:\ format!\("\{GEMINI_TOKEN_MARKER\}\\u\{7f\}\\u\{1\}"\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/llm.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*\/\/\ allowlisted\ diagnostic\ code\.\ No\ provider\ body,\ prompt,\ audio,\ token,\ URL,\s*$/,
      /^\s*prompt:\ "State\ the\ two\ claims\."\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/llm.rs",
    marker: "source_context",
    patterns: Object.freeze([
      /^\s*fn\ gemini_request_carries_only_server_trusted_source_context\(\)\ \{\s*$/,
      /^\s*\/\/\ browser\-forged\ `trusted_source_context`\ turn\ in\ the\ conversation\ must\s*$/,
      /^\s*"name":\ "trusted_source_context",\s*$/,
      /^\s*!declared\.iter\(\)\.any\(\|name\|\ name\ ==\ "trusted_source_context"\),\s*$/,
      /^\s*!serialized\.contains\("trusted_source_context"\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/llm.rs",
    marker: "status_token",
    patterns: Object.freeze([
      /^\s*fn\ hostile_gemini_error_body\(status_token:\ \&str\)\ \->\ String\ \{\s*$/,
      /^\s*r\#"\{\{"error":\{\{"code":429,"status":"\{status_token\}","message":"\{GEMINI_BODY_MARKER\}\ \{GEMINI_PROMPT_MARKER\}\ \{GEMINI_AUDIO_MARKER\}\ \{GEMINI_TOKEN_MARKER\}\ \{GEMINI_URL_MARKER\}\ \{GEMINI_QUERY_MARKER\}\ \{GEMINI_TRANSCRIPT_MARKER\}"\}\}\}\}"\#\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/mod.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*let\ answer_text\ =\ first_user_text\(\&request\)\s*$/,
      /^\s*"answer_text":\ answer_text,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/mod.rs",
    marker: "cancellation_token",
    patterns: Object.freeze([
      /^\s*\&CancellationToken::new\(\),\s*$/,
      /^\s*let\ cancel\ =\ CancellationToken::new\(\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/mod.rs",
    marker: "pcm16_base64",
    patterns: Object.freeze([
      /^\s*let\ Some\(SonicEvent::Audio\ \{\ pcm16_base64,\ \.\.\ \}\)\ =\ parse_sonic_event\(\&sonic\.to_string\(\)\)\s*$/,
      /^\s*let\ frame\ =\ AudioFrame::from_base64\(pcm16_base64\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/mod.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*\/\/\ request\ URL\ or\ query,\ prompt,\ transcript,\ answer,\ audio,\ or\ credential\ has\ no\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/projection.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*\/\/\/\ Every\ graded\ field\ is\ copied\ from\ the\ outcome\.\ `answer_text`\ is\ the\s*$/,
      /^\s*answer_text:\ \&str,\s*$/,
      /^\s*answer_text:\ answer_text\.to_owned\(\),\s*$/,
      /^\s*assert_eq!\(evaluation\.answer_text,\ "the\ answer"\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs",
    marker: "CARTESIA_API_KEY",
    patterns: Object.freeze([
      /^\s*cartesia_api_key:\ String::new\(\),\s*$/,
      /^\s*cartesia_api_key:\ "sk_car_live_label_probe"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*answer_text:\ \&str,\s*$/,
      /^\s*let\ evaluation\ =\ answer_evaluation_from_outcome\(\&outcome,\ answer_text,\ \&source,\ question\)\?;\s*$/,
      /^\s*"answer_text":\ "a\ spoken\ answer",\s*$/,
      /^\s*answer_text:\ "the\ learner\ answer"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs",
    marker: "api_key",
    patterns: Object.freeze([
      /^\s*api_key:\ "gemini\-live\-label\-probe"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs",
    marker: "cancellation_token",
    patterns: Object.freeze([
      /^\s*cancelled:\ CancellationToken::new\(\),\s*$/,
      /^\s*let\ cancel\ =\ CancellationToken::new\(\);\s*$/,
      /^\s*let\ idle_cancellation\ =\ CancellationToken::new\(\);\s*$/,
      /^\s*if\ cancelled\.is_some_and\(CancellationToken::is_cancelled\)\ \{\s*$/,
      /^\s*\&CancellationToken::new\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs",
    marker: "cartesia_api_key",
    patterns: Object.freeze([
      /^\s*cartesia_api_key:\ String::new\(\),\s*$/,
      /^\s*cartesia_api_key:\ "sk_car_live_label_probe"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*follow_up\.prompt\ =\ "Explain\ what\ the\ proton\ gradient\ powers\."\.to_owned\(\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/session.rs",
    marker: "CARTESIA_API_KEY",
    patterns: Object.freeze([
      /^\s*transcribe_ink_websocket\(\&config\.ink,\ \&config\.cartesia_api_key,\ frame,\ cancel\)\s*$/,
      /^\s*\.extend\(\&config\.sonic,\ \&config\.cartesia_api_key,\ response_id,\ text\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/session.rs",
    marker: "api_key",
    patterns: Object.freeze([
      /^\s*api_key:\ "gemini\-test\-key"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/session.rs",
    marker: "authorization",
    patterns: Object.freeze([
      /^\s*authorization:\ F,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/session.rs",
    marker: "cartesia_api_key",
    patterns: Object.freeze([
      /^\s*transcribe_ink_websocket\(\&config\.ink,\ \&config\.cartesia_api_key,\ frame,\ cancel\)\s*$/,
      /^\s*\.extend\(\&config\.sonic,\ \&config\.cartesia_api_key,\ response_id,\ text\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/stt.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*let\ authorization\ =\ HeaderValue::from_str\(\&format!\("Bearer\ \{api_key\}"\)\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/stt.rs",
    marker: "api_key",
    patterns: Object.freeze([
      /^\s*transcribe_ink_with_connector\(\&WebSocketInkConnector,\ config,\ api_key,\ frame,\ cancel\)\.await\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/stt.rs",
    marker: "authorization",
    patterns: Object.freeze([
      /^\s*let\ authorization\ =\ HeaderValue::from_str\(\&format!\("Bearer\ \{api_key\}"\)\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/stt.rs",
    marker: "cancellation_token",
    patterns: Object.freeze([
      /^\s*\&CancellationToken::new\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/tts.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*let\ authorization\ =\ HeaderValue::from_str\(\&format!\("Bearer\ \{api_key\}"\)\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/tts.rs",
    marker: "api_key",
    patterns: Object.freeze([
      /^\s*\.extend\(config,\ api_key,\ context_id,\ transcript\)\s*$/,
      /^\s*api_key:\ \&str,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/tts.rs",
    marker: "authorization",
    patterns: Object.freeze([
      /^\s*let\ authorization\ =\ HeaderValue::from_str\(\&format!\("Bearer\ \{api_key\}"\)\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/tts.rs",
    marker: "cancellation_token",
    patterns: Object.freeze([
      /^\s*\&CancellationToken::new\(\),\s*$/,
      /^\s*let\ cancel\ =\ CancellationToken::new\(\);\s*$/,
      /^\s*let\ replacement\ =\ CancellationToken::new\(\);\s*$/,
      /^\s*\.finish\(\&config,\ "response\-2",\ \&CancellationToken::new\(\),\ \&mut\ heard\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/cartesia_gemini/tts.rs",
    marker: "pcm16_base64",
    patterns: Object.freeze([
      /^\s*let\ frame\ =\ AudioFrame::from_base64\(pcm16_base64\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/synthetic.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*answer_text:\ answer\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/synthetic.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*Some\(prompt\)\ =>\ format!\("\{concise_feedback\}\ \{prompt\}"\),\s*$/,
      /^\s*prompt:\ "Trace\ the\ electrons\."\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/src/synthetic.rs",
    marker: "source_context",
    patterns: Object.freeze([
      /^\s*ConceptStatus,\ RealtimeBrain,\ SessionId,\ SourceConfidence,\ SourceContext,\ StudyMode,\s*$/,
      /^\s*\/\/\/\ Values\ a\ hostile\ browser\ could\ put\ in\ `SessionConfig\.source_context`\.\s*$/,
      /^\s*fn\ forged_source_context\(\)\ \->\ Vec<SourceContext>\ \{\s*$/,
      /^\s*\/\/\/\ A\ browser\ can\ put\ anything\ in\ `SessionConfig\.source_context`\.\ It\ is\ not\s*$/,
      /^\s*source_context:\ forged_source_context\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "CARTESIA_API_KEY",
    patterns: Object.freeze([
      /^\s*cartesia_api_key:\ "viva\-release\-check\-cartesia\-placeholder\-key"\.to_owned\(\),\s*$/,
      /^\s*cartesia_api_key:\ "cartesia\-loopback\-key"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*\/\/\/\ evaluation's\ `answer_text`\ can\ be\ compared\ with\ the\ fixture's\.\s*$/,
      /^\s*"answer_text":\ "NADH\ donates\ electrons\ to\ the\ chain\ and\ pumps\ protons\.",\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "api_key",
    patterns: Object.freeze([
      /^\s*api_key:\ "viva\-release\-check\-gemini\-placeholder\-key"\.to_owned\(\),\s*$/,
      /^\s*api_key:\ "gemini\-loopback\-key"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "cartesia_api_key",
    patterns: Object.freeze([
      /^\s*cartesia_api_key:\ "viva\-release\-check\-cartesia\-placeholder\-key"\.to_owned\(\),\s*$/,
      /^\s*cartesia_api_key:\ "cartesia\-loopback\-key"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "pcm16_base64",
    patterns: Object.freeze([
      /^\s*\/\/\/\ constructors\ and\ reads\ them\ back\ through\ the\ borrowed\ `pcm16_base64\(\)`\s*$/,
      /^\s*AudioFrame::from_base64\(frame\.pcm16_base64\(\)\)\.expect\("cached\ base64\ decodes"\),\s*$/,
      /^\s*const\ ALLOWED_FRAME_ACCESSORS:\ \[\&str;\ 3\]\ =\ \["pcm16_bytes",\ "pcm16_bytes_owned",\ "pcm16_base64"\];\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*follow_up\.prompt\ =\ "Explain\ what\ the\ proton\ gradient\ powers\."\.to_owned\(\);\s*$/,
      /^\s*prompt:\ "Trace\ the\ electrons\ from\ NADH\ through\ the\ chain\."\.to_owned\(\),\s*$/,
      /^\s*prompt:\ "Name\ the\ two\ treaties\ that\ ended\ the\ war\ and\ say\ which\ came\ first\."\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*!body\.contains\("session_token"\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "transcript_final",
    patterns: Object.freeze([
      /^\s*BrainEvent::TranscriptFinal\ \{\ \.\.\ \}\ =>\ "transcript_final",\s*$/,
      /^\s*"transcript_final",\s*$/,
      /^\s*\/\/\/\ The\ fixture's\ own\ `transcript_final\.confidence`\.\ Plan\ 05\ freezes\ it\ as\s*$/,
      /^\s*let\ finals\ =\ bound\("transcript_final"\);\s*$/,
      /^\s*\.filter\(\|event\|\ event\["type"\]\ ==\ "transcript_final"\)\s*$/,
      /^\s*"transcript_final:\{response_id\}:confidence=\{\}",\s*$/,
      /^\s*"transcript_final:response\-1:confidence=none",\s*$/,
      /^\s*"transcript_final:response\-2:confidence=none",\s*$/,
      /^\s*"transcript_final:fake\-cartesia\-gemini\-session\-response\-1:confidence=none",\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-adapters/tests/cartesia_gemini.rs",
    marker: "viva-release-check-gemini-placeholder-key",
    patterns: Object.freeze([
      /^\s*api_key:\ "viva\-release\-check\-gemini\-placeholder\-key"\.to_owned\(\),\s*$/,
    ]),
  },
  // A-21 (2026-08-26): coordinator-applied sanction rows for Plan 08 agent-service
  // sources (node 08 admission), generated from the audit own detection over the
  // lane diff, dual-keyed (evidence marker + structural field). Anchored literals
  // of reviewed lines only. Plan 12 reconciles at 12B.
  {
    file: "agent/crates/agent-service/src/app.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*\/\/\/\ value\ that\ is\ not\ a\ short\ identifier\ —\ a\ signed\ credential,\ a\ bearer\ header,\s*$/,
      /^\s*\|\ crate::config::VoiceWsAccessError::InvalidBearer\ =>\ StatusCode::UNAUTHORIZED,\s*$/,
      /^\s*crate::config::VoiceWsAccessError::MissingBearer\ =>\ "missing_bearer",\s*$/,
      /^\s*crate::config::VoiceWsAccessError::InvalidBearer\ =>\ "invalid_bearer",\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/app.rs",
    marker: "prompt",
    patterns: Object.freeze([
      /^\s*let\ prompt\ =\ event\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/app.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*pub\(crate\)\ fn\ signed_session_token\(\s*$/,
      /^\s*pub\(crate\)\ fn\ signed_session_token_for\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*\/\/\/\ separate\ from\ \[`VoiceWsAccess`\],\ whose\ bearer\ check\ succeeds\ when\ no\ WebSocket\s*$/,
      /^\s*\/\/\/\ bearer\ is\ configured\ —\ the\ exact\ case\ `D\-07\ TOKEN_ONLY_REFRESH`\ makes\ normal\.\s*$/,
      /^\s*Self\ \{\ bearer\ \}\s*$/,
      /^\s*let\ Some\(required\)\ =\ \&self\.bearer\ else\ \{\s*$/,
      /^\s*config\.ws_access\.required_bearer\ =\ Some\(secret\.into\(\)\);\s*$/,
      /^\s*config\.library_read_bearer\ =\s*$/,
      /^\s*config\.library_delete_bearer\ =\s*$/,
      /^\s*if\ let\ Some\(required\)\ =\ \&access\.required_bearer\ \{\s*$/,
      /^\s*\/\/\/\ library\ credentials,\ so\ the\ WebSocket\ bearer\ alone\ no\ longer\ validates\.\s*$/,
      /^\s*\/\/\/\ which\ intentionally\ succeeds\ when\ no\ WebSocket\ bearer\ is\ configured\.\s*$/,
      /^\s*"the\ websocket\ bearer\ check\ is\ absent\-permissive\ by\ design"\s*$/,
      /^\s*HeaderValue::from_str\(\&format!\("Bearer\ \{FIXTURE_LIBRARY_READ_CREDENTIAL\}"\)\)\s*$/,
      /^\s*HeaderValue::from_str\(\&format!\("Bearer\ \{FIXTURE_OPERATOR_CREDENTIAL\}"\)\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "bearer",
    patterns: Object.freeze([
      /^\s*bearer:\ Option<RedactedSecret>,\s*$/,
      /^\s*pub\ fn\ new\(bearer:\ Option<RedactedSecret>\)\ \->\ Self\ \{\s*$/,
      /^\s*Self\ \{\ bearer\ \}\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "bearer.",
    patterns: Object.freeze([
      /^\s*self\.bearer\.is_some\(\)\s*$/,
      /^\s*self\.library_read_bearer\.as_str\(\)\.as_bytes\(\),\s*$/,
      /^\s*self\.library_read_bearer\.is_some\(\),\s*$/,
      /^\s*self\.library_delete_bearer\.is_some\(\),\s*$/,
      /^\s*self\.operator_access\.bearer\.as_ref\(\),\s*$/,
      /^\s*self\.library_read_bearer\.as_ref\(\),\s*$/,
      /^\s*self\.library_delete_bearer\.as_ref\(\),\s*$/,
      /^\s*self\.ws_access\.required_bearer\.as_ref\(\),\s*$/,
      /^\s*return\ if\ access\.required_bearer\.is_some\(\)\ \{\s*$/,
      /^\s*assert!\(config\.ws_access\.required_bearer\.is_some\(\)\);\s*$/,
      /^\s*assert!\(defaults\.library_read_bearer\.is_none\(\)\);\s*$/,
      /^\s*assert!\(defaults\.library_delete_bearer\.is_none\(\)\);\s*$/,
      /^\s*\&\&\ config\.library_read_bearer\.is_some\(\)\s*$/,
      /^\s*\&\&\ config\.library_delete_bearer\.is_some\(\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "fixture_session_signing_secret",
    patterns: Object.freeze([
      /^\s*const\ FIXTURE_SESSION_SIGNING_SECRET:\ \&str\ =\ "viva\-fixture\-session\-signing\-secret01";\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "redacted_secret",
    patterns: Object.freeze([
      /^\s*env_value\("VIVA_AGENT_OPERATOR_BEARER_TOKEN"\)\.map\(RedactedSecret::from\),\s*$/,
      /^\s*env_value\("VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN"\)\.map\(RedactedSecret::from\);\s*$/,
      /^\s*env_value\("VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN"\)\.map\(RedactedSecret::from\);\s*$/,
      /^\s*verify_session_token_at\(token,\ \&RedactedSecret::from\(secret\),\ now,\ None\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "secret",
    patterns: Object.freeze([
      /^\s*let\ claims\ =\ verify_session_token_at\(\&presented,\ secret,\ now_unix_seconds,\ None\)\s*$/,
      /^\s*secret:\ \&RedactedSecret,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*pub\ const\ VIVA_SESSION_TOKEN_HEADER:\ \&str\ =\ "x\-viva\-session\-token";\s*$/,
      /^\s*session_token_secret:\ RedactedSecret,\s*$/,
      /^\s*session_token_secret,\s*$/,
      /^\s*let\ mut\ tokens\ =\ headers\.get_all\(VIVA_SESSION_TOKEN_HEADER\)\.iter\(\);\s*$/,
      /^\s*verify_session_token_at\(token,\ \&self\.session_token_secret,\ now_unix_seconds,\ None\)\s*$/,
      /^\s*config\.ws_access\.session_token_secret\ =\ Some\(secret\.into\(\)\);\s*$/,
      /^\s*"VIVA_VOICE_SESSION_TOKEN_SECRET",\s*$/,
      /^\s*self\.ws_access\.session_token_secret\.is_some\(\),\s*$/,
      /^\s*if\ credential\.is_some\(\)\ \&\&\ self\.ws_access\.session_token_secret\.is_none\(\)\ \{\s*$/,
      /^\s*\#\[error\("`\{0\}`\ requires\ `VIVA_VOICE_SESSION_TOKEN_SECRET`"\)\]\s*$/,
      /^\s*pub\ session_token_secret:\ Option<RedactedSecret>,\s*$/,
      /^\s*let\ Some\(secret\)\ =\ \&access\.session_token_secret\ else\ \{\s*$/,
      /^\s*let\ claims\ =\ verify_session_token_at\(\&presented,\ secret,\ now_unix_seconds,\ None\)\s*$/,
      /^\s*const\ SESSION_TOKEN_CLAIM_NAMES:\ \&\[\&str\]\ =\ \&\[\s*$/,
      /^\s*const\ SESSION_TOKEN_REQUIRED_CLAIM_NAMES:\ \&\[\&str\]\ =\ \&\[\s*$/,
      /^\s*pub\ fn\ verify_session_token_at\(\s*$/,
      /^\s*let\ claims\ =\ decode_session_token_claims\(\&claims_bytes\)\?;\s*$/,
      /^\s*fn\ decode_session_token_claims\(bytes:\ \&\[u8\]\)\ \->\ Result<SessionTokenClaims,\ SessionTokenError>\ \{\s*$/,
      /^\s*\.any\(\|name\|\ !SESSION_TOKEN_CLAIM_NAMES\.contains\(\&name\.as_str\(\)\)\)\s*$/,
      /^\s*if\ SESSION_TOKEN_REQUIRED_CLAIM_NAMES\s*$/,
      /^\s*verify_session_token_at\(token,\ \&RedactedSecret::from\(secret\),\ now,\ None\)\s*$/,
      /^\s*session_token_secret:\ Some\("session\-secret"\.into\(\)\),\s*$/,
      /^\s*session_token_secret:\ Some\(FIXTURE_SESSION_SIGNING_SECRET\.into\(\)\),\s*$/,
      /^\s*"VIVA_VOICE_SESSION_TOKEN_SECRET"\ =>\ Some\(FIXTURE_SESSION_SIGNING_SECRET\.to_owned\(\)\),\s*$/,
      /^\s*public_env\(\&\[\("VIVA_VOICE_SESSION_TOKEN_SECRET",\ None\)\]\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "session_token_secret",
    patterns: Object.freeze([
      /^\s*session_token_secret:\ RedactedSecret,\s*$/,
      /^\s*verify_session_token_at\(token,\ \&self\.session_token_secret,\ now_unix_seconds,\ None\)\s*$/,
      /^\s*config\.ws_access\.session_token_secret\ =\ Some\(secret\.into\(\)\);\s*$/,
      /^\s*pub\ session_token_secret:\ Option<RedactedSecret>,\s*$/,
      /^\s*session_token_secret:\ Some\("session\-secret"\.into\(\)\),\s*$/,
      /^\s*session_token_secret:\ Some\(FIXTURE_SESSION_SIGNING_SECRET\.into\(\)\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/config.rs",
    marker: "token",
    patterns: Object.freeze([
      /^\s*let\ token\ =\ token\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/ingestion.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*"Bearer\ viva\-fixture\-operator\-credential\-0001\ ",\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/ingestion.rs",
    marker: "bearer.",
    patterns: Object.freeze([
      /^\s*if\ state\.ws_access\.required_bearer\.is_none\(\)\ \{\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/ingestion.rs",
    marker: "pasted_text",
    patterns: Object.freeze([
      /^\s*pasted_text:\ String,\s*$/,
      /^\s*pasted_text:\ request\.pasted_text,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/ingestion.rs",
    marker: "redacted_secret",
    patterns: Object.freeze([
      /^\s*\.map\(RedactedSecret::as_str\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/ingestion.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*if\ let\ Err\(error\)\ =\ attach_ready_session_token\(\&state,\ \&mut\ record,\ request_origin\(\&headers\)\)\ \{\s*$/,
      /^\s*"error":\ "session_token_failed",\s*$/,
      /^\s*pub\(super\)\ fn\ attach_ready_session_token\(\s*$/,
      /^\s*\.session_token_secret\s*$/,
      /^\s*record\.session_token\ =\ Some\(signed_session_token\(record,\ secret,\ state,\ origin\)\?\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/ingestion.rs",
    marker: "session_token_secret",
    patterns: Object.freeze([
      /^\s*\.session_token_secret\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/ingestion.rs",
    marker: "viva1.",
    patterns: Object.freeze([
      /^\s*"viva1\.eyJ1c2VyX2lkIjoidXNlci0xIn0\.c2ln\ ",\s*$/,
      /^\s*"viva1\.",\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*"missing\ bearer\ token\ or\ library\ control\ token"\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "bearer.",
    patterns: Object.freeze([
      /^\s*if\ state\.ws_access\.required_bearer\.is_none\(\)\ \{\s*$/,
      /^\s*if\ state\.ws_access\.required_bearer\.is_some\(\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "control_token",
    patterns: Object.freeze([
      /^\s*control_token:\ Option<String>,\s*$/,
      /^\s*control_token:\ None,\s*$/,
      /^\s*pub\(super\)\ fn\ available_mutation_action\(control_token:\ Option<String>\)\ \->\ LibraryAction\ \{\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "mutation_control_token",
    patterns: Object.freeze([
      /^\s*let\ mutation_control_token\ =\ signed_library_control_token\(\&state,\ \&study_set\.user_id\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "redacted_secret",
    patterns: Object.freeze([
      /^\s*use\ crate::config::\{ProjectionReadAccess,\ RedactedSecret,\ SessionTokenClaims\};\s*$/,
      /^\s*\.map\(RedactedSecret::as_str\)\s*$/,
      /^\s*\.map\(RedactedSecret::as_str\)\?;\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "secret",
    patterns: Object.freeze([
      /^\s*signed_session_token_for\(user_id,\ study_set_id,\ \&session_id,\ secret,\ failure_control\)\s*$/,
      /^\s*let\ secret\ =\ state\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*session_token:\ Option<String>,\s*$/,
      /^\s*session_token:\ None,\s*$/,
      /^\s*\.session_token_secret\s*$/,
      /^\s*return\ unavailable_action\("session_token_unavailable"\);\s*$/,
      /^\s*let\ Ok\(session_token\)\ =\s*$/,
      /^\s*signed_session_token_for\(user_id,\ study_set_id,\ \&session_id,\ secret,\ failure_control\)\s*$/,
      /^\s*session_token:\ Some\(session_token\),\s*$/,
      /^\s*signed_session_token_for\(\s*$/,
      /^\s*if\ state\.ws_access\.required_bearer\.is_none\(\)\ \&\&\ state\.ws_access\.session_token_secret\.is_none\(\)\ \{\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "session_token_secret",
    patterns: Object.freeze([
      /^\s*\.session_token_secret\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/http/library.rs",
    marker: "token",
    patterns: Object.freeze([
      /^\s*let\ token\ =\ headers\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/lib.rs",
    marker: "redacted_secret",
    patterns: Object.freeze([
      /^\s*RecorderLimits,\ RedactedSecret,\ ServiceConfig,\ ServiceConfigError,\ SessionTokenClaims,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/lib.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*build_brain,\ build_study_store,\ validate_runtime_store_preflight,\ verify_session_token_at,\s*$/,
      /^\s*EXPIRY_CLOCK_SKEW_SECONDS,\ VIVA_SESSION_TOKEN_HEADER,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/main.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*\.zip\(config\.ws_access\.session_token_secret\.clone\(\)\)\s*$/,
      /^\s*\.map\(\|\(library_read_bearer,\ session_token_secret\)\|\ \{\s*$/,
      /^\s*session_token_secret,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws.rs",
    marker: "redacted_secret",
    patterns: Object.freeze([
      /^\s*authenticate_upgrade,\ bac_510_max_turn_duration,\ FailureControlScenario,\ RedactedSecret,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/preflight.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*UpgradePrincipal::ServiceBearer\ =>\ \{\s*$/,
      /^\s*VoiceWsAccessError::MissingBearer\ \|\ VoiceWsAccessError::InvalidBearer\ =>\ \{\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/preflight.rs",
    marker: "bound_session_token",
    patterns: Object.freeze([
      /^\s*bound_session_token:\ initial\.session_token,\s*$/,
      /^\s*pub\(super\)\ bound_session_token:\ String,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/preflight.rs",
    marker: "redacted_secret",
    patterns: Object.freeze([
      /^\s*\.map\(RedactedSecret::as_str\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/preflight.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*match\ state\.study_store\.claim_session_token_nonce\(claim\)\.await\ \{\s*$/,
      /^\s*session_token,\s*$/,
      /^\s*\.session_token_secret\s*$/,
      /^\s*let\ token\ =\ initial\.session_token\.as_str\(\);\s*$/,
      /^\s*bound_session_token:\ initial\.session_token,\s*$/,
      /^\s*session_token:\ \&str,\s*$/,
      /^\s*session_binding\.bound_session_token\.as_bytes\(\),\s*$/,
      /^\s*session_token\.as_bytes\(\),\s*$/,
      /^\s*pub\(super\)\ bound_session_token:\ String,\s*$/,
      /^\s*pub\(super\)\ session_token:\ String,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/preflight.rs",
    marker: "session_token_secret",
    patterns: Object.freeze([
      /^\s*\.session_token_secret\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/preflight.rs",
    marker: "source_context",
    patterns: Object.freeze([
      /^\s*config\.source_context\.clear\(\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/preflight.rs",
    marker: "token",
    patterns: Object.freeze([
      /^\s*let\ token\ =\ initial\.session_token\.as_str\(\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/provider.rs",
    marker: "malformed_token",
    patterns: Object.freeze([
      /^\s*\|\ FailureControlScenario::MalformedToken\ =>\ BrainFailureClass::ProviderAuthFailure,\s*$/,
      /^\s*\|\ FailureControlScenario::MalformedToken\ =>\ BrainFailureStage::SessionAuth,\s*$/,
      /^\s*\|\ FailureControlScenario::MalformedToken\ =>\ "synthetic\ provider\ auth\ failed",\s*$/,
      /^\s*\|\ FailureControlScenario::MalformedToken\ =>\ "session_auth",\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/tests.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*Ok\(_\)\ =>\ panic!\("expected\ bearer\ rejection"\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/tests.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*answer_text:\ "omitted"\.to_owned\(\),\s*$/,
      /^\s*"intent":\ \{\ "kind":\ "answer_text",\ "text":\ "quiz\ me"\ \},\s*$/,
      /^\s*"intent":\ \{\ "kind":\ "answer_text",\ "text":\ "an\ answer\ the\ client\ never\ reads\ back"\ \},\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/tests.rs",
    marker: "bound_session_token",
    patterns: Object.freeze([
      /^\s*bound_session_token:\ "placeholder\-session\-material"\.to_owned\(\),\s*$/,
      /^\s*bound_session_token:\ "bound\-token"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/tests.rs",
    marker: "pcm16_base64",
    patterns: Object.freeze([
      /^\s*"frame":\ \{\ "pcm16_base64":\ "AQIDBA=="\ \},\s*$/,
      /^\s*let\ encoded\ =\ frame\.pcm16_base64\(\);\s*$/,
      /^\s*assert!\(!error\.message\.contains\("pcm16_base64"\)\);\s*$/,
      /^\s*"\$\.frame\.pcm16_base64"\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/tests.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*bound_session_token:\ "placeholder\-session\-material"\.to_owned\(\),\s*$/,
      /^\s*"session_token":\ "placeholder\-session\-material",\s*$/,
      /^\s*assert_eq!\(initial\.session_token,\ "placeholder\-session\-material"\);\s*$/,
      /^\s*r\#"\{\{"type":"session_config","version":\{VIVA_VOICE_PROTOCOL_VERSION\},"client_generation_id":"1","session_token":"placeholder\-session\-material","session":\{session\}\}\}"\#\s*$/,
      /^\s*session_token_secret:\ None,\s*$/,
      /^\s*r\#"\{\{"type":"session_config","version":\{VIVA_VOICE_PROTOCOL_VERSION\},"client_generation_id":"slow\-client\-1","session_token":"placeholder\-session\-material","session":\{session\}\}\}"\#\s*$/,
      /^\s*bound_session_token:\ "bound\-token"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/tests.rs",
    marker: "session_token_secret",
    patterns: Object.freeze([
      /^\s*session_token_secret:\ None,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/tests.rs",
    marker: "source_context",
    patterns: Object.freeze([
      /^\s*"source_context":\ \[\],\s*$/,
      /^\s*fn\ sanitizes_session_config_identity_and_strips_browser_source_context\(\)\ \{\s*$/,
      /^\s*assert!\(sanitized\.source_context\.is_empty\(\)\);\s*$/,
      /^\s*source_context:\ vec!\[agent_domain::SourceContext\ \{\s*$/,
      /^\s*assert!\(refreshed\.source_context\.is_empty\(\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/turn.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*ClientAction::AnswerText\ =>\ \(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/turn.rs",
    marker: "pcm16_base64",
    patterns: Object.freeze([
      /^\s*"\$\.frame\.pcm16_base64"\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/src/ws/turn.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*session_token,\s*$/,
      /^\s*\&session_token,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "Bearer ",
    patterns: Object.freeze([
      /^\s*\/\/\/\ bearer\ at\ all,\ so\ the\ absent\-permissive\ WebSocket\ bearer\ check\ would\ leave\s*$/,
      /^\s*Some\(\&format!\("Bearer\ \{FIXTURE_LIBRARY_READ_CREDENTIAL\}"\)\),\s*$/,
      /^\s*Some\(\&format!\("Bearer\ \{FIXTURE_OPERATOR_CREDENTIAL\}"\)\),\s*$/,
      /^\s*\/\/\/\ identifiers;\ a\ signed\ credential,\ a\ bearer\ header,\ transcript\ prose,\ or\ a\ base64\s*$/,
      /^\s*const\ HOSTILE_AUTHORIZATION_VALUE:\ \&str\ =\ "Bearer\ viva\-fixture\-hostile\-credential";\s*$/,
      /^\s*\/\/\/\ The\ upgrade\ request\ a\ trusted\ service\ makes:\ a\ shared\ bearer\ in\ `Authorization`\.\s*$/,
      /^\s*HeaderValue::from_str\(\&format!\("Bearer\ \{bearer\}"\)\)\.expect\("authorization\ header\ is\ valid"\),\s*$/,
      /^\s*let\ missing_bearer\ =\ bearer_app\s*$/,
      /^\s*let\ invalid_bearer\ =\ bearer_app\s*$/,
      /^\s*\.header\("authorization",\ "Bearer\ wrong\-secret"\)\s*$/,
      /^\s*\.header\("authorization",\ "Bearer\ rest\-secret"\)\s*$/,
      /^\s*if\ let\ Some\(bearer\)\ =\ request\.bearer\ \{\s*$/,
      /^\s*builder\ =\ builder\.header\("authorization",\ format!\("Bearer\ \{bearer\}"\)\);\s*$/,
      /^\s*"operator\ bearer\ must\ not\ authorize\ a\ projection\ read",\s*$/,
      /^\s*"scoped\ bearer\ alone\ must\ not\ authorize",\s*$/,
      /^\s*"Bearer\ \{FIXTURE_LIBRARY_READ_CREDENTIAL\}\ user\-1\ voice\-session\-1\ \{HOSTILE_TRANSCRIPT_TEXT\}"\s*$/,
      /^\s*format!\("Bearer\ \{FIXTURE_LIBRARY_READ_CREDENTIAL\}"\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "CARTESIA_API_KEY",
    patterns: Object.freeze([
      /^\s*"raw\ answer\ transcript\ with\ CARTESIA_API_KEY\ must\ not\ surface"\.to_owned\(\);\s*$/,
      /^\s*\.contains\("CARTESIA_API_KEY"\),\s*$/,
      /^\s*message:\ "CARTESIA_API_KEY\ rejected;\ postgres\ adapter\ error:\ durable\ store\ write\ failed;\ rate\ limit"\s*$/,
      /^\s*assert!\(!rendered\.contains\("CARTESIA_API_KEY"\),\ "\{rendered\}"\);\s*$/,
      /^\s*!event\.detail\.contains\("CARTESIA_API_KEY"\)\ \&\&\ !event\.detail\.contains\("postgres"\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "answer_text",
    patterns: Object.freeze([
      /^\s*"answer_text":\ "forged"\s*$/,
      /^\s*answer_text:\ "forged\ answer"\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "unpersisted\ answer\ should\ not\ leak"\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "late\ provider\ answer"\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "stale\ answer"\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "NADH\ gives\ electrons\."\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "first\ provider\ turn\ evaluated"\.to_owned\(\),\s*$/,
      /^\s*answer_text:\ "provider\ turn\ evaluated"\.to_owned\(\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "authorization",
    patterns: Object.freeze([
      /^\s*authorization:\ Option<\&str>,\s*$/,
      /^\s*let\ authorization\ =\ format!\("Bearer\ \{session_token\}"\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "bearer",
    patterns: Object.freeze([
      /^\s*bearer:\ \&str,\s*$/,
      /^\s*HeaderValue::from_str\(\&format!\("Bearer\ \{bearer\}"\)\)\.expect\("authorization\ header\ is\ valid"\),\s*$/,
      /^\s*bearer:\ Option<\&'a\ str>,\s*$/,
      /^\s*builder\ =\ builder\.header\("authorization",\ format!\("Bearer\ \{bearer\}"\)\);\s*$/,
      /^\s*bearer:\ None,\s*$/,
      /^\s*bearer:\ Some\("viva\-fixture\-not\-the\-read\-credential\-1"\),\s*$/,
      /^\s*bearer:\ Some\(FIXTURE_OPERATOR_CREDENTIAL\),\s*$/,
      /^\s*bearer:\ Some\(FIXTURE_LIBRARY_READ_CREDENTIAL\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "bearer.",
    patterns: Object.freeze([
      /^\s*\/\/\/\ rides\ in\ the\ `bearer\.<base64url\(token\)>`\ subprotocol\ entry\.\s*$/,
      /^\s*"viva\-voice,\ bearer\.\{\}",\s*$/,
      /^\s*"viva\-voice,\ bearer\.not\-a\-canonical\-token"\.to_owned\(\),\s*$/,
      /^\s*format!\("viva\-voice,\ bearer\.\{\}",\ URL_SAFE_NO_PAD\.encode\(\&expired\)\),\s*$/,
      /^\s*assert_eq!\(missing_bearer\.status\(\),\ StatusCode::UNAUTHORIZED\);\s*$/,
      /^\s*assert_eq!\(invalid_bearer\.status\(\),\ StatusCode::UNAUTHORIZED\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "biology_token",
    patterns: Object.freeze([
      /^\s*let\ biology_token\ =\ signed_session_token_with_failure_control\(FailureControlTokenFixture\ \{\s*$/,
      /^\s*let\ biology_token\ =\ signed_session_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "canonical_token",
    patterns: Object.freeze([
      /^\s*let\ canonical_token\ =\ \&vectors\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "chemistry_token",
    patterns: Object.freeze([
      /^\s*let\ chemistry_token\ =\ signed_session_token_with_failure_control\(FailureControlTokenFixture\ \{\s*$/,
      /^\s*let\ chemistry_token\ =\ signed_session_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "control_secret",
    patterns: Object.freeze([
      /^\s*control_secret:\ "control\-secret",\s*$/,
      /^\s*control_secret:\ \&'a\ str,\s*$/,
      /^\s*fixture\.control_secret,\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "control_token",
    patterns: Object.freeze([
      /^\s*let\ control_token\ =\ snapshot_payload\["privacy"\]\["export"\]\["control_token"\]\s*$/,
      /^\s*let\ control_token\ =\ signed_session_token_with_failure_control\(FailureControlTokenFixture\ \{\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "denied_token",
    patterns: Object.freeze([
      /^\s*let\ denied_token\ =\ nonce_audit_token_for\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "duplicate_biology_token",
    patterns: Object.freeze([
      /^\s*let\ duplicate_biology_token\ =\ signed_session_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "first_frame_token",
    patterns: Object.freeze([
      /^\s*let\ first_frame_token\ =\ provider_limiter_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "first_socket_token",
    patterns: Object.freeze([
      /^\s*let\ first_socket_token\ =\ provider_limiter_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "first_token",
    patterns: Object.freeze([
      /^\s*let\ first_token\ =\ nonce_audit_token_for\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "nonce_audit_secret",
    patterns: Object.freeze([
      /^\s*const\ NONCE_AUDIT_SECRET:\ \&str\ =\ "viva\-fixture\-session\-signing\-secret01";\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "normal_token",
    patterns: Object.freeze([
      /^\s*let\ normal_token\ =\ signed_session_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "owner_password",
    patterns: Object.freeze([
      /^\s*const\ OWNER_PASSWORD:\ \&\[u8\]\ =\ b"viva\-owner";\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "password",
    patterns: Object.freeze([
      /^\s*fn\ pdf_padded_password\(password:\ \&\[u8\]\)\ \->\ \[u8;\ 32\]\ \{\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "pasted_text",
    patterns: Object.freeze([
      /^\s*"pasted_text":\ "mitosis\ chromosome\ spindle\ metaphase\ cytokinesis",\s*$/,
      /^\s*r\#"\{"title":"A","title":"B","course":null,"exam_date":null,"pasted_text":"x"\}"\#\s*$/,
      /^\s*let\ pasted_text\ =\ "mitosis\ chromosome\ spindle\ metaphase\ cytokinesis";\s*$/,
      /^\s*"pasted_text":\ pasted_text,\s*$/,
      /^\s*assert_ne!\(excerpt,\ pasted_text\);\s*$/,
      /^\s*assert!\(!payload_json\.contains\(pasted_text\)\);\s*$/,
      /^\s*"pasted_text":\ "!!!\ \?\?\?\ \.\.\.\ \-\-\-"\s*$/,
      /^\s*assert!\(!exported\.contains\("pasted_text"\)\);\s*$/,
      /^\s*"pasted_text":\ "attacker\ notes\ should\ not\ mint\ a\ token"\s*$/,
      /^\s*const\ ROUTER_SURFACE_PASTE_BODY:\ \&str\ =\ r\#"\{"title":"Cell\ Division","course":"Biology\ 201","exam_date":"2031\-06\-01T09:30:00\.000Z","pasted_text":"mitosis\ chromosome\ spindle\ metaphase\ cytokinesis"\}"\#;\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "pcm16_base64",
    patterns: Object.freeze([
      /^\s*"frame":\ \{\ "pcm16_base64":\ "AQIDBA=="\ \}\s*$/,
      /^\s*"frame":\ \{\ "pcm16_base64":\ STANDARD\.encode\(pcm16\)\ \},\s*$/,
      /^\s*"frame":\ \{\ "pcm16_base64":\ STANDARD\.encode\(\&pcm16\)\ \},\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "physics_token",
    patterns: Object.freeze([
      /^\s*let\ physics_token\ =\ signed_session_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "projection_session_secret",
    patterns: Object.freeze([
      /^\s*const\ PROJECTION_SESSION_SECRET:\ \&str\ =\ "viva\-fixture\-projection\-signing\-secret";\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "redacted_secret",
    patterns: Object.freeze([
      /^\s*FailureControlScenario,\ OperatorAccess,\ ProjectionReadAccess,\ RecorderLimits,\ RedactedSecret,\s*$/,
      /^\s*\.with_operator_access\(OperatorAccess::new\(Some\(RedactedSecret::from\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "retry_token",
    patterns: Object.freeze([
      /^\s*let\ retry_token\ =\ provider_limiter_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "second_socket_token",
    patterns: Object.freeze([
      /^\s*let\ second_socket_token\ =\ provider_limiter_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "secret",
    patterns: Object.freeze([
      /^\s*let\ secret:\ RedactedSecret\ =\ String::from_utf8\(\s*$/,
      /^\s*secret:\ \&str,\s*$/,
      /^\s*fn\ signed_session_token_claims\(secret:\ \&str,\ claims:\ serde_json::Value\)\ \->\ String\ \{\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "session-secret",
    patterns: Object.freeze([
      /^\s*assert!\(!body\.contains\("session\-secret"\)\);\s*$/,
      /^\s*"session\-secret",\s*$/,
      /^\s*session_secret:\ "session\-secret",\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "session_secret",
    patterns: Object.freeze([
      /^\s*session_secret:\ "session\-secret",\s*$/,
      /^\s*session_secret:\ \&'a\ str,\s*$/,
      /^\s*signed_session_token_claims\(fixture\.session_secret,\ claims\)\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "session_token",
    patterns: Object.freeze([
      /^\s*begin_drain_and_wait,\ build_router,\ verify_session_token_at,\ AppState,\ ClientFrame,\s*$/,
      /^\s*session_token_secret:\ Some\("session\-secret"\.into\(\)\),\s*$/,
      /^\s*session_token_secret:\ Some\(secret\.into\(\)\),\s*$/,
      /^\s*const\ SESSION_TOKEN_VECTORS_JSON:\ \&str\ =\s*$/,
      /^\s*fn\ session_token_vectors\(\)\ \->\ SessionTokenVectors\ \{\s*$/,
      /^\s*serde_json::from_str\(SESSION_TOKEN_VECTORS_JSON\)\.expect\("session\-token\ vectors\ parse"\)\s*$/,
      /^\s*fn\ session_token_v1_vectors\(\)\ \{\s*$/,
      /^\s*let\ vectors\ =\ session_token_vectors\(\);\s*$/,
      /^\s*let\ outcome\ =\ verify_session_token_at\(\s*$/,
      /^\s*assert!\(verify_session_token_at\(canonical_token,\ \&secret,\ expires_at\ \-\ 1,\ None\)\.is_ok\(\)\);\s*$/,
      /^\s*verify_session_token_at\(canonical_token,\ \&secret,\ expires_at,\ None\)\s*$/,
      /^\s*verify_session_token_at\(canonical_token,\ \&secret,\ expires_at\ \+\ 59,\ None\)\s*$/,
      /^\s*verify_session_token_at\(\s*$/,
      /^\s*async\ fn\ claim_session_token_nonce\(\s*$/,
      /^\s*self\.audit\.record\("claim_session_token_nonce"\);\s*$/,
      /^\s*let\ outcome\ =\ self\.inner\.claim_session_token_nonce\(claim\)\.await;\s*$/,
      /^\s*session_token_secret:\ Some\(NONCE_AUDIT_SECRET\.into\(\)\),\s*$/,
      /^\s*signed_session_token\(\s*$/,
      /^\s*\.position\(\|operation\|\ \*operation\ ==\ "claim_session_token_nonce"\)\s*$/,
      /^\s*\.filter\(\|operation\|\ \*\*operation\ ==\ "claim_session_token_nonce"\)\s*$/,
      /^\s*let\ expired\ =\ signed_session_token\(\s*$/,
      /^\s*let\ wrong_secret_token\ =\ signed_session_token\(\s*$/,
      /^\s*session_token_secret:\ None,\s*$/,
      /^\s*"session_token",\s*$/,
      /^\s*async\ fn\ paste_study_set_route_creates_server_owned_ready_set_with_session_token\(\)\ \{\s*$/,
      /^\s*assert!\(payload\["session_token"\]\s*$/,
      /^\s*let\ app\ =\ build_router\(test_state_with_session_token_and_store\(\s*$/,
      /^\s*assert_eq!\(failed_payload\["session_token"\],\ serde_json::Value::Null\);\s*$/,
      /^\s*assert_eq!\(still_bad_payload\["session_token"\],\ serde_json::Value::Null\);\s*$/,
      /^\s*assert!\(retried_payload\["session_token"\]\s*$/,
      /^\s*async\ fn\ paste_study_set_route_does_not_mint_session_token_for_failed_ingestion\(\)\ \{\s*$/,
      /^\s*assert!\(payload\["session_token"\]\.is_null\(\)\);\s*$/,
      /^\s*assert!\(ready\["actions"\]\["start"\]\["session_token"\]\s*$/,
      /^\s*assert!\(!exported\.contains\("session_token"\)\);\s*$/,
      /^\s*async\ fn\ library_export_and_delete_reject_browser_session_token_authorization\(\)\ \{\s*$/,
      /^\s*let\ session_token\ =\ signed_session_token\(\s*$/,
      /^\s*let\ authorization\ =\ format!\("Bearer\ \{session_token\}"\);\s*$/,
      /^\s*session_token_secret:\ Some\(PROJECTION_SESSION_SECRET\.into\(\)\),\s*$/,
      /^\s*session_token:\ Option<\&'a\ str>,\s*$/,
      /^\s*if\ let\ Some\(token\)\ =\ request\.session_token\ \{\s*$/,
      /^\s*session_token:\ Some\(\&token\),\s*$/,
      /^\s*session_token:\ None,\s*$/,
      /^\s*session_token:\ Some\("viva1\.not\-a\-token"\),\s*$/,
      /^\s*let\ forged\ =\ signed_session_token\(\s*$/,
      /^\s*session_token:\ Some\(\&attacker\),\s*$/,
      /^\s*async\ fn\ library_route_mints_session_tokens_with_public_bearer_auth\(\)\ \{\s*$/,
      /^\s*format!\(r\#"\{\{"type":"session_config","version":\{VIVA_VOICE_PROTOCOL_VERSION\},"client_generation_id":"\{VOICE_TEST_CLIENT_GENERATION\}","session_token":"\{VOICE_TEST_PLACEHOLDER_CREDENTIAL\}","session":\{session\}\}\}"\#\)\.into\(\),\s*$/,
      /^\s*r\#"\{\{"type":"session_config","version":\{VIVA_VOICE_PROTOCOL_VERSION\},"client_generation_id":"\{VOICE_TEST_CLIENT_GENERATION\}","session_token":"\{VOICE_TEST_PLACEHOLDER_CREDENTIAL\}","session":\{\}\}\}"\#,\s*$/,
      /^\s*async\ fn\ websocket_accepts_signed_session_token_matching_initial_config\(\)\ \{\s*$/,
      /^\s*let\ state\ =\ test_state_with_session_token\("session\-secret"\)\s*$/,
      /^\s*"session_token":\ VOICE_TEST_PLACEHOLDER_CREDENTIAL,\s*$/,
      /^\s*session_token,\s*$/,
      /^\s*assert!\(session_token\.starts_with\("viva1\."\)\);\s*$/,
      /^\s*serde_json::json!\(\{\ "session_token":\ "viva1\.aaa\.bbb"\ \}\),\s*$/,
      /^\s*let\ state\ =\ test_state_with_session_token\("session\-secret"\)\.with_failure_control\(\s*$/,
      /^\s*let\ token\ =\ signed_session_token_with_failure_control\(FailureControlTokenFixture\ \{\s*$/,
      /^\s*let\ control_token\ =\ signed_session_token_with_failure_control\(FailureControlTokenFixture\ \{\s*$/,
      /^\s*let\ normal_token\ =\ signed_session_token\(\s*$/,
      /^\s*r\#"\{\{"type":"session_config","version":\{VIVA_VOICE_PROTOCOL_VERSION\},"client_generation_id":"\{VOICE_TEST_CLIENT_GENERATION\}","session_token":"\{VOICE_TEST_PLACEHOLDER_CREDENTIAL\}","session":\{session\}\}\}"\#\s*$/,
      /^\s*let\ biology_token\ =\ signed_session_token_with_failure_control\(FailureControlTokenFixture\ \{\s*$/,
      /^\s*let\ chemistry_token\ =\ signed_session_token_with_failure_control\(FailureControlTokenFixture\ \{\s*$/,
      /^\s*async\ fn\ websocket_rejects_replayed_session_token_before_brain_open\(\)\ \{\s*$/,
      /^\s*let\ token\ =\ signed_session_token\(\s*$/,
      /^\s*async\ fn\ websocket_rejects_invalid_session_token_before_brain_open\(\)\ \{\s*$/,
      /^\s*let\ biology_token\ =\ signed_session_token\(\s*$/,
      /^\s*let\ duplicate_biology_token\ =\ signed_session_token\(\s*$/,
      /^\s*let\ chemistry_token\ =\ signed_session_token\(\s*$/,
      /^\s*let\ physics_token\ =\ signed_session_token\(\s*$/,
      /^\s*"session_token":\ token,\s*$/,
      /^\s*fn\ signed_session_token\(\s*$/,
      /^\s*signed_session_token_claims\(secret,\ claims\)\s*$/,
      /^\s*fn\ signed_session_token_with_failure_control\(fixture:\ FailureControlTokenFixture<'_>\)\ \->\ String\ \{\s*$/,
      /^\s*signed_session_token_claims\(fixture\.session_secret,\ claims\)\s*$/,
      /^\s*fn\ signed_session_token_claims\(secret:\ \&str,\ claims:\ serde_json::Value\)\ \->\ String\ \{\s*$/,
      /^\s*self\.inner\.claim_session_token_nonce\(claim\)\.await\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "session_token_secret",
    patterns: Object.freeze([
      /^\s*session_token_secret:\ Some\("session\-secret"\.into\(\)\),\s*$/,
      /^\s*session_token_secret:\ Some\(secret\.into\(\)\),\s*$/,
      /^\s*session_token_secret:\ Some\(NONCE_AUDIT_SECRET\.into\(\)\),\s*$/,
      /^\s*session_token_secret:\ None,\s*$/,
      /^\s*session_token_secret:\ Some\(PROJECTION_SESSION_SECRET\.into\(\)\),\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "socket_token",
    patterns: Object.freeze([
      /^\s*let\ socket_token\ =\ provider_limiter_token\(\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "source_context",
    patterns: Object.freeze([
      /^\s*async\ fn\ websocket_strips_browser_source_context_before_trusted_output\(\)\ \{\s*$/,
      /^\s*session\.source_context\ =\ vec!\[agent_domain::SourceContext\ \{\s*$/,
      /^\s*serde_json::json!\(\{\ "source_context":\ \[\]\ \}\),\s*$/,
      /^\s*"source_context":\ \[\],\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "token",
    patterns: Object.freeze([
      /^\s*token:\ String,\s*$/,
      /^\s*\&case\.token,\s*$/,
      /^\s*!rendered\.contains\(\&case\.token\)\ \&\&\ !rendered\.contains\(\&expected_user_id\),\s*$/,
      /^\s*\.token;\s*$/,
      /^\s*token:\ \&str,\s*$/,
      /^\s*let\ token\ =\ nonce_audit_token\("voice\-session\-1",\ "nonce\-audit\-order\-1"\);\s*$/,
      /^\s*let\ token\ =\ nonce_audit_token\("voice\-session\-1",\ "nonce\-token\-only\-reconnect"\);\s*$/,
      /^\s*let\ token\ =\ projection_token\("user\-1",\ "biology\-midterm",\ "voice\-session\-1",\ "proj\-1"\);\s*$/,
      /^\s*let\ token\ =\ projection_token\("user\-1",\ "biology\-midterm",\ "voice\-session\-1",\ "proj\-ok"\);\s*$/,
      /^\s*let\ token\ =\ projection_token\("user\-1",\ "biology\-midterm",\ "voice\-session\-1",\ "proj\-fail"\);\s*$/,
      /^\s*let\ token\ =\ signed_session_token_with_failure_control\(FailureControlTokenFixture\ \{\s*$/,
      /^\s*let\ token\ =\ signed_session_token\(\s*$/,
      /^\s*fn\ session_config_json_with_token\(token:\ \&str\)\ \->\ String\ \{\s*$/,
      /^\s*let\ token\ =\ provider_limiter_token\(study_set_id,\ session_id,\ nonce\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "transcript_final",
    patterns: Object.freeze([
      /^\s*assert!\(!exported\.contains\("transcript_final"\)\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "user_password",
    patterns: Object.freeze([
      /^\s*const\ USER_PASSWORD:\ \&\[u8\]\ =\ b"viva\-user";\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "viva1.",
    patterns: Object.freeze([
      /^\s*const\ HOSTILE_SIGNED_CREDENTIAL:\ \&str\ =\ "viva1\.eyJ1c2VyX2lkIjoidXNlci0xIn0\.c2ln";\s*$/,
      /^\s*"viva1\.",\s*$/,
      /^\s*\.starts_with\("viva1\."\)\);\s*$/,
      /^\s*assert!\(!exported\.contains\("viva1\."\)\);\s*$/,
      /^\s*assert!\(control_token\.starts_with\("viva1\."\)\);\s*$/,
      /^\s*\("viva1\.malformed\.signature"\.to_owned\(\),\ "malformed"\),\s*$/,
      /^\s*let\ payload\ =\ format!\("viva1\.\{claims\}"\);\s*$/,
    ]),
  },
  {
    file: "agent/crates/agent-service/tests/voice_ws.rs",
    marker: "wrong_secret_token",
    patterns: Object.freeze([
      /^\s*let\ wrong_secret_token\ =\ signed_session_token\(\s*$/,
    ]),
  },
  {
    file: "agent/fixtures/voice-protocol/fake-cartesia-gemini-study-session.json",
    marker: "NADH donates high-energy electrons",
    patterns: Object.freeze([
      /^\s*"claim":\ "NADH\ donates\ high\-energy\ electrons\ to\ the\ electron\ transport\ chain\.",\s*$/,
    ]),
  },
  {
    file: "agent/fixtures/voice-protocol/server-event-question-started.json",
    marker: "NADH donates high-energy electrons",
    patterns: Object.freeze([
      /^\s*"claim":\ "NADH\ donates\ high\-energy\ electrons\ to\ the\ electron\ transport\ chain\.",\s*$/,
    ]),
  },
  {
    file: "agent/fixtures/voice-protocol/synthetic-study-session.json",
    marker: "NADH donates high-energy electrons",
    patterns: Object.freeze([
      /^\s*"claim":\ "NADH\ donates\ high\-energy\ electrons\ to\ the\ electron\ transport\ chain\.",\s*$/,
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
