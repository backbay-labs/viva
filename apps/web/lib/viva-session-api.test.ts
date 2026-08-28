import * as bunTest from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type AuthenticatedStudyProjectionV1,
  validateAuthenticatedStudyProjectionV1,
} from "@viva/core";
import type { NextRequest } from "next/server";
import { GET as fetchStudyProjection } from "../app/api/viva-session/projection/route";
import { POST as refreshSession } from "../app/api/viva-session/refresh/route";
import {
  guardVivaSessionProjectionAdmission,
  resetVivaSessionSecurityStoreForTests,
  type SessionSecurityStore,
  type SessionTokenClaims,
  signVivaLibraryControlToken,
  signVivaSessionBootstrapToken,
  VIVA_SESSION_AUTH_FAILURE_PROFILES,
  type VivaSessionRouteFailureClass,
  type VivaSessionRouteOutcome,
  validateVivaWebSecret,
  verifyVivaSessionAccessToken,
  vivaSessionRouteFailureLogPayload,
  vivaSessionSecurityStore,
  vivaSessionSecurityStoreMemoryRecordCountForTests,
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
  NODE_ENV: process.env.NODE_ENV,
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
  VIVA_SESSION_PROJECTION_MAX_PER_MINUTE: process.env.VIVA_SESSION_PROJECTION_MAX_PER_MINUTE,
  VIVA_SESSION_SECURITY_STORE_MODE: process.env.VIVA_SESSION_SECURITY_STORE_MODE,
  VIVA_SESSION_SECURITY_STORE_REST_TOKEN: process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN,
  VIVA_SESSION_SECURITY_STORE_REST_URL: process.env.VIVA_SESSION_SECURITY_STORE_REST_URL,
  VIVA_SESSION_TRUSTED_PROXY_HOPS: process.env.VIVA_SESSION_TRUSTED_PROXY_HOPS,
  VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET: process.env.VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET,
  VIVA_VOICE_SESSION_TOKEN_SECRET: process.env.VIVA_VOICE_SESSION_TOKEN_SECRET,
  VIVA_VOICE_WS_BEARER_TOKEN: process.env.VIVA_VOICE_WS_BEARER_TOKEN,
  VIVA_WEB_CANONICAL_ORIGIN: process.env.VIVA_WEB_CANONICAL_ORIGIN,
  VIVA_WEB_SINGLE_INSTANCE: process.env.VIVA_WEB_SINGLE_INSTANCE,
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
const SESSION_SECURITY_STORE_ORIGIN = "https://session-store.example";
const SESSION_SECURITY_STORE_CREDENTIAL = "viva-fixture-session-security-store-cred";

describe("Viva same-origin session API", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionSecurityStoreForTests();
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
    process.env.VIVA_SESSION_TRUSTED_PROXY_HOPS = "1";
    delete process.env.VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET;
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = STRONG_SESSION_SECRET;
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
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
    const agentAccessToken = signedAgentAccessToken();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return jsonResponse(200, librarySnapshot({ startToken: agentAccessToken }));
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as VivaSessionRouteOutcome;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    // `A-32`: a start mint asks the agent to record the session for the one study set
    // it is starting. Without that selector the agent's library snapshot is a pure
    // read, so no other caller of it opens a durable session.
    expect(calls[0]?.input).toBe(
      "https://agent.example/study-sets/library?user_id=synthetic-user&record_start_for=biology-midterm",
    );
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SCOPED_SESSION_MINT_BEARER}`);
    expect(headers.get("origin")).toBe(CANONICAL_WEB_ORIGIN);
    expect(Object.keys(body).sort()).toEqual([
      "failure_class",
      "refresh_expires_at",
      "refresh_token",
      "session",
      "session_absolute_expires_at",
      "session_token",
      "token_refresh_outcome",
    ]);
    expect(body.failure_class).toBe(null);
    expect(body.session).toEqual({
      session_id: "server-session",
      study_set_id: "biology-midterm",
      user_id: "synthetic-user",
    });
    expect(body.session_token).toBe(agentAccessToken);
    expect(body.token_refresh_outcome).toBe("issued");
    expect(typeof body.refresh_token).toBe("string");
    expect(typeof body.refresh_expires_at).toBe("string");
    expect(typeof body.session_absolute_expires_at).toBe("string");
    const serialized = JSON.stringify(body);
    // The credential this path actually sends upstream is the scoped mint bearer asserted above,
    // so that is the string whose absence proves nothing leaked back to the browser.
    expect(serialized).not.toContain(SCOPED_SESSION_MINT_BEARER);
    expect(serialized).not.toContain("viva-fixture-legacy-rest-bearer");
    expect(serialized).not.toContain("agent.example");
  });

  test("resume mints ask the agent for no durable write because their session already exists", async () => {
    const calls: string[] = [];
    const agentAccessToken = signedAgentAccessToken();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ resumeToken: agentAccessToken }));
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest(
        "/api/viva-session/start",
        sessionStartPayload({ sessionId: "server-session" }),
      ),
    );
    const body = (await response.json()) as VivaSessionRouteOutcome;

    expect(response.status).toBe(200);
    expect(body.session?.session_id).toBe("server-session");
    expect(calls).toHaveLength(1);
    // `A-32`: only a start records. A resume names a `voice_sessions` row the start
    // mint already committed, so it must not ask the agent to open another one.
    expect(calls[0]).toBe("https://agent.example/study-sets/library?user_id=synthetic-user");
    expect(calls[0]).not.toContain("record_start_for");
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
        return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
      }
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => {
          reject(new Error(`raw upstream timeout with bearer ${SCOPED_SESSION_MINT_BEARER}`));
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
    expect(JSON.stringify(body)).not.toContain(SCOPED_SESSION_MINT_BEARER);
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
          () => reject(new Error(`raw upstream timeout with bearer ${SCOPED_SESSION_MINT_BEARER}`)),
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
      expect(JSON.stringify(body)).not.toContain(SCOPED_SESSION_MINT_BEARER);
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
        `raw stalled library body with bearer ${SCOPED_SESSION_MINT_BEARER}`,
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
    expect(JSON.stringify(body)).not.toContain(SCOPED_SESSION_MINT_BEARER);
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
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
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
      jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }))) as typeof fetch;
    const requestBody = sessionStartPayload();

    const first = await startSession(sessionRequest("/api/viva-session/start", requestBody));
    const sameIpDifferentIdentity = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload({ userId: "alternate-user" })),
    );
    const sameIpBody = (await sameIpDifferentIdentity.json()) as VivaSessionRouteFailureClass;

    resetVivaSessionSecurityStoreForTests();
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
      jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }))) as typeof fetch;

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

  test("refresh requires the server-only session signing secret before contacting the agent", async () => {
    const calls: string[] = [];
    delete process.env.VIVA_VOICE_SESSION_TOKEN_SECRET;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;

    const response = await refreshSession(
      sessionRequest(
        "/api/viva-session/refresh",
        refreshPayload("viva-refresh1.unused-credential"),
      ),
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
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
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
      sessionRequest(
        "/api/viva-session/refresh",
        refreshPayload("viva-refresh1.unused-credential"),
      ),
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
    // D-07 Branch A moved access-token verification off the browser payload and onto the token the
    // agent returns, so the active/previous rotation rule is proved through the surviving path.
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = STRONG_SESSION_SECRET;
    process.env.VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET = STRONG_PREVIOUS_SESSION_SECRET;
    let agentToken = signedSessionToken(
      sessionTokenClaims({ nonce: "previous-key-nonce" }),
      STRONG_PREVIOUS_SESSION_SECRET,
    );
    globalThis.fetch = (async () =>
      jsonResponse(200, librarySnapshot({ startToken: agentToken }))) as typeof fetch;

    const rotated = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const rotatedBody = (await rotated.json()) as VivaSessionRouteOutcome;

    agentToken = signedSessionToken(
      sessionTokenClaims({ nonce: "active-key-nonce" }),
      STRONG_SESSION_SECRET,
    );
    const active = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );

    expect(rotated.status).toBe(200);
    expect(rotatedBody.token_refresh_outcome).toBe("issued");
    expect(active.status).toBe(200);

    // The previous key is verify-only: it must never become the active signer, and a token signed
    // with neither the active nor the previous key is never handed to the browser.
    process.env.VIVA_VOICE_SESSION_TOKEN_SECRET = STRONG_ROTATED_SESSION_SECRET;
    agentToken = signedSessionToken(
      sessionTokenClaims({ nonce: "stale-active-nonce" }),
      "viva-fixture-unrelated-signing-secret-000",
    );
    const staleActive = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const staleBody = (await staleActive.json()) as VivaSessionRouteFailureClass;

    expect(staleActive.status).toBe(502);
    expect(staleBody).toEqual({
      error: "viva_session_agent_unavailable",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "failed",
    });
    expect(JSON.stringify(staleBody)).not.toContain("stale-active-nonce");
  });
});

describe("Viva canonical origin authority", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
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
      sessionRequest(
        "/api/viva-session/refresh",
        refreshPayload("viva-refresh1.unused-credential"),
      ),
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
      resetVivaSessionSecurityStoreForTests();
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
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
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
    resetVivaSessionSecurityStoreForTests();
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
      jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }))) as typeof fetch;

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
    resetVivaSessionSecurityStoreForTests();
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
      resetVivaSessionSecurityStoreForTests();
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
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("start uses the session mint scope and never another scope", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
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
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;

    const withoutEscapeHatch = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const withoutBody = (await withoutEscapeHatch.json()) as VivaSessionRouteFailureClass;

    resetVivaSessionSecurityStoreForTests();
    process.env.VIVA_ALLOW_LEGACY_AGENT_REST_BEARER = "1";
    const loopbackAllowed = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );

    resetVivaSessionSecurityStoreForTests();
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
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;

    const weakValues = ["short-mint-bearer", "changeme", `viva-${"m".repeat(600)}`];
    const observed: Array<{ error: string; status: number }> = [];
    for (const weak of weakValues) {
      resetVivaSessionSecurityStoreForTests();
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

describe("Viva trusted proxy and atomic shared rate admission", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
    applySharedSecurityStoreTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("trusted proxy admission with one hop buckets on the right-most forwarded entry only", async () => {
    process.env.VIVA_SESSION_TRUSTED_PROXY_HOPS = "1";
    process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "1";
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "synthetic-user,alternate-user";
    globalThis.fetch = (async () =>
      jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }))) as typeof fetch;

    // Same trusted hop, attacker-rotated left prefixes AND attacker-supplied platform headers.
    // None of them may mint a fresh admission bucket.
    const first = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload(), {
        "x-forwarded-for": "198.51.100.1, 203.0.113.10",
      }),
    );
    const rotatedPrefix = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload({ userId: "alternate-user" }), {
        "x-forwarded-for": "198.51.100.99, 203.0.113.10",
      }),
    );
    const spoofedPlatformHeaders = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload({ userId: "alternate-user" }), {
        "cf-connecting-ip": "198.51.100.51",
        "true-client-ip": "198.51.100.52",
        "x-forwarded-for": "198.51.100.98, 203.0.113.10",
        "x-real-ip": "198.51.100.50",
        "x-vercel-forwarded-for": "198.51.100.53",
      }),
    );

    expect(first.status).toBe(200);
    expect([rotatedPrefix.status, spoofedPlatformHeaders.status]).toEqual([429, 429]);
    expect(await rotatedPrefix.json()).toEqual({
      error: "session_mint_rate_limited",
      failure_class: "rate_limit",
      token_refresh_outcome: "blocked",
    });
    expect(isBoundedRetryAfter(rotatedPrefix.headers.get("retry-after"))).toBe(true);
  });

  test("trusted proxy admission with two hops buckets on the second entry from the right", async () => {
    process.env.VIVA_SESSION_TRUSTED_PROXY_HOPS = "2";
    process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "1";
    process.env.VIVA_SESSION_ALLOWED_USER_IDS = "synthetic-user,alternate-user";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const userId = new URL(String(input)).searchParams.get("user_id") ?? "synthetic-user";
      // The agent's token is now strictly verified against the minted identity, so the fixture
      // must sign one that actually binds the user it is answering for.
      return jsonResponse(
        200,
        librarySnapshot({ startToken: signedAgentAccessToken({ user_id: userId }), userId }),
      );
    }) as typeof fetch;

    const first = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload(), {
        "x-forwarded-for": "198.51.100.1, 203.0.113.10, 192.0.2.5",
      }),
    );
    const sameSecondFromRight = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload({ userId: "alternate-user" }), {
        "x-forwarded-for": "198.51.100.77, 203.0.113.10, 192.0.2.9",
      }),
    );
    const differentSecondFromRight = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload({ userId: "alternate-user" }), {
        "x-forwarded-for": "198.51.100.77, 203.0.113.44, 192.0.2.9",
      }),
    );

    expect(first.status).toBe(200);
    expect(sameSecondFromRight.status).toBe(429);
    expect(differentSecondFromRight.status).toBe(200);
  });

  test("trusted proxy admission fails closed on unset, invalid, zero, and short forwarded chains", async () => {
    // A fully working public shared store is configured here on purpose: the only thing that can
    // refuse these requests is the trusted client identity, and the store must never be reached.
    const calls: string[] = [];
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = SESSION_SECURITY_STORE_ORIGIN;
    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = SESSION_SECURITY_STORE_CREDENTIAL;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      calls.push(target);
      if (target.startsWith(SESSION_SECURITY_STORE_ORIGIN)) {
        const sent = JSON.parse(String(init?.body)) as { operation: string; request_id: string };
        return jsonResponse(200, {
          operation: sent.operation,
          request_id: sent.request_id,
          result:
            sent.operation === "increment_rate_limit"
              ? { ok: true, remaining: 11, resetAtMs: Date.now() + 60_000 }
              : { ok: true },
          schema_version: 1,
        });
      }
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;

    const cases: Array<{
      headers?: Record<string, string>;
      hops?: string;
      omitHeaders?: readonly string[];
    }> = [
      { hops: undefined },
      { hops: "0" },
      { hops: "abc" },
      { hops: "6" },
      // Declared two hops, one supplied: the request did not traverse the declared topology.
      { hops: "2" },
      { hops: "1", omitHeaders: ["x-forwarded-for"] },
      { headers: { "x-forwarded-for": "" }, hops: "1" },
      { headers: { "x-forwarded-for": "203.0.113.10, , 192.0.2.5" }, hops: "1" },
      { headers: { "x-forwarded-for": "203.0.113.10, not-an-ip" }, hops: "1" },
      { headers: { "x-forwarded-for": "203.0.113.10, 999.1.1.1" }, hops: "1" },
    ];

    const observed: Array<{ error: string; status: number }> = [];
    for (const testCase of cases) {
      resetVivaSessionSecurityStoreForTests();
      restoreEnv("VIVA_SESSION_TRUSTED_PROXY_HOPS", testCase.hops);
      const response = await startSession(
        sessionRequest("/api/viva-session/start", sessionStartPayload(), testCase.headers ?? {}, {
          omitHeaders: testCase.omitHeaders,
        }),
      );
      const body = (await response.json()) as VivaSessionRouteFailureClass;
      observed.push({ error: body.error, status: response.status });
    }

    // Positive control on the identical fixture: a declared chain admits and does reach the store.
    resetVivaSessionSecurityStoreForTests();
    process.env.VIVA_SESSION_TRUSTED_PROXY_HOPS = "1";
    const admitted = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload(), {
        "x-forwarded-for": "198.51.100.4, 203.0.113.10",
      }),
    );

    expect(observed).toEqual(
      cases.map(() => ({ error: "viva_session_security_store_unavailable", status: 503 })),
    );
    expect(admitted.status).toBe(200);
    expect(calls).toEqual([
      "https://session-store.example/v1/session-security",
      // A-32: the admitted call is a start, so it carries the record selector.
      "https://agent.example/study-sets/library?user_id=synthetic-user&record_start_for=biology-midterm",
      // D-07 Branch A: the issued refresh record is committed to the same shared store.
      "https://session-store.example/v1/session-security",
    ]);
  });

  test("atomic shared rate admission rejects out-of-range mint and projection limits", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;

    const rejected = ["0", "121", "-1", "12.5", "twelve", "1e2", "+12", "0x0c"];
    const observed: Array<{ error: string; status: number }> = [];
    for (const value of rejected) {
      resetVivaSessionSecurityStoreForTests();
      process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = value;
      const response = await startSession(
        sessionRequest("/api/viva-session/start", sessionStartPayload()),
      );
      const body = (await response.json()) as VivaSessionRouteFailureClass;
      observed.push({ error: body.error, status: response.status });
    }

    // A blank value is treated as unset, not as an invalid value: deployment tooling routinely
    // renders an unset variable as the empty string, and every other env read here agrees.
    const blankDefaults: number[] = [];
    for (const blank of ["", "   "]) {
      resetVivaSessionSecurityStoreForTests();
      process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = blank;
      const response = await startSession(
        sessionRequest("/api/viva-session/start", sessionStartPayload()),
      );
      blankDefaults.push(response.status);
    }

    resetVivaSessionSecurityStoreForTests();
    delete process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE;
    const defaulted = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );

    expect(observed).toEqual(
      rejected.map(() => ({ error: "viva_session_agent_unavailable", status: 503 })),
    );
    expect(blankDefaults).toEqual([200, 200]);
    expect(defaulted.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  test("shared security store is mandatory for public start and refresh before any agent fetch", async () => {
    const calls: string[] = [];
    restoreEnv("NODE_ENV", "production");
    delete process.env.VIVA_SESSION_SECURITY_STORE_REST_URL;
    delete process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;

    const start = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const startBody = (await start.json()) as VivaSessionRouteFailureClass;
    const refresh = await refreshSession(
      sessionRequest(
        "/api/viva-session/refresh",
        refreshPayload("viva-refresh1.unused-credential"),
      ),
    );
    const refreshBody = (await refresh.json()) as VivaSessionRouteFailureClass;

    expect(start.status).toBe(503);
    expect(startBody).toEqual({
      error: "viva_session_security_store_unavailable",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "failed",
    });
    expect(refresh.status).toBe(503);
    expect(refreshBody).toEqual(startBody);
    expect(calls).toEqual([]);
    expect(JSON.stringify([startBody, refreshBody])).not.toContain("VIVA_SESSION_SECURITY_STORE");
  });

  test("shared security store rest url alone cannot admit public traffic without its credential", async () => {
    const calls: string[] = [];
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = SESSION_SECURITY_STORE_ORIGIN;
    delete process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(503);
    expect(body.error).toBe("viva_session_security_store_unavailable");
    expect(calls).toEqual([]);
  });
});

describe("Viva shared security store adapters", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
    applySharedSecurityStoreTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("shared security store refuses memory mode and unconfigured stores on public deployments", () => {
    restoreEnv("NODE_ENV", "production");

    process.env.VIVA_SESSION_SECURITY_STORE_MODE = "memory";
    const publicMemoryRequest = vivaSessionSecurityStore();

    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = SESSION_SECURITY_STORE_ORIGIN;
    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = SESSION_SECURITY_STORE_CREDENTIAL;
    const memoryRequestedWithRestAvailable = vivaSessionSecurityStore();

    process.env.VIVA_SESSION_SECURITY_STORE_MODE = "redis";
    const unknownMode = vivaSessionSecurityStore();

    delete process.env.VIVA_SESSION_SECURITY_STORE_MODE;
    const restSelected = vivaSessionSecurityStore();

    delete process.env.VIVA_SESSION_SECURITY_STORE_REST_URL;
    const restUnconfigured = vivaSessionSecurityStore();

    expect(publicMemoryRequest).toEqual({ ok: false, reason: "unavailable" });
    expect(memoryRequestedWithRestAvailable).toEqual({ ok: false, reason: "unavailable" });
    expect(unknownMode).toEqual({ ok: false, reason: "unavailable" });
    expect(restSelected.ok).toBe(true);
    expect(restUnconfigured).toEqual({ ok: false, reason: "unavailable" });
  });

  test("shared security store memory mode requires an explicit single-instance assertion", () => {
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_WEB_CANONICAL_ORIGIN = "http://localhost:3000";
    process.env.VIVA_AGENT_HTTP_URL = "http://127.0.0.1:4318";

    const rejectedAssertions = [undefined, "", "0", "false", "true", "yes", "01"];
    const rejected = rejectedAssertions.map((value) => {
      restoreEnv("VIVA_WEB_SINGLE_INSTANCE", value);
      return vivaSessionSecurityStore().ok;
    });

    process.env.VIVA_WEB_SINGLE_INSTANCE = "1";
    const loopbackSingleInstance = vivaSessionSecurityStore();

    process.env.VIVA_AGENT_HTTP_URL = "https://agent.example";
    const publicAgentUrl = vivaSessionSecurityStore();

    process.env.VIVA_AGENT_HTTP_URL = "http://127.0.0.1:4318";
    process.env.VIVA_WEB_CANONICAL_ORIGIN = "https://web.example";
    const publicWebOrigin = vivaSessionSecurityStore();

    expect(rejected).toEqual(rejectedAssertions.map(() => false));
    expect(loopbackSingleInstance.ok).toBe(true);
    expect(publicAgentUrl).toEqual({ ok: false, reason: "unavailable" });
    expect(publicWebOrigin).toEqual({ ok: false, reason: "unavailable" });
  });

  test("shared security store rejects rest urls with credentials, path, query, fragment, or insecure public http", () => {
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = SESSION_SECURITY_STORE_CREDENTIAL;

    const rejectedUrls = [
      "https://operator:secret@session-store.example",
      "https://session-store.example/v1",
      "https://session-store.example/",
      "https://session-store.example?tenant=1",
      "https://session-store.example#fragment",
      "http://session-store.example",
      "session-store.example",
      "ftp://session-store.example",
    ];
    const rejected = rejectedUrls.map((value) => {
      process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = value;
      return vivaSessionSecurityStore().ok;
    });

    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = "https://session-store.example";
    const publicHttps = vivaSessionSecurityStore();
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = "http://127.0.0.1:9410";
    const loopbackHttp = vivaSessionSecurityStore();

    expect(rejected).toEqual(rejectedUrls.map(() => false));
    expect(publicHttps.ok).toBe(true);
    expect(loopbackHttp.ok).toBe(true);
  });

  test("shared security store validates its rest credential through the web secret gate", () => {
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = SESSION_SECURITY_STORE_ORIGIN;

    const weakCredentials = [
      undefined,
      "",
      "short-store-token",
      "changeme",
      "<replace-with-store-token>",
      "z".repeat(64),
      "s".repeat(513).replace(/^s/, "v"),
    ];
    const rejected = weakCredentials.map((value) => {
      restoreEnv("VIVA_SESSION_SECURITY_STORE_REST_TOKEN", value);
      return vivaSessionSecurityStore().ok;
    });

    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = SESSION_SECURITY_STORE_CREDENTIAL;
    const accepted = vivaSessionSecurityStore();

    expect(rejected).toEqual(weakCredentials.map(() => false));
    expect(accepted.ok).toBe(true);
  });

  test("shared security store speaks the exact rest envelope and requires an exact request id echo", async () => {
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = SESSION_SECURITY_STORE_ORIGIN;
    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = SESSION_SECURITY_STORE_CREDENTIAL;
    const calls: Array<{ init?: RequestInit; input: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, input: String(input) });
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, {
        operation: "increment_rate_limit",
        request_id: sent.request_id,
        result: { ok: true, remaining: 5, resetAtMs: 1_700_000_060_000 },
        schema_version: 1,
      });
    }) as typeof fetch;

    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("rest adapter must be selected for this fixture");
    const result = await selection.store.incrementRateLimit({
      keys: ["hashed-ip-key", "hashed-identity-key"],
      limit: 6,
      nowMs: 1_700_000_000_000,
      windowMs: 60_000,
    });
    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    const headers = new Headers(calls[0]?.init?.headers);

    expect(result).toEqual({ ok: true, remaining: 5, resetAtMs: 1_700_000_060_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://session-store.example/v1/session-security");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.signal instanceof AbortSignal).toBe(true);
    expect(headers.get("authorization")).toBe(`Bearer ${SESSION_SECURITY_STORE_CREDENTIAL}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(Object.keys(sent).sort()).toEqual([
      "input",
      "operation",
      "request_id",
      "schema_version",
    ]);
    expect(sent.schema_version).toBe(1);
    expect(sent.operation).toBe("increment_rate_limit");
    expect(isCanonicalUuidV4(String(sent.request_id))).toBe(true);
    expect(sent.input).toEqual({
      keys: ["hashed-ip-key", "hashed-identity-key"],
      limit: 6,
      nowMs: 1_700_000_000_000,
      windowMs: 60_000,
    });
  });

  test("shared security store fails closed on hostile rest responses and never falls back to memory", async () => {
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = SESSION_SECURITY_STORE_ORIGIN;
    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = SESSION_SECURITY_STORE_CREDENTIAL;
    const admitted = { ok: true, remaining: 5, resetAtMs: 1_700_000_060_000 };
    const hostile: Array<(requestId: string) => Response> = [
      () => jsonResponse(500, { error: "upstream" }),
      () => new Response("{not-json", { headers: { "content-type": "application/json" } }),
      (requestId) =>
        jsonResponse(200, {
          operation: "increment_rate_limit",
          padding: "x".repeat(17 * 1024),
          request_id: requestId,
          result: admitted,
          schema_version: 1,
        }),
      () =>
        jsonResponse(200, {
          operation: "increment_rate_limit",
          request_id: "00000000-0000-4000-8000-000000000000",
          result: admitted,
          schema_version: 1,
        }),
      (requestId) =>
        jsonResponse(200, {
          operation: "consume_refresh",
          request_id: requestId,
          result: admitted,
          schema_version: 1,
        }),
      (requestId) =>
        jsonResponse(200, {
          operation: "increment_rate_limit",
          request_id: requestId,
          result: admitted,
          schema_version: 2,
        }),
      (requestId) =>
        jsonResponse(200, {
          extra: true,
          operation: "increment_rate_limit",
          request_id: requestId,
          result: admitted,
          schema_version: 1,
        }),
      (requestId) =>
        jsonResponse(200, {
          operation: "increment_rate_limit",
          request_id: requestId,
          result: { ok: false, reason: "teapot" },
          schema_version: 1,
        }),
      (requestId) =>
        jsonResponse(200, {
          operation: "increment_rate_limit",
          request_id: requestId,
          result: { ok: true, extra: 1, remaining: 5, resetAtMs: 1 },
          schema_version: 1,
        }),
    ];

    const observed: Array<unknown> = [];
    for (const respond of hostile) {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body)) as { request_id: string };
        return respond(sent.request_id);
      }) as typeof fetch;
      const selection = vivaSessionSecurityStore();
      if (!selection.ok) throw new Error("rest adapter must be selected for this fixture");
      observed.push(
        await selection.store.incrementRateLimit({
          keys: ["hashed-ip-key", "hashed-identity-key"],
          limit: 6,
          nowMs: 1_700_000_000_000,
          windowMs: 60_000,
        }),
      );
    }

    expect(observed).toEqual(hostile.map(() => ({ ok: false, reason: "unavailable" })));
    // A failed HTTP adapter never quietly becomes the bounded in-memory adapter.
    expect(vivaSessionSecurityStoreMemoryRecordCountForTests()).toBe(0);
  });

  test("shared security store abandons a hung rest call at its two-second deadline", async () => {
    restoreEnv("NODE_ENV", "production");
    process.env.VIVA_SESSION_SECURITY_STORE_REST_URL = SESSION_SECURITY_STORE_ORIGIN;
    process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN = SESSION_SECURITY_STORE_CREDENTIAL;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      })) as typeof fetch;

    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("rest adapter must be selected for this fixture");
    const startedAt = Date.now();
    const result = await selection.store.incrementRateLimit({
      keys: ["hashed-ip-key", "hashed-identity-key"],
      limit: 6,
      nowMs: 1_700_000_000_000,
      windowMs: 60_000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(4_000);
  });

  test("atomic shared rate admission is one bucket across independently constructed adapters", async () => {
    const first = vivaSessionSecurityStore();
    const second = vivaSessionSecurityStore();
    if (!first.ok || !second.ok) throw new Error("memory adapter must be selected in test mode");
    const keys = mintAdmissionKeys("203.0.113.10");
    const nowMs = 1_700_000_000_000;

    const results = [
      await first.store.incrementRateLimit({ keys, limit: 3, nowMs, windowMs: 60_000 }),
      await second.store.incrementRateLimit({ keys, limit: 3, nowMs, windowMs: 60_000 }),
      await first.store.incrementRateLimit({ keys, limit: 3, nowMs, windowMs: 60_000 }),
      await second.store.incrementRateLimit({ keys, limit: 3, nowMs, windowMs: 60_000 }),
    ];

    expect(first.store).not.toBe(second.store);
    expect(results.map((result) => result.ok)).toEqual([true, true, true, false]);
    expect(results[3]).toEqual({ ok: false, reason: "limited", resetAtMs: 1_700_000_040_000 });
  });

  test("atomic shared rate admission shares one mint bucket with the start route", async () => {
    process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "2";
    globalThis.fetch = (async () =>
      jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }))) as typeof fetch;
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("memory adapter must be selected in test mode");

    // One slot is consumed outside the route, through the documented key formula only.
    const seeded = await selection.store.incrementRateLimit({
      keys: mintAdmissionKeys("203.0.113.10"),
      limit: 2,
      nowMs: Date.now(),
      windowMs: 60_000,
    });
    const admitted = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const rejected = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const rejectedBody = (await rejected.json()) as VivaSessionRouteFailureClass;

    expect(seeded.ok).toBe(true);
    expect(admitted.status).toBe(200);
    expect(rejected.status).toBe(429);
    expect(rejectedBody).toEqual({
      error: "session_mint_rate_limited",
      failure_class: "rate_limit",
      token_refresh_outcome: "blocked",
    });
    expect(isBoundedRetryAfter(rejected.headers.get("retry-after"))).toBe(true);
  });

  test("atomic shared rate admission admits exactly one concurrent request for the final slot", async () => {
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("memory adapter must be selected in test mode");
    const keys = mintAdmissionKeys("198.51.100.200");
    const nowMs = 1_700_000_000_000;

    const settled = await Promise.all(
      Array.from({ length: 8 }, () =>
        selection.store.incrementRateLimit({ keys, limit: 1, nowMs, windowMs: 60_000 }),
      ),
    );

    expect(settled.filter((result) => result.ok)).toHaveLength(1);
    expect(settled.filter((result) => !result.ok)).toHaveLength(7);
  });

  test("atomic shared rate admission never consumes one key of a pair when the other is limited", async () => {
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("memory adapter must be selected in test mode");
    const nowMs = 1_700_000_000_000;
    const shared = "atomic-pair-shared";
    const fresh = "atomic-pair-fresh";
    const partner = "atomic-pair-partner";

    const seeded = await selection.store.incrementRateLimit({
      keys: ["atomic-pair-seed", shared],
      limit: 1,
      nowMs,
      windowMs: 60_000,
    });
    const limited = await selection.store.incrementRateLimit({
      keys: [fresh, shared],
      limit: 1,
      nowMs,
      windowMs: 60_000,
    });
    // If the limited call had already consumed `fresh`, this pair would be limited too.
    const freshStillWhole = await selection.store.incrementRateLimit({
      keys: [fresh, partner],
      limit: 1,
      nowMs,
      windowMs: 60_000,
    });

    expect(seeded.ok).toBe(true);
    expect(limited).toEqual({ ok: false, reason: "limited", resetAtMs: 1_700_000_040_000 });
    expect(freshStillWhole).toEqual({
      ok: true,
      remaining: 0,
      resetAtMs: 1_700_000_040_000,
    });
  });

  test("atomic shared rate admission passes the 100k-key clocked test with a bounded record map", async () => {
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("memory adapter must be selected in test mode");
    const windowMs = 60_000;
    const batches = 10;
    const callsPerBatch = 5_000;
    let nowMs = 1_700_000_000_000;
    let observedMaxRecords = 0;
    let admitted = 0;

    for (let batch = 0; batch < batches; batch += 1) {
      if (batch > 0) nowMs += windowMs;
      for (let index = 0; index < callsPerBatch; index += 1) {
        const key = batch * callsPerBatch + index;
        const result = await selection.store.incrementRateLimit({
          keys: [`clocked-ip-${key}`, `clocked-identity-${key}`],
          limit: 2,
          nowMs,
          windowMs,
        });
        if (result.ok) admitted += 1;
        observedMaxRecords = Math.max(
          observedMaxRecords,
          vivaSessionSecurityStoreMemoryRecordCountForTests(),
        );
      }
    }

    // 10,000 records are active at this instant; a brand-new key must be refused, not grown into.
    const overflow = await selection.store.incrementRateLimit({
      keys: ["clocked-overflow-ip", "clocked-overflow-identity"],
      limit: 2,
      nowMs,
      windowMs,
    });
    // Surviving buckets still enforce their own atomic limits.
    const lastKey = batches * callsPerBatch - 1;
    const survivorKeys = [`clocked-ip-${lastKey}`, `clocked-identity-${lastKey}`] as const;
    const survivorSecond = await selection.store.incrementRateLimit({
      keys: survivorKeys,
      limit: 2,
      nowMs,
      windowMs,
    });
    const survivorThird = await selection.store.incrementRateLimit({
      keys: survivorKeys,
      limit: 2,
      nowMs,
      windowMs,
    });

    expect(admitted).toBe(batches * callsPerBatch);
    expect(observedMaxRecords).toBe(10_000);
    expect(overflow).toEqual({ ok: false, reason: "unavailable" });
    expect(vivaSessionSecurityStoreMemoryRecordCountForTests()).toBe(10_000);
    expect(survivorSecond.ok).toBe(true);
    expect(survivorThird).toEqual({
      ok: false,
      reason: "limited",
      resetAtMs: Math.floor(nowMs / windowMs) * windowMs + windowMs,
    });
  });

  test("shared security store memory adapter prunes expired records instead of evicting active ones", async () => {
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("memory adapter must be selected in test mode");
    const windowMs = 60_000;
    const nowMs = 1_700_000_000_000;

    await selection.store.incrementRateLimit({
      keys: ["prune-ip", "prune-identity"],
      limit: 2,
      nowMs,
      windowMs,
    });
    const beforeExpiry = vivaSessionSecurityStoreMemoryRecordCountForTests();
    await selection.store.incrementRateLimit({
      keys: ["prune-next-ip", "prune-next-identity"],
      limit: 2,
      nowMs: nowMs + windowMs,
      windowMs,
    });
    const afterExpiry = vivaSessionSecurityStoreMemoryRecordCountForTests();

    expect(beforeExpiry).toBe(2);
    expect(afterExpiry).toBe(2);
  });

  test("shared security store bounds projection admission separately from mint capacity", async () => {
    process.env.VIVA_SESSION_PROJECTION_MAX_PER_MINUTE = "2";
    process.env.VIVA_SESSION_MINT_MAX_PER_MINUTE = "12";
    const identity = {
      sessionId: "server-session",
      studySetId: "biology-midterm",
      userId: "synthetic-user",
    };

    const admitted = [
      await guardVivaSessionProjectionAdmission(projectionRequest(), identity),
      await guardVivaSessionProjectionAdmission(projectionRequest(), identity),
    ];
    const limited = await guardVivaSessionProjectionAdmission(projectionRequest(), identity);
    const limitedBody = (await limited?.json()) as Record<string, unknown>;
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("memory adapter must be selected in test mode");
    const mintStillOpen = await selection.store.incrementRateLimit({
      keys: mintAdmissionKeys("203.0.113.10"),
      limit: 12,
      nowMs: Date.now(),
      windowMs: 60_000,
    });

    expect(admitted).toEqual([null, null]);
    expect(limited?.status).toBe(429);
    expect(limitedBody).toEqual({
      error: "session_projection_rate_limited",
      failure_class: "rate_limit",
      stage: "pre_loop",
    });
    expect(isBoundedRetryAfter(limited?.headers.get("retry-after"))).toBe(true);
    expect(limited?.headers.get("cache-control")).toBe("no-store");
    expect(mintStillOpen.ok).toBe(true);
  });

  test("shared security store rejects out-of-range projection limits and unavailable stores", async () => {
    const identity = {
      sessionId: "server-session",
      studySetId: "biology-midterm",
      userId: "synthetic-user",
    };
    const rejectedLimits = ["0", "601", "-3", "60.5", "sixty"];
    const observed: Array<{ body: unknown; status: number | undefined }> = [];
    for (const value of rejectedLimits) {
      resetVivaSessionSecurityStoreForTests();
      process.env.VIVA_SESSION_PROJECTION_MAX_PER_MINUTE = value;
      const response = await guardVivaSessionProjectionAdmission(projectionRequest(), identity);
      observed.push({ body: await response?.json(), status: response?.status });
    }

    resetVivaSessionSecurityStoreForTests();
    delete process.env.VIVA_SESSION_PROJECTION_MAX_PER_MINUTE;
    const defaulted = await guardVivaSessionProjectionAdmission(projectionRequest(), identity);

    restoreEnv("NODE_ENV", "production");
    const storeUnavailable = await guardVivaSessionProjectionAdmission(
      projectionRequest(),
      identity,
    );
    const storeUnavailableBody = (await storeUnavailable?.json()) as Record<string, unknown>;

    const expectedFailure = {
      body: {
        error: "viva_session_projection_unavailable",
        failure_class: "projection_unavailable",
        stage: "pre_loop",
      },
      status: 503,
    };
    expect(observed).toEqual(rejectedLimits.map(() => expectedFailure));
    expect(defaulted).toBe(null);
    expect(storeUnavailable?.status).toBe(503);
    expect(storeUnavailableBody).toEqual(expectedFailure.body);
  });
});

