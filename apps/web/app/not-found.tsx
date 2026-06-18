import Link from "next/link";

export default function NotFound() {
  return (
    <main className="app-shell not-found-shell">
      <section className="empty-state">
        <p className="kicker">Not found</p>
        <h1 className="display">This study room does not exist.</h1>
        <Link className="button button-primary" href="/">
          Return to Viva
        </Link>
      </section>
    </main>
  );
}
