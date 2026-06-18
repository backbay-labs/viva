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

Postgres durability is opt-in by setting `DATABASE_URL` or
`VIVA_AGENT_DATABASE_URL` before starting `bun run dev:agent`. Leave those unset
for the default in-memory fixture store. Cartesia/Gemini request builders,
parsers, and fake-runtime tests exist in the Rust adapters, but
`cartesia_gemini` is intentionally not a selectable runtime provider yet. The
authoritative definition of live Cartesia/Gemini proof is in
`docs/superpowers/specs/live-cartesia-gemini-definition.md`.
