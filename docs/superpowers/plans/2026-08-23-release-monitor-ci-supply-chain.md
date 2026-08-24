# Viva Release, Monitor, CI, and Supply-Chain Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:test-driven-development` for every behavior change, `superpowers:systematic-debugging` for any unexpected RED/GREEN result, and `superpowers:verification-before-completion` before each commit and final handoff. Execute this plan task-by-task; do not credit source-grep, local-only, fixture-only, or lower-layer output as hosted/release proof.

**Goal:** Make Viva's release evidence, hosted-monitor runner, browser/process harnesses, CI topology, dependency audits, and runtime-image supply chain fail closed, exact-run/deploy bound, reproducible, and behavior-tested without changing capability source.

**Architecture:** Keep product capability code owned by the voice, service, data, web, and frontend lanes. This lane owns orchestration and proof: monitor policy/state enters one normalized run plan; live smoke uses one monotonic deadline and writes sanitized terminal evidence even when interrupted; all local children use one process-group supervisor; release imports bind sanitized artifacts to an exact run and deploy; production bundles are HMAC-verified by a separate downstream command; the recorded D-06 build disposition is reflected atomically in root/app manifests, lockfile, and required workflow; CI exposes one stable required-job result over strict Node 24, loopback, browser, audit, and Postgres jobs; images and actions are immutable and non-root.

**Tech Stack:** Node.js 24 `node:test`, Bun 1.3.3, Playwright 1.61.0, POSIX process groups, Rust 1.94.1/Cargo, cargo-audit 0.22.0, GitHub Actions, Docker/OCI, Postgres 16, S3 SigV4.

**Spec:** `docs/superpowers/plans/2026-08-23-review-remediation-swarm-program.md`, `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`, `docs/superpowers/reviews/2026-08-23-scripts-e2e-monitoring.md`, `docs/superpowers/reviews/2026-08-23-scripts-release-gates.md`, `docs/superpowers/reviews/2026-08-23-security.md`, `docs/superpowers/reviews/2026-08-23-security-review.md`, `docs/superpowers/reviews/2026-08-23-quality-and-tests-review.md`, `docs/superpowers/reviews/2026-08-23-project-state.md`, `docs/superpowers/reviews/2026-08-23-reliability-and-performance-review.md`, `docs/superpowers/reviews/2026-08-23-architecture-consistency.md`, `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`, and `docs/superpowers/reviews/index.md`.

**Reviewed baseline:** `main` at `4d5d8276f03635ca74c04f4d500d13ce62198dd0`. At plan authoring time `bun audit` fails with 16 advisories (9 high, 7 moderate), and `cargo audit --file agent/Cargo.lock --no-fetch --deny warnings` fails on `quinn-proto 0.11.14`, `rsa 0.9.10`, `anyhow 1.0.102`, `event-listener 5.4.1`, and yanked `spin 0.9.8`. The latest recorded hosted Validate run for this SHA is red under Node 24; this plan does not claim that state has been repaired until Plan 15 verifies the exact merged SHA externally.

## Global Constraints

- This lane may modify `.gitignore`, `.github/workflows/validate.yml`, `.github/dependabot.yml`, root `package.json`, the exact audit/test/static-integration dependencies and scripts in `apps/web/package.json`, `bun.lock`, `agent/Cargo.lock`, `agent/Dockerfile`, `Dockerfile.monitor`, release/monitor/E2E scripts, their tests/policy files, and release/deployment documentation. It does not own dependency manifests generically: Plan 13 owns `packages/ui-web/package.json`; Plan 14 owns `packages/core/package.json` and `agent/Cargo.toml` workspace metadata; Plans 06/07/08 own their crate `Cargo.toml` files. This lane coordinates those owner handoffs, regenerates and audits the lockfiles only after their commits land, and never stages their manifests.
- Do not modify `apps/web` capability source, `packages/core` capability contracts, or Rust capability source under `agent/crates/**/src` or `agent/crates/**/tests`. Tests in this plan may execute those surfaces and bind evidence to existing test names, but capability behavior changes belong to their owning lanes.
- `DOMAIN-001` owns the real domain-purity semantic redesign and `scripts/check-agent-domain-purity.sh`. `RELEASE-001` owns the generic missing-tool/exit-code contract and `scripts/check-generated-artifact-hygiene.sh`; the domain lane must apply the shared contract to its gate without this worker editing the same file.
- Baseline-safe script isolation, tests, audit policy, action/image pinning, and process supervision may begin immediately. Do not merge this lane until required capability lanes have merged, the branch is rebased onto the frozen combined tree, and the capability-dependent E2E/required-job assertions pass there.
- Do not enable live providers, call paid providers, change deployed services, alter branch protection, or claim hosted evidence in this plan. Those external acceptance actions belong to Plan 15.
- Do not use `VIVA_RELEASE_CHECK_SKIP_BROWSER=1`, `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1`, an unbound “latest” manifest, an unsigned production bundle, a harness-authored preview, or a zero-test Cargo filter as release proof.
- Every new evidence field is sanitized and schema-tested. Raw keys, bearer/session tokens, audio, transcripts, answers, prompts, notes, source excerpts, and raw provider responses remain forbidden.

## Dependency and merge order

1. The release/monitor tasks other than capability-bound browser proof and the D-06/D-09 branches are baseline-safe if their tests stay inside this lane.
2. `RELEASE-019` is blocked on recorded decision `D-09 STRUCTURED_PREVIEW_EVIDENCE`; the worker must not select a branch.
3. `RELEASE-015`/`RELEASE-023` may build the supervisor and behavior-test infrastructure early, but final browser assertions wait for the voice/frontend capability lanes.
4. `RELEASE-028` may land its sanitized adapter/tests early, but GREEN waits for Plan 04/05's strict validators and Plan 14's `@viva/core/runtime-validation` export; this lane never edits those owner files.
5. `RELEASE-030` may freeze the reviewed concentration budget early, but its E2E extraction follows the voice/frontend story changes and any over-budget capability path returns to its named Plan 07/08/09/13 owner.
6. `RELEASE-027` may establish branch-neutral CI structure early, but its durable job depends on `DATA-001`, its strict loopback/browser jobs depend on the voice/service lanes, and its final required job must be validated on the combined tree.
7. `RELEASE-031` is hard-blocked on the recorded `D-06 STATIC_EXPORT` branch and the matching Plan 10/11/13B/14B owner commits. It consumes Plan 14's build contract and changes only Plan-12-owned manifest/lock/workflow/test surfaces; it never edits `apps/web/next.config.ts`, `turbo.json`, or Plan 14's cache/build proof implementation.
8. `RELEASE-024`'s Rust lock regeneration (Task 14 Step 5) and the D-04-conditional dependency-policy and workflow-policy assertions (Task 14 Step 2, Task 17 Step 1) are blocked on the coordinator-recorded `D-04` branch and the matching Plan 06 `agent/crates/agent-domain/Cargo.toml` commit; the worker must not infer a D-04 branch.
9. The only early `12A` release commits are the additive manifest/lock commits in `RELEASE-024`: (a) the exact `happy-dom`/`@happy-dom/global-registrator` app-manifest handoff, landing before Plan 10's mounted tests; (b) the additive root-manifest commit adding exact root dev dependencies `"yaml": "2.8.2"` (Plan 06's workflow/domain policy-test prerequisite) and `"@viva/core": "workspace:*"` plus root script `"build:cache:prove"` (Plan 14's handoff — its Task 3 Step 5, Task 4 Step 5, and Task 7 Step 1 gate on this commit being merged to integration before Plan 14's GREEN verification); and (c) the lockfile-regeneration commit for Plan 13's Task 1/Task 2 package-manifest handoff (`packages/tokens/package.json` export addition and `packages/ui-web/package.json` dependency/peer changes), which must exist before `13A` merges so frozen-lockfile installs stay green; the coordinator admits (c) to integration only as the merge immediately preceding `13A`, with no other lane merge in between, so no integration tip carries a lock that names `packages/ui-web` dependencies whose manifests have not merged. Each regenerates `bun.lock` with Bun 1.3.3 and changes no product source or workflow. All remaining work is `12B`: merge capability lanes and Plan 14B first, then the final release lane. Plan 15 performs exact-head hosted validation, required-check/branch-rule verification, deploy/run evidence collection, static-disposition reconciliation, and downstream production-bundle verification.

---

### Task 1: `RELEASE-013` / `RELEASE-017` — Make live-monitor state and budget semantics truthful

**Files:**
- Modify: `scripts/hosted-monitor-runner.mjs`
- Modify: `scripts/hosted-monitor-runner.test.mjs`
- Create: `scripts/hosted-monitor-state.mjs`
- Create: `scripts/hosted-monitor-state.test.mjs`
- Modify: `scripts/hosted-e2e-matrix.mjs`
- Modify: `scripts/hosted-e2e-matrix.test.mjs`
- Modify: `scripts/live-provider-smoke.mjs`
- Modify: `scripts/live-provider-smoke.test.mjs`
- Modify: `docs/deployment-runbook.md`
- Modify: `scripts/deployment-runbook.test.mjs`

- [ ] **Step 1: Write failing state-propagation and cost-shape tests**

Add behavioral tests proving:

1. two scheduled runs with different run IDs/output directories but one injected durable state store pass `VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES=0` then `1` to the smoke (the exact variable it reads), persist evidence counts `1` then `2`, and activate the BAC-527 consecutive-failure decision;
2. failure state older than the observation window resets to zero; a first-ever 404 initializes schema-valid zero state exactly once with `If-None-Match: *`, while malformed state, authentication/read failure, or conflicting initialization fails the live leg as `state_unavailable` instead of silently assuming zero;
3. one run-independent object at `viva-hosted-monitor/state/live-monitor-state.v1.json` owns UTC date, runs/tokens/cost today, consecutive failures, last failure time, quarantine, active reservation, last applied run ID, and schema version; no learner/provider payload or secret is allowed;
4. an idempotent compare-and-swap reservation charges maximum per-run token/cost caps before mint/provider work, two concurrent stale-ETag reservations cannot both pass the daily cap, and retrying the same run ID does not double-charge or double-increment;
5. the durable `cost_usd_today` is a non-negative finite number and blocks a run when `cost_today + max_cost_usd_per_run > max_cost_usd_per_day`;
6. the remote cost-cap failure returns the same complete top-level shape as every other failure: `failure`, `failure_class`, `monitor`, `terminal_reason`, and `failure_stage`;
7. the monitor summary, durable state, and observability counter agree on the same consecutive-failure value.

Use this target shape in the test:

```js
assert.equal(firstRun.env.VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES, "0");
assert.equal(secondRun.env.VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES, "1");
assert.equal(secondRun.env.VIVA_HOSTED_LIVE_MONITOR_CONSECUTIVE_FAILURES, undefined);
assert.equal(secondPlan.liveMonitor.cost_usd_today, 0.2);
assert.equal(secondPlan.liveMonitor.max_cost_usd_per_day, 0.5);
assert.equal(secondEvidence.failure_class, secondEvidence.failure.failure_class);
assert.equal(secondEvidence.monitor.live_monitor_consecutive_failures, 2);
assert.equal(state.last_applied_run_id, secondPlan.runId);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test scripts/hosted-monitor-state.test.mjs scripts/hosted-e2e-matrix.test.mjs scripts/hosted-monitor-runner.test.mjs scripts/live-provider-smoke.test.mjs scripts/deployment-runbook.test.mjs
```

Expected: FAIL because the hosted runner uses the wrong consecutive-failure variable, fresh run directories cannot accumulate state, daily USD state is caller-supplied rather than durably reserved, and the cost-cap branch omits failure/monitor fields.

- [ ] **Step 3: Implement one normalized state contract**

Implement `hosted-monitor-state.mjs` as a schema-validating store over the existing S3 credentials. Read the stable key with its ETag, reserve the maximum cost/tokens/run count with conditional `If-Match` (or `If-None-Match: *` on first creation), and retry only an observed precondition conflict after re-reading. A read/auth/schema failure prevents the live child. Apply final outcome under CAS with `last_applied_run_id` idempotency; a crash after reservation remains conservatively charged until UTC rollover, never refunded from unverifiable partial evidence.

At runner startup the state store must probe conditional-write support against the configured endpoint using a dedicated probe key, never the live state object: a PUT with a deliberately stale `If-Match` must be rejected with a precondition failure. A store that accepts the stale precondition or errors on the header is `state_unavailable` and fails the live leg closed. Record in the runbook that hosted CAS behavior (object version/ETag transition across two runs) is verified only by Plan 15 handoff item 4; local injected-fetch tests do not prove store precondition support.

Translate the authoritative reserved state once into the smoke's public contract:

```js
env: {
  VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES: String(
    liveMonitorDecision.consecutive_failures ?? 0,
  ),
  VIVA_LIVE_SMOKE_RUN_ID: runId,
  // no VIVA_HOSTED_* state leaks into the child contract
}
```

Extend `HOSTED_MONITOR_POLICY.live_monitor` enforcement to `max_cost_usd_per_day`, record `cost_usd_today`, reserved cost, remaining cost, state schema, and an ETag hash (never the raw storage credential) in the sanitized decision, and use one helper for every failure result:

```js
function failedEvidence(base, monitorConfig, terminalReason, stage, extra = {}) {
  const failure = liveProviderFailureForSmokeReason(terminalReason);
  return {
    ...base,
    ...extra,
    status: "failed",
    failure_stage: stage,
    failure,
    failure_class: failure.failure_class,
    monitor: failedMonitorEvidence(monitorConfig, terminalReason),
    terminal_reason: terminalReason,
  };
}
```

Remove operator-maintained daily/failure counters as the scheduled-run authority from the runbook. Document the stable state object, UTC rollover, reservation/finalization ordering, stale-observation reset, idempotent run ID, CAS conflict behavior, and recovery procedure. Task 5 must upload audited run objects, finalize/CAS the state, and upload the run manifest last as the commit marker; a state finalization failure is `publish_failed` and cannot yield a committed manifest.

- [ ] **Step 4: Verify GREEN and negative controls**

Run the Step 2 command, then mutate the test input to cost `0.251` with `cost_today=0.25`; confirm scheduling fails closed. Restore the correct fixture and rerun.

- [ ] **Step 5: Commit**

```bash
git add scripts/hosted-monitor-state.mjs scripts/hosted-monitor-state.test.mjs scripts/hosted-e2e-matrix.mjs scripts/hosted-e2e-matrix.test.mjs scripts/hosted-monitor-runner.mjs scripts/hosted-monitor-runner.test.mjs scripts/live-provider-smoke.mjs scripts/live-provider-smoke.test.mjs docs/deployment-runbook.md scripts/deployment-runbook.test.mjs
git commit -m "fix(release): make live monitor state and budgets truthful"
```

