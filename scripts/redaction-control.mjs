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

const SAFE_FORBIDDEN_MARKER_LITERALS = new Map([["session_token", ["invalid_session_token"]]]);

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
    marker: "authorization",
    patterns: Object.freeze([/authorization: `AWS4-HMAC-SHA256 Credential=/]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "secret",
    patterns: Object.freeze([/hmac\(`AWS4\$\{secret\}`, dateStamp\)/]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "session_token",
    patterns: Object.freeze([/VIVA_VOICE_SESSION_TOKEN_SECRET: requiredValue/]),
  },
  {
    file: "scripts/hosted-monitor-runner.mjs",
    marker: "viva_voice_session_token_secret",
    patterns: Object.freeze([/VIVA_VOICE_SESSION_TOKEN_SECRET: requiredValue/]),
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
]);

const AUDITED_FILE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx", ".rs", ".yml", ".yaml"]);

const RUNTIME_REDACTION_BOUNDARY_FILES = new Set([
  "apps/web/lib/viva-redaction.ts",
  "agent/crates/observe/src/lib.rs",
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
