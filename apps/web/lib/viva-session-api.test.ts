import * as bunTest from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { POST as refreshSession } from "../app/api/viva-session/refresh/route";
import {
  resetVivaSessionMintRateLimitsForTests,
  type SessionTokenClaims,
  signVivaLibraryControlToken,
  signVivaSessionBootstrapToken,
  VIVA_SESSION_AUTH_FAILURE_PROFILES,
  type VivaSessionRouteFailureClass,
  type VivaSessionRouteOutcome,
  validateVivaWebSecret,
  verifyVivaSessionAccessToken,
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
  VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN: process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN,
  VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN: process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN,
  VIVA_AGENT_REST_BEARER_TOKEN: process.env.VIVA_AGENT_REST_BEARER_TOKEN,
  VIVA_AGENT_SESSION_MINT_BEARER_TOKEN: process.env.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN,
  VIVA_ALLOW_LEGACY_AGENT_REST_BEARER: process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER,
  VIVA_SESSION_BOOTSTRAP_TOKEN_PREVIOUS_SECRET:
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_PREVIOUS_SECRET,
  VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET: process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET,
  VIVA_SESSION_ALLOWED_STUDY_SET_IDS: process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS,
  VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS: process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS,
  VIVA_SESSION_ALLOWED_USER_IDS: process.env.VIVA_SESSION_ALLOWED_USER_IDS,
  VIVA_SESSION_MINT_MAX_PER_MINUTE: process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE,
  VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET: process.env.VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET,
  VIVA_VOICE_SESSION_TOKEN_SECRET: process.env.VIVA_VOICE_SESSION_TOKEN_SECRET,
  VIVA_VOICE_WS_BEARER_TOKEN: process.env.VIVA_VOICE_WS_BEARER_TOKEN,
  VIVA_WEB_CANONICAL_ORIGIN: process.env.VIVA_WEB_CANONICAL_ORIGIN,
};

// Fixture credentials: long enough to satisfy the recorded strength floor and
// clearly non-production. No value here is a real or real-shaped credential.
const STRONG_SESSION_SECRET = "viva-fixture-session-signing-key-0001";
const STRONG_PREVIOUS_SESSION_SECRET = "viva-fixture-session-previous-key-0001";
const STRONG_ROTATED_SESSION_SECRET = "viva-fixture-session-rotated-key-0001";
const STRONG_BOOTSTRAP_SECRET = "viva-fixture-bootstrap-signing-key-01";
const STRONG_PREVIOUS_BOOTSTRAP_SECRET = "viva-fixture-bootstrap-previous-key-1";
const CANONICAL_WEB_ORIGIN = "https://web.example";
const SCOPED_SESSION_MINT_BEARER = "viva-fixture-agent-session-mint-bearer";
const SCOPED_LIBRARY_READ_BEARER = "viva-fixture-agent-library-read-bearer";
const SCOPED_LIBRARY_DELETE_BEARER = "viva-fixture-agent-library-delete-bearer";

