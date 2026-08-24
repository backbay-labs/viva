# Viva project state — 2026-08-23

**Scope:** Current local and remote `main`, repository structure, hosted validation, and locally executed evidence.  
**Reviewed SHA:** `4d5d8276f03635ca74c04f4d500d13ce62198dd0` — “Prepare repository for public release,” committed 2026-08-10.  
**Confidence:** High for the recorded state as of 2026-08-23.

## State summary

Local `main`, the local `origin/main` ref, and a fresh `git ls-remote origin main` all resolve to the same SHA. There are no unreviewed runtime-code modifications in this audit; the review documents and `.impeccable.md` are the only intended working-tree additions.

The repository is a substantial monorepo, not a UI prototype:

```text
apps/web          Next.js 16 landing, library, live session, and same-origin BFF
packages/core     Shared browser contract, fixtures, scheduling, learner-state taxonomy
packages/tokens   Color, typography, and radius tokens
packages/ui-web   Small React primitive/icon package
agent/crates/
  agent-domain    Types, ports, tool declarations/executor
  agent-adapters  Synthetic, fake, and Cartesia/Gemini brains
  agent-service   axum HTTP/WebSocket edge, auth, limits, drain, observability
  data            In-memory and Postgres stores plus migrations
  observe         Sanitized evidence and usage types
scripts           E2E, release, redaction, hosted monitoring, rollback evidence
```

Inventory from tracked source areas:

- 278 tracked files; 199 source-area files.
- 116 TypeScript/TSX/MJS files, 32 Rust files, 14 SQL migrations, and 45 test files.
- Approximately 93,354 source/test/script/CSS lines: about 61,689 non-test and 31,665 test lines.
- Concentration is severe: `voice_ws.rs` 11,421 lines; `ws.rs` 5,467; `memory.rs` 5,145; `globals.css` 4,864; live-provider runner/LLM 3,175/3,028.

## Remote and GitHub state

| Item | Observed state |
| --- | --- |
| Remote `main` | Exact match: `4d5d8276…` |
| Latest Validate run | **Failure**, run `31401218406`, 2026-08-10 |
| Failed step | `Validate TypeScript, Rust, and purity gates` |
| Downstream gates | WebSocket replay, Chromium E2E, release evidence, and artifact upload were skipped |
| Branch protection | GitHub API returned “Branch not protected” |
| Repository rulesets | Empty list |
| Open PRs | Five visible PRs, #94–#98, last updated 2026-06-29 |

The hosted failure is concrete. Under the GitHub runner's Node 24 environment, `hosted monitor S3 uploads honor the publication deadline` ended with `cancelledByParent` / “Promise resolution is still pending but the event loop has already resolved”; the following two tests were canceled. `putS3Object` unrefs the only timeout used to abort the mocked stalled fetch. Local Node 25.5.0 passes the same test, which makes this a runtime-version compatibility defect, not proof that the hosted run is stale noise.

No statement in this review treats local green output as hosted green output.

## Local validation executed during this review

| Command | Result | What it proves | What it does not prove |
| --- | --- | --- | --- |
| `bun run validate` | Pass | Repository's default TS/Rust/hygiene path; Rust compiled and tested | Initial TS Turbo tasks were cache hits; no Postgres/live provider |
| `bun run test:scripts` | 180/180 pass | Script contracts on local Node 25.5 | Node 24 compatibility |
| `bunx turbo run typecheck lint test build --force` | 16/16 tasks pass, 0 cached | Fresh TS/React typecheck, lint, tests, production build | Browser behavior or hosted CI |
| Package tests in forced run | 56 core, 343 web, 2 UI, 1 token pass | 402 package tests | Real provider or Postgres |
| Full Rust workspace tests in validation | 396 reported pass | Domain/adapters/service/data/observe and WS fixtures | Tests guarded by missing external environment |
| `bun run e2e:browser` | Pass; zero console/page errors | Local Chromium synthetic manuscript, URL lifecycle, source folio, recap, session cap | Real microphone/live provider; durable store |
| `bun run agent:replay:ws` | 2/2 pass | Real loopback WebSocket synthetic/fake fixture replay | Browser microphone transport |
| Oversized-frame targeted test | 1/1 pass | Server closes oversized text frames with size code/reason | Correct client chunking; the client is incorrect |
| `bun audit` | **Fail**: 16 vulnerabilities | Current Bun lockfile advisory state | Exploitability of every transitive path |
| `cargo audit --file agent/Cargo.lock` | **Fail**: 2 vulnerabilities, 3 warnings | Current Rust lockfile advisory state and trees | Runtime exploitability of every advisory |
| `bun run release:check` | **Fail** with inherited signed-session config | Release harness is not isolated from developer/production env | Harness behavior in a clean CI environment |
| Sanitized-env release check with existing browser proof | Pass | Remaining release evidence path when no-secret env is enforced | A new live provider or Postgres release proof |

