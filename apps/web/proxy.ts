import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import authDecision from "../../agent/fixtures/voice-protocol/v5/auth-decision.json" with {
  type: "json",
};

/**
 * `WEBAPI-015` — server-mode nonce CSP and the fixed defense header set.
 *
 * Next 16 runs this file on the Node.js runtime for every request the matcher admits. Each request
 * gets its own 128-bit nonce, stated in the policy on the response AND on the forwarded request,
 * so Next nonces its framework and inline scripts against the very policy the browser enforces.
 * Two requests never share a nonce; a shared one would let a script injected into one response
 * execute inside another.
 *
 * `output: "export"` cannot produce any of this — a static artifact has no request to nonce and no
 * server to run the web-owned API routes. Plan 14 exclusively owns `next.config.ts` and must
 * select a server-mode build; Plan 15 owns the built-and-served proof.
 */
const NONCE_BYTES = 16;

/** Until the asset lane self-hosts them, these are the only third-party asset hosts. */
const GOOGLE_FONTS_STYLESHEET_HOST = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILE_HOST = "https://fonts.gstatic.com";

const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";

/**
 * The fixed defense set, applied to every server route the matcher admits.
 *
 * `microphone=(self)` is the one capability this product needs and the reason the list is written
 * out rather than defaulted: a blanket `microphone=()` would break the voice session, and a
 * blanket `microphone=*` would hand it to any embedded third party.
 */
const DEFENSE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["referrer-policy", "no-referrer"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["permissions-policy", "microphone=(self), camera=(), geolocation=()"],
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-resource-policy", "same-origin"],
];

/**
 * D-07 is read from Plan 05's published decision, never inferred from the deployment environment.
 * Only the recorded Branch A — `retain-token-only` with direct browser transport — admits the two
 * public agent origins; every other value, including a decision file this build did not expect,
 * falls back to `connect-src 'self'` and the browser cannot reach the agent directly at all.
 */
const DIRECT_AGENT_TRANSPORT_RECORDED =
  authDecision.decision === "D-07 TOKEN_ONLY_REFRESH" &&
  authDecision.branch === "retain-token-only" &&
  authDecision.direct_browser_wss === true;

export function proxy(request: NextRequest): NextResponse {
  const nonce = randomBytes(NONCE_BYTES).toString("base64");
  const policy = contentSecurityPolicy(nonce);

  const forwarded = new Headers(request.headers);
  forwarded.set("content-security-policy", policy);
  forwarded.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set("content-security-policy", policy);
  for (const [name, value] of DEFENSE_HEADERS) response.headers.set(name, value);
  if (request.nextUrl.protocol === "https:") {
    response.headers.set("strict-transport-security", HSTS_VALUE);
  }
  return response;
}

/**
 * Every server route except the API, the build assets, and the metadata files.
 *
 * The API exclusion is load-bearing: `apps/web/app/api/**` authors its own `cache-control:
 * no-store` / `pragma: no-cache` / `x-content-type-options: nosniff` set from one route-owned
 * allowlist, and those handlers — not a page-response policy — are what know whether a body is
 * cacheable.
 */
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.webmanifest|apple-touch-icon\\.png|icon\\.png|opengraph-image).*)",
  ],
};

/**
 * One line, one space between sources, no trailing separator. A policy that reached the browser
 * with an embedded newline would be truncated at the newline and silently enforce only its head.
 */
function contentSecurityPolicy(nonce: string): string {
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  // Turbopack's dev-mode HMR client evaluates code; a production bundle never does.
  if (process.env.NODE_ENV === "development") scriptSources.push("'unsafe-eval'");

  return [
    ["default-src", "'self'"],
    ["base-uri", "'self'"],
    ["object-src", "'none'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ["frame-src", "'none'"],
    ["script-src", ...scriptSources],
    ["style-src", "'self'", GOOGLE_FONTS_STYLESHEET_HOST],
    // Mounted UI sets React style attributes, which are inline styles the browser attributes to
    // the element rather than to a nonce. Stating it as its own directive keeps `style-src` free
    // of `'unsafe-inline'`, so a stylesheet still cannot be injected.
    ["style-src-attr", "'unsafe-inline'"],
    ["font-src", "'self'", GOOGLE_FONTS_FILE_HOST],
    ["img-src", "'self'", "data:", "blob:"],
    ["media-src", "'self'", "blob:"],
    ["connect-src", "'self'", ...directAgentConnectSources()],
    ["worker-src", "'self'", "blob:"],
    ["manifest-src", "'self'"],
  ]
    .map((directive) => directive.join(" "))
    .join("; ");
}

/**
 * The validated direct-agent origins, deduplicated, in the order the two envs are read.
 *
 * An unusable value is dropped rather than emitted, and it is never echoed into a log or an error:
 * a misconfigured origin should narrow the policy, not widen it and not disclose itself.
 */
function directAgentConnectSources(): string[] {
  if (!DIRECT_AGENT_TRANSPORT_RECORDED) return [];
  const sources: string[] = [];
  for (const candidate of [
    validatedAgentOrigin(process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL, ["https:", "http:"]),
    validatedAgentOrigin(process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL, ["wss:", "ws:"]),
  ]) {
    if (candidate && !sources.includes(candidate)) sources.push(candidate);
  }
  return sources;
}

/**
 * An exact, credential-free origin using the secure scheme publicly or the insecure one on
 * loopback. A path, query, fragment, userinfo, unsupported scheme, or insecure public value is
 * refused, and the refusal returns nothing at all rather than a reason carrying the input.
 */
function validatedAgentOrigin(
  value: string | undefined,
  [secureScheme, insecureScheme]: readonly [string, string],
): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  if (raw !== url.origin && raw !== `${url.origin}/`) return null;
  if (url.protocol === secureScheme) return url.origin;
  if (url.protocol === insecureScheme && isLoopbackHostname(url.hostname)) return url.origin;
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}
