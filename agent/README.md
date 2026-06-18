# Viva Voice Agent

Self-contained Rust workspace for Viva's realtime voice agent.

The agent is intentionally a sibling to the Bun/Turbo app. Cargo owns Rust
formatting, linting, tests, and builds; root `package.json` exposes wrappers so
`bun run validate` covers both TypeScript and Rust.

## Local Run

```sh
bun run dev:agent
```

Default local mode is `VIVA_AGENT_PROVIDER=synthetic`, which requires no provider
keys and is the only provider used unless explicitly overridden. Use
`VIVA_AGENT_PROVIDER=fake_cartesia_gemini` to exercise the no-key/no-network
Cartesia/Gemini-shaped runtime through the real WebSocket service boundary. Live
`cartesia_gemini` remains rejected until the live STT -> Gemini -> TTS pipeline
is proven.

`bun run dev:agent` is the no-secret loopback path. It defaults
`VIVA_AGENT_BIND_ADDR` to `127.0.0.1:4318`, defaults the provider to
`synthetic`, and clears inherited `VIVA_VOICE_SESSION_TOKEN_SECRET` and
`VIVA_VOICE_WS_BEARER_TOKEN` values before `dotenvy` reads `.env`. That is
intentional: a root `.env` copied from production must not make the local
synthetic `/session` page require a signed token.

For the signed-session path, set `VIVA_VOICE_SESSION_TOKEN_SECRET` and run:

```sh
bun run dev:agent:signed
```

Use the signed path for production-like testing only. Session-token signing is
required for public/non-loopback deployments and is paired with BAC-338 nonce
replay hardening. Public binds still fail closed without auth and
`VIVA_VOICE_WS_ALLOWED_ORIGINS` configured, per BAC-337.

Running from `agent/` directly is still supported for service-only work:

```sh
cd agent
cp .env.example .env
cargo run -p agent-service
```

Leave `DATABASE_URL` and `VIVA_AGENT_DATABASE_URL` unset for the default
in-memory fixture store. Setting either value opts the service into Postgres,
runs migrations on boot, and makes `/ready` report a durable `postgres` store.
Postgres is never required by `bun run validate`.

The local synthetic WebSocket accepts only the server-configured fixture identity
by default: `VIVA_VOICE_TRUSTED_USER_ID=user-1`,
`VIVA_VOICE_TRUSTED_STUDY_SET_ID=biology-midterm`, and
`VIVA_VOICE_TRUSTED_SESSION_ID=voice-session-1`. Browser-supplied session,
study-set, source context, and tool result frames are rejected or stripped before
the brain or store sees them.

The example leaves `VIVA_VOICE_WS_BEARER_TOKEN` empty so local browser tests can
connect through the allowed localhost origins. If you set a bearer token, pass it
to the browser client through `connectVivaAgent({ token })`, which sends it as a
WebSocket subprotocol token.

## Gates

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace
```

No default gate may require provider keys, paid network calls, or a local
Postgres instance.

Root `bun run validate` sets `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1` for the Rust test
wrapper so sandboxed Bun runs do not require `127.0.0.1` bind permission. To
prove the WebSocket path itself, run
`cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws`
directly; that command does not opt into the skip.
