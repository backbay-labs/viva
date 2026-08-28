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

The edge/router must forward exactly the routes the service registers, and no others:

- `https://agent.viva.example.com/health`
- `https://agent.viva.example.com/live`
- `https://agent.viva.example.com/ready`
- `https://agent.viva.example.com/health/brain`
- `https://agent.viva.example.com/study-sets/paste`
- `https://agent.viva.example.com/study-sets/files`
- `https://agent.viva.example.com/study-sets/{study_set_id}/files/retry`
- `https://agent.viva.example.com/study-sets/library`
- `https://agent.viva.example.com/study-sets/export`
- `https://agent.viva.example.com/v1/study-sets/{study_set_id}/projection`
- `https://agent.viva.example.com/study-sets/{study_set_id}`
- `https://agent.viva.example.com/study-sets/{study_set_id}/sessions/{voice_session_id}`
- `wss://agent.viva.example.com/ws`

There is no restore route. `D-04 CONFIRM_DELETE` is the recorded branch, so both `DELETE` routes
above are permanent, and the service registers no undo endpoint to forward.

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

`VIVA_VOICE_WS_MAX_IP_SESSIONS` keys its per-IP cap off the raw socket peer
address by default, so a direct deployment needs no forwarding proxy header
at all. Set `VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS` to a comma-separated CIDR
list only when a real proxy terminates in front of the agent and its address
is worth naming as trusted:

```sh
export VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS="10.0.0.0/8"
```

When the connecting peer does not match a configured CIDR -- including the
default case of no CIDRs configured at all -- `X-Forwarded-For` is ignored
outright and the socket peer address is the session key, so a spoofed header
from a direct client can never open a second per-IP bucket. Only when the
peer itself is a trusted proxy does the service consult `X-Forwarded-For`: it
scans the comma-separated chain right to left, skips any hop that is itself a
trusted proxy, and takes the first untrusted hop as the client address.
`X-Real-IP` is never consulted. A trusted peer that omits the header, sends a
malformed or oversized (over 32 hops) chain, or names only trusted hops is
rejected before a session slot or IP lease is acquired -- there is no
unattributed fallback to the peer address in that case.

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
`in_memory` and `false`. `bun run validate` must not require Postgres.

### Migration, restart, and multi-instance proof

The continuous half of this is already automated: the required CI job
`Durable Postgres proof` runs `scripts/ci-durable-postgres.sh` against a real
PostgreSQL 16 service container on every pull request and every push to `main`.
Release-grade durability adds one disposable-database pass against the deployed
schema, and it is not satisfied by a developer's own database:

1. **Migrate from empty.** Point a fresh, empty database at the service and boot
   it. All 18 migrations in `agent/migrations` apply in order.
2. **Replay.** Boot a second time against the same database. Migrations are
   idempotent, so the second boot applies nothing and `/ready` still reports
   `postgres` / `true`.
3. **Restart.** Write a session, a recap, a review-schedule decision, and an
   answer envelope; restart the process; confirm every row is still readable and
   that the replay guards refuse a duplicate application of the same turn.
4. **Two instances.** Run two service instances against one database and confirm
   identity, nonce replay protection, and deletion all resolve in the store
   rather than in process memory.
5. **Delete and do not resurrect.** Delete a study set, confirm the
   `hard_purge_text` purge removed the learner text, then re-run the fixture seed
   and confirm it does not recreate material behind the content-free tombstone.

Record the database identity, the migration list applied, and the exact SHA under
test with the run. Do not delete managed data to "reset" between steps of a
release proof; use a fresh disposable database.

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

When `/api/viva-session/start` mints a signed start token, the web service
records the voice session at the agent in the same operation (the signed-start
deadlock fix, `A-32`), presenting a dedicated agent credential:

```sh
VIVA_AGENT_SESSION_MINT_BEARER_TOKEN="<from the web service secret store>"
```

The agent requires this credential whenever it binds beyond loopback. Its value
is 32–512 bytes, must be byte-distinct from every other configured bearer (the
agent fails closed at startup on any collision), and requires
`VIVA_VOICE_SESSION_TOKEN_SECRET` to be configured alongside it. The agent
accepts it for the mint/record operation only, and only for the agent's own
trusted user: it carries no general library-read, delete, or cross-user
authority (`A-36`).
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
  bun run release:check
```

To prove one deterministic failure path without live-provider flakiness, run:

```sh
VIVA_E2E_FAILURE_CONTROL_SCENARIO=provider_rate_limited \
  bun run e2e:browser
