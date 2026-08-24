# Code Review: Web API routes and library proxy

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | apps/web/app/api/ (viva-session including shared.ts, viva-library catch-all route), apps/web/lib/viva-library.ts, apps/web/lib/viva-library-proxy.test.ts, apps/web/lib/viva-session-api.test.ts |
| **Verdict** | sound-with-fixes |
| **Confidence** | High for source/test behavior; moderate for deployment-specific proxy trust |

This area is the browser-facing trust boundary of Viva: the same-origin session mint relay (`/api/viva-session/start`, `/api/viva-session/refresh` backed by `shared.ts`) and the catch-all library proxy (`/api/viva-library/[[...path]]`) that fronts the Rust agent's REST surface, injecting the server-only bearer, filtering snapshots to configured allowlists, and replacing raw signed session tokens with short-lived bootstrap capabilities. Adversarial verification confirmed both first-pass important findings against the actual agent handlers (`agent/crates/agent-service/src/app.rs`) and the test files; none were refuted. The core controls — fail-closed configuration, timing-safe HMAC verification, sanitized error surfaces, per-user/per-allowlist snapshot filtering — hold as claimed and are well tested. The two real gaps are that capability-token stripping is scoped only to the library snapshot path while the agent embeds raw `session_token` values in successful create responses, and that the proxy buffers unbounded request/response bodies in memory.

## Strengths

- Uniform fail-closed posture on missing configuration: `guardAllowedIdentity` and `serverBearerForBrowserLibraryRequest` both return 503 when the `VIVA_SESSION_ALLOWED_*` allowlists or the REST bearer are unset (`apps/web/app/api/viva-session/shared.ts:414-436`, `apps/web/app/api/viva-library/[[...path]]/route.ts:374-392`), so a deploy that forgets a secret denies rather than exposes.
- Error surfaces are aggressively sanitized: pre-loop/timeout responses never reflect the server bearer, agent URL, or raw upload body, and this is pinned by hostile-case tests (`route.ts:116-131`, `apps/web/lib/viva-library-proxy.test.ts:689-787`, `1020-1053`; `shared.ts:851-865`, `apps/web/lib/viva-session-api.test.ts`).
- All three HMAC verifiers compare with `node:crypto` `timingSafeEqual` after a length check, avoiding signature timing oracles (`shared.ts:762-767`, `1051-1054`, `1113-1116`).
- The proxy rebuilds a fresh response `Headers` object and forwards only content-type plus a forced `cache-control: no-store`, dropping any upstream set-cookie or authorization echo (`route.ts:104-107`, `516-519`).
- Mint rate limiting keys independently on client IP and (user, study_set) identity, and extracts the client IP from trusted platform headers with a last-entry XFF fallback; the dual-key and XFF-spoof cases are both tested (`shared.ts:479-509`, `995-1011`; `apps/web/lib/viva-session-api.test.ts`).
- Bearer-backed browser snapshots are filtered to the requested user and allowlisted study sets, `session_token`/`control_token` keys are recursively stripped, and only server-minted browser-safe capabilities remain — with strong cross-user leak tests (`route.ts:467-592`; `viva-library-proxy.test.ts:327-570`).

## Findings

### Important

1. **Proxy token stripping is scoped to the library path; create responses relay raw session_token**
   `apps/web/app/api/viva-library/[[...path]]/route.ts:467-506`
   **What**: `browserSafeLibraryResponseBody` only parses and strips tokens when `path === "study-sets/library"`; every other path returns `response.arrayBuffer()` verbatim (line 505). Verified against the agent: the paste, file, and retry handlers all call `attach_ready_session_token` (`agent/crates/agent-service/src/app.rs:1796`, `1903`, `1973`), which sets `record.session_token = Some(signed_session_token(...))` whenever the study set is `Ready` (`app.rs:1997-2008`) — and the memory store creates paste/file sets synchronously `Ready` (`agent/crates/data/src/memory.rs:1011`, `1135`). `PasteStudySetResponse` serde-flattens the record including `session_token` (`app.rs:1370-1373`, `agent-domain/src/ports.rs:268-276`), so a 201/200 create body containing a real signed WS credential is forwarded unstripped to the browser.
   **Why it matters**: This contradicts the documented invariant that the browser obtains signed `/ws` material only by POSTing a bootstrap capability to `/api/viva-session/start` (docs/deployment-runbook.md, "Same-origin session bootstrap"). The GET library path goes to great lengths to strip `session_token`, while the create paths hand out a ready-to-use credential that bypasses the same-origin start route, mint rate limiting, and the bootstrap-capability check. Strict bearer mode masks it only because the agent 401s create requests the proxy did not bearer-inject; a mixed config (`unauthenticated_paste_allowed=true` alongside bootstrap) leaks the credential through the proxy. Verified that no test covers this: the successful 201 upload test (`viva-library-proxy.test.ts:969-1018`) mocks `{ok: true}` upstream and asserts nothing about the response body, and every `session_token`-stripping assertion targets the GET library path.
   **Fix**: Apply `stripBrowserLibraryCapabilityTokens` to JSON responses on all proxied paths, not just `study-sets/library`; add a regression test that a 201 files/paste response with an upstream `session_token` reaches the browser without it.