describe("Viva session body byte cap", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
    applySharedSecurityStoreTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("body byte cap accepts a session request at exactly 16 KiB and rejects one byte more", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;

    const atLimit = await startSession(
      streamingSessionRequest(paddedSessionPayload(16 * 1024), [4096, 1, 8191, 4096]),
    );
    resetVivaSessionSecurityStoreForTests();
    const overLimit = await startSession(
      streamingSessionRequest(paddedSessionPayload(16 * 1024 + 1), [4096, 1, 8191, 4097]),
    );
    const overBody = (await overLimit.json()) as VivaSessionRouteFailureClass;

    expect(atLimit.status).toBe(200);
    expect(overLimit.status).toBe(413);
    expect(overBody).toEqual({
      error: "viva_request_body_too_large",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "invalid",
    });
    expect(calls).toHaveLength(1);
  });

  test("multibyte body is measured in bytes, not JavaScript string length", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;

    // Four bytes per astral character: well under 16 KiB by string length, over it by bytes.
    const payload = paddedSessionPayload(16 * 1024 + 4, "\u{1F600}");
    const response = await startSession(streamingSessionRequest(payload, [8192, 4096, 4096]));
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(16 * 1024);
    expect(payload.length).toBeLessThan(16 * 1024);
    expect(response.status).toBe(413);
    expect(body.error).toBe("viva_request_body_too_large");
    expect(calls).toEqual([]);
  });

  test("body byte cap cannot be bypassed by a lying or missing content-length", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }));
    }) as typeof fetch;
    const oversized = paddedSessionPayload(16 * 1024 + 1);

    const lying = await startSession(
      streamingSessionRequest(oversized, [8192, 8193], { "content-length": "42" }),
    );
    resetVivaSessionSecurityStoreForTests();
    const absent = await startSession(streamingSessionRequest(oversized, [8192, 8193]));
    resetVivaSessionSecurityStoreForTests();
    const declaredTooLarge = await startSession(
      streamingSessionRequest(paddedSessionPayload(1024), [1024], {
        "content-length": String(64 * 1024),
      }),
    );

    expect([lying.status, absent.status, declaredTooLarge.status]).toEqual([413, 413, 413]);
    expect(calls).toEqual([]);
  });

  test("oversized upstream library response cancels the stream and returns a sanitized 502", async () => {
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        oversizedJsonStream(1024 * 1024 + 1, () => (cancelled = true)),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      )) as typeof fetch;

    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as VivaSessionRouteFailureClass;

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: "viva_upstream_response_too_large",
      failure_class: "session_bootstrap_unavailable",
      stage: "pre_loop",
      terminal_reason: "pre_loop_session_unavailable",
      token_refresh_outcome: "failed",
    });
    expect(cancelled).toBe(true);
  });

  test("body byte cap responses carry route-owned no-store, pragma, and nosniff headers", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, librarySnapshot({ startToken: signedAgentAccessToken() }))) as typeof fetch;

    const success = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    resetVivaSessionSecurityStoreForTests();
    const rejected = await startSession(
      streamingSessionRequest(paddedSessionPayload(16 * 1024 + 1), [16385]),
    );

    for (const response of [success, rejected]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

/**
 * Task 7 (`WEBAPI-009`), store half. The route half lives in `viva-library-proxy.test.ts`; this
 * suite pins the shared-store transaction primitive the route depends on, so a store that checks
 * and then inserts in two operations is caught here rather than only at the route.
 */
/**
 * Task 8A (`WEBAPI-011`), D-07 Branch A `retain-token-only`.
 *
 * The browser now holds a SEPARATE opaque refresh credential. An access token — however correctly
 * signed, however old — is never refresh authority again.
 *
 * WIRE-SHAPE NOTE: the plan's Task 8A literal types `refresh_expires_at` and
 * `session_absolute_expires_at` as `number`, but Plan 13's already-merged browser vault seam
 * (`browserSessionCredentialVaultInputFromStartResponse` in `apps/web/lib/viva-library.ts`, which
 * this lane may not edit) declares them `string` and calls `.trim()` on them — a number would throw
 * in the browser. These assertions therefore pin canonical RFC3339 UTC strings whose parsed instant
 * equals the plan's arithmetic exactly. See the lane ledger's recorded deviation.
 */
describe("Viva D-07 Branch A rotating refresh credentials", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
    applySharedSecurityStoreTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("rotating refresh credential is a 256-bit opaque value stored only as its SHA-256", async () => {
    const agentAccessToken = signedAgentAccessToken();
    globalThis.fetch = agentSnapshotFetch(() => agentAccessToken);

    const issued = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await issued.json()) as VivaSessionRouteOutcome;

    expect(issued.status).toBe(200);
    expect(body.token_refresh_outcome).toBe("issued");
    expect(body.session_token).toBe(agentAccessToken);
    const [prefix, encoded, ...rest] = body.refresh_token.split(".");
    expect(prefix).toBe("viva-refresh1");
    expect(rest).toEqual([]);
    // 32 random bytes as canonical unpadded base64url is exactly 43 characters.
    expect(/^[A-Za-z0-9_-]{43}$/.test(encoded ?? "")).toBe(true);
    expect(Buffer.from(encoded ?? "", "base64url")).toHaveLength(32);
    // Two starts never produce the same credential.
    const second = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const secondBody = (await second.json()) as VivaSessionRouteOutcome;
    expect(secondBody.refresh_token).not.toBe(body.refresh_token);

    // Only the digest is stored: the raw credential never matches a store record, its digest does.
    const store = selectedSecurityStore();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rawLookup = await store.consumeRefresh({
      credentialHash: body.refresh_token,
      identity: refreshIdentity(),
      nowSeconds,
      reservationTtlSeconds: 10,
    });
    const digestLookup = await store.consumeRefresh({
      credentialHash: sha256Hex(body.refresh_token),
      identity: refreshIdentity(),
      nowSeconds,
      reservationTtlSeconds: 10,
    });
    expect(rawLookup).toEqual({ ok: false, reason: "replayed" });
    expect(digestLookup).toMatchObject({ ok: true });
  });

  test("years-old access token cannot stand in for a rotating refresh credential", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: "should_not_call_agent" });
    }) as typeof fetch;
    const yearsOldButCorrectlySigned = signedSessionToken(
      sessionTokenClaims({
        expires_at: 1_600_000_900,
        issued_at: 1_600_000_000,
        nonce: "years-old-nonce",
        not_before: 1_600_000_000,
      }),
    );

    const rejected = await Promise.all([
      refreshSession(
        sessionRequest("/api/viva-session/refresh", {
          session_id: "server-session",
          session_token: yearsOldButCorrectlySigned,
          study_set_id: "biology-midterm",
          user_id: "synthetic-user",
        }),
      ),
      refreshSession(
        sessionRequest("/api/viva-session/refresh", {
          ...refreshPayload("viva-refresh1.unused-credential"),
          session_token: yearsOldButCorrectlySigned,
        }),
      ),
      refreshSession(sessionRequest("/api/viva-session/refresh", { session_id: "server-session" })),
    ]);
    const bodies = await Promise.all(rejected.map((response) => response.json()));

    expect(rejected.map((response) => response.status)).toEqual([400, 400, 400]);
    for (const body of bodies) {
      expect(body).toEqual({
        error: "invalid_session_request",
        failure_class: "session_bootstrap_failed",
        token_refresh_outcome: "invalid",
      });
    }
    expect(calls).toEqual([]);
  });

  test("rotating refresh credential replay revokes the replacement and returns the coarse terminal", async () => {
    let agentAccessToken = signedAgentAccessToken({ nonce: "issued-nonce" });
    globalThis.fetch = agentSnapshotFetch(() => agentAccessToken);
    const issued = await issuedCredentials();

    agentAccessToken = signedAgentAccessToken({ nonce: "rotated-nonce" });
    const rotated = await refreshSession(
      sessionRequest("/api/viva-session/refresh", refreshPayload(issued.refresh_token)),
    );
    const rotatedBody = (await rotated.json()) as VivaSessionRouteOutcome;

    expect(rotated.status).toBe(200);
    expect(rotatedBody.token_refresh_outcome).toBe("refreshed");
    expect(rotatedBody.refresh_token).not.toBe(issued.refresh_token);
    expect(rotatedBody.session_token).not.toBe(issued.session_token);
    expect(rotatedBody.session_absolute_expires_at).toBe(issued.session_absolute_expires_at);

    const replay = await refreshSession(
      sessionRequest("/api/viva-session/refresh", refreshPayload(issued.refresh_token)),
    );
    const afterReplay = await refreshSession(
      sessionRequest("/api/viva-session/refresh", refreshPayload(rotatedBody.refresh_token)),
    );

    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual(COARSE_SESSION_AUTH_TERMINAL);
    // The replacement the winning rotation issued is revoked by the replay, not merely unused.
    expect(afterReplay.status).toBe(401);
    expect(await afterReplay.json()).toEqual(COARSE_SESSION_AUTH_TERMINAL);
  });

  test("refresh race admits exactly one concurrent use of a rotating refresh credential", async () => {
    let nonce = 0;
    globalThis.fetch = agentSnapshotFetch(() => {
      nonce += 1;
      return signedAgentAccessToken({ nonce: `race-nonce-${nonce}` });
    });
    const issued = await issuedCredentials();

    const raced = await Promise.all([
      refreshSession(
        sessionRequest("/api/viva-session/refresh", refreshPayload(issued.refresh_token)),
      ),
      refreshSession(
        sessionRequest("/api/viva-session/refresh", refreshPayload(issued.refresh_token)),
      ),
    ]);
    const statuses = raced.map((response) => response.status).sort();
    const loser = raced.find((response) => response.status === 401);

    expect(statuses).toEqual([200, 401]);
    expect(await loser?.json()).toEqual(COARSE_SESSION_AUTH_TERMINAL);
  });

  test("rotating refresh credential expiry is the minimum of its TTL and the absolute lifetime", async () => {
    globalThis.fetch = agentSnapshotFetch(() => signedAgentAccessToken());
    const before = Math.floor(Date.now() / 1000);
    const issued = await issuedCredentials();
    const after = Math.floor(Date.now() / 1000);

    const refreshExpiresAt = unixSecondsFromRfc3339(issued.refresh_expires_at);
    const absoluteExpiresAt = unixSecondsFromRfc3339(issued.session_absolute_expires_at);
    expect(refreshExpiresAt).toBeGreaterThanOrEqual(before + 900);
    expect(refreshExpiresAt).toBeLessThanOrEqual(after + 900);
    expect(absoluteExpiresAt).toBeGreaterThanOrEqual(before + 21_600);
    expect(absoluteExpiresAt).toBeLessThanOrEqual(after + 21_600);
    // min(now + 900, absolute) — the 15-minute TTL is the binding one this far from the horizon.
    expect(refreshExpiresAt).toBe(Math.min(refreshExpiresAt, absoluteExpiresAt));
    expect(refreshExpiresAt).toBeLessThan(absoluteExpiresAt);
  });

  test("absolute session lifetime is fixed at issue and never extended by rotation", async () => {
    let nonce = 0;
    globalThis.fetch = agentSnapshotFetch(() => {
      nonce += 1;
      return signedAgentAccessToken({ nonce: `absolute-nonce-${nonce}` });
    });
    // A controlled clock, advanced a minute between rotations. Without it every rotation lands in
    // the same wall-clock second and a horizon that IS being extended would serialize identically.
    const realNow = Date.now;
    let clockMs = realNow();
    Date.now = () => clockMs;
    let current: VivaSessionRouteOutcome;
    let issued: VivaSessionRouteOutcome;
    let atHorizon: unknown;
    try {
      issued = await issuedCredentials();
      current = issued;
      for (let rotation = 0; rotation < 3; rotation += 1) {
        clockMs += 60_000;
        const response = await refreshSession(
          sessionRequest("/api/viva-session/refresh", refreshPayload(current.refresh_token)),
        );
        const body = (await response.json()) as VivaSessionRouteOutcome;
        expect(response.status).toBe(200);
        expect(body.session_absolute_expires_at).toBe(issued.session_absolute_expires_at);
        current = body;
      }

      // At the absolute horizon the credential is terminal, whatever its own TTL says.
      atHorizon = await selectedSecurityStore().consumeRefresh({
        credentialHash: sha256Hex(current.refresh_token),
        identity: refreshIdentity(),
        nowSeconds: unixSecondsFromRfc3339(issued.session_absolute_expires_at),
        reservationTtlSeconds: 10,
      });
    } finally {
      Date.now = realNow;
    }

    expect(unixSecondsFromRfc3339(current.refresh_expires_at)).toBeGreaterThan(
      unixSecondsFromRfc3339(issued.refresh_expires_at),
    );
    expect(atHorizon).toEqual({ ok: false, reason: "expired" });
  });

  test("rotating refresh credential rejections share one public body and distinct operator codes", async () => {
    globalThis.fetch = agentSnapshotFetch(() => signedAgentAccessToken());
    const issued = await issuedCredentials();
    const store = selectedSecurityStore();
    const nowSeconds = Math.floor(Date.now() / 1000);
    // A second identity's credential, so the identity-mismatch case is a real credential used by
    // the wrong session rather than a forged string.
    const foreign = fixtureRefreshCredential();
    await store.rotateRefresh({
      absoluteExpiresAt: nowSeconds + 21_600,
      credentialHash: sha256Hex(foreign),
      identity: {
        sessionId: "other-session",
        studySetId: "biology-midterm",
        userId: "synthetic-user",
      },
      mode: "issue",
      refreshExpiresAt: nowSeconds + 900,
    });

    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    const cases = [
      { credential: "viva-refresh1.not-canonical", label: "malformed" },
      { credential: foreign, label: "identity_mismatch" },
      { credential: fixtureRefreshCredential(), label: "replayed" },
    ];
    const observed = [];
    for (const input of cases) {
      const response = await refreshSession(
        sessionRequest("/api/viva-session/refresh", refreshPayload(input.credential)),
      );
      observed.push({ body: await response.json(), status: response.status });
    }
    // The genuinely-consumed credential: spend it, then reuse it.
    await refreshSession(
      sessionRequest("/api/viva-session/refresh", refreshPayload(issued.refresh_token)),
    );
    const replayed = await refreshSession(
      sessionRequest("/api/viva-session/refresh", refreshPayload(issued.refresh_token)),
    );
    observed.push({ body: await replayed.json(), status: replayed.status });
    console.warn = originalConsoleWarn;

    for (const entry of observed) {
      expect(entry.status).toBe(401);
      expect(entry.body).toEqual(COARSE_SESSION_AUTH_TERMINAL);
    }
    const operatorCodes = warnings
      .map((entry) => JSON.parse(entry) as { token_refresh_outcome?: string })
      .map((entry) => entry.token_refresh_outcome)
      .filter((code) => code !== undefined);
    expect(new Set(operatorCodes).size).toBeGreaterThanOrEqual(3);
    expect(operatorCodes).toContain("identity_mismatch");
    expect(operatorCodes).toContain("malformed_rejected");
    expect(operatorCodes).toContain("replayed_rejected");
    const serializedWarnings = JSON.stringify(warnings);
    expect(serializedWarnings).not.toContain(issued.refresh_token);
    expect(serializedWarnings).not.toContain(foreign);
  });

  test("rotating refresh credential is withheld when the agent mint fails", async () => {
    let agentAccessToken = signedAgentAccessToken();
    globalThis.fetch = agentSnapshotFetch(() => agentAccessToken);
    const issued = await issuedCredentials();

    globalThis.fetch = (async () => jsonResponse(502, { error: "agent_down" })) as typeof fetch;
    const failed = await refreshSession(
      sessionRequest("/api/viva-session/refresh", refreshPayload(issued.refresh_token)),
    );
    const failedBody = (await failed.json()) as Record<string, unknown>;

    expect(failed.status).toBe(502);
    expect(failedBody.refresh_token).toBeUndefined();
    expect(failedBody.session_token).toBeUndefined();

    // The reservation holds until its TTL: an immediate retry loses, a retry past the TTL wins.
    const store = selectedSecurityStore();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const duringReservation = await store.consumeRefresh({
      credentialHash: sha256Hex(issued.refresh_token),
      identity: refreshIdentity(),
      nowSeconds,
      reservationTtlSeconds: 10,
    });
    const afterReservation = await store.consumeRefresh({
      credentialHash: sha256Hex(issued.refresh_token),
      identity: refreshIdentity(),
      nowSeconds: nowSeconds + 10,
      reservationTtlSeconds: 10,
    });

    expect(duringReservation).toEqual({ ok: false, reason: "replayed" });
    expect(afterReservation).toMatchObject({ ok: true });
    agentAccessToken = signedAgentAccessToken();
  });

  test("rotating refresh credential flow exposes an agent access token only after strict verification", async () => {
    const calls: string[] = [];
    const hostile = [
      { label: "unsigned", token: "viva1.not-a-real-token" },
      {
        label: "foreign-key",
        token: signedSessionToken(
          sessionTokenClaims({ nonce: "foreign-key-nonce" }),
          "viva-fixture-unrelated-signing-secret-000",
        ),
      },
      {
        label: "wrong-identity",
        token: signedSessionToken(
          sessionTokenClaims({ nonce: "wrong-identity-nonce", user_id: "other-user" }),
        ),
      },
      {
        label: "wrong-session",
        token: signedSessionToken(
          sessionTokenClaims({ nonce: "wrong-session-nonce", session_id: "other-session" }),
        ),
      },
    ];
    const observed = [];
    for (const input of hostile) {
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return jsonResponse(200, librarySnapshot({ startToken: input.token }));
      }) as typeof fetch;
      const response = await startSession(
        sessionRequest("/api/viva-session/start", sessionStartPayload()),
      );
      const serialized = await response.text();
      observed.push({ serialized, status: response.status });
      expect(serialized).not.toContain(input.token);
    }

    expect(observed.map((entry) => entry.status)).toEqual([502, 502, 502, 502]);
    for (const entry of observed) {
      expect(JSON.parse(entry.serialized)).toEqual({
        error: "viva_session_agent_unavailable",
        failure_class: "session_bootstrap_unavailable",
        stage: "pre_loop",
        terminal_reason: "pre_loop_session_unavailable",
        token_refresh_outcome: "failed",
      });
    }
    expect(calls).toHaveLength(4);
  });

  function selectedSecurityStore(): SessionSecurityStore {
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("fixture requires a selectable bounded security store");
    return selection.store;
  }

  function refreshIdentity() {
    return {
      sessionId: "server-session",
      studySetId: "biology-midterm",
      userId: "synthetic-user",
    };
  }

  async function issuedCredentials(): Promise<VivaSessionRouteOutcome> {
    const response = await startSession(
      sessionRequest("/api/viva-session/start", sessionStartPayload()),
    );
    const body = (await response.json()) as VivaSessionRouteOutcome;
    if (response.status !== 200) {
      throw new Error(`fixture start must succeed, got ${response.status}`);
    }
    return body;
  }

  function agentSnapshotFetch(nextToken: () => string): typeof fetch {
    return (async () =>
      jsonResponse(
        200,
        librarySnapshot({ resumeToken: nextToken(), startToken: nextToken() }),
      )) as typeof fetch;
  }
});

