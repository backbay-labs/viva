import { describe, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { GET, POST } from "../app/api/viva-library/[[...path]]/route";

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.VIVA_AGENT_HTTP_URL;
const originalPublicAgentUrl = process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL;
const originalBearer = process.env.VIVA_VOICE_WS_BEARER_TOKEN;
const originalRestBearer = process.env.VIVA_AGENT_REST_BEARER_TOKEN;
const originalAllowedUsers = process.env.VIVA_SESSION_ALLOWED_USER_IDS;
const originalAllowedStudySets = process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS;

describe("Viva library proxy", () => {
  test("forwards caller control tokens without injecting the private server bearer", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_VOICE_WS_BEARER_TOKEN = "server-secret";
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
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

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe("http://agent.test/study-sets/export?user_id=user-1");
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("x-viva-library-control-token")).toBe("viva1.control-token");
      expect(headers.get("origin")).toBe("http://localhost:3000");
      expect(headers.get("authorization")).toBe(null);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_VOICE_WS_BEARER_TOKEN", originalBearer);
    }
  });

  test("strips start and resume session tokens from browser library snapshots", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
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
      expect(JSON.stringify(body)).not.toContain("session_token");
      expect(JSON.stringify(body)).not.toContain("viva1.redacted");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("filters bearer-backed browser library snapshots to the requested user and allowed study sets", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
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
      expect(JSON.stringify(body)).not.toContain("session_token");
      expect(body.privacy.export.control_token).toBe("viva1.export-control");
      expect(body.study_sets[0].actions.delete.control_token).toBe("viva1.delete-control");
      expect(JSON.stringify(body)).not.toContain("session_token");
      expect(JSON.stringify(body)).not.toContain("viva1.disallowed");
      expect(JSON.stringify(body)).not.toContain("viva1.allowed-session-token");
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
    }
  });

  test("does not let caller Authorization bypass bearer-backed browser snapshot filtering", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_AGENT_REST_BEARER_TOKEN = "server-rest-bearer";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
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
      expect(JSON.stringify(body)).not.toContain("session_token");
      expect(body.privacy.export.control_token).toBe("viva1.export-control");
      expect(body.study_sets[0].actions.delete.control_token).toBe("viva1.delete-control");
      expect(JSON.stringify(body)).not.toContain("session_token");
      expect(JSON.stringify(body)).not.toContain("viva1.disallowed");
      expect(JSON.stringify(body)).not.toContain("viva1.allowed-session-token");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_AGENT_REST_BEARER_TOKEN", originalRestBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
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
      expect(JSON.stringify(body)).not.toContain("session_token");
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
      globalThis.fetch = (async () => {
        throw new Error("connection refused for server-rest-bearer at http://agent.test");
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

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({ error: "viva_library_proxy_unavailable" });
      expect(JSON.stringify(body)).not.toContain("server-rest-bearer");
      expect(JSON.stringify(body)).not.toContain("agent.test");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
    }
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