---

### Task 2: `RELEASE-014` / `RELEASE-022` — Enforce one smoke deadline and classify partial evidence

**Files:**
- Modify: `scripts/live-provider-smoke.mjs`
- Modify: `scripts/live-provider-smoke.test.mjs`
- Modify: `scripts/hosted-monitor-runner.mjs`
- Modify: `scripts/hosted-monitor-runner.test.mjs`

- [ ] **Step 1: Write failing deadline, interruption, and transport tests**

Use injected clocks/timers and a child-process integration test to prove:

- readiness, bootstrap, socket open, ready, question, and recap share one `started_at + max_duration_ms` deadline;
- each stage receives only the remaining milliseconds, never the full 90 seconds again;
- the hosted runner grants a fixed 30-second evidence-flush grace (`90_000 + 30_000`) before its hard kill;
- SIGTERM during readiness, question wait, and recap wait writes a complete audited `evidence.json` with `status: "failed"`, `partial: true`, `terminal_reason: "killed_by_runner"`, `failure_class: "timeout"`, and no sensitive payload;
- SIGKILL remains the bounded fallback only after the grace expires;
- socket/open/close transport failures increment `event_counts.transport_error` and classify as `transport`; malformed JSON/schema frames increment a distinct `event_counts.protocol_error` and classify as `protocol`; only valid server error frames increment `structured_error` and retain the server's allowed failure class. The three outcomes must remain distinct in smoke evidence, hosted summary, observability counters, and production-gate diagnostics.

The core deadline API must be directly testable:

```js
const deadline = createDeadline({ nowMs: 1_000, durationMs: 90_000 });
assert.equal(deadline.remainingMs(31_000), 60_000);
assert.throws(() => deadline.remainingMs(91_001), /live smoke deadline exceeded/);
```

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/live-provider-smoke.test.mjs scripts/hosted-monitor-runner.test.mjs
```

Expected: FAIL because four sequential socket waits each receive the full cap, the runner kills at that same cap, no signal handler writes evidence, and transport failures share the structured-error counter.

- [ ] **Step 3: Implement deadline and idempotent evidence finalization**

Create the deadline before the first readiness request and pass `deadline.remainingMs()` to every timeout/abort wrapper. Make evidence finalization single-shot so normal completion and SIGTERM cannot race:

```js
let finalized = false;
async function finalizeEvidence(evidence) {
  if (finalized) return;
  finalized = true;
  auditLiveSmokeEvidence(evidence, process.env);
  await writeEvidence(outputPath, evidence);
}

process.once("SIGTERM", () => {
  void finalizeEvidence(interruptedEvidence(currentStage, "SIGTERM"))
    .finally(() => { process.exitCode = 1; });
});
```

Do not call `process.exit()` before the write resolves. The partial artifact may contain counters, stage, run/deploy binding, signal name, and timestamps only. It must not contain the current frame, audio bytes, transcript, answer, prompt, or session token.

Set the live child soft timeout to `max_duration_ms_per_run + 30_000`; keep the smoke's own cap at exactly `max_duration_ms_per_run`.

- [ ] **Step 4: Verify GREEN and kill-path evidence**

```bash
node --test scripts/live-provider-smoke.test.mjs scripts/hosted-monitor-runner.test.mjs
```

Run the integration fixture once with SIGTERM and inspect only schema-safe fields:

```bash
node -e 'const e=require("./artifacts/live-provider-smoke-test/evidence.json"); if (e.partial!==true || e.terminal_reason!=="killed_by_runner") process.exit(1)'
```

The test owns and removes `artifacts/live-provider-smoke-test`; do not retain that directory in the commit.

- [ ] **Step 5: Commit**

```bash
git add scripts/live-provider-smoke.mjs scripts/live-provider-smoke.test.mjs scripts/hosted-monitor-runner.mjs scripts/hosted-monitor-runner.test.mjs
git commit -m "fix(monitor): preserve classified evidence at the smoke deadline"
```

---

### Task 3: `RELEASE-029` — Isolate every spawned release, monitor, and E2E child environment

**Files:**
- Create: `scripts/child-environment.mjs`
- Create: `scripts/child-environment.test.mjs`
- Modify: `scripts/hosted-monitor-runner.mjs`
- Modify: `scripts/hosted-monitor-runner.test.mjs`
- Modify: `scripts/e2e-browser.mjs`
- Modify: `scripts/e2e-browser-static.test.mjs`
- Modify: `scripts/dev-agent.mjs`
- Modify: `scripts/dev-agent.test.mjs`
- Modify: `scripts/release-check.mjs`
- Modify: `scripts/release-check.test.mjs`

- [ ] **Step 1: Write failing hostile-parent behavior tests**

Spawn a real fixture child that prints only its environment-key names. Seed the parent with sentinel `DATABASE_URL`, provider keys, bearer/session/signing secrets, production release flags, failure-control variables, `NODE_OPTIONS=--require /tmp/viva-hostile-parent.cjs`, `BUN_OPTIONS`, and unrelated `VIVA_*` values. Exercise each role used by hosted browser, hosted live smoke, local browser agent/web, dev-agent, and release-check commands. Prove:

- operational keys are an explicit role-independent allowlist: selected `PATH`, `HOME`, `TMPDIR`/`TEMP`/`TMP`, `CI`, locale, and required platform runtime paths only;
- role keys enter only through a typed per-command map and an unknown requested key is rejected before spawn;
- ambient values matching `KEY|TOKEN|SECRET|PASSWORD|DATABASE|PROVIDER|FAILURE_CONTROL|VIVA_RELEASE`, plus `NODE_OPTIONS` and `BUN_OPTIONS`, never cross the boundary;
- a role-required value is present only when supplied explicitly in that command's normalized target/run configuration;
- removing `env` from any managed spawn is a test failure, because Node's implicit inheritance is forbidden;
- the fixture observes no sentinel value and command summaries/logs serialize no rejected parent key or value.

Add an adversarial control in which the fake child succeeds despite a leaked sentinel; the environment test must fail independently of command exit status.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/child-environment.test.mjs scripts/hosted-monitor-runner.test.mjs scripts/e2e-browser-static.test.mjs scripts/dev-agent.test.mjs scripts/release-check.test.mjs
```

Expected: FAIL because callers spread or implicitly inherit the ambient process environment and there is no common fail-closed environment constructor.

- [ ] **Step 3: Implement one explicit environment constructor**

Expose role-specific constructors over one deny-first core:

```js
const operationalKeys = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "CI", "LANG", "LC_ALL"];

export function childEnvironmentFor(role, { parentEnv, explicit }) {
  assertKnownRoleKeys(role, Object.keys(explicit));
  return Object.freeze({
    ...pickDefined(parentEnv, operationalKeys),
    ...explicit,
  });
}
```

The implementation must not accept an arbitrary extra-object escape hatch. Explicit values are constructed from already normalized plan/target inputs, not copied by name from `parentEnv`. Update every named spawn site to pass a constructed environment. Task 7's shared supervisor must later require a non-null `env` argument and preserve this contract.

- [ ] **Step 4: Verify GREEN and mutation controls**

Run Step 2. Then temporarily add `NODE_OPTIONS` to the operational allowlist and confirm the hostile-parent test fails. Restore it, delete one explicit required role key, confirm that role fails before spawn, restore, and rerun GREEN.

- [ ] **Step 5: Commit**

```bash
git add scripts/child-environment.mjs scripts/child-environment.test.mjs scripts/hosted-monitor-runner.mjs scripts/hosted-monitor-runner.test.mjs scripts/e2e-browser.mjs scripts/e2e-browser-static.test.mjs scripts/dev-agent.mjs scripts/dev-agent.test.mjs scripts/release-check.mjs scripts/release-check.test.mjs
git commit -m "security(harness): isolate every child environment"
```

---

### Task 4: `RELEASE-016` / `RELEASE-021` — Minimize monitor secrets and mint live capabilities just in time

**Files:**
- Modify: `scripts/hosted-monitor-runner.mjs`
- Modify: `scripts/hosted-monitor-runner.test.mjs`
- Modify: `scripts/hosted-monitor-state.mjs`
- Modify: `scripts/hosted-monitor-state.test.mjs`
- Modify: `scripts/live-provider-smoke.mjs`
- Modify: `scripts/live-provider-smoke.test.mjs`
- Modify: `docs/deployment-runbook.md`
- Modify: `scripts/deployment-runbook.test.mjs`

- [ ] **Step 1: Write failing secret-boundary tests**

Prove all of the following:

- scheduled synthetic mode builds without `CARTESIA_API_KEY`, `GEMINI_API_KEY`, or `VIVA_VOICE_SESSION_TOKEN_SECRET`;
- PR mode requires the failure-control secret/session-signing secret only for a selected scenario that actually consumes it;
- live smoke requires `VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED=1`, but never receives raw Cartesia/Gemini keys;
- the plan contains live identity, not a pre-minted token;
- an injected slow synthetic leg advances beyond a would-be plan-time TTL, yet the token is minted immediately before spawning `scheduled_hosted_live_smoke`, retains its full TTL covering the smoke deadline plus the 30-second flush grace, and leaves the raw signing secret absent from the child environment and serialized summary;
- the minted token carries a fresh single-use nonce plus the exact run ID, deploy SHA, agent deploy ID, provider mode, and synthetic learner/session identity, and a replay or one-field mismatch is rejected before provider work;
- a hostile parent environment containing provider keys, database URLs, production auth, and failure-control values cannot leak them into the child unless an explicit run contract allowlists that exact key.

Required negative assertions:

