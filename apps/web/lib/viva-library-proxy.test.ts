import { describe, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { GET, POST } from "../app/api/viva-library/[[...path]]/route";

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.VIVA_AGENT_HTTP_URL;
const originalBearer = process.env.VIVA_VOICE_WS_BEARER_TOKEN;

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
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_VOICE_WS_BEARER_TOKEN", originalBearer);
    }
  });

  test("strips start and resume session tokens from browser library snapshots", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            user_id: "user-1",
            study_sets: [
              {
                id: "biology-midterm",
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
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
