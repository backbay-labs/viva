# Code Review: E2E, smoke, and monitoring scripts

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | scripts/e2e-browser.mjs, scripts/e2e-browser-static.test.mjs, scripts/hosted-e2e-matrix.mjs(+test), scripts/hosted-monitor-runner.mjs(+test), scripts/live-provider-smoke.mjs(+test), scripts/live-provider-failure-matrix.mjs(+test), scripts/provider-readiness-matrix.mjs(+test), scripts/provider-limiter-evidence.mjs(+test), scripts/provider-failure-observability.mjs(+test), scripts/browser-evidence.mjs(+test), scripts/dev-agent.mjs(+test), scripts/fixtures/, Dockerfile.monitor |
| **Verdict** | sound-with-fixes |
| **Confidence** | High for control-flow findings; unknown for current hosted-provider behavior |

This area is the proof layer for the whole product: a real-browser E2E gate that drives the actual Rust agent and Next.js app, a hosted scheduled/PR monitor that publishes redaction-audited evidence to durable storage, and a live-provider smoke with cost, cadence, and quarantine controls. The discipline is well above typical test tooling — evidence is contract-derived, fail-closed, and audited for secrets before publication. Adversarial verification confirmed all four important findings from the first pass and refuted none: two of them (the consecutive-failure plumbing gap and the timeout budgeting collision) quietly undermine the monitor's own documented alerting and rollback contract, one leaks grandchild processes on every local run, and one over-distributes production secrets into the monitor container. All have small, testable fixes.

## Strengths

- CI runs the real stack, not mocks: `.github/workflows/validate.yml:51-55` executes `scripts/e2e-browser.mjs` against the actual cargo agent-service and Next.js app, and protocol proof is read from real WebSocket frames (`scripts/e2e-browser.mjs:194-197`) rather than UI-only assertions; the second-tab session_cap and failure-control terminal checks assert server-emitted terminal reasons, not styling.
- Evidence-integrity discipline is consistent: every artifact directory is audited for forbidden markers before publication (`scripts/e2e-browser.mjs:1451-1476` writeAuditedBrowserStoryResult; `scripts/hosted-monitor-runner.mjs:1037-1048` auditHostedArtifacts), learner content is redacted in screenshots before capture, and tests assert secrets never serialize into evidence (`scripts/live-provider-smoke.test.mjs:490-497`).
- Live-monitor budget controls are thorough and unit-tested: cadence gating, daily run/token budgets, remaining-budget preflight, remote cost-cap cross-check against `/ready`, and failure-count self-quarantine with staleness expiry (`scripts/hosted-monitor-runner.mjs:315-451, 470-477`; `scripts/hosted-monitor-runner.test.mjs:236-359, 571-660`).
- `scripts/browser-evidence.mjs` release assertions are strict, fail-closed, and extensively negative-tested (`scripts/browser-evidence.test.mjs:125-466`), including path-safety checks that screenshot names cannot escape the artifact directory.
- The failure taxonomy is contract-driven rather than duplicated: the failure matrix, hosted matrix, and observability queries all derive from `packages/core/src/learner-loop-contract.json`, and validation rejects alerts whose query text cannot observe the claimed failure class (`scripts/live-provider-failure-matrix.test.mjs:48-66`; `scripts/provider-failure-observability.mjs:717-753`).
- Session-token URL hygiene is verified end-to-end in a real browser across load, expired, replayed, malformed, history, back/forward, BFCache-restore, and refresh scenarios (`scripts/e2e-browser.mjs:1075-1166`), a rare and valuable class of e2e coverage.

## Findings

### Important