```js
assert.equal(plan.runs[1].env.VIVA_LIVE_SMOKE_SESSION_TOKEN, undefined);
assert.equal("CARTESIA_API_KEY" in childEnv, false);
assert.equal("GEMINI_API_KEY" in childEnv, false);
assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in childEnv, false);
assert.equal(childEnv.VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED, "1");
```

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/hosted-monitor-runner.test.mjs scripts/live-provider-smoke.test.mjs scripts/deployment-runbook.test.mjs
```

Expected: FAIL because the runner currently requires a signing secret for every mode, mints at plan construction, spreads the ambient environment into children, and the smoke requires unused raw provider keys.

- [ ] **Step 3: Implement explicit environment and delayed materialization**

Split pure planning from secret-consuming execution:

```js
function materializeLiveRun(run, env, nowSeconds) {
  const secret = requiredValue(env, "VIVA_VOICE_SESSION_TOKEN_SECRET");
  const expiresAt = nowSeconds + Math.ceil(run.timeoutMs / 1000) + 60;
  const claims = {
    ...run.identity,
    nonce: randomUUID(),
    run_id: run.runId,
    deploy_sha: run.deploySha,
    agent_deploy_id: run.agentDeployId,
    provider_mode: run.provider,
  };
  return {
    ...run,
    env: {
      ...run.env,
      VIVA_LIVE_SMOKE_SESSION_TOKEN: signSession(claims, secret, expiresAt),
    },
  };
}
```

Pass the materialized live values through `childEnvironmentFor("hosted-live", ...)` from `RELEASE-029`; do not build a second allowlist or spread `process.env`. Construct the live token claims from the normalized run identity at materialization time, not a caller-supplied opaque session object.

Replace the smoke's raw-key presence check with the explicit attestation flag. The agent deployment remains the only component that holds provider keys.

- [ ] **Step 4: Verify GREEN and redaction**

Run Step 2. Then serialize the plan, materialized run summary, and test evidence and pass them through `assertNoForbiddenEvidenceMarkers`; assert the fake parent secret values are absent.

- [ ] **Step 5: Commit**

```bash
git add scripts/hosted-monitor-runner.mjs scripts/hosted-monitor-runner.test.mjs scripts/hosted-monitor-state.mjs scripts/hosted-monitor-state.test.mjs scripts/live-provider-smoke.mjs scripts/live-provider-smoke.test.mjs docs/deployment-runbook.md scripts/deployment-runbook.test.mjs
git commit -m "security(monitor): minimize secrets and mint tokens at execution"
```

---

### Task 5: `RELEASE-018` / `RELEASE-025` — Make durable publication bounded and references truthful

**Files:**
- Modify: `scripts/hosted-monitor-runner.mjs`
- Modify: `scripts/hosted-monitor-runner.test.mjs`
- Modify: `scripts/hosted-e2e-matrix.mjs`
- Modify: `scripts/hosted-e2e-matrix.test.mjs`

- [ ] **Step 1: Write failing publication tests**

Add deterministic tests for:

- network error then success;
- HTTP 503 then success;
- HTTP 429 honoring bounded retry without exceeding the overall publication deadline;
- HTTP 403 failing immediately with one attempt;
- an aborting fetch under Node 24 staying alive until the correctness-critical timer fires;
- backoff refusing to start when `remainingPublishMs` cannot cover it;
- a publication failure producing local sanitized `publish-failure.json` with `failure_class: "publish_failed"`, attempted object key, attempt count, and no credential/header values;
- the manifest remaining the final uploaded object only after every earlier object succeeds.
- state GET/reservation/finalization retrying only the same classified retryable transport/status set, preserving conditional headers, and surfacing CAS exhaustion separately from transport/publication failure;
- hosted result manifests using `local_screenshots` for browser PNG names and never claiming those names are durable S3 objects while `publishableHostedFiles` excludes PNG;
- the dead PNG content-type branch being removed so adding a durable screenshot later requires an explicit publisher/test change rather than a misleading dormant promise.

Inject `fetchImpl`, `sleep`, `nowMs`, and deterministic jitter; do not make tests sleep in real time.

- [ ] **Step 2: Verify RED under the supported runtime**

```bash
node --version
node --test scripts/hosted-monitor-state.test.mjs scripts/hosted-monitor-runner.test.mjs
```

Expected runtime in CI: `v24.x`. Expected test result before implementation: FAIL because upload attempts are single-shot and the abort timer is unref'ed.

- [ ] **Step 3: Implement deadline-aware retries**

Retry only transport failures, 408, 429, and 5xx. Never retry other 4xx responses. Use at most three attempts and cap every fetch/backoff by the same publication deadline:

```js
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const timeoutMs = remainingPublishMs(deadlineMs, nowMs());
  const timeout = setTimeout(() => controller.abort(), timeoutMs); // deliberately referenced
  // fetch, classify, clear timer
  // sleep(min(100 * 2 ** (attempt - 1) + jitter(), remaining - 1))
}
```

Do not call `.unref()` on the abort deadline. Preserve S3 SigV4 recalculation per attempt so `x-amz-date` and signatures do not go stale.

Rename the hosted manifest field from `screenshots` to `local_screenshots` and schema-test that every value is a safe relative local artifact path. The `screenshots` field lives in `scripts/hosted-e2e-matrix.mjs` (schema key list and result assembly); rename it there and update its tests, while `scripts/hosted-monitor-runner.mjs` changes only `publishableHostedFiles`/`contentTypeFor` and manifest publication. Keep PNGs out of `publishableHostedFiles`; the durable manifest must not expose a fetchable-looking screenshot reference. Remove the unreachable `image/png` branch from `contentTypeFor`. A future decision to publish screenshots must add PNG upload, checksum, redaction, content type, retry, and fetch-after-publish proof together.

- [ ] **Step 4: Verify GREEN on Node 24 and current developer Node**

```bash
node --test scripts/hosted-monitor-state.test.mjs scripts/hosted-monitor-runner.test.mjs
```

The GitHub job in `RELEASE-027` repeats this on Node 24; local Node 25 success is not a substitute.

- [ ] **Step 5: Commit**

```bash
git add scripts/hosted-monitor-state.mjs scripts/hosted-monitor-state.test.mjs scripts/hosted-monitor-runner.mjs scripts/hosted-monitor-runner.test.mjs scripts/hosted-e2e-matrix.mjs scripts/hosted-e2e-matrix.test.mjs
git commit -m "fix(monitor): retry S3 publication within one deadline"
```

---

### Task 6: `RELEASE-019` — Resolve D-09 STRUCTURED_PREVIEW_EVIDENCE before changing release semantics

**Decision:** `D-09 STRUCTURED_PREVIEW_EVIDENCE`

**Files:**
- Modify: `scripts/e2e-browser.mjs`
- Modify: `scripts/e2e-browser-static.test.mjs`
- Modify: `scripts/browser-evidence.mjs`
- Modify: `scripts/browser-evidence.test.mjs`

**Branch A additional prerequisite:** The frontend/web capability lane must first expose a real product pending/extraction state. This worker does not add that product state.

- [ ] **Step 1: Stop for the recorded decision**

The coordinator must record exactly one of:

- **Branch A — product proof:** `pending_local_preview` navigates to and screenshots a real product pending/extraction state, and release evidence binds the screenshot to the same validation run, web origin, deploy IDs, and run ID as the remaining browser story.
- **Branch B — non-product evidence:** remove `pending_local_preview` from `REQUIRED_BROWSER_STORY_FRAME_IDS`; keep any structured preview in a separately normalized `non_product_evidence` collection that cannot satisfy screenshot counts, product-frame requirements, or production release proof.

The worker must not choose based on implementation convenience.

- [ ] **Step 2: Write the branch-specific failing test**

Branch A tests must fail if `page.setContent()` or harness-authored HTML supplies the frame, and must assert a real URL/product selector and exact run/deploy correlation.

Branch B tests must prove a complete release story passes without `pending_local_preview`, and that adding a `kind: "structured_preview"` frame cannot increase `product_screenshot_count` or satisfy a missing required product frame.

- [ ] **Step 3: Verify RED**

```bash
node --test scripts/e2e-browser-static.test.mjs scripts/browser-evidence.test.mjs
```

Expected: FAIL under either recorded branch because the current frame is harness-authored HTML yet mandatory release evidence.

- [ ] **Step 4: Implement only the recorded branch**

Branch A: delete `pendingPreviewHtml()`/`page.setContent()` capture and drive the actual product state. Branch B: separate required product frames from informational structured previews in normalization and assertions. Do not retain both semantics behind a flag.

- [ ] **Step 5: Verify GREEN and adversarial control**

Run Step 3. Then deliberately relabel a harness-authored structured frame as a product frame; the assertion must fail. Restore and rerun.

- [ ] **Step 6: Commit**

```bash
git add scripts/e2e-browser.mjs scripts/e2e-browser-static.test.mjs scripts/browser-evidence.mjs scripts/browser-evidence.test.mjs
git commit -m "fix(evidence): enforce the D-09 preview decision"
```

---

### Task 7: `RELEASE-015` / `RELEASE-023` — Supervise process trees, eliminate port races, and bind browser behavior

**Files:**
- Create: `scripts/process-supervisor.mjs`
- Create: `scripts/process-supervisor.test.mjs`
- Create: `scripts/e2e-browser.test.mjs`
- Modify: `scripts/e2e-browser.mjs`
- Modify: `scripts/e2e-browser-static.test.mjs`
- Modify: `scripts/dev-agent.mjs`
- Modify: `scripts/dev-agent.test.mjs`
- Modify: `scripts/hosted-monitor-runner.mjs`
- Modify: `scripts/hosted-monitor-runner.test.mjs`
- Modify: `scripts/release-check.mjs`
- Modify: `scripts/release-check.test.mjs`

- [ ] **Step 1: Write failing process-tree and port-race tests**

Use real short-lived Node fixtures to prove:

- a wrapper that spawns a grandchild listener is fully gone after `stop()`;
- SIGTERM is sent to the POSIX process group, exit is awaited, SIGKILL follows after a bounded grace only when necessary, and log streams finish after exit;
- spawn `error` rejects through the managed promise rather than escaping the caller's cleanup path;
- SIGINT/SIGTERM handlers invoke the same idempotent cleanup once;
- targeting `dev-agent.mjs` directly does not orphan Cargo/agent grandchildren;
- a forced close-then-bind collision causes one bounded reallocation/retry and the second attempt uses a different port;
- exhaustion after the bounded retry is a typed bind failure, never a readiness timeout against a stray listener.

The supervisor contract:

```js
const child = spawnManaged({ command, args, cwd, env, stdoutPath, stderrPath });
await child.ready;
await child.stop({ graceMs: 5_000 });
assert.equal(child.state, "exited");
```

**Post-Critical audio-harness ownership:** after the Plan 03 merge this lane permanently owns `scripts/e2e-browser-audio.mjs`, `scripts/fixtures/e2e-browser-audio-entry.ts`, and the `e2e:browser:audio`/`e2e:browser:audio:negative` root scripts. Their disposition is fixed: the standalone harness and both package.json entries survive. The `VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX` story invokes `bun run e2e:browser:audio` and binds its result plus the `oversized_single_chunk_negative_control` outcome into the release browser evidence; do not absorb the harness into `e2e-browser.mjs`/`e2e-browser-story.mjs` or delete either root script, because Plan 03's handoff preserves both proofs and Plan 15 runs `bun run e2e:browser:audio` and `bun run e2e:browser:audio:negative` directly on the combined tree. Task 16 budgets the surviving file in `module-concentration-policy.json`, and Task 17's `loopback-and-browser` job executes the negative control.

- [ ] **Step 2: Write failing behavioral E2E-helper tests**

Extract/import pure helpers without executing the browser script. Directly test URL normalization, hosted synthetic identity rejection, terminal proof reduction, and post-answer proof reduction. Retain source scans only for structural bans such as “REST bearer must not enter browser JavaScript.”

Add a negative control in which a source string remains present but the reducer returns an unconditional pass; the behavioral test must fail while the old regex would have passed.

Receive Plan 04's LEARN-012 Step 3 harness handoff and make its eight learning-truth assertions required visible checks of `bun run e2e:browser` on one authenticated study identity: (1) a question from `AuthenticatedStudyProjectionV1` starts; (2) an evaluated turn persists one `TurnOutcome`; (3) a deferred turn renders recovery without mastery; (4) a second question advances under selected D-02; (5) recap equals persisted outcomes; (6) review schedule uses selected D-01 authority and obeys exam policy; (7) completed recap copy dominates socket close/disconnection; (8) selected D-03 mode/goal is bound, or the removed UI is absent. Screenshot existence alone is insufficient. Confirm this handoff to Plan 04 — its LEARN-012 Step 3 stays `BLOCKED` until Plan 12 confirms the harness asserts them.

Add a required voice-transport-matrix contract to `scripts/e2e-browser.test.mjs`: when `VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1`, the browser evidence must prove 2-, 10-, and 45-second turns for both 44.1 kHz and 48 kHz source capture through the production client controller and real Rust WebSocket service. For every case assert bounded serialized frames, contiguous production frame identity/sequence, explicit `audio_end`, `audio_turn_accepted`, one transcript, one evaluation, and recap/next-question readiness. The story must fail on oversized frames, an absent duration/rate cell, skipped loopback, close-before-acceptance, backpressure reorder/drop, or a zero-match lower-layer test. Preserve the capability lane's pre-v5 single-frame rejection as a negative control; this task only binds that proof into the release browser evidence.

- [ ] **Step 3: Verify RED**

```bash
node --test scripts/process-supervisor.test.mjs scripts/e2e-browser.test.mjs scripts/e2e-browser-static.test.mjs scripts/dev-agent.test.mjs scripts/hosted-monitor-runner.test.mjs scripts/release-check.test.mjs
```

Expected: FAIL because `spawnLogged.stop()` kills only wrappers, ends logs early, lacks signal cleanup, `freePort()` races, and most E2E assertions inspect source text rather than behavior.

- [ ] **Step 4: Implement the shared supervisor**

On macOS/Linux spawn with `detached: true` and signal `-pid`; on unsupported platforms use explicit child-tree handling and tests appropriate to that platform. Await `exit` and `finished(stdout/stderr)` before returning. Make cleanup idempotent and never suppress a spawn error.

Replace `freePort()` call sites with a `spawnWithPortRetry` boundary. The retry must trigger only for an observed early bind failure; it must not retry arbitrary product/test failures.

Use the supervisor in local E2E, hosted monitor commands, release-check readiness children, and dev-agent. Hosted-mode browser runs do not spawn local product services, but their wrapper process still uses the same bounded teardown.

Make `spawnManaged` reject a missing/null environment and accept only the frozen role environment produced by `RELEASE-029`; it must never fall back to Node's implicit `process.env` inheritance.

- [ ] **Step 5: Verify GREEN and leak control**

Run Step 3 twice. The second run must bind cleanly and the process test must report no surviving grandchild PIDs or open fixture ports.

After the voice/frontend capability lanes merge, run the exact required browser matrix in both non-network provider modes:

```bash
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP \
  VIVA_E2E_AGENT_PROVIDER=synthetic \
  VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 \
  VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 \
  VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" \
  VIVA_E2E_ARTIFACT_DIR="artifacts/ci/browser-voice-matrix/synthetic" \
  bun run e2e:browser

env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP \
  VIVA_E2E_AGENT_PROVIDER=fake_cartesia_gemini \
  VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 \
  VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 \
  VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" \
  VIVA_E2E_ARTIFACT_DIR="artifacts/ci/browser-voice-matrix/fake-provider" \
  bun run e2e:browser
```

Expected: both commands exercise all six duration/sample-rate cells through the real local boundary and emit sanitized evidence bound to the current commit. Local success is necessary for `loopback-and-browser`; it is not hosted or deployed proof.

- [ ] **Step 6: Commit**

```bash
git add scripts/process-supervisor.mjs scripts/process-supervisor.test.mjs scripts/e2e-browser.mjs scripts/e2e-browser.test.mjs scripts/e2e-browser-static.test.mjs scripts/dev-agent.mjs scripts/dev-agent.test.mjs scripts/hosted-monitor-runner.mjs scripts/hosted-monitor-runner.test.mjs scripts/release-check.mjs scripts/release-check.test.mjs
git commit -m "fix(harness): supervise process trees and test behavior"
```

---

### Task 8: `RELEASE-001` — Make shell release gates fail closed when tools fail

**Files:**
- Modify: `scripts/check-generated-artifact-hygiene.sh`
- Create: `scripts/check-generated-artifact-hygiene.test.mjs`
- Modify: `package.json`

**Cross-lane dependency:** `DOMAIN-001` separately modifies/tests `scripts/check-agent-domain-purity.sh` with the same tool/error contract and redesigns its semantics. Do not edit that file here. Ledger alias "Release-gate scripts Minor M8 — dead docs exclusion in purity gate" is credited through `RELEASE-001` but implemented by Plan 06 `DOMAIN-001` (its purity redesign removes the dead `-g '!docs/superpowers/plans/**'` exclusion and pins the intended search roots). Do not report `RELEASE-001` complete until that `DOMAIN-001` commit is referenced in the handoff.

- [ ] **Step 1: Write failing missing-tool and pipeline tests**

Spawn `/bin/sh scripts/check-generated-artifact-hygiene.sh` with controlled `PATH` directories and stub executables. Prove:

- missing `git` exits non-zero with `git is required`;
- missing `rg` exits non-zero with `rg is required`;
- `rg` exit 1 means “no matches” and passes;
- `rg` exit 2 propagates failure;
- `git ls-files`, `git diff`, and `git diff --cached` failures propagate and cannot become empty match sets;
- a real generated path still fails with its current diagnostic;
- the hygiene gate scans exactly its intended roots/patterns, and a test-injected scope change (an added exclusion glob or a dropped root) fails the test.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/check-generated-artifact-hygiene.test.mjs
```

Expected: FAIL because `|| true` converts missing/erroring `rg`, and pipeline `git` failures, into a clean result.

- [ ] **Step 3: Implement explicit exit discrimination**

Check tools before work. Avoid a POSIX pipeline whose upstream status cannot be observed. Write `git` output to a temporary file, run `rg` on that file, and accept only `rg` status 1 as no-match:

```sh
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v rg >/dev/null 2>&1 || { echo "rg is required" >&2; exit 1; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

rg_status=0
rg "$generated_path_pattern" "$tracked_file" >"$workdir/matches" || rg_status=$?
case "$rg_status" in 0|1) ;; *) exit "$rg_status" ;; esac
```

Use `mktemp -d` and a trap; do not target a workspace/root path for cleanup.

- [ ] **Step 4: Verify GREEN and shared-contract integration**

```bash
node --test scripts/check-generated-artifact-hygiene.test.mjs
bun run release:hygiene
```

