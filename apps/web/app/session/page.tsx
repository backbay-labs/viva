import type { Metadata } from "next";
import { LiveSessionPage } from "../../components/session/LiveSessionPage";

/**
 * `FRONTEND-009` (Task 11): without an explicit dynamic-rendering opt-in,
 * a production (`next start`) build of this route — which reads no
 * dynamic API and has no data fetching of its own — is prerendered once
 * and Next.js then never applies `apps/web/proxy.ts`'s per-request CSP
 * nonce to any `<script>` tag it emits for it (confirmed directly: a raw
 * fetch of the built route's HTML carried zero `nonce="…"` attributes
 * across 16-18 script tags, against the one nonce named in its own
 * `Content-Security-Policy` response header — every client bundle chunk
 * then fails to execute, and the route never hydrates at all, "Preparing
 * your session…" forever). `/` needs no such opt-in because its own
 * `page.tsx` already reads request-scoped data. This is a route-segment
 * rendering-mode flag only — no session semantics, protocol, or UI
 * behavior changes — so it is not a session-semantics edit under this
 * program's Plan 10/13 boundary; flagged here for Plan 10's/CSP owner's
 * own review regardless.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Viva · Live session",
  description: "A live oral exam drawn from your sources — the listening manuscript.",
  referrer: "no-referrer",
};

export default function Page() {
  return <LiveSessionPage />;
}