1. **Consecutive live-monitor failure count never reaches the smoke evidence, so the >=2 threshold and rollback trigger cannot fire from hosted artifacts**

   `scripts/hosted-monitor-runner.mjs:558`

   **What**: The hosted runner passes prior failure state to the live-smoke child as `VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES` (`scripts/hosted-monitor-runner.mjs:558`), but `scripts/live-provider-smoke.mjs` reads `VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES` (lines 110-112, 1070) — a grep confirms nothing else in the repo bridges the two names. The other recovery path — reading the previous `evidence.json` (`scripts/live-provider-smoke.mjs:1076-1085`) — also never fires in hosted mode because the runner gives every run a fresh run-id-scoped artifact path (`scripts/hosted-monitor-runner.mjs:917-918`). So `evidence.json`'s `monitor.live_monitor_consecutive_failures` is structurally capped at 1.

   **Why it matters**: The BAC-525 `live_monitor_failure` alert queries the smoke artifact for `monitor.live_monitor_consecutive_failures:">=2"` (`scripts/provider-failure-observability.mjs:313`) and the shared BAC-527 rollback trigger `live_monitor_consecutive_failures` (threshold value 2, `scripts/rollback-drain-criteria.mjs:253-268`) maps to that same query (`scripts/provider-failure-observability.mjs:361-369`). Against hosted artifacts as actually produced, that condition can never be true. The alert's OR-clause on `failure_class:"live_monitor_failure"` still fires per single failure, but the consecutive-failure escalation semantics — the documented rollback trigger — are silently disabled. The runner's manifest does carry the correct count (`live_smoke.self_quarantine`, `scripts/hosted-monitor-runner.mjs:781-819`) but the query as written does not target the manifest schema.

   **Fix**: In `scheduledLiveMonitorRun`, also set `VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES` from the hosted state (or rename the smoke's env read); alternatively repoint the `live_monitor_failure` railway_query at the manifest's `runs[].live_smoke.self_quarantine.consecutive_failures` field. Add a test that builds the hosted plan and asserts the smoke config actually picks up the prior count.

2. **Per-stage smoke timeouts each get the full max_duration_ms while the runner kills the whole process at that same value, making graceful failure evidence unreachable in hosted operation**

   `scripts/live-provider-smoke.mjs:614-627`

   **What**: `collectWebSocketProof` awaits open, ready, question, and recap sequentially, each with `withTimeout(config.caps.max_duration_ms)` — up to 4x the cap in wall time, on top of readiness and bootstrap HTTP calls. The hosted runner caps the entire child at `Math.min(runTimeoutMs, max_duration_ms_per_run)` = 90s (`scripts/hosted-monitor-runner.mjs:550`; policy value at `scripts/hosted-e2e-matrix.mjs:173`), and `evidence.json` is only written after `runLiveProviderSmoke` completes (`scripts/live-provider-smoke.mjs:1229-1243`), with no SIGTERM handler anywhere in the file.

   **Why it matters**: Any slow-provider hang (the exact scenario the monitor exists for) hits the runner's SIGTERM/SIGKILL before any of the smoke's own stage timers can fire — each timer starts after process startup plus prior stages, so it always expires later than 90s of process life. No `evidence.json` is written, the run is classified `missing_evidence`/`timeout` (`scripts/hosted-monitor-runner.mjs:643-649, 868-877`), `summary.live_smoke` is null, and the in-band terminal reasons `recap_timeout`/`question_event_timeout` are effectively unreachable in hosted operation. Consequently `stuck_checking_sessions` (`scripts/live-provider-smoke.mjs:819, 832`) can never be 1 in hosted artifacts, so the `stuck_checking` observability query (`scripts/provider-failure-observability.mjs:291-306`) loses its primary data source. Timeouts also never count toward self-quarantine, since `summarizeLiveSmokeResult` returns null without a result.

   **Fix**: Compute one deadline (start + max_duration_ms) and pass the remaining budget to each `withTimeout`; set the runner's live-run timeout to `max_duration_ms_per_run` plus a grace margin (e.g. +30s) so the smoke's graceful classification wins; optionally install a SIGTERM handler in `main()` that flushes a partial `evidence.json` with terminal_reason `killed_by_runner`.

3. **Child teardown signals only the direct wrapper process, orphaning the cargo-run agent binary and the Next dev server**

   `scripts/e2e-browser.mjs:1506-1541`

   **What**: `spawnLogged.stop()` does `child.kill("SIGTERM")` on the direct child, without `detached: true` or process-group signaling, and without awaiting exit. For the agent that child is `cargo run` (`scripts/e2e-browser.mjs:129-142`) and for web it is `bun run --cwd apps/web dev` wrapping `next dev` (`scripts/e2e-browser.mjs:153-177`; `apps/web/package.json` dev script). cargo does not forward SIGTERM to the compiled agent-service binary, so the grandchild survives, re-parented and still bound to its port. `stop()` also ends the log write streams immediately (lines 1535-1537) while the dying child may still be piping output, risking an unhandled write-after-end stream error, and the script installs no SIGINT/SIGTERM cleanup handlers. `scripts/dev-agent.mjs:29-47` has the related shape: a targeted kill of the node wrapper orphans cargo and the agent (though interactive Ctrl+C is covered by terminal process-group signaling).

   **Why it matters**: Every completed local e2e run leaks an agent-service binary (and potentially a next-dev server). Since `freePort()` (`scripts/e2e-browser.mjs:1842-1855`) hands out fresh ports each run, the leak is silent — memory, file handles, and stray listeners pile up on dev machines, and a leaked agent can answer later WebSocket probes and confuse debugging. In CI the runner teardown masks it, so this only bites humans.

   **Fix**: Spawn with `detached: true` and kill the process group (`process.kill(-child.pid, "SIGTERM")`), await the exit promise with a bounded SIGKILL escalation, and end the log streams only after exit. Add `process.on("SIGINT"/"SIGTERM")` handlers that run the same teardown. Apply the same to `scripts/dev-agent.mjs`.

4. **Monitor environment must carry raw provider API keys it never uses, plus the production session-signing secret in modes that never mint tokens**

   `scripts/live-provider-smoke.mjs:62-72`

   **What**: `buildLiveSmokeConfig` requires `CARTESIA_API_KEY` and `GEMINI_API_KEY` to be present (lines 62-64) purely as an attestation — the smoke talks only to the agent over HTTP/WS and never reads the key values (line 62 is the sole reference in the file). Separately, `scripts/hosted-monitor-runner.mjs:100` makes `VIVA_VOICE_SESSION_TOKEN_SECRET` mandatory for every hosted-monitor mode, including scheduled synthetic runs where the child never uses it (`buildE2EFailureControlEnv` returns `{}` when failure control is disabled, `scripts/e2e-browser.mjs:1037-1043`); the live leg then self-signs production session tokens with it (`scripts/hosted-monitor-runner.mjs:513-526`).

   **Why it matters**: The monitor container (`Dockerfile.monitor`: Playwright base image + full bun dependency tree + curl-piped bun installer) becomes a holder of live provider credentials and the production HMAC signing secret — the broadest-attack-surface component in the system holding the narrowest-need secrets. Possession of `VIVA_VOICE_SESSION_TOKEN_SECRET` lets a compromised monitor forge arbitrary learner session tokens. The runbook (`docs/deployment-runbook.md:528-560`) mandates supplying the API keys "from provider secret store", so this is deliberate — but the key values are provably unused, and the session secret is unused in the default scheduled mode.

   **Fix**: Replace the API-key presence check with an explicit attestation flag (e.g. `VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED=1` set by the deployment that owns the keys), and require `VIVA_VOICE_SESSION_TOKEN_SECRET` only when a mode actually consumes it (live monitor enabled or failure-control scenarios selected). Longer term, consider a server-minted single-use monitor session capability instead of shipping the raw signing secret.

### Minor

1. **Remote cost-cap readiness failure omits failure_class and monitor fields present on every other failure path**

   `scripts/live-provider-smoke.mjs:180-191`

   **What**: The `remoteCostCapPasses` failure branch builds evidence with `failure` and `terminal_reason` but, unlike the readiness/audio/bootstrap/websocket failure branches (e.g. lines 150-159, 202-213), omits top-level `failure_class` and the `monitor` object entirely.

   **Why it matters**: Downstream consumers that read `result.failure_class` directly or the `monitor.*` fields (the `live_monitor_failure` query matches `monitor.terminal_reason`, `scripts/provider-failure-observability.mjs:313`) see an inconsistent shape for this one failure mode, and the consecutive-failure counter is not advanced for cost-cap rejections even though they are provider-target misconfigurations worth accumulating.

   **Fix**: Mirror the other branches: add `failure_class: failure.failure_class` and `monitor: failedMonitorEvidence(monitorConfig, "cost_budget")`.

2. **S3 publication has zero retries, so one transient upload error fails the whole monitor cycle**

   `scripts/hosted-monitor-runner.mjs:961-1027`

   **What**: `putS3Object` performs a single PUT per file with an abort deadline; any transient 5xx/network error throws and aborts `publishHostedEvidence` mid-stream (some objects uploaded, manifest not), and `main()` exits non-zero without printing the summary.

   **Why it matters**: For a scheduled monitor, a storage blip becomes a failed monitoring cycle indistinguishable from a product failure — alert noise and reduced trust in the monitor. Partial prefixes with no `manifest.json` also complicate the BAC-526 consumer that reads the object prefix.

   **Fix**: Add a small bounded retry (2-3 attempts with jittered backoff) inside `putS3Object`, staying within the existing publish deadline via `remainingPublishMs`, and treat a publish failure distinctly (e.g. failure_class `publish_failed`) from run failures.

3. **The mandatory pending_local_preview release frame is harness-authored HTML, not product UI**

   `scripts/e2e-browser.mjs:736-749`

   **What**: `capturePendingLocalPreview` screenshots a static HTML page baked into the script (`pendingPreviewHtml`) via `page.setContent`, and `scripts/browser-evidence.mjs` makes that frame id mandatory release evidence (`REQUIRED_BROWSER_STORY_FRAME_IDS`, `scripts/browser-evidence.mjs:4-11`).

   **Why it matters**: A release-gate-required frame that exercises zero product code dilutes the evidentiary value of the browser story: it will pass forever regardless of what the app does. The frame's note discloses this honestly, but the release assertion treats it identically to real product frames.

   **Fix**: Either render the app's real pending/extraction state (even behind a test-only route) or exempt `kind: "structured_preview"` frames from the required-frame release assertion and track them separately so evidence consumers can distinguish staged frames from product proof.

4. **The limiter release evidence's proved_by test name is an unchecked string that can silently drift from the Rust suite**

   `scripts/provider-limiter-evidence.mjs:31-34`

   **What**: `providerLimiterReleaseEvidence` hardcodes `proved_by.agent_service_test = "websocket_provider_backoff_denies_next_answer_before_brain_input"` and the assert only compares the string to itself; nothing reads the Rust source. The test does exist today (`agent/crates/agent-service/tests/voice_ws.rs:3169`), but a rename or deletion leaves the release evidence claiming proof that no longer runs.

   **Why it matters**: This is release-gate evidence whose entire value is the link to a real enforcing test; the repo already has the right pattern for cross-file pinning (`scripts/e2e-browser-static.test.mjs:71-86` pins the protocol version against packages/core source).

   **Fix**: In `scripts/provider-limiter-evidence.test.mjs`, read `agent/crates/agent-service/tests/voice_ws.rs` and assert the named async test fn exists, mirroring the protocol-version pinning approach.

5. **Live-monitor session token is minted at plan time with a 15-minute expiry but consumed after the synthetic browser run**

   `scripts/hosted-monitor-runner.mjs:513-526`

   **What**: `signedLiveMonitorSession` sets `expires_at = now + 15min` when `buildHostedMonitorPlan` runs, but the live-smoke run executes after the scheduled synthetic browser run (runs order, `scripts/hosted-monitor-runner.mjs:142-164`), which may take up to `runTimeoutMs` — 10 minutes by default and configurable arbitrarily high via `VIVA_HOSTED_RUN_TIMEOUT_MS` (lines 38-42).

   **Why it matters**: With a custom run timeout above ~13 minutes, a slow synthetic leg makes the pre-signed token expire before the live leg starts; the resulting failure is then misclassified as a provider/session-auth problem rather than a scheduling artifact, polluting the failure-class telemetry the monitor exists to keep clean. Defaults leave only a few minutes of margin.

   **Fix**: Mint the signed session lazily when the live run starts (move signing into the run execution path), or derive the expiry from `runTimeoutMs` plus margin, and reject plans where the expiry cannot cover the preceding runs' worst case.

6. **Transport-level socket errors are counted as structured_error server frames**

   `scripts/live-provider-smoke.mjs:606-612`

   **What**: The socket "error" handler increments `eventCounts.structured_error`, the same counter used for server frames of type "error" (`summarizeServerFrame`, lines 308-313) and unparseable frames (lines 538-541).

   **Why it matters**: The evidence's `event_counts` conflates "server sent a structured error frame" with "the TCP/WS transport failed", so operators reading `event_counts.structured_error > 0` cannot tell a protocol-level server rejection from a network blip, and websocketStatus fails for both under the same label while `terminal_reason` says `socket_error`.

   **Fix**: Track transport errors in a separate counter (e.g. `transport_error`) and leave `structured_error` for genuine server error frames.

7. **freePort() close-then-spawn race can flake local runs**

   `scripts/e2e-browser.mjs:1842-1855`

   **What**: `freePort` binds port 0, closes the listener, and returns the port; cargo/Next then re-bind it later (lines 45-48, 134, 167). Between close and re-bind another process can claim the port; the two sequential allocations can also, in principle, collide with each other on a busy host.

   **Why it matters**: Classic TOCTOU port race — a low-probability but confusing local/CI flake in which the agent or web server fails to bind and the run aborts with an unrelated-looking readiness timeout (`waitForHttpJson`'s early-exit does surface the child exit, which helps).

   **Fix**: Retry the spawn+readiness sequence once on early bind failure, or keep the allocation listener open until just before spawn; document the residual race. Low priority given the early-exit diagnostics.

8. **Source-regex assertions are brittle guardrails that verify text, not behavior**

   `scripts/e2e-browser-static.test.mjs:8-109`

   **What**: Most tests assert that `scripts/e2e-browser.mjs` contains or lacks specific source substrings (variable names, call shapes, ternaries). Only the protocol-version test (lines 71-86) checks a real cross-file invariant.

   **Why it matters**: These tests break on harmless refactors (rename a local, reformat a call) while passing when behavior regresses in ways that keep the strings intact — e.g. `hostedWebSocketVerified` could be set true unconditionally elsewhere and every assertion here still passes. They encode review outcomes, which has value, but at the cost of false confidence and refactor friction.

   **Fix**: Where feasible, export the small pure helpers (`normalizeComparableWsUrl`, `hostedSyntheticIdentity`, `assertHostedSyntheticIdentity`, `postAnswerProtocolProofFromEvents`) and unit-test them directly; keep regex checks only for genuinely structural bans (e.g. the bearer-in-browser-JS prohibition).

## Verification notes

No findings were refuted or downgraded; all four important findings were confirmed directly against the cited code. Two refinements from verification:

- F1 (consecutive failures): the `live_monitor_failure` alert query is an OR — its `failure_class:"live_monitor_failure"` clause still matches any single failed run, so the alert as a whole is not dead. What is unreachable from hosted artifacts is specifically the `>=2` consecutive-failures clause and the BAC-527 rollback trigger, whose threshold value 2 (`scripts/rollback-drain-criteria.mjs:255-265`) can never be met by `evidence.json`'s counter, which caps at 1. The finding's wording was tightened accordingly; severity unchanged.
- F3 (process teardown): for `scripts/dev-agent.mjs`, interactive Ctrl+C is safe because terminal SIGINT goes to the whole foreground process group; the orphaning occurs on a targeted kill of the wrapper. The e2e-browser leak, however, occurs on every completed local run because `stop()` SIGTERMs `cargo run`, which does not forward the signal to the compiled binary. Severity unchanged.
- Cross-checks performed: grep confirmed no code bridges `VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES` to `VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES` (only the smoke and its test reference the latter); `HOSTED_MONITOR_POLICY.live_monitor.max_duration_ms_per_run` is 90_000 (`scripts/hosted-e2e-matrix.mjs:173`); `scripts/live-provider-smoke.mjs` contains no signal handlers; the Rust test named in F8-minor-4 exists today at `agent/crates/agent-service/tests/voice_ws.rs:3169`; the runbook (`docs/deployment-runbook.md:528-560`) does mandate raw provider keys in the monitor env.

## Recommendations

- Fix the consecutive-failure plumbing (Important 1) and the timeout budgeting (Important 2) together — they are the two gaps that most weaken the hosted monitor's stated alerting/rollback contract, and both have small, testable fixes.
- Introduce a shared `spawnManaged()` helper (detached process group, SIGTERM-then-SIGKILL escalation, stream-end-after-exit, signal handlers) used by `scripts/e2e-browser.mjs`, `scripts/dev-agent.mjs`, and `scripts/hosted-monitor-runner.mjs` so teardown semantics are fixed once.
- Shrink the monitor container's secret set: replace unused API-key presence checks with an attestation flag and make the session-signing secret conditional on modes that consume it.
- Add bounded retries to `putS3Object` within the existing publish deadline, and give publish failures their own failure_class so storage blips are distinguishable from product failures.
- Mark the hosted evidence screenshots array as local-only in the manifest (or rename to `local_screenshots`) — the durable store deliberately publishes text/JSON/logs only (`publishableHostedFiles` filters to json/log/txt), so the current field implies artifacts a consumer of the S3 prefix can never fetch, and `contentTypeFor`'s PNG branch (`scripts/hosted-monitor-runner.mjs:1211`) is dead code in the publish path.
- Add a static cross-check that provider-limiter-evidence's named Rust test still exists, mirroring the protocol-version pinning pattern already in `scripts/e2e-browser-static.test.mjs`.
- Consider writing partial live-smoke evidence on SIGTERM so hard-killed runs still contribute sanitized failure classification to the durable record.

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first-pass reviewer; verification confirmed all important findings and refuted none).

This is an unusually disciplined test/monitoring layer: CI drives the real Rust agent and Next app through a real browser, evidence is contract-derived and aggressively redaction-audited, and the live monitor has genuine cost, cadence, and quarantine controls with strong unit coverage. No critical data-loss or security-hole findings survived verification. However, four confirmed important defects undermine the layer's own guarantees — the consecutive-failure counter can never reach the rollback threshold from hosted artifacts, the timeout budgeting makes timeout-class failure classification unreachable in hosted operation, local teardown leaks grandchild processes on every run, and the monitor container holds production secrets it provably does not need in its default mode. All are fixable with small, well-scoped changes the existing test suites can lock in.
