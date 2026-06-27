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
path; it is not live. The server-side live transport gate is
`VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1`; it must stay unset unless real
Cartesia/Gemini credentials, provider zero-data-retention confirmations, budget
caps, and the opt-in live smoke proof are being run. Set
`CARTESIA_ZERO_DATA_RETENTION_ENABLED=1` only after Cartesia Enterprise ZDR is
enabled for the Viva organization. Set `GEMINI_ZERO_DATA_RETENTION_APPROVED=1`
only after the Gemini Developer API project has ZDR approval, as described in
`docs/data-governance.md`.

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

### Deterministic failure controls

Failure controls are for hosted test environments and budget-capped synthetic
monitor identities only. They are unavailable to normal learner traffic unless
all gates are deliberately enabled: `VIVA_FAILURE_CONTROL_ENABLED=1`,
`VIVA_FAILURE_CONTROL_SCENARIO`, `VIVA_FAILURE_CONTROL_SECRET`,
`VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS`,
`VIVA_FAILURE_CONTROL_STUDY_SET_IDS`,
`VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS`, and
`VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY`. The control claim is signed
separately from the session token and bound to user, study set, session, origin,
run id, expiry, and nonce. Do not create a public generic force-failure endpoint.

For browser proof, select one scenario deterministically:

```sh
VIVA_E2E_FAILURE_CONTROL_SCENARIO=provider_rate_limited \
  bun run e2e:browser
```

The browser evidence records scenario id, failure class, stage, terminal reason,
event index, validation run id, screenshots, and sanitized harness state. It
must not contain raw audio, transcripts, learner answers, provider payloads,
session tokens, control secrets, API keys, or bearer tokens.

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
trusted WSS proxy injects the token. The same-origin session bootstrap path does
not expose this REST bearer; `/session` reuses the signed session token as the
WebSocket protocol credential.

### Same-origin session bootstrap

Production web must use server-only same-origin session bootstrap. Browser
library snapshots served through `/api/viva-library/study-sets/library` keep
start/resume availability and session ids, but strip start/resume session token
fields before the snapshot reaches the client. Server-bearer-backed snapshots
are filtered to `VIVA_SESSION_ALLOWED_USER_IDS` and
`VIVA_SESSION_ALLOWED_STUDY_SET_IDS`, remove server-only token fields, and carry
only short-lived `session_bootstrap_token` capabilities for allowed start/resume
actions. The browser obtains the minimum signed material for `/ws` only by
POSTing that capability to `/api/viva-session/start` or by presenting an
existing signed token to `/api/viva-session/refresh`.

Client-side library refresh, export, and delete controls must also use the
same-origin `/api/viva-library` proxy, even when `NEXT_PUBLIC_VIVA_API_URL` or
`NEXT_PUBLIC_VIVA_AGENT_HTTP_URL` points at the public agent origin for readiness
and session transport.

Configure the web service with the intended Railway agent URL and REST bearer in
server-only variables. The web service must share the agent's session signing
secret so `/api/viva-session/refresh` can validate existing token signatures
before asking the agent for a fresh resume token:

```sh
VIVA_AGENT_HTTP_URL="https://agent.viva.example.com"
VIVA_AGENT_REST_BEARER_TOKEN="<from the web service secret store>"
VIVA_VOICE_SESSION_TOKEN_SECRET="<same value as the agent service>"
VIVA_SESSION_ALLOWED_USER_IDS="synthetic-monitor-user"
VIVA_SESSION_ALLOWED_STUDY_SET_IDS="biology-midterm"
VIVA_SESSION_MINT_MAX_PER_MINUTE="12"
```

`NEXT_PUBLIC_VIVA_AGENT_HTTP_URL` may still identify the public readiness target,
but it is not a credential. Do not expose the REST bearer through any
`NEXT_PUBLIC_*` variable. The same-origin endpoints reject cross-origin callers,
rate-limit minting by client IP plus session identity, and return only
`session`, `session_token`, `token_refresh_outcome`, and `failure_class`.
Refresh validates the HMAC signature locally, treats expired signed material as
recoverable by minting a fresh resume token through the agent, and leaves nonce
replay authority with `/ws`. Refresh outcomes such as `expired_refreshed`,
`invalid_rejected`, `malformed_rejected`, `identity_mismatch`, and `blocked` are
evidence fields; logs and artifacts must not include the token value, server
bearer, agent URL secret, raw request body, or upstream error payload.
The `/session` page sends the signed session token as both the first
`session_config` credential and the WebSocket protocol credential; the agent
accepts that signed token at preflight when session-token signing is configured,
so the browser never needs the REST bearer.

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

