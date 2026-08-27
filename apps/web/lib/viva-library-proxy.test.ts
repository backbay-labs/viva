import * as bunTest from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { DELETE, GET, POST } from "../app/api/viva-library/[[...path]]/route";
import {
  resetVivaSessionSecurityStoreForTests,
  type SessionSecurityStore,
  signVivaLibraryControlToken,
  vivaSessionSecurityStore,
  WEB_API_BODY_LIMITS,
} from "../app/api/viva-session/shared";

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

  /**
   * Task 7 (`WEBAPI-009`) replaced this fixture's original subject. It used to assert that a DELETE
   * carrying an arbitrary caller-supplied `x-viva-library-control-token` was RELAYED upstream with
   * the header attached and no `authorization` at all — which is exactly the bypass the destructive
   * sequence exists to close, because `viva1.control-token` is not a capability this deployment
   * could have minted (`viva-control1.` is the only prefix it signs). The private WS bearer
   * non-injection it really guarded is preserved and strengthened below: it is now asserted on both
   * the refused path and the accepted path, so it is never vacuous.
   */
  test("never injects the private server bearer on a destructive delete, refused or accepted", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_VOICE_WS_BEARER_TOKEN = "server-secret";
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

      const refused = await DELETE(destructiveDelete("viva1.control-token"), {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });
      const refusedBody = await refused.json();

      // A caller-supplied string that this deployment never signed buys no authority at all.
      expect(refused.status).toBe(403);
      expect(refusedBody).toEqual({ error: "viva_library_control_capability_required" });
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);

      const controlToken = signVivaLibraryControlToken({
        scope: "study_set_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
      });
      if (!controlToken) throw new Error("test fixture must sign study-set delete control token");
      const accepted = await DELETE(destructiveDelete(controlToken), {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });

      expect(accepted.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBe("http://agent.test/study-sets/biology-midterm?user_id=user-1");
      const headers = new Headers(calls[0]?.init?.headers);
      // The scoped delete credential, never the broad private WS bearer, and never the browser's
      // own capability.
      expect(headers.get("authorization")).toBe(`Bearer ${LIBRARY_DELETE_BEARER}`);
      expect(headers.get("authorization")).not.toContain("server-secret");
      expect(headers.get("x-viva-library-control-token")).toBe(null);
      expect(headers.get("origin")).toBe("http://localhost:3000");
      expect(accepted.headers.get("cache-control")).toBe("no-store");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("VIVA_AGENT_HTTP_URL", originalAgentUrl);
      restoreEnv("VIVA_VOICE_WS_BEARER_TOKEN", originalBearer);
      restoreEnv("VIVA_SESSION_ALLOWED_USER_IDS", originalAllowedUsers);
      restoreEnv("VIVA_SESSION_ALLOWED_STUDY_SET_IDS", originalAllowedStudySets);
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
    }
  });

  function destructiveDelete(controlToken: string): NextRequest {
    return {
      headers: new Headers({
        origin: LIBRARY_CANONICAL_ORIGIN,
        "x-viva-library-control-token": controlToken,
      }),
      method: "DELETE",
      nextUrl: new URL(
        "http://localhost:3000/api/viva-library/study-sets/biology-midterm?user_id=user-1",
      ),
    } as unknown as NextRequest;
  }

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
      // LIBRARY_READ_BEARER is both the credential this path sends and the credential the
      // upstream body echoes back, so it is the string that proves the sanitizer held.
      expect(JSON.stringify(body)).not.toContain(LIBRARY_READ_BEARER);
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
      // Same leak source as the snapshot-error case above: the scoped read bearer this path
      // actually sends, echoed back by the upstream body.
      expect(JSON.stringify(body)).not.toContain(LIBRARY_READ_BEARER);
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
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
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
      // WEBAPI-014: the forwarded body is now REBUILT from the accepted fields, so it carries the
      // same values under the same exact key set, in the contract's own order rather than the
      // caller's. Byte-identical passthrough is exactly what field-by-field reconstruction ends.
      expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(JSON.parse(body));
      expect(Object.keys(JSON.parse(calls[0]?.body ?? "{}")).sort()).toEqual(
        Object.keys(JSON.parse(body)).sort(),
      );
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

  // Subject: a thrown fetch becomes a sanitized 502 that leaks neither the credential nor the
  // upstream host. The DELETE is only the vehicle, so it must carry a capability the deployment
  // really signed — an unmintable prefix would 403 before fetch and make the test vacuous.
  test("converts agent fetch failures to sanitized uncached proxy errors", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
      let fetchAttempts = 0;
      globalThis.fetch = (async () => {
        fetchAttempts += 1;
        throw new Error(
          "connection refused for viva-fixture-legacy-rest-bearer at http://agent.test",
        );
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
      const body = await response.json();

      expect(fetchAttempts).toBe(1);
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
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
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
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
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

  // Subject: an upstream control-route status is preserved rather than relabelled with an ingestion
  // terminal reason. As above, the DELETE must carry a really-signed capability or it would 403
  // before reaching upstream and prove nothing about relabelling.
  test("preserves upstream control-route failures without pre-loop ingestion labels", async () => {
    try {
      process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
      process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
      process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
      process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
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

      const controlToken = signVivaLibraryControlToken({
        scope: "study_set_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
      });
      if (!controlToken) throw new Error("test fixture must sign study-set delete control token");
      const deleteRequest = {
        headers: new Headers({
          origin: LIBRARY_CANONICAL_ORIGIN,
          "x-viva-library-control-token": controlToken,
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
      restoreEnv("VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET", originalBootstrapSecret);
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

  test("shared security store is mandatory before a public destructive delete reaches the agent", async () => {
    const calls: string[] = [];
    const savedNodeEnv = process.env.NODE_ENV;
    const savedStoreUrl = process.env.VIVA_SESSION_SECURITY_STORE_REST_URL;
    const savedStoreToken = process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN;
    try {
      applyEnv();
      process.env.VIVA_WEB_CANONICAL_ORIGIN = "https://web.example";
      process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
      restoreEnv("NODE_ENV", "production");
      delete process.env.VIVA_SESSION_SECURITY_STORE_REST_URL;
      delete process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const token = signVivaLibraryControlToken({
        scope: "study_set_delete",
        studySetId: "biology-midterm",
        userId: "user-1",
      });
      if (!token) throw new Error("fixture must sign a study-set delete control capability");

      const request = {
        headers: new Headers({
          origin: "https://web.example",
          "sec-fetch-site": "same-origin",
          "x-viva-library-control-token": token,
        }),
        method: "DELETE",
        nextUrl: new URL(
          "https://web.example/api/viva-library/study-sets/biology-midterm?user_id=user-1",
        ),
      } as unknown as NextRequest;

      const response = await DELETE(request, {
        params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({
        error: "viva_library_control_unavailable",
        failure_class: "pre_loop_unavailable",
        stage: "pre_loop",
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(calls).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("VIVA_SESSION_SECURITY_STORE");
    } finally {
      restoreAll();
      restoreEnv("NODE_ENV", savedNodeEnv);
      restoreEnv("VIVA_SESSION_SECURITY_STORE_REST_URL", savedStoreUrl);
      restoreEnv("VIVA_SESSION_SECURITY_STORE_REST_TOKEN", savedStoreToken);
    }
  });
});

describe("Viva library body byte cap and ingestion request shapes", () => {
  const CANONICAL = "http://localhost:3000";
  const trackedEnv = [
    "VIVA_AGENT_HTTP_URL",
    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
    "VIVA_LIBRARY_PROXY_TIMEOUT_MS",
    "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
    "VIVA_SESSION_ALLOWED_USER_IDS",
    "VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET",
    "VIVA_WEB_CANONICAL_ORIGIN",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of trackedEnv) savedEnv.set(name, process.env[name]);
    process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
    process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN = LIBRARY_READ_BEARER;
    process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN = LIBRARY_DELETE_BEARER;
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
    process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
    process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of savedEnv) restoreEnv(name, value);
    savedEnv.clear();
  });

  test("bounded reader budgets pin the recorded per-route byte caps", () => {
    expect(WEB_API_BODY_LIMITS).toEqual({
      libraryRequest: 2 * 1024 * 1024,
      libraryResponse: 2 * 1024 * 1024,
      projectionResponse: 1 * 1024 * 1024,
      securityStoreResponse: 16 * 1024,
      sessionRequest: 16 * 1024,
      sessionUpstreamResponse: 1 * 1024 * 1024,
    });
  });

  test("body byte cap accepts a library request at exactly 2 MiB and rejects one byte more", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    const atLimit = await POST(pasteRequestAtBytes(2 * 1024 * 1024, [65_536, 1, 4095]), {
      params: Promise.resolve({ path: ["study-sets", "paste"] }),
    });
    const overLimit = await POST(pasteRequestAtBytes(2 * 1024 * 1024 + 1, [65_536, 1, 4095]), {
      params: Promise.resolve({ path: ["study-sets", "paste"] }),
    });
    const overBody = await overLimit.json();

    expect(atLimit.status).toBe(201);
    expect(overLimit.status).toBe(413);
    expect(overBody).toEqual({
      error: "viva_request_body_too_large",
      failure_class: "pre_loop_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_ingestion_unavailable",
    });
    expect(calls).toEqual(["http://agent.test/study-sets/paste"]);
  });

  test("multibyte body is measured in bytes over uneven chunks, not string length", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    const request = pasteRequestAtBytes(2 * 1024 * 1024 + 4, [7, 65_536, 13], "\u{1F600}");
    const response = await POST(request, {
      params: Promise.resolve({ path: ["study-sets", "paste"] }),
    });

    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  test("oversized upstream response cancels the stream and returns a sanitized 502", async () => {
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        oversizedLibraryStream(2 * 1024 * 1024 + 1, () => (cancelled = true)),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      )) as typeof fetch;

    const response = await GET(librarySnapshotRequest(), {
      params: Promise.resolve({ path: ["study-sets", "library"] }),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: "viva_upstream_response_too_large",
      failure_class: "pre_loop_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_ingestion_unavailable",
    });
    expect(cancelled).toBe(true);
  });

  test("four concurrent hostile streams settle under the route deadline without an upstream call", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    const startedAt = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        POST(pasteRequestAtBytes(2 * 1024 * 1024 + 1, [1, 65_536, 3]), {
          params: Promise.resolve({ path: ["study-sets", "paste"] }),
        }),
      ),
    );
    const elapsed = Date.now() - startedAt;

    expect(responses.map((response) => response.status)).toEqual([413, 413, 413, 413]);
    expect(calls).toEqual([]);
    expect(elapsed).toBeLessThan(15_000);
  });

  test("byte-limit cancellation retains no chunks across the next request", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    const rejected = await POST(pasteRequestAtBytes(2 * 1024 * 1024 + 1, [65_536]), {
      params: Promise.resolve({ path: ["study-sets", "paste"] }),
    });
    const accepted = await POST(ingestionRequest("study-sets/paste", validPasteBody()), {
      params: Promise.resolve({ path: ["study-sets", "paste"] }),
    });

    expect(rejected.status).toBe(413);
    expect(accepted.status).toBe(201);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual(validPasteBody());
    expect((bodies[0] ?? "").length).toBeLessThan(1024);
  });

  test("ingestion requests accept exactly their contract fields and forward a reconstructed body", async () => {
    const sent: Array<{ body: string; input: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ body: String(init?.body ?? ""), input: String(input) });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    const cases = [
      {
        accepted: validPasteBody(),
        path: ["study-sets", "paste"],
        route: "study-sets/paste",
      },
      {
        accepted: {
          content_type: "application/pdf",
          course: "Biology 201",
          exam_date: "2026-09-01",
          file_base64: "JVBERi0xLjc=",
          file_name: "Lecture 9.pdf",
          title: "Bio PDF",
        },
        path: ["study-sets", "files"],
        route: "study-sets/files",
      },
      {
        accepted: {
          content_type: "application/pdf",
          file_base64: "JVBERi0xLjc=",
          file_name: "Lecture 9.pdf",
        },
        path: ["study-sets", "biology-midterm", "files", "retry"],
        route: "study-sets/biology-midterm/files/retry",
      },
    ];

    const statuses: number[] = [];
    for (const testCase of cases) {
      const response = await POST(ingestionRequest(testCase.route, testCase.accepted), {
        params: Promise.resolve({ path: testCase.path }),
      });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([201, 201, 201]);
    expect(sent).toHaveLength(3);
    for (const [index, testCase] of cases.entries()) {
      const forwarded = JSON.parse(sent[index]?.body ?? "{}") as Record<string, unknown>;
      expect(forwarded).toEqual(testCase.accepted);
      expect(Object.keys(forwarded).sort()).toEqual(Object.keys(testCase.accepted).sort());
    }
  });

  test("ingestion requests reject missing, duplicate, unknown, and identity fields before upstream", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    const hostileBodies = [
      // missing required
      '{"course":"Biology 201"}',
      '{"title":"Bio"}',
      // duplicate key
      '{"title":"Bio","pasted_text":"a","pasted_text":"b"}',
      // unknown field
      '{"title":"Bio","pasted_text":"a","notes":"x"}',
      // browser-supplied identity fields
      '{"title":"Bio","pasted_text":"a","user_id":"user-1"}',
      '{"title":"Bio","pasted_text":"a","study_set_id":"biology-midterm"}',
      '{"title":"Bio","pasted_text":"a","session_id":"voice-session-1"}',
      // server-owned status / authority fields
      '{"title":"Bio","pasted_text":"a","ingestion_status":"ready"}',
      '{"title":"Bio","pasted_text":"a","server_owned":true}',
      // wrong types
      '{"title":"Bio","pasted_text":123}',
      '{"title":"","pasted_text":"a"}',
      '{"title":"Bio","pasted_text":"a","course":null}',
      // not an object / malformed
      '["title","pasted_text"]',
      "{not json",
    ];

    const observed: Array<{ body: unknown; status: number }> = [];
    for (const raw of hostileBodies) {
      const response = await POST(rawIngestionRequest("study-sets/paste", raw), {
        params: Promise.resolve({ path: ["study-sets", "paste"] }),
      });
      observed.push({ body: await response.json(), status: response.status });
    }

    const expected = {
      body: {
        error: "viva_library_request_invalid",
        failure_class: "access_denied",
        stage: "pre_loop",
      },
      status: 400,
    };
    expect(observed).toEqual(hostileBodies.map(() => expected));
    expect(calls).toEqual([]);
    expect(JSON.stringify(observed)).not.toContain("biology-midterm");
    expect(JSON.stringify(observed)).not.toContain("user-1");
  });

  test("cross-origin ingestion posts are refused with the coarse ingestion body before upstream", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    const refused = [
      await POST(ingestionRequest("study-sets/paste", validPasteBody(), { origin: "" }), {
        params: Promise.resolve({ path: ["study-sets", "paste"] }),
      }),
      await POST(
        ingestionRequest("study-sets/paste", validPasteBody(), { origin: "https://evil.example" }),
        { params: Promise.resolve({ path: ["study-sets", "paste"] }) },
      ),
      await POST(
        ingestionRequest("study-sets/paste", validPasteBody(), {
          "sec-fetch-site": "cross-site",
        }),
        { params: Promise.resolve({ path: ["study-sets", "paste"] }) },
      ),
    ];
    const sameOrigin = await POST(
      ingestionRequest("study-sets/paste", validPasteBody(), { "sec-fetch-site": "same-origin" }),
      { params: Promise.resolve({ path: ["study-sets", "paste"] }) },
    );

    expect(refused.map((response) => response.status)).toEqual([400, 400, 400]);
    for (const response of refused) {
      expect(await response.json()).toEqual({
        error: "viva_library_request_invalid",
        failure_class: "access_denied",
        stage: "pre_loop",
      });
    }
    expect(sameOrigin.status).toBe(201);
    expect(calls).toEqual(["http://agent.test/study-sets/paste"]);
  });

  test("library proxy responses carry route-owned headers and never clone upstream cookie, auth, or cache headers", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: {
          "cache-control": "public, max-age=31536000",
          "content-type": "application/json",
          "set-cookie": "session=upstream-cookie; Path=/",
          "www-authenticate": 'Bearer realm="agent"',
          "x-api-key": "upstream-api-key",
        },
        status: 201,
      })) as typeof fetch;

    const success = await POST(ingestionRequest("study-sets/paste", validPasteBody()), {
      params: Promise.resolve({ path: ["study-sets", "paste"] }),
    });
    const rejected = await POST(rawIngestionRequest("study-sets/paste", "{not json"), {
      params: Promise.resolve({ path: ["study-sets", "paste"] }),
    });

    for (const response of [success, rejected]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("set-cookie")).toBe(null);
      expect(response.headers.get("www-authenticate")).toBe(null);
      expect(response.headers.get("x-api-key")).toBe(null);
      expect(response.headers.get("authorization")).toBe(null);
    }
  });

  function librarySnapshotRequest(): NextRequest {
    return {
      headers: new Headers(),
      method: "GET",
      nextUrl: new URL(`${CANONICAL}/api/viva-library/study-sets/library?user_id=user-1`),
    } as unknown as NextRequest;
  }
});