Before final merge, also run the `DOMAIN-001` gate test; its ownership stays in that lane.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-generated-artifact-hygiene.sh scripts/check-generated-artifact-hygiene.test.mjs package.json
git commit -m "fix(release): fail closed when hygiene tools error"
```

---

### Task 9: `RELEASE-002` / `RELEASE-020` — Make BAC-528 and `proved_by` fields attest real behavior

**Files:**
- Modify: `scripts/failure-control-harness.mjs`
- Modify: `scripts/failure-control-harness.test.mjs`
- Modify: `scripts/provider-limiter-evidence.mjs`
- Modify: `scripts/provider-limiter-evidence.test.mjs`
- Modify: `scripts/release-check.mjs`
- Modify: `scripts/release-check.test.mjs`
- Modify: `scripts/production-release-gate.test.mjs`

- [ ] **Step 1: Write failing BAC-528 semantic tests**

Assert disabled and enabled plans produce opposite evidence:

```js
assert.equal(failureControlHarnessEvidence({ enabled: false }).enabled_for_release, false);
assert.equal(failureControlHarnessEvidence(enabledPlan).enabled_for_release, true);
```

Then build production gate evidence with the enabled plan and assert `bac_528_harness_disabled` (the exact existing field name in `scripts/production-release-gate.mjs`) is false even if the top-level release-check throw is bypassed in the fixture.

- [ ] **Step 2: Write failing `proved_by` execution tests**

Export one constant for the Rust test name and use it in both evidence and release orchestration. Change the release command to the exact integration-test target:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws websocket_provider_backoff_denies_next_answer_before_brain_input -- --exact --nocapture
```

Add a parser/assertion that the command log reports exactly one passed matching test. A zero-test Cargo filter must fail release evidence construction. Keep a cross-file source-name test as a cheap drift guard, but do not let it replace execution/count proof.

- [ ] **Step 3: Verify RED**

```bash
node --test scripts/failure-control-harness.test.mjs scripts/provider-limiter-evidence.test.mjs scripts/release-check.test.mjs scripts/production-release-gate.test.mjs
```

Expected: FAIL because BAC-528 is hardcoded safe and the proof name is a self-compared string whose current Cargo filter may pass with zero tests.

- [ ] **Step 4: Implement minimal truthful evidence**

Set `enabled_for_release: plan?.enabled === true`, leaving `release_gate_must_fail_if_enabled: true`. In production-gate semantics, safe means strictly `enabled_for_release === false`; missing/null plan state may not be mislabeled enabled or bypass the independent release-check throw.

Make `providerLimiterReleaseEvidence` consume a proof record generated only after the exact test command succeeds with one observed test. It may name the constant, command record, and sanitized log digest; it may not embed test output.

- [ ] **Step 5: Verify GREEN and zero-test negative control**

Run Step 3 and the exact Cargo command. Then substitute a nonexistent test name in the JS fixture; the proof parser must reject zero executed tests. Restore and rerun.

- [ ] **Step 6: Commit**

```bash
git add scripts/failure-control-harness.mjs scripts/failure-control-harness.test.mjs scripts/provider-limiter-evidence.mjs scripts/provider-limiter-evidence.test.mjs scripts/release-check.mjs scripts/release-check.test.mjs scripts/production-release-gate.test.mjs
git commit -m "fix(evidence): bind gate claims to executed behavior"
```

---

### Task 10: `RELEASE-003` / `RELEASE-007` / `RELEASE-008` — Bind imports to exact sanitized run and deploy identities

**Files:**
- Modify: `scripts/hosted-monitor-runner.mjs`
- Modify: `scripts/hosted-monitor-runner.test.mjs`
- Modify: `scripts/live-provider-smoke.mjs`
- Modify: `scripts/live-provider-smoke.test.mjs`
- Modify: `scripts/release-evidence-imports.mjs`
- Modify: `scripts/release-evidence-imports.test.mjs`
- Modify: `scripts/production-release-gate.mjs`
- Modify: `scripts/production-release-gate.test.mjs`
- Modify: `docs/deployment-runbook.md`
- Modify: `scripts/deployment-runbook.test.mjs`

- [ ] **Step 1: Write failing exact-binding tests**

For production mode, prove the gate rejects:

- missing `VIVA_RELEASE_RUN_ID` even when an explicit manifest path is supplied;
- a manifest whose `run_id` differs by one character;
- a manifest with `sanitized` missing, null, or false;
- live smoke with missing/mismatched `run_id`;
- live smoke with missing/mismatched `agent_deploy_id`;
- live smoke with missing/mismatched `deploy_sha` when `VIVA_RELEASE_DEPLOY_SHA` is required;
- hosted browser results whose web/agent deploy IDs were inherited accidentally rather than mapped from the selected target;
- the lexicographic “latest” fallback in production.

Non-production convenience may still use latest, but its gate must remain `allowed: false`.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/hosted-monitor-runner.test.mjs scripts/live-provider-smoke.test.mjs scripts/release-evidence-imports.test.mjs scripts/production-release-gate.test.mjs scripts/deployment-runbook.test.mjs
```

Expected: FAIL because production run binding is optional, manifest sanitization accepts a missing flag, live smoke is freshness/budget checked but not deploy/run bound, and hosted child deploy IDs rely on ambient environment.

- [ ] **Step 3: Implement explicit binding fields**

Require and explicitly map target identity values:

```js
{
  VIVA_E2E_WEB_DEPLOY_ID: target.webDeployId,
  VIVA_E2E_AGENT_DEPLOY_ID: target.agentDeployId,
  VIVA_E2E_DEPLOY_SHA: target.deploySha,
  VIVA_HOSTED_RUN_ID: runId,
}
```

For live smoke write `run_id`, `agent_deploy_id`, and `deploy_sha` at top level and inside the monitor correlation summary. Production `summarizeLiveSmoke` must require equality with `VIVA_RELEASE_RUN_ID`, `VIVA_RELEASE_AGENT_DEPLOY_ID`, and `VIVA_RELEASE_DEPLOY_SHA`. Add distinct missing-evidence IDs (`live_smoke_run_id_match`, `live_smoke_agent_deploy_match`, `live_smoke_deploy_sha_match`) so diagnostics do not collapse into `budget_capped_live_smoke`.

Change manifest validation to `manifest.sanitized !== true` and require `VIVA_RELEASE_RUN_ID` before resolving any production path.

- [ ] **Step 4: Verify GREEN and mismatch mutation**

Run Step 2. Mutate each binding independently and confirm only its named gate fails. Restore and rerun.

- [ ] **Step 5: Commit**

```bash
git add scripts/hosted-monitor-runner.mjs scripts/hosted-monitor-runner.test.mjs scripts/live-provider-smoke.mjs scripts/live-provider-smoke.test.mjs scripts/release-evidence-imports.mjs scripts/release-evidence-imports.test.mjs scripts/production-release-gate.mjs scripts/production-release-gate.test.mjs docs/deployment-runbook.md scripts/deployment-runbook.test.mjs
git commit -m "fix(release): bind evidence to exact run and deploy"
```

---

### Task 11: `RELEASE-004` — Add downstream HMAC verification and prevent production downgrade

**Files:**
- Create: `scripts/verify-release-bundle.mjs`
- Create: `scripts/verify-release-bundle.test.mjs`
- Modify: `scripts/production-release-gate.mjs`
- Modify: `scripts/production-release-gate.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-runbook.md`
- Modify: `scripts/deployment-runbook.test.mjs`

- [ ] **Step 1: Write failing downgrade/verifier tests**

Cover:

- production bundle + missing verifier secret -> reject;
- production bundle relabeled/re-signed with `sha256-self` -> reject even when the verifying environment lacks a secret;
- `signature_key_present !== true` -> reject in production;
- correct HMAC + wrong secret -> reject;
- correct HMAC + exact secret -> pass, then run `assertProductionReleaseGate` over the stored bundle;
- tamper after storage -> reject;
- correct HMAC over a stale bundle or a bundle whose deploy SHA/run ID differs from the verifier's exact expected release identity -> reject;
- non-production self-integrity remains diagnosable but can never become `allowed: true`.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/production-release-gate.test.mjs scripts/verify-release-bundle.test.mjs scripts/deployment-runbook.test.mjs
```

Expected: FAIL because verification currently recomputes whichever algorithm the verifier environment implies, and no downstream CLI exists.

- [ ] **Step 3: Implement strict verification mode**

Add an explicit verification policy:

```js
assertReleaseBundleIntegrity(evidence, {
  env,
  requireHmac: evidence.production_release_gate?.production_requested === true,
});
```

When `requireHmac` is true, require a non-empty `VIVA_RELEASE_BUNDLE_SIGNING_SECRET`, `signature_algorithm === "hmac-sha256"`, and `signature_key_present === true` before comparing signatures. Do not accept an env-driven algorithm downgrade.

`scripts/verify-release-bundle.mjs` accepts exactly one evidence path, reads it after generation/storage, invokes strict integrity and production-gate assertions, emits a sanitized one-line success record containing only schema, run ID, deploy IDs, payload hash, and verification status, and exits non-zero on any failure.

When the bundle's `production_release_gate.production_requested` is true, `scripts/verify-release-bundle.mjs` must also require `VIVA_RELEASE_RUN_ID`, `VIVA_RELEASE_DEPLOY_SHA`, `VIVA_RELEASE_WEB_DEPLOY_ID`, and `VIVA_RELEASE_AGENT_DEPLOY_ID` from its environment (the same names Task 10 binds) and reject a bundle whose bound identity differs from any of them; missing expected-identity values are a verification failure, not a skip.

Add:

```json
"release:verify": "node scripts/verify-release-bundle.mjs"
```

Document the exact downstream form:

```bash
VIVA_RELEASE_BUNDLE_SIGNING_SECRET="$VIVA_RELEASE_BUNDLE_SIGNING_SECRET" \
  bun run release:verify -- artifacts/release-check/evidence.json
```

Plan 15 supplies the secret in the authorized deployment/release environment; this plan does not execute that production command.

- [ ] **Step 4: Verify GREEN**

Run Step 2. Generate test fixtures only in a temporary directory; do not commit a signed evidence bundle or secret.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-release-bundle.mjs scripts/verify-release-bundle.test.mjs scripts/production-release-gate.mjs scripts/production-release-gate.test.mjs package.json docs/deployment-runbook.md scripts/deployment-runbook.test.mjs
git commit -m "feat(release): verify stored production bundles with HMAC"
```

---

### Task 12: `RELEASE-005` / `RELEASE-006` / `RELEASE-009` / `RELEASE-010` / `RELEASE-011` — Make release-check hermetic, unique, and behavior-tested

**Files:**
- Create: `scripts/release-check-core.mjs`
- Modify: `scripts/release-check.mjs`
- Modify: `scripts/release-check.test.mjs`
- Modify: `scripts/redaction-control.mjs`
- Modify: `scripts/redaction-control.test.mjs`
- Modify: `scripts/production-release-gate.mjs`
- Modify: `scripts/production-release-gate.test.mjs`

- [ ] **Step 1: Write failing orchestration tests**

Replace the three grep-only release-check tests with behavioral tests over extracted functions. Prove:

- a child `ENOENT` rejects into the top-level quarantine path, writes sanitized `failure.json`, and deletes the releasable artifact directory;
- duplicate command name is rejected before the second spawn and cannot overwrite logs;
- command names map one-to-one to stdout/stderr paths;
- streams finish before a command record is finalized;
- readiness children see an explicit allowlisted environment and ignore hostile inherited `DATABASE_URL`, session/WS secrets, provider keys, live runtime flags, production release flags, and failure-control values;
- marker-bearing evidence throws even if a call remains present as dead/commented source text;
- the caller's injected env, not `process.env`, controls secret-value scanning;
- `release_gate.max_age_seconds` equals the same parsed `VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS` used by the production gate.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/release-check.test.mjs scripts/redaction-control.test.mjs scripts/production-release-gate.test.mjs
```

Expected: FAIL because spawn errors escape the cleanup promise, `provider_gate_tests` is duplicated, logs clobber, marker assertions are triplicated/drifting, current tests only grep source, and age is hardcoded to 86,400. The `RELEASE-029` environment assertions are retained as regression coverage and should already pass.

- [ ] **Step 3: Extract and implement testable orchestration**

Move command registration, command execution, evidence auditing, and release-gate summary construction into `release-check-core.mjs`. Continue importing the one `childEnvironmentFor("release-check", ...)` constructor from `RELEASE-029`; do not copy its policy. Enforce uniqueness before opening logs:

```js
if (seenNames.has(name)) throw new Error(`duplicate release command name: ${name}`);
seenNames.add(name);
```

Delete the second `provider_gate_tests` invocation. Route spawn `error` through the awaited promise/shared supervisor. Build each readiness target's explicit role values, then pass them through the shared child-environment constructor; do not spread `process.env`.

Make `redaction-control.mjs` the canonical exported marker/assertion implementation. `production-release-gate.mjs` imports it and adds gate-only markers explicitly; thread the supplied `env` through every assertion. Export/reuse `DEFAULT_MAX_EVIDENCE_AGE_SECONDS` and one positive-integer parser for both summaries.

- [ ] **Step 4: Verify GREEN and adversarial controls**

Run Step 2, then run:

```bash
node --test scripts/release-check.test.mjs --test-name-pattern="spawn failure|duplicate|ambient|marker|max age"
```

If the local Node version does not support option ordering, use:

```bash
node --test --test-name-pattern="spawn failure|duplicate|ambient|marker|max age" scripts/release-check.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add scripts/release-check-core.mjs scripts/release-check.mjs scripts/release-check.test.mjs scripts/redaction-control.mjs scripts/redaction-control.test.mjs scripts/production-release-gate.mjs scripts/production-release-gate.test.mjs
git commit -m "fix(release): isolate commands and unify evidence policy"
```

---

### Task 13: `RELEASE-028` — Validate every raw learner-loop and voice contract before release use

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `scripts/release-contract-validation.mjs`
- Create: `scripts/release-contract-validation.test.mjs`
- Modify: `scripts/rollback-drain-criteria.mjs`
- Modify: `scripts/rollback-drain-criteria.test.mjs`
- Modify: `scripts/live-provider-failure-matrix.mjs`
- Modify: `scripts/live-provider-failure-matrix.test.mjs`
- Modify: `scripts/hosted-e2e-matrix.mjs`
- Modify: `scripts/hosted-e2e-matrix.test.mjs`
- Modify: `scripts/provider-failure-observability.mjs`
- Modify: `scripts/provider-failure-observability.test.mjs`
- Modify: `scripts/live-provider-smoke.mjs`
- Modify: `scripts/live-provider-smoke.test.mjs`
- Modify: `scripts/e2e-browser.mjs`
- Modify: `scripts/e2e-browser.test.mjs`

**Upstream ownership prerequisite:** Plan 04/05 contract owners publish strict pure-ESM runtime functions `validateLearnerLoopContract(value)` and `parseVivaServerFrame(value)`; Plan 14 exposes them to Node 24 at the exact package subpath `@viva/core/runtime-validation`. Those validators must reject unknown keys at every nested level and reconstruct an allowed value rather than returning a cast reference. This task consumes that public surface and must not edit or duplicate package schemas. Plan 12 owns the root Node-resolution handoff: add the exact root development dependency `"@viva/core": "workspace:*"` and regenerate `bun.lock`; Plan 14 must not edit or stage those two files.

