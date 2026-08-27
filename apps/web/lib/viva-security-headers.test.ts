import * as bunTest from "bun:test";
import type { NextRequest } from "next/server";
import authDecision from "../../../agent/fixtures/voice-protocol/v5/auth-decision.json" with {
  type: "json",
};
import { config, proxy } from "../proxy";

const { afterEach, beforeEach, describe, expect, test } = bunTest as typeof bunTest & {
  afterEach: (fn: () => void) => void;
  beforeEach: (fn: () => void) => void;
};

const originalEnv = {
  NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL,
  NEXT_PUBLIC_VIVA_AGENT_WS_URL: process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL,
  NODE_ENV: process.env.NODE_ENV,
};

const AGENT_HTTPS_ORIGIN = "https://agent.example";
const AGENT_WSS_ORIGIN = "wss://agent.example";

/**
 * `WEBAPI-015` — server-mode nonce CSP and the fixed defense header set.
 *
 * These are owner-local unit assertions over the real `proxy` export and the real matcher it
 * ships. Plan 15 owns the downstream proof on a built, served page: `bun --cwd apps/web run build`
 * plus `bun run e2e:browser`, fetching a rendered page twice and inspecting the actual response
 * headers rather than any source string.
 */
describe("Viva server-mode security headers", () => {
  beforeEach(() => {
    restoreEnv("NODE_ENV", "production");
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = AGENT_HTTPS_ORIGIN;
    process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = AGENT_WSS_ORIGIN;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) restoreEnv(name, value);
  });

  test("mints a fresh 128-bit nonce for every request and states it in request and response", () => {
    const first = proxy(serverPageRequest());
    const second = proxy(serverPageRequest());

    const firstResponseCsp = responseCsp(first);
    const secondResponseCsp = responseCsp(second);
    const firstNonce = nonceFromCsp(firstResponseCsp);
    const secondNonce = nonceFromCsp(secondResponseCsp);

    // 16 random bytes as base64 is 24 characters including one "=" pad.
    expect(atob(firstNonce).length).toBe(16);
    expect(atob(secondNonce).length).toBe(16);
    expect(firstNonce).not.toBe(secondNonce);

    // The forwarded REQUEST carries the same policy and the bare nonce, so Next can nonce its own
    // framework and inline scripts against the exact policy the browser will enforce.
    expect(forwardedRequestHeader(first, "content-security-policy")).toBe(firstResponseCsp);
    expect(forwardedRequestHeader(first, "x-nonce")).toBe(firstNonce);
    expect(forwardedRequestHeader(second, "x-nonce")).toBe(secondNonce);
    expect(firstResponseCsp).not.toContain("\n");
    expect(firstResponseCsp).not.toContain("  ");
  });

  test("scripts run only from self, this response's nonce, and what that nonce loads", () => {
    const response = proxy(serverPageRequest());
    const csp = responseCsp(response);
    const scriptSrc = directive(csp, "script-src");

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain(`'nonce-${nonceFromCsp(csp)}'`);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  test("allows inline style attributes explicitly and no stylesheet or font host but Google Fonts", () => {
    const csp = responseCsp(proxy(serverPageRequest()));

    expect(directive(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
    expect(directive(csp, "style-src")).toBe("style-src 'self' https://fonts.googleapis.com");
    expect(directive(csp, "font-src")).toBe("font-src 'self' https://fonts.gstatic.com");
  });

  test("connect-src admits only self plus the validated direct-agent origins", () => {
    expect(authDecision.branch).toBe("retain-token-only");
    expect(authDecision.direct_browser_wss).toBe(true);

    const csp = responseCsp(proxy(serverPageRequest()));

    expect(directive(csp, "connect-src")).toBe(
      `connect-src 'self' ${AGENT_HTTPS_ORIGIN} ${AGENT_WSS_ORIGIN}`,
    );
  });

  test("refuses every unusable agent origin instead of emitting or reflecting it", () => {
    const rejected = [
      "https://agent.example/socket",
      "https://agent.example/?tenant=1",
      "https://agent.example/#fragment",
      "https://viva:hunter2@agent.example",
      "http://agent.example",
      "ftp://agent.example",
      "agent.example",
      "",
      "   ",
    ];

    for (const value of rejected) {
      process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = value;
      process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = value;
      const csp = responseCsp(proxy(serverPageRequest()));
      expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
      expect(csp).not.toContain("agent.example");
      expect(csp).not.toContain("hunter2");
    }
  });

  test("admits loopback agent origins only over the insecure schemes a dev host uses", () => {
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "http://127.0.0.1:8080";
    process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = "ws://127.0.0.1:8080";

    expect(directive(responseCsp(proxy(serverPageRequest())), "connect-src")).toBe(
      "connect-src 'self' http://127.0.0.1:8080 ws://127.0.0.1:8080",
    );
  });

  test("states one copy of an origin both agent envs name", () => {
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = AGENT_HTTPS_ORIGIN;
    process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = AGENT_HTTPS_ORIGIN;

    expect(directive(responseCsp(proxy(serverPageRequest())), "connect-src")).toBe(
      `connect-src 'self' ${AGENT_HTTPS_ORIGIN}`,
    );
  });

  test("pins the fixed CSP floor every server page gets", () => {
    const csp = responseCsp(proxy(serverPageRequest()));

    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "worker-src")).toBe("worker-src 'self' blob:");
  });

  test("allows eval only in development, never in production", () => {
    restoreEnv("NODE_ENV", "development");
    const development = responseCsp(proxy(serverPageRequest()));
    restoreEnv("NODE_ENV", "production");
    const production = responseCsp(proxy(serverPageRequest()));

    expect(directive(development, "script-src")).toContain("'unsafe-eval'");
    expect(directive(production, "script-src")).not.toContain("'unsafe-eval'");
  });

  test("adds HSTS over https and never over an http loopback host", () => {
    const secure = proxy(serverPageRequest("https://web.example/session"));
    const loopback = proxy(serverPageRequest("http://localhost:3000/session"));

    expect(secure.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(loopback.headers.get("strict-transport-security")).toBe(null);
  });

  test("every server route carries the fixed defense header set", () => {
    for (const path of ["/", "/session", "/library/biology-midterm"]) {
      const response = proxy(serverPageRequest(`https://web.example${path}`));
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("permissions-policy")).toBe(
        "microphone=(self), camera=(), geolocation=()",
      );
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    }
  });

  test("the shipped matcher runs on pages and never on the API or build assets", () => {
    expect(config.matcher).toHaveLength(1);
    const matched = matcherPattern();

    for (const path of ["/", "/session", "/library/biology-midterm", "/study/set-1/review"]) {
      expect({ matched: matched.test(path), path }).toEqual({ matched: true, path });
    }
    for (const path of [
      "/api",
      "/api/viva-session/projection",
      "/api/viva-library/study-sets/library",
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
      "/manifest.webmanifest",
      "/apple-touch-icon.png",
    ]) {
      expect({ matched: matched.test(path), path }).toEqual({ matched: false, path });
    }
  });

  test("never sets the no-store headers the API routes own for themselves", () => {
    // The proxy is a page-response policy. Cache directives on API responses stay with the route
    // handlers that know whether a body is cacheable; a blanket no-store here would hide that.
    const response = proxy(serverPageRequest());
    expect(response.headers.get("cache-control")).toBe(null);
    expect(response.headers.get("pragma")).toBe(null);
  });
});

function serverPageRequest(url = "https://web.example/session"): NextRequest {
  return {
    headers: new Headers(),
    method: "GET",
    nextUrl: new URL(url),
    url,
  } as unknown as NextRequest;
}

function responseCsp(response: Response): string {
  const value = response.headers.get("content-security-policy");
  if (!value) throw new Error("every proxied server response must carry a content security policy");
  return value;
}

/**
 * `NextResponse.next({ request: { headers } })` forwards request headers by encoding them as
 * `x-middleware-request-<name>` on the response, which is exactly what Next reads back before
 * rendering. Reading them here is reading the real forwarded value, not a stand-in.
 */
function forwardedRequestHeader(response: Response, name: string): string | null {
  const overridden = response.headers.get("x-middleware-override-headers")?.split(",") ?? [];
  if (!overridden.includes(name)) return null;
  return response.headers.get(`x-middleware-request-${name}`);
}

function nonceFromCsp(csp: string): string {
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  if (!nonce) throw new Error("the policy must carry exactly one nonce source");
  return nonce;
}

function directive(csp: string, name: string): string {
  const found = csp
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry === name || entry.startsWith(`${name} `));
  if (found.length !== 1) {
    throw new Error(`the policy must state ${name} exactly once, saw ${found.length}`);
  }
  return found[0] as string;
}

/**
 * The shipped matcher is a bare negative-lookahead path pattern, which Next's path-to-regexp
 * layer and this anchored `RegExp` agree on. Testing the shipped string is the point: a matcher
 * that stopped excluding `/api` would silently wrap the BFF's own responses.
 */
function matcherPattern(): RegExp {
  const [matcher] = config.matcher;
  if (typeof matcher !== "string") throw new Error("the proxy must ship one string matcher");
  return new RegExp(`^${matcher}$`);
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
