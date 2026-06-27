import * as bunTest from "bun:test";
import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { POST as refreshSession } from "../app/api/viva-session/refresh/route";
import {
  resetVivaSessionMintRateLimitsForTests,
  VIVA_SESSION_AUTH_FAILURE_PROFILES,
  type VivaSessionRouteFailureClass,
  type VivaSessionRouteOutcome,
  vivaSessionRouteFailureLogPayload,
} from "../app/api/viva-session/shared";
import { POST as startSession } from "../app/api/viva-session/start/route";

const { afterEach, beforeEach, describe, expect, test } = bunTest as typeof bunTest & {
  afterEach: (fn: () => void) => void;
  beforeEach: (fn: () => void) => void;
};

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
const originalEnv = {
  NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  VIVA_AGENT_HTTP_URL: process.env.VIVA_AGENT_HTTP_URL,
  VIVA_AGENT_REST_BEARER_TOKEN: process.env.VIVA_AGENT_REST_BEARER_TOKEN,
  VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET: process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET,
  VIVA_SESSION_ALLOWED_STUDY_SET_IDS: process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS,
  VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS: process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS,
  VIVA_SESSION_ALLOWED_USER_IDS: process.env.VIVA_SESSION_ALLOWED_USER_IDS,
  VIVA_SESSION_MINT_MAX_PER_MINUTE: process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE,
  VIVA_VOICE_SESSION_TOKEN_SECRET: process.env.VIVA_VOICE_SESSION_TOKEN_SECRET,
  VIVA_VOICE_WS_BEARER_TOKEN: process.env.VIVA_VOICE_WS_BEARER_TOKEN,
};

