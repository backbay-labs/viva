import * as bunTest from "bun:test";
import type { NextRequest } from "next/server";
import { DELETE, GET, POST } from "../app/api/viva-library/[[...path]]/route";
import { signVivaLibraryControlToken } from "../app/api/viva-session/shared";

const { afterEach, beforeEach, describe, expect, test } = bunTest as typeof bunTest & {
  afterEach: (fn: () => void) => void;
  beforeEach: (fn: () => void) => void;
};

// Fixture credentials: long enough to satisfy the recorded strength floor and clearly
// non-production. No value here is a real or real-shaped credential.
const LIBRARY_CANONICAL_ORIGIN = "http://localhost:3000";
const LIBRARY_READ_BEARER = "viva-fixture-agent-library-read-bearer";
const LIBRARY_DELETE_BEARER = "viva-fixture-agent-library-delete-bearer";
const LIBRARY_BOOTSTRAP_SECRET = "viva-fixture-bootstrap-signing-key-01";

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.VIVA_AGENT_HTTP_URL;
const originalPublicAgentUrl = process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL;
const originalBearer = process.env.VIVA_VOICE_WS_BEARER_TOKEN;
const originalRestBearer = process.env.VIVA_AGENT_REST_BEARER_TOKEN;
const originalAllowedUsers = process.env.VIVA_SESSION_ALLOWED_USER_IDS;
const originalAllowedStudySets = process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS;
const originalBootstrapSecret = process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET;
const originalProxyTimeout = process.env.VIVA_LIBRARY_PROXY_TIMEOUT_MS;