describe("Viva destructive capability store contract", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
    applySharedSecurityStoreTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("one-time delete consumption is atomic, scope-bound, and expiry-bound in the shared store", async () => {
    const selection = vivaSessionSecurityStore();
    if (!selection.ok) throw new Error("fixture requires a selectable bounded security store");
    const store = selection.store;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const studySetScope = {
      kind: "study_set" as const,
      studySetId: "biology-midterm",
      userId: "synthetic-user",
    };

    const first = await store.revokeSession({
      capabilityExpiresAt: nowSeconds + 300,
      capabilityHash: destructiveCapabilityHash("capability-one"),
      nowSeconds,
      operation: "consume_delete_and_revoke",
      purpose: "study_set_delete",
      scope: studySetScope,
    });
    const replay = await store.revokeSession({
      capabilityExpiresAt: nowSeconds + 300,
      capabilityHash: destructiveCapabilityHash("capability-one"),
      nowSeconds,
      operation: "consume_delete_and_revoke",
      purpose: "study_set_delete",
      scope: studySetScope,
    });
    const expired = await store.revokeSession({
      capabilityExpiresAt: nowSeconds,
      capabilityHash: destructiveCapabilityHash("capability-expired"),
      nowSeconds,
      operation: "consume_delete_and_revoke",
      purpose: "study_set_delete",
      scope: studySetScope,
    });
    const wrongScope = await store.revokeSession({
      capabilityExpiresAt: nowSeconds + 300,
      capabilityHash: destructiveCapabilityHash("capability-wrong-scope"),
      nowSeconds,
      operation: "consume_delete_and_revoke",
      purpose: "study_set_delete",
      scope: {
        identity: {
          sessionId: "server-session",
          studySetId: "biology-midterm",
          userId: "synthetic-user",
        },
        kind: "session",
      },
    });
    const raced = await Promise.all(
      [0, 1].map(() =>
        store.revokeSession({
          capabilityExpiresAt: nowSeconds + 300,
          capabilityHash: destructiveCapabilityHash("capability-raced"),
          nowSeconds,
          operation: "consume_delete_and_revoke",
          purpose: "study_set_delete",
          scope: studySetScope,
        }),
      ),
    );

    expect(first).toEqual({ ok: true });
    expect(replay).toEqual({ ok: false, reason: "replayed" });
    expect(expired).toEqual({ ok: false, reason: "expired" });
    expect(wrongScope).toEqual({ ok: false, reason: "scope_mismatch" });
    expect(raced.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(raced.filter((outcome) => !outcome.ok)).toEqual([{ ok: false, reason: "replayed" }]);
  });
});