describe("Viva library proxy credential stripping", () => {
  const CANONICAL = "http://localhost:3000";
  const trackedEnv = [
    "VIVA_AGENT_HTTP_URL",
    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
    "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
    "VIVA_SESSION_ALLOWED_USER_IDS",
    "VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET",
    "VIVA_WEB_CANONICAL_ORIGIN",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of trackedEnv) savedEnv.set(name, process.env[name]);
    process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
    process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN = LIBRARY_READ_BEARER;
    process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN = LIBRARY_DELETE_BEARER;
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
    process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = LIBRARY_BOOTSTRAP_SECRET;
    process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of savedEnv) restoreEnv(name, value);
    savedEnv.clear();
  });

  test("strips agent credentials from every proxied JSON response", async () => {
    const relaying: Array<{ label: string; status: number; run: () => Promise<Response> }> = [];
    for (const status of [200, 201, 400, 401, 403, 409, 422, 500]) {
      relaying.push({
        label: `delete ${status}`,
        run: () => destructiveDelete(),
        status,
      });
    }
    for (const status of [200, 201, 400, 422]) {
      relaying.push({ label: `paste ${status}`, run: () => ingestionPost("paste"), status });
      relaying.push({ label: `files ${status}`, run: () => ingestionPost("files"), status });
      relaying.push({ label: `retry ${status}`, run: () => ingestionPost("retry"), status });
    }
    relaying.push({ label: "snapshot 200", run: () => librarySnapshot(), status: 200 });

    const leaked: string[] = [];
    const preserved: string[] = [];
    for (const entry of relaying) {
      globalThis.fetch = hostileUpstream(entry.status);
      const response = await entry.run();
      const text = await response.text();
      for (const credential of HOSTILE_CREDENTIAL_STRINGS) {
        if (text.includes(credential)) leaked.push(`${entry.label}: value ${credential}`);
      }
      for (const key of HOSTILE_CREDENTIAL_KEYS) {
        if (text.includes(`"${key}"`)) leaked.push(`${entry.label}: key ${key}`);
      }
      if (text.includes('"safe":"preserved"')) preserved.push(entry.label);
    }

    expect(leaked).toEqual([]);
    // Every relaying case keeps the innocuous field, so the matrix is not passing by returning
    // an empty or sanitized body everywhere.
    expect(preserved).toHaveLength(relaying.length);
  });

  test("strips agent credentials from every proxied JSON response header set", async () => {
    globalThis.fetch = hostileUpstream(200, {
      authorization: `Bearer ${LIBRARY_READ_BEARER}`,
      "cache-control": "public, max-age=31536000",
      "content-type": "application/json",
      "set-cookie": "session=upstream; Path=/",
      "www-authenticate": 'Bearer realm="agent"',
      "x-api-key": "upstream-api-key",
    });

    const response = await destructiveDelete();
    const names = [...response.headers.keys()].sort();

    expect(response.headers.get("authorization")).toBe(null);
    expect(response.headers.get("set-cookie")).toBe(null);
    expect(response.headers.get("www-authenticate")).toBe(null);
    expect(response.headers.get("x-api-key")).toBe(null);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(names).toEqual(["cache-control", "content-type", "pragma", "x-content-type-options"]);
  });

  test("strips agent credentials from every proxied JSON response before minting BFF capabilities", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          study_sets: [
            {
              actions: {
                delete: { available: true },
                start: {
                  available: true,
                  session_bootstrap_token: "viva-bootstrap1.upstream-forged",
                  session_id: "server-session",
                  session_token: "viva1.raw-upstream",
                },
              },
              id: "biology-midterm",
              same_origin_control_token: "viva-control1.upstream-forged",
              user_id: "user-1",
            },
          ],
          user_id: "user-1",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      )) as typeof fetch;

    const response = await librarySnapshot();
    const body = (await response.json()) as {
      study_sets: Array<{
        actions: {
          delete?: { same_origin_control_token?: string };
          start?: { session_bootstrap_token?: string; session_token?: string };
        };
        same_origin_control_token?: string;
      }>;
    };
    const studySet = body.study_sets[0];

    // Upstream-forged capability values never survive...
    expect(JSON.stringify(body)).not.toContain("upstream-forged");
    expect(JSON.stringify(body)).not.toContain("viva1.raw-upstream");
    expect(studySet?.same_origin_control_token).toBeUndefined();
    // ...while the BFF's own freshly minted ones do, because minting runs after the strip pass.
    expect(studySet?.actions.start?.session_bootstrap_token).toContain("viva-bootstrap1.");
    expect(studySet?.actions.delete?.same_origin_control_token).toContain("viva-control1.");
    expect(studySet?.actions.start?.session_token).toBeUndefined();
  });

  test("strips agent credentials from every proxied JSON response and refuses ambiguous non-JSON bytes", async () => {
    const calls: number[] = [];
    globalThis.fetch = (async () => {
      calls.push(1);
      return new Response(`raw bytes with Bearer ${LIBRARY_READ_BEARER} inside`, {
        headers: { "content-type": "text/plain" },
        status: 200,
      });
    }) as typeof fetch;

    const removal = await destructiveDelete();
    const removalBody = await removal.json();
    const snapshot = await librarySnapshot();
    const snapshotBody = await snapshot.json();

    expect(removal.status).toBe(502);
    expect(removalBody).toEqual({ error: "viva_library_proxy_unavailable" });
    expect(snapshot.status).toBe(502);
    expect(snapshotBody).toEqual({
      error: "viva_library_pre_loop_unavailable",
      failure_class: "pre_loop_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_ingestion_unavailable",
    });
    expect(JSON.stringify([removalBody, snapshotBody])).not.toContain(LIBRARY_READ_BEARER);
    expect(calls).toHaveLength(2);
  });

  function hostileUpstream(status: number, headers?: Record<string, string>): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(hostileUpstreamBody()), {
        headers: headers ?? { "content-type": "application/json" },
        status,
      })) as typeof fetch;
  }

  async function destructiveDelete(): Promise<Response> {
    const token = signVivaLibraryControlToken({
      scope: "study_set_delete",
      studySetId: "biology-midterm",
      userId: "user-1",
    });
    if (!token) throw new Error("fixture must sign a study-set delete control capability");
    const request = {
      headers: new Headers({
        origin: CANONICAL,
        "sec-fetch-site": "same-origin",
        "x-viva-library-control-token": token,
      }),
      method: "DELETE",
      nextUrl: new URL(`${CANONICAL}/api/viva-library/study-sets/biology-midterm?user_id=user-1`),
    } as unknown as NextRequest;
    return DELETE(request, {
      params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }),
    });
  }

  async function ingestionPost(kind: "files" | "paste" | "retry"): Promise<Response> {
    if (kind === "paste") {
      return POST(ingestionRequest("study-sets/paste", validPasteBody()), {
        params: Promise.resolve({ path: ["study-sets", "paste"] }),
      });
    }
    if (kind === "files") {
      return POST(
        ingestionRequest("study-sets/files", {
          file_base64: "JVBERi0xLjc=",
          file_name: "Lecture 9.pdf",
          title: "Bio PDF",
        }),
        { params: Promise.resolve({ path: ["study-sets", "files"] }) },
      );
    }
    return POST(
      ingestionRequest("study-sets/biology-midterm/files/retry", {
        file_base64: "JVBERi0xLjc=",
        file_name: "Lecture 9.pdf",
      }),
      { params: Promise.resolve({ path: ["study-sets", "biology-midterm", "files", "retry"] }) },
    );
  }

  async function librarySnapshot(): Promise<Response> {
    const request = {
      headers: new Headers(),
      method: "GET",
      nextUrl: new URL(`${CANONICAL}/api/viva-library/study-sets/library?user_id=user-1`),
    } as unknown as NextRequest;
    return GET(request, { params: Promise.resolve({ path: ["study-sets", "library"] }) });
  }
});

