# Viva Deployment Runbook

This is the blessed operating path for the beta Listening Manuscript. It covers
the no-secret default validation path plus the opt-in live smoke boundary. It is
not the place to add unrelated platform programs before the core voice loop is
proven.

## Topology

Run Viva as two processes behind a TLS-terminating edge/router:

- Web: the Next app in `apps/web`, served over HTTPS.
- Agent: the Rust `agent-service`, reachable from the web origin over HTTPS for
  REST endpoints and WSS for `/ws`.
- Store: in-memory by default, or managed Postgres when `DATABASE_URL` or
  `VIVA_AGENT_DATABASE_URL` is set.

The public browser should see these URLs:

```sh
export NEXT_PUBLIC_VIVA_API_URL="https://agent.viva.example.com"
export NEXT_PUBLIC_VIVA_AGENT_HTTP_URL="https://agent.viva.example.com"
export NEXT_PUBLIC_VIVA_AGENT_WS_URL="wss://agent.viva.example.com/ws"
```

`NEXT_PUBLIC_VIVA_API_URL` is the agent REST origin, not the plain web origin,
unless the edge explicitly rewrites the REST paths below from the web origin to
the agent.

The edge/router must forward:

- `https://agent.viva.example.com/health`
- `https://agent.viva.example.com/live`
- `https://agent.viva.example.com/ready`
- `https://agent.viva.example.com/health/brain`
- `https://agent.viva.example.com/study-sets/paste`
- `https://agent.viva.example.com/study-sets/library`
- `https://agent.viva.example.com/study-sets/export`
- `https://agent.viva.example.com/study-sets/{study_set_id}`
- `https://agent.viva.example.com/study-sets/{study_set_id}/sessions/{voice_session_id}`
- `wss://agent.viva.example.com/ws`

Keep the browser origin stable. A public or non-loopback agent bind fails closed
unless authentication and allowed origins are configured.

## Runtime Configuration

Default no-secret validation uses the synthetic provider and no durable store:

```sh
export VIVA_AGENT_BIND_ADDR="127.0.0.1:4318"
export VIVA_AGENT_PROVIDER="synthetic"
unset DATABASE_URL
unset VIVA_AGENT_DATABASE_URL
unset VIVA_VOICE_SESSION_TOKEN_SECRET
unset VIVA_VOICE_WS_BEARER_TOKEN
bun run dev:agent
```

Production-like direct browser WSS service start uses the Rust service directly.
Bind to the private interface your edge/router can reach, not to an unprotected
public socket:

```sh
export VIVA_AGENT_BIND_ADDR="0.0.0.0:4318"
export VIVA_AGENT_PROVIDER="synthetic"
export VIVA_VOICE_WS_ALLOWED_ORIGINS="https://viva.example.com"
export VIVA_VOICE_SESSION_TOKEN_SECRET="$(openssl rand -base64 32)"
cargo run --manifest-path agent/Cargo.toml -p agent-service
```

This direct browser WSS recipe intentionally omits `VIVA_VOICE_WS_BEARER_TOKEN`.
The `/session` page sends the signed session token in the first
`session_config` frame; it does not send a WebSocket bearer subprotocol.
REST paste/library bootstrap uses the REST bootstrap bearer path below, not this
direct WSS recipe.

Voice safety caps are optional but recommended for beta:

```sh
export VIVA_VOICE_WS_MAX_SESSIONS="32"
export VIVA_VOICE_WS_SESSION_SECONDS="1800"
export VIVA_VOICE_WS_TURN_SECONDS="45"
export VIVA_VOICE_WS_MAX_USER_SESSIONS="2"
export VIVA_VOICE_WS_MAX_IP_SESSIONS="5"
export VIVA_VOICE_WS_MAX_AUDIO_BYTES_PER_MINUTE="1440000"
export VIVA_VOICE_WS_MAX_SESSION_COST_USD="0.75"
```

The live Cartesia/Gemini provider remains opt-in Act 3 work. Do not set
`VIVA_AGENT_PROVIDER=cartesia_gemini` for default beta validation. The
`fake_cartesia_gemini` provider is a deterministic no-key provider-shaped smoke
path; it is not live.

## Managed Postgres

Leave `DATABASE_URL` and `VIVA_AGENT_DATABASE_URL` unset for the default
in-memory fixture store. Set exactly one of them to enable managed Postgres; the
service runs migrations on boot and `/ready` reports a durable `postgres` store.

```sh
export VIVA_AGENT_DATABASE_URL="postgres://viva_agent:${VIVA_DB_PASSWORD}@db.example.com:5432/viva?sslmode=require"
cargo run --manifest-path agent/Cargo.toml -p agent-service
```