/**
 * `WEBAPI-010` — the authenticated study projection BFF.
 *
 * Every case drives the real route handler. The upstream body always starts from Plan 04's shared
 * cross-language fixture (`agent/fixtures/learning-core/study-projection-v1.json`, read only here)
 * so the BFF and the Rust producer are answering the same bytes; only the two identity fields are
 * rewritten onto the queried identity, because the plan pins the browser query and the upstream
 * URL to `biology-midterm` / `server-session` verbatim.
 */
describe("Viva authenticated study projection BFF", () => {
  beforeEach(() => {
    console.warn = () => {};
    resetVivaSessionSecurityStoreForTests();
    applyCanonicalOriginTestEnv();
    applySharedSecurityStoreTestEnv();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    globalThis.fetch = originalFetch;
    resetVivaSessionSecurityStoreForTests();
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("returns the validated v1 projection over the exact Plan 08 endpoint and header pair", async () => {
    const accessToken = signedAgentAccessToken();
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, url: String(input) });
      return jsonResponse(200, studyProjectionFixture("ready_session_with_active_question"));
    }) as typeof fetch;

    const response = await fetchStudyProjection(studyProjectionRequest({ accessToken }));
    const body = (await response.json()) as AuthenticatedStudyProjectionV1;

    expect(response.status).toBe(200);
    expect(body).toEqual(
      validateAuthenticatedStudyProjectionV1(
        studyProjectionFixture("ready_session_with_active_question"),
      ),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-allow-origin")).toBe(null);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("the projection route must contact the agent exactly once");
    expect(new URL(call.url).pathname + new URL(call.url).search).toBe(
      "/v1/study-sets/biology-midterm/projection?voice_session_id=server-session",
    );
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SCOPED_LIBRARY_READ_BEARER}`);
    expect(headers.get("x-viva-session-token")).toBe(accessToken);
    expect(headers.get("origin")).toBe(CANONICAL_WEB_ORIGIN);
    expect(call.init?.cache).toBe("no-store");
    expect(call.init?.redirect).toBe("error");
    expect(call.init?.body ?? null).toBe(null);
    expect(call.url).not.toContain(accessToken);
    expect(call.url).not.toContain(SCOPED_LIBRARY_READ_BEARER);
  });

  test("returns the smallest valid v1 case unchanged", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        200,
        studyProjectionFixture("failed_ingestion_is_reported_not_hidden"),
      )) as typeof fetch;

    const response = await fetchStudyProjection(studyProjectionRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      validateAuthenticatedStudyProjectionV1(
        studyProjectionFixture("failed_ingestion_is_reported_not_hidden"),
      ),
    );
  });

  test("refuses every unusable authorization header before the agent", async () => {
    const observed: Array<{ headers: Record<string, string>; status: number; body: unknown }> = [];
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, studyProjectionFixture("ready_session_with_active_question"));
    }) as typeof fetch;

    const cases: Array<Record<string, string>> = [
      {},
      { authorization: "" },
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: `Basic ${signedAgentAccessToken()}` },
      { authorization: `bearer  ${signedAgentAccessToken()}` },
      { authorization: `Bearer ${signedAgentAccessToken()}, Bearer ${signedAgentAccessToken()}` },
      { authorization: `Bearer ${flipOneSignatureByte(signedAgentAccessToken())}` },
      {
        authorization: `Bearer ${signedAgentAccessToken({
          expires_at: Math.floor(Date.now() / 1000) - 1,
          issued_at: Math.floor(Date.now() / 1000) - 900,
          not_before: Math.floor(Date.now() / 1000) - 900,
        })}`,
      },
      { authorization: `Bearer ${signedAgentAccessToken({ study_set_id: "other-set" })}` },
      { authorization: `Bearer ${signedAgentAccessToken({ session_id: "other-session" })}` },
      { authorization: `Bearer ${signedAgentAccessToken({ user_id: "not-allowlisted" })}` },
    ];

    for (const headers of cases) {
      const response = await fetchStudyProjection(
        studyProjectionRequest({ accessToken: null, headers }),
      );
      observed.push({ body: await response.json(), headers, status: response.status });
    }

    expect(calls).toEqual([]);
    expect(observed.map((entry) => entry.status)).toEqual(cases.map(() => 401));
    for (const entry of observed) {
      expect(entry.body).toEqual({
        error: "session_auth_terminal",
        failure_class: "session_auth_failure",
        stage: "session",
        token_refresh_outcome: "terminal",
      });
    }
  });

  test("refuses a query that is not exactly the two allowed parameters", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, studyProjectionFixture("ready_session_with_active_question"));
    }) as typeof fetch;

    const queries = [
      "study_set_id=biology-midterm",
      "voice_session_id=server-session",
      "study_set_id=biology-midterm&voice_session_id=server-session&user_id=synthetic-user",
      "study_set_id=biology-midterm&study_set_id=biology-midterm&voice_session_id=server-session",
      "study_set_id=biology-midterm&voice_session_id=server-session&voice_session_id=other",
      "study_set_id=&voice_session_id=server-session",
      "study_set_id=biology-midterm&voice_session_id=",
    ];
    const statuses: number[] = [];
    const bodies: unknown[] = [];
    for (const query of queries) {
      const response = await fetchStudyProjection(studyProjectionRequest({ query }));
      statuses.push(response.status);
      bodies.push(await response.json());
    }

    expect(calls).toEqual([]);
    expect(statuses).toEqual(queries.map(() => 400));
    for (const body of bodies) {
      expect(body).toEqual({
        error: "viva_session_projection_request_invalid",
        failure_class: "projection_unavailable",
        stage: "pre_loop",
      });
    }
  });

  test("requires a same-origin safe-read fetch context", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, studyProjectionFixture("ready_session_with_active_question"));
    }) as typeof fetch;

    const contexts: Array<Record<string, string>> = [
      {},
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
      { origin: "https://attacker.example", "sec-fetch-site": "same-origin" },
    ];
    const statuses: number[] = [];
    const bodies: unknown[] = [];
    for (const context of contexts) {
      const response = await fetchStudyProjection(
        studyProjectionRequest({ fetchSite: null, headers: context }),
      );
      statuses.push(response.status);
      bodies.push(await response.json());
    }

    expect(calls).toEqual([]);
    expect(statuses).toEqual(contexts.map(() => 403));
    for (const body of bodies) {
      expect(body).toEqual({
        error: "cross_origin_session_request",
        failure_class: "access_denied",
        stage: "pre_loop",
      });
    }
  });

  test("keeps the eight-second deadline armed through fetch, bounded read, and validation", async () => {
    const timers = captureDeadlineTimers();
    try {
      const upstreamSignals: Array<AbortSignal | undefined> = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        upstreamSignals.push(init?.signal ?? undefined);
        timers.fire(PROJECTION_UPSTREAM_TIMEOUT_MS);
        // Exactly what a real `fetch` does once its signal aborts mid-flight.
        throw new DOMException("The operation was aborted.", "AbortError");
      }) as typeof fetch;

      const duringFetch = await fetchStudyProjection(studyProjectionRequest());
      const duringFetchBody = await duringFetch.json();

      expect(timers.delays).toContain(PROJECTION_UPSTREAM_TIMEOUT_MS);
      expect(upstreamSignals[0]?.aborted).toBe(true);
      expect(duringFetch.status).toBe(504);
      expect(duringFetchBody).toEqual({
        error: "viva_session_projection_timeout",
        failure_class: "projection_unavailable",
        stage: "pre_loop",
      });

      timers.reset();
      globalThis.fetch = (async () => {
        let pulled = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!pulled) {
                pulled = true;
                controller.enqueue(new TextEncoder().encode('{"version":'));
                timers.fire(PROJECTION_UPSTREAM_TIMEOUT_MS);
              }
              // The producer stalls; the deadline has to beat the read. The quarter-second
              // backstop only exists so a route that armed NO deadline fails instead of hanging
              // the suite — it is thirty-two times shorter than the deadline under test.
              return new Promise<void>((_resolve, reject) => {
                setTimeout(() => reject(new Error("the upstream body stalled")), 250);
              });
            },
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }) as typeof fetch;

      const duringRead = await fetchStudyProjection(studyProjectionRequest());

      expect(duringRead.status).toBe(504);
      expect(await duringRead.json()).toEqual({
        error: "viva_session_projection_timeout",
        failure_class: "projection_unavailable",
        stage: "pre_loop",
      });
    } finally {
      timers.restore();
    }
  });

  test("sanitizes every malicious upstream projection body to the coarse 502", async () => {
    const cases: Array<{ body: BodyInit; name: string }> = [
      { body: oversizedProjectionBody(), name: "over one mebibyte" },
      { body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]), name: "malformed utf-8" },
      { body: '{"version": 1,', name: "malformed json" },
      {
        body: JSON.stringify({
          ...studyProjectionFixture("failed_ingestion_is_reported_not_hidden"),
          version: 2,
        }),
        name: "wrong schema version",
      },
      {
        body: JSON.stringify({
          ...studyProjectionFixture("failed_ingestion_is_reported_not_hidden"),
          rubric: "the grading rubric the learner may not see",
        }),
        name: "unknown field",
      },
      {
        body: duplicateIdentityProjectionBody(),
        name: "duplicate identity key",
      },
      {
        body: JSON.stringify(
          studyProjectionFixture("failed_ingestion_is_reported_not_hidden", {
            studySetId: "some-other-set",
          }),
        ),
        name: "identity disagrees with the verified session",
      },
      {
        body: JSON.stringify(
          studyProjectionFixture("failed_ingestion_is_reported_not_hidden", {
            sessionId: "some-other-session",
          }),
        ),
        name: "session identity disagrees with the verified session",
      },
      { body: "[]", name: "not an object" },
    ];

    const observed: Array<{ name: string; status: number; body: unknown }> = [];
    for (const entry of cases) {
      globalThis.fetch = (async () =>
        new Response(entry.body, {
          headers: { "content-type": "application/json" },
          status: 200,
        })) as typeof fetch;
      const response = await fetchStudyProjection(studyProjectionRequest());
      observed.push({ body: await response.json(), name: entry.name, status: response.status });
    }

    expect(observed.map((entry) => entry.status)).toEqual(cases.map(() => 502));
    for (const entry of observed) {
      expect(entry.body).toEqual({
        error: "viva_session_projection_unavailable",
        failure_class: "projection_unavailable",
        stage: "pre_loop",
      });
    }
  });

  test("treats any upstream credential key or value as a contract violation, not a projection", async () => {
    const logs: string[] = [];
    console.warn = (line: unknown) => {
      logs.push(String(line));
    };

    const hostile: Array<{ body: unknown; leaked: string[]; name: string }> = [
      {
        body: {
          ...studyProjectionFixture("failed_ingestion_is_reported_not_hidden"),
          session_token: "viva1.forged-projection-credential",
        },
        leaked: ["session_token", "viva1.forged-projection-credential"],
        name: "top-level credential key",
      },
      {
        body: (() => {
          const value = studyProjectionFixture("ready_session_with_active_question");
          const question = value.activeQuestion as Record<string, unknown>;
          const citations = question.sourceCitations as Array<Record<string, unknown>>;
          const citation = citations[0] as Record<string, unknown>;
          citation.api_key = "viva-fixture-upstream-api-key";
          return value;
        })(),
        leaked: ["api_key", "viva-fixture-upstream-api-key"],
        name: "deeply nested credential key",
      },
      {
        body: (() => {
          const value = studyProjectionFixture("failed_ingestion_is_reported_not_hidden");
          const studySet = value.studySet as Record<string, unknown>;
          studySet.title = "Bearer viva-fixture-upstream-leaked-credential";
          return value;
        })(),
        leaked: ["Bearer viva-fixture-upstream-leaked-credential"],
        name: "credential-shaped string leaf that would otherwise validate",
      },
      {
        body: (() => {
          const value = studyProjectionFixture("failed_ingestion_is_reported_not_hidden");
          const session = value.session as Record<string, unknown>;
          session.goal = "viva-control1.forged-capability";
          return value;
        })(),
        leaked: ["viva-control1.forged-capability"],
        name: "BFF capability prefix in a nullable string leaf",
      },
    ];

    const observed: Array<{ name: string; status: number; text: string }> = [];
    for (const entry of hostile) {
      logs.length = 0;
      globalThis.fetch = (async () => jsonResponse(200, entry.body)) as typeof fetch;
      const response = await fetchStudyProjection(studyProjectionRequest());
      const text = await response.text();
      observed.push({ name: entry.name, status: response.status, text });
      const joinedLogs = logs.join("\n");
      for (const leak of entry.leaked) {
        expect(text).not.toContain(leak);
        expect(joinedLogs).not.toContain(leak);
      }
      expect(joinedLogs).toContain("projection_upstream_credential_violation");
    }

    expect(observed.map((entry) => entry.status)).toEqual(hostile.map(() => 502));
    for (const entry of observed) {
      expect(JSON.parse(entry.text)).toEqual({
        error: "viva_session_projection_unavailable",
        failure_class: "projection_unavailable",
        stage: "pre_loop",
      });
    }
  });

  test("admits sixty projections a minute over atomic ip and session keys", async () => {
    process.env.VIVA_SESSION_PROJECTION_MAX_PER_MINUTE = "60";
    globalThis.fetch = (async () =>
      jsonResponse(
        200,
        studyProjectionFixture("ready_session_with_active_question"),
      )) as typeof fetch;

    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      const response = await fetchStudyProjection(studyProjectionRequest());
      statuses.push(response.status);
      if (index === 60) {
        expect(await response.json()).toEqual({
          error: "session_projection_rate_limited",
          failure_class: "rate_limit",
          stage: "pre_loop",
        });
        expect(isBoundedRetryAfter(response.headers.get("retry-after"))).toBe(true);
      }
    }

    expect(statuses.slice(0, 60)).toEqual(Array.from({ length: 60 }, () => 200));
    expect(statuses[60]).toBe(429);
  });

  test("fails closed with no agent contact when a public deployment has no shared store", async () => {
    restoreEnv("NODE_ENV", "production");
    delete process.env.VIVA_SESSION_SECURITY_STORE_REST_URL;
    delete process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, studyProjectionFixture("ready_session_with_active_question"));
    }) as typeof fetch;

    const response = await fetchStudyProjection(studyProjectionRequest());

    expect(calls).toEqual([]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "viva_session_projection_unavailable",
      failure_class: "projection_unavailable",
      stage: "pre_loop",
    });
    expect(response.headers.get("retry-after")).toBe(null);
  });

  test("maps every upstream status onto its recorded public projection failure", async () => {
    const cases: Array<{
      expected: { body: Record<string, unknown>; retryAfter: boolean; status: number };
      upstream: { headers?: Record<string, string>; status: number };
    }> = [
      {
        expected: {
          body: {
            error: "session_auth_terminal",
            failure_class: "session_auth_failure",
            stage: "session",
            token_refresh_outcome: "terminal",
          },
          retryAfter: false,
          status: 401,
        },
        upstream: { status: 401 },
      },
      {
        expected: {
          body: {
            error: "session_auth_terminal",
            failure_class: "session_auth_failure",
            stage: "session",
            token_refresh_outcome: "terminal",
          },
          retryAfter: false,
          status: 401,
        },
        upstream: { status: 403 },
      },
      {
        expected: {
          body: {
            error: "viva_session_projection_not_found",
            failure_class: "projection_unavailable",
            stage: "pre_loop",
          },
          retryAfter: false,
          status: 404,
        },
        upstream: { status: 404 },
      },
      {
        expected: {
          body: {
            error: "session_projection_rate_limited",
            failure_class: "rate_limit",
            stage: "pre_loop",
          },
          retryAfter: true,
          status: 429,
        },
        upstream: { headers: { "retry-after": "30" }, status: 429 },
      },
      {
        expected: {
          body: {
            error: "viva_session_projection_unavailable",
            failure_class: "projection_unavailable",
            stage: "pre_loop",
          },
          retryAfter: false,
          status: 502,
        },
        upstream: { status: 429 },
      },
      {
        expected: {
          body: {
            error: "viva_session_projection_unavailable",
            failure_class: "projection_unavailable",
            stage: "pre_loop",
          },
          retryAfter: false,
          status: 502,
        },
        upstream: { headers: { "retry-after": "0" }, status: 429 },
      },
      {
        expected: {
          body: {
            error: "viva_session_projection_unavailable",
            failure_class: "projection_unavailable",
            stage: "pre_loop",
          },
          retryAfter: false,
          status: 502,
        },
        upstream: { headers: { "retry-after": "61" }, status: 429 },
      },
      {
        expected: {
          body: {
            error: "viva_session_projection_unavailable",
            failure_class: "projection_unavailable",
            stage: "pre_loop",
          },
          retryAfter: false,
          status: 502,
        },
        upstream: { headers: { "retry-after": "1.5" }, status: 429 },
      },
      {
        expected: {
          body: {
            error: "viva_session_projection_unavailable",
            failure_class: "projection_unavailable",
            stage: "pre_loop",
          },
          retryAfter: false,
          status: 502,
        },
        upstream: { headers: { "retry-after": "Wed, 26 Aug 2026 00:00:00 GMT" }, status: 429 },
      },
      {
        expected: {
          body: {
            error: "viva_session_projection_unavailable",
            failure_class: "projection_unavailable",
            stage: "pre_loop",
          },
          retryAfter: false,
          status: 502,
        },
        upstream: { status: 500 },
      },
      {
        expected: {
          body: {
            error: "viva_session_projection_unavailable",
            failure_class: "projection_unavailable",
            stage: "pre_loop",
          },
          retryAfter: false,
          status: 502,
        },
        upstream: { status: 204 },
      },
    ];

    const observed: Array<{ body: unknown; retryAfter: string | null; status: number }> = [];
    for (const entry of cases) {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            authorization: "Bearer viva-fixture-upstream-error-detail",
            detail: "https://agent.example/internal/path",
          }),
          {
            headers: { "content-type": "application/json", ...(entry.upstream.headers ?? {}) },
            status: entry.upstream.status,
          },
        )) as typeof fetch;
      const response = await fetchStudyProjection(studyProjectionRequest());
      observed.push({
        body: await response.json(),
        retryAfter: response.headers.get("retry-after"),
        status: response.status,
      });
    }

    for (const [index, entry] of cases.entries()) {
      const actual = observed[index];
      if (!actual) throw new Error("every upstream case must produce a response");
      expect({ body: actual.body, status: actual.status }).toEqual({
        body: entry.expected.body,
        status: entry.expected.status,
      });
      if (entry.expected.retryAfter) {
        expect(actual.retryAfter).toBe("30");
      } else {
        expect(actual.retryAfter).toBe(null);
      }
      expect(JSON.stringify(actual.body)).not.toContain("viva-fixture-upstream-error-detail");
      expect(JSON.stringify(actual.body)).not.toContain("agent.example");
    }
  });

  test("cancels the upstream read and authors no late body when the client aborts", async () => {
    const client = new AbortController();
    const upstreamSignals: Array<AbortSignal | undefined> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignals.push(init?.signal ?? undefined);
      client.abort(new Error("the learner navigated away"));
      // Watching the client signal as well as the upstream one keeps a route that forwards
      // NEITHER from hanging the suite; the assertion below still proves the upstream one aborted.
      return abortableJsonResponse([init?.signal, client.signal]);
    }) as typeof fetch;

    let refused: unknown = null;
    let delivered: unknown = "the route authored a response for a caller that had gone away";
    try {
      delivered = await fetchStudyProjection(studyProjectionRequest({ signal: client.signal }));
    } catch (error) {
      refused = error;
    }

    expect(delivered).toBe("the route authored a response for a caller that had gone away");
    expect(refused instanceof Error).toBe(true);
    expect((refused as Error).message).toBe("the learner navigated away");
    expect(upstreamSignals[0]?.aborted).toBe(true);
  });

  test("keeps the projection credential detector in step with the library proxy's", () => {
    const projectionSource = readFileSync(
      new URL("../app/api/viva-session/shared.ts", import.meta.url),
      "utf8",
    );
    const librarySource = readFileSync(
      new URL("../app/api/viva-library/[[...path]]/route.ts", import.meta.url),
      "utf8",
    );

    expect(agentCredentialKeyLiterals(projectionSource)).toEqual(
      agentCredentialKeyLiterals(librarySource),
    );
    expect(agentCredentialValueMarkerLiterals(projectionSource)).toEqual(
      agentCredentialValueMarkerLiterals(librarySource),
    );
  });
});

/** The one coarse public body every D-07 Branch A refresh terminal returns. */
const COARSE_SESSION_AUTH_TERMINAL = {
  error: "session_auth_terminal",
  failure_class: "session_auth_failure",
  token_refresh_outcome: "terminal",
} as const;

/**
 * A currently-valid access token of the shape the AGENT returns. Start and refresh now verify this
 * strictly before handing it to the browser, so fixtures must sign a real one.
 */
function signedAgentAccessToken(
  overrides: Partial<Record<keyof SessionTokenClaims, unknown>> = {},
): string {
  return signedSessionToken(sessionTokenClaims(overrides));
}

/** A syntactically valid opaque refresh credential, minted locally rather than by the route. */
function fixtureRefreshCredential(): string {
  return `viva-refresh1.${randomBytes(32).toString("base64url")}`;
}

/** The exact D-07 Branch A refresh payload: four fields, no access token. */
function refreshPayload(refreshToken: string): Record<string, unknown> {
  return {
    refresh_token: refreshToken,
    session_id: "server-session",
    study_set_id: "biology-midterm",
    user_id: "synthetic-user",
  };
}

/**
 * Independent restatement of the credential-hash rule the store contract pins: the adapter only
 * ever sees SHA-256. Computed here rather than imported, so a production drift breaks the test.
 */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Parses a canonical RFC3339 UTC instant back to epoch seconds for the plan's arithmetic. */
function unixSecondsFromRfc3339(value: string): number {
  expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)).toBe(true);
  return Math.floor(Date.parse(value) / 1000);
}

function destructiveCapabilityHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

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
  process.env.VIVA_SESSION_TRUSTED_PROXY_HOPS = "1";
}

/**
 * Baseline shared-store env for the admission suites. `NODE_ENV` stays `test` here so the
 * bounded in-memory adapter is the selected one; individual cases raise it to `production` to
 * exercise the public HTTP-adapter path.
 */
function applySharedSecurityStoreTestEnv() {
  delete process.env.VIVA_SESSION_SECURITY_STORE_MODE;
  delete process.env.VIVA_SESSION_SECURITY_STORE_REST_URL;
  delete process.env.VIVA_SESSION_SECURITY_STORE_REST_TOKEN;
  delete process.env.VIVA_SESSION_PROJECTION_MAX_PER_MINUTE;
  delete process.env.VIVA_WEB_SINGLE_INSTANCE;
  restoreEnv("NODE_ENV", "test");
}

/**
 * Independent restatement of the plan's admission key formula. These hashes are computed here
 * from the documented formula, never imported from the module under test, so a production drift
 * in either key breaks the shared-bucket assertions.
 */
function mintAdmissionKeys(
  ip: string,
  userId = "synthetic-user",
  studySetId = "biology-midterm",
): readonly [string, string] {
  const sep = String.fromCharCode(0);
  return [
    createHash("sha256").update(["mint", "ip", ip].join(sep), "utf8").digest("hex"),
    createHash("sha256")
      .update(["mint", "identity", userId, studySetId].join(sep), "utf8")
      .digest("hex"),
  ] as const;
}

/** A `retry-after` must be whole seconds inside the one-minute admission window, never a raw key. */
function isBoundedRetryAfter(value: string | null | undefined): boolean {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return false;
  const seconds = Number.parseInt(value, 10);
  return seconds >= 1 && seconds <= 60;
}

function isCanonicalUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/**
 * A valid start payload padded to an exact byte budget with a filler claim. The padding lives in
 * an unknown top-level field so the request stays structurally valid JSON; the byte cap must fire
 * before any parsing decides what to do with it.
 */
function paddedSessionPayload(totalBytes: number, fillChar = "a"): string {
  const base = { ...sessionStartPayload(), padding: "" };
  const encoder = new TextEncoder();
  const overhead = encoder.encode(JSON.stringify(base)).byteLength;
  const fillerBytes = encoder.encode(fillChar).byteLength;
  const remaining = Math.max(0, totalBytes - overhead);
  const payload = JSON.stringify({
    ...base,
    padding: fillChar.repeat(Math.ceil(remaining / fillerBytes)),
  });
  return payload;
}

/** Streams a body in the given chunk sizes, so the cap is proven against a stream, not a string. */
function streamingSessionRequest(
  payload: string,
  chunkSizes: readonly number[],
  headers: Record<string, string> = {},
): NextRequest {
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  let chunkIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      // Uneven chunks, cycled, so no boundary lines up with the cap.
      const size = chunkSizes[chunkIndex % chunkSizes.length] ?? bytes.byteLength;
      chunkIndex += 1;
      const take = Math.min(Math.max(1, size), bytes.byteLength - offset);
      controller.enqueue(bytes.slice(offset, offset + take));
      offset += take;
    },
  });
  const requestHeaders = new Headers({
    "content-type": "application/json",
    host: "web.example",
    origin: "https://web.example",
    "x-forwarded-for": "203.0.113.10",
    ...headers,
  });
  const request = new Request("https://web.example/api/viva-session/start", {
    body,
    duplex: "half",
    headers: requestHeaders,
    method: "POST",
  } as RequestInit & { duplex: "half" }) as unknown as NextRequest;
  Object.defineProperty(request, "nextUrl", {
    value: new URL("https://web.example/api/viva-session/start"),
  });
  return request;
}

function oversizedJsonStream(totalBytes: number, onCancel: () => void): ReadableStream<Uint8Array> {
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

function projectionRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: new Headers({ "x-forwarded-for": "203.0.113.10", ...headers }),
    method: "GET",
    nextUrl: new URL(
      "https://web.example/api/viva-session/projection?study_set_id=biology-midterm&voice_session_id=server-session",
    ),
  } as unknown as NextRequest;
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
  options: { omitHeaders?: readonly string[] } = {},
): NextRequest {
  const requestHeaders = new Headers({
    "content-type": "application/json",
    host: "web.example",
    origin: "https://web.example",
    "x-forwarded-for": "203.0.113.10",
    ...headers,
  });
  for (const name of options.omitHeaders ?? []) requestHeaders.delete(name);
  const request = new Request(`https://web.example${path}`, {
    body: JSON.stringify(body),
    headers: requestHeaders,
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
  userId = "synthetic-user",
}: {
  conceptCount?: number;
  ingestionStatus?: "pending" | "processing" | "ready" | "failed" | "retry";
  questionCount?: number;
  resumeToken?: string;
  startAvailable?: boolean;
  startToken?: string;
  unavailableReason?: string;
  userId?: string;
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
                session_token: startToken ?? signedAgentAccessToken(),
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
        user_id: userId,
      },
    ],
    user_id: userId,
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

