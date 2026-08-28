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

  test("allows inline style attributes explicitly and limits font hosts to Google Fonts", () => {
    const csp = responseCsp(proxy(serverPageRequest()));

    expect(directive(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
    expect(directive(csp, "font-src")).toBe("font-src 'self' https://fonts.gstatic.com");
  });

  /**
   * `A-32` — lane 12's measurement found the 35 real-run CSP console violations were exclusively
   * Next's own framework-injected `<style>` elements (framework CSS-in-JS insertion on the
   * A-30 dynamic routes), never a mounted-UI stylesheet. `style-src-attr 'unsafe-inline'` above
   * already covers React style attributes, so the fix is to carry this response's EXISTING nonce
   * onto `style-src` too — never to relax it with `'unsafe-inline'`, which is explicitly rejected.
   */
  test("carries this response's nonce on style-src, alongside Google Fonts, never unsafe-inline [A-32]", () => {
    const csp = responseCsp(proxy(serverPageRequest()));
    const nonce = nonceFromCsp(directive(csp, "script-src"));
    const styleSrc = directive(csp, "style-src");

    expect(styleSrc).toBe(`style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`);
    expect(styleSrc).not.toContain("'unsafe-inline'");
  });

  test("connect-src admits only self plus the validated direct-agent origins", () => {
    expect(authDecision.branch).toBe("retain-token-only");
    expect(authDecision.direct_browser_wss).toBe(true);

    const csp = responseCsp(proxy(serverPageRequest()));

    expect(directive(csp, "connect-src")).toBe(
      `connect-src 'self' ${AGENT_HTTPS_ORIGIN} ${AGENT_WSS_ORIGIN}`,
    );
  });

  /**
   * `A-42`/`W-07` — the live blocker the harness's two full-matrix reproductions isolated.
   *
   * Every consumer configures the socket endpoint with its path: `.env.example` and the
   * deployment runbook both ship `…/ws`, `vivaAgentWsUrl` hands that exact string to
   * `new WebSocket(...)`, and `vivaApiBaseUrl` derives the REST base by stripping the trailing
   * `/ws` from it. Refusing a path here dropped the socket source silently — the policy still
   * looked well-formed, and the browser refused the session's only transport with
   * `Connecting to 'ws://127.0.0.1:38877/ws' violates … "connect-src 'self' http://127.0.0.1:38877"`.
   *
   * A-42 item 2 orders the shape: the value "must carry exactly the configured socket URL's
   * origin+path shape, never a broadened wildcard". A CSP host-source takes a `path-part`, so the
   * emitted source is the origin AND the path — the narrowest source that admits the one endpoint
   * the browser opens: never a wildcard host, never a bare `ws:`/`wss:` scheme source, never a
   * sibling path on that origin, and never anything the operator did not already name.
   */
  test("admits the path-suffixed agent socket URL every consumer configures [A-42/W-07]", () => {
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "http://127.0.0.1:38877";
    process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = "ws://127.0.0.1:38877/ws";

    const csp = responseCsp(proxy(serverPageRequest()));
    const connectSrc = directive(csp, "connect-src");

    expect(connectSrc).toBe("connect-src 'self' http://127.0.0.1:38877 ws://127.0.0.1:38877/ws");
    // The path admitted the value; it never widened it.
    expect(connectSrc).not.toContain("*");
    expect(connectSrc.split(" ")).not.toContain("ws:");
    expect(connectSrc.split(" ")).not.toContain("wss:");
  });

  test("admits the public path-suffixed socket origin the runbook documents [A-42/W-07]", () => {
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://agent.viva.example.com";
    process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = "wss://agent.viva.example.com/ws";

    // One host, two sources: the two envs name the same host over different schemes, and the
    // socket source carries the endpoint path the runbook documents.
    expect(directive(responseCsp(proxy(serverPageRequest())), "connect-src")).toBe(
      "connect-src 'self' https://agent.viva.example.com wss://agent.viva.example.com/ws",
    );
  });

  /**
   * `A-42` item 2 — "exactly the configured socket URL's origin+path shape, NEVER a broadened
   * wildcard". The socket source is a `path-part` host-source, so it admits the one endpoint the
   * operator configured and no sibling path on that origin; emitting the bare origin instead
   * would be strictly broader than the ordered shape, in the direction the order warns against.
   */
  test("states the socket endpoint exactly, never the whole origin around it [A-42/W-07]", () => {
    for (const socket of [
      "wss://agent.viva.example.com/ws",
      "wss://agent.viva.example.com/agent/v1/socket",
      "ws://127.0.0.1:4318/ws",
    ]) {
      restoreEnv("NEXT_PUBLIC_VIVA_AGENT_HTTP_URL", undefined);
      process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = socket;

      const connectSrc = directive(responseCsp(proxy(serverPageRequest())), "connect-src");

      // The whole source list is `'self'` plus this one endpoint, spelled exactly as configured.
      expect(connectSrc).toBe(`connect-src 'self' ${socket}`);
      // And the origin around it is NOT a source, so no sibling path rides in on it.
      expect(connectSrc.split(" ")).not.toContain(new URL(socket).origin);
    }
  });

  /**
   * The two agent envs are different KINDS of value, so they contribute different shapes.
   * `NEXT_PUBLIC_VIVA_AGENT_HTTP_URL` is a BASE — `vivaAgentHttpBaseUrl` trims its trailing slash
   * and every caller concatenates a request path onto it, and the deployment runbook documents it
   * as "the public agent origin" — so a `path-part` there would refuse every request the app
   * actually makes. It contributes its ORIGIN. Only the socket env names one endpoint opened
   * verbatim, and only it carries a path into the policy.
   */
  test("contributes the HTTP env's origin, because that env is a base and not an endpoint", () => {
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://agent.viva.example.com/api";
    restoreEnv("NEXT_PUBLIC_VIVA_AGENT_WS_URL", undefined);

    const connectSrc = directive(responseCsp(proxy(serverPageRequest())), "connect-src");

    expect(connectSrc).toBe("connect-src 'self' https://agent.viva.example.com");
    // A base URL's own path is not a `path-part`: `…/api/v1/readiness` has to stay admitted.
    expect(connectSrc).not.toContain("/api");
  });

  test("refuses every unusable agent origin instead of emitting or reflecting it", () => {
    const rejected = [
      "https://agent.example/?tenant=1",
      "https://agent.example/#fragment",
      "https://viva:hunter2@agent.example",
      "http://agent.example",
      "ftp://agent.example",
      "agent.example",
      "",
      "   ",
      // `A-42`: admitting a path admits ONLY a path. Every other disqualification still holds
      // when the value carries one, and a cross-origin or garbage value is still refused.
      "https://viva:hunter2@agent.example/ws",
      "https://agent.example/ws?tenant=1",
      "https://agent.example/ws#fragment",
      "http://agent.example/ws",
      "ftp://agent.example/ws",
      "agent.example/ws",
      "/ws",
      "ws:///ws",
      "https://agent.example:443/ws",
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

  /**
   * `A-42`: the admitted path is never a channel for a second host. The operator's own path is
   * emitted verbatim — that is the ordered origin+path shape — so the guarantee to pin is not
   * that the string is absent but that CSP can only ever read it as a `path-part`: every emitted
   * source resolves to the host the operator named. Userinfo that spells a host is refused
   * outright, so there the string is absent from the policy entirely.
   */
  test("never admits a host the socket URL's path or userinfo merely spells [A-42]", () => {
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "http://127.0.0.1:38877";
    process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = "ws://127.0.0.1:38877/ws/evil.example";

    const pathSmuggled = responseCsp(proxy(serverPageRequest()));
    const smuggledSources = directive(pathSmuggled, "connect-src");
    expect(smuggledSources).toBe(
      "connect-src 'self' http://127.0.0.1:38877 ws://127.0.0.1:38877/ws/evil.example",
    );
    for (const source of smuggledSources.split(" ").slice(2)) {
      expect(new URL(source).host).toBe("127.0.0.1:38877");
    }

    process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = "ws://evil.example@127.0.0.1:38877/ws";

    const userinfoSmuggled = responseCsp(proxy(serverPageRequest()));
    expect(directive(userinfoSmuggled, "connect-src")).toBe(
      "connect-src 'self' http://127.0.0.1:38877",
    );
    expect(userinfoSmuggled).not.toContain("evil.example");
  });

  test("admits loopback agent origins only over the insecure schemes a dev host uses", () => {
    process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "http://127.0.0.1:8080";
    process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = "ws://127.0.0.1:8080";

    expect(directive(responseCsp(proxy(serverPageRequest())), "connect-src")).toBe(
      "connect-src 'self' http://127.0.0.1:8080 ws://127.0.0.1:8080",
    );
  });

  /**
   * The insecure-scheme allowance exists only because loopback traffic never leaves the machine,
   * so it must be spent on hosts that ARE loopback and on nothing that merely reads like one.
   * `127.0.0.1.evil.example` is an ordinary registrable name whose first label happens to be
   * `127`, and `localhost.evil.example` likewise; both resolve wherever their owner points them.
   */
  test("refuses a public host that only spells the loopback prefix, over either scheme", () => {
    for (const value of [
      "http://127.0.0.1.evil.example",
      "http://127.0.0.1.evil.example:38877",
      "ws://127.0.0.1.evil.example/ws",
      "ws://127.0.0.1.evil.example:38877/ws",
      "http://127.example",
      "ws://127.0.0.1x/ws",
      "http://localhost.evil.example",
      "ws://localhost.evil.example/ws",
    ]) {
      process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = value;
      process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = value;

      const csp = responseCsp(proxy(serverPageRequest()));
      expect({ connectSrc: directive(csp, "connect-src"), value }).toEqual({
        connectSrc: "connect-src 'self'",
        value,
      });
      expect(csp).not.toContain("evil.example");
    }
  });

  /**
   * The counterweight to the test above: narrowing the loopback check must not narrow it past the
   * hosts a dev machine really serves on — all of `127.0.0.0/8`, `localhost`, and IPv6 `[::1]`.
   */
  test("still admits every genuine loopback host a dev machine serves on", () => {
    for (const [http, ws] of [
      ["http://127.0.0.1:4318", "ws://127.0.0.1:4318/ws"],
      ["http://127.0.0.2:4318", "ws://127.0.0.2:4318/ws"],
      ["http://127.255.255.254:4318", "ws://127.255.255.254:4318/ws"],
      ["http://localhost:4318", "ws://localhost:4318/ws"],
      ["http://[::1]:4318", "ws://[::1]:4318/ws"],
    ] as const) {
      process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = http;
      process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL = ws;

      expect(directive(responseCsp(proxy(serverPageRequest())), "connect-src")).toBe(
        `connect-src 'self' ${http} ${ws}`,
      );
    }
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
