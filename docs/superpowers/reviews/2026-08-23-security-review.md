# Viva security review — 2026-08-23

**Scope:** Browser/BFF/agent trust boundaries, bearer and capability tokens, tenant binding, rate limiting, browser headers, data retention, and dependency supply chain.  
**Method:** Defensive static review plus local audit commands; no exploitation of external systems.  
**Overall confidence:** High.

## Findings

| ID | Priority | Finding | Confidence |
| --- | --- | --- | --- |
| SEC-01 | P1 | Expired access tokens can mint fresh session tokens without a refresh horizon or rotated refresh credential | High |
| SEC-02 | P1 | JavaScript and Rust dependency audits fail; audits are absent from CI/validation | High |
| SEC-03 | P1 | Production startup can undelete fixture source material | High |
| SEC-04 | P2 | Session-mint rate limits are process-local, non-shared, and unswept | High |
| SEC-05 | P2 | Public signed-session configuration can leave operator readiness/usage endpoints without REST bearer auth | High |
| SEC-06 | P2 | One REST bearer can read library state and mint sessions for every allowlisted identity | High |
| SEC-07 | P2 | Next.js response security headers are materially incomplete | High |
| SEC-08 | P2 | Session/HMAC secrets have no enforced minimum entropy | High |
| SEC-09 | P2 | File and paste routes rely primarily on framework body limits, then allocate/decode whole payloads | Moderate |
| SEC-10 | P3 | Library control capabilities are reusable until expiry | High |
| SEC-11 | P3 | CI actions use floating major tags and no Dependabot configuration is present | High |
| SEC-12 | P3 | Google Fonts receives page-load metadata | High |

## What is solid

- Non-loopback agent binds fail closed unless allowed origins and a WS bearer or session-token secret are configured.
- Signed session claims bind `user_id`, `study_set_id`, `session_id`, expiry, run ID, origin, and nonce; Postgres/in-memory stores claim nonces atomically.
- WebSocket admission strips browser source tuples and rejects browser `tool_result` authority.
- Same-origin BFF routes filter requested users/study sets through allowlists and remove private agent bearer tokens from browser JSON.
- Bootstrap/control capabilities are purpose-, identity-, origin-, scope-, and expiry-bound.
- Live Cartesia/Gemini selectability is gated by runtime enablement, keys, and both zero-retention assertions.
- Evidence and log redaction forbid raw answer/transcript/source payload fields structurally, not merely by string blacklist.
- The browser removes tokens from visible session URLs and uses `Referrer-Policy: no-referrer` on the session route.

## SEC-01 — P1 — Access-token expiry is not an expiry boundary

`handleVivaSessionRefresh` verifies the HMAC and identity of `session_token`, but explicitly accepts `claims.expired` and mints a new token (`apps/web/app/api/viva-session/shared.ts:214-269`). `verifySessionTokenClaims` returns only `expired: boolean`; it does not reject old expiry, validate `issued_at`, enforce a refresh grace window, or consume/rotate a refresh credential (`shared.ts:747-805`).

The nonce is correctly consumed at WebSocket admission, but refresh does not inspect whether that access-token nonce was used and does not revoke it. A stolen, correctly signed old access token can therefore be presented to the same-origin endpoint to obtain new access as long as the referenced session can be resumed. “Same origin” prevents ordinary browser CSRF; it does not protect a bearer presented by a non-browser client that can set `Origin`.

**Remediation:** Separate access and refresh credentials. Store a hashed, one-time rotating refresh token with an absolute session lifetime; revoke the prior refresh record atomically; reject access tokens outside a short explicit grace. Test years-old tokens, reused refresh tokens, session deletion, rotation races, and cross-tenant claims.

## SEC-02 — P1 — The supply-chain gate is green while audits are red

`bun audit` exited 1 with **16 vulnerabilities: 9 high, 7 moderate**:

- Next.js `16.2.6` is in the reported vulnerable interval `<16.2.11`, including high-severity SSRF, App Router bypass, Server Action DoS, and rewrite SSRF advisories.
- Sharp `0.34.5` is below `0.35.0` and inherits high-severity libvips advisories.
- PostCSS `8.4.31` is affected by source-map file-read/path-traversal and XSS advisories.
- Nano ID `3.3.12` is affected by generator infinite-loop advisories.

`cargo audit --file agent/Cargo.lock` exited 1:

- RUSTSEC-2026-0185: `quinn-proto 0.11.14`, high severity remote memory exhaustion, reachable through `reqwest -> agent-adapters`; patch `>=0.11.15`.
- RUSTSEC-2023-0071: `rsa 0.9.10`, timing side channel, no fixed release; pulled through `sqlx-mysql` even though Viva is Postgres-only.
- Warnings: unsound `anyhow 1.0.102`, unsound `event-listener 5.4.1`, yanked `spin 0.9.8`.

Neither audit appears in `package.json` validation nor `.github/workflows/validate.yml`, so current green local validation cannot detect this state.

**Remediation:** Upgrade Next/Sharp and resolve transitive JS versions. Upgrade the Rust network tree, set SQLx `default-features = false`, retain only Postgres/runtime/TLS features, and update warning crates. Add fail-closed audit policy with narrowly documented temporary ignores and expiry dates.

