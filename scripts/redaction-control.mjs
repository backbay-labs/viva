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
  "transcript_final",
  "transcript_text",
]);

const forbiddenStructuralFieldSet = new Set(
  FORBIDDEN_STRUCTURAL_FIELDS.map((field) => normalizeStructuralFieldName(field)),
);

const AUDITED_FILE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".rs",
  ".yml",
  ".yaml",
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
      `${context} includes forbidden evidence field: ${structuralHits
        .slice(0, 5)
        .join(", ")}`,
    );
  }
  assertNoForbiddenTextMarkers(serializedForAudit(value), { context, env });
}

export function assertNoForbiddenTextMarkers(text, { context = "artifact", env = process.env } = {}) {
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
  if (
    file === "scripts/redaction-control.mjs" ||
    file === "scripts/redaction-control-check.mjs" ||
    file === "apps/web/lib/viva-redaction.ts" ||
    file === "agent/crates/observe/src/lib.rs"
  ) {
    return false;
  }
  const extension = path.extname(file);
  if (!AUDITED_FILE_EXTENSIONS.has(extension)) return false;
  return /(^scripts\/|^apps\/web\/|^agent\/crates\/|^packages\/|^\.github\/workflows\/)/.test(file);
}

export function addedLineViolatesRedactionAudit(line) {
  return Boolean(forbiddenEvidenceMarkerInText(line) ?? forbiddenStructuralFieldInText(line));
}

export function forbiddenEvidenceMarkerInText(text) {
  const normalized = text.toLowerCase();
  return FORBIDDEN_EVIDENCE_MARKERS.find((marker) => normalized.includes(marker.toLowerCase()));
}

export function forbiddenStructuralFieldInText(text) {
  const candidatePattern = /(^|[^A-Za-z0-9_$])["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*(?=[:=,})])/g;
  let match = candidatePattern.exec(text);
  while (match) {
    const normalized = normalizeStructuralFieldName(match[2]);
    if (isForbiddenStructuralField(normalized)) return normalized;
    match = candidatePattern.exec(text);
  }
  return undefined;
}

function redactValue(value, key) {
  if (key && isForbiddenStructuralField(key)) return REDACTED_VALUE;
  if (typeof value === "string") {
    return forbiddenEvidenceMarkerInText(value) ? REDACTED_VALUE : value.replace(/\s+/g, " ").slice(0, 240);
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
    normalized.endsWith("_secret")
  );
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
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s]+/g, "_")
    .toLowerCase();
}
