"use client";

import { useEffect, useRef } from "react";
import {
  reportVivaClientRenderError,
  safeVivaErrorReference,
} from "../lib/viva-client-error-reporting";

/**
 * Global render-error boundary (`FRONTEND-012`). Renders only fixed
 * product copy and a validated reference — never `error.message`,
 * `.stack`, `.cause`, or any other field of the caught `Error`, which may
 * carry arbitrary application state including tokens and URLs. Reports
 * exactly one sanitized event per distinct thrown error via
 * `reportVivaClientRenderError`, called from an effect keyed by the error
 * object so React Strict Mode's mount/cleanup/remount replay — and any
 * later rerender against the same error — never double-reports.
 */
export default function AppError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  // Guards "Try again" to invoke `reset` at most once per distinct error,
  // without ever disabling the button — a disabled control loses keyboard
  // focus, which the retry action must preserve while its reset is
  // pending.
  const resetInvokedForError = useRef<(Error & { digest?: string }) | null>(null);

  useEffect(() => {
    reportVivaClientRenderError(error);
  }, [error]);

  const reference = safeVivaErrorReference(error.digest);

  function handleRetry() {
    if (resetInvokedForError.current === error) return;
    resetInvokedForError.current = error;
    reset();
  }

  return (
    <main className="app-shell not-found-shell">
      <section className="empty-state">
        <p className="kicker">Runtime error</p>
        <h1 className="display">Viva lost the thread.</h1>
        <p>Something went wrong while rendering this page.</p>
        {reference !== null ? <p className="cap">Reference: {reference}</p> : null}
        <button className="button button-primary" onClick={handleRetry} type="button">
          Try again
        </button>
      </section>
    </main>
  );
}
