# Viva

Viva is a voice-first AI study companion prototype: upload course materials, start a short oral recall session, get source-grounded corrections, and leave with a next study plan.

This repo follows the Backbay app shape used by `chartd` and `luca`: Bun workspaces, Turbo tasks, shared packages, and a Next web app.

## Workspaces

- `apps/web` - the runnable Viva web prototype.
- `packages/core` - local study-set, extraction, session, and evaluation logic.
- `packages/ui-web` - reusable Viva React components.
- `packages/tokens` - design token constants matching the supplied design reference.

## Commands

```sh
bun install
bun run dev:web
bun run dev:agent
bun run typecheck
bun run lint
bun run test
bun run build
bun run validate
```

## Test Environment

Frontend URL tests must pass even when a local root `.env` is present. Tests that
exercise agent URLs should pass explicit env records; an explicit empty record is
hermetic and falls back to `ws://127.0.0.1:4318/ws` instead of reading ambient
`NEXT_PUBLIC_VIVA_AGENT_WS_URL` values. Runtime app code that omits an env record
still reads the public agent URL and API URL from the normal Next/Bun
environment.

## Agent Modes

Default validation uses the Rust synthetic voice agent only. It requires no
provider keys, network calls, microphone hardware, or Postgres. The connected web
flow treats the server as authoritative: browser identity, source context, local
tool results, and local mock recaps are not accepted as successful connected
agent output.

### Session Bootstrap Modes

There are two supported `/session` bootstrap modes:

- Local loopback dev: `bun run dev:agent` starts the agent on
  `127.0.0.1:4318` with `VIVA_AGENT_PROVIDER=synthetic` and explicitly clears
  inherited `VIVA_VOICE_SESSION_TOKEN_SECRET` and
  `VIVA_VOICE_WS_BEARER_TOKEN` values. This keeps a root `.env` copied from a
  production-like environment from forcing signed tokens on the no-key synthetic
  `/session` path. In this mode the browser can open `/session` with the trusted
  fixture identity and no signed token.
- Signed-session production path: set `VIVA_VOICE_SESSION_TOKEN_SECRET` and run
  `bun run dev:agent:signed` for local production-path testing, or run the Rust
  service directly in deployment. Signed tokens bind user, study set, session,
  expiry, and nonce; BAC-338 hardens nonce replay protection.

The local convenience path is loopback-only. Public or non-loopback binds still
fail closed unless auth and `VIVA_VOICE_WS_ALLOWED_ORIGINS` are configured, per
BAC-337. Do not commit real bearer or session-token secrets.

Postgres durability is opt-in by setting `DATABASE_URL` or
`VIVA_AGENT_DATABASE_URL` before starting `bun run dev:agent`. Leave those unset
for the default in-memory fixture store. Cartesia/Gemini request builders,
parsers, and fake-runtime tests exist in the Rust adapters, but
`cartesia_gemini` is selectable only when real provider credentials are paired
with the explicit `VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1` transport gate. The
authoritative definition of live Cartesia/Gemini proof is in
`docs/superpowers/specs/live-cartesia-gemini-definition.md`.