describe("Viva library proxy", () => {
  const scopedEnv = [
    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
    "VIVA_WEB_CANONICAL_ORIGIN",
  ] as const;
  const savedScopedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of scopedEnv) savedScopedEnv.set(name, process.env[name]);
    process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN = LIBRARY_READ_BEARER;
    process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN = LIBRARY_DELETE_BEARER;
    process.env.VIVA_WEB_CANONICAL_ORIGIN = LIBRARY_CANONICAL_ORIGIN;
  });

  afterEach(() => {
    for (const [name, value] of savedScopedEnv) restoreEnv(name, value);
    savedScopedEnv.clear();
  });

  test("forwards caller control tokens without injecting the private server bearer", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_VOICE_WS_BEARER_TOKEN = "server-secret";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": "viva1.control-token",
        }),
        method: "DELETE",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/biology-midterm?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await DELETE(request, {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe("http://agent.test/study-sets/biology-midterm?user_id=user-1");
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("x-viva-library-control-token")).toBe("viva1.control-token");
      expect(headers.get("origin")).toBe("http://localhost:3000");
      expect(headers.get("authorization")).toBe(null);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_VOICE_WS_BEARER_TOKEN", originalBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("blocks same-origin allowed study-set deletes without a signed control capability", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "DELETE",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/biology-midterm?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await DELETE(request, {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({ error: "viva_library_control_capability_required" });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("injects the server REST bearer for signed same-origin study-set deletes", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const controlToken = signVivaLibraryControlToken({
        scope: "study_set_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
      });
      if (!controlToken) throw new Error("test fixture must sign study-set delete control token");

      const request = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": controlToken,
        }),
        method: "DELETE",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/biology-midterm?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await DELETE(request, {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe("http://agent.test/study-sets/biology-midterm?user_id=user-1");
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${LIBRARY_DELETE_BEARER}`);
      expect(headers.get("x-viva-library-control-token")).toBe(null);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
    }
  });

  test("injects the server REST bearer for signed same-origin session recap deletes", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const controlToken = signVivaLibraryControlToken({
        scope: "session_history_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
        voiceSessionId: "voice-session-1",
      });
      if (!controlToken) throw new Error("test fixture must sign session delete control token");

      const request = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": controlToken,
        }),
        method: "DELETE",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await DELETE(request, {
        params: Promise.resolve({
          path: ["study-sets", "biology-midterm", "sessions", "voice-session-1"],
        }),
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe(
        "http://agent.test/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1",
      );
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${LIBRARY_DELETE_BEARER}`);
      expect(headers.get("x-viva-library-control-token")).toBe(null);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
    }
  });

  test("rejects signed same-origin delete capabilities outside their session scope", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const controlToken = signVivaLibraryControlToken({
        scope: "session_history_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
        voiceSessionId: "different-session",
      });
      if (!controlToken) throw new Error("test fixture must sign mismatched control token");

      const request = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": controlToken,
        }),
        method: "DELETE",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await DELETE(request, {
        params: Promise.resolve({
          path: ["study-sets", "biology-midterm", "sessions", "voice-session-1"],
        }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({ error: "viva_library_control_capability_required" });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
    }
  });

  test("strips start and resume session tokens from browser library snapshots", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      delete process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            user_id: "user-1",
            study_sets: [
              {
                id: "biology-midterm",
                user_id: "user-1",
                actions: {
                  start: {
                    available: true,
                    session_id: "server-session",
                    session_token: "viva1.redacted-start-token",
                  },
                  resume: {
                    available: true,
                    session_id: "open-session",
                    session_token: "viva1.redacted-resume-token",
                  },
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        )) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.study_sets[0].actions.start).toEqual({
        available: true,
        session_id: "server-session",
      });
      expect(body.study_sets[0].actions.resume).toEqual({
        available: true,
        session_id: "open-session",
      });
      expect(JSON.stringify(body)).not.toContain('"session_token"');
      expect(JSON.stringify(body)).not.toContain("viva1.redacted");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
    }
  });

  test("filters bearer-backed browser library snapshots to the requested user and allowed study sets", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            user_id: "user-1",
            privacy: {
              export: { available: true, control_token: "viva1.export-control" },
            },
            study_sets: [
              {
                id: "biology-midterm",
                user_id: "user-1",
                actions: {
                  delete: { available: true, control_token: "viva1.delete-control" },
                  start: {
                    available: true,
                    session_id: "allowed-session",
                    session_token: "viva1.allowed-session-token",
                  },
                },
              },
              {
                id: "history-final",
                user_id: "user-1",
                actions: {
                  delete: { available: true, control_token: "viva1.disallowed-control" },
                  start: {
                    available: true,
                    session_id: "disallowed-session",
                    session_token: "viva1.disallowed-session-token",
                  },
                },
              },
              {
                id: "biology-midterm",
                user_id: "user-2",
                actions: {
                  start: {
                    available: true,
                    session_id: "other-user-session",
                    session_token: "viva1.other-user-session-token",
                  },
                },
              },
            ],
            sessions: [
              {
                voice_session_id: "allowed-recap",
                user_id: "user-1",
                study_set_id: "biology-midterm",
              },
              {
                voice_session_id: "disallowed-recap",
                user_id: "user-1",
                study_set_id: "history-final",
              },
              {
                voice_session_id: "other-user-recap",
                user_id: "user-2",
                study_set_id: "biology-midterm",
              },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        )) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.study_sets.map((studySet: { id: string }) => studySet.id)).toEqual([
        "biology-midterm",
      ]);
      expect(
        body.sessions.map((session: { voice_session_id: string }) => session.voice_session_id),
      ).toEqual(["allowed-recap"]);
      expect(JSON.stringify(body)).not.toContain("user-2");
      expect(JSON.stringify(body)).not.toContain("history-final");
      expect(JSON.stringify(body)).not.toContain('"session_token"');
      expect(body.privacy.export).toEqual({
        available: false,
        unavailable_reason: "allowlist_filtered_export_unavailable",
      });
      expect(body.study_sets[0].actions.delete.available).toBe(true);
      expect(
        body.study_sets[0].actions.delete.same_origin_control_token.startsWith("viva-control1."),
      ).toBe(true);
      expect(body.sessions[0].actions.delete.available).toBe(true);
      expect(
        body.sessions[0].actions.delete.same_origin_control_token.startsWith("viva-control1."),
      ).toBe(true);
      expect(JSON.stringify(body)).not.toContain('"session_token"');
      expect(JSON.stringify(body)).not.toContain('"control_token"');
      expect(JSON.stringify(body)).not.toContain("viva1.disallowed");
      expect(JSON.stringify(body)).not.toContain("viva1.allowed-session-token");
      expect(JSON.stringify(body)).not.toContain("viva1.delete-control");
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
    }
  });

  test("does not let caller Authorization bypass bearer-backed browser snapshot filtering", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(
          JSON.stringify({
            user_id: "user-1",
            privacy: {
              export: { available: true, control_token: "viva1.export-control" },
            },
            study_sets: [
              {
                id: "biology-midterm",
                user_id: "user-1",
                actions: {
                  delete: { available: true, control_token: "viva1.delete-control" },
                  start: {
                    available: true,
                    session_id: "allowed-session",
                    session_token: "viva1.allowed-session-token",
                  },
                },
              },
              {
                id: "history-final",
                user_id: "user-1",
                actions: {
                  start: {
                    available: true,
                    session_id: "disallowed-session",
                    session_token: "viva1.disallowed-session-token",
                  },
                },
              },
              {
                id: "biology-midterm",
                user_id: "user-2",
                actions: {
                  start: {
                    available: true,
                    session_id: "other-user-session",
                    session_token: "viva1.other-user-session-token",
                  },
                },
              },
            ],
            sessions: [
              {
                voice_session_id: "allowed-recap",
                user_id: "user-1",
                study_set_id: "biology-midterm",
              },
              {
                voice_session_id: "other-user-recap",
                user_id: "user-2",
                study_set_id: "biology-midterm",
              },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }) as typeof fetch;

      const request = {
        headers: new Headers({
          authorization: "Bearer viva1.browser-session-token",
          origin: LIBRARY_CANONICAL_ORIGIN,
        }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${LIBRARY_READ_BEARER}`);
      expect(body.study_sets.map((studySet: { id: string }) => studySet.id)).toEqual([
        "biology-midterm",
      ]);
      expect(
        body.sessions.map((session: { voice_session_id: string }) => session.voice_session_id),
      ).toEqual(["allowed-recap"]);
      expect(JSON.stringify(body)).not.toContain("user-2");
      expect(JSON.stringify(body)).not.toContain("history-final");
      expect(JSON.stringify(body)).not.toContain('"session_token"');
      expect(body.privacy.export).toEqual({
        available: false,
        unavailable_reason: "allowlist_filtered_export_unavailable",
      });
      expect(body.study_sets[0].actions.delete.available).toBe(true);
      expect(
        body.study_sets[0].actions.delete.same_origin_control_token.startsWith("viva-control1."),
      ).toBe(true);
      expect(body.sessions[0].actions.delete.available).toBe(true);
      expect(
        body.sessions[0].actions.delete.same_origin_control_token.startsWith("viva-control1."),
      ).toBe(true);
      expect(JSON.stringify(body)).not.toContain('"session_token"');
      expect(JSON.stringify(body)).not.toContain('"control_token"');
      expect(JSON.stringify(body)).not.toContain("viva1.disallowed");
      expect(JSON.stringify(body)).not.toContain("viva1.allowed-session-token");
      expect(JSON.stringify(body)).not.toContain("viva1.delete-control");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
    }
  });

  test("injects the server REST bearer for allowed browser library snapshots", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify({ study_sets: [], user_id: "user-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${LIBRARY_READ_BEARER}`);
      expect(headers.get("origin")).toBe("http://localhost:3000");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("blocks user-wide export through bearer-backed allowlisted proxy snapshots", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": "viva1.control-token",
        }),
        method: "GET",
        nextUrl: new URL("http://localhost:3000/api/viva-library/study-sets/export?user_id=user-1"),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "export"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({ error: "viva_library_control_scope_not_allowed" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("blocks disallowed study-set control routes before reaching the agent", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": "viva1.control-token",
        }),
        method: "DELETE",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/history-final?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await DELETE(request, {
        params: Promise.resolve({ path: ["study-sets", "history-final"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({ error: "viva_library_control_scope_not_allowed" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("sanitizes upstream browser library snapshot errors after private bearer injection", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            authorization: `Bearer ${LIBRARY_READ_BEARER}`,
            detail: "agent failure at http://agent.test/study-sets/library",
            session_token: "viva1.raw-upstream-token",
          }),
          { headers: { "content-type": "application/json" }, status: 503 },
        )) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({
        error: "viva_library_pre_loop_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_ingestion_unavailable",
      });
      expect(JSON.stringify(body)).not.toContain("viva-fixture-legacy-rest-bearer");
      expect(JSON.stringify(body)).not.toContain("agent.test");
      expect(JSON.stringify(body)).not.toContain('"session_token"');
      expect(JSON.stringify(body)).not.toContain("viva1.");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("sanitizes bearer-backed browser snapshot validation failures", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            authorization: `Bearer ${LIBRARY_READ_BEARER}`,
            detail: "invalid browser library request at http://agent.test/study-sets/library",
            session_token: "viva1.raw-upstream-token",
          }),
          { headers: { "content-type": "application/json" }, status: 400 },
        )) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({
        error: "viva_library_pre_loop_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_ingestion_unavailable",
      });
      expect(JSON.stringify(body)).not.toContain("viva-fixture-legacy-rest-bearer");
      expect(JSON.stringify(body)).not.toContain("agent.test");
      expect(JSON.stringify(body)).not.toContain('"session_token"');
      expect(JSON.stringify(body)).not.toContain("viva1.");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("fails browser library snapshots closed when the scoped read credential is missing", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      delete process.env.VIVA_AGENT_REST_BEARER_TOKEN;
      delete process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN;
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ study_sets: [], user_id: "user-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({
        error: "viva_library_auth_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_ingestion_unavailable",
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("classifies local library allowlist failures as pre-loop ingestion", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      delete process.env.VIVA_SESSION_ALLOWED_USER_IDS;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ study_sets: [], user_id: "user-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({
        error: "viva_library_identity_allowlist_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_ingestion_unavailable",
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("classifies disallowed browser snapshot users as access denied", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ study_sets: [], user_id: "user-2" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-2",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: "viva_library_identity_not_allowed",
        failure_class: "access_denied",
        stage: "pre_loop",
      });
      expect(JSON.stringify(body)).not.toContain("pre_loop_ingestion_unavailable");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("does not send the server REST bearer to public or fallback agent URLs", async () => {
    const calls: string[] = [];
    try {
      delete process.env.VIVA_AGENT_HTTP_URL;
      process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://public-agent.example";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ study_sets: [], user_id: "user-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const request = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({ error: "viva_agent_unavailable" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("NEXT_PUBLIC_VIVA_AGENT_HTTP_URL", originalPublicAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("forwards file ingestion POST bodies without injecting the private server bearer", async () => {
    const calls: Array<{ input: string; init?: RequestInit; body: string }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_VOICE_WS_BEARER_TOKEN = "server-secret";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          input: String(input),
          init,
          body: String(init?.body ?? ""),
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 201,
        });
      }) as typeof fetch;

      const body = JSON.stringify({
        title: "Bio PDF",
        file_name: "Lecture 9.pdf",
        content_type: "application/pdf",
        file_base64: "JVBERi0xLjc=",
      });
      const request = new Request("http://localhost:3000/api/viva-library/study-sets/files", {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      }) as unknown as NextRequest;
      Object.defineProperty(request, "nextUrl", {
        value: new URL("http://localhost:3000/api/viva-library/study-sets/files"),
      });

      const response = await POST(request, {
        params: Promise.resolve({ path: ["study-sets", "files"] }),
      });

      expect(response.status).toBe(201);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe("http://agent.test/study-sets/files");
      expect(calls[0]?.body).toBe(body);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("origin")).toBe("http://localhost:3000");
      expect(headers.get("authorization")).toBe(null);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_VOICE_WS_BEARER_TOKEN", originalBearer);
    }
  });

  test("converts agent fetch failures to sanitized uncached proxy errors", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async () => {
        throw new Error(
          "connection refused for viva-fixture-legacy-rest-bearer at http://agent.test",
        );
      }) as typeof fetch;

      const request = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": "viva1.control-token",
        }),
        method: "DELETE",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/biology-midterm?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await DELETE(request, {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({ error: "viva_library_proxy_unavailable" });
      expect(JSON.stringify(body)).not.toContain("viva-fixture-legacy-rest-bearer");
      expect(JSON.stringify(body)).not.toContain("agent.test");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("bounds file upload proxy work with a sanitized pre-loop terminal reason", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_LIBRARY_PROXY_TIMEOUT_MS = "5";
      let observedSignal: AbortSignal | undefined;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        if (!observedSignal) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
            status: 201,
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => {
            reject(new Error("raw file_base64 JVBERi0xLjc= should stay private"));
          });
        });
      }) as typeof fetch;

      const request = new Request("http://localhost:3000/api/viva-library/study-sets/files", {
        body: JSON.stringify({
          content_type: "application/pdf",
          file_base64: "JVBERi0xLjc=",
          file_name: "Lecture 9.pdf",
          title: "Bio PDF",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }) as unknown as NextRequest;
      Object.defineProperty(request, "nextUrl", {
        value: new URL("http://localhost:3000/api/viva-library/study-sets/files"),
      });

      const response = await POST(request, {
        params: Promise.resolve({ path: ["study-sets", "files"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(504);
      expect(observedSignal?.aborted).toBe(true);
      expect(body).toEqual({
        error: "viva_library_pre_loop_timeout",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_upload_unavailable",
      });
      expect(JSON.stringify(body)).not.toContain("JVBERi0xLjc=");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_LIBRARY_PROXY_TIMEOUT_MS", originalProxyTimeout);
    }
  });

  test("keeps the upload proxy timeout active while reading the upstream body", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_LIBRARY_PROXY_TIMEOUT_MS = "5";
      let observedSignal: AbortSignal | undefined;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return hangingJsonResponse(
          observedSignal,
          "raw stalled upload body with file_base64 JVBERi0xLjc=",
          201,
        );
      }) as typeof fetch;

      const request = fileUploadRequest();
      const response = await Promise.race([
        POST(request, {
          params: Promise.resolve({ path: ["study-sets", "files"] }),
        }),
        rejectAfter(100, "library upload body read did not time out"),
      ]);
      const body = await response.json();

      expect(response.status).toBe(504);
      expect(observedSignal?.aborted).toBe(true);
      expect(body).toEqual({
        error: "viva_library_pre_loop_timeout",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_upload_unavailable",
      });
      expect(JSON.stringify(body)).not.toContain("JVBERi0xLjc=");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_LIBRARY_PROXY_TIMEOUT_MS", originalProxyTimeout);
    }
  });

  test("times out stalled upload request bodies before contacting the agent", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_LIBRARY_PROXY_TIMEOUT_MS = "5";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 201,
        });
      }) as typeof fetch;

      const response = await Promise.race([
        POST(stalledUploadRequest(), {
          params: Promise.resolve({ path: ["study-sets", "files"] }),
        }),
        rejectAfter(100, "library upload request body read did not time out"),
      ]);
      const body = await response.json();

      expect(response.status).toBe(504);
      expect(calls).toEqual([]);
      expect(body).toEqual({
        error: "viva_library_pre_loop_timeout",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_upload_unavailable",
      });
      expect(JSON.stringify(body)).not.toContain("JVBERi0xLjc=");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_LIBRARY_PROXY_TIMEOUT_MS", originalProxyTimeout);
    }
  });

  test("uses the contract upload timeout when no proxy override is configured", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const scheduledTimeouts: number[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      delete process.env.VIVA_LIBRARY_PROXY_TIMEOUT_MS;
      globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        scheduledTimeouts.push(Number(timeout));
        return originalSetTimeout(handler, 0, ...args);
      }) as typeof setTimeout;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("raw file_base64 JVBERi0xLjc= should stay private")),
            { once: true },
          );
        });
      }) as typeof fetch;

      const response = await POST(fileUploadRequest(), {
        params: Promise.resolve({ path: ["study-sets", "files"] }),
      });
      const body = await response.json();

      expect(scheduledTimeouts).toContain(15_000);
      expect(response.status).toBe(504);
      expect(body.terminal_reason).toBe("pre_loop_upload_unavailable");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_LIBRARY_PROXY_TIMEOUT_MS", originalProxyTimeout);
    }
  });

  test("caps proxy timeout overrides to route contract maximums", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const scheduledTimeouts: number[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_LIBRARY_PROXY_TIMEOUT_MS = "60000";
      globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        scheduledTimeouts.push(Number(timeout));
        return originalSetTimeout(handler, 0, ...args);
      }) as typeof setTimeout;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("raw upstream timeout with viva-fixture-legacy-rest-bearer")),
            { once: true },
          );
        });
      }) as typeof fetch;

      const uploadResponse = await POST(fileUploadRequest(), {
        params: Promise.resolve({ path: ["study-sets", "files"] }),
      });
      const libraryRequest = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;
      const libraryResponse = await GET(libraryRequest, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });

      expect(scheduledTimeouts).toContain(15_000);
      expect(scheduledTimeouts).toContain(30_000);
      expect(uploadResponse.status).toBe(504);
      expect(libraryResponse.status).toBe(504);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_LIBRARY_PROXY_TIMEOUT_MS", originalProxyTimeout);
    }
  });

  test("sanitizes upstream HTTP failures with route-specific pre-loop terminal reasons", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      const rawFailure = { error: "raw upstream failure with file_base64 JVBERi0xLjc=" };
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(rawFailure), {
          headers: { "content-type": "application/json" },
          status: 503,
        })) as typeof fetch;

      const uploadResponse = await POST(fileUploadRequest(), {
        params: Promise.resolve({ path: ["study-sets", "files"] }),
      });
      const uploadBody = await uploadResponse.json();
      const libraryRequest = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
        ),
      } as unknown as NextRequest;
      const libraryResponse = await GET(libraryRequest, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const libraryBody = await libraryResponse.json();

      expect(uploadResponse.status).toBe(502);
      expect(uploadBody).toEqual({
        error: "viva_library_pre_loop_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_upload_unavailable",
      });
      expect(libraryResponse.status).toBe(502);
      expect(libraryBody).toEqual({
        error: "viva_library_pre_loop_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_ingestion_unavailable",
      });
      expect(JSON.stringify(uploadBody)).not.toContain("JVBERi0xLjc=");
      expect(JSON.stringify(libraryBody)).not.toContain("JVBERi0xLjc=");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("preserves upstream upload validation failures without pre-loop outage labels", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      const validationFailure = {
        error: "file_ingestion_failed",
        message: "invalid file_base64: invalid padding",
      };
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(validationFailure), {
          headers: { "content-type": "application/json" },
          status: 400,
        })) as typeof fetch;

      const response = await POST(fileUploadRequest(), {
        params: Promise.resolve({ path: ["study-sets", "files"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual(validationFailure);
      expect(JSON.stringify(body)).not.toContain("pre_loop_upload_unavailable");
      expect(JSON.stringify(body)).not.toContain("JVBERi0xLjc=");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
    }
  });

  test("cancels failed pre-loop upstream bodies before returning sanitized unavailable", async () => {
    let cancelled = false;
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 503,
          },
        )) as typeof fetch;

      const response = await POST(fileUploadRequest(), {
        params: Promise.resolve({ path: ["study-sets", "files"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(cancelled).toBe(true);
      expect(body).toEqual({
        error: "viva_library_pre_loop_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_upload_unavailable",
      });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
    }
  });

  test("preserves upstream control-route failures without pre-loop ingestion labels", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE") {
          return new Response(JSON.stringify({ error: "study_set_not_found" }), {
            headers: { "content-type": "application/json" },
            status: 404,
          });
        }
        if (url.endsWith("/study-sets/export?user_id=user-1")) {
          return new Response(JSON.stringify({ error: "control_token_required" }), {
            headers: { "content-type": "application/json" },
            status: 403,
          });
        }
        return new Response(JSON.stringify({ error: "unexpected_route" }), {
          headers: { "content-type": "application/json" },
          status: 500,
        });
      }) as typeof fetch;

      const exportRequest = {
        headers: new Headers({ origin: LIBRARY_CANONICAL_ORIGIN }),
        method: "GET",
        nextUrl: new URL("http://localhost:3000/api/viva-library/study-sets/export?user_id=user-1"),
      } as unknown as NextRequest;
      const exportResponse = await GET(exportRequest, {
        params: Promise.resolve({ path: ["study-sets", "export"] }),
      });
      const exportBody = await exportResponse.json();

      const deleteRequest = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": "viva1.control-token",
        }),
        method: "DELETE",
        nextUrl: new URL(
          "http://localhost:3000/api/viva-library/study-sets/biology-midterm?user_id=user-1",
        ),
      } as unknown as NextRequest;
      const deleteResponse = await DELETE(deleteRequest, {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });
      const deleteBody = await deleteResponse.json();

      expect(exportResponse.status).toBe(403);
      expect(exportBody).toEqual({ error: "viva_library_control_scope_not_allowed" });
      expect(JSON.stringify(exportBody)).not.toContain("pre_loop_ingestion_unavailable");
      expect(deleteResponse.status).toBe(404);
      expect(deleteBody).toEqual({ error: "study_set_not_found" });
      expect(JSON.stringify(deleteBody)).not.toContain("pre_loop_ingestion_unavailable");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });
});