## SEC-03 — P1 — Restart defeats fixture deletion

The Postgres startup seed clears fixture `deleted_at` fields and overwrites the same known IDs on every process boot. See COR-03 for code evidence. This is both correctness and security/privacy failure: a user-visible delete can be reversed by deployment.

**Remediation:** Remove fixture mutation from production startup and prove delete persistence across restart in mandatory Postgres CI.

## SEC-04 — P2 — BFF mint limiting is not horizontally authoritative

`mintRateLimits` is a module-level `Map` keyed by IP and identity (`apps/web/app/api/viva-session/shared.ts:146-163,479-509`). Each serverless/Node instance owns a separate map, so traffic distributed across instances multiplies the allowed rate. Expired buckets are replaced only when that exact key returns; unique keys are never swept, making memory growth unbounded.

**Remediation:** Use a shared atomic limiter keyed by trusted platform client identity plus user/study-set. Add bounded retention and explicit proxy-header trust configuration. Keep the agent's provider/session admission caps as a separate defense.

## SEC-05 — P2 — Readiness can expose operational state without REST auth

`/ready` and `/health/brain` call `validate_bearer_headers`, but that validator allows access when `required_bearer` is absent. A public deployment may use signed WebSocket sessions without configuring a separate WS/REST bearer, exposing provider selection, store backend/capabilities/write counts, and cumulative usage summary (`agent/crates/agent-service/src/app.rs:1151-1271`).

**Remediation:** Split public liveness from authenticated operational readiness. On non-loopback binds, require an operator bearer/mTLS for provider/store/usage details and expose only minimal `/live` publicly.

## SEC-06 — P2 — REST bearer is broad authority

The agent REST bearer gates library snapshots, session minting, and mutation endpoints. Anyone holding it can operate across every identity allowed by the service configuration. BFF allowlists mitigate browser requests but do not scope the bearer itself.

**Remediation:** Issue audience/scope-bound service credentials, or authenticate the BFF as a service and enforce user/study-set authorization in the agent from signed claims. Separate read, mint, delete, and operator-health scopes.

## SEC-07 — P2 — Browser hardening headers are incomplete

The app sets session referrer policy but does not establish a repository-wide CSP, `frame-ancestors`, HSTS, or `X-Content-Type-Options`. Next's framework defaults are not a substitute for an explicit deployment policy. This matters because session tokens exist in browser memory and provider/source content is rendered dynamically.

**Remediation:** Add a tested header policy: CSP with nonces/hashes as required, `frame-ancestors 'none'` (or documented allowlist), `object-src 'none'`, `base-uri 'self'`, HSTS on HTTPS deployment, `nosniff`, and a deliberate permissions policy for microphone.

## SEC-08 — P2 — Weak secrets are accepted

Configuration checks presence but does not enforce length/entropy for HMAC session/bootstrap/control secrets or REST/WS bearer values. A short operator-provided string boots successfully.

**Remediation:** Require at least 256 bits of randomly generated secret material, reject placeholder/common values, and support key IDs/rotation. Do not log secrets or their prefixes.

## SEC-09 — P2 — Whole-body upload allocation

File ingestion decodes the entire base64 string to `Vec<u8>` and normalization allocates another text representation. The app has no product-specific `MAX_UPLOAD_BYTES`; the main backstop is Axum's default body limit (normally 2 MiB unless changed). Paste text follows a similar whole-body path. The Next proxy adds timeouts, not a clear semantic/decompressed-size budget.

**Remediation:** Enforce content-length and decoded-byte caps at both BFF and agent, stream where possible, reject over-limit base64 before full decode, and impose parser/decompression/OCR budgets. Treat the current framework default as defense-in-depth, not the contract.

## SEC-10 — P3 — Control tokens are capabilities, not tickets

Library control tokens include nonce and expiry but are verified statelessly and can be replayed until expiry. Delete operations are mostly idempotent, which limits impact, but replayable capabilities should be documented as such.

**Remediation:** Consume nonces for destructive scopes or remove the nonce field and document replay semantics honestly.

## SEC-11 — P3 — CI supply-chain controls are conventional, not strict

Actions are referenced by floating majors such as `actions/checkout@v4` and `oven-sh/setup-bun@v2`; no `.github/dependabot.yml` exists.

**Remediation:** Pin Actions to reviewed commit SHAs and enable dependency update automation if repository policy requires it.

## SEC-12 — P3 — Third-party font requests

Google Fonts links reveal visitor IP/user agent/referrer metadata to a third party on page load. This is not equivalent to sending study content, but it is unnecessary for a privacy-positioned study product.

**Remediation:** Self-host licensed/subset fonts or use system fallbacks.

## Data-handling conclusion

The runtime intentionally avoids persisting raw microphone audio, transcripts, and answers, and the redaction controls are materially stronger than average. The remaining high-risk data issue is not accidental logging; it is authoritative derived data being wrong or resurrected. Sanitized mastery, recap, review, and usage records are still personal educational data and must obey deletion and retention guarantees.
