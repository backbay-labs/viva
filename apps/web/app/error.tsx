"use client";

export default function AppError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return (
    <main className="app-shell not-found-shell">
      <section className="empty-state">
        <p className="kicker">Runtime error</p>
        <h1 className="display">Viva lost the thread.</h1>
        <p>{error.message}</p>
        <button className="button button-primary" onClick={reset} type="button">
          Try again
        </button>
      </section>
    </main>
  );
}