/**
 * Plan 04's shared cross-language study-projection fixture, read only. Plan 11 consumes it exactly
 * as Plan 05's token vectors are consumed: never edited, never re-derived, and reported by path in
 * the Task 11 handoff.
 */
const PLAN_04_STUDY_PROJECTION_FIXTURE_PATH =
  "agent/fixtures/learning-core/study-projection-v1.json";
const planFourStudyProjectionFixture = JSON.parse(
  readFileSync(
    new URL(`../../../${PLAN_04_STUDY_PROJECTION_FIXTURE_PATH}`, import.meta.url),
    "utf8",
  ),
) as { projections: Record<string, Record<string, unknown>>; schema: string };

/** The identity the plan pins into both the browser query and the upstream URL, verbatim. */
const PROJECTION_STUDY_SET_ID = "biology-midterm";
const PROJECTION_SESSION_ID = "server-session";
const PROJECTION_QUERY = `study_set_id=${PROJECTION_STUDY_SET_ID}&voice_session_id=${PROJECTION_SESSION_ID}`;
/**
 * Restated here from the plan rather than imported, so a production drift off the eight-second
 * deadline breaks the test instead of silently redefining it.
 */
const PROJECTION_UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * One fixture case, deep-copied, with only its two identity fields rewritten onto the queried
 * identity. Nothing else about Plan 04's bytes is touched: the shapes, the nesting, the citation
 * confidences, and the review-schedule authority all stay exactly as the shared fixture states.
 */