describe("Viva same-origin session API", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionMintRateLimitsForTests();
    process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://agent.example";
    process.env.VIVA_AGENT_REST_BEARER_TOKEN = "redacted-rest-bearer";
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = "redacted-bootstrap-signing-secret";
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "synthetic-user";
    process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
    process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS = "10000";
    process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "20";
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = "redacted-session-signing-secret";
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionMintRateLimitsForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("auth failure profiles cover operator codes while exposing coarse client classes", () => {
    expect(Object.keys(VIVA_SESSION_AUTH_FAILURE_PROFILES).sort()).toEqual([
      "access_denied",
      "expired",
      "identity_mismatch",
      "invalid_signature",
      "malformed",
      "replayed",
    ]);
    for (const [code, profile] of Object.entries(VIVA_SESSION_AUTH_FAILURE_PROFILES)) {
      expect(profile.operatorCode).toBe(code);
      expect(profile.stage).toBe("session");
      expect(profile.evidenceFields).toEqual(["failure_class", "stage", "token_refresh_outcome"]);
      expect(profile.learnerCopyCause).toBe("auth_failed");
      if (code === "expired") {
        expect(profile.clientClass).toBe("recoverable");
        expect(profile.retryEligible).toBe(true);
      } else {
        expect(profile.clientClass).toBe("terminal");
        expect(profile.retryEligible).toBe(false);
      }
    }
  });

  test("start mints through the server REST bearer without reflecting secrets", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return jsonResponse(200, librarySnapshot({ startToken: "viva1.redacted-start-token" }));
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as VivaSessionRouteOutcome;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://agent.example/study-sets/library?user_id=synthetic-user");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer redacted-rest-bearer");
    expect(headers.get("origin")).toBe("https://web.example");
    expect(body).toEqual({
      failure_class: null,
      session: {
        session_id: "server-session",
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      },
      session_token: "viva1.redacted-start-token",
      token_refresh_outcome: "issued",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("redacted-rest-bearer");
    expect(serialized).not.toContain("agent.example");
  });

  test("start requires the server-only agent URL instead of falling back to public browser config", async () => {
    const calls: string[] = [];
    delete process.env.VIVA_AGENT_HTTP_URL;
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://public-agent.example";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "viva_session_agent_unavailable",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "failed",
    });
    expect(calls).toEqual([]);
  });

  test("start fails closed on invalid server agent URL without reflecting it", async () => {
    const calls: string[] = [];
    process.env.VIVA_AGENT_HTTP_URL = "not a url";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "viva_session_agent_unavailable",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "failed",
    });
    expect(JSON.stringify(body)).not.toContain("not a url");
    expect(calls).toEqual([]);
  });

  test("start times out hung session creation with a pre-loop terminal reason", async () => {
    process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS = "5";
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      if (!observedSignal) {
        return jsonResponse(200, librarySnapshot({ startToken: "viva1.redacted-start-token" }));
      }
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => {
          reject(new Error("raw upstream timeout with bearer redacted-rest-bearer"));
        });
      });
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(504);
    expect(observedSignal?.aborted).toBe(true);
    expect(body).toEqual({
      error: "viva_session_agent_timeout",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "failed",
    });
    expect(JSON.stringify(body)).not.toContain("redacted-rest-bearer");
  });

  test("start caps configured bootstrap timeout to the contract maximum", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const scheduledTimeouts: number[] = [];
    process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS = "60000";
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduledTimeouts.push(Number(timeout));
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => reject(new Error("raw upstream timeout with bearer redacted-rest-bearer")),
          { once: true },
        );
      });
    }) as typeof fetch;

    try {
      const response = await startSession(
        sessionRequest("/api/viva-session/start", sessionStartPayload()),
      );
      const body = (await response.json()) as Record<string, unknown>;

      expect(scheduledTimeouts).toContain(10_000);
      expect(response.status).toBe(504);
      expect(observedSignal?.aborted).toBe(true);
      expect(body).toEqual({
        error: "viva_session_agent_timeout",
        failure_class: "session_bootstrap_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_session_unavailable",
        token_refresh_outcome: "failed",
      });
      expect(JSON.stringify(body)).not.toContain("redacted-rest-bearer");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("start keeps the bootstrap timeout active while reading the library body", async () => {
    process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS = "5";
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return hangingJsonResponse(
        observedSignal,
        "raw stalled library body with bearer redacted-rest-bearer",
      );
    }) as typeof fetch;

    const response = await Promise.race([
      startSession(sessionRequest("/api/viva-session/start", sessionStartPayload())),
      rejectAfter(100, "session bootstrap body read did not time out"),
    ]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(504);
    expect(observedSignal?.aborted).toBe(true);
    expect(body).toEqual({
      error: "viva_session_agent_timeout",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "failed",
    });
    expect(JSON.stringify(body)).not.toContain("redacted-rest-bearer");
  });

  test("start rejects cross-origin callers before contacting the agent", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload(), {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      }),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: "cross_origin_session_request",
      failure_class: "access_denied",
      token_refresh_outcome: "blocked",
    });
    expect(calls).toEqual([]);
  });

  test("start rejects requests without a positive same-origin header before contacting the agent", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;
    const request = sessionRequest("/api/viva-session/start", sessionStartPayload());
    request.headers.delete("origin");

    const response = await startSession(request);
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: "cross_origin_session_request",
      failure_class: "access_denied",
      token_refresh_outcome: "blocked",
    });
    expect(calls).toEqual([]);
  });

  test("start fails closed when session identity allowlists are not configured", async () => {
    const calls: string[] = [];
    delete process.env.VIVA_SESSION_ALLOWED_USER_IDS;
    delete process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "viva_session_identity_allowlist_unavailable",
      failure_class: "session_bootstrap_failed",
      token_refresh_outcome: "failed",
    });
    expect(calls).toEqual([]);
  });

  test("start requires a signed bootstrap capability even when same-origin headers are forged", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", {
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: "session_bootstrap_capability_required",
      failure_class: "access_denied",
      token_refresh_outcome: "blocked",
    });
    expect(calls).toEqual([]);
  });

  test("start requires bootstrap capability for loopback agents when server REST bearer minting is enabled", async () => {
    const calls: string[] = [];
    process.env.VIVA_AGENT_HTTP_URL = "http://127.0.0.1:4318";
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "http://127.0.0.1:4318";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ startToken: "viva1.redacted-start-token" }));
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", {
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: "session_bootstrap_capability_required",
      failure_class: "access_denied",
      token_refresh_outcome: "blocked",
    });
    expect(calls).toEqual([]);
  });

  test("start hides same-origin access-denied detail behind terminal auth class", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", {
        study_set_id: "biology-midterm",
        user_id: "other-user",
      }),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: "session_auth_terminal",
      failure_class: "session_auth_failure",
      token_refresh_outcome: "terminal",
    });
    expect(/access_denied|other-user|biology-midterm/.test(JSON.stringify(body))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("start applies independent mint limits to client IP and session identity", async () => {
    process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "1";
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "synthetic-user,alternate-user";
    globalThis.fetch = (async () =>
      jsonResponse(
        200,
        librarySnapshot({ startToken: "viva1.redacted-start-token" }),
      )) as typeof fetch;
    const requestBody = sessionStartPayload();

    const first = await startSession(sessionRequest("/api/viva-session/start", requestBody));
    const sameIpDifferentIdentity = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload({ userId: "alternate-user" })),
    );
    const sameIpBody = (await sameIpDifferentIdentity.json()) as VivaSessionRouteFailureClass;

    resetVivaSessionMintRateLimitsForTests();
    const third = await startSession(sessionRequest("/api/viva-session/start", requestBody));
    const sameIdentityDifferentIp = await startSession(
      sessionRequest("/api/viva-session/start", requestBody, {
        "x-forwarded-for": "203.0.113.11",
      }),
    );
    const sameIdentityBody = (await sameIdentityDifferentIp.json()) as VivaSessionRouteFailureClass;

    expect(first.status).toBe(200);
    expect(sameIpDifferentIdentity.status).toBe(429);
    expect(sameIpBody).toEqual({
      error: "session_mint_rate_limited",
      failure_class: "rate_limit",
      token_refresh_outcome: "blocked",
    });
    expect(third.status).toBe(200);
    expect(sameIdentityDifferentIp.status).toBe(429);
    expect(sameIdentityBody).toEqual({
      error: "session_mint_rate_limited",
      failure_class: "rate_limit",
      token_refresh_outcome: "blocked",
    });
  });

  test("start rate limiting uses the trusted appended proxy address instead of the caller-controlled first XFF value", async () => {
    process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "1";
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "synthetic-user,alternate-user";
    globalThis.fetch = (async () =>
      jsonResponse(
        200,
        librarySnapshot({ startToken: "viva1.redacted-start-token" }),
      )) as typeof fetch;

    const first = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload(), {
        "x-forwarded-for": "198.51.100.1, 203.0.113.10",
      }),
    );
    const sameProxyClient = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload({ userId: "alternate-user" }), {
        "x-forwarded-for": "198.51.100.2, 203.0.113.10",
      }),
    );
    const body = (await sameProxyClient.json()) as VivaSessionRouteFailureClass;

    expect(first.status).toBe(200);
    expect(sameProxyClient.status).toBe(429);
    expect(body).toEqual({
      error: "session_mint_rate_limited",
      failure_class: "rate_limit",
      token_refresh_outcome: "blocked",
    });
  });

  test("start enumerates failed and empty study sets before session creation", async () => {
    const cases = [
      {
        snapshot: librarySnapshot({
          conceptCount: 0,
          ingestionStatus: "failed",
          questionCount: 0,
          startAvailable: false,
          unavailableReason: "ingestion_failed",
        }),
        body: {
          error: "study_set_ingestion_failed",
          failure_class: "pre_loop_unavailable",
          stage: "pre_loop",
          terminal_reason: "pre_loop_ingestion_unavailable",
          token_refresh_outcome: "blocked",
        },
      },
      {
        snapshot: librarySnapshot({
          conceptCount: 0,
          ingestionStatus: "ready",
          questionCount: 0,
          startAvailable: false,
          unavailableReason: "empty_study_set",
        }),
        body: {
          error: "study_set_empty",
          failure_class: "pre_loop_unavailable",
          stage: "pre_loop",
          terminal_reason: "pre_loop_ingestion_unavailable",
          token_refresh_outcome: "blocked",
        },
      },
    ];

    for (const testCase of cases) {
      globalThis.fetch = (async () => jsonResponse(200, testCase.snapshot)) as typeof fetch;

      const response = await startSession(
        sessionRequest("/api/viva-session/start", sessionStartPayload()),
      );
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(409);
      expect(body).toEqual(testCase.body);
      expect(JSON.stringify(body)).not.toContain("No usable source span");
    }
  });

  test("refresh replaces an expired same-identity token and records the refresh outcome", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return jsonResponse(200, librarySnapshot({ resumeToken: "viva1.redacted-refresh-token" }));
    }) as typeof fetch;

    const response = await refreshSession(
      sessionRequest("/api/viva-session/refresh", {
        session_id: "server-session",
        session_token: signedSessionToken({
          expires_at: 1,
          nonce: "expired-nonce",
          session_id: "server-session",
          study_set_id: "biology-midterm",
          user_id: "synthetic-user",
        }),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const body = (await response.json()) as VivaSessionRouteOutcome;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(body).toEqual({
      failure_class: null,
      session: {
        session_id: "server-session",
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      },
      session_token: "viva1.redacted-refresh-token",
      token_refresh_outcome: "expired_refreshed",
    });
  });

  test("refresh records a normal same-identity token refresh separately from expiry recovery", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return jsonResponse(200, librarySnapshot({ resumeToken: "viva1.redacted-refresh-token" }));
    }) as typeof fetch;

    const response = await refreshSession(
      sessionRequest("/api/viva-session/refresh", {
        session_id: "server-session",
        session_token: signedSessionToken({
          expires_at: futureUnixSeconds(),
          nonce: "valid-refresh-nonce",
          session_id: "server-session",
          study_set_id: "biology-midterm",
          user_id: "synthetic-user",
        }),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const body = (await response.json()) as VivaSessionRouteOutcome;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(body).toEqual({
      failure_class: null,
      session: {
        session_id: "server-session",
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      },
      session_token: "viva1.redacted-refresh-token",
      token_refresh_outcome: "refreshed",
    });
  });

  test("refresh requires the server-only session signing secret before contacting the agent", async () => {
    const calls: string[] = [];
    delete process.env.VIVA_VOICE_SESSION_TOKEN_SECRET;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const response = await refreshSession(
      sessionRequest("/api/viva-session/refresh", {
        session_id: "server-session",
        session_token: signedSessionToken({
          expires_at: futureUnixSeconds(),
          nonce: "valid-nonce",
          session_id: "server-session",
          study_set_id: "biology-midterm",
          user_id: "synthetic-user",
        }),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "viva_session_refresh_unavailable",
      failure_class: "session_bootstrap_failed",
      token_refresh_outcome: "failed",
    });
    expect(calls).toEqual([]);
  });

  test("refresh exposes only coarse terminal auth class for invalid token categories", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const cases = [
      {
        forbiddenFragments: ["mismatch-nonce", "identity_mismatch", "other-user"],
        token: signedSessionToken({
          expires_at: futureUnixSeconds(),
          nonce: "mismatch-nonce",
          session_id: "server-session",
          study_set_id: "biology-midterm",
          user_id: "other-user",
        }),
      },
      {
        forbiddenFragments: ["invalid-signature-nonce", "invalid_signature", "invalid_rejected"],
        token: signedSessionToken(
          {
            expires_at: futureUnixSeconds(),
            nonce: "invalid-signature-nonce",
            session_id: "server-session",
            study_set_id: "biology-midterm",
            user_id: "synthetic-user",
          },
          "wrong-session-signing-secret",
        ),
      },
      {
        forbiddenFragments: ["not-a-viva-token", "malformed", "malformed_rejected"],
        token: "not-a-viva-token",
      },
    ];
    const observed = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      for (const input of cases) {
        const response = await refreshSession(
          sessionRequest("/api/viva-session/refresh", {
            session_id: "server-session",
            session_token: input.token,
            study_set_id: "biology-midterm",
            user_id: "synthetic-user",
          }),
        );
        const body = (await response.json()) as VivaSessionRouteFailureClass;
        observed.push({ body, status: response.status });
        const serialized = JSON.stringify(body);
        for (const fragment of input.forbiddenFragments) {
          expect(serialized).not.toContain(fragment);
        }
      }
    } finally {
      console.warn = originalWarn;
    }

    expect(observed).toEqual([
      {
        status: 401,
        body: {
          error: "session_auth_terminal",
          failure_class: "session_auth_failure",
          token_refresh_outcome: "terminal",
        },
      },
      {
        status: 401,
        body: {
          error: "session_auth_terminal",
          failure_class: "session_auth_failure",
          token_refresh_outcome: "terminal",
        },
      },
      {
        status: 401,
        body: {
          error: "session_auth_terminal",
          failure_class: "session_auth_failure",
          token_refresh_outcome: "terminal",
        },
      },
    ]);
    const logPayloads = warnings.map((entry) => JSON.parse(entry));
    expect(logPayloads.map((entry) => entry.error)).toEqual([
      "invalid_session_identity",
      "invalid_session_token",
      "invalid_session_token",
    ]);
    expect(logPayloads.map((entry) => entry.token_refresh_outcome)).toEqual([
      "identity_mismatch",
      "invalid_rejected",
      "malformed_rejected",
    ]);
    expect(JSON.stringify(logPayloads)).not.toContain("mismatch-nonce");
    expect(JSON.stringify(logPayloads)).not.toContain("invalid-signature-nonce");
    expect(JSON.stringify(logPayloads)).not.toContain("not-a-viva-token");
    expect(calls).toEqual([]);
  });

  test("session route failures expose sanitized log fields for provider dashboards", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";

    expect(
      vivaSessionRouteFailureLogPayload(
        {
          error: "invalid_session_token",
          failure_class: "session_auth_failure",
          token_refresh_outcome: "invalid_rejected",
        },
        401,
        { action: "refresh", route: "refresh" },
      ),
    ).toEqual({
      action: "refresh",
      deploy_sha: "abc123",
      error: "invalid_session_token",
      event: "viva_session_route_failure",
      failure_class: "session_auth_failure",
      route: "refresh",
      service: "web",
      stage: "session_auth",
      status: 401,
      token_refresh_outcome: "invalid_rejected",
    });
  });
});

function sessionRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  const request = new Request(`https://web.example${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "web.example",
      origin: "https://web.example",
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
    method: "POST",
  }) as unknown as NextRequest;
  Object.defineProperty(request, "nextUrl", {
    value: new URL(`https://web.example${path}`),
  });
  return request;
}

function sessionStartPayload({
  sessionId,
  studySetId = "biology-midterm",
  userId = "synthetic-user",
}: {
  sessionId?: string;
  studySetId?: string;
  userId?: string;
} = {}): Record<string, unknown> {
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    session_bootstrap_token: signedSessionBootstrapToken({
      session_id: sessionId ?? null,
      study_set_id: studySetId,
      user_id: userId,
    }),
    study_set_id: studySetId,
    user_id: userId,
  };
}

function signedSessionBootstrapToken(
  claims: { session_id: string | null; study_set_id: string; user_id: string },
  secret = "redacted-bootstrap-signing-secret",
): string {
  const body = {
    ...claims,
    expires_at: futureUnixSeconds(),
    nonce: "bootstrap-nonce",
    origin: "https://web.example",
    purpose: "viva_session_bootstrap",
  };
  const claimsPart = Buffer.from(JSON.stringify(body)).toString("base64url");
  const payload = `viva-bootstrap1.${claimsPart}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function hangingJsonResponse(signal: AbortSignal | undefined, abortMessage: string): Response {
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
      status: 200,
    },
  );
}

async function rejectAfter(ms: number, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  throw new Error(message);
}

function librarySnapshot({
  conceptCount = 1,
  ingestionStatus = "ready",
  questionCount = 1,
  resumeToken,
  startAvailable = true,
  startToken,
  unavailableReason,
}: {
  conceptCount?: number;
  ingestionStatus?: "pending" | "processing" | "ready" | "failed" | "retry";
  questionCount?: number;
  resumeToken?: string;
  startAvailable?: boolean;
  startToken?: string;
  unavailableReason?: string;
}) {
  return {
    privacy: {
      copy: "Voice recordings and transcripts are not saved.",
      export: { available: false, unavailable_reason: "mutation_auth_required" },
      export_contains_raw_provider_payloads: false,
      raw_audio_persistence: false,
      transcript_persistence: false,
      transcripts_saved: false,
      voice_recordings_saved: false,
    },
    sessions: [],
    study_sets: [
      {
        actions: {
          archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
          delete: { available: false, unavailable_reason: "server_mutation_unavailable" },
          resume: resumeToken
            ? {
                available: true,
                session_id: "server-session",
                session_token: resumeToken,
              }
            : { available: false, unavailable_reason: "no_open_session" },
          start: startAvailable
            ? {
                available: true,
                session_id: "server-session",
                session_token: startToken ?? "viva1.redacted-default-token",
              }
            : { available: false, unavailable_reason: unavailableReason ?? "unavailable" },
        },
        concept_count: conceptCount,
        course: "Biology 201",
        documents: [],
        id: "biology-midterm",
        ingestion_error: ingestionStatus === "failed" ? "No usable source span" : null,
        ingestion_status: ingestionStatus,
        question_count: questionCount,
        server_owned: true,
        title: "Biology Midterm",
        user_id: "synthetic-user",
      },
    ],
    user_id: "synthetic-user",
  };
}

function signedSessionToken(
  claims: Record<string, unknown>,
  secret = "redacted-session-signing-secret",
): string {
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `viva1.${claimsPart}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function futureUnixSeconds(): number {
  return Math.floor(Date.now() / 1000) + 60;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
