/**
 * Client-side render-error reporting (`FRONTEND-012`): the one sanitizer
 * standing between a thrown `Error` object — whose `message`/`stack`/
 * `cause` may carry arbitrary application state, including tokens and
 * URLs — and anything that leaves the render tree: the DOM, a telemetry
 * sink, or the console. `apps/web/app/error.tsx` is the only caller. It
 * never interpolates the raw `Error` into JSX, `console.*`, JSON, or
 * telemetry tags itself; it renders fixed product copy plus the reference
 * this module validates, and calls `reportVivaClientRenderError` from an
 * effect keyed by the error object.
 */

/** The exact, two-key structured report this module ever emits. */
export type VivaClientRenderErrorReport = {
  event: "viva_client_render_error";
  reference: string | null;
};

/**
 * A Next.js error-boundary `digest` is an opaque server-minted id, never
 * end-user or attacker-controlled application text — but this validates it
 * anyway rather than trusting its shape, so a future digest format change
 * (or a differently-sourced value passed by mistake) can never smuggle a
 * URL, token, or arbitrary message text into rendered copy or a report.
 */
const SAFE_ERROR_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validates an error `digest` before it is ever rendered or reported.
 * Accepts only an unmodified match of `^[A-Za-z0-9_-]{1,64}$`; anything
 * else — the wrong type, empty, over 64 characters, or containing any
 * character outside that allowlist (whitespace, `:`, `/`, `?`, `#`, …) —
 * resolves to `null` rather than a truncated or partially-sanitized
 * fragment.
 */
export function safeVivaErrorReference(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  return SAFE_ERROR_REFERENCE_PATTERN.test(digest) ? digest : null;
}

/**
 * Error objects already reported, tracked by identity (`WeakSet`, so a
 * report that is no longer referenced anywhere else can still be garbage
 * collected). Deduplicating here — not in the caller — is what makes React
 * Strict Mode's mount/cleanup/remount effect replay, and any later
 * rerender against the *same* `Error` instance, emit exactly one report.
 */
const reportedErrors = new WeakSet<object>();

function defaultSink(report: VivaClientRenderErrorReport): void {
  console.error(report);
}

/**
 * Builds and emits exactly one sanitized `VivaClientRenderErrorReport` for
 * a given `Error`, deduplicated by object identity. The error is marked
 * reported *before* `sink` runs, so a throwing sink can never cause a
 * retry that resends (raw or sanitized) data — the report was already the
 * last thing this function will ever emit for that object, throw or not.
 * Reads only `error.digest`; never `error.message`, `.stack`, `.cause`,
 * `.name`, the current URL, or any other field.
 *
 * @param error the caught render error; only `.digest` is read
 * @param sink defaults to logging the structured report via `console.error`
 */
export function reportVivaClientRenderError(
  error: Error & { digest?: string },
  sink: (report: VivaClientRenderErrorReport) => void = defaultSink,
): void {
  if (reportedErrors.has(error)) return;
  reportedErrors.add(error);
  const report: VivaClientRenderErrorReport = {
    event: "viva_client_render_error",
    reference: safeVivaErrorReference(error.digest),
  };
  try {
    sink(report);
  } catch {
    // The error is already marked reported (above), so no retry with raw
    // data can follow; a broken sink must never fail the render path.
  }
}
