# Viva Voice Agent

Self-contained Rust workspace for Viva's realtime voice agent.

The agent is intentionally a sibling to the Bun/Turbo app. Cargo owns Rust
formatting, linting, tests, and builds; root `package.json` exposes wrappers so
`bun run validate` covers both TypeScript and Rust.

The machine-checked statement of the agent's public surface is
`docs/public-contract.json`, generated from this code. Where this file and that
one disagree, that one is right.

## Local Run

```sh
bun run dev:agent
```

Default local mode is `VIVA_AGENT_PROVIDER=synthetic`, which requires no provider
keys and is the only provider used unless explicitly overridden. Use
`VIVA_AGENT_PROVIDER=fake_cartesia_gemini` to exercise the no-key/no-network
Cartesia/Gemini-shaped runtime through the real WebSocket service boundary. Live
`cartesia_gemini` requires `VIVA_AGENT_PROVIDER=cartesia_gemini`, real
Cartesia/Gemini credentials, and the explicit
`VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1` transport gate. Live selection also
requires `CARTESIA_ZERO_DATA_RETENTION_ENABLED=1` and
`GEMINI_ZERO_DATA_RETENTION_APPROVED=1`; set those only after the provider-side
controls described in `docs/data-governance.md` are confirmed.

`bun run dev:agent` is the no-secret loopback path. It defaults
`VIVA_AGENT_BIND_ADDR` to `127.0.0.1:4318`, defaults the provider to
`synthetic`, and clears inherited `VIVA_VOICE_SESSION_TOKEN_SECRET` and
`VIVA_VOICE_WS_BEARER_TOKEN` values before `dotenvy` reads `.env`. That is
intentional: a root `.env` copied from production must not make the local
synthetic `/session` page require a signed credential.

For the signed-session path, set `VIVA_VOICE_SESSION_TOKEN_SECRET` and run:

```sh
bun run dev:agent:signed
```

Use the signed path for production-like testing only. Session-credential signing
is required for public/non-loopback deployments and is paired with BAC-338 nonce
replay hardening. Public binds still fail closed without auth and
`VIVA_VOICE_WS_ALLOWED_ORIGINS` configured, per BAC-337.

## Wire Surface

The service speaks one protocol on one route.

| Fact | Value |
| --- | --- |
| Route | `wss://<agent-origin>/ws` |
| Protocol version | v5, the only accepted and emitted version; a v4 frame is rejected, never upgraded |
| Capture format | 24 kHz mono `pcm_s16le` |
| Browser-sendable frames | `session_config`, `session_refresh`, `audio_chunk`, `audio_end`, `turn_intent`, `cancel`, `stop` |
| One chunk | at most 4,096 samples / 8,192 bytes |
| One turn | at most 1,080,000 samples / 2,160,000 bytes, resolving within 45 seconds |
| Text frame ceiling | 65,536 bytes |
| Study mode | exactly `quiz`; any other value is rejected at `$.session.mode` |

`select_next_question`, `evaluate_spoken_answer`, `retrieve_source_reference`,
`challenge_correction`, and `build_session_recap` are the five tools the brain
can propose. Concept status and the next review date are not among them: both
are derived from server state inside a persisted turn outcome, so a model can
never propose a mastery claim or a due date.

Deterministic failure controls are hard-off by default. To run a hosted
test/monitor scenario, enable all gates together: `VIVA_FAILURE_CONTROL_ENABLED=1`,
one `VIVA_FAILURE_CONTROL_SCENARIO`, `VIVA_FAILURE_CONTROL_SECRET`,
`VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS`,
`VIVA_FAILURE_CONTROL_STUDY_SET_IDS`,
`VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS`, and
`VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY`. The selected scenario is
embedded as a separately signed claim inside the normal signed session
credential and is accepted only for the configured synthetic identity, study
set, origin, session, expiry, and nonce. Do not enable it for learner identities
or release evidence generation.

Running from `agent/` directly is still supported for service-only work:

```sh
cd agent
cp .env.example .env
cargo run -p agent-service
```

## Store And Durability

Leave `DATABASE_URL` and `VIVA_AGENT_DATABASE_URL` unset for the default
in-memory fixture store. Setting either value opts the service into Postgres,
runs the 18 tracked migrations in `agent/migrations` on boot, and makes `/ready`
report a durable `postgres` store.

Restart and multi-instance expectations under Postgres:

- migrations are idempotent and replayable; a second boot against an already
  migrated database is a no-op;
- session, recap, review-schedule, and answer-envelope writes are guarded for
  atomic replay, so a restarted or duplicated process does not double-apply a
  turn;
- two service instances may share one database; identity, nonce replay
  protection, and deletion are all resolved in the store, not in process memory;
- deleting a study set runs the `hard_purge_text` policy and is
  non-resurrecting: a fixture seed cannot recreate purged material behind the
  content-free tombstone.

Under the default in-memory store, none of that survives a restart. The
in-memory backend is a fixture store for local work, and it is not a durability
claim.

`bun run validate` never requires Postgres. That is deliberate, and it is also
why a local Postgres run is never accepted as release proof: the continuous
durable evidence comes from the **`Durable Postgres proof`** CI job, which is
required on every pull request and every push to `main` and runs
`scripts/ci-durable-postgres.sh` against a real PostgreSQL 16 service container.
Release-grade durability additionally requires the deployed-database procedure in
`docs/deployment-runbook.md`.

## Session Identity

The local synthetic WebSocket accepts only the server-configured fixture identity
by default: `VIVA_VOICE_TRUSTED_USER_ID=user-1`,
`VIVA_VOICE_TRUSTED_STUDY_SET_ID=biology-midterm`, and
`VIVA_VOICE_TRUSTED_SESSION_ID=voice-session-1`. Browser-supplied session,
study-set, retrieval context, and tool result frames are rejected or stripped
before the brain or store sees them.

The example leaves `VIVA_VOICE_WS_BEARER_TOKEN` empty so local browser tests can
connect through the allowed localhost origins. If you set that value, pass it to
the browser client through `connectVivaAgent({ token })`, which sends it as a
WebSocket subprotocol credential.

When the web service mints a signed start credential it also records the voice
session at the agent in the same operation, presenting the dedicated
`VIVA_AGENT_SESSION_MINT_BEARER_TOKEN` credential. The agent requires that
credential whenever it binds beyond loopback, requires it to be byte-distinct
from every other configured credential, and accepts it for the mint/record
operation only, and only for the agent's own trusted user. It carries no general
library-read, delete, or cross-user authority. See `docs/deployment-runbook.md`
for the full deployment procedure.

## Gates

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace
```

No default gate may require provider keys, paid network calls, or a local
Postgres instance.

`bun run agent:purity` reads this workspace's `agent-domain` direct normal
dependencies from `cargo metadata`, checks them against a declared allowlist, and
scans every `agent-domain` source file for forbidden module imports. It does not
prove adapter purity, runtime behavior, or live provider behavior.

Root `bun run validate` sets `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1` for the Rust test
wrapper so sandboxed Bun runs do not require `127.0.0.1` bind permission. To
prove the WebSocket path itself, run
`cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws`
directly; that command does not opt into the skip.
