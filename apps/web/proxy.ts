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
    // `A-32`: real-run measurement attributed every style-src CSP violation to Next's own
    // framework-injected `<style>`/stylesheet elements, never a mounted-UI stylesheet, and
    // A-30's dynamic rendering is what lets Next stamp this same request's nonce onto them
    // (confirmed directly: the production `<link rel="stylesheet">` Next itself emits for
    // these routes already carries this exact nonce). Carrying it here — the identical
    // value already forwarded for `script-src`, not a second nonce — lets any such element
    // validate without ever admitting `'unsafe-inline'`, which stays explicitly out. (Next's
    // `next dev`-only error-overlay chrome, `<nextjs-portal>`, injects its own unnonced
    // shadow-DOM styles that no nonce here reaches; verified absent from a production build,
    // so it is a dev-console-noise/harness-environment question, not a shipped-policy gap.)
    ["style-src", "'self'", `'nonce-${nonce}'`, GOOGLE_FONTS_STYLESHEET_HOST],
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
 * The validated direct-agent `connect-src` sources, deduplicated, in the order the two envs are
 * read.
 *
 * The two envs hold different KINDS of value, so they contribute different shapes.
 * `NEXT_PUBLIC_VIVA_AGENT_HTTP_URL` is a BASE: `vivaAgentHttpBaseUrl` trims its trailing slash and
 * every caller concatenates a request path onto it, and the deployment runbook documents it as
 * "the public agent origin". It contributes its ORIGIN, because a CSP `path-part` there would
 * refuse every request the app actually makes under that base.
 * `NEXT_PUBLIC_VIVA_AGENT_WS_URL` is one ENDPOINT, opened verbatim — `connectVivaAgent` hands
 * `vivaAgentWsUrl()` straight to `new WebSocket(...)`, unchanged and with the token in the
 * subprotocol rather than the URL. It contributes that endpoint's ORIGIN AND PATH.
 *
 * An unusable value is dropped rather than emitted, and it is never echoed into a log or an error:
 * a misconfigured origin should narrow the policy, not widen it and not disclose itself.
 */
function directAgentConnectSources(): string[] {
  if (!DIRECT_AGENT_TRANSPORT_RECORDED) return [];
  const httpBase = validatedAgentUrl(process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL, [
    "https:",
    "http:",
  ]);
  const wsEndpoint = validatedAgentUrl(process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL, ["wss:", "ws:"]);
  const sources: string[] = [];
  for (const candidate of [httpBase?.origin, wsEndpoint && endpointHostSource(wsEndpoint)]) {
    if (candidate && !sources.includes(candidate)) sources.push(candidate);
  }
  return sources;
}

/**
 * A host-source naming one exact endpoint: its origin, plus the CSP `path-part` for the path the
 * operator configured. `A-42` item 2 orders this shape for the socket value — "exactly the
 * configured socket URL's origin+path shape, never a broadened wildcard" — and a `path-part`
 * without a trailing solidus matches that one path and no sibling of it.
 *
 * A bare origin contributes no `path-part` at all. That states the same policy a `/` path-part
 * would, in the spelling the operator wrote and every consumer already reads.
 */
function endpointHostSource(url: URL): string {
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

/**
 * An exact, credential-free agent URL using the secure scheme publicly or the insecure one on
 * loopback. A query, fragment, userinfo, unsupported scheme, insecure public value, or any value
 * the URL parser had to normalize is refused, and the refusal returns nothing at all rather than
 * a reason carrying the input. The caller decides which part of the accepted URL to state.
 *
 * `A-42`/`W-07`: an endpoint PATH is admitted. It has to be, because the socket endpoint every
 * consumer configures carries one — `.env.example`, the deployment runbook, and `vivaAgentWsUrl`'s
 * own fallback are all `…/ws`, and `vivaApiBaseUrl` derives the REST base by stripping that exact
 * suffix. Refusing it dropped the socket source silently: the emitted policy was still
 * well-formed, so nothing failed until a real browser refused the session's only transport.
 *
 * Admitting a path never widens what a value can name. The scheme, host, and port still come from
 * the parsed URL, so a path segment that spells a hostname stays a path segment; userinfo that
 * spells one is refused outright; and no accepted value can produce a wildcard, a bare scheme
 * source, or any host the operator did not already write.
 */
function validatedAgentUrl(
  value: string | undefined,
  [secureScheme, insecureScheme]: readonly [string, string],
): URL | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // Both guards are subsumed by the exactness check below — userinfo, query, and fragment all
  // make `raw` differ from origin+pathname — and are kept as defense in depth so that loosening
  // the exactness check can never silently start admitting credentials or a query string.
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  // The configured value must be exactly what it parses back to, so a normalized-away default
  // port or an altered host can never reach the policy under a shape the operator never wrote.
  // `url.pathname` is `/` for a bare origin, which is why both spellings of that case are named.
  const withPath = `${url.origin}${url.pathname}`;
  const bareOrigin = url.pathname === "/" ? url.origin : null;
  if (raw !== withPath && raw !== bareOrigin) return null;
  if (url.protocol === secureScheme) return url;
  if (url.protocol === insecureScheme && isLoopbackHostname(url.hostname)) return url;
  return null;
}

/**
 * The hosts a dev machine actually serves loopback on: `localhost`, IPv6 `::1`, and the whole of
 * `127.0.0.0/8`. Nothing else. The insecure-scheme allowance above exists only because loopback
 * traffic never leaves the machine, so it must be spent on hosts that ARE loopback and never on
 * one that merely reads like one: `127.0.0.1.evil.example` is an ordinary registrable name whose
 * first label happens to be `127`, and a prefix test would hand its owner the allowance. Numeric
 * spellings the URL parser rewrites (`127.1`, `0177.0.0.1`, `2130706433`) never reach here — they
 * normalize to `127.0.0.1`, which no longer matches what the operator wrote, so the exactness
 * check in `validatedAgentUrl` has already refused them.
 */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!octets) return false;
  return octets.slice(1).every((octet) => Number(octet) <= 255);
}
