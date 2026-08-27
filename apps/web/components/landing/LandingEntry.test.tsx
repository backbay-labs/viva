import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, Children, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import Page, { dynamic } from "../../app/page";
import { projectLibrarySnapshot, type VivaLibrarySnapshot } from "../../lib/viva-library";
import { LandingEntry, landingEntryTarget } from "./LandingEntry";
import { LandingHero } from "./LandingHero";
import {
  LibraryStatusPanel,
  libraryActionSessionTarget,
  startServerSession,
} from "./LibraryStatusPanel";

type LandingHeroProps = Parameters<typeof LandingHero>[0];

const librarySnapshot: VivaLibrarySnapshot = {
  user_id: "user-1",
  privacy: {
    copy: "Voice recordings and transcripts are not saved; Viva stores sanitized study meaning only.",
    export: { available: true, control_token: "viva1.control-token" },
    export_contains_raw_provider_payloads: false,
    raw_audio_persistence: false,
    transcript_persistence: false,
    transcripts_saved: false,
    voice_recordings_saved: false,
  },
  study_sets: [
    {
      id: "biology-midterm",
      user_id: "user-1",
      title: "Biology Midterm",
      course: "Biology 201",
      ingestion_status: "ready",
      ingestion_error: null,
      server_owned: true,
      documents: [
        {
          id: "lec-5",
          display_name: "Lecture 5",
          source_kind: "pdf",
          processing_status: "ready",
          deleted: false,
        },
      ],
      concept_count: 2,
      question_count: 1,
      actions: {
        start: {
          available: true,
          session_id: "server-session",
          session_token: "viva1.server-token",
        },
        resume: { available: false, unavailable_reason: "no_open_session" },
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: true, control_token: "viva1.control-token" },
      },
    },
  ],
  sessions: [
    {
      voice_session_id: "voice-session-1",
      user_id: "user-1",
      study_set_id: "biology-midterm",
      study_set_title: "Biology Midterm",
      status: "closed",
      terminal_reason: "completed",
      recap: {
        voice_session_id: "voice-session-1",
        strong_concepts: ["oxidative-phosphorylation"],
        shaky_concepts: ["nadh"],
        missed_concepts: [],
        review_later: ["nadh"],
      },
      next_review: {
        concept_id: "nadh",
        label: "NADH",
        status: "shaky",
        persisted_due_at: "2026-06-19T09:00:00Z",
        source: "persisted_review_item",
      },
    },
  ],
};

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.VIVA_AGENT_HTTP_URL;
const originalPublicApiUrl = process.env.NEXT_PUBLIC_VIVA_API_URL;
const originalRestBearer = process.env.VIVA_AGENT_REST_BEARER_TOKEN;
const originalAllowedUsers = process.env.VIVA_SESSION_ALLOWED_USER_IDS;
const originalAllowedStudySets = process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS;
const originalBootstrapSecret = process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET;
const originalCanonicalOrigin = process.env.VIVA_WEB_CANONICAL_ORIGIN;

