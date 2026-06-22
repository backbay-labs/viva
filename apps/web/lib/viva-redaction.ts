const REDACTED_VALUE = "[redacted]";

const FORBIDDEN_LOG_MARKERS = [
  "pcm16_base64",
  "answer_text",
  "bearer",
  "transcript_final",
  "prompt",
  "source_context",
  "pasted_text",
  "session_token",
  "viva1.",
  "Bearer ",
  "CARTESIA_API_KEY",
  "GEMINI_API_KEY",
  "raw answer",
  "secret",
  "source excerpt",
  "transcript",
  "bearer.",
] as const;

const FORBIDDEN_LOG_FIELDS = new Set(
  [
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
  ].map((field) => normalizeLogFieldName(field)),
);

export function redactForVivaLog(value: unknown): unknown {
  return redactValue(value, null);
}

export function isRedactedVivaLogValue(value: unknown): boolean {
  return value === REDACTED_VALUE;
}

function redactValue(value: unknown, key: string | null): unknown {
  if (key && isForbiddenLogField(key)) return REDACTED_VALUE;
  if (typeof value === "string") {
    return containsForbiddenLogMarker(value)
      ? REDACTED_VALUE
      : value.replace(/\s+/g, " ").slice(0, 240);
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, null));
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

function containsForbiddenLogMarker(value: string): boolean {
  const normalized = value.toLowerCase();
  return FORBIDDEN_LOG_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()));
}

function isForbiddenLogField(key: string): boolean {
  const normalized = normalizeLogFieldName(key);
  return (
    FORBIDDEN_LOG_FIELDS.has(normalized) ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_password") ||
    normalized.endsWith("_secret")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLogFieldName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s]+/g, "_")
    .toLowerCase();
}
