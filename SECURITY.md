# Security Policy

Viva handles student course material and voice. We take reports seriously and would rather hear
about a problem early than read about it later.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately through
[GitHub Security Advisories](https://github.com/backbay-labs/viva/security/advisories/new). If you
cannot use that, email **[security@backbay.io](mailto:security@backbay.io)** with `viva` in the
subject line.

Please include:

- What the issue is and roughly how severe you think it is
- Steps to reproduce, or a proof of concept
- The commit or version you tested
- Anything you know about affected configurations

We aim to acknowledge a report within three business days and to send a substantive assessment
within ten. If a fix is warranted, we will keep you updated through the advisory and credit you on
release unless you would rather stay anonymous.

Please give us a reasonable window to ship a fix before disclosing publicly. We will not pursue
legal action against good-faith research that respects user privacy, avoids service degradation,
and does not access, modify, or retain data belonging to anyone else.

## Scope

In scope:

- The agent service and its WebSocket surface (`agent/crates/agent-service`)
- Session-credential issuance, verification, and replay protection
- Origin, bearer, and bind-address enforcement
- Cross-tenant access to study sets, sessions, sources, or recaps
- Leakage of learner content into logs, diagnostics, or operator evidence
- Redaction-control bypass
- Anything that reaches a live provider without the documented gates

Out of scope:

- Findings that require an operator to have already disabled a documented safety gate
- Missing hardening on `bun run dev:agent`, which is loopback-only by design and documented as such
- Vulnerabilities in third-party dependencies with no exploitable path in Viva. Report those
  upstream, though we appreciate a heads-up
- Volumetric denial of service against a deployment you do not own

## What Viva enforces today

These are the controls a report should be measured against. They are the shipped ones, not
aspirations; `docs/public-contract.json` is the generated statement of the same set.

### Reaching the agent at all

- **The default path needs no secrets.** `VIVA_AGENT_PROVIDER=synthetic` performs no provider
  calls and no network I/O.
- **Non-loopback binds fail closed.** A public or non-loopback bind refuses to start unless auth
  and `VIVA_VOICE_WS_ALLOWED_ORIGINS` are configured.
- **`/ws` preflight is authenticated before a session exists.** When session-credential signing is
  configured the agent accepts the signed session credential at preflight, so the browser never
  needs the REST bearer. Where a shared `VIVA_VOICE_WS_BEARER_TOKEN` is configured instead, it
  gates preflight and is carried as a WebSocket subprotocol credential.
- **Session credentials are bound and single-use.** Signed credentials bind user, study set,
  session, expiry, and nonce, with nonce replay protection resolved in the store.
- **The server is authoritative.** Browser-supplied identity, study set, retrieval context, and
  tool results are rejected or stripped before the brain or the store sees them.

### Client-address attribution

Per-IP session caps key off the raw socket peer address by default, so a direct deployment needs no
forwarding header at all. `X-Forwarded-For` is consulted **only** when the connecting peer itself
matches a CIDR in `VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS`; otherwise it is ignored outright and a
spoofed header cannot open a second per-IP bucket. When the peer is trusted, the chain is scanned
right to left, trusted hops are skipped, and the first untrusted hop is the client address.
`X-Real-IP` is never consulted. A trusted peer that omits the header, sends a malformed or oversized
chain, or names only trusted hops is rejected before a session slot or IP lease is acquired; there
is no unattributed fallback.

### Credential strength, scope, and rotation

- Every configured agent credential is length-bounded to 32–512 bytes and must be **byte-distinct**
  from every other configured credential; a collision is startup-fatal, so route scopes cannot
  collapse by configuration.
- A library-read, library-delete, or session-mint credential without
  `VIVA_VOICE_SESSION_TOKEN_SECRET` configured alongside it is also startup-fatal.
- `VIVA_AGENT_SESSION_MINT_BEARER_TOKEN` is scoped to the mint/record operation only, and only for
  the agent's own trusted user. It carries no general library-read, delete, or cross-user authority.
- Rotate credentials through the deployment secret store, never through git. `.env` is gitignored.

### Browser response headers

The web middleware sets a per-request nonce `content-security-policy` — two requests never share a
nonce, `'unsafe-inline'` is never admitted for `script-src` or `style-src`, and `object-src`,
`frame-src`, and `frame-ancestors` are `'none'` — plus a fixed defense set on every server route:
`referrer-policy`, `x-content-type-options`, `x-frame-options`, `permissions-policy`,
`cross-origin-opener-policy`, and `cross-origin-resource-policy`. Over HTTPS it additionally sets
`strict-transport-security`.

### Container runtime

Both runtime images drop root before `CMD`: the agent image runs as fixed uid/gid `10001:10001`,
and the monitor image runs as the Playwright base image's own `pwuser`, with `/app/evidence` owned
by that user. All privileged build-time work happens before the user switch, and neither image
re-enters root afterward. Every `FROM` is pinned to an immutable `sha256:` digest.

### Diagnostics and evidence

The learner-loop contract permits stage, provider, latency, and cost evidence and excludes raw
audio, answer content, provider payloads, source material, and credentials. A redaction gate runs on
every pull request.

### Deterministic failure controls

The failure-injection path requires seven environment gates set together and is accepted only for a
configured synthetic identity, study set, origin, session, expiry, and nonce. It must never be
enabled for a learner identity, and `bun run release:check` fails outright if it is enabled.

### Dependency audits

`bun run audit` runs `bun audit` plus `cargo audit --deny warnings`. Exactly one advisory is scoped
out, in `.cargo/audit.toml`: **RUSTSEC-2023-0071** (`rsa`, no fixed upgrade), reachable only through
the MySQL driver in SQLx's feature-agnostic dependency graph, which this workspace never enables,
builds, or ships. `scripts/dependency-policy.test.mjs` re-proves the build-graph absence on every
run and pins the ignore list to exactly that one entry, so the scope cannot widen silently. See
[docs/data-governance.md](docs/data-governance.md).

## What is *not* proven here

Everything above is proven by repository-local gates. Three things cannot be, and a report should
not assume them:

- **Live provider behavior.** Real Cartesia/Gemini traffic, provider-side zero-data-retention
  status, and provider quota are attestations about third parties. They are recorded as external
  gate `OPS-04` and are never inferred from a local run.
- **A deployed environment.** Deployment identity, origins, and image digests are external gate
  `OPS-03`.
- **Real devices and assistive technology.** Microphone hardware, non-Chromium browsers, and screen
  readers are external gate `OPS-05`.

See [docs/release-readiness.md](docs/release-readiness.md) for how those are recorded, and
[docs/data-governance.md](docs/data-governance.md) for the data-handling model.

## Secrets

Never commit real bearer credentials, session-signing values, or provider keys. `.env` is
gitignored; `.env.example` carries placeholders only. If you believe a secret has been committed,
report it privately using the process above rather than opening a pull request that removes it,
because a removal commit advertises the secret.