The first `release:check` failure was reproducible when run alone. The child synthetic agent inherited signed-session configuration, rejected an in-memory store, and exited before `/health/brain`. Clearing the no-secret session/WS variables made the check pass. The harness should construct its provider-readiness child environment the way `dev-agent.mjs` already does.

## Test totals and caveats

The test volume is real: roughly 978 reported package/script/Rust tests passed locally, plus browser E2E and direct WebSocket replay. The problem is path selection, not raw test count.

- The browser E2E uses synthetic/fake providers and written or tiny fixture answers. It does not submit a normal multi-second browser microphone answer.
- `client-audio.json` is 87 bytes; it cannot reveal the 64 KiB live-audio failure.
- Optional Postgres tests return early when `DATABASE_URL` is absent. The only CI Postgres service is `workflow_dispatch`-only.
- Real Cartesia/Gemini requires credentials and zero-retention gates; it was correctly not executed.
- `agent:test` sets `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1`. A separate direct replay gate compensates in CI only if CI reaches that step; the latest hosted run did not.

## Dependency state

`bun audit` found vulnerabilities in direct Next.js `16.2.6` and transitive `sharp`, `postcss`, and `nanoid`. The current patched thresholds reported by the audit are Next.js `>=16.2.11`, Sharp `>=0.35.0`, PostCSS `>8.5.22`, and Nano ID `>=3.3.16` for the reported advisories.

`cargo audit` found:

- `quinn-proto 0.11.14`, RUSTSEC-2026-0185, high severity; reachable through `reqwest -> agent-adapters`; patch `>=0.11.15`.
- `rsa 0.9.10`, RUSTSEC-2023-0071, medium severity, no fixed upgrade; pulled through SQLx's MySQL feature tree even though the product uses Postgres.
- Warnings for `anyhow 1.0.102`, `event-listener 5.4.1`, and yanked `spin 0.9.8`.

The SQLx workspace dependency omits `default-features = false`, so MySQL and SQLite trees are present despite a Postgres-only product. Pruning those features removes unnecessary surface and may eliminate the RSA tree.

## Current product truth

The shipped product reliably demonstrates a polished synthetic biology oral-exam manuscript with safe fixtures. It does not yet reliably deliver the broader README proposition:

- Live voice answers longer than about one second fail at the WebSocket frame limit.
- Real PDFs are not parsed.
- Library-created sets do not own the session chrome or recap projection.
- Teach/mock/cram are type-level concepts; the mounted session always sends `quiz`.
- Persisted review dates are fixed June 2026 literals.
- Live grading and recap use deterministic term matching/templates below the LLM.

## Unverified areas

Confidence is **unknown** for these environments in this review:

- Real Cartesia Ink/Sonic and Gemini calls with production credentials.
- Current hosted Railway deployments, traffic, logs, or cron monitor state.
- Postgres migration/replay/privacy behavior against an actual database.
- Cross-browser microphone behavior outside local Chromium.
- Screen-reader behavior in VoiceOver, NVDA, or JAWS.

These omissions are explicit acceptance gaps, not implied passes.