2. **No body/response size cap; base64 uploads fully buffered in memory**
   `apps/web/app/api/viva-library/[[...path]]/route.ts:219-247`
   **What**: `requestTextWithAbort` reads the request body via `request.body.getReader()` and concatenates the whole stream into a JS string, and successful responses are read with `response.arrayBuffer()` (line 505). Neither has a byte limit; the only bound is the 15s/30s timeout. App Router route handlers expose the raw stream with no framework body-size limit, and this deploys to Railway (railway.json), a long-lived Node process with no platform request cap in front of the manual reader.
   **Why it matters**: A single large (or fast, under-timeout) POST to the unauthenticated upload proxy path allocates the entire base64 payload in web-instance memory before any upstream auth check; concurrent uploads can exhaust memory. It is a memory-exhaustion DoS vector on the upload path.
   **Fix**: Enforce a maximum byte count while reading — abort with a sanitized 413-style error once exceeded — for both the request-body accumulation and the upstream response buffering, sized to the largest legitimate upload.

### Minor

1. **Rate-limit map never evicts expired buckets**
   `apps/web/app/api/viva-session/shared.ts:163`
   **What**: `mintRateLimits` is a module-level Map written per `ip:...` and `identity:...` key (lines 497-500) and only cleared by the test helper. Expired buckets are replaced lazily on re-access (`currentRateLimitBucket`) but stale keys are never deleted, and the per-IP keyspace is unbounded by distinct client IPs.
   **Why it matters**: On a long-lived Node instance (Railway) the map grows without bound as new client IPs appear — a slow memory leak with no cleanup path.
   **Fix**: Sweep entries whose `resetAt < now` on access or periodically, or switch to a bounded LRU.

2. **IP rate-limit key is spoofable off trusted-platform deployments**
   `apps/web/app/api/viva-session/shared.ts:995-1011`
   **What**: `clientIp` prefers `request.ip` and platform headers (`x-vercel-forwarded-for`, `cf-connecting-ip`, `true-client-ip`, `x-real-ip`), then falls back to the last entry of `x-forwarded-for`. When no platform header is present and no trusted proxy appends the peer IP (e.g. direct exposure or a pass-through proxy), the fallback value is entirely caller-controlled, so an attacker can rotate the IP bucket key at will.
   **Why it matters**: Weakens the per-IP mint limit. Impact is contained because the per-identity bucket still caps each allowlisted (user, study_set) and non-allowlisted identities are rejected earlier, but the IP dimension is not trustworthy without a known platform header.
   **Fix**: Only trust `x-forwarded-for` under a configured trusted-proxy assumption and document that one of the platform headers must be present; otherwise treat the IP as "unknown" and lean on the identity bucket.

3. **Origin binding on bootstrap/control tokens is optional and absent in the SSR mint path**
   `apps/web/app/api/viva-session/shared.ts:468`
   **What**: `verifySessionBootstrapTokenClaims` and `verifyVivaLibraryControlToken` only check origin when the claim is non-null (`claims.origin && claims.origin !== ...`, lines 468 and 346). The SSR mint in `apps/web/app/page.tsx:35-48` calls both attach helpers without an origin, so those tokens carry `origin: null` and are never origin-checked.
   **Why it matters**: Origin binding is defense-in-depth here (the HMAC secret and the same-origin guard are the real controls), but the asymmetry — proxy-minted tokens origin-bound, SSR-minted ones not — is surprising and easy to regress. The DELETE control routes on the proxy have no same-origin guard of their own, so SSR-minted control capabilities rely on token secrecy alone.
   **Fix**: Thread the request origin through the SSR attach calls, or make the origin claim mandatory so verification always binds it.

4. **Unreachable browser-snapshot error branch**
   `apps/web/app/api/viva-library/[[...path]]/route.ts:101`
   **What**: `if (isBrowserLibrarySnapshotRequest(...) && !response.ok)` can never fire: `libraryPreLoopTerminalReason` returns a non-null reason for GET `study-sets/library`, so the earlier `!response.ok && terminalReason` block (lines 79-95) already returns for every non-ok library response. Verified both branches of that earlier block (validation-failure and otherwise) return before line 101.
   **Why it matters**: Dead code that implies a fallback which is never taken; a future edit to the terminal-reason mapping could silently change behavior here in a confusing way.
   **Fix**: Remove the branch or restructure so snapshot error handling lives in one place.