function studyProjectionFixture(
  name: string,
  overrides: { sessionId?: string; studySetId?: string } = {},
): Record<string, unknown> {
  const source = planFourStudyProjectionFixture.projections[name];
  if (!source) {
    throw new Error(`Plan 04 study projection fixture is missing case ${name}`);
  }
  const value = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  (value.studySet as Record<string, unknown>).id = overrides.studySetId ?? PROJECTION_STUDY_SET_ID;
  (value.session as Record<string, unknown>).id = overrides.sessionId ?? PROJECTION_SESSION_ID;
  return value;
}

function studyProjectionRequest(
  options: {
    accessToken?: string | null;
    fetchSite?: string | null;
    headers?: Record<string, string>;
    query?: string;
    signal?: AbortSignal;
  } = {},
): NextRequest {
  const accessToken =
    options.accessToken === undefined ? signedAgentAccessToken() : options.accessToken;
  const fetchSite = options.fetchSite === undefined ? "same-origin" : options.fetchSite;
  const headers = new Headers({ "x-forwarded-for": "203.0.113.10" });
  if (accessToken !== null) headers.set("authorization", `Bearer ${accessToken}`);
  if (fetchSite !== null) headers.set("sec-fetch-site", fetchSite);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  return {
    headers,
    method: "GET",
    nextUrl: new URL(
      `${CANONICAL_WEB_ORIGIN}/api/viva-session/projection?${options.query ?? PROJECTION_QUERY}`,
    ),
    ...(options.signal ? { signal: options.signal } : {}),
  } as unknown as NextRequest;
}