To prove one deterministic failure path without live-provider flakiness, run:

```sh
VIVA_E2E_FAILURE_CONTROL_SCENARIO=provider_rate_limited \
  bun run e2e:browser
```

The release evidence bundle is sanitized output only: command summaries,
fixture hashes, browser story filenames/screenshots, provider readiness matrix,
failure_control_harness disabled state, rollback_drain criteria, and artifact
audit summary. It must show forbidden hits equal to zero. `bun run release:check` must fail if
`VIVA_FAILURE_CONTROL_ENABLED=1`; deterministic provider failure coverage must
come from the signed harness, not flaky real outages.

Opt-in live smoke is separate. Only run it after Act 3 makes `/ready` selectable
for `cartesia_gemini` and after budget/time caps are set. The minimum proof is:

```sh
AGENT_ORIGIN="https://agent.viva.example.com"
export VIVA_AGENT_PROVIDER="cartesia_gemini"
export VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1
export CARTESIA_ZERO_DATA_RETENTION_ENABLED=1
export GEMINI_ZERO_DATA_RETENTION_APPROVED=1
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

## Hosted E2E Monitor Substrate

BAC-530 uses a separate Railway cron service named `viva-hosted-monitor` as the
off-GitHub execution substrate. It is not GitHub Actions and it does not consume
blocked Actions minutes. The service builds from `Dockerfile.monitor`, reads
Railway deployment config from the default-discoverable `railway.json`, and runs:

```sh
bun run hosted:monitor
```

`railway.json` is intentionally scoped to the `viva-hosted-monitor` service. Do
not connect hosted web or hosted agent services to the repo root without a
service-specific Railway config path, or they will inherit the monitor
Dockerfile, cron schedule, and start command. `railway.json` configures a
short-lived Railway cron service with
`cronSchedule: "*/30 * * * *"` and `restartPolicyType: "NEVER"`. Railway cron
jobs must exit when the task finishes; a still-active prior execution causes the
next scheduled execution to be skipped. Keep the monitor as a task process, not a
web server.

Each execution writes and uploads a final sanitized `manifest.json`, including
failed or timed-out browser legs, before returning a non-zero process status.
Browser execution is bounded by `VIVA_HOSTED_RUN_TIMEOUT_MS`; durable evidence
publication is separately bounded by `VIVA_HOSTED_PUBLISH_TIMEOUT_MS` so object
storage stalls cannot pin the cron worker indefinitely.

The scheduled production monitor uses:

```sh
VIVA_HOSTED_RUNNER_MODE=scheduled
```

It runs one hosted Playwright browser-story proof against hosted web + hosted
agent, using a synthetic monitor identity, then publishes sanitized evidence to
the object prefix `viva-hosted-monitor/scheduled/<run_id>/` in the durable
artifact store.

The PR-equivalent trigger uses the same service image with:

```sh
VIVA_HOSTED_RUNNER_MODE=pr
```

Run that mode from a Railway deployment or manual service run for the branch
under review. It executes the hosted synthetic provider leg, hosted
`fake_cartesia_gemini` provider leg, and the BAC-528 failure-control browser
slice, including a deterministic provider-rate-limited terminal path. It
publishes under `viva-hosted-monitor/pr/<run_id>/`.

Required monitor variables:

```sh
VIVA_HOSTED_WEB_URL="https://viva-web.example.com"
VIVA_HOSTED_AGENT_HTTP_URL="https://viva-agent.example.com"
VIVA_HOSTED_AGENT_WS_URL="wss://viva-agent.example.com/ws"
VIVA_E2E_AGENT_PROVIDER="synthetic"
VIVA_HOSTED_REST_BEARER_TOKEN="<from the hosted agent REST auth secret store>"
VIVA_HOSTED_FAKE_PROVIDER_WEB_URL="https://viva-fake-web.example.com"
VIVA_HOSTED_FAKE_PROVIDER_AGENT_HTTP_URL="https://viva-fake-agent.example.com"
VIVA_HOSTED_FAKE_PROVIDER_AGENT_WS_URL="wss://viva-fake-agent.example.com/ws"
VIVA_HOSTED_FAILURE_CONTROL_WEB_URL="https://viva-failure-control-web.example.com"
VIVA_HOSTED_FAILURE_CONTROL_AGENT_HTTP_URL="https://viva-failure-control-agent.example.com"
VIVA_HOSTED_FAILURE_CONTROL_AGENT_WS_URL="wss://viva-failure-control-agent.example.com/ws"
VIVA_HOSTED_SYNTHETIC_USER_ID="synthetic-monitor-user"
VIVA_HOSTED_SYNTHETIC_STUDY_SET_ID="biology-midterm"
VIVA_VOICE_SESSION_TOKEN_SECRET="<from the hosted agent secret store>"
VIVA_FAILURE_CONTROL_SECRET="<from the hosted agent secret store for PR mode>"
VIVA_HOSTED_ARTIFACT_BUCKET="<Railway object bucket name>"
VIVA_HOSTED_ARTIFACT_ENDPOINT="<Railway object bucket endpoint>"
VIVA_HOSTED_ARTIFACT_REGION="auto"
VIVA_HOSTED_ARTIFACT_KEY_ID="<Railway object bucket access key id>"
VIVA_HOSTED_ARTIFACT_SECRET_KEY="<Railway object bucket secret key>"
```

The hosted agent URL must point at a synthetic or fake monitor deployment whose
provider matches `VIVA_E2E_AGENT_PROVIDER`; do not aim the scheduled monitor at a
live learner tutor endpoint. The control secret and session signing secret must
come from the deployment secret store and must match the hosted agent variables.
The PR failure-control leg must use its own hosted web and agent target that is
preconfigured with matching `VIVA_FAILURE_CONTROL_*` gates; the normal synthetic
leg and failure-control leg must not share one hosted agent origin. The runner
identity must be an allowlisted synthetic monitor identity, never a learner or
real tester. Do not print secret values while checking variables; verify presence
by key name and service configuration only.

The hosted monitor evidence is safe to attach only after `manifest.json` reports
`learner_identity_used: false`, each run reports `sanitized: true`, and the
artifact upload summary reports the expected durable object prefix. The durable
bundle intentionally publishes only text, JSON, and log artifacts; screenshots,
traces, archives, HAR files, and other binary browser captures are local-only and
must not be uploaded as hosted evidence. BAC-526 reads that object prefix as the
hosted-browser evidence bundle; `/ready` alone, a local-only run, or
`VIVA_RELEASE_CHECK_SKIP_BROWSER=1` is not production-ready evidence.

## Rollback And Drain

The numeric rollback thresholds live in `scripts/rollback-drain-criteria.mjs`
and are reused by the BAC-525 alert work. Do not fork these numbers into a
second alert table. Production rollback is required when any threshold below is
met for its full sustained duration:

| Signal | Threshold | Window | Sustained |
| --- | ---: | ---: | ---: |
| Provider 429 rate | >=10% of provider turns, minimum 20 turns and 3 failures | 600s | 300s |
| Provider timeout rate | >=5% of provider turns, minimum 20 turns and 2 failures | 600s | 300s |
| Provider auth failure | >=1 auth failure | 300s | 60s |
| Stuck checking | >=3 active submitted-answer sessions past the 45s BAC-510 bound | 120s | 120s |
| Recap failure rate | >=5% of recap attempts, minimum 20 attempts and 2 failures | 600s | 300s |
| Token refresh failure rate | >=2% of refresh attempts, minimum 20 attempts and 3 failures | 600s | 180s |
| Live monitor failure | >=2 consecutive synthetic monitor failures, minimum 2 attempts | 300s | 120s |

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

The release proof for drain is anchored by these tests:

- `ready_route_reports_unavailable_during_voice_drain`
- `websocket_preflight_rejects_new_sessions_after_drain_begins`
- `websocket_drain_emits_terminal_phase_before_close`
- `websocket_drain_interrupts_active_provider_response`

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

Before any production release, the sanitized release evidence must include:

- `VIVA_RELEASE_WEB_DEPLOY_ID`
- `VIVA_RELEASE_AGENT_DEPLOY_ID`
- `VIVA_RELEASE_CONFIG_DIFF_SHA256`
- `VIVA_RELEASE_PROVIDER_MODE`
- `VIVA_RELEASE_POSTGRES_STATE`
- `VIVA_RELEASE_RECOVERY_VALIDATION`
- `VIVA_RELEASE_OWNER`
- `VIVA_RELEASE_OWNER_DECISION=proceed`
- `VIVA_RELEASE_OWNER_DECIDED_AT_UTC`

Set `VIVA_PRODUCTION_RELEASE=1` only for the production release gate. With that
flag present, `bun run release:check` fails unless rollback thresholds, deploy
ids, redacted config diff hash, provider mode, Postgres state, recovery
validation, and the owner proceed decision are present.

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