5. **serverBearerForBrowserLibraryRequest returns a snapshotFilter the caller ignores**
   `apps/web/app/api/viva-library/[[...path]]/route.ts:297`
   **What**: `serverBearerForBrowserLibraryRequest` computes and returns `snapshotFilter` (lines 305, 392), but `proxyVivaLibraryRequest` never reads it — it recomputes the same filter via `browserLibrarySnapshotFilter` (lines 110-111) with duplicate logic.
   **Why it matters**: Two independent computations of the allowlist filter can drift if one is updated and the other is not; the unused return field is misleading. Not currently a bug because both derive from the same env and query, but it is latent risk plus dead surface.
   **Fix**: Return the filter once and thread it through, or drop the unused field.

6. **Bootstrap token origin claim and start-time comparison use different origin derivations**
   `apps/web/app/api/viva-session/shared.ts:461-468`
   **What**: Proxy-minted bootstrap/control tokens bind origin to `vivaLibraryProxyOrigin(request)` — the Origin header, or host + `x-forwarded-proto` for the header-less snapshot GET (`route.ts:285-295`). `guardSessionBootstrapCapability` then compares `claims.origin` against `requestOrigin(request)` = `request.nextUrl.origin` (`shared.ts:468`, `991-993`). Behind a proxy where the forwarded protocol/host derivation does not match `nextUrl.origin`, the two disagree.
   **Why it matters**: A mismatch would spuriously 403 a proxy-refresh-obtained bootstrap capability for a legitimate caller. In practice such a deployment already 403s at `guardSameOrigin` (which also compares against `nextUrl.origin`), so the observable effect is the same failure class — but the root cause is a split origin derivation that should be single-sourced. SSR-minted tokens dodge it only because they carry `origin: null` (Minor 3).
   **Fix**: Derive the token's origin claim and the start-time comparison origin from the same helper so they cannot disagree.

## Verification notes

No findings were refuted or downgraded; all eight survived at their original severity. Adversarial checks performed:

- F1: traced the agent side end-to-end — `attach_ready_session_token` at `app.rs:1796/1903/1973` sets `record.session_token` on `Ready`, `PasteStudySetResponse` serde-flattens it, and the memory store creates paste/file sets synchronously `Ready` — and confirmed the proxy's verbatim `arrayBuffer()` pass-through plus the absence of any create-path stripping test (the 201 test at `viva-library-proxy.test.ts:969-1018` asserts only forwarding, not body hygiene). Also confirmed the strict-mode mask: the proxy injects no bearer on POST create paths, and the agent's web-tier-unaware `validate_library_control_token` rejects `viva-control1` tokens, so the leak requires the agent's `unauthenticated_paste_allowed` config.
- F2: confirmed the unbounded manual reader and `arrayBuffer()`, and that the deployment target (Railway, long-lived Node) puts no platform cap in front of it.
- F4: tightened the mechanics — the last-entry XFF fallback is actually the correct choice when a trusted proxy appends the peer IP; the spoof only exists when nothing appends, which is the deployment the finding worries about. Essence kept.
- F6: confirmed dead by checking both return paths of the earlier `!response.ok && terminalReason` block.
- F8: noted its practical effect is preempted by `guardSameOrigin` failing first in the same misconfigured deployment; kept as minor because the split origin derivation is the real hazard.

## Recommendations

1. Extend the proxy's token-hygiene stripping to all JSON responses (not just `study-sets/library`) and add a regression test asserting POST files/paste 201 bodies contain no `session_token` — closes Important 1.
2. Add an explicit byte cap to the manual request-body reader and the upstream `arrayBuffer` read, returning a sanitized 413-class error when exceeded (Important 2).
3. Add a periodic or opportunistic sweep of expired rate-limit buckets, or bound the map, to prevent slow growth on long-lived instances (Minor 1).
4. Make the origin claim mandatory in bootstrap/control tokens, thread the request origin through the SSR mint path, and derive mint-time and verify-time origins from one helper so binding is uniform and cannot silently degrade (Minor 3, Minor 6).
5. Remove the dead library-snapshot error branch and the unused `snapshotFilter` return value to keep the proxy's control flow single-sourced (Minor 4, Minor 5).
6. Document (and where possible enforce) the trusted-proxy assumption behind `clientIp` so the IP rate-limit dimension is not silently spoofable off-platform (Minor 2).

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first pass — verification confirmed all findings rather than shifting the balance). The session-mint relay and library proxy are carefully built around a clear trust boundary: server-only secrets are never reflected, HMAC verification is timing-safe, snapshots are filtered per-user and per-allowlist, and the surface is backed by unusually thorough hostile-case tests. The most significant confirmed issue is that token stripping is scoped only to the library snapshot path while the agent verifiably emits raw signed session tokens on create paths — production reachability is limited by the agent's own bearer gate, making it a real defense-in-depth gap with an untested success path rather than a live leak — followed by the unbounded in-memory buffering of upload bodies. Addressing those two plus the smaller hardening items would move this area to solid.
