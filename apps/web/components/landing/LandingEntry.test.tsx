import { describe, expect, test } from "bun:test";
import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Page, { dynamic } from "../../app/page";
import { projectLibrarySnapshot, type VivaLibrarySnapshot } from "../../lib/viva-library";
import { LandingEntry, landingEntryTarget } from "./LandingEntry";
import { LandingHero } from "./LandingHero";
import { libraryActionSessionTarget, startServerSession } from "./LibraryStatusPanel";

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

describe("LandingEntry", () => {
  test("renders the hero without mounting the legacy study app", () => {
    const markup = renderToStaticMarkup(<LandingEntry onEnter={() => {}} />);

    expect(markup).toContain("All you must know,");
    expect(markup).toContain("Where should Viva begin?");
    expect(markup).not.toContain("What are we studying?");
    expect(markup).not.toContain("Generate local preview");
  });

  test("routes command and suggestion directly to the single session entrypoint", () => {
    const intents: string[] = [];
    const element = LandingEntry({
      onEnter: (intent) => intents.push(intent),
    }) as ReactElement<{ children: ReactElement[] }>;
    const hero = Children.toArray(element.props.children).find(
      (child): child is ReactElement<LandingHeroProps> =>
        typeof child === "object" &&
        child !== null &&
        "type" in child &&
        child.type === LandingHero,
    );

    expect(hero?.type).toBe(LandingHero);
    hero?.props.onSubmit?.("oxidative phosphorylation");
    hero?.props.onSuggestion?.("Review missed concepts");

    expect(landingEntryTarget()).toBe("/session");
    expect(intents).toEqual(["oxidative phosphorylation", "Review missed concepts"]);
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
});

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
