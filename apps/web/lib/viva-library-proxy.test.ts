import { describe, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { DELETE, GET, POST } from "../app/api/viva-library/[[...path]]/route";
import { signVivaLibraryControlToken } from "../app/api/viva-session/shared";

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
        headers: new Headers({ "x-viva-library-control-token": "viva1.control-token" }),
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
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
        headers: new Headers(),
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = "redacted-bootstrap-signing-secret";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const controlToken = signVivaLibraryControlToken({
        origin: "http://localhost:3000",
        scope: "study_set_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
      });
      if (!controlToken) throw new Error("test fixture must sign study-set delete control token");

      const request = {
        headers: new Headers({ "x-viva-library-control-token": controlToken }),
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
      expect(headers.get("authorization")).toBe("Bearer server-rest-bearer");
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = "redacted-bootstrap-signing-secret";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const controlToken = signVivaLibraryControlToken({
        origin: "http://localhost:3000",
        scope: "session_history_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
        voiceSessionId: "voice-session-1",
      });
      if (!controlToken) throw new Error("test fixture must sign session delete control token");

      const request = {
        headers: new Headers({ "x-viva-library-control-token": controlToken }),
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
      expect(headers.get("authorization")).toBe("Bearer server-rest-bearer");
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = "redacted-bootstrap-signing-secret";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const controlToken = signVivaLibraryControlToken({
        origin: "http://localhost:3000",
        scope: "session_history_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
        voiceSessionId: "different-session",
      });
      if (!controlToken) throw new Error("test fixture must sign mismatched control token");

      const request = {
        headers: new Headers({ "x-viva-library-control-token": controlToken }),
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
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
        headers: new Headers(),
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = "redacted-bootstrap-signing-secret";
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
        headers: new Headers(),
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = "redacted-bootstrap-signing-secret";
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
        headers: new Headers({ authorization: "Bearer viva1.browser-session-token" }),
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
      expect(headers.get("authorization")).toBe("Bearer server-rest-bearer");
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
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
        headers: new Headers(),
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
      expect(headers.get("authorization")).toBe("Bearer server-rest-bearer");
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
        headers: new Headers({ "x-viva-library-control-token": "viva1.control-token" }),
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
        headers: new Headers({ "x-viva-library-control-token": "viva1.control-token" }),
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            authorization: "Bearer server-rest-bearer",
            detail: "agent failure at http://agent.test/study-sets/library",
            session_token: "viva1.raw-upstream-token",
          }),
          { headers: { "content-type": "application/json" }, status: 503 },
        )) as typeof fetch;

      const request = {
        headers: new Headers(),
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
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({ error: "viva_library_proxy_unavailable" });
      expect(JSON.stringify(body)).not.toContain("server-rest-bearer");
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

  test("fails browser library snapshots closed when the server REST bearer is missing", async () => {
    const calls: string[] = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      delete process.env.VIVA_AGENT_REST_BEARER_TOKEN;
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
        headers: new Headers(),
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
      expect(body).toEqual({ error: "viva_library_auth_unavailable" });
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
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
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
        headers: new Headers(),
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
        throw new Error("connection refused for server-rest-bearer at http://agent.test");
      }) as typeof fetch;

      const request = {
        headers: new Headers({ "x-viva-library-control-token": "viva1.control-token" }),
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
      expect(JSON.stringify(body)).not.toContain("server-rest-bearer");
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

  test("sanitizes upstream HTTP failures with route-specific pre-loop terminal reasons", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
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
        headers: new Headers(),
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
