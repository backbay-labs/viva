# Contributing to Viva

Thanks for your interest in contributing to Viva, a voice-first study companion that turns a
student's course material into live oral examination. This guide explains how to build, test, and
submit changes so that they land cleanly.

One rule shapes most of what follows: **the default path requires no secrets.** Please keep it
that way.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

```sh
git clone https://github.com/backbay-labs/viva.git && cd viva
bun install
```

Toolchains are pinned: **Bun 1.3.3** and **Rust 1.94.1** (`agent/rust-toolchain.toml`). Nothing
else is required: no provider keys, no microphone, no Postgres.

```sh
bun run dev:agent   # synthetic voice agent on 127.0.0.1:4318
bun run dev:web     # Next.js app on http://localhost:3000
```

## The gate

Run this before you open a pull request. CI runs the same thing.

```sh
bun run validate
```

That expands to:

| Command | Covers |
| --- | --- |
| `bun run validate:ts` | `typecheck`, `lint`, `test`, `build` across the Bun workspaces |
| `bun run validate:agent` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `cargo build`, and the domain purity check |
| `bun run release:hygiene` | Generated-artifact hygiene |

Useful narrower commands:

```sh
bun run typecheck
bun run lint
bun run test
bun run format          # biome, writes
bun run agent:purity    # asserts agent-domain stays I/O-free
bun run redaction:check # the redaction control gate CI runs on every PR
bun run e2e:browser     # Playwright browser gate
```

### Rules the gate enforces

1. **No default gate may require a provider key, a paid network call, or a local Postgres.** If
   your change makes `bun run validate` need any of those, the change is wrong, not the gate.
2. **`agent-domain` stays pure.** The study brain has no I/O. New capability goes behind a port in
   `ports.rs` with an adapter implementation. `bun run agent:purity` enforces this.
3. **Learner copy and operator diagnostics stay separate.** Learner-facing text must never carry a
   raw provider failure or internal payload data. The
   [learner-loop contract](packages/core/src/learner-loop-contract.json) is the source of truth;
   update the JSON and its tests rather than adding a second state table in prose.
4. **Never commit real secrets.** No bearer tokens, session-token secrets, or provider keys.
   `.env` is gitignored; `.env.example` holds placeholders.

## Running the agent

`agent/README.md` is the authoritative reference for agent configuration. The essentials:

### Provider modes

| Provider | Needs | What it is |
| --- | --- | --- |
| `synthetic` | nothing | The default. A deterministic study brain over fixtures. The only provider used unless explicitly overridden. |
| `fake_cartesia_gemini` | nothing | The Cartesia/Gemini-shaped runtime driven through the real WebSocket service boundary. No keys, no network. |
| `cartesia_gemini` | real credentials + gates | Live voice. Requires `VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1`, `CARTESIA_ZERO_DATA_RETENTION_ENABLED=1`, and `GEMINI_ZERO_DATA_RETENTION_APPROVED=1`. The last two are set only after the provider-side controls in [docs/data-governance.md](docs/data-governance.md) are confirmed. |

The authoritative definition of live Cartesia/Gemini proof is
[`docs/superpowers/specs/live-cartesia-gemini-definition.md`](docs/superpowers/specs/live-cartesia-gemini-definition.md).

### Session bootstrap modes

There are two supported `/session` bootstrap modes.

**Local loopback dev.** `bun run dev:agent` starts the agent on `127.0.0.1:4318` with
`VIVA_AGENT_PROVIDER=synthetic` and explicitly clears inherited `VIVA_VOICE_SESSION_TOKEN_SECRET`
and `VIVA_VOICE_WS_BEARER_TOKEN` values before `dotenvy` reads `.env`. That is deliberate: a root
`.env` copied from a production-like environment must not force signed tokens onto the no-key
synthetic `/session` path. In this mode the browser opens `/session` with the trusted fixture
identity and no signed token.

**Signed-session production path.** Set `VIVA_VOICE_SESSION_TOKEN_SECRET` and run
`bun run dev:agent:signed` for local production-path testing, or run the Rust service directly in
deployment. Signed tokens bind user, study set, session, expiry, and nonce.

The loopback convenience path is loopback-only. Public and non-loopback binds still fail closed
unless auth and `VIVA_VOICE_WS_ALLOWED_ORIGINS` are configured.

### The server is authoritative

The connected web flow treats the server as the only source of truth. Browser identity, source
context, local tool results, and local mock recaps are **not** accepted as successful connected
agent output. If you are adding a feature that seems to need the client to assert one of those,
that is a signal to add a server-side capability instead.

### Durability

Postgres is opt-in. Set `DATABASE_URL` or `VIVA_AGENT_DATABASE_URL` before starting the agent to
run migrations on boot and have `/ready` report a durable `postgres` store. Leave both unset for
the default in-memory fixture store. Postgres is never required by `bun run validate`.

## Test environment notes

Frontend URL tests must pass even when a local root `.env` is present. Tests that exercise agent
URLs should pass explicit env records; an explicit **empty** record is hermetic and falls back to
`ws://127.0.0.1:4318/ws` instead of reading ambient `NEXT_PUBLIC_VIVA_AGENT_WS_URL` values. Runtime
app code that omits an env record still reads the public agent URL and API URL from the normal
Next/Bun environment.

`bun run validate` sets `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1` for the Rust test wrapper so sandboxed
Bun runs do not require `127.0.0.1` bind permission. To prove the WebSocket path itself, run it
directly. This command does not opt into the skip:

```sh
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws
```

## Pull requests

- Branch from `main`. Keep the change focused; unrelated refactoring belongs in its own PR.
- Write a test that fails before your change and passes after it.
- Run `bun run validate` and say so in the PR description.
- Update docs in the same PR when behavior changes. If you touch agent configuration, update
  `agent/README.md`.
- Explain the reasoning, not just the diff. What was wrong, and why is this the right fix?

## Reporting bugs and proposing features

Open an issue using the templates. For anything security-related, **do not open a public issue**;
follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