- [ ] **Step 1: Write failing strict-consumption and sanitization tests**

Add table-driven behavioral tests covering every release consumer named above. For learner-loop data, mutate one valid fixture at a time with an unknown top-level field, unknown nested state/copy field, invalid enum, duplicate state ID, and malformed evidence-field list. For voice data, exercise unknown top-level/frame/event fields, wrong version, invalid event shape, malformed JSON, and a valid structured server error. Prove:

- root `package.json` declares exact dev dependency `"@viva/core": "workspace:*"`, the refreshed lockfile resolves it to the workspace package rather than the registry, and a real Node 24 process can import `@viva/core/runtime-validation` and observe both validator functions;
- all release/monitor runtime and test consumers use one validated singleton; `scripts/release-contract-validation.mjs` is the only file under `scripts/` allowed to import `learner-loop-contract.json` directly;
- smoke and manual browser-WebSocket paths validate each decoded frame before branching on `type`, `event`, terminality, failure class, or evidence fields;
- invalid input yields only stable sanitized codes `learner_loop_contract_invalid` or `voice_server_frame_invalid`; thrown messages, evidence, logs, and browser results contain none of the hostile unknown key/value, transcript, answer, token, or raw JSON;
- a valid structured server error remains distinct from a malformed protocol frame as required by `RELEASE-022`;
- mutating the caller's raw object after validation cannot change the frozen/reconstructed validated value;
- deleting or bypassing the validator call in any consumer fixture makes its behavioral test fail. A structural import scan is retained only to ban direct raw JSON imports; it is not the acceptance proof.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/release-contract-validation.test.mjs scripts/rollback-drain-criteria.test.mjs scripts/live-provider-failure-matrix.test.mjs scripts/hosted-e2e-matrix.test.mjs scripts/provider-failure-observability.test.mjs scripts/live-provider-smoke.test.mjs scripts/e2e-browser.test.mjs
```

Expected: FAIL because the root workspace does not link `@viva/core`, four release modules import and trust raw learner-loop JSON, smoke/browser code branches on parsed voice objects without the published strict validator, and current package parsers may return cast references or tolerate unknown fields.

- [ ] **Step 3: Add one sanitized release adapter**

Use the published validator only through this adapter:

```js
import rawLearnerLoopContract from "../packages/core/src/learner-loop-contract.json" with {
  type: "json",
};
import {
  parseVivaServerFrame,
  validateLearnerLoopContract,
} from "@viva/core/runtime-validation";

export function validatedLearnerLoopForRelease(value) {
  try {
    return deepFreeze(validateLearnerLoopContract(structuredClone(value)));
  } catch {
    throw new ReleaseContractValidationError("learner_loop_contract_invalid");
  }
}

export function validatedVoiceFrameForRelease(value) {
  try {
    return deepFreeze(parseVivaServerFrame(structuredClone(value)));
  } catch {
    throw new ReleaseContractValidationError("voice_server_frame_invalid");
  }
}

export const RELEASE_LEARNER_LOOP_CONTRACT = validatedLearnerLoopForRelease(
  rawLearnerLoopContract,
);
```

The error class exposes the stable code only and never stores `cause`, raw input, parser text, or an input-derived message. The adapter owns no allowed-key list. Replace every runtime/test raw learner-loop import under `scripts/` with `RELEASE_LEARNER_LOOP_CONTRACT`; tests that need hostile variants call `validatedLearnerLoopForRelease` explicitly.

Add the exact root manifest link and regenerate the lock with the repository's pinned Bun 1.3.3:

```json
{
  "devDependencies": {
    "@viva/core": "workspace:*"
  }
}
```

```bash
bun install
node -e 'import("@viva/core/runtime-validation").then((m) => { if (typeof m.validateLearnerLoopContract !== "function" || typeof m.parseVivaServerFrame !== "function") process.exit(1); })'
```

The manifest fragment is additive to the existing exact dev dependencies; it does not replace them. Run the import proof under Node 24, from the repository root, with no `NODE_PATH`, loader, source-relative fallback, or ambient package-manager shim.

For `live-provider-smoke.mjs`, validate immediately after JSON decoding. For the browser-native WebSocket inside `page.evaluate`, expose `validatedVoiceFrameForRelease` with `page.exposeFunction`, await it before any frame use, and return only the validated reconstructed value or stable sanitized code into page context. Do not serialize validator source or maintain a second browser schema.

- [ ] **Step 4: Verify GREEN and bypass controls**

Run Step 2. Then make each consumer fixture receive a validator that returns its input unchanged; each corresponding test must fail on an unknown field. Restore the strict validator, inject a secret sentinel into malformed JSON, rerun, and require the stable code with zero sentinel occurrences.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock scripts/release-contract-validation.mjs scripts/release-contract-validation.test.mjs scripts/rollback-drain-criteria.mjs scripts/rollback-drain-criteria.test.mjs scripts/live-provider-failure-matrix.mjs scripts/live-provider-failure-matrix.test.mjs scripts/hosted-e2e-matrix.mjs scripts/hosted-e2e-matrix.test.mjs scripts/provider-failure-observability.mjs scripts/provider-failure-observability.test.mjs scripts/live-provider-smoke.mjs scripts/live-provider-smoke.test.mjs scripts/e2e-browser.mjs scripts/e2e-browser.test.mjs
git commit -m "fix(release): validate raw runtime contracts before use"
```

---

### Task 14: `RELEASE-024` — Remediate lockfiles and make audits acceptance gates

**Acceptance alias:** Plan 15 credits this implementation through canonical `INTEGRATION-004`; this task owns lockfiles/audit policy, not another lane's manifest.

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `agent/Cargo.lock`
- Create: `scripts/dependency-policy.test.mjs`

**Owner prerequisites before GREEN:** Plan 14 commits `default-features = false` and Postgres-only SQLx features in `agent/Cargo.toml`; any crate-level dependency constraint needed after resolution is committed by Plan 06/07/08. This task owns the exact `apps/web/package.json` audit/test dependency changes named below, but must stop and hand a product regression to the web owner rather than changing capability source.

- [ ] **Step 1: Capture the failing audit baseline**

Run:

```bash
bun audit
cargo audit --file agent/Cargo.lock --no-fetch --deny warnings
```

Expected RED on the reviewed lockfiles:

- Bun: 16 vulnerabilities (Next `<16.2.11`, Sharp `<0.35.0`, PostCSS `<=8.5.22`, Nano ID `<3.3.16`).
- Cargo: `RUSTSEC-2026-0185` via `quinn-proto 0.11.14`, `RUSTSEC-2023-0071` via unused `sqlx-mysql`, plus warnings for `anyhow 1.0.102`, `event-listener 5.4.1`, and yanked `spin 0.9.8`.

If advisory fetch cannot run, `--no-fetch` may diagnose against the existing database, but CI must fetch a current database and is the acceptance gate.

- [ ] **Step 2: Write the failing dependency-policy test**

Assert:

- `package.json` exposes `audit:js`, `audit:rust`, and `audit`, and `validate` runs `audit`;
- root dev dependency `@viva/core` is exactly `workspace:*`, `bun.lock` resolves it as the local workspace, and Node 24 imports `@viva/core/runtime-validation` without a loader or source-relative fallback;
- root dev dependency `yaml` is pinned exactly to `2.8.2`, so workflow/domain policy tests semantically parse active jobs and steps without relying on a transitive dependency or source grep;
- root dev dependency `playwright` is pinned exactly to `1.61.0`, matching the browser runtime used by both the ordinary and any retained static E2E gate;
- `apps/web/package.json` pins Next exactly to `16.3.2` and pins dev dependencies `happy-dom` and `@happy-dom/global-registrator` exactly to `20.11.6` for Plan 10's mounted-test environment;
- Bun resolves Next 16.3.2, PostCSS at least 8.5.23, Nano ID at least 3.3.16, and Sharp at least 0.35.3;
- the owner-supplied workspace SQLx declaration has `default-features = false` and only Postgres/runtime/TLS/UUID/chrono/json/migrate features;
- the recorded D-04 selector and Plan-06-owned `agent-domain/Cargo.toml` agree exactly: `chrono.workspace = true` and `uuid.workspace = true` are direct dependencies only for `SOFT_DELETE_UNDO`, while both are absent for `CONFIRM_DELETE`; `cargo-udeps` remains required in either branch;
- `rsa`, `sqlx-mysql`, and `sqlx-sqlite` are absent from `agent/Cargo.lock`;
- `quinn-proto` is at least 0.11.17, `anyhow` at least 1.0.104, and `event-listener` at least 5.4.2.

- [ ] **Step 3: Verify RED**

```bash
node --test scripts/dependency-policy.test.mjs
```

- [ ] **Step 4A: Commit the additive `12A` mounted-DOM dependency handoff before Plan 10**

Before Plan 10 creates `apps/web/test/setup-dom.ts` or any mounted test, add only these exact `apps/web/package.json` dev dependencies and regenerate `bun.lock` with Bun 1.3.3:

```json
"@happy-dom/global-registrator": "20.11.6",
"happy-dom": "20.11.6"
```

```bash
bun install
bun install --frozen-lockfile
bun pm ls | rg 'happy-dom@20\.11\.6|@happy-dom/global-registrator@20\.11\.6'
node --input-type=module --eval 'import { readFile } from "node:fs/promises"; const p = JSON.parse(await readFile("apps/web/package.json", "utf8")); if (p.devDependencies?.["happy-dom"] !== "20.11.6" || p.devDependencies?.["@happy-dom/global-registrator"] !== "20.11.6") process.exit(1)'
git add apps/web/package.json bun.lock
git commit -m "test(web): pin mounted DOM runtime"
```

Expected: the `rg` filter prints both package lines — `happy-dom@20.11.6` and `@happy-dom/global-registrator@20.11.6` must each appear — resolved as direct app dev dependencies. This `12A` commit contains no root manifest, audit upgrade, workflow, static-export disposition, setup file, mounted test, or product source. Report its SHA to Plan 10 and Plan 14; neither owner edits or stages these two files.

- [ ] **Step 4A2: Commit the additive `12A` root-manifest handoff before Plan 06's policy test and Plan 14's GREEN verification**

