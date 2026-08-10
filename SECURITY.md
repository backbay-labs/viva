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
- Session-token issuance, verification, and replay protection
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

These are the controls a report should be measured against.

- **The default path needs no secrets.** `VIVA_AGENT_PROVIDER=synthetic` performs no provider
  calls and no network I/O.
- **Non-loopback binds fail closed.** A public or non-loopback bind refuses to start unless auth
  and `VIVA_VOICE_WS_ALLOWED_ORIGINS` are configured.
- **Session tokens are bound and single-use.** Signed tokens bind user, study set, session,
  expiry, and nonce, with nonce replay protection.
- **The server is authoritative.** Browser-supplied identity, study set, source context, and tool
  results are rejected or stripped before the brain or the store sees them.
- **Live providers are triple-gated.** Reaching Cartesia and Gemini requires real credentials,
  `VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1`, `CARTESIA_ZERO_DATA_RETENTION_ENABLED=1`, and
  `GEMINI_ZERO_DATA_RETENTION_APPROVED=1`.
- **Diagnostics exclude learner content.** The learner-loop contract permits stage, provider,
  latency, and cost evidence and excludes raw audio, answer content, provider payloads, source
  material, and credentials. A redaction gate runs on every pull request.
- **Deterministic failure controls are hard-off.** The failure-injection path requires seven
  environment gates set together and is accepted only for a configured synthetic identity. It must
  never be enabled for a learner identity.

See [docs/data-governance.md](docs/data-governance.md) for the data-handling model.

## Secrets

Never commit real bearer tokens, session-token secrets, or provider keys. `.env` is gitignored;
`.env.example` carries placeholders only. If you believe a secret has been committed, report it
privately using the process above rather than opening a pull request that removes it, because a removal
commit advertises the secret.