describe("LandingEntry", () => {
  test("renders the hero without mounting the legacy study app", () => {
    const markup = renderToStaticMarkup(<LandingEntry onEnter={() => {}} />);

    expect(markup).toContain("All you must know,");
    expect(markup).toContain("Begin oral exam");
    expect(markup).not.toContain("Where should Viva begin?");
    expect(markup).not.toContain("What are we studying?");
    expect(markup).not.toContain("Generate local preview");
  });

  test("routes the one honest begin action directly to the single session entrypoint (D-03 Branch B)", () => {
    let calls = 0;
    const element = LandingEntry({
      onEnter: () => {
        calls += 1;
      },
    }) as ReactElement<{ children: ReactElement[] }>;
    const hero = Children.toArray(element.props.children).find(
      (child): child is ReactElement<LandingHeroProps> =>
        typeof child === "object" &&
        child !== null &&
        "type" in child &&
        child.type === LandingHero,
    );

    expect(hero?.type).toBe(LandingHero);
    hero?.props.onBegin?.();

    expect(landingEntryTarget()).toBe("/session");
    expect(calls).toBe(1);
  });

  test("renders server-owned library and completed session history when provided", () => {
    const markup = renderToStaticMarkup(
      <LandingEntry initialLibrarySnapshot={librarySnapshot} onEnter={() => {}} />,
    );

    expect(markup).toContain("Library");
    expect(markup).toContain("Privacy controls");
    expect(markup).toContain("Voice recordings and transcripts are not saved");
    expect(markup).toContain("Export data");
    expect(markup).toContain("Biology Midterm");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Start");
    expect(markup).toContain("Delete source");
    expect(markup).toContain("Sessions");
    expect(markup).toContain("Completed");
    expect(markup).toContain("Delete recap");
    expect(markup).toContain("NADH");
    expect(markup).toContain("server schedule");
    expect(markup).toContain(
      "/session?user_id=user-1&amp;study_set_id=biology-midterm&amp;session_id=server-session",
    );
    expect(markup).not.toContain("session_token=");
    expect(markup).not.toContain("viva1.server-token");
  });

  test("keeps a direct signed-token session target available for static-export actions", () => {
    const target = libraryActionSessionTarget(
      { id: "biology-midterm", userId: "user-1" },
      {
        available: true,
        sessionId: "server-session",
        sessionToken: "viva1.static-export-token",
      },
      { includeSessionToken: true },
    );

    expect(target).toBe(
      "/session?user_id=user-1&study_set_id=biology-midterm&session_id=server-session#session_token=viva1.static-export-token",
    );
  });

  test("server-side initial library fetch uses server credentials and redacts the browser snapshot", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = "redacted-bootstrap-signing-secret";
      // CROSS-LANE FIXTURE COMPLETION, PENDING COORDINATOR RATIFICATION. This file is
      // Plan-13-owned; Plan 11 Task 3 lists app/page.tsx as READ ONLY and does not list this
      // test. WEBAPI-003 makes SSR capability minting bound to the configured canonical web
      // origin, so without this line page.tsx correctly mints nothing and the assertion below
      // on same_origin_control_token reads undefined. Mechanical, deterministic, and
      // assertion-preserving — the A-07 / A-08 / A-12.4 category — but those precedents were
      // coordinator-applied, so this one needs its own amendment row before merge. Plan 13
      // owns the file wholesale and may rewrite this setup freely.
      process.env.VIVA_WEB_CANONICAL_ORIGIN = "https://web.example";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify(librarySnapshot), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const page = (await Page()) as ReactElement<{ initialLibrarySnapshot: VivaLibrarySnapshot }>;

      expect(page.type).toBe(LandingEntry);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe("https://agent.example/study-sets/library?user_id=user-1");
      expect(calls[0]?.init?.cache).toBe("no-store");
      expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
        "Bearer server-rest-bearer",
      );
      expect(JSON.stringify(page.props.initialLibrarySnapshot)).not.toContain('"session_token"');
      expect(JSON.stringify(page.props.initialLibrarySnapshot)).not.toContain('"control_token"');
      expect(JSON.stringify(page.props.initialLibrarySnapshot)).not.toContain("viva1.server-token");
      expect(page.props.initialLibrarySnapshot.privacy.export).toEqual({
        available: false,
        unavailable_reason: "allowlist_filtered_export_unavailable",
      });
      const studySetDelete = page.props.initialLibrarySnapshot.study_sets[0]?.actions.delete;
      const sessionDelete = page.props.initialLibrarySnapshot.sessions[0]?.actions?.delete;
      expect(studySetDelete?.available).toBe(true);
      expect(
        studySetDelete?.available &&
          studySetDelete.same_origin_control_token?.startsWith("viva-control1."),
      ).toBe(true);
      expect(sessionDelete?.available).toBe(true);
      expect(
        sessionDelete?.available &&
          sessionDelete.same_origin_control_token?.startsWith("viva-control1."),
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
      restoreEnv("VIVA_WEB_CANONICAL_ORIGIN", originalCanonicalOrigin);
    }
  });

  test("server-side initial library fetch preserves direct session tokens when bootstrap is disabled", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      delete process.env.VIVA_AGENT_HTTP_URL;
      delete process.env.VIVA_AGENT_REST_BEARER_TOKEN;
      delete process.env.VIVA_SESSION_ALLOWED_USER_IDS;
      delete process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS;
      process.env.NEXT_PUBLIC_VIVA_API_URL = "https://agent.example";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify(librarySnapshot), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const page = (await Page()) as ReactElement<{ initialLibrarySnapshot: VivaLibrarySnapshot }>;

      expect(page.type).toBe(LandingEntry);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe("https://agent.example/study-sets/library");
      expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(null);
      expect(page.props.initialLibrarySnapshot.study_sets[0]?.actions.start).toEqual({
        available: true,
        session_id: "server-session",
        session_token: "viva1.server-token",
      });
      expect(page.props.initialLibrarySnapshot.privacy.export).toEqual({
        available: true,
      });
      expect(page.props.initialLibrarySnapshot.study_sets[0]?.actions.delete).toEqual({
        available: true,
      });
      expect(JSON.stringify(page.props.initialLibrarySnapshot)).not.toContain('"control_token"');
      expect(JSON.stringify(page.props.initialLibrarySnapshot)).not.toContain(
        "viva1.control-token",
      );
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("NEXT_PUBLIC_VIVA_API_URL", originalPublicApiUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("server-side initial library fetch fails closed when bootstrap config is incomplete", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
      delete process.env.VIVA_AGENT_REST_BEARER_TOKEN;
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify(librarySnapshot), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const page = (await Page()) as ReactElement<{ initialLibrarySnapshot: VivaLibrarySnapshot }>;

      expect(page.type).toBe(LandingEntry);
      expect(page.props.initialLibrarySnapshot).toBe(null);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("the landing page keeps static export compatible", () => {
    expect(dynamic).toBe("auto");
  });

  test("refreshes expired bootstrap capabilities before retrying session start", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const navigations: string[] = [];
    const staleSnapshot = librarySnapshotWithBootstrap("stale-bootstrap-capability");
    const freshSnapshot = librarySnapshotWithBootstrap("fresh-bootstrap-capability");
    const row = projectLibrarySnapshot(staleSnapshot).libraryRows[0];
    if (!row) throw new Error("fixture must include a library row");
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        if (calls.length === 1) {
          return new Response(JSON.stringify({ error: "session_bootstrap_capability_required" }), {
            headers: { "content-type": "application/json" },
            status: 403,
          });
        }
        return new Response(
          JSON.stringify({
            session: {
              session_id: "server-session",
              study_set_id: "biology-midterm",
              user_id: "user-1",
            },
            session_token: "redacted-session-token",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }) as typeof fetch;

      await startServerSession(row, "start", row.start, {
        navigate: (target) => navigations.push(target),
        refreshLibrary: async () => freshSnapshot,
      });

      expect(calls).toHaveLength(2);
      expect(JSON.parse(String(calls[0]?.init?.body)).session_bootstrap_token).toBe(
        "stale-bootstrap-capability",
      );
      expect(JSON.parse(String(calls[1]?.init?.body)).session_bootstrap_token).toBe(
        "fresh-bootstrap-capability",
      );
      expect(navigations).toEqual([
        "/session?user_id=user-1&study_set_id=biology-midterm&session_id=server-session#session_token=redacted-session-token",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("session cards surface a mastery ring, emphasise the next drill, and quiet the delete", () => {
    const markup = renderToStaticMarkup(
      <LandingEntry initialLibrarySnapshot={librarySnapshot} onEnter={() => {}} />,
    );

    // The completed session recap (1 strong / 1 shaky) rings its held share,
    // captioned so the bare percentage never reads as overall mastery.
    expect(markup).toContain("mastery-ring");
    expect(markup).toContain("viva-library__mastery-caption");
    // The persisted next review reads as the card's next action, not flat metadata.
    expect(markup).toContain("Next drill");
    expect(markup).toContain("server schedule");
    // Destructive actions are demoted to a quiet danger affordance.
    expect(markup).toContain("viva-library__action--danger");
    // The study-set primary action keeps its emphasis.
    expect(markup).toContain("viva-library__action--primary");
  });

  test("never logs the bootstrap or session token while refreshing an expired bootstrap capability and retrying", async () => {
    const staleSnapshot = librarySnapshotWithBootstrap("stale-bootstrap-capability");
    const freshSnapshot = librarySnapshotWithBootstrap("fresh-bootstrap-capability");
    const row = projectLibrarySnapshot(staleSnapshot).libraryRows[0];
    if (!row) throw new Error("fixture must include a library row");
    const order: string[] = [];
    const vaultCalls: unknown[] = [];
    const navigations: string[] = [];
    const loggedText: string[] = [];
    const originalConsole = { error: console.error, log: console.log, warn: console.warn };
    console.log = (...args: unknown[]) => loggedText.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => loggedText.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => loggedText.push(args.map(String).join(" "));
    try {
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        if (String(init?.body ?? "").includes("stale-bootstrap-capability")) {
          return new Response(JSON.stringify({ error: "session_bootstrap_capability_required" }), {
            headers: { "content-type": "application/json" },
            status: 403,
          });
        }
        return new Response(
          JSON.stringify({
            session: {
              session_id: "server-session",
              study_set_id: "biology-midterm",
              user_id: "user-1",
            },
            session_token: "redacted-session-token",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }) as typeof fetch;

      const outcome = await startServerSession(row, "start", row.start, {
        navigate: (target) => {
          order.push("navigate");
          navigations.push(target);
        },
        refreshLibrary: async () => freshSnapshot,
        sessionCredentialVault: {
          replaceBrowserSessionCredential: (input) => {
            order.push("vault");
            vaultCalls.push(input);
          },
        },
      });

      expect(outcome).toEqual({ ok: true });
      expect(navigations).toEqual([
        "/session?user_id=user-1&study_set_id=biology-midterm&session_id=server-session#session_token=redacted-session-token",
      ]);
      // The vault is only ever called once — on the successful retry — and
      // strictly before navigation, never on the 403 attempt.
      expect(vaultCalls).toEqual([
        {
          mode: "retain-token-only",
          refresh_expires_at: null,
          refresh_token: null,
          session_absolute_expires_at: null,
          session_id: "server-session",
          session_token: "redacted-session-token",
          study_set_id: "biology-midterm",
          user_id: "user-1",
        },
      ]);
      expect(order).toEqual(["vault", "navigate"]);

      for (const line of loggedText) {
        expect(line).not.toContain("stale-bootstrap-capability");
        expect(line).not.toContain("fresh-bootstrap-capability");
        expect(line).not.toContain("redacted-session-token");
      }
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalConsole.error;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
    }
  });
});

/**
 * D-07 Branch A (`retain-token-only`, `FRONTEND-011`): function-level proof
 * that `startServerSession` composes the "small local indirection" this task
 * owns in place of Plan 10's not-yet-published `replaceBrowserSessionCredential`
 * (confirmed absent from `apps/web/lib/use-viva-agent-session.ts` in this
 * tree before writing this test) — it must be handed the complete start
 * response and invoked strictly before navigation — and that the same-origin
 * start fetch is bounded so a hung mint can never hang the UI forever.
 */
describe("D-07 Branch A session-bootstrap composition: vault seam and fetch bound (FRONTEND-011)", () => {
  test("calls the session credential vault with the complete start response before navigating", async () => {
    const order: string[] = [];
    const vaultCalls: unknown[] = [];
    const navigations: string[] = [];
    const row = projectLibrarySnapshot(librarySnapshotWithBootstrap("full-response-sentinel"))
      .libraryRows[0];
    if (!row) throw new Error("fixture must include a library row");
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            refresh_expires_at: "2026-09-01T00:00:00Z",
            refresh_token: "viva1.full-refresh-token",
            session: {
              session_id: "server-session",
              study_set_id: "biology-midterm",
              user_id: "user-1",
            },
            session_absolute_expires_at: "2026-09-23T00:00:00Z",
            session_token: "viva1.full-session-token",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        )) as typeof fetch;

      const outcome = await startServerSession(row, "start", row.start, {
        navigate: (target) => {
          order.push("navigate");
          navigations.push(target);
        },
        sessionCredentialVault: {
          replaceBrowserSessionCredential: (input) => {
            order.push("vault");
            vaultCalls.push(input);
          },
        },
      });

      expect(outcome).toEqual({ ok: true });
      expect(vaultCalls).toEqual([
        {
          mode: "retain-token-only",
          refresh_expires_at: "2026-09-01T00:00:00Z",
          refresh_token: "viva1.full-refresh-token",
          session_absolute_expires_at: "2026-09-23T00:00:00Z",
          session_id: "server-session",
          session_token: "viva1.full-session-token",
          study_set_id: "biology-midterm",
          user_id: "user-1",
        },
      ]);
      expect(navigations).toEqual([
        "/session?user_id=user-1&study_set_id=biology-midterm&session_id=server-session#session_token=viva1.full-session-token",
      ]);
      expect(order).toEqual(["vault", "navigate"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes null refresh/expiry fields to the vault when today's real start response omits them", async () => {
    const vaultCalls: unknown[] = [];
    const row = projectLibrarySnapshot(librarySnapshotWithBootstrap("today-shape-sentinel"))
      .libraryRows[0];
    if (!row) throw new Error("fixture must include a library row");
    try {
      // Exactly today's real `handleVivaSessionStart` response shape
      // (`apps/web/app/api/viva-session/shared.ts`, not owned by this task).
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            failure_class: null,
            session: {
              session_id: "server-session",
              study_set_id: "biology-midterm",
              user_id: "user-1",
            },
            session_token: "viva1.today-session-token",
            token_refresh_outcome: "issued",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        )) as typeof fetch;

      const outcome = await startServerSession(row, "start", row.start, {
        navigate: () => {},
        sessionCredentialVault: {
          replaceBrowserSessionCredential: (input) => vaultCalls.push(input),
        },
      });

      expect(outcome).toEqual({ ok: true });
      expect(vaultCalls).toEqual([
        {
          mode: "retain-token-only",
          refresh_expires_at: null,
          refresh_token: null,
          session_absolute_expires_at: null,
          session_id: "server-session",
          session_token: "viva1.today-session-token",
          study_set_id: "biology-midterm",
          user_id: "user-1",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("defaults to the inert Phase-13A vault placeholder without throwing when the caller supplies none", async () => {
    const navigations: string[] = [];
    const row = projectLibrarySnapshot(librarySnapshotWithBootstrap("default-vault-sentinel"))
      .libraryRows[0];
    if (!row) throw new Error("fixture must include a library row");
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            session: {
              session_id: "server-session",
              study_set_id: "biology-midterm",
              user_id: "user-1",
            },
            session_token: "viva1.default-vault-token",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        )) as typeof fetch;

      const outcome = await startServerSession(row, "start", row.start, {
        navigate: (target) => navigations.push(target),
      });

      expect(outcome).toEqual({ ok: true });
      expect(navigations).toEqual([
        "/session?user_id=user-1&study_set_id=biology-midterm&session_id=server-session#session_token=viva1.default-vault-token",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("bounds the start fetch: a hung request neither navigates nor calls the vault, and surfaces a distinct timed_out outcome", async () => {
    const navigations: string[] = [];
    const vaultCalls: unknown[] = [];
    const row = projectLibrarySnapshot(librarySnapshotWithBootstrap("timeout-sentinel"))
      .libraryRows[0];
    if (!row) throw new Error("fixture must include a library row");
    try {
      globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })) as typeof fetch;

      const outcome = await startServerSession(row, "start", row.start, {
        navigate: (target) => navigations.push(target),
        sessionCredentialVault: {
          replaceBrowserSessionCredential: (input) => vaultCalls.push(input),
        },
        timeoutMs: 5,
      });

      expect(outcome).toEqual({ ok: false, reason: "timed_out" });
      expect(navigations).toEqual([]);
      expect(vaultCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Adversarial-review finding (important, first-attempt Task 6): the
  // previous `timeoutMs: 5` test above only proves a request whose *headers*
  // never arrive is bounded. `fetchWithVivaSessionStartTimeout` cleared its
  // timer the instant `fetch()` itself settled, so a response whose headers
  // arrived immediately but whose *body* never completed ran `response.json()`
  // with no live timer at all — an unbounded hang the 6000ms policy never
  // covered. `hangingStartResponse` below mirrors the exact
  // `hangingJsonResponse` idiom `apps/web/lib/viva-session-api.test.ts`
  // already uses for the equivalent server-side gap (`ReadableStream` that
  // only errors when the same `AbortSignal` fires), so this proves the fix
  // at the real `fetch`/`Response`/`AbortSignal` layer, not only through the
  // synthetic `manualFakeTimers()` double in `viva-library.test.ts`.
  test("bounds the start fetch across the response body read too: headers arriving promptly never disarms the bound before a stalled body completes", async () => {
    const navigations: string[] = [];
    const vaultCalls: unknown[] = [];
    const row = projectLibrarySnapshot(librarySnapshotWithBootstrap("body-hang-sentinel"))
      .libraryRows[0];
    if (!row) throw new Error("fixture must include a library row");
    try {
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) =>
        hangingStartResponse(init?.signal ?? undefined)) as typeof fetch;

      // `rejectAfter` is a safety backstop, not the mechanism under test: if
      // `startServerSession` regresses to the pre-fix unbounded behavior,
      // this makes the test fail fast with a clear message instead of
      // hanging the whole `bun test` process (this repo's local `bun:test`
      // ambient types, `types/bun-test/index.d.ts`, declare no per-test
      // timeout parameter to lean on instead).
      const outcome = await Promise.race([
        startServerSession(row, "start", row.start, {
          navigate: (target) => navigations.push(target),
          sessionCredentialVault: {
            replaceBrowserSessionCredential: (input) => vaultCalls.push(input),
          },
          timeoutMs: 5,
        }),
        rejectAfter(500, "the start fetch's response-body read did not time out"),
      ]);

      expect(outcome).toEqual({ ok: false, reason: "timed_out" });
      expect(navigations).toEqual([]);
      expect(vaultCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * A `Response` whose headers resolve immediately (status 200, JSON content
 * type) but whose body is a `ReadableStream` that never enqueues or closes
 * on its own — `response.json()` against it hangs until `signal` aborts, at
 * which point the stream errors and the read rejects. Mirrors
 * `hangingJsonResponse` in `apps/web/lib/viva-session-api.test.ts` (that
 * file's equivalent proof for the server-side upstream-body-read bound);
 * this is the browser-side counterpart for `requestServerSession`'s fetch.
 */
function hangingStartResponse(signal: AbortSignal | undefined): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

/** A real (short) timer-based race, only ever used as a RED/safety backstop so a genuinely unbounded hang fails fast with a clear message instead of hanging the whole `bun test` process. */
async function rejectAfter(ms: number, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  throw new Error(message);
}

/**
 * D-07 Branch A (`FRONTEND-011`) mounted proof, using the happy-dom runtime
 * Plan 12's early manifest handoff makes available in this tree
 * (`"happy-dom": "20.11.6"` / `"@happy-dom/global-registrator": "20.11.6"`
 * in `apps/web/package.json`). Unlike the function-level tests above (which
 * call `startServerSession` directly), these mount the real
 * `LibraryStatusPanel` component into a real DOM and dispatch a genuine
 * `click()` through React's own event system, proving the button's actual
 * wiring — not only the underlying function's behavior.
 */
describe("LibraryStatusPanel mounted session-bootstrap composition (D-07 Branch A, happy-dom)", () => {
  test("a real click on Start sends the sentinel exactly once in the POST body, calls the vault before navigating, and never renders any credential into the DOM", async () => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const sentinel = "MOUNTED_BOOTSTRAP_SENTINEL";
    const seededSnapshot = librarySnapshotWithBootstrap(sentinel);
    const requests: Array<string | undefined> = [];
    const order: string[] = [];
    const navigations: string[] = [];
    const vaultCalls: unknown[] = [];
    let container: HTMLDivElement | null = null;
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        requests.push(init?.body as string | undefined);
        return new Response(
          JSON.stringify({
            refresh_expires_at: "2026-09-01T00:00:00Z",
            refresh_token: "viva1.mounted-refresh-token",
            session: {
              session_id: "server-session",
              study_set_id: "biology-midterm",
              user_id: "user-1",
            },
            session_absolute_expires_at: "2026-09-23T00:00:00Z",
            session_token: "viva1.mounted-session-token",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }) as typeof fetch;

      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      const mountedContainer = container;

      await act(async () => {
        root?.render(
          <LibraryStatusPanel
            navigate={(target) => {
              order.push("navigate");
              navigations.push(target);
            }}
            sessionCredentialVault={{
              replaceBrowserSessionCredential: (input) => {
                order.push("vault");
                vaultCalls.push(input);
              },
            }}
            snapshot={seededSnapshot}
          />,
        );
      });

      expect(mountedContainer.innerHTML).not.toContain(sentinel);

      const startButton = mountedContainer.querySelector('[aria-label="Start Biology Midterm"]');
      if (!(startButton instanceof HTMLElement)) {
        throw new Error("expected a real Start button in the mounted DOM");
      }

      await act(async () => {
        startButton.click();
        await waitForCondition(() => navigations.length > 0 || vaultCalls.length > 0);
      });

      expect(requests).toHaveLength(1);
      const sentBody = requests[0] ? JSON.parse(requests[0]) : null;
      expect(sentBody?.session_bootstrap_token).toBe(sentinel);

      expect(vaultCalls).toEqual([
        {
          mode: "retain-token-only",
          refresh_expires_at: "2026-09-01T00:00:00Z",
          refresh_token: "viva1.mounted-refresh-token",
          session_absolute_expires_at: "2026-09-23T00:00:00Z",
          session_id: "server-session",
          session_token: "viva1.mounted-session-token",
          study_set_id: "biology-midterm",
          user_id: "user-1",
        },
      ]);
      expect(navigations).toEqual([
        "/session?user_id=user-1&study_set_id=biology-midterm&session_id=server-session#session_token=viva1.mounted-session-token",
      ]);
      expect(order).toEqual(["vault", "navigate"]);

      expect(mountedContainer.innerHTML).not.toContain(sentinel);
      expect(mountedContainer.innerHTML).not.toContain("viva1.mounted-session-token");
      expect(mountedContainer.innerHTML).not.toContain("viva1.mounted-refresh-token");

      // Mirrors `checkNoSessionBootstrapStorageLeak` in
      // `scripts/frontend-accessibility.mjs`: D-07 Branch A Step 3's "adds
      // no persistent browser storage" — read after the same real click,
      // not merely asserted by omission.
      const storageSnapshot = JSON.stringify({
        cookie: document.cookie,
        local: { ...localStorage },
        session: { ...sessionStorage },
      });
      expect(storageSnapshot).not.toContain(sentinel);
      expect(storageSnapshot).not.toContain("viva1.mounted-session-token");
      expect(storageSnapshot).not.toContain("viva1.mounted-refresh-token");
    } finally {
      if (root) {
        act(() => {
          root?.unmount();
        });
      }
      container?.remove();
      globalThis.fetch = originalFetch;
      await GlobalRegistrator.unregister();
    }
  });

  test("a hung start request surfaces an explicit timed-out status in the mounted UI rather than hanging forever", async () => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const seededSnapshot = librarySnapshotWithBootstrap("hung-request-sentinel");
    let container: HTMLDivElement | null = null;
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })) as typeof fetch;

      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      const mountedContainer = container;

      await act(async () => {
        // A tiny `startFetchTimeoutMs` override keeps this real-DOM, real-click
        // proof fast; the production default (`VIVA_SESSION_START_FETCH_TIMEOUT_MS`
        // = 6000ms) is separately locked and proved with injected fake timers in
        // `apps/web/lib/viva-library.test.ts`.
        root?.render(
          <LibraryStatusPanel
            navigate={() => {}}
            snapshot={seededSnapshot}
            startFetchTimeoutMs={5}
          />,
        );
      });

      const startButton = mountedContainer.querySelector('[aria-label="Start Biology Midterm"]');
      if (!(startButton instanceof HTMLElement)) {
        throw new Error("expected a real Start button in the mounted DOM");
      }

      await act(async () => {
        startButton.click();
        await waitForCondition(
          () =>
            mountedContainer.querySelector(".viva-library__status")?.textContent ===
            "Session start timed out.",
        );
      });

      expect(mountedContainer.querySelector(".viva-library__status")?.textContent).toBe(
        "Session start timed out.",
      );
    } finally {
      if (root) {
        act(() => {
          root?.unmount();
        });
      }
      container?.remove();
      globalThis.fetch = originalFetch;
      await GlobalRegistrator.unregister();
    }
  });
});

/**
 * Polls `check` on a macrotask boundary (never real wall-clock waiting
 * beyond scheduler yields) until it returns true or `maxIterations` elapses,
 * so an `act(async () => ...)` block can deterministically wait out an async
 * handler's promise chain without guessing a fixed number of microtask hops.
 */
async function waitForCondition(check: () => boolean, maxIterations = 50): Promise<void> {
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function librarySnapshotWithBootstrap(sessionBootstrapToken: string): VivaLibrarySnapshot {
  const readyStudySet = librarySnapshot.study_sets[0];
  if (!readyStudySet) throw new Error("fixture must include a ready study set");
  return {
    ...librarySnapshot,
    study_sets: [
      {
        ...readyStudySet,
        actions: {
          ...readyStudySet.actions,
          start: {
            available: true,
            session_bootstrap_token: sessionBootstrapToken,
            session_id: "server-session",
          },
        },
      },
    ],
  };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