After boot, verify the store state:

```sh
curl -fsS https://agent.viva.example.com/ready | jq '.store.backend, .store.durable'
```

Expected durable output is `postgres` and `true`. Expected default output is
`in_memory` and `false`. Default CI and `bun run validate` must not require
Postgres.

## Secrets And Origins

There are two supported `/session` bootstrap paths.

### No-secret loopback/dev path

`bun run dev:agent` is intentionally loopback-only. It defaults to
`127.0.0.1:4318`, selects `synthetic`, and clears inherited
`VIVA_VOICE_SESSION_TOKEN_SECRET` and `VIVA_VOICE_WS_BEARER_TOKEN`. This protects
local `/session` from a copied production-like `.env`.

```sh
bun run dev:agent
```

The browser may open `/session` with the trusted fixture identity only in this
loopback/dev mode.

### Signed-session production path

For non-loopback direct browser WSS deployments, set
`VIVA_VOICE_SESSION_TOKEN_SECRET` and `VIVA_VOICE_WS_ALLOWED_ORIGINS`. Signed
session tokens bind user, study set, session, expiry, and nonce. This path uses
the signed first frame and leaves `VIVA_VOICE_WS_BEARER_TOKEN` unset so browser
WebSocket preflight is not rejected before the signed session token arrives.

```sh
export VIVA_AGENT_BIND_ADDR="0.0.0.0:4318"
export VIVA_VOICE_WS_ALLOWED_ORIGINS="https://viva.example.com"
export VIVA_VOICE_SESSION_TOKEN_SECRET="$(openssl rand -base64 32)"
cargo run --manifest-path agent/Cargo.toml -p agent-service
```

Do not log or commit the generated secret values. Rotate them through the
deployment secret store, not through git. A public bind with neither
`VIVA_VOICE_SESSION_TOKEN_SECRET` nor `VIVA_VOICE_WS_BEARER_TOKEN` must fail
startup validation.

### REST bootstrap bearer path

Public REST paste/library bootstrap and control operations require
`VIVA_VOICE_WS_BEARER_TOKEN` because loopback-only unauthenticated bootstrap is
disabled on non-loopback binds. Use this only from a trusted server, operator
tool, or authenticated proxy:

```sh
export VIVA_VOICE_WS_BEARER_TOKEN="$(openssl rand -base64 32)"
curl -fsS \
  -H "Authorization: Bearer $VIVA_VOICE_WS_BEARER_TOKEN" \
  "$AGENT_ORIGIN/study-sets/library" | jq .
```

The same bearer also gates `/ws` preflight. Do not combine it with the direct
browser signed-session path unless the browser/proxy sends the WebSocket
`bearer.` subprotocol, for example through `connectVivaAgent({ token })`, or a
trusted WSS proxy injects the token. The current `/session` page does not do
that, so the direct browser signed-session path omits it.

## Health Checks

Use `/live` for process liveness and `/ready` for routing readiness.

```sh
AGENT_ORIGIN="https://agent.viva.example.com"
curl -fsS "$AGENT_ORIGIN/health" | jq .
curl -fsS "$AGENT_ORIGIN/live" | jq .
curl -fsS "$AGENT_ORIGIN/ready" | jq .
curl -fsS "$AGENT_ORIGIN/health/brain" | jq .
```

`/ready` returns HTTP 200 only when the provider is configured, selectable, the
store is available, and the service is not draining. It returns HTTP 503 for the
gated live provider baseline and during deploy drain. `/health/brain` reports
provider mode with `configured`, `selectable`, and `live_runtime` flags.

Expected no-secret synthetic readiness:

```json
{
  "ready": true,
  "brain": {
    "provider": "synthetic",
    "configured": true,
    "selectable": true,
    "live_runtime": false
  }
}
```

Expected gated live baseline before Act 3, when placeholder or non-production
Cartesia/Gemini key material is present only to prove configuration shape:

```json
{
  "ready": false,
  "brain": {
    "provider": "cartesia_gemini",
    "configured": true,
    "selectable": false,
    "live_runtime": false
  }
}
```

## Release Smoke

Run the no-secret default validation before every beta release:

```sh
bun install
bun run validate
VIVA_E2E_AGENT_PROVIDER=synthetic \
VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 \
  bun run e2e:browser
VIVA_AGENT_PROVIDER=fake_cartesia_gemini \
VIVA_RELEASE_CHECK_SKIP_BROWSER=1 \
  bun run release:check
```

The release evidence bundle is sanitized output only: command summaries,
fixture hashes, browser story filenames/screenshots, provider readiness matrix,
and artifact audit summary. It must show forbidden hits equal to zero.