```

The release evidence bundle is sanitized output only: command summaries,
fixture hashes, browser story filenames/screenshots, provider readiness matrix,
failure_control_harness disabled state, rollback_drain criteria,
provider_failure_observability dashboard criteria, hosted_e2e_matrix contract,
production_release_gate summary, release_bundle integrity hash/signature, and
artifact audit summary. It must show forbidden hits equal to zero.
`bun run release:check` must fail if `VIVA_FAILURE_CONTROL_ENABLED=1`;
deterministic provider failure coverage must come from the signed harness, not
flaky real outages. Do not set `VIVA_RELEASE_CHECK_SKIP_BROWSER=1` for release
evidence; a browser-skipped result cannot certify production readiness.

Opt-in live smoke is separate. Only run it after Act 3 makes `/ready` selectable
for `cartesia_gemini` and after budget/time caps are set. Confirm the agent
deployment itself (never this shell) sets `VIVA_AGENT_PROVIDER=cartesia_gemini`,
`VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1`, `CARTESIA_API_KEY`, `GEMINI_API_KEY`,
`CARTESIA_ZERO_DATA_RETENTION_ENABLED=1`, and `GEMINI_ZERO_DATA_RETENTION_APPROVED=1`
before continuing:

```sh
AGENT_ORIGIN="https://agent.viva.example.com"
curl -fsS "$AGENT_ORIGIN/ready" | jq '.brain.provider, .brain.selectable, .brain.live_runtime'
```

Do not call that live until `/ready` reports `cartesia_gemini`, `selectable: true`,
and `live_runtime: true`, and an opt-in `/ws` session reaches a sanitized
`recap_ready` event through the real provider cascade. The harness is disabled
unless `VIVA_LIVE_PROVIDER_SMOKE=1` is present, reads spoken PCM input only from
an explicit local file, and writes sanitized counters to
`artifacts/live-provider-smoke/evidence.json`.
RELEASE-016/021: `bun run live:smoke` never reads `CARTESIA_API_KEY`,
`GEMINI_API_KEY`, `CARTESIA_ZERO_DATA_RETENTION_ENABLED`, or
`GEMINI_ZERO_DATA_RETENTION_APPROVED` directly -- the agent deployment above
is the only component that holds them. Set
`VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED=1` instead, once the `/ready` check
above has confirmed they are configured there:

```sh
export VIVA_LIVE_PROVIDER_SMOKE=1
export VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED=1
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
Dockerfile, cron schedule, and start command. This is about Railway's own
service-config discovery root, a separate concern from the Docker **build
context** both Dockerfiles use — see
[Container supply chain](#container-supply-chain-release-026) below, which
builds `agent/Dockerfile` and `Dockerfile.monitor` from the repository root
as their build context so each `COPY` can reach everything it needs; that
build-context requirement does not change which `railway.json` a hosted
service discovers. `railway.json` configures a
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
artifact store. The scheduled manifest includes the BAC-524 hosted matrix
contract and the BAC-510 evidence-field contract for the scheduled profile; the
high-cadence synthetic happy-path leg is the only default cron leg. Leave
`VIVA_HOSTED_MATRIX_PROFILE` unset for scheduled cron, or set it explicitly to
`scheduled`; the runner rejects `full` in scheduled mode so the manifest cannot
claim PR-only failure-control coverage. The cron cadence remains 30 minutes, so
the synthetic monitor is bounded to at most 48 runs per day.

The PR-equivalent trigger uses the same service image with:

```sh
VIVA_HOSTED_RUNNER_MODE=pr
```

Run that mode from a Railway deployment or manual service run for the branch
under review. It executes three baseline PR browser legs: hosted synthetic
provider, hosted `fake_cartesia_gemini` provider, and token-free session-history
URL audit. It also runs the BAC-528 deterministic failure-control scenarios that
do not require explicit browser action: provider 429, provider timeout,
silent stall, provider auth failure, malformed stream, network disconnect,
Sonic/TTS timeout, recap timeout, and stale socket. The default PR profile does
not run the deterministic partial-recap contract row, double submit race,
mic denied, typed fallback, or session-auth material rows. Those rows remain in
the matrix contract until a runner explicitly opts into their required browser
or bearer-preflight controls. The default PR profile is
`VIVA_HOSTED_MATRIX_PROFILE=full` when the variable is unset in PR mode; to run
a smaller operational subset during manual triage, set
`VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS` to a comma separated list such as:

```sh
VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS="provider_rate_limited,provider_timeout"
```

The full PR manifest publishes under `viva-hosted-monitor/pr/<run_id>/` and
records one sanitized `hosted_e2e` result summary per executed scenario. When
`VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS` names a smaller subset, the published
matrix is filtered to the three baseline PR browser legs plus the selected
failure-control rows and includes `scenario_subset` metadata, so consumers do
not treat unexecuted failure controls as covered. The matrix contract also names
future product slices for ingestion/pre-loop failure (`BAC-532`) and second-tab
reconciliation (`BAC-535`) without treating them as passing default PR legs
before their owning product issues land.

The optional live monitor is low cadence and opt-in only:

```sh
VIVA_HOSTED_LIVE_MONITOR_ENABLED=1
```

Do not enable it until live provider zero-retention confirmations and Gemini
quota evidence are current. The BAC-524 policy caps it to one turn, 90 seconds,
262144 audio bytes, 0.25 USD per run, 0.50 USD per day, 4096 tokens per run,
8192 tokens per day, at most two runs per day, and a minimum six-hour cadence.
The live monitor must charge the separate `viva-monitor-live-smoke` budget
bucket, never learner traffic. When enabled, the scheduled runner adds
`scheduled_hosted_live_smoke` only when persisted scheduler state proves the
minimum cadence, daily budget, and self-quarantine gates are open. It invokes
`bun run live:smoke` against the dedicated live-monitor target, maps the hosted
bearer into `VIVA_VOICE_WS_BEARER_TOKEN`, passes the policy caps as
`VIVA_LIVE_SMOKE_*`, `VIVA_VOICE_WS_MAX_SESSION_COST_USD`, and
`VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD`, publishes the sanitized
live-smoke evidence beside the browser proof, and records the self-quarantine
cooldown evidence when the smoke terminates with `provider_rate_limited` /
`quota_rate_failure`. If the monitor itself observes two consecutive
provider-rate-limit terminal results inside one hour, self-quarantine live runs
for six hours and dedupe alerts for 30 minutes.

Common monitor variables:

```sh
VIVA_HOSTED_WEB_URL="https://viva-web.example.com"
VIVA_HOSTED_AGENT_HTTP_URL="https://viva-agent.example.com"
VIVA_HOSTED_AGENT_WS_URL="wss://viva-agent.example.com/ws"
VIVA_E2E_AGENT_PROVIDER="synthetic"
VIVA_HOSTED_REST_BEARER_TOKEN="<from the hosted agent REST auth secret store>"
VIVA_HOSTED_FAKE_PROVIDER_WEB_URL="https://viva-fake-web.example.com"
VIVA_HOSTED_FAKE_PROVIDER_AGENT_HTTP_URL="https://viva-fake-agent.example.com"
VIVA_HOSTED_FAKE_PROVIDER_AGENT_WS_URL="wss://viva-fake-agent.example.com/ws"
VIVA_HOSTED_SYNTHETIC_USER_ID="synthetic-monitor-user"
VIVA_HOSTED_SYNTHETIC_STUDY_SET_ID="biology-midterm"
VIVA_FAILURE_CONTROL_SECRET="<from the hosted agent secret store for PR mode>"
VIVA_HOSTED_ARTIFACT_BUCKET="<Railway object bucket name>"
VIVA_HOSTED_ARTIFACT_ENDPOINT="<Railway object bucket endpoint>"
VIVA_HOSTED_ARTIFACT_REGION="auto"
VIVA_HOSTED_ARTIFACT_KEY_ID="<Railway object bucket access key id>"
VIVA_HOSTED_ARTIFACT_SECRET_KEY="<Railway object bucket secret key>"
```

Full PR mode needs one isolated failure-control target per selected scenario,
because the failure-control server is single-scenario by construction. For the
default `full` profile, configure each of these variable triples:

```sh
VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_RATE_LIMITED_WEB_URL="https://failure-provider-rate-limited-web.example.com"
VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_RATE_LIMITED_AGENT_HTTP_URL="https://failure-provider-rate-limited-agent.example.com"
VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_RATE_LIMITED_AGENT_WS_URL="wss://failure-provider-rate-limited-agent.example.com/ws"
VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_AUTH_FAILED_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_TIMEOUT_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_SILENT_STALL_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_MALFORMED_STREAM_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_PROVIDER_NETWORK_DISCONNECT_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_SONIC_TTS_TIMEOUT_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_RECAP_TIMEOUT_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_INVALID_TOKEN_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_EXPIRED_TOKEN_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_REPLAYED_TOKEN_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_MALFORMED_TOKEN_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_SLOW_STALE_SOCKET_CLOSE_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_DOUBLE_SUBMIT_RACE_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_MIC_DENIED_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
VIVA_HOSTED_FAILURE_CONTROL_TYPED_FALLBACK_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}
```

The legacy generic
`VIVA_HOSTED_FAILURE_CONTROL_{WEB_URL,AGENT_HTTP_URL,AGENT_WS_URL}` target is
allowed only when `VIVA_HOSTED_PR_FAILURE_CONTROL_SCENARIOS` names exactly one
scenario.

When `VIVA_HOSTED_LIVE_MONITOR_ENABLED=1`, also provide
`VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED=1`, `VIVA_VOICE_SESSION_TOKEN_SECRET`, a
pre-provisioned synthetic live-session identity, and a dedicated live-provider
target whose deployed agent reports the same remote cost cap on `/ready` and
`/health/brain`. RELEASE-016/021: the monitor's own environment never holds
`CARTESIA_API_KEY`, `GEMINI_API_KEY`,
`CARTESIA_ZERO_DATA_RETENTION_ENABLED`, or
`GEMINI_ZERO_DATA_RETENTION_APPROVED` -- the agent deployment above is the
only component that holds them; `VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED=1`
attests they are already configured and zero-retention-approved there. The
monitor image creates `/app/evidence/live-smoke-answer.pcm` at build time;
override `VIVA_HOSTED_LIVE_MONITOR_AUDIO_FILE` only when replacing it with
another sanitized spoken PCM fixture. The scheduled runner derives a fresh
UUID voice session id from `VIVA_HOSTED_LIVE_MONITOR_SESSION_ID`,
`VIVA_HOSTED_RUN_ID`, and a per-invocation nonce, and mints a fresh
single-use session capability signed with `VIVA_VOICE_SESSION_TOKEN_SECRET`
immediately before spawning `scheduled_hosted_live_smoke` -- never earlier,
and never persisted in the plan or the hosted summary. `buildHostedMonitorPlan`
validates that secret's presence synchronously, at plan-construction time, so
a misconfigured live monitor fails fast before any durable-state reservation
or a preceding leg runs, but discards the value immediately -- the check
never retains it on the plan. The capability's signed claims carry exactly
what the deployed agent's `SessionTokenClaims`
(`agent/crates/agent-service/src/config.rs`) accepts: the synthetic
`user_id`, `study_set_id`, and `session_id`, an `expires_at`, and a nonce.
That struct derives `#[serde(deny_unknown_fields)]`, so it cannot also carry
a run id, deploy SHA, agent deploy id, or provider mode -- an unrecognized
claim makes the deployed server reject the whole token as malformed before
any provider work. The run id, deploy SHA, agent deploy id, and provider mode
still travel with the run for audit, on the sanitized run record and hosted
summary outside the signed envelope; binding them cryptographically into the
verified token itself would require extending that struct (the way
`failure_control` is already nested there), which remains a deferred
capability-lane change, not something this runner can do on its own. The
token's expiry covers the run's own timeout plus an additional 60-second
safety margin -- the run's own timeout already folds in the runner's
30-second flush grace -- measured from the moment of minting, so an earlier,
slower leg in the same invocation can never eat into its validity window. The
runner maps these hosted variables into `VIVA_LIVE_SMOKE_*`, and must not let
`bun run live:smoke` bootstrap durable study text through `/study-sets/paste`.

### Durable live-monitor state (BAC-527)

The scheduled-run authority for cadence, daily budget, consecutive failures,
and self-quarantine is no longer operator-set environment state. `bun run
hosted:monitor` reads and reserves one run-independent, schema-versioned
object at `viva-hosted-monitor/state/live-monitor-state.v1.json` in the same
durable artifact store as the evidence bundle, keyed by the current UTC date
(`date_utc`) with `runs_today`, `tokens_today`, `cost_usd_today`,
`consecutive_failures`, `last_failure_at`, `last_run_at`,
`quarantined_until`, `active_reservation`, and `last_applied_run_id`. The
state object never carries a learner/provider payload or a secret value; a
schema violation or an unexpected key fails the read closed.

At startup the runner probes conditional-write support against the
configured endpoint using a dedicated probe key
(`viva-hosted-monitor/state/.cas-probe.v1.json`), never the live state
object: a PUT with a deliberately stale `If-Match` must be rejected with a
precondition failure. A store that accepts the stale precondition, or errors
on the header, is `state_unavailable` and fails the live leg closed before
any reservation is attempted. Hosted CAS behavior (an object version/ETag
transition observed across two real runs against the deployed store) is
verified only by Plan 15 handoff item 4; the local injected-fetch tests in
`scripts/hosted-monitor-state.test.mjs` prove the reservation, staleness, and
idempotency contracts, not that the deployed store itself honors
conditional-write preconditions.

Before spawning the live child, the runner reserves the maximum per-run
token and cost caps under compare-and-swap: it reads the object with its
ETag, computes cadence/quarantine/budget eligibility from the durable
fields, and writes the incremented reservation with `If-Match` (or
`If-None-Match: *` on the very first run of all time). A precondition
conflict re-reads and retries a bounded number of times, because a
concurrent invocation may have consumed the remaining budget; exhausting
those retries — like any read, auth, or schema failure — is
`state_unavailable` and fails the live leg closed rather than guessing. A
reservation is charged before the live child ever starts, and a crash after
reservation stays conservatively charged until the UTC date rolls over; it
is never refunded from unverifiable partial evidence. After the live leg
finishes, the runner finalizes the same object under CAS, updating
`consecutive_failures`, `last_failure_at`, and `quarantined_until` from the
observed outcome and clearing `active_reservation`. Both reservation and
finalization are idempotent on `last_applied_run_id`: retrying the exact
same run ID (a re-invocation of the same cron execution) neither
double-charges the budget nor double-increments the failure count. A state
finalization failure is classified `publish_failed` and cannot yield a
committed manifest — the runner uploads audited run objects, finalizes the
durable state, and uploads the run manifest last, as the commit marker.

The child process never sees the durable object or its credentials; the
runner translates the resolved decision once into the smoke's public
contract — `VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES` (the exact variable
`bun run live:smoke` reads) and `VIVA_LIVE_SMOKE_RUN_ID` — with no
`VIVA_HOSTED_*` state leaking into the child environment.

```sh
VIVA_HOSTED_LIVE_MONITOR_WEB_URL="https://viva-live-monitor-web.example.com"
VIVA_HOSTED_LIVE_MONITOR_AGENT_HTTP_URL="https://viva-live-monitor-agent.example.com"
VIVA_HOSTED_LIVE_MONITOR_AGENT_WS_URL="wss://viva-live-monitor-agent.example.com/ws"
VIVA_HOSTED_LIVE_MONITOR_AGENT_MAX_SESSION_COST_USD=0.25
VIVA_HOSTED_LIVE_MONITOR_REST_BEARER_TOKEN="<optional live monitor REST auth secret>"
VIVA_HOSTED_LIVE_MONITOR_AUDIO_FILE="/app/evidence/live-smoke-answer.pcm"
VIVA_HOSTED_LIVE_MONITOR_USER_ID="synthetic-live-monitor-user"
VIVA_HOSTED_LIVE_MONITOR_STUDY_SET_ID="live-monitor-study-set"
VIVA_HOSTED_LIVE_MONITOR_SESSION_ID="live-monitor-session-1"
VIVA_HOSTED_LIVE_MONITOR_AGENT_DEPLOY_ID="<optional; recorded on the sanitized run record and hosted summary for audit, outside the signed session capability>"
VIVA_AGENT_PROVIDER="cartesia_gemini"
VIVA_VOICE_SESSION_TOKEN_SECRET="<from the hosted agent secret store; must match the live-monitor target>"
VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED=1
```

The hosted agent URL must point at a synthetic or fake monitor deployment whose
provider matches `VIVA_E2E_AGENT_PROVIDER`; do not aim the scheduled synthetic
monitor at a live learner tutor endpoint. The live-monitor URL must point at a
separate `cartesia_gemini` deployment configured with
`VIVA_VOICE_WS_MAX_SESSION_COST_USD=0.25` or lower; `bun run live:smoke` rejects
the target if readiness omits that cap or reports a higher cap. The
`VIVA_VOICE_SESSION_TOKEN_SECRET` above must come from the deployment secret
store and must match what the live-monitor target agent itself trusts, which
may differ from the baseline scheduled-synthetic agent's secret. The PR
failure-control leg must use its
own hosted web and agent target that is preconfigured with matching
`VIVA_FAILURE_CONTROL_*` gates; the normal synthetic leg, live-monitor leg, and
failure-control leg must not share one hosted agent origin. The runner identity
must be an allowlisted synthetic monitor identity, never a learner or real
tester. Do not print secret values while checking variables; verify presence by
key name and service configuration only.

The hosted monitor evidence is safe to attach only after `manifest.json` reports
`learner_identity_used: false`, each run reports `sanitized: true`, and the
artifact upload summary reports the expected durable object prefix. Each
scenario result must include web URL, agent URL, web/agent deploy IDs when
available, provider/model, control mode, Postgres durability, terminal reason,
failure class, stage, latency, usage/cost, token-refresh outcome, recap success,
log correlation, and a redaction audit. The durable bundle intentionally
publishes only text, JSON, and log artifacts; screenshots, traces, archives, HAR
files, and other binary browser captures are local-only and must not be uploaded
as hosted evidence. BAC-526 reads that object prefix as the hosted-browser
evidence bundle; `/ready` alone, a local-only run, or
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

- `VIVA_RELEASE_RUN_ID`
- `VIVA_RELEASE_WEB_DEPLOY_ID`
- `VIVA_RELEASE_AGENT_DEPLOY_ID`
- `VIVA_RELEASE_DEPLOY_SHA`
- `VIVA_LIVE_WEB_DEPLOY_ID`
- `VIVA_LIVE_AGENT_DEPLOY_ID`
- `VIVA_RELEASE_WEB_ORIGIN`
- `VIVA_RELEASE_AGENT_ORIGIN`
- `VIVA_RELEASE_CONFIG_DIFF_SHA256`
- `VIVA_RELEASE_SECRETS_SNAPSHOT_SHA256`
- `VIVA_RELEASE_PROVIDER_MODE`
- `VIVA_RELEASE_POSTGRES_STATE`
- `VIVA_RELEASE_RECOVERY_VALIDATION`
- `VIVA_RELEASE_LIVE_SMOKE_EVIDENCE_PATH`
- `VIVA_PROVIDER_LIMITER_STATE`
- `VIVA_GEMINI_QUOTA_CONFIRMED=1`
- `VIVA_GEMINI_QUOTA_RPM_LIMIT`
- `VIVA_GEMINI_QUOTA_TPM_LIMIT`
- `VIVA_RELEASE_BUNDLE_SIGNING_SECRET`
- `VIVA_RELEASE_AGENT_IMAGE_DIGEST`
- `VIVA_RELEASE_MONITOR_IMAGE_DIGEST`
- `VIVA_RELEASE_OWNER`
- `VIVA_RELEASE_OWNER_DECISION=proceed`
- `VIVA_RELEASE_OWNER_DECIDED_AT_UTC`

Set `VIVA_PRODUCTION_RELEASE=1` only for the production release gate. With that
flag present, `bun run release:check` fails unless rollback thresholds, deploy
ids, currently-live deploy ids, hosted browser deploy ids, redacted config and
secret snapshot hashes, provider mode/model, durable Postgres state,
budget-capped live smoke evidence, submitted-answer recovery matrix,
provider-failure recovery proof, BAC-528 harness-disabled state, BAC-531
consent/deletion proof, BAC-529 Gemini quota sufficiency, pinned container
build inputs and matching agent/monitor output-image digests, release bundle
signature, and the owner proceed decision are present. The gate rejects stale
evidence over 24 hours old, deploy-id mismatches, missing hosted browser
evidence, browser-skipped evidence, and any ephemeral durability mode while
BAC-520/BAC-521/BAC-522 durable-state proof is claimed.

### Exact run and deploy binding (RELEASE-003/007/008)

Fresh, sanitized, and schema-valid evidence is not by itself proof that a
piece of evidence came from *this* release's own run and deploy. Every import
this gate trusts is bound to the exact release identity, not merely dated and
well-formed:

- **Hosted monitor manifest resolution requires `VIVA_RELEASE_RUN_ID` before
  resolving any production path** — even when an explicit
  `VIVA_RELEASE_HOSTED_MONITOR_MANIFEST_PATH` is supplied. A production
  import can never fall back to the lexicographically latest run directory
  under `artifacts/hosted-monitor/<mode>/`; that convenience fallback exists
  for non-production local/PR runs only, and even there the resulting gate's
  `allowed` can never become `true` because `VIVA_PRODUCTION_RELEASE` is
  unset. Once resolved, the manifest's own `run_id` must equal
  `VIVA_RELEASE_RUN_ID` exactly — a one-character difference is rejected —
  and `sanitized` must be strictly `true`; missing or `null` no longer passes
  silently the way only an explicit `false` once did.
- **Every passed hosted browser run's `deploy_ids.web`/`.agent` is checked
  against the release's own `VIVA_RELEASE_WEB_DEPLOY_ID`/
  `VIVA_RELEASE_AGENT_DEPLOY_ID`** in production — not only the runs a
  required recovery scenario names. A production import without both
  expected deploy ids configured is rejected outright rather than silently
  skipping the comparison; the target a run actually exercised must be
  mapped explicitly, never left to whatever the evidence happened to carry.
- **Live smoke evidence (`live_smoke.run_id`/`.agent_deploy_id`/
  `.deploy_sha`) must equal `VIVA_RELEASE_RUN_ID`/`VIVA_RELEASE_AGENT_DEPLOY_ID`/
  `VIVA_RELEASE_DEPLOY_SHA`** in production. All three are the release's own
  primary identity keys and are all always required — a missing expected
  value (including an unset `VIVA_RELEASE_DEPLOY_SHA`, or live smoke
  evidence that omits its own `deploy_sha`) is a verification failure, not
  a skip, exactly like a real mismatch. Each of the three binds to its own
  distinct missing-evidence id (`live_smoke_run_id_match`,
  `live_smoke_agent_deploy_match`, `live_smoke_deploy_sha_match`) so a
  binding failure is diagnosable on its own, separate from
  `budget_capped_live_smoke`. `live-provider-smoke.mjs` writes `run_id`,
  `agent_deploy_id`, and `deploy_sha` both at the top level of its own
  evidence and inside the monitor correlation summary; set
  `VIVA_LIVE_SMOKE_AGENT_DEPLOY_ID` alongside the existing
  `VIVA_LIVE_SMOKE_RUN_ID` when invoking it directly.

### Downstream bundle verification (RELEASE-004)

Signing a bundle at generation time only proves it was self-consistent for
whatever algorithm and environment produced it. It does not prove a *later*
reader, in a *different* environment, should trust it: storage could be
overwritten with a bundle relabeled `sha256-self`, or an old, honestly
correctly-signed bundle could simply be reused for a different run or
deploy than the one actually being verified right now. A separate,
downstream command re-verifies a stored bundle from a fresh environment,
after generation and storage:

```sh
VIVA_RELEASE_BUNDLE_SIGNING_SECRET="$VIVA_RELEASE_BUNDLE_SIGNING_SECRET" \
  bun run release:verify -- artifacts/release-check/evidence.json
```

`scripts/verify-release-bundle.mjs` accepts exactly one evidence path and,
whenever the stored bundle's own `production_release_gate.production_requested`
is `true`:

- requires a non-empty `VIVA_RELEASE_BUNDLE_SIGNING_SECRET` in its own
  environment, requires the stored bundle's own `signature_algorithm` to be
  exactly `hmac-sha256`, and requires `signature_key_present` to be `true`,
  all before any signature is even compared. A verifying environment with no
  secret is rejected outright, never silently downgraded into comparing the
  bundle's own claimed `sha256-self` value against itself;
- recomputes the HMAC over the stored payload with its own secret and
  rejects a mismatch (a wrong secret, or any tamper to the bundle after it
  was written);
- separately re-checks freshness **at verification time**, via
  `assertFreshProductionEvidence`: it recomputes `evidence.generated_at`'s
  age against this command's own "now", independent of whatever
  `production_release_gate.allowed` said back when the bundle was generated,
  and rejects a bundle that is stale at verification time using the same
  canonical `VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS` override (24 hours by
  default) every other freshness seam honors — so a bundle that was
  genuinely fresh at generation but has since aged past the window is
  rejected here even though its stored `gate.allowed` still says `true`. A
  future-dated `generated_at` is rejected the same way;
- separately requires `VIVA_RELEASE_RUN_ID`, `VIVA_RELEASE_DEPLOY_SHA`,
  `VIVA_RELEASE_WEB_DEPLOY_ID`, and `VIVA_RELEASE_AGENT_DEPLOY_ID` from its
  own environment and rejects a bundle whose bound identity
  (`live_smoke.run_id`/`.deploy_sha`, `deploy_identity.release_deploy_ids.web`/
  `.agent`) differs from any one of them, so a stale bundle valid for a
  different run or deploy is rejected exactly like a tampered one. A missing
  expected value is a verification failure, never a silently skipped check;
- runs the same `assertProductionReleaseGate` check `release-check.mjs`
  itself runs, so a validly signed but incomplete bundle is still rejected.

On success it prints one sanitized JSON line — `schema`, `verified`,
`run_id`, `deploy_sha`, `web_deploy_id`, `agent_deploy_id`, and
`payload_sha256` only, never a secret or raw evidence field — and exits `0`;
any failure exits non-zero. Outside a production-requested bundle this same
command stays diagnosable but that bundle's own `production_release_gate`
can never itself become `allowed: true`. Plan 15 supplies the real secret
and runs this command in the authorized deployment/release environment; it
is not executed against a live production target from this repository's own
scripts.

### Container supply chain (RELEASE-026)

`agent/Dockerfile` and `Dockerfile.monitor` pin every `FROM` to an immutable
`sha256:` index digest, not a mutable tag — the reviewed indexes as of
2026-08-23:

- `rust:1.94.1-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2`
  (agent build stage)
- `debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241`
  (agent runtime stage)
- `mcr.microsoft.com/playwright:v1.61.0-noble@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a`
  (monitor image — the tag's own Playwright version is kept equal to
  `bun.lock`'s resolved `playwright` package version, since a mismatch
  between the npm package and the image's bundled browsers breaks the
  browser story)

`Dockerfile.monitor` installs Bun 1.3.3 from verified release bytes instead
of piping `curl` into a shell: it downloads the exact `bun-v1.3.3` release
archive selected by `TARGETARCH`, checks it with `sha256sum -c` against the
pinned checksum for that architecture, rejects an unrecognized architecture,
and deletes the downloaded archive and its extraction directory in the same
`RUN` layer that created them:

```text
linux/amd64 bun-linux-x64.zip     f5c546736f955141459de231167b6fdf7b01418e8be3609f2cde9dfe46a93a3d
linux/arm64 bun-linux-aarch64.zip 41b9f4f25256db897c2c135320e4f96c373e20ae6f06d8015187dac83591efc8
```

Both runtime images drop root before `CMD`: the agent image runs as fixed
uid/gid `10001:10001`, and the monitor image runs as the Playwright base
image's own `pwuser`, with `/app/evidence` explicitly owned by `pwuser` so
the live-smoke fixture and evidence directory stay writable non-root. All
`apt-get`/`espeak-ng`/`ffmpeg` build-time work happens before the `USER`
switch; neither image re-enters root afterward.

Sanitized release evidence records `container_provenance` with two distinct
parts. `build_inputs` — the three base-image digests above, both Bun archive
checksums, and the Bun version — is always knowable locally, straight from
the committed Dockerfiles, so it is present in every run including
non-production ones. `deployment_outputs` is knowable only from the actual
selected deployment and is never inferred from a `FROM` line: outside a
production release it always reports `status: "not_proven"` with both
digest fields `null`. Production evidence additionally requires:

- `VIVA_RELEASE_AGENT_IMAGE_DIGEST`
- `VIVA_RELEASE_MONITOR_IMAGE_DIGEST`

Each must be an exact `sha256:` digest — a mutable tag, a malformed value, a
missing value, or the two values swapped between agent and monitor all fail
the gate the same way a missing value does. `assertProductionReleaseGate`
compares the *stored* evidence's `deployment_outputs` digests against the
*verifying* environment's own `VIVA_RELEASE_AGENT_IMAGE_DIGEST`/
`VIVA_RELEASE_MONITOR_IMAGE_DIGEST` — the same binding pattern as
[Exact run and deploy binding](#exact-run-and-deploy-binding-release-003007008)
above — so a stale or tampered digest is rejected exactly like a real
mismatch, and a base-image `build_inputs` digest can never masquerade as
deployed provenance because the gate never reads `build_inputs` when
checking `deployment_outputs`.

Local image/runtime verification (not hosted or deployed proof) — run
`node scripts/container-runtime-smoke.mjs` for the bounded, timed,
repeatable form of these same six checks; equivalently, by hand:

```sh
docker build -f agent/Dockerfile . -t viva-agent-supply-chain-test
docker run --rm --entrypoint sh viva-agent-supply-chain-test \
  -c 'test "$(id -u)" = 10001 && test "$(id -g)" = 10001'
docker build -f Dockerfile.monitor . -t viva-monitor-supply-chain-test
docker run --rm --entrypoint sh viva-monitor-supply-chain-test \
  -c 'test "$(id -u)" != 0 && test "$(bun --version)" = 1.3.3 && test -r /app/evidence/live-smoke-answer.pcm && test -w /app/evidence'
docker run --rm --read-only --tmpfs /tmp --entrypoint sh viva-agent-supply-chain-test \
  -c 'test "$(id -u)" = 10001 && touch /tmp/agent-write-probe'
docker run --rm --read-only --tmpfs /tmp \
  --tmpfs /app/evidence:rw,uid=1001,gid=1001,mode=0750 --entrypoint sh viva-monitor-supply-chain-test \
  -c 'test "$(id -u)" != 0 && touch /tmp/monitor-write-probe && touch /app/evidence/monitor-write-probe'
```

Both builds use the repository root as their build context, not `agent`:
`agent/crates/agent-domain`'s `include_str!` of
`packages/core/src/learner-loop-contract.json` reaches a sibling of `agent/`
that a context scoped to `agent/` alone cannot COPY (Docker refuses a path
outside the build context); `agent/Dockerfile`'s own COPY instructions are
prefixed accordingly, and a root `.dockerignore` keeps that wider context
from sending host-only build output (`node_modules`, `agent/target`, `.git`,
…) to the daemon. The monitor's `--tmpfs /app/evidence` mount uses
`uid=1001,gid=1001` — confirmed by running `id pwuser` inside the built
image — because the Playwright base image's `pwuser` is not uid/gid 1000.

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
  bun run release:check
node -e 'const e=require("./artifacts/release-check/evidence.json"); if (e.artifact_audit.forbidden_hits !== 0) process.exit(1); console.log(e.artifact_audit)'
```

If forbidden hits are nonzero, do not publish the bundle. Delete the generated
artifact directory, fix the leak, rerun the release smoke, and attach only the
new sanitized bundle.

## External Gates And `BLOCKED_EXTERNAL`

Everything above this heading is something the repository, its workflow, or an
operator running these commands can prove. Six things are not, and each has a
named accountable owner rather than a command: hosted exact-SHA validation
(`OPS-01`), enforced branch protection (`OPS-02`), an exact deployment
(`OPS-03`), live provider and zero-retention attestation (`OPS-04`), real device,
browser, and screen-reader behavior (`OPS-05`), and the release owner's decision
(`OPS-06`).

`BLOCKED_EXTERNAL` is the only legal way to record one of those six as
outstanding, and it is legal for those six alone. Recording it requires the whole
reason object, not a note:

| Field | What it must carry |
| --- | --- |
| `code` | The fixed reason code for that gate |
| `owner` | The accountable role, not a person's convenience |
| `blocked_at` | A UTC instant |
| `attempted` | The exact command or URL that was actually attempted |
| `last_observed_state` | The exact externally observed state, for example `project access denied` |
| `required_action` | What the accountable owner must do |
| `required_evidence` | The identities that will prove it, bound to the frozen SHA |
| `next_check_at` | A UTC instant |
| `applies_to_frozen_sha` | The exact SHA the block applies to |

Two rules keep that honest:

1. **Only external gates may be blocked.** A missing executable, an absent
   database, a skipped test, a cache-only result, or a local test failure is a
   plain failure. Reclassifying one of those as `BLOCKED_EXTERNAL` is the
   specific misuse this section exists to forbid.
2. **A gate that never ran is a failure, not a block.** Pending status is earned
   by recording the reason object above; it is never granted by omission, and it
   is never inherited from a green local or hosted run.

The status vocabulary those gates feed, and the rule that no local proof ever
promotes an external gate, are defined in
[release-readiness.md](release-readiness.md).