Add only these exact root `package.json` entries and regenerate `bun.lock` with Bun 1.3.3: dev dependencies `"yaml": "2.8.2"` (Plan 06's `scripts/rust-domain-quality-policy.test.mjs` prerequisite — merge before Plan 06 per the program's `L12A --> L06` edge) and `"@viva/core": "workspace:*"`, plus root script `"build:cache:prove": "node scripts/prove-turbo-cache-restoration.mjs"` (Plan 14's handoff; the script file itself is Plan 14-owned and may land later). Run `bun install`, `bun install --frozen-lockfile`, then commit only `package.json` and `bun.lock`. This `12A` commit contains no app-manifest change, audit upgrade, workflow, static-export disposition, or product source. Report its SHA to Plan 06 and Plan 14; Plan 14's Task 3 Step 5, Task 4 Step 5, and Task 7 Step 1 gate on it being merged to integration before Plan 14's GREEN verification.

- [ ] **Step 4A3: Regenerate the lockfile for Plan 13's Task 1/Task 2 manifest handoff**

On receipt of Plan 13's Task 1 and Task 2 manifest commit SHAs (`packages/tokens/package.json` export addition; `packages/ui-web/package.json` dependency/peer changes), regenerate `bun.lock` with Bun 1.3.3 in one additive commit mirroring Step 4A (no other manifest change), so `bun install --frozen-lockfile` stays green once `13A` merges. Per Plan 13's preamble item 7, `13A` must not be merged to integration before this lockfile commit exists, and the coordinator merges `13A` immediately after this commit with no intervening lane merge (constraint 9(c)); Plan 13 never stages `bun.lock` itself. Report the commit SHA to Plan 13 and the coordinator.

- [ ] **Step 4B: Upgrade the remaining JavaScript dependency tree in `12B`**

After the capability-owner handoffs, preserve both exact DOM pins and the `12A` root additions (`yaml: "2.8.2"`, `"@viva/core": "workspace:*"`, `build:cache:prove`), set exact `next: "16.3.2"` in `apps/web/package.json`, and add exact root dev dependency `playwright: "1.61.0"`; then regenerate `bun.lock` with Bun 1.3.3 and do not use a permanent audit ignore. The expected compatible resolution is PostCSS 8.5.23 or newer, Nano ID 3.3.16 or newer, and Sharp 0.35.3 or newer. Plan 14's package-build contract is blocked on this final lock resolution; Plan 06's semantic workflow-policy test needs only the `12A` `yaml` dependency plus the `12B` commands/workflow.

```bash
bun install
bun install --frozen-lockfile
bun pm ls | rg 'happy-dom@20\.11\.6|@happy-dom/global-registrator@20\.11\.6'
bun audit
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web test
bun test apps/web/components/session/LiveSessionPage.mounted.test.tsx
bun run --cwd apps/web build
```

Expected: the `bun pm ls` output contains both DOM package lines at exactly 20.11.6 (both must appear), audit exits 0, and web validation passes. A missing registrator or a transitive-only DOM implementation is RED. If Next 16.3.2 exposes a capability regression, stop and route the capability fix to the web lane; do not waive the advisory in this lane.

- [ ] **Step 5: Prune and upgrade the Rust dependency tree**

Require Plan 14 to commit:

```toml
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "tls-rustls", "postgres", "uuid", "chrono", "json", "migrate"] }
```

After that owner commit and the selected Plan 06 D-04 manifest commit land, regenerate only `agent/Cargo.lock` with targeted compatible versions. Do not add `chrono`/`uuid` to `agent-domain` from this lane; consume them only when Plan 06's recorded selector is `SOFT_DELETE_UNDO`, and require their absence for `CONFIRM_DELETE`:

```bash
cargo update --manifest-path agent/Cargo.toml -p quinn-proto --precise 0.11.17
cargo update --manifest-path agent/Cargo.toml -p anyhow --precise 1.0.104
cargo update --manifest-path agent/Cargo.toml -p event-listener --precise 5.4.2
cargo test --manifest-path agent/Cargo.toml --workspace
cargo audit --file agent/Cargo.lock --deny warnings
```

Expected: MySQL/SQLite/RSA/Spin-only lockfile branches disappear, the patched versions resolve, tests pass, and the current advisory database reports zero vulnerabilities/warnings. Do not add an ignore for the unfixed RSA advisory; remove its unused MySQL dependency path.

- [ ] **Step 6: Wire fail-closed audit scripts**

Add:

```json
"audit:js": "bun audit",
"audit:rust": "cargo audit --file agent/Cargo.lock --deny warnings",
"audit": "bun run audit:js && bun run audit:rust"
```

Include `bun run audit` in `validate`. Missing `cargo-audit` must fail with a clear prerequisite message; `RELEASE-027` installs exactly cargo-audit 0.22.0 with `--locked` before validation.

- [ ] **Step 7: Verify GREEN**

```bash
node --test scripts/dependency-policy.test.mjs
bun run audit
bun run validate
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json package.json bun.lock agent/Cargo.lock scripts/dependency-policy.test.mjs
git commit -m "security(deps): remediate advisories and gate audits"
```

---

### Task 15: `RELEASE-026` — Pin reproducible non-root runtime images and verify Bun bytes

**Acceptance aliases:** Plan 15 credits the repository-local built-image and provenance proof through `INTEGRATION-004`, then the exact-deploy runtime-image proof through `INTEGRATION-009`; this task owns the Dockerfile/release-provenance implementation hotspots.

**Files:**
- Modify: `agent/Dockerfile`
- Modify: `Dockerfile.monitor`
- Modify: `scripts/release-check.mjs`
- Modify: `scripts/release-check.test.mjs`
- Modify: `scripts/production-release-gate.mjs`
- Modify: `scripts/production-release-gate.test.mjs`
- Modify: `scripts/deployment-runbook.test.mjs`
- Create: `scripts/container-supply-chain.test.mjs`
- Modify: `docs/deployment-runbook.md`

- [ ] **Step 1: Write failing Dockerfile policy tests**

Parse Dockerfiles and require:

- every `FROM` has a 64-hex sha256 digest;
- the agent runtime ends as uid/gid `10001:10001` (or named `viva` mapped to those IDs);
- the monitor ends as Playwright's non-root `pwuser` and owns `/app/evidence`;
- no `curl ... | bash` remains;
- Bun 1.3.3 archives are SHA-256 checked for both supported architectures;
- the Dockerfile's Playwright version still matches Bun's resolved Playwright 1.61.0;
- release evidence records the three reviewed base-image digests and Bun archive checksums as build inputs, while production evidence separately requires exact `sha256:` agent and monitor output-image digests supplied by the selected deployments;
- missing, tag-only, malformed, or swapped output-image digests fail the production gate; a base-image digest can never masquerade as a built/deployed image digest.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/container-supply-chain.test.mjs scripts/release-check.test.mjs scripts/production-release-gate.test.mjs scripts/deployment-runbook.test.mjs
```

Expected: FAIL because images use mutable tags, both runtimes default to root, Bun is installed from a live curl-piped script, and release evidence does not distinguish pinned build inputs from exact deployed output-image digests.

- [ ] **Step 3: Pin the reviewed OCI indexes**

Use these immutable multi-architecture index digests resolved on 2026-08-23:

```dockerfile
FROM rust:1.94.1-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2 AS builder
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS runtime
FROM mcr.microsoft.com/playwright:v1.61.0-noble@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a
```

The implementation PR must record the tag-to-digest inspection command output in its local verification log, but the committed Dockerfile remains digest-authoritative.

- [ ] **Step 4: Install Bun from verified release bytes**

Use `ARG TARGETARCH` and exact Bun 1.3.3 checksums:

```text
linux/amd64 bun-linux-x64.zip     f5c546736f955141459de231167b6fdf7b01418e8be3609f2cde9dfe46a93a3d
linux/arm64 bun-linux-aarch64.zip 41b9f4f25256db897c2c135320e4f96c373e20ae6f06d8015187dac83591efc8
```

Download from `https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/` plus the selected exact archive name, validate with `sha256sum -c`, unzip, and `install -m 0755` to `/usr/local/bin/bun`. Reject unknown architectures. Delete archives and temporary extraction directories in the same layer.

- [ ] **Step 5: Drop runtime privileges**

In the agent runtime create uid/gid 10001, copy the binary with correct ownership, and set `USER 10001:10001`. In the monitor use the image's `pwuser`, `COPY --chown=pwuser:pwuser`, ensure `/app/evidence` is owned by `pwuser`, and set `USER pwuser` before `CMD`. Build-time apt/espeak/ffmpeg work remains root-only and leaves no writable root-owned evidence target.

In `release-check`, emit a sanitized `container_provenance` record with typed `build_inputs` and `deployment_outputs`. For production, require `VIVA_RELEASE_AGENT_IMAGE_DIGEST` and `VIVA_RELEASE_MONITOR_IMAGE_DIGEST`, bind them to the same exact run/deploy identity as Task 10, and make `assertProductionReleaseGate` compare them to the selected deployment metadata. Non-production evidence explicitly records `deployment_outputs.status: "not_proven"`; it cannot infer an output digest from a `FROM` line or turn local image inspection into deployed provenance.

- [ ] **Step 5A: Apply Plan 08's `SERVICE-003` runbook handoff**

Update the direct-WSS recipe in `docs/deployment-runbook.md` (the `VIVA_VOICE_WS_MAX_IP_SESSIONS` guidance, currently ~line 85) with Plan 08's Task 3 handoff text: the per-IP session cap keys off the socket peer address, or the rightmost untrusted hop when `VIVA_VOICE_WS_TRUSTED_PROXY_CIDRS` is configured; remove any claim that direct deployments require a forwarding proxy header; and document that unset trusted proxies means forwarding headers are ignored. Extend `scripts/deployment-runbook.test.mjs` to assert the runbook names the peer/trusted-proxy semantics and contains no forwarding-header requirement for direct deployments. Report this commit SHA to the coordinator so it is linked in the `SERVICE-003` ledger rows requiring the runbook update.

- [ ] **Step 6: Verify images behaviorally**

```bash
docker build -f agent/Dockerfile agent -t viva-agent-supply-chain-test
docker run --rm --entrypoint sh viva-agent-supply-chain-test -c 'test "$(id -u)" = 10001 && test "$(id -g)" = 10001'
docker build -f Dockerfile.monitor . -t viva-monitor-supply-chain-test
docker run --rm --entrypoint sh viva-monitor-supply-chain-test -c 'test "$(id -u)" != 0 && test "$(bun --version)" = 1.3.3 && test -r /app/evidence/live-smoke-answer.pcm && test -w /app/evidence'
docker run --rm --read-only --tmpfs /tmp --entrypoint sh viva-agent-supply-chain-test -c 'test "$(id -u)" = 10001 && touch /tmp/agent-write-probe'
docker run --rm --read-only --tmpfs /tmp --tmpfs /app/evidence:rw,uid=1000,gid=1000,mode=0750 --entrypoint sh viva-monitor-supply-chain-test -c 'test "$(id -u)" != 0 && touch /tmp/monitor-write-probe && touch /app/evidence/monitor-write-probe'
node --test scripts/container-supply-chain.test.mjs scripts/release-check.test.mjs scripts/production-release-gate.test.mjs scripts/deployment-runbook.test.mjs
```

These are local image/runtime proofs, not hosted deployment proof.

- [ ] **Step 7: Commit**

```bash
git add agent/Dockerfile Dockerfile.monitor scripts/container-supply-chain.test.mjs scripts/release-check.mjs scripts/release-check.test.mjs scripts/production-release-gate.mjs scripts/production-release-gate.test.mjs scripts/deployment-runbook.test.mjs docs/deployment-runbook.md
git commit -m "security(containers): pin images and run nonroot"
```

---

### Task 16: `RELEASE-030` — Characterize and ratchet concentrated modules before extraction

**Files:**
- Create: `scripts/module-concentration-policy.json`
- Create: `scripts/module-concentration-policy.test.mjs`
- Create: `scripts/e2e-browser-plan.mjs`
- Create: `scripts/e2e-browser-plan.test.mjs`
- Create: `scripts/e2e-browser-runtime.mjs`
- Create: `scripts/e2e-browser-runtime.test.mjs`
- Create: `scripts/e2e-browser-story.mjs`
- Create: `scripts/e2e-browser-story.test.mjs`
- Modify: `scripts/e2e-browser.mjs`
- Modify: `scripts/e2e-browser.test.mjs`
- Modify: `scripts/e2e-browser-static.test.mjs`
- Modify: `package.json`

**Capability ownership lock:** this task may characterize but never edit the Plan 07/08/09/13 source paths in the budget below. Their named owners perform any required extraction and return a commit; Plan 12 rebases, reruns the policy, and changes only its E2E files.

- [ ] **Step 1: Freeze behavioral characterization before moving code**

Extend the Task 7 browser behavior suite to record normalized results for synthetic, fake-provider, failure-control, D-09's selected preview semantics, the six-cell voice matrix, port retry, process cleanup, console/page errors, screenshot inventory, run/deploy identity, and sanitization. The fixture compares semantic objects and observable child/process results, never full source text or unstable log timestamps.

Create `module-concentration-policy.json` with this reviewed `4d5d8276f03635ca74c04f4d500d13ce62198dd0` baseline and exact owner/boundary records:

| Path | Reviewed lines | Extraction owner | Required authority boundary |
| --- | ---: | --- | --- |
| `agent/crates/agent-service/tests/voice_ws.rs` | 11,421 | Plan 08 | auth/lease, audio-turn, durability, and failure-control integration modules with shared real-WS fixtures |
| `agent/crates/agent-service/src/ws.rs` | 5,467 | Plan 08 | preflight/admission, active-turn runtime, provider forwarding, and terminal/error evidence |
| `agent/crates/data/src/memory.rs` | 5,145 | Plan 09 | shared store conformance plus bounded memory backend repositories |
| `apps/web/app/globals.css` | 4,864 | Plan 13 | tokens/base, landing, session, accessibility/motion, and print layers with preserved cascade tests |
| `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs` | 3,175 | Plan 07 | session orchestration, stream event reduction, cancellation, and tool lifecycle |
| `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs` | 3,028 | Plan 07 | request construction, incremental decoder, retry/deadline policy, and sanitized provider errors |
| `agent/crates/data/src/postgres.rs` | 2,480 | Plan 09 | shared conformance plus Postgres repositories aligned with memory boundaries |
| `agent/crates/agent-service/src/app.rs` | 2,395 | Plan 08 | health/readiness, library/ingestion, operational evidence, and route composition |
| `scripts/e2e-browser.mjs` | 1,855 | Plan 12 | pure plan/config, managed runtime, browser story, and thin entrypoint |
| `scripts/live-provider-smoke.test.mjs` | 1,494 | Plan 12 | config/deadline, protocol classification, termination, and evidence test modules with shared fixtures |
| `scripts/live-provider-smoke.mjs` | 1,263 | Plan 12 | config/deadline, strict voice protocol, proof collection, and sanitized evidence finalization |
| `scripts/hosted-monitor-runner.mjs` | 1,240 | Plan 12 | pure run plan, managed execution, durable-state adapter, publication, and manifest commit |

For capability-owned entries and the three Plan 12 smoke/runner entries, the ratchet ceiling is exactly `ceil(reviewed_lines * 1.05)` and can move only downward after an owner extraction commit. A source change over the ceiling fails with its named owner and boundary; Plan 15 independent review cannot waive it. For the Plan 12 E2E entrypoint, the post-extraction ceiling is 1,200 lines and each new extracted module is capped at 600 lines.

Also budget the post-Critical `scripts/e2e-browser-audio.mjs` (owned by this lane per Task 7): it has no reviewed line count at `4d5d8276f03635ca74c04f4d500d13ce62198dd0`, so it takes a fixed 1,200-line entrypoint ceiling rather than a `reviewed_lines * 1.05` ratchet, with Plan 12 recorded as owner and "audio harness plus oversized-single-chunk negative control" as its authority boundary. Do not add a fabricated reviewed-lines baseline for it.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/module-concentration-policy.test.mjs scripts/e2e-browser-plan.test.mjs scripts/e2e-browser-runtime.test.mjs scripts/e2e-browser-story.test.mjs scripts/e2e-browser.test.mjs scripts/e2e-browser-static.test.mjs
```

Expected: FAIL because no executable concentration budget exists, the E2E responsibilities remain concentrated in one 1,855-line entrypoint, and the proposed extracted modules do not exist.

- [ ] **Step 3: Implement the executable ratchet and E2E extraction**

The policy test validates every path, reviewed count, owner, boundary, formula, and current line count. It rejects missing paths, any unbudgeted release/monitor/E2E runtime or test file above 1,200 lines, upward baseline edits, absent owner/boundary text, or a Plan 12 E2E entrypoint above 1,200. Mutation controls lower each ceiling below the current count and delete an owner field; each must fail.

Move without semantic changes:

- provider/mode/env/URL/run-plan construction and validation to `e2e-browser-plan.mjs`;
- Playwright/local-service lifecycle, explicit child environments, port retry, signal cleanup, and managed teardown to `e2e-browser-runtime.mjs`;
- page actions, required frames, D-09 classification, voice-matrix execution, and normalized evidence assembly to `e2e-browser-story.mjs`;
- leave `e2e-browser.mjs` as argument/env parsing, composition, top-level quarantine, and exit-code handling.

Do not split by line ranges. Move complete tested authority boundaries, retain public helper names where consumers depend on them, and compare the characterization result before/after each extraction commit. If a behavior changes, revert that extraction and route the behavior change to its owning earlier task.

Add exact root scripts:

```json
"module:concentration": "node --test scripts/module-concentration-policy.test.mjs"
```

Include `bun run module:concentration` in `validate` and therefore in `quality-and-audit`.

- [ ] **Step 4: Verify GREEN and owner handoffs**

Run Step 2 twice, then:

```bash
bun run module:concentration
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP VIVA_E2E_AGENT_PROVIDER=synthetic VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" VIVA_E2E_ARTIFACT_DIR=artifacts/ci/browser-voice-matrix/synthetic bun run e2e:browser
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP VIVA_E2E_AGENT_PROVIDER=fake_cartesia_gemini VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" VIVA_E2E_ARTIFACT_DIR=artifacts/ci/browser-voice-matrix/fake-provider bun run e2e:browser
```

Expected: characterization remains equivalent, E2E entrypoint/extracted-module budgets pass, and every capability-owned hotspot stays within its executable ratchet. Any over-budget capability file returns to its named Plan 07/08/09/13 owner; Plan 12 does not patch it.

- [ ] **Step 5: Commit**

```bash
git add scripts/module-concentration-policy.json scripts/module-concentration-policy.test.mjs scripts/e2e-browser-plan.mjs scripts/e2e-browser-plan.test.mjs scripts/e2e-browser-runtime.mjs scripts/e2e-browser-runtime.test.mjs scripts/e2e-browser-story.mjs scripts/e2e-browser-story.test.mjs scripts/e2e-browser.mjs scripts/e2e-browser.test.mjs scripts/e2e-browser-static.test.mjs package.json
git commit -m "refactor(e2e): extract characterized browser authorities"
```

---

### Task 17: `RELEASE-027` — Build strict required-job CI with immutable actions and Dependabot

**Acceptance aliases:** Plan 15 credits local permissions/action-pin policy through `INTEGRATION-004`, hosted required-workflow continuity through `INTEGRATION-006`, and enforced GitHub rules through `INTEGRATION-009`; this task exclusively owns `.github/workflows/validate.yml` and its policy tests.

**Files:**
- Modify: `.gitignore`
- Modify: `.github/workflows/validate.yml`
- Create: `.github/dependabot.yml`
- Create: `scripts/ci-durable-postgres.sh`
- Create: `scripts/ci-durable-postgres.test.mjs`
- Create: `scripts/ignore-policy.test.mjs`
- Modify: `scripts/validate-workflow.test.mjs`
- Modify: `package.json`

**Prerequisites before GREEN:** capability lanes merged; `DATA-001` supplies isolation-safe Postgres tests; Tasks 1 through 16 complete; `D-09` resolved.

- [ ] **Step 1: Replace regex-only workflow tests with parsed job-contract tests**

Parse YAML with the exact root `yaml` 2.8.2 dev dependency added and locked/audited in `RELEASE-024`; inspect active job/step structures rather than matching source strings. Assert:

- top-level `permissions: { contents: read }`;
- all `uses:` values are 40-character commit SHAs;
- Node 24 and Bun 1.3.3 are explicit;
- cargo-audit 0.22.0 is installed with `--locked`;
- no required Rust test sets `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1`;
- no required step uses `continue-on-error`, provider keys, production signing/session secrets, or inherited live-provider credentials;
- `.env*` files are ignored at the repository root and every nested depth while `.env.example` and `.env.*.example` templates remain visible; an already tracked non-template dotenv file fails policy;
- root `package.json` maps `agent:purity` to `scripts/check-agent-domain-purity.sh`, maps `agent:residue` to `scripts/check-legacy-domain-residue.sh`, and runs both from `validate:agent` without masking failures;
- root `package.json` exposes the exact `agent:deps:unused` and `agent:domain:mutants` commands handed off by Plan 06, while the required workflow installs nightly `2026-04-21`, cargo-udeps `0.1.60`, and cargo-mutants `25.3.1` with `--locked`, runs both commands, and has no `continue-on-error`;
- the required Plan-06 purity-policy test reads the recorded D-04 selector and allows direct `chrono`/`uuid` only for `SOFT_DELETE_UNDO`; `CONFIRM_DELETE` requires both absent, and `agent:deps:unused` runs without an allowlist under either branch;
- root `validate` runs `module:concentration`, and `quality-and-audit` executes the strict release-contract consumer tests plus the concentration ratchet on Node 24 rather than accepting their source presence;
- Postgres proof runs on PR and `main` push, not only `workflow_dispatch`;
- the durable job invokes `scripts/ci-durable-postgres.sh`, and behavioral shell tests prove that it creates only the two named CI databases, waits for Postgres, clears ambient skip authority, and propagates either Cargo command's failure;
- artifact upload runs only after release evidence and `bun run redaction:check` succeed and retains no trace/source archive;
- `required-validation` uses `if: always()` and fails unless every required upstream job result is exactly `success` (a skipped/cancelled proof cannot turn green);
- the `loopback-and-browser` job runs Plan 13's `node scripts/frontend-accessibility.mjs` and `node scripts/frontend-performance.mjs` after pinned Chromium installation and uploads only `artifacts/frontend-performance/result.json` from them on success;
- Dependabot covers `github-actions` at `/`, `npm` at `/`, and `cargo` at `/agent` on a weekly schedule.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/validate-workflow.test.mjs scripts/ci-durable-postgres.test.mjs scripts/ignore-policy.test.mjs scripts/rust-domain-quality-policy.test.mjs
```

Expected: FAIL because the current workflow has mutable actions, no explicit permissions, a monolithic job, optional Postgres, no stable aggregate required job or Dependabot config, and `.gitignore` misses general/nested `.env*` variants.

- [ ] **Step 3: Pin action commits and runtime versions**

Use exactly:

```yaml
permissions:
  contents: read

- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
- uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
  with:
    node-version: 24
- uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
  with:
    bun-version: 1.3.3
- uses: dtolnay/rust-toolchain@75be91dd2711b583df57c31d0873b4145c89f1d9 # 1.94.1
- uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
```

Pin the Postgres service too:

```yaml
image: postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5
```

Add these exact Plan 06 root scripts; Plan 06 owns the underlying purity/residue implementation and its mutation-policy test, while this task owns package/workflow wiring:

```json
"agent:purity": "scripts/check-agent-domain-purity.sh",
"agent:residue": "scripts/check-legacy-domain-residue.sh",
"agent:deps:unused": "cargo +nightly-2026-04-21 udeps --manifest-path agent/Cargo.toml --workspace --all-targets",
"agent:domain:mutants": "cargo mutants --manifest-path agent/crates/agent-domain/Cargo.toml -p agent-domain -F 'response_id|can_transition_to|restart_after_cancellation|terminate|terminal_reason|require_failure|sanitize_stage_token|sanitize_stage_metadata|is_durability|pending_answer_attempts_for_session|record_voice_session|study_session_durable_counts|answer_attempt_was_recorded|close_voice_session|active_question|record_voice_usage|record_turn_outcome|session_learning_evidence|record_challenge_resolution|select_next_question|authenticated_study_projection|restore_study_set|finalize_expired_study_set_deletions|try_new|validate_fail_closed|pcm16_base64|from_base64' --timeout 120"
```

Make `validate:agent` execute both `agent:purity` and `agent:residue`. In `quality-and-audit`, install the pinned nightly and run `cargo install cargo-udeps --version 0.1.60 --locked` plus `cargo install cargo-mutants --version 25.3.1 --locked`; run unused-dependency proof after compile/tests and focused mutants after the domain tests. Cache use may accelerate these tools but must not skip their commands or turn a non-zero result green.

- [ ] **Step 4: Split proof jobs without losing artifact continuity**

Use these stable job responsibilities:

1. `quality-and-audit`: frozen install, Node 24 script tests (including strict contract, child-environment, ignore-policy, and workflow behavior), `bun run audit`, `bun run module:concentration`, TypeScript/Rust format/clippy/unit/build/hygiene. Remove `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1` from the default `agent:test`; if a restricted local convenience command remains, name it explicitly and never call it from `validate` or CI.
2. `loopback-and-browser`: depends on quality; runs the direct WS replay, both required Playwright browser matrix commands, and the audio-harness negative control (`bun run e2e:browser:audio:negative`, per Task 7's audio-harness ownership) with real loopback permission. After pinned Chromium installation it also runs Plan 13's Task 12 Step 4 handoff commands — `node scripts/frontend-accessibility.mjs` and `node scripts/frontend-performance.mjs` — uploading only `artifacts/frontend-performance/result.json` from them on success; confirm this workflow commit to Plan 13 and the coordinator, since `FRONTEND-009` hosted enforcement stays blocked in the ledger until it exists. Then runs the fake-provider sanitized non-production `release:check` and `bun run redaction:check` in the same job so browser artifacts are not silently missing. Upload only after both release-check and redaction succeed; never upload Playwright trace/source archives or an unaudited partial directory.
3. `durable-postgres`: required on PR and main push. Invoke `scripts/ci-durable-postgres.sh`; do not duplicate orchestration in YAML. The script waits for Postgres, creates only `viva_data_test` and `viva_service_test`, clears `VIVA_ALLOW_LOOPBACK_TEST_SKIP`, and runs the DATA-001-approved data/service Postgres filters against their respective URLs. Its initial exact commands are:

   ```bash
   DATA_POSTGRES_REQUIRED=1 \
   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/viva_data_test \
     cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
   SERVICE_POSTGRES_REQUIRED=1 \
   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/viva_service_test \
     cargo test --manifest-path agent/Cargo.toml -p agent-service postgres_ -- --ignored --test-threads=1 --nocapture
   ```

   CI may substitute its explicit disposable Postgres 16 credentials/port, but not either database name or required-mode flag. Fail if either filter matches zero tests, reports an optional-database skip, omits `--ignored --test-threads=1`, or touches the other database. The data command must report execution of the `postgres_store_conformance_` focused prefix and, when the recorded D-04 branch is `SOFT_DELETE_UNDO`, the `postgres_study_set_restore_` focused prefix; under `CONFIRM_DELETE`, the restore prefix must be absent rather than skipped. The release worker owns orchestration only and must not edit the underlying Rust tests.
4. `required-validation`: stable aggregate job with `needs: [quality-and-audit, loopback-and-browser, durable-postgres]`, `if: always()`, and one shell assertion that every `needs.*.result` equals `success`.

Example aggregate:

```yaml
required-validation:
  name: Required validation
  if: always()
  needs: [quality-and-audit, loopback-and-browser, durable-postgres]
  runs-on: ubuntu-latest
  steps:
    - name: Require every proof job
      env:
        QUALITY: ${{ needs.quality-and-audit.result }}
        LOOPBACK_BROWSER: ${{ needs.loopback-and-browser.result }}
        DURABLE: ${{ needs.durable-postgres.result }}
      run: test "$QUALITY" = success && test "$LOOPBACK_BROWSER" = success && test "$DURABLE" = success
```

- [ ] **Step 5: Add Dependabot and fail-closed dotenv ignore policy**

Create weekly entries for `github-actions`, `npm`, and `cargo`, each with a unique directory and bounded open-PR limit. GitHub Actions updates preserve SHA pinning; review the new SHA and version comment together.

Replace the partial dotenv rules with:

```gitignore
**/.env*
!**/.env.example
!**/.env.*.example
```

`scripts/ignore-policy.test.mjs` invokes `git check-ignore --no-index -v --stdin` behaviorally and requires root plus nested `.env`, `.env.local`, `.env.production`, `.env.test.local`, `.envrc`, and `.env.secrets` paths to be ignored. It requires root/nested `.env.example` and `.env.production.example` to remain visible, and rejects any `git ls-files` result matching a non-template dotenv path. Missing `git`, `git check-ignore` failure, or an ambiguous rule is fatal; test fixtures use a temporary isolated path and do not create secret-looking files in the workspace.

- [ ] **Step 6: Verify locally without claiming hosted success**

```bash
node --test scripts/validate-workflow.test.mjs
node --test scripts/ci-durable-postgres.test.mjs
node --test scripts/ignore-policy.test.mjs
node --test scripts/rust-domain-quality-policy.test.mjs
node --test scripts/*.test.mjs
bun run validate
bun run agent:deps:unused
bun run agent:domain:mutants
bun run agent:replay:ws
scripts/ci-durable-postgres.sh
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP VIVA_E2E_AGENT_PROVIDER=synthetic VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" VIVA_E2E_ARTIFACT_DIR=artifacts/ci/browser-voice-matrix/synthetic bun run e2e:browser
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP VIVA_E2E_AGENT_PROVIDER=fake_cartesia_gemini VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" VIVA_E2E_ARTIFACT_DIR=artifacts/ci/browser-voice-matrix/fake-provider bun run e2e:browser
git diff --check
```

Expected: local commands pass on the combined tree. This does not prove the GitHub jobs, branch rules, Postgres service, or hosted deployments; Plan 15 owns those claims.

- [ ] **Step 7: Commit**

```bash
git add .gitignore .github/workflows/validate.yml .github/dependabot.yml scripts/ci-durable-postgres.sh scripts/ci-durable-postgres.test.mjs scripts/ignore-policy.test.mjs scripts/validate-workflow.test.mjs package.json
git commit -m "ci: require strict audit browser and durable proofs"
```

---

### Task 18: `RELEASE-031` — Execute the recorded D-06 static-export disposition in release-owned surfaces

**Decision:** `D-06 STATIC_EXPORT`

**Acceptance aliases:** Plan 14 owns canonical `PACKAGE-05` build behavior; Plan 15 credits the combined disposition through `INTEGRATION-004` and its truthful public claim through `INTEGRATION-007`. This task owns only the root/app manifest, lockfile, workflow, and release-policy half.

**Files:**
- Modify: `package.json`
- Modify: `apps/web/package.json`
- Modify: `bun.lock`
- Modify: `.github/workflows/validate.yml`
- Create: `scripts/static-release-integration.test.mjs`
- Modify: `scripts/validate-workflow.test.mjs`

**Hard gate:** Stop until the coordinator changes the single D-06 registry row's Current state to exactly `D-06B DELETE` or a value matching `^D-06A RETAIN; STATIC_CONSUMER=[A-Za-z0-9][A-Za-z0-9._/-]{0,127}; SERVER_BFF=[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`, with both retain IDs populated and distinct. Compare the Current-state cell after trimming surrounding whitespace and one pair of surrounding backticks (the ledger stores registry values backticked); a cell that remains ambiguous after that normalization is not a recorded decision. Before any GREEN edit, the selected Plan 10/11/13B changes and Plan 14B build-contract commit must be ancestors of this branch. The release worker must not infer a default from current flags, missing consumers, review recommendations, or which branch appears easier.

**Ownership lock:** Consume `scripts/package-build-contract.test.mjs` and the selected Plan 14B proof files as upstream tests. Do not edit `apps/web/next.config.ts`, `turbo.json`, `scripts/prove-turbo-cache-restoration.mjs`, `scripts/prove-static-turbo-cache-restoration.mjs`, or `scripts/static-export-browser-gate.mjs`; do not edit Plan 10/11/13 capability files. `apps/web/package.json` remains Plan-12-owned only for the exact dependencies and script-residue policy below.

- [ ] **Step 1: Verify the recorded decision and exact upstream branch before editing**

Inspect the coordinator-owned D-06 registry entry and the exact Plan 13B/14B commit records. Then run:

```bash
node --test --test-name-pattern='D-06 STATIC_EXPORT' scripts/package-build-contract.test.mjs
git log --first-parent --format='%H %s' -- docs/superpowers/plans/2026-08-23-package-build-contracts.md apps/web/next.config.ts turbo.json scripts/package-build-contract.test.mjs
```

Expected: the package contract passes for exactly the recorded branch, and the reviewed Plan 14B SHA is reachable. If the decision is still `DECISION_REQUIRED`, a retain record lacks either consumer name, the selected owner commits are absent, or the contract is mixed/red, stop. Do not repair Plan 14 behavior from this task.

- [ ] **Step 2: Write the failing manifest/lock/workflow integration tests**

Create `scripts/static-release-integration.test.mjs`. Parse both manifests as JSON and `.github/workflows/validate.yml` with exact root `yaml` 2.8.2. Determine the already-selected upstream disposition from Plan 14B's executable contract: retained has both `scripts/static-export-browser-gate.mjs` and `scripts/prove-static-turbo-cache-restoration.mjs`; deleted has neither, and the Step 1 package contract must already have passed. There is no fallback state.

Parse `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md` and require exactly one row beginning `| \`D-06\` |`. The Current state cell must equal `D-06B DELETE` or match `^D-06A RETAIN; STATIC_CONSUMER=[A-Za-z0-9][A-Za-z0-9._/-]{0,127}; SERVER_BFF=[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`; reject identical consumer IDs. Compare the Current-state cell after trimming surrounding whitespace and one pair of surrounding backticks (the ledger stores registry values backticked); a cell that remains ambiguous after that normalization exits 64. Require the registry branch to equal the Plan 14B disposition. Missing, duplicate, `DECISION_REQUIRED`, malformed, or mismatched state exits 64 before manifest/workflow assertions. The test has no default branch.

Assert these branch-neutral facts:

- root `build:cache:prove` is exactly `node scripts/prove-turbo-cache-restoration.mjs`, and active `quality-and-audit` runs it exactly once after the normal build;
- root `playwright` is exactly 1.61.0; app `happy-dom` and `@happy-dom/global-registrator` are each exactly 20.11.6; app scripts do not duplicate root static-script authority;
- `bun install --frozen-lockfile` succeeds, the `bun pm ls` output contains both the `happy-dom@20.11.6` and `@happy-dom/global-registrator@20.11.6` lines (both must appear), and the lockfile has no top-level importer or direct-dependency declaration absent from the selected manifests;
- no relevant workflow step uses `continue-on-error`, a provider secret, a production credential, or an ambient static-mode variable;
- the manifest and parsed active workflow are both retained or both deleted; a mixed state is fatal.

For Branch A, additionally assert exact root scripts:

```json
"build:static": "VIVA_STATIC_EXPORT=1 NEXT_PUBLIC_VIVA_STATIC_EXPORT=1 turbo run build --filter=@viva/web",
"e2e:static": "node scripts/static-export-browser-gate.mjs"
```

Require `loopback-and-browser` to run, in order and exactly once, `bun run build:static`, `bun run e2e:static`, and `node scripts/prove-static-turbo-cache-restoration.mjs` after Chromium installation. The build step supplies only sanitized non-routable public endpoints:

```yaml
env:
  NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: https://agent-static.invalid
  NEXT_PUBLIC_VIVA_AGENT_WS_URL: wss://agent-static.invalid/ws
  NEXT_PUBLIC_VIVA_API_URL: https://api-static.invalid
```

For Branch B, require both static root/app script keys to be absent, no active workflow command/env refers to either static build flag or either removed root script, and no lockfile package exists solely for deleted static serving. Assemble reserved-token strings from fixed fragments inside the policy test so Plan 14B's repository-wide no-hit control remains meaningful; do not add an exclusion for this test.

Add matching semantic assertions to `scripts/validate-workflow.test.mjs`; do not source-grep YAML.

- [ ] **Step 3: Verify RED**

```bash
node --test scripts/static-release-integration.test.mjs scripts/validate-workflow.test.mjs
node --test --test-name-pattern='D-06 STATIC_EXPORT' scripts/package-build-contract.test.mjs
```

Expected: the upstream package test already reflects the recorded branch, while the Plan 12 test fails because `build:cache:prove` and the selected manifest/workflow integration are absent or mixed. If the package test is RED, return to Plan 14 instead of weakening the release test.

**Branch-neutral wiring (both branches):** add the exact root script `"build:cache:prove": "node scripts/prove-turbo-cache-restoration.mjs"` to `package.json` if absent, and add exactly one `bun run build:cache:prove` step to the `quality-and-audit` job in `.github/workflows/validate.yml` immediately after the normal build step. Plan 14 assigns this wiring to Plan 12 under both D-06 branches; the reviewed baseline root manifest does not contain the script.

- [ ] **Step 4A: Branch A — retain the exact root scripts and required workflow proof**

Execute only for recorded `D-06A retain`. Preserve the exact DOM and Playwright pins from `RELEASE-024`; the static gate uses Node core plus the already-required root Playwright and introduces no static-only package. Apply the branch-neutral `build:cache:prove` wiring above, then add the exact `build:static` and `e2e:static` root scripts from Step 2. Do not add copies under `apps/web/scripts`.

The branch-neutral wiring above already runs `bun run build:cache:prove` in `quality-and-audit` after the normal build; do not add a second invocation. In `loopback-and-browser`, after pinned Chromium installation and before sanitized release-check/upload, run the three selected static commands in Step 2 with the exact non-routable public endpoint environment. The ordinary server build/browser proof remains required and separately proves the named BFF; a static artifact cannot prove proxy, nonce CSP, or API availability.

Regenerate and freeze the lock:

```bash
bun install
bun install --frozen-lockfile
bun pm ls | rg 'happy-dom@20\.11\.6|@happy-dom/global-registrator@20\.11\.6'
```

Both DOM package lines must appear in the `bun pm ls` output.

- [ ] **Step 4B: Branch B — remove every release-owned static residue**

Execute only for recorded `D-06B delete`. Add (or preserve) the exact root `build:cache:prove` script and its single quality-and-audit invocation per the branch-neutral wiring above, then delete root and app `build:static`/`e2e:static` keys, every active workflow invocation or static environment entry, and every direct dependency introduced solely for the deleted static gate. Regenerate `bun.lock` so removed direct dependencies/importers leave no orphan resolution.

Do not remove root Playwright 1.61.0 because the required ordinary `e2e:browser` consumes it. Do not remove app `happy-dom` or `@happy-dom/global-registrator` 20.11.6 because Plan 10's mounted tests consume them. No new static-only dependency is allowed on Branch A, so a clean Branch B lock should need no replacement package.

Run:

```bash
bun install
bun install --frozen-lockfile
bun pm ls | rg 'happy-dom@20\.11\.6|@happy-dom/global-registrator@20\.11\.6'
rg -n 'VIVA_STATIC_EXPORT|NEXT_PUBLIC_VIVA_STATIC_EXPORT|vivaStaticExportEnabled|staticExport' .github apps packages scripts package.json turbo.json -g '!package-build-contract.test.mjs'
```

Expected: the frozen install passes and both mounted-test DOM package lines appear in the `bun pm ls` output; the final residue `rg` scan exits 1 with no hits. Any hit, including workflow/test/package residue, is RED. The Plan-12 policy tests construct reserved names from fragments so they do not require a deletion-proof exception.

- [ ] **Step 5: Verify the selected GREEN branch behaviorally**

Run for both branches:

```bash
node --test scripts/static-release-integration.test.mjs scripts/validate-workflow.test.mjs
node --test --test-name-pattern='D-06 STATIC_EXPORT' scripts/package-build-contract.test.mjs
bun run build:cache:prove
bun --cwd apps/web run build
bun run e2e:browser
bun run validate
```

For Branch A additionally run:

```bash
bun run build:static
bun run e2e:static
node scripts/prove-static-turbo-cache-restoration.mjs
```

For Branch B rerun the Step 4B no-hit command after the normal build/browser gate. Expected: only the recorded branch passes, build outputs/cache restoration match Plan 14's contract, the normal server path remains required, and required-workflow aggregation still fails on any skipped/cancelled upstream. These are local proofs only.

- [ ] **Step 6: Commit exactly the selected release integration**

Branch A:

```bash
git add package.json apps/web/package.json bun.lock .github/workflows/validate.yml scripts/static-release-integration.test.mjs scripts/validate-workflow.test.mjs
git commit -m "ci(build): require retained static export proof"
```

Branch B:

```bash
git add package.json apps/web/package.json bun.lock .github/workflows/validate.yml scripts/static-release-integration.test.mjs scripts/validate-workflow.test.mjs
git commit -m "ci(build): remove static export integration residue"
```

The lane handoff/PR names `D-06A` or `D-06B`, the consumed Plan 13B/14B SHAs, and the exact Step 5 proof. The commit never stages Plan 10/11/13/14-owned files.

- [ ] **Step 7: Hand the selected disposition to Plan 15 without claiming external proof**

Report the Plan 12B commit SHA, selected branch, parsed workflow result, and local commands. For Branch A, Plan 15 must independently verify the recorded named static consumer and separate server BFF, exact-head required workflow, served static artifact, normal server/API browser proof, and truthful public claims. For Branch B, Plan 15 must verify the exact combined tree and public docs contain no supported-static claim or runtime/config residue. Plan 15 cannot select D-06, patch Plan 12/14 files, or credit these local commands as hosted proof.

---

## Final combined-tree verification (local only)

- [ ] Rebase onto the frozen combined capability tree; resolve without reverting other lanes.
- [ ] Confirm only intended release/monitor/CI/supply-chain files are staged.
- [ ] Run Node 24 script tests:

```bash
node --version
node --test scripts/*.test.mjs
```

- [ ] Run audit and default validation:

```bash
bun run audit
bun run module:concentration
bun run build:cache:prove
bun run validate
```

- [ ] Verify the recorded D-06 branch locally. For `D-06A`, run `bun run build:static`, `bun run e2e:static`, and `node scripts/prove-static-turbo-cache-restoration.mjs`; for `D-06B`, rerun Task 18's repository-wide no-hit command. Do not run both branches or infer one from failures.

- [ ] Run strict loopback/browser/release paths:

```bash
bun run agent:replay:ws
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP VIVA_E2E_AGENT_PROVIDER=synthetic VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" VIVA_E2E_ARTIFACT_DIR=artifacts/ci/browser-voice-matrix/synthetic bun run e2e:browser
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP VIVA_E2E_AGENT_PROVIDER=fake_cartesia_gemini VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" VIVA_E2E_ARTIFACT_DIR=artifacts/ci/browser-voice-matrix/fake-provider bun run e2e:browser
VIVA_AGENT_PROVIDER=fake_cartesia_gemini bun run release:check
```

- [ ] Run `scripts/ci-durable-postgres.sh` against disposable Postgres 16 and require both DATA-001 and SERVICE required-mode suites to execute without skip; require `postgres_store_conformance_` and conditionally selected `postgres_study_set_restore_` execution from the data suite.
- [ ] Run `bun run agent:deps:unused` and `bun run agent:domain:mutants`; require zero unused dependencies and zero missed selected mutants.
- [ ] Build and run both non-root image checks from `RELEASE-026`.
- [ ] Verify no zero-test, skip, trace, key, token, or raw-content proof entered the bundle:

```bash
rg -n "VIVA_ALLOW_LOOPBACK_TEST_SKIP=1|trace\.zip|CARTESIA_API_KEY|GEMINI_API_KEY|session_token|answer_text|transcript_final|pcm16_base64" .github package.json artifacts/release-check/evidence.json
```

Expected: no forbidden workflow/manifest/evidence occurrences; source fixtures/tests may contain negative-test strings and are not part of this artifact scan.

- [ ] Run repository hygiene:

```bash
git diff --check
git status --short
```

- [ ] Obtain independent review focused on: exact run/deploy binding, production HMAC downgrade, partial/SIGTERM evidence, process-tree cleanup, hostile child environments, strict raw-contract validation/sanitization, Node 24 S3 deadlines, dotenv ignore behavior, audit completeness, executable concentration budgets/owner handoffs, selected D-06 manifest/lock/workflow completeness, Docker privilege/digest controls, and required-job skipped/cancelled behavior.
- [ ] Commit review fixes in scoped follow-up commits and rerun the affected RED/GREEN plus final commands.

## Plan 15 hosted acceptance handoff (external; no evidence credited here)

Plan 15 must re-derive and record all of the following from the exact merged SHA. This plan must not pre-fill or claim any item:

1. GitHub `Required validation` is green on the exact head; all three upstream jobs are `success`, not skipped/cancelled.
2. Default-branch protection/rulesets require that stable job for contributors and administrators, with any break-glass path documented.
3. The PR hosted-monitor manifest uses the exact `VIVA_RELEASE_RUN_ID`, exact web/agent deploy IDs, exact deploy SHA, `sanitized: true`, and the required scenario results.
4. Two separately identified hosted failure-control/synthetic runs exercise the stable monitor state object across fresh run directories, record its object version/ETag transition, advance the canonical consecutive count from one to two, and activate the BAC-527 rollback decision without calling a paid provider. If the hosted store/run cannot be authorized, record blocked rather than substituting the local state test.
5. Any authorized live-provider smoke is separately opt-in, budget reserved/capped, secret-minimized, exact-run/deploy bound, sanitized, and generated after the capability lanes. Absence of authorized credentials remains “not proven,” never green.
6. The stored production bundle is fetched from its downstream location into `artifacts/downloaded-release/evidence.json` and verified with `bun run release:verify -- artifacts/downloaded-release/evidence.json` in an environment holding `VIVA_RELEASE_BUNDLE_SIGNING_SECRET`; self-signed or locally generated evidence cannot satisfy this gate.
7. Deployed containers report non-root runtime identities, match the bundle's exact agent/monitor output-image digests, and retain the separately recorded base-image/Bun-checksum build inputs; a base digest is not accepted as deployed provenance.
8. The combined tree exposes `@viva/core/runtime-validation`, contains no raw learner-loop import anywhere under `scripts/` outside the sanitized adapter, passes hostile unknown-field/bypass tests, passes `scripts/ignore-policy.test.mjs`, and passes `bun run module:concentration` with any capability extraction supplied by the recorded Plan 07/08/09/13 owner commit rather than a Plan 15 patch.
9. D-06 matches its recorded branch across the exact Plan 10/11/13B/14B/12B commits. For `D-06A`, record the named static consumer and separate server BFF, require the exact-head `build:static`/`e2e:static` workflow proof plus normal server/API proof, and publish only that split topology. For `D-06B`, verify root/app manifests, lockfile, workflow, runtime/config, tests, and public docs contain no supported-static residue or claim. Plan 15 may verify but not select or repair the branch.
10. No release decision is made from local checks, workflow YAML tests, artifact counters, `/ready`, or this implementation plan alone.
11. Hosted termination evidence for the EXTERNAL_EVIDENCE alias "Reliability A1/T5 — SIGTERM during each live pipeline stage" (credited through `RELEASE-015`) must be recorded by Plan 15 from actual hosted runs (task cancellation and clean exit before SIGKILL at each stage) or marked `BLOCKED_EXTERNAL` with owner/reason; this plan's local Task 2/7 SIGTERM proofs do not satisfy it.