Opt-in live smoke is separate. Only run it after Act 3 makes `/ready` selectable
for `cartesia_gemini` and after budget/time caps are set. The minimum proof is:

```sh
AGENT_ORIGIN="https://agent.viva.example.com"
export VIVA_AGENT_PROVIDER="cartesia_gemini"
: "${CARTESIA_API_KEY:?set CARTESIA_API_KEY in the secret store before live smoke}"
: "${GEMINI_API_KEY:?set GEMINI_API_KEY in the secret store before live smoke}"
curl -fsS "$AGENT_ORIGIN/ready" | jq '.brain.provider, .brain.selectable, .brain.live_runtime'
```

Do not call that live until `/ready` reports `cartesia_gemini`, `selectable: true`,
and `live_runtime: true`, and an opt-in `/ws` session reaches a sanitized
`recap_ready` event through the real provider cascade. The harness is disabled
unless `VIVA_LIVE_PROVIDER_SMOKE=1` is present, reads spoken PCM input only from
an explicit local file, and writes sanitized counters to
`artifacts/live-provider-smoke/evidence.json`:

```sh
export VIVA_LIVE_PROVIDER_SMOKE=1
export VIVA_LIVE_SMOKE_AGENT_HTTP_URL="$AGENT_ORIGIN"
export VIVA_LIVE_SMOKE_ORIGIN="https://app.viva.example.com"
export VIVA_LIVE_SMOKE_AUDIO_FILE="$PWD/artifacts/live-smoke/answer.pcm"
export VIVA_LIVE_SMOKE_MAX_DURATION_MS=90000
export VIVA_LIVE_SMOKE_MAX_TURNS=1
export VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES=262144
export VIVA_VOICE_WS_MAX_SESSION_COST_USD=0.25
bun run live:smoke
jq '.status, .websocket.required_events, .usage.events_delta' \
  artifacts/live-provider-smoke/evidence.json
```

That evidence may record readiness flags, terminal reason, event-class counts,
and usage-event deltas only. It must not retain provider keys, raw audio,
transcript content, answer content, prompts, full notes, raw provider responses,
or source excerpts.

## Rollback And Drain

Rollback is a two-step operation: remove the bad web/agent revision from routing,
then let the old agent drain voice sessions before process exit.

1. Stop sending new web traffic to the bad revision.
2. Send SIGTERM to the bad agent process.
3. Confirm `/ready` on that process returns HTTP 503 while `/live` stays HTTP
   200 until process exit.
4. Confirm new `/ws` preflights fail with HTTP 503 and `voice session draining`.
5. Confirm active manuscripts receive a terminal `session_phase` event with
   terminal reason `drained`.

The Rust service handles SIGTERM and Ctrl-C by calling `begin_drain()`, waiting a
two-second grace period, then allowing shutdown to complete. During drain, the
manuscript must close honestly as a drained session instead of pretending it
reached recap.

Operator checks:

```sh
kill -TERM "$VIVA_AGENT_PID"
live_status="$(curl -fsS -o /tmp/viva-live.json -w '%{http_code}' "$AGENT_ORIGIN/live")"
ready_status="$(curl -sS -o /tmp/viva-ready.json -w '%{http_code}' "$AGENT_ORIGIN/ready")"
test "$live_status" = "200"
test "$ready_status" = "503"
cat /tmp/viva-ready.json
```

If rollback is due to a provider or store fault, return `VIVA_AGENT_PROVIDER` to
`synthetic` and unset `DATABASE_URL` / `VIVA_AGENT_DATABASE_URL` only for the
default no-secret validation path. Do not delete managed Postgres data as part
of application rollback.

## Logs And Evidence Redaction

Logs and release artifacts may contain operational facts only: command names,
exit codes, durations, provider mode flags, HTTP statuses, fixture hashes,
browser artifact filenames, and sanitized store capability flags.

Logs and artifacts must never contain:

- provider keys
- bearer tokens or session tokens
- raw audio
- transcript text
- answer text
- prompts
- full notes
- unrestricted source excerpts
- raw provider responses

Validate redaction before attaching release evidence:

```sh
VIVA_AGENT_PROVIDER=fake_cartesia_gemini \
VIVA_RELEASE_CHECK_SKIP_BROWSER=1 \
  bun run release:check
node -e 'const e=require("./artifacts/release-check/evidence.json"); if (e.artifact_audit.forbidden_hits !== 0) process.exit(1); console.log(e.artifact_audit)'
```

If forbidden hits are nonzero, do not publish the bundle. Delete the generated
artifact directory, fix the leak, rerun the release smoke, and attach only the
new sanitized bundle.