/**
 * Records every `setTimeout` delay the route arms and lets one be fired on demand, so the exact
 * eight-second deadline is asserted as a value AND its expiry is observed at a chosen moment —
 * without a test that actually waits eight seconds.
 */
function captureDeadlineTimers(): {
  delays: number[];
  fire(delayMs: number): void;
  reset(): void;
  restore(): void;
} {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  let pending: Array<{ delay: number; fire: () => void; id: ReturnType<typeof setTimeout> }> = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = (originalSetTimeout as (...rest: unknown[]) => ReturnType<typeof setTimeout>)(
      handler,
      delay,
      ...args,
    );
    if (typeof handler === "function" && typeof delay === "number") {
      delays.push(delay);
      pending.push({ delay, fire: () => (handler as () => void)(), id });
    }
    return id;
  }) as unknown as typeof globalThis.setTimeout;
  return {
    delays,
    fire(delayMs: number) {
      const matched = pending.filter((entry) => entry.delay === delayMs);
      pending = pending.filter((entry) => entry.delay !== delayMs);
      for (const entry of matched) {
        clearTimeout(entry.id);
        entry.fire();
      }
    },
    reset() {
      for (const entry of pending) clearTimeout(entry.id);
      pending = [];
      delays.length = 0;
    },
    restore() {
      for (const entry of pending) clearTimeout(entry.id);
      pending = [];
      globalThis.setTimeout = originalSetTimeout;
    },
  };
}