/**
 * Task 7 (`WEBAPI-009`). A destructive control capability is one-time, and "one time" is only
 * true if the shared store owns the transaction. Every case here drives the real catch-all route
 * against the real bounded store adapter; nothing is asserted from source text.
 */
describe("Viva library destructive capability consumption", () => {
  const CANONICAL = "http://localhost:3000";
  const PUBLIC_CANONICAL = "https://web.example";
  const SCOPED_LIBRARY_READ_BEARER = "viva-fixture-agent-library-read-bearer";
  const SCOPED_LIBRARY_DELETE_BEARER = "viva-fixture-agent-library-delete-bearer";
  const BOOTSTRAP_SECRET = "viva-fixture-bootstrap-signing-key-01";
  const STORE_ORIGIN = "https://session-store.example";
  const STORE_CREDENTIAL = "viva-fixture-session-security-store-cred";
  const trackedEnv = [
    "NODE_ENV",
    "VIVA_AGENT_HTTP_URL",
    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
    "VIVA_AGENT_REST_BEARER_TOKEN",
    "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
    "VIVA_SESSION_ALLOWED_USER_IDS",
    "VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET",
    "VIVA_SESSION_SECURITY_STORE_MODE",
    "VIVA_SESSION_SECURITY_STORE_REST_TOKEN",
    "VIVA_SESSION_SECURITY_STORE_REST_URL",
    "VIVA_WEB_CANONICAL_ORIGIN",
    "VIVA_WEB_SINGLE_INSTANCE",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of trackedEnv) savedEnv.set(name, process.env[name]);
    resetVivaSessionSecurityStoreForTests();
    process.env.VIVA_AGENT_HTTP_URL = "http://agent.test";
    process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN = SCOPED_LIBRARY_READ_BEARER;
    process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN = SCOPED_LIBRARY_DELETE_BEARER;
    delete process.env.VIVA_AGENT_REST_BEARER_TOKEN;
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
    process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = BOOTSTRAP_SECRET;
    process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL;
    delete process.env.VIVA_SESSION_SECURITY_STORE_MODE;
    delete process.env.VIVA_SESSION_SECURITY_STORE_REST_URL;
    delete process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN;
    delete process.env.VIVA_WEB_SINGLE_INSTANCE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of savedEnv) restoreEnv(name, value);
    savedEnv.clear();
  });

  test("one-time delete capability reaches the agent once and replays as the coarse 403", async () => {
    const calls: string[] = [];
    globalThis.fetch = recordingAgentFetch(calls);
    const token = studySetDeleteToken();

    const first = await studySetDelete(token);
    const second = await studySetDelete(token);
    const replayBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(replayBody).toEqual({ error: "viva_library_control_capability_required" });
    expect(calls).toEqual(["http://agent.test/study-sets/biology-midterm?user_id=user-1"]);
  });

  test("concurrent DELETE requests spending one capability reach the agent exactly once", async () => {
    const calls: string[] = [];
    globalThis.fetch = recordingAgentFetch(calls);
    const token = studySetDeleteToken();

    const responses = await Promise.all([studySetDelete(token), studySetDelete(token)]);
    const statuses = responses.map((response) => response.status).sort();
    const loser = responses.find((response) => response.status === 403);

    expect(statuses).toEqual([200, 403]);
    expect(await loser?.json()).toEqual({ error: "viva_library_control_capability_required" });
    expect(calls).toHaveLength(1);
  });

  test("session deletion revokes only the matching session refresh record", async () => {
    const calls: string[] = [];
    globalThis.fetch = recordingAgentFetch(calls);
    const store = memoryStore();
    const nowSeconds = Math.floor(Date.now() / 1000);
    await issueRefreshRecord(store, "refresh-session-a", "session-a", nowSeconds);
    await issueRefreshRecord(store, "refresh-session-b", "session-b", nowSeconds);

    const response = await sessionDelete(sessionDeleteToken("session-a"), "session-a");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await refreshOutcome(store, "refresh-session-a", "session-a", nowSeconds)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(await refreshOutcome(store, "refresh-session-b", "session-b", nowSeconds)).toMatchObject(
      {
        ok: true,
      },
    );
  });

  test("study-set deletion revokes every refresh record under the verified user and study set", async () => {
    const calls: string[] = [];
    globalThis.fetch = recordingAgentFetch(calls);
    const store = memoryStore();
    const nowSeconds = Math.floor(Date.now() / 1000);
    await issueRefreshRecord(store, "refresh-session-a", "session-a", nowSeconds);
    await issueRefreshRecord(store, "refresh-session-b", "session-b", nowSeconds);
    await issueRefreshRecord(store, "refresh-other-set", "session-c", nowSeconds, {
      studySetId: "chemistry-final",
    });

    const response = await studySetDelete(studySetDeleteToken());

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await refreshOutcome(store, "refresh-session-a", "session-a", nowSeconds)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(await refreshOutcome(store, "refresh-session-b", "session-b", nowSeconds)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(
      await refreshOutcome(store, "refresh-other-set", "session-c", nowSeconds, {
        studySetId: "chemistry-final",
      }),
    ).toMatchObject({ ok: true });
  });

  test("deletion revokes refresh authority before the upstream DELETE and keeps it revoked after an upstream failure", async () => {
    const store = memoryStore();
    const nowSeconds = Math.floor(Date.now() / 1000);
    await issueRefreshRecord(store, "refresh-session-a", "session-a", nowSeconds);
    const observedDuringUpstream: unknown[] = [];
    globalThis.fetch = (async () => {
      // Observed from inside the upstream call: revocation must already have committed.
      observedDuringUpstream.push(
        await refreshOutcome(store, "refresh-session-a", "session-a", nowSeconds),
      );
      return new Response(JSON.stringify({ error: "agent_exploded" }), {
        headers: { "content-type": "application/json" },
        status: 500,
      });
    }) as typeof fetch;

    const response = await studySetDelete(studySetDeleteToken());

    expect(observedDuringUpstream).toEqual([{ ok: false, reason: "revoked" }]);
    // A control-route upstream failure is relayed after stripping; there is no rollback of the
    // revocation, and the capability stays spent.
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "agent_exploded" });
    expect(await refreshOutcome(store, "refresh-session-a", "session-a", nowSeconds)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  test("one-time delete fails closed with 503 when the shared store cannot commit and never deletes upstream", async () => {
    const agentCalls: string[] = [];
    const storeCalls: string[] = [];
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_WEB_CANONICAL_ORIGIN = PUBLIC_CANONICAL;
    process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = STORE_ORIGIN;
    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = STORE_CREDENTIAL;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(STORE_ORIGIN)) {
        storeCalls.push(url);
        return new Response("{}", { status: 500 });
      }
      agentCalls.push(url);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as typeof fetch;
    const token = studySetDeleteToken();

    const response = await studySetDelete(token, { origin: PUBLIC_CANONICAL });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "viva_library_control_unavailable",
      failure_class: "pre_loop_unavailable",
      stage: "pre_loop",
    });
    expect(storeCalls).toEqual([`${STORE_ORIGIN}/v1/session-security`]);
    expect(agentCalls).toEqual([]);
  });

  test("one-time delete rejects a foreign or missing origin before capability verification, store, and fetch", async () => {
    const calls: string[] = [];
    globalThis.fetch = recordingAgentFetch(calls);
    const token = studySetDeleteToken();

    const missingOrigin = await studySetDelete(token, { origin: null });
    const foreignOrigin = await studySetDelete(token, { origin: "https://evil.example" });
    // The capability must still be unspent: a rejected origin never reached the store.
    const afterwards = await studySetDelete(token);

    expect([missingOrigin.status, foreignOrigin.status]).toEqual([403, 403]);
    expect(await missingOrigin.json()).toEqual({
      error: "viva_library_control_capability_required",
    });
    expect(await foreignOrigin.json()).toEqual({
      error: "viva_library_control_capability_required",
    });
    expect(afterwards.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("one-time delete never forwards or logs the browser capability and session headers", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      const token = studySetDeleteToken();

      const response = await studySetDelete(token, {
        extraHeaders: { "x-viva-session-token": "viva1.browser-held-session-credential" },
      });
      const serializedBody = await response.text();

      expect(response.status).toBe(200);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${SCOPED_LIBRARY_DELETE_BEARER}`);
      expect(headers.get("x-viva-library-control-token")).toBe(null);
      expect(headers.get("x-viva-session-token")).toBe(null);
      expect(headers.get("origin")).toBe(CANONICAL);
      const forwarded = [...headers.keys()].sort();
      expect(forwarded).toEqual(["authorization", "origin"]);
      const observed = `${warnings.join("\n")}\n${serializedBody}`;
      expect(observed).not.toContain(token);
      expect(observed).not.toContain("viva1.browser-held-session-credential");
      expect(observed).not.toContain(SCOPED_LIBRARY_DELETE_BEARER);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("one-time delete refuses an unusable capability instead of proxying it upstream", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, url: String(input) });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as typeof fetch;

    // A capability that is PRESENT but unusable is exactly as unauthorized as an absent one. Each
    // of these once fell through the destructive branch and was relayed to the agent as an ordinary
    // proxied DELETE, carrying the browser-supplied header with it.
    const foreignPrefix = await studySetDelete("totally-bogus-capability");
    const truncatedPrefix = await studySetDelete("viva-control1");
    const nearMissPrefix = await studySetDelete("viva-control2.claims.signature");
    const whitespaceOnly = await studySetDelete("   ");
    const rejections = [foreignPrefix, truncatedPrefix, nearMissPrefix, whitespaceOnly];

    expect(rejections.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    for (const rejection of rejections) {
      // The single coarse body the error table pins for malformed, expired, wrong scope, and replay.
      expect(await rejection.json()).toEqual({
        error: "viva_library_control_capability_required",
      });
    }
    // No upstream contact at all, so the browser capability cannot have been relayed either.
    expect(calls).toEqual([]);
    expect(
      calls.map(({ init }) => new Headers(init?.headers).get("x-viva-library-control-token")),
    ).toEqual([]);

    // Positive control in the same fixture: the guard refuses only unusable capabilities, and a
    // genuine one still spends once and reaches the agent.
    const accepted = await studySetDelete(studySetDeleteToken());
    expect(accepted.status).toBe(200);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://agent.test/study-sets/biology-midterm?user_id=user-1",
    ]);
  });

  function memoryStore(): SessionSecurityStore {
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("fixture requires a selectable bounded security store");
    return selection.store;
  }

  function refreshIdentity(
    sessionId: string,
    overrides: { studySetId?: string; userId?: string } = {},
  ) {
    return {
      sessionId,
      studySetId: overrides.studySetId ?? "biology-midterm",
      userId: overrides.userId ?? "user-1",
    };
  }

  async function issueRefreshRecord(
    store: SessionSecurityStore,
    credential: string,
    sessionId: string,
    nowSeconds: number,
    overrides: { studySetId?: string; userId?: string } = {},
  ) {
    const issued = await store.rotateRefresh({
      absoluteExpiresAt: nowSeconds + 21_600,
      credentialHash: sha256Hex(credential),
      identity: refreshIdentity(sessionId, overrides),
      mode: "issue",
      refreshExpiresAt: nowSeconds + 900,
    });
    if (!issued.ok) throw new Error("fixture must be able to issue a refresh record");
  }

  async function refreshOutcome(
    store: SessionSecurityStore,
    credential: string,
    sessionId: string,
    nowSeconds: number,
    overrides: { studySetId?: string; userId?: string } = {},
  ) {
    return store.consumeRefresh({
      credentialHash: sha256Hex(credential),
      identity: refreshIdentity(sessionId, overrides),
      nowSeconds,
      reservationTtlSeconds: 10,
    });
  }

  function studySetDeleteToken(): string {
    const token = signVivaLibraryControlToken({
      scope: "study_set_delete",
      studySetId: "biology-midterm",
      userId: "user-1",
    });
    if (!token) throw new Error("fixture must sign a study-set delete control capability");
    return token;
  }

  function sessionDeleteToken(voiceSessionId: string): string {
    const token = signVivaLibraryControlToken({
      scope: "session_history_delete",
      studySetId: "biology-midterm",
      userId: "user-1",
      voiceSessionId,
    });
    if (!token) throw new Error("fixture must sign a session delete control capability");
    return token;
  }

  function recordingAgentFetch(calls: string[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          deleted_at: "2026-08-23T12:00:00Z",
          policy: "hard_purge_text",
          status: "deleted",
          study_set_id: "biology-midterm",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }) as typeof fetch;
  }

  function studySetDelete(
    token: string,
    options: { extraHeaders?: Record<string, string>; origin?: string | null } = {},
  ): Promise<Response> {
    const path = ["study-sets", "biology-midterm"];
    return DELETE(destructiveRequest(path, token, options), {
      params: Promise.resolve({ path }),
    });
  }

  function sessionDelete(token: string, voiceSessionId: string): Promise<Response> {
    const path = ["study-sets", "biology-midterm", "sessions", voiceSessionId];
    return DELETE(destructiveRequest(path, token), {
      params: Promise.resolve({ path }),
    });
  }

  function destructiveRequest(
    path: string[],
    token: string,
    options: { extraHeaders?: Record<string, string>; origin?: string | null } = {},
  ): NextRequest {
    const origin = options.origin === undefined ? CANONICAL : options.origin;
    const headers = new Headers({
      "sec-fetch-site": "same-origin",
      "x-viva-library-control-token": token,
      ...(options.extraHeaders ?? {}),
    });
    if (origin) headers.set("origin", origin);
    return {
      headers,
      method: "DELETE",
      nextUrl: new URL(`${CANONICAL}/api/viva-library/${path.join("/")}?user_id=user-1`),
    } as unknown as NextRequest;
  }
});

/**
 * Task 7A (`WEBAPI-016`), D-04 Branch A. The central ledger records `CONFIRM_DELETE`, so this
 * deployment has confirmation plus permanent delete and NO restore surface at all. Plan 13 owns the
 * named accessible confirmation UI; this lane owns only the API absence/behaviour proof.
 *
 * The recorded D-05 selector is `HARD_PURGE_TEXT`, so the permanent-delete receipt asserted below
 * is Plan 09's — `{ study_set_id, status, policy, deleted_at }` with the constant policy
 * `hard_purge_text` — not a shape invented here.
 */
describe("Viva library D-04 confirmation delete branch", () => {
  const CANONICAL = "https://web.example";
  const AGENT_ORIGIN = "https://agent.example";
  const STORE_ORIGIN = "https://session-store.example";
  const trackedEnv = [
    "NODE_ENV",
    "VIVA_AGENT_HTTP_URL",
    "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
    "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
    "VIVA_AGENT_REST_BEARER_TOKEN",
    "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
    "VIVA_SESSION_ALLOWED_USER_IDS",
    "VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET",
    "VIVA_SESSION_SECURITY_STORE_MODE",
    "VIVA_SESSION_SECURITY_STORE_REST_TOKEN",
    "VIVA_SESSION_SECURITY_STORE_REST_URL",
    "VIVA_SESSION_TRUSTED_PROXY_HOPS",
    "VIVA_WEB_CANONICAL_ORIGIN",
    "VIVA_WEB_SINGLE_INSTANCE",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of trackedEnv) savedEnv.set(name, process.env[name]);
    resetVivaSessionSecurityStoreForTests();
    process.env.VIVA_AGENT_HTTP_URL = AGENT_ORIGIN;
    process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN = "viva-fixture-agent-library-read-bearer";
    process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN = "viva-fixture-agent-library-delete-bearer";
    delete process.env.VIVA_AGENT_REST_BEARER_TOKEN;
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "user-1";
    process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = "viva-fixture-bootstrap-signing-key-01";
    process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL;
    // A REST-backed store, so a security-store call would be an observable fetch rather than an
    // invisible in-process map write. "Zero security-store calls" is then a real assertion.
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = STORE_ORIGIN;
    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = "viva-fixture-session-security-store-cred";
    process.env.VIVA_SESSION_TRUSTED_PROXY_HOPS = "1";
    delete process.env.VIVA_SESSION_SECURITY_STORE_MODE;
    delete process.env.VIVA_WEB_SINGLE_INSTANCE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of savedEnv) restoreEnv(name, value);
    savedEnv.clear();
  });

  test("D-04 confirmation delete has no restore surface", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ init, url });
      if (url.startsWith(STORE_ORIGIN)) {
        return new Response(
          JSON.stringify({
            operation: JSON.parse(String(init?.body)).operation,
            request_id: JSON.parse(String(init?.body)).request_id,
            result: { ok: true },
            schema_version: 1,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }
      // Plan 09's selected D-05 permanent-delete receipt, plus an upstream-injected capability the
      // BFF must strip. Nothing here carries an undo deadline, a deletion generation, or a token.
      return new Response(
        JSON.stringify({
          deleted_at: "2026-08-23T12:00:00Z",
          policy: "hard_purge_text",
          restore_control_token: "viva-control1.upstream-forged.capability",
          status: "deleted",
          study_set_id: "biology-midterm",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }) as typeof fetch;
    const controlToken = signVivaLibraryControlToken({
      scope: "study_set_delete",
      studySetId: "biology-midterm",
      userId: "user-1",
    });
    if (!controlToken) throw new Error("fixture must sign a study-set delete control capability");

    const confirmedDelete = await DELETE(
      branchRequest("DELETE", ["study-sets", "biology-midterm"], {
        "x-viva-library-control-token": controlToken,
      }),
      { params: Promise.resolve({ path: ["study-sets", "biology-midterm"] }) },
    );
    const receipt = await confirmedDelete.json();

    expect(confirmedDelete.status).toBe(200);
    // Exactly Plan 09's D-05 `HARD_PURGE_TEXT` receipt, after Task 5's bounded read and Task 6's
    // recursive strip: no undo deadline, no deletion generation, no restore capability.
    expect(receipt).toEqual({
      deleted_at: "2026-08-23T12:00:00Z",
      policy: "hard_purge_text",
      status: "deleted",
      study_set_id: "biology-midterm",
    });
    const serializedReceipt = JSON.stringify(receipt);
    for (const branchBField of ["undo_expires_at", "deletion_id", "restore_control_token"]) {
      expect(serializedReceipt).not.toContain(branchBField);
    }

    const restoreCallsBefore = calls.length;
    const restore = await POST(
      branchRequest(
        "POST",
        ["biology-midterm", "restore"],
        { "x-viva-control-token": controlToken },
        JSON.stringify({ deletion_id: "018f6e2c-3b8a-4a17-9c2d-6e7f8091a2b3" }),
      ),
      { params: Promise.resolve({ path: ["biology-midterm", "restore"] }) },
    );
    const restoreBody = await restore.json();

    expect(restore.status).toBe(403);
    expect(restoreBody).toEqual({
      error: "viva_library_control_scope_not_allowed",
      failure_class: "access_denied",
      stage: "pre_loop",
    });
    // Rejected before the security store and before the agent: no new call of either kind.
    expect(calls.length).toBe(restoreCallsBefore);
    expect(calls.filter((call) => call.url.startsWith(STORE_ORIGIN))).toHaveLength(1);
    expect(calls.filter((call) => call.url.startsWith(AGENT_ORIGIN))).toHaveLength(1);

    // Branch B artifacts must not exist in the selected route implementation.
    const routeSource = readFileSync(
      new URL("../app/api/viva-library/[[...path]]/route.ts", import.meta.url),
      "utf8",
    );
    for (const branchBSymbol of ["restore_control_token", "register_restore", "consume_restore"]) {
      expect(routeSource).not.toContain(branchBSymbol);
    }
  });

  function branchRequest(
    method: "DELETE" | "POST",
    path: string[],
    headers: Record<string, string>,
    body?: string,
  ): NextRequest {
    const url = `${CANONICAL}/api/viva-library/${path.join("/")}?user_id=user-1`;
    const request = new Request(url, {
      ...(body === undefined ? {} : { body }),
      headers: new Headers({
        "content-type": "application/json",
        origin: CANONICAL,
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "203.0.113.10",
        ...headers,
      }),
      method,
    }) as unknown as NextRequest;
    Object.defineProperty(request, "nextUrl", { value: new URL(url) });
    return request;
  }
});

const HOSTILE_CREDENTIAL_KEYS = [
  "session_token",
  "control_token",
  "refresh_token",
  "authorization",
  "Access_Token",
  "api_key",
  "secret",
  "password",
  "private_key",
  "credential",
  "token",
] as const;

const HOSTILE_CREDENTIAL_STRINGS = [
  "viva1.raw",
  "raw-control",
  "viva-refresh1.raw",
  "viva1.raw-nested",
  "Bearer raw-in-text",
  "viva-control1.raw",
  "viva-bootstrap1.raw",
] as const;

function hostileUpstreamBody(): Record<string, unknown> {
  return {
    api_key: "raw-api-key",
    authorization: "Bearer raw",
    control_token: "raw-control",
    credential: "raw-credential",
    nested: [
      { Access_Token: "viva1.raw-nested" },
      { message: "upstream reflected Bearer raw-in-text" },
      { deeper: { same_origin_control_token: "viva-control1.raw", token: "raw-token" } },
    ],
    password: "raw-password",
    private_key: "raw-private-key",
    refresh_token: "viva-refresh1.raw",
    safe: "preserved",
    secret: "raw-secret",
    session_bootstrap_token: "viva-bootstrap1.raw",
    session_token: "viva1.raw",
    study_sets: [],
    user_id: "user-1",
  };
}

function validPasteBody(): Record<string, string> {
  return {
    course: "Biology 201",
    exam_date: "2026-09-01",
    pasted_text: "Glycolysis yields two ATP.",
    title: "Bio paste",
  };
}

function ingestionRequest(
  route: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  return rawIngestionRequest(route, JSON.stringify(body), headers);
}

function rawIngestionRequest(
  route: string,
  body: string,
  headers: Record<string, string> = {},
): NextRequest {
  const requestHeaders = new Headers({
    "content-type": "application/json",
    origin: "http://localhost:3000",
    ...headers,
  });
  if (headers.origin === "") requestHeaders.delete("origin");
  const request = new Request(`http://localhost:3000/api/viva-library/${route}`, {
    body,
    headers: requestHeaders,
    method: "POST",
  }) as unknown as NextRequest;
  Object.defineProperty(request, "nextUrl", {
    value: new URL(`http://localhost:3000/api/viva-library/${route}`),
  });
  return request;
}

/** A valid paste body padded to an exact byte budget and streamed in uneven, cycled chunks. */
function pasteRequestAtBytes(
  totalBytes: number,
  chunkSizes: readonly number[],
  fillChar = "a",
): NextRequest {
  const encoder = new TextEncoder();
  const base = { ...validPasteBody(), pasted_text: "" };
  const overhead = encoder.encode(JSON.stringify(base)).byteLength;
  const fillerBytes = encoder.encode(fillChar).byteLength;
  const remaining = Math.max(0, totalBytes - overhead);
  const payload = JSON.stringify({
    ...base,
    pasted_text: fillChar.repeat(Math.ceil(remaining / fillerBytes)),
  });
  const bytes = encoder.encode(payload);
  let offset = 0;
  let chunkIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const size = chunkSizes[chunkIndex % chunkSizes.length] ?? bytes.byteLength;
      chunkIndex += 1;
      const take = Math.min(Math.max(1, size), bytes.byteLength - offset);
      controller.enqueue(bytes.slice(offset, offset + take));
      offset += take;
    },
  });
  const request = new Request("http://localhost:3000/api/viva-library/study-sets/paste", {
    body,
    duplex: "half",
    headers: new Headers({
      "content-type": "application/json",
      origin: "http://localhost:3000",
    }),
    method: "POST",
  } as RequestInit & { duplex: "half" }) as unknown as NextRequest;
  Object.defineProperty(request, "nextUrl", {
    value: new URL("http://localhost:3000/api/viva-library/study-sets/paste"),
  });
  return request;
}

function oversizedLibraryStream(
  totalBytes: number,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    cancel() {
      onCancel();
    },
    pull(controller) {
      if (sent === 0) controller.enqueue(new TextEncoder().encode('{"study_sets":["'));
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
}

function fileUploadRequest(): NextRequest {
  const request = new Request("http://localhost:3000/api/viva-library/study-sets/files", {
    body: JSON.stringify({
      content_type: "application/pdf",
      file_base64: "JVBERi0xLjc=",
      file_name: "Lecture 9.pdf",
      title: "Bio PDF",
    }),
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
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
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
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

/**
 * Independent restatement of the credential-hash rule the store contract pins: the adapter only
 * ever sees SHA-256, never a raw credential. Computed here rather than imported, so a production
 * drift in the hashing rule breaks these assertions.
 */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