describe("Viva same-origin session API", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionMintRateLimitsForTests();
    process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://agent.example";
    process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
    delete process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER;
    process.env.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN = SCOPED_SESSION_MINT_BEARER;
    process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN = SCOPED_LIBRARY_READ_BEARER;
    process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN = SCOPED_LIBRARY_DELETE_BEARER;
    process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL_WEB_ORIGIN;
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = STRONG_BOOTSTRAP_SECRET;
    delete process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_PREVIOUS_SECRET;
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "synthetic-user";
    process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
    process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS = "10000";
    process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "20";
    delete process.env.VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET;
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = STRONG_SESSION_SECRET;
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
    expect(headers.get("authorization")).toBe(`Bearer ${SCOPED_SESSION_MINT_BEARER}`);
    expect(headers.get("origin")).toBe(CANONICAL_WEB_ORIGIN);
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
    expect(serialized).not.toContain("viva-fixture-legacy-rest-bearer");
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
          reject(new Error("raw upstream timeout with bearer viva-fixture-legacy-rest-bearer"));
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
    expect(JSON.stringify(body)).not.toContain("viva-fixture-legacy-rest-bearer");
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
          () =>
            reject(new Error("raw upstream timeout with bearer viva-fixture-legacy-rest-bearer")),
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
      expect(JSON.stringify(body)).not.toContain("viva-fixture-legacy-rest-bearer");
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
        "raw stalled library body with bearer viva-fixture-legacy-rest-bearer",
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
    expect(JSON.stringify(body)).not.toContain("viva-fixture-legacy-rest-bearer");
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
        session_token: signedSessionToken(
          sessionTokenClaims({
            expires_at: 1_000_000,
            issued_at: 900_000,
            nonce: "expired-nonce",
            not_before: 900_000,
          }),
        ),
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
        session_token: signedSessionToken(sessionTokenClaims({ nonce: "valid-refresh-nonce" })),
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
        session_token: signedSessionToken(sessionTokenClaims({ nonce: "valid-nonce" })),
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
        token: signedSessionToken(
          sessionTokenClaims({ nonce: "mismatch-nonce", user_id: "other-user" }),
        ),
      },
      {
        forbiddenFragments: ["invalid-signature-nonce", "invalid_signature", "invalid_rejected"],
        token: signedSessionToken(
          sessionTokenClaims({ nonce: "invalid-signature-nonce" }),
          "viva-fixture-unrelated-signing-secret-000",
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

type SessionTokenVectorsV1 = {
  version: 1;
  fake_secret_base64: string;
  clock_unix_seconds: number;
  cases: Array<{
    id: string;
    token: string;
    claims: Record<string, unknown> | null;
    valid: boolean;
    rejection: string | null;
  }>;
};

type SessionTokenVectorsManifest = {
  fixtures: Array<{ id: string; kind: string; path: string }>;
};

// Plan 05 manifest ID VOICE-TOKEN-V1-VECTORS (kind `token_vectors`). This lane
// consumes the fixture read-only; any required change returns to Plan 05 and is
// never normalized inside Node.
const PLAN_05_TOKEN_VECTOR_MANIFEST_ID = "VOICE-TOKEN-V1-VECTORS";
const PLAN_05_TOKEN_VECTOR_MANIFEST_PATH = "agent/fixtures/session-token/v1/vectors.json";
const PLAN_05_TOKEN_VECTOR_SECRET_BASE64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

const planFiveSessionTokenVectors = JSON.parse(
  readFileSync(new URL(`../../../${PLAN_05_TOKEN_VECTOR_MANIFEST_PATH}`, import.meta.url), "utf8"),
) as SessionTokenVectorsV1;

const planFiveFixtureManifest = JSON.parse(
  readFileSync(
    new URL("../../../agent/fixtures/voice-protocol/v5/manifest.json", import.meta.url),
    "utf8",
  ),
) as SessionTokenVectorsManifest;

const PLAN_05_FIXTURE_BINDING = {
  session_id: "fixture-session",
  study_set_id: "fixture-study-set",
  user_id: "fixture-user",
} as const;

describe("Plan 05 session-token vectors", () => {
  test("declares the exact read-only fixture schema and fake secret", () => {
    expect(planFiveSessionTokenVectors.version).toBe(1);
    expect(planFiveSessionTokenVectors.fake_secret_base64).toBe(PLAN_05_TOKEN_VECTOR_SECRET_BASE64);
    expect([...planFiveFixtureSecretBytes()]).toEqual(
      Array.from({ length: 32 }, (_value, index) => index),
    );
    expect(Number.isSafeInteger(planFiveSessionTokenVectors.clock_unix_seconds)).toBe(true);
    expect(planFiveSessionTokenVectors.cases.length).toBeGreaterThan(0);
    expect(new Set(planFiveSessionTokenVectors.cases.map((entry) => entry.id)).size).toBe(
      planFiveSessionTokenVectors.cases.length,
    );
    expect(
      planFiveFixtureManifest.fixtures.find(
        (entry) => entry.id === PLAN_05_TOKEN_VECTOR_MANIFEST_ID,
      ),
    ).toEqual({
      id: PLAN_05_TOKEN_VECTOR_MANIFEST_ID,
      kind: "token_vectors",
      path: PLAN_05_TOKEN_VECTOR_MANIFEST_PATH,
    });
  });

  test("verifies every vector without filtering and returns the exact closed rejection", () => {
    const secretBytes = planFiveFixtureSecretBytes();
    const observed: Array<{ id: string; outcome: string }> = [];
    const expected: Array<{ id: string; outcome: string }> = [];

    for (const vector of planFiveSessionTokenVectors.cases) {
      const verification = verifyVivaSessionAccessToken({
        clockSkewSeconds: 0,
        expectedBinding: PLAN_05_FIXTURE_BINDING,
        now: planFiveSessionTokenVectors.clock_unix_seconds,
        secretBytes,
        token: vector.token,
      });

      observed.push({
        id: vector.id,
        outcome: verification.ok ? "valid" : verification.reason,
      });
      expected.push({
        id: vector.id,
        outcome: vector.valid ? "valid" : (vector.rejection ?? "missing_rejection"),
      });

      if (vector.valid) {
        expect(verification.ok).toBe(true);
        if (verification.ok) {
          expect(verification.claims as unknown as Record<string, unknown>).toEqual(
            vector.claims as Record<string, unknown>,
          );
        }
      }
    }

    expect(observed).toEqual(expected);
    expect(observed.length).toBe(planFiveSessionTokenVectors.cases.length);
  });

  test("mutation control: a single flipped signature byte fails verification", () => {
    const secretBytes = planFiveFixtureSecretBytes();
    const canonical = planFiveSessionTokenVectors.cases.find((entry) => entry.valid);
    if (!canonical) throw new Error("fixture must contain at least one valid vector");

    expect(
      verifyVivaSessionAccessToken({
        clockSkewSeconds: 0,
        expectedBinding: PLAN_05_FIXTURE_BINDING,
        now: planFiveSessionTokenVectors.clock_unix_seconds,
        secretBytes,
        token: canonical.token,
      }).ok,
    ).toBe(true);

    const verification = verifyVivaSessionAccessToken({
      clockSkewSeconds: 0,
      expectedBinding: PLAN_05_FIXTURE_BINDING,
      now: planFiveSessionTokenVectors.clock_unix_seconds,
      secretBytes,
      token: flipOneSignatureByte(canonical.token),
    });

    expect(verification).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("mutation control: a mutated fixture secret fails every valid vector", () => {
    const mutatedSecret = planFiveFixtureSecretBytes();
    mutatedSecret[0] = (mutatedSecret[0] ?? 0) ^ 0x01;

    for (const vector of planFiveSessionTokenVectors.cases.filter((entry) => entry.valid)) {
      expect(
        verifyVivaSessionAccessToken({
          clockSkewSeconds: 0,
          expectedBinding: PLAN_05_FIXTURE_BINDING,
          now: planFiveSessionTokenVectors.clock_unix_seconds,
          secretBytes: mutatedSecret,
          token: vector.token,
        }),
      ).toEqual({ ok: false, reason: "invalid_signature" });
    }
  });

  test("rejects tokens beyond the bounded size before parsing", () => {
    const canonical = planFiveSessionTokenVectors.cases.find((entry) => entry.valid);
    if (!canonical) throw new Error("fixture must contain at least one valid vector");

    expect(
      verifyVivaSessionAccessToken({
        clockSkewSeconds: 0,
        expectedBinding: PLAN_05_FIXTURE_BINDING,
        now: planFiveSessionTokenVectors.clock_unix_seconds,
        secretBytes: planFiveFixtureSecretBytes(),
        token: `${canonical.token}${"A".repeat(4096)}`,
      }),
    ).toEqual({ ok: false, reason: "malformed_json" });
  });

  test("enforces the Plan 05 window with no Node-only grace", () => {
    const secretBytes = planFiveFixtureSecretBytes();
    const canonical = planFiveSessionTokenVectors.cases.find((entry) => entry.valid);
    if (!canonical) throw new Error("fixture must contain at least one valid vector");
    const claims = canonical.claims as unknown as SessionTokenClaims;

    const atNotBefore = verifyVivaSessionAccessToken({
      clockSkewSeconds: 0,
      expectedBinding: PLAN_05_FIXTURE_BINDING,
      now: claims.not_before,
      secretBytes,
      token: canonical.token,
    });
    const beforeNotBefore = verifyVivaSessionAccessToken({
      clockSkewSeconds: 0,
      expectedBinding: PLAN_05_FIXTURE_BINDING,
      now: claims.not_before - 1,
      secretBytes,
      token: canonical.token,
    });
    const atExpiry = verifyVivaSessionAccessToken({
      clockSkewSeconds: 0,
      expectedBinding: PLAN_05_FIXTURE_BINDING,
      now: claims.expires_at,
      secretBytes,
      token: canonical.token,
    });
    const beforeExpiry = verifyVivaSessionAccessToken({
      clockSkewSeconds: 0,
      expectedBinding: PLAN_05_FIXTURE_BINDING,
      now: claims.expires_at - 1,
      secretBytes,
      token: canonical.token,
    });

    expect(atNotBefore.ok).toBe(true);
    expect(beforeNotBefore).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(atExpiry).toEqual({ ok: false, reason: "expired" });
    expect(beforeExpiry.ok).toBe(true);
  });
});

describe("Viva web credential configuration", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionMintRateLimitsForTests();
    applyCanonicalOriginTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionMintRateLimitsForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("rejects weak secrets across the recorded placeholder table", () => {
    const weakValues = [
      "secret",
      "SECRET",
      "Password",
      "changeme",
      "CHANGE-ME",
      "placeholder",
      "Example",
      "TEST",
      "<your-session-signing-secret>",
      "<REPLACE_ME_WITH_A_REAL_SECRET_32B>",
      "a".repeat(64),
      "0".repeat(32),
      "short-but-not-a-placeholder-31b",
    ];

    for (const value of weakValues) {
      expect(validateVivaWebSecret(value).ok).toBe(false);
    }
    expect(validateVivaWebSecret(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(validateVivaWebSecret("   ")).toEqual({ ok: false, reason: "missing" });
    expect(validateVivaWebSecret(STRONG_SESSION_SECRET)).toEqual({
      ok: true,
      value: STRONG_SESSION_SECRET,
    });
    expect(validateVivaWebSecret("b".repeat(600), { maxBytes: 512 })).toEqual({
      ok: false,
      reason: "repeated_byte",
    });
    expect(
      validateVivaWebSecret(`viva-fixture-opaque-credential-${"c".repeat(600)}`, {
        maxBytes: 512,
      }),
    ).toEqual({ ok: false, reason: "too_long" });
  });

  test("rejects weak secrets at the route boundary without leaking the value or env name", async () => {
    const calls: string[] = [];
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = "secret";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    const response = await refreshSession(
      sessionRequest("/api/viva-session/refresh", {
        session_id: "server-session",
        session_token: signedSessionToken(
          sessionTokenClaims({ nonce: "weak-secret-nonce" }),
          STRONG_SESSION_SECRET,
        ),
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
    const evidence = `${JSON.stringify(body)}${warnings.join("")}`;
    expect(evidence).not.toContain("secret");
    expect(evidence).not.toContain("VIVA_VOICE_SESSION_TOKEN_SECRET");
  });

  test("accepts previous verification key during rotation without signing with it", async () => {
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = STRONG_SESSION_SECRET;
    process.env.VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET = STRONG_PREVIOUS_SESSION_SECRET;
    globalThis.fetch = (async () =>
      jsonResponse(
        200,
        librarySnapshot({ resumeToken: "viva1.redacted-refresh-token" }),
      )) as typeof fetch;

    const rotated = await refreshSession(
      sessionRequest("/api/viva-session/refresh", {
        session_id: "server-session",
        session_token: signedSessionToken(
          sessionTokenClaims({ nonce: "previous-key-nonce" }),
          STRONG_PREVIOUS_SESSION_SECRET,
        ),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const rotatedBody = (await rotated.json()) as VivaSessionRouteOutcome;

    const active = await refreshSession(
      sessionRequest("/api/viva-session/refresh", {
        session_id: "server-session",
        session_token: signedSessionToken(
          sessionTokenClaims({ nonce: "active-key-nonce" }),
          STRONG_SESSION_SECRET,
        ),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );

    expect(rotated.status).toBe(200);
    expect(rotatedBody.token_refresh_outcome).toBe("refreshed");
    expect(active.status).toBe(200);

    // The previous key is verify-only: it must never become the active signer.
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = STRONG_ROTATED_SESSION_SECRET;
    const staleActive = await refreshSession(
      sessionRequest("/api/viva-session/refresh", {
        session_id: "server-session",
        session_token: signedSessionToken(
          sessionTokenClaims({ nonce: "stale-active-nonce" }),
          "viva-fixture-unrelated-signing-secret-000",
        ),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const staleBody = (await staleActive.json()) as VivaSessionRouteFailureClass;

    expect(staleActive.status).toBe(401);
    expect(staleBody).toEqual({
      error: "session_auth_terminal",
      failure_class: "session_auth_failure",
      token_refresh_outcome: "terminal",
    });
  });
});

describe("Viva canonical origin authority", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionMintRateLimitsForTests();
    applyCanonicalOriginTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionMintRateLimitsForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("start and refresh fail closed before fetch when no canonical origin is configured", async () => {
    const calls: string[] = [];
    delete process.env.VIVA_WEB_CANONICAL_ORIGIN;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const start = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const startBody = (await start.json()) as VivaSessionRouteFailureClass;
    const refresh = await refreshSession(
      sessionRequest("/api/viva-session/refresh", {
        session_id: "server-session",
        session_token: signedSessionToken(sessionTokenClaims({ nonce: "no-canonical-nonce" })),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const refreshBody = (await refresh.json()) as VivaSessionRouteFailureClass;

    expect(start.status).toBe(503);
    expect(startBody).toEqual({
      error: "viva_session_agent_unavailable",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "failed",
    });
    expect(refresh.status).toBe(503);
    expect(refreshBody).toEqual({
      error: "viva_session_refresh_unavailable",
      failure_class: "session_bootstrap_failed",
      token_refresh_outcome: "failed",
    });
    expect(start.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([]);
  });

  test("canonical origin rejects credentials, path, query, fragment, insecure public http, and non-origin text", async () => {
    const rejected = [
      "https://viva:hunter2@web.example",
      "https://web.example/library",
      "https://web.example/",
      "https://web.example?user_id=synthetic-user",
      "https://web.example#fragment",
      "http://web.example",
      "web.example",
      "not an origin",
      "https://web.example:443/path?q=1#f",
    ];
    const observed: number[] = [];
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    for (const value of rejected) {
      resetVivaSessionMintRateLimitsForTests();
      process.env.VIVA_WEB_CANONICAL_ORIGIN = value;
      const response = await startSession(
        sessionRequest("/api/viva-session/start", sessionStartPayload()),
      );
      const body = (await response.json()) as VivaSessionRouteFailureClass;
      observed.push(response.status);
      expect(JSON.stringify(body)).not.toContain(value);
    }

    expect(observed).toEqual(rejected.map(() => 503));
    expect(calls).toEqual([]);
  });

  test("canonical origin accepts https and loopback http origins only", () => {
    const accepted = [
      "https://web.example",
      "https://web.example:8443",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://127.10.0.4:3000",
      "http://[::1]:3000",
    ];

    for (const value of accepted) {
      process.env.VIVA_WEB_CANONICAL_ORIGIN = value;
      const token = signVivaSessionBootstrapToken({
        sessionId: null,
        studySetId: "biology-midterm",
        userId: "synthetic-user",
      });
      expect(decodedCapabilityClaims(token).origin).toBe(value);
    }
  });

  test("canonical origin binds SSR-style capability minting with no origin argument", () => {
    const bootstrap = signVivaSessionBootstrapToken({
      sessionId: null,
      studySetId: "biology-midterm",
      userId: "synthetic-user",
    });
    const control = signVivaLibraryControlToken({
      scope: "study_set_delete",
      studySetId: "biology-midterm",
      userId: "synthetic-user",
    });

    const bootstrapClaims = decodedCapabilityClaims(bootstrap);
    const controlClaims = decodedCapabilityClaims(control);
    expect(bootstrapClaims.origin).toBe(CANONICAL_WEB_ORIGIN);
    expect(controlClaims.origin).toBe(CANONICAL_WEB_ORIGIN);
    expect(typeof bootstrapClaims.origin).toBe("string");
    expect(typeof controlClaims.origin).toBe("string");
    expect(Object.keys(bootstrapClaims).sort()).toEqual([
      "expires_at",
      "nonce",
      "origin",
      "purpose",
      "session_id",
      "study_set_id",
      "user_id",
    ]);
    expect(Object.keys(controlClaims).sort()).toEqual([
      "expires_at",
      "nonce",
      "origin",
      "purpose",
      "scope",
      "study_set_id",
      "user_id",
      "voice_session_id",
    ]);
  });

  test("canonical origin cannot be moved by Origin, Host, Forwarded, or X-Forwarded-Proto spoofs", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, librarySnapshot({ startToken: "viva1.redacted-start-token" }));
    }) as typeof fetch;

    const spoofHeaders = {
      forwarded: "for=203.0.113.7;host=evil.example;proto=http",
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
    };
    const accepted = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload(), spoofHeaders),
    );
    resetVivaSessionMintRateLimitsForTests();
    const spoofedOrigin = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload(), {
        ...spoofHeaders,
        origin: "https://evil.example",
      }),
    );
    const spoofedBody = (await spoofedOrigin.json()) as VivaSessionRouteFailureClass;

    expect(accepted.status).toBe(200);
    expect(new Headers(calls[0]?.init?.headers).get("origin")).toBe(CANONICAL_WEB_ORIGIN);
    expect(spoofedOrigin.status).toBe(403);
    expect(spoofedBody).toEqual({
      error: "cross_origin_session_request",
      failure_class: "access_denied",
      token_refresh_outcome: "blocked",
    });
    expect(calls).toHaveLength(1);
  });

  test("canonical origin accepts a bootstrap capability minted under the previous signing key", async () => {
    process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_PREVIOUS_SECRET = STRONG_PREVIOUS_BOOTSTRAP_SECRET;
    globalThis.fetch = (async () =>
      jsonResponse(
        200,
        librarySnapshot({ startToken: "viva1.redacted-start-token" }),
      )) as typeof fetch;

    const rotated = await startSession(
      sessionRequest("/api/viva-session/start", {
        session_bootstrap_token: signedSessionBootstrapToken(
          { session_id: null, study_set_id: "biology-midterm", user_id: "synthetic-user" },
          STRONG_PREVIOUS_BOOTSTRAP_SECRET,
        ),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    resetVivaSessionMintRateLimitsForTests();
    const unrelated = await startSession(
      sessionRequest("/api/viva-session/start", {
        session_bootstrap_token: signedSessionBootstrapToken(
          { session_id: null, study_set_id: "biology-midterm", user_id: "synthetic-user" },
          "viva-fixture-unrelated-signing-secret-000",
        ),
        study_set_id: "biology-midterm",
        user_id: "synthetic-user",
      }),
    );
    const unrelatedBody = (await unrelated.json()) as VivaSessionRouteFailureClass;

    expect(rotated.status).toBe(200);
    expect(unrelated.status).toBe(403);
    expect(unrelatedBody).toEqual({
      error: "session_bootstrap_capability_required",
      failure_class: "access_denied",
      token_refresh_outcome: "blocked",
    });
  });

  test("canonical origin rejects every malformed bootstrap capability with one coarse body", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;
    const baseClaims = {
      expires_at: Math.floor(Date.now() / 1000) + 300,
      nonce: "bootstrap-nonce",
      origin: CANONICAL_WEB_ORIGIN,
      purpose: "viva_session_bootstrap",
      session_id: null,
      study_set_id: "biology-midterm",
      user_id: "synthetic-user",
    };
    const hostile: Array<{ label: string; token: string }> = [
      {
        label: "padded claims segment",
        token: capabilityTokenFromJson(JSON.stringify(baseClaims), { padClaims: true }),
      },
      {
        label: "padded signature segment",
        token: capabilityTokenFromJson(JSON.stringify(baseClaims), { padSignature: true }),
      },
      {
        label: "duplicate claim",
        token: capabilityTokenFromJson(
          `{"expires_at":${baseClaims.expires_at},"nonce":"a","nonce":"b","origin":"${CANONICAL_WEB_ORIGIN}","purpose":"viva_session_bootstrap","session_id":null,"study_set_id":"biology-midterm","user_id":"synthetic-user"}`,
        ),
      },
      {
        label: "unknown claim",
        token: capabilityTokenFromJson(JSON.stringify({ ...baseClaims, role: "admin" })),
      },
      {
        label: "null origin",
        token: capabilityTokenFromJson(JSON.stringify({ ...baseClaims, origin: null })),
      },
      {
        label: "missing origin",
        token: capabilityTokenFromJson(
          JSON.stringify({
            expires_at: baseClaims.expires_at,
            nonce: baseClaims.nonce,
            purpose: baseClaims.purpose,
            session_id: null,
            study_set_id: baseClaims.study_set_id,
            user_id: baseClaims.user_id,
          }),
        ),
      },
      {
        label: "foreign origin",
        token: capabilityTokenFromJson(
          JSON.stringify({ ...baseClaims, origin: "https://evil.example" }),
        ),
      },
      {
        label: "invalid purpose",
        token: capabilityTokenFromJson(
          JSON.stringify({ ...baseClaims, purpose: "viva_library_control" }),
        ),
      },
      {
        label: "non-safe-integer expiry",
        token: capabilityTokenFromJson(JSON.stringify({ ...baseClaims, expires_at: 1.5e18 })),
      },
      {
        label: "string expiry",
        token: capabilityTokenFromJson(
          JSON.stringify({ ...baseClaims, expires_at: `${baseClaims.expires_at}` }),
        ),
      },
      {
        label: "empty nonce",
        token: capabilityTokenFromJson(JSON.stringify({ ...baseClaims, nonce: "" })),
      },
    ];

    const observed: Array<{ label: string; status: number; body: unknown }> = [];
    for (const entry of hostile) {
      resetVivaSessionMintRateLimitsForTests();
      const response = await startSession(
        sessionRequest("/api/viva-session/start", {
          session_bootstrap_token: entry.token,
          study_set_id: "biology-midterm",
          user_id: "synthetic-user",
        }),
      );
      observed.push({ body: await response.json(), label: entry.label, status: response.status });
    }

    expect(observed).toEqual(
      hostile.map((entry) => ({
        body: {
          error: "session_bootstrap_capability_required",
          failure_class: "access_denied",
          token_refresh_outcome: "blocked",
        },
        label: entry.label,
        status: 403,
      })),
    );
    expect(calls).toEqual([]);
  });
});

describe("Viva scoped service credential selection", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionMintRateLimitsForTests();
    applyCanonicalOriginTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionMintRateLimitsForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("start uses the session mint scope and never another scope", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, librarySnapshot({ startToken: "viva1.redacted-start-token" }));
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const authorization = new Headers(calls[0]?.init?.headers).get("authorization");

    expect(response.status).toBe(200);
    expect(authorization).toBe(`Bearer ${SCOPED_SESSION_MINT_BEARER}`);
    expect(authorization).not.toContain(SCOPED_LIBRARY_READ_BEARER);
    expect(authorization).not.toContain(SCOPED_LIBRARY_DELETE_BEARER);
    expect(authorization).not.toContain("viva-fixture-legacy-rest-bearer");
  });

  test("public start fails when its scoped service credential is missing even with the legacy REST bearer present", async () => {
    const calls: string[] = [];
    delete process.env.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN;
    process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
    process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER = "1";
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

  test("legacy REST bearer is loopback-only and requires the explicit escape hatch", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    delete process.env.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN;
    process.env.VIVA_AGENT_HTTP_URL = "http://127.0.0.1:4318";
    process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL_WEB_ORIGIN;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, librarySnapshot({ startToken: "viva1.redacted-start-token" }));
    }) as typeof fetch;

    const withoutEscapeHatch = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const withoutBody = (await withoutEscapeHatch.json()) as VivaSessionRouteFailureClass;

    resetVivaSessionMintRateLimitsForTests();
    process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER = "1";
    const loopbackAllowed = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );

    resetVivaSessionMintRateLimitsForTests();
    process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
    const publicRejected = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const publicBody = (await publicRejected.json()) as VivaSessionRouteFailureClass;

    expect(withoutEscapeHatch.status).toBe(503);
    expect(withoutBody.error).toBe("viva_session_agent_unavailable");
    expect(loopbackAllowed.status).toBe(200);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer viva-fixture-legacy-rest-bearer",
    );
    expect(publicRejected.status).toBe(503);
    expect(publicBody.error).toBe("viva_session_agent_unavailable");
    expect(calls).toHaveLength(1);
  });

  test("a present but weak scoped credential fails closed instead of degrading to the legacy bearer", async () => {
    const calls: string[] = [];
    // Every legacy escape-hatch precondition is satisfied here, so the only thing that can keep
    // the request from silently borrowing the broad bearer is the scoped credential failing
    // closed on its own strength gate.
    process.env.VIVA_AGENT_HTTP_URL = "http://127.0.0.1:4318";
    process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER = "1";
    process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ startToken: "viva1.redacted-start-token" }));
    }) as typeof fetch;

    const weakValues = ["short-mint-bearer", "changeme", `viva-${"m".repeat(600)}`];
    const observed: Array<{ error: string; status: number }> = [];
    for (const weak of weakValues) {
      resetVivaSessionMintRateLimitsForTests();
      process.env.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN = weak;
      const response = await startSession(
        sessionRequest("/api/viva-session/start", sessionStartPayload()),
      );
      const body = (await response.json()) as VivaSessionRouteFailureClass;
      observed.push({ error: body.error, status: response.status });
    }

    expect(observed).toEqual(
      weakValues.map(() => ({ error: "viva_session_agent_unavailable", status: 503 })),
    );
    expect(calls).toEqual([]);
  });
});

function applyCanonicalOriginTestEnv() {
  process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
  process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://agent.example";
  process.env.VIVA_AGENT_REST_BEARER_TOKEN = "viva-fixture-legacy-rest-bearer";
  delete process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER;
  process.env.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN = SCOPED_SESSION_MINT_BEARER;
  process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN = SCOPED_LIBRARY_READ_BEARER;
  process.env.VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN = SCOPED_LIBRARY_DELETE_BEARER;
  process.env.VIVA_WEB_CANONICAL_ORIGIN = CANONICAL_WEB_ORIGIN;
  process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET = STRONG_BOOTSTRAP_SECRET;
  delete process.env.VIVA_SESSION_BOOTSTRAP_TOKEN_PREVIOUS_SECRET;
  process.env.VIVA_SESSION_ALLOWED_USER_IDS = "synthetic-user";
  process.env.VIVA_SESSION_ALLOWED_STUDY_SET_IDS = "biology-midterm";
  process.env.VIVA_SESSION_BOOTSTRAP_TIMEOUT_MS = "10000";
  process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "20";
  delete process.env.VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET;
  process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = STRONG_SESSION_SECRET;
}

function decodedCapabilityClaims(token: string | null): Record<string, unknown> {
  if (!token) throw new Error("capability token must be minted for this fixture");
  const segment = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

// Independent local minting of hostile bootstrap capabilities: never reuses the production
// signer or verifier, and never copies a real credential.
function capabilityTokenFromJson(
  claimsJson: string,
  options: { padClaims?: boolean; padSignature?: boolean } = {},
): string {
  const claimsPart = Buffer.from(claimsJson, "utf8").toString("base64url");
  const signedClaims = options.padClaims ? `${claimsPart}=` : claimsPart;
  const payload = `viva-bootstrap1.${signedClaims}`;
  const signature = createHmac("sha256", STRONG_BOOTSTRAP_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${options.padSignature ? `${signature}=` : signature}`;
}

function planFiveFixtureSecretBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(planFiveSessionTokenVectors.fake_secret_base64, "base64"));
}

function flipOneSignatureByte(token: string): string {
  const segments = token.split(".");
  const signature = Buffer.from(segments[2] ?? "", "base64url");
  signature[0] = (signature[0] ?? 0) ^ 0x01;
  return `${segments[0]}.${segments[1]}.${signature.toString("base64url")}`;
}

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
  secret = STRONG_BOOTSTRAP_SECRET,
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
  secret = STRONG_SESSION_SECRET,
): string {
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const payload = `viva1.${claimsPart}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

// Independent local minting: never reuses the production verifier or signer.
function sessionTokenClaims(
  overrides: Partial<Record<keyof SessionTokenClaims, unknown>> = {},
): Record<string, unknown> {
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  return {
    expires_at: issuedAt + 900,
    issued_at: issuedAt,
    nonce: "fixture-session-nonce",
    not_before: issuedAt,
    session_id: "server-session",
    study_set_id: "biology-midterm",
    user_id: "synthetic-user",
    ...overrides,
  };
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