/** Streams one byte past the projection response budget in uneven chunks, never prebuilt. */
function oversizedProjectionBody(): ReadableStream<Uint8Array> {
  const limit = 1 * 1024 * 1024;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > limit) {
        controller.close();
        return;
      }
      const size = Math.min(4_096 + (sent % 97), limit + 1 - sent);
      controller.enqueue(new Uint8Array(size).fill(0x20));
      sent += size;
    },
  });
}

/** A syntactically valid JSON document whose identity object is stated twice. */
function duplicateIdentityProjectionBody(): string {
  const serialized = JSON.stringify(
    studyProjectionFixture("failed_ingestion_is_reported_not_hidden"),
  );
  return `${serialized.slice(0, -1)},"session":{"id":"${PROJECTION_SESSION_ID}","mode":"quiz","goal":null}}`;
}

/** A body that never arrives and errors as soon as any of the given signals aborts. */
function abortableJsonResponse(signals: Array<AbortSignal | null | undefined>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const cancel = () => {
          try {
            controller.error(new Error("upstream cancelled"));
          } catch {
            // The stream was already errored by the first signal to fire.
          }
        };
        for (const signal of signals) {
          if (!signal) continue;
          if (signal.aborted) {
            cancel();
            return;
          }
          signal.addEventListener("abort", cancel, { once: true });
        }
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

function agentCredentialKeyLiterals(source: string): string[] {
  return sourceArrayLiterals(source, "AGENT_CREDENTIAL_KEYS");
}

function agentCredentialValueMarkerLiterals(source: string): string[] {
  return sourceArrayLiterals(source, "AGENT_CREDENTIAL_VALUE_MARKERS");
}

/** Reads one declared array literal out of a source file so two copies cannot drift apart. */
function sourceArrayLiterals(source: string, name: string): string[] {
  const declaration = source.indexOf(`const ${name}`);
  if (declaration < 0) throw new Error(`source must declare ${name}`);
  const open = source.indexOf("[", declaration);
  const close = source.indexOf("]", open);
  if (open < 0 || close < 0) throw new Error(`${name} must be declared as an array literal`);
  return [...source.slice(open, close).matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
}