describe("Viva library canonical origin and scoped service credential", () => {
  const CANONICAL = "http://localhost:3000";
  const SCOPED_LIBRARY_READ_BEARER = "viva-fixture-agent-library-read-bearer";
  const SCOPED_LIBRARY_DELETE_BEARER = "viva-fixture-agent-library-delete-bearer";
  const LEGACY_REST_BEARER = "viva-fixture-legacy-rest-bearer";
  const BOOTSTRAP_SECRET = "viva-fixture-bootstrap-signing-key-01";
  const trackedEnv = [
    "VIVA_AGENT_HTTP_URL",
    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
    "VIVA_AGENT_REST_BEARER_TOKEN",
    "VIVA_ALLOW_LEGACY_AGENT_REST_BEARER",
    "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
    "VIVA_SESSION_ALLOWED_USER_IDS",
    "VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET",
    "VIVA_WEB_CANONICAL_ORIGIN",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  function applyEnv() {
    for (const name of trackedEnv) savedEnv.set(name, process.env[name]);
    process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
    process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN = SCOPED_LIBRARY_READ_BEARER;
    process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN = SCOPED_LIBRARY_DELETE_BEARER;
    process.env.VIVA_AGENT_REST_BEARER_TOKEN = LEGACY_REST_BEARER;
    delete process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER;
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
    process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = BOOTSTRAP_SECRET;
    process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL;
  }

  function restoreAll() {
    globalThis.fetch = originalFetch;
    for (const [name, value] of savedEnv) restoreEnv(name, value);
    savedEnv.clear();
  }

  function snapshotRequest(): NextRequest {
    return {
      headers: new Headers(),
      method: "GET",
      nextUrl: new URL(`${CANONICAL}/api/viva-library/study-sets/library?user_id=user-1`),
    } as unknown as NextRequest;
  }

  function deleteRequest(headers: Record<string, string>): NextRequest {
    return {
      headers: new Headers(headers),
      method: "DELETE",
      nextUrl: new URL(`${CANONICAL}/api/viva-library/study-sets/biology-midterm?user_id=user-1`),
    } as unknown as NextRequest;
  }

  function signedStudySetDeleteToken(): string {
    const token = signVivaLibraryControlToken({
      scope: "study_set_delete",
      studySetId: "biology-midterm",
      userId: "user-1",
    });
    if (!token) throw new Error("fixture must sign a study-set delete control capability");
    return token;
  }

  test("canonical origin config is mandatory before the snapshot or destructive delete reaches the agent", async () => {
    const calls: string[] = [];
    try {
      applyEnv();
      delete process.env.VIVA_WEB_CANONICAL_ORIGIN;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const snapshot = await GET(snapshotRequest(), {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const snapshotBody = await snapshot.json();
      const removal = await DELETE(
        deleteRequest({
          origin: CANONICAL,
          "x-viva-library-control-token": "viva-control1.unverifiable.capability",
        }),
        { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
      );
      const removalBody = await removal.json();

      expect(snapshot.status).toBe(503);
      expect(snapshotBody).toEqual({
        error: "viva_library_auth_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_ingestion_unavailable",
      });
      expect(removal.status).toBe(503);
      expect(removalBody).toEqual({ error: "viva_library_control_unavailable" });
      expect(snapshot.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);
    } finally {
      restoreAll();
    }
  });

  test("canonical origin is the only outbound origin authority for proxied library calls", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    try {
      applyEnv();
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init });
        return new Response(JSON.stringify({ study_sets: [], user_id: "user-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const request = {
        headers: new Headers({
          forwarded: "for=203.0.113.7;host=evil.example;proto=http",
          host: "evil.example",
          origin: "https://evil.example",
          "x-forwarded-proto": "https",
        }),
        method: "GET",
        nextUrl: new URL(`${CANONICAL}/api/viva-library/study-sets/library?user_id=user-1`),
      } as unknown as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });

      expect(response.status).toBe(200);
      expect(new Headers(calls[0]?.init?.headers).get("origin")).toBe(CANONICAL);
    } finally {
      restoreAll();
    }
  });

  test("destructive deletes require an exact canonical origin and a same-origin fetch site", async () => {
    const calls: string[] = [];
    try {
      applyEnv();
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const token = signedStudySetDeleteToken();

      const missingOrigin = await DELETE(deleteRequest({ "x-viva-library-control-token": token }), {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });
      const foreignOrigin = await DELETE(
        deleteRequest({ origin: "https://evil.example", "x-viva-library-control-token": token }),
        { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
      );
      const crossSite = await DELETE(
        deleteRequest({
          origin: CANONICAL,
          "sec-fetch-site": "cross-site",
          "x-viva-library-control-token": token,
        }),
        { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
      );
      const sameOrigin = await DELETE(
        deleteRequest({
          origin: CANONICAL,
          "sec-fetch-site": "same-origin",
          "x-viva-library-control-token": token,
        }),
        { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
      );

      const bodies = await Promise.all([
        missingOrigin.json(),
        foreignOrigin.json(),
        crossSite.json(),
      ]);

      expect([missingOrigin.status, foreignOrigin.status, crossSite.status]).toEqual([
        403, 403, 403,
      ]);
      expect(bodies).toEqual([
        { error: "viva_library_control_capability_required" },
        { error: "viva_library_control_capability_required" },
        { error: "viva_library_control_capability_required" },
      ]);
      expect(sameOrigin.status).toBe(200);
      expect(calls).toHaveLength(1);
    } finally {
      restoreAll();
    }
  });

  test("scoped service credential separates library read from library delete", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    try {
      applyEnv();
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init });
        return new Response(JSON.stringify({ study_sets: [], user_id: "user-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const snapshot = await GET(snapshotRequest(), {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const removal = await DELETE(
        deleteRequest({
          origin: CANONICAL,
          "x-viva-library-control-token": signedStudySetDeleteToken(),
        }),
        { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
      );

      expect(snapshot.status).toBe(200);
      expect(removal.status).toBe(200);
      expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
        `Bearer ${SCOPED_LIBRARY_READ_BEARER}`,
      );
      expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe(
        `Bearer ${SCOPED_LIBRARY_DELETE_BEARER}`,
      );
    } finally {
      restoreAll();
    }
  });

  test("public library routes fail closed when their exact scoped service credential is missing", async () => {
    const calls: string[] = [];
    try {
      applyEnv();
      delete process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN;
      delete process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN;
      process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER = "1";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const snapshot = await GET(snapshotRequest(), {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const snapshotBody = await snapshot.json();
      const removal = await DELETE(
        deleteRequest({
          origin: CANONICAL,
          "x-viva-library-control-token": signedStudySetDeleteToken(),
        }),
        { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
      );
      const removalBody = await removal.json();

      expect(snapshot.status).toBe(503);
      expect(snapshotBody).toEqual({
        error: "viva_library_auth_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_ingestion_unavailable",
      });
      expect(removal.status).toBe(503);
      expect(removalBody).toEqual({ error: "viva_library_control_unavailable" });
      expect(calls).toEqual([]);
    } finally {
      restoreAll();
    }
  });

  test("legacy REST bearer cannot authorize public library traffic and stays loopback-only", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    try {
      applyEnv();
      delete process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN;
      process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER = "1";
      process.env.VIVA_AGENT_HTTP_URL = "http://127.0.0.1:4318";
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init });
        return new Response(JSON.stringify({ study_sets: [], user_id: "user-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      const loopback = await GET(snapshotRequest(), {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });

      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      const publicCall = await GET(snapshotRequest(), {
        params: Promise.resolve({ path: ["study-sets", "library"] }),
      });
      const publicBody = await publicCall.json();

      expect(loopback.status).toBe(200);
      expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
        `Bearer ${LEGACY_REST_BEARER}`,
      );
      expect(publicCall.status).toBe(503);
      expect(publicBody).toEqual({
        error: "viva_library_auth_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_ingestion_unavailable",
      });
      expect(calls).toHaveLength(1);
    } finally {
      restoreAll();
    }
  });

  test("canonical origin rejects control capabilities minted for another origin or another scope", async () => {
    const calls: string[] = [];
    try {
      applyEnv();
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;

      process.env.VIVA_WEB_CANONICAL_ORIGIN = "https://other.example";
      const foreignOriginToken = signedStudySetDeleteToken();
      process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL;
      const sessionScopedToken = signVivaLibraryControlToken({
        scope: "session_history_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
        voiceSessionId: "voice-session-1",
      });
      if (!sessionScopedToken) throw new Error("fixture must sign a session-scoped capability");

      const foreignOrigin = await DELETE(
        deleteRequest({
          origin: CANONICAL,
          "x-viva-library-control-token": foreignOriginToken,
        }),
        { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
      );
      const wrongScope = await DELETE(
        deleteRequest({
          origin: CANONICAL,
          "x-viva-library-control-token": sessionScopedToken,
        }),
        { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
      );

      expect([foreignOrigin.status, wrongScope.status]).toEqual([403, 403]);
      expect(await foreignOrigin.json()).toEqual({
        error: "viva_library_control_capability_required",
      });
      expect(await wrongScope.json()).toEqual({
        error: "viva_library_control_capability_required",
      });
      expect(calls).toEqual([]);
    } finally {
      restoreAll();
    }
  });
});

function fileUploadRequest(): NextRequest {
  const request = new Request("http://localhost:3000/api/viva-library/study-sets/files", {
    body: JSON.stringify({
      content_type: "application/pdf",
      file_base64: "JVBERi0xLjc=",
      file_name: "Lecture 9.pdf",
      title: "Bio PDF",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }) as unknown as NextRequest;
  Object.defineProperty(request, "nextUrl", {
    value: new URL("http://localhost:3000/api/viva-library/study-sets/files"),
  });
  return request;
}

function stalledUploadRequest(): NextRequest {
  const request = new Request("http://localhost:3000/api/viva-library/study-sets/files", {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"title":"Bio PDF","stalled":"'));
      },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    duplex: "half",
  } as RequestInit & { duplex: "half" }) as unknown as NextRequest;
  Object.defineProperty(request, "nextUrl", {
    value: new URL("http://localhost:3000/api/viva-library/study-sets/files"),
  });
  return request;
}

function hangingJsonResponse(
  signal: AbortSignal | undefined,
  abortMessage: string,
  status: number,
): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => {
            controller.error(new Error(abortMessage));
          },
          { once: true },
        );
      },
    }),
    {
      headers: { "content-type": "application/json" },
      status,
    },
  );
}

async function rejectAfter(ms: number, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  throw new Error(message);
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
