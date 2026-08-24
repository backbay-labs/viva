# Viva Integrated Evidence and Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate remediation plans 03–14 into one immutable candidate, prove that candidate through mandatory local, combined-tree, browser/WebSocket/release, dependency, and disposable-Postgres gates, reconcile public contracts to shipped behavior, and distinguish code completion from externally proven release readiness.

**Architecture:** This coordinator phase on `review-remediation/integration` is the only final evidence, workflow-acceptance, and public-documentation owner; it is not a thirteenth remediation lane, and Plan 12 remains the sole workflow implementation owner. Program Task 5 integrates the exact source commits from the twelve remediation lanes as sixteen ordered nodes. Plan 15 verifies those already-merged PR heads and integration commits, records them in a machine-validated manifest, commits only integration-owned evidence tooling and truthful docs, freezes one SHA, and invalidates all evidence whenever that SHA changes. It never independently re-merges a lane. Repository-local Levels 1–3 are mandatory; GitHub, Railway, live-provider, real-device, assistive-technology, and release-owner checks are external gates that remain `BLOCKED_EXTERNAL` until exact-SHA evidence exists.

**Tech Stack:** Git and GitHub CLI, Bun 1.3.3, Node.js 24, Turbo, TypeScript 5.9, React/Next.js 16, Rust 1.94.1, Cargo, Playwright, PostgreSQL 16, Docker, Railway, JSON/Markdown evidence, SHA-256 and HMAC-SHA-256.

**Spec:** Coordinator sources: `docs/superpowers/plans/2026-08-23-review-remediation-swarm-program.md` and `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`. Review sources: `docs/superpowers/reviews/index.md`, `2026-08-23-project-state.md`, `2026-08-23-comprehensive-review-summary.md`, `2026-08-23-architecture-review.md`, `2026-08-23-correctness-review.md`, `2026-08-23-security-review.md`, `2026-08-23-reliability-and-performance-review.md`, `2026-08-23-quality-and-tests-review.md`, `2026-08-23-frontend-review.md`, `2026-08-23-architecture-consistency.md`, `2026-08-23-packages-shared.md`, `2026-08-23-rust-agent-adapters.md`, `2026-08-23-rust-agent-domain.md`, `2026-08-23-rust-agent-service.md`, `2026-08-23-rust-data-observe.md`, `2026-08-23-scripts-e2e-monitoring.md`, `2026-08-23-scripts-release-gates.md`, `2026-08-23-security.md`, `2026-08-23-web-api-proxy.md`, `2026-08-23-web-session-client.md`, and `2026-08-23-web-ui.md`, all under `docs/superpowers/reviews/`. Plan sources are the exact Plan 03–14 files listed below.

---

## Global Constraints

The state observed on 2026-08-23 is a seed for the execution-time refresh, not current evidence:

- reviewed `main`: `4d5d8276f03635ca74c04f4d500d13ce62198dd0`;
- latest reviewed Validate run: `31401218406`, failed on that exact SHA;
- `main`: not protected;
- repository rulesets: empty;
- real Cartesia/Gemini, Railway, durable Postgres, real microphone, non-Chromium, and screen-reader behavior: not proven.

Execution must refresh every item. It must not copy these facts forward as if they were still current.

The top-level `terminal_status` field is forbidden until Levels 1–3, public-contract regeneration, ledger/PR reconciliation, and independent review all pass on the same frozen SHA. Once those mandatory gates pass, only these three values may appear:

| Status | Exact meaning |
| --- | --- |
| `CODE_REMEDIATION_COMPLETE` | Mandatory Levels 1–3/docs/ledger/review all pass, but the required external set qualifies for neither `RELEASE_READY` nor clean external-pending status—normally because at least one external gate ran and `FAIL`ed. Code remediation is complete, external acceptance is not, and the remediation loop remains open. This is not a release claim. |
| `CODE_COMPLETE_EXTERNAL_GATES_PENDING` | Mandatory Levels 1–3/docs/ledger/review all pass; no required external gate is `FAIL`; and at least one required Level 4/5 gate is `BLOCKED_EXTERNAL` or has not run for a fully recorded external reason. A not-yet-run external gate is serialized as `BLOCKED_EXTERNAL` with the full skip-reason object, not as an unqualified omission. This is not a release claim. |
| `RELEASE_READY` | The same frozen SHA passes Levels 1–3 and every `OPS-01` through `OPS-06` gate, the stored production bundle is independently verified, deployed web/agent/monitor identities bind to that SHA and run ID, and the release owner records `proceed`. |

If any mandatory gate is absent, active, blocked, or `FAIL`, integration remains active and the JSON must omit `terminal_status`; the Markdown must say that no terminal status was emitted. `BLOCKED_EXTERNAL` is legal only for `OPS-01` through `OPS-06`; a missing executable, absent Postgres, skipped test, cache-only result, or local test failure is mandatory `FAIL`, not an external block. Once mandatory proof passes, any external state outside all-PASS or clean fully reasoned pending maps to `CODE_REMEDIATION_COMPLETE` and keeps the external remediation/retest loop open.

This plan deliberately treats all six OPS gates as required for `RELEASE_READY` regardless of release scope. It is a conscious tightening of Program Section 8's "required for the selected release scope" language, and relaxing it requires a Program amendment recorded by the coordinator.

Decision gates: Task 7 Step 4's `docs/data-governance.md` retention/deletion wording is blocked until the coordinator records `D-05`; its disclosure wording and the Task 4 disclosure/browser-story acceptance are blocked until `D-08`; Task 4's required-product-frame versus non-certifying structured-preview treatment (the `required product frame replaced by harness-authored HTML` control) follows the recorded `D-09` branch. No Plan 15 step may author a value reserved for those decisions.

## Inputs: plans 03–14

The integration manifest must contain exactly sixteen Program integration nodes across twelve lane namespaces. `04A`/`04B`, `12A`/`12B`, `13A`/`13B`, and `14A`/`14B` are distinct PR/source/merge commits from the same lane branch; they are not extra branches and Plan 15 must never merge either phase itself.

| Rank | Node ID | Namespace | Branch | Required plan | Required predecessors and scope |
| ---: | --- | --- | --- | --- | --- |
| 0 | `03` | `CRIT` | `review-remediation/03-critical-path` | `docs/superpowers/plans/2026-08-23-expedited-critical-path.md` | First remediation merge. |
| 1 | `04A` | `LEARN` | `review-remediation/04-learning-core` | `docs/superpowers/plans/2026-08-23-learning-core-authority.md` | After `03`; additive Plan-04-owned learning types only. |
| 1 | `05` | `VOICE` | `review-remediation/05-voice-contract` | `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md` | After `03`. |
| 1 | `12A` | `RELEASE` | `review-remediation/12-release-ci` | `docs/superpowers/plans/2026-08-23-release-monitor-ci-supply-chain.md` | After `03`; the additive `RELEASE-024` manifest/lock commits only — the pinned `happy-dom@20.11.6`/`@happy-dom/global-registrator@20.11.6` app handoff, the root `yaml@2.8.2` plus `@viva/core: workspace:*`/`build:cache:prove` root-manifest commit, and the lockfile regeneration for Plan 13's Task 1/2 manifest handoff. |
| 2 | `13A` | `FRONTEND` | `review-remediation/13-frontend` | `docs/superpowers/plans/2026-08-23-frontend-accessibility-performance.md` | After `03` and `12A`; consumes the `happy-dom`/global-registrator manifest-and-lock handoff for mounted global-error tests, then lands additive canvas/tokens/UI handoffs before `10`; when `D-07B` is selected, includes the frontend bootstrap-removal prerequisite that must precede `11`. |
| 2 | `06` | `DOMAIN` | `review-remediation/06-domain-integrity` | `docs/superpowers/plans/2026-08-23-rust-domain-integrity.md` | After `03`, `04A`, and `12A` (consumes the `12A` root `yaml@2.8.2` dev-dependency commit for its workflow/domain policy-test RED). |
| 3 | `04B` | `LEARN` | `review-remediation/04-learning-core` | `docs/superpowers/plans/2026-08-23-learning-core-authority.md` | After `06`; executor and complete learning authority. |
| 4 | `14A` | `PACKAGE` | `review-remediation/14-package-build` | `docs/superpowers/plans/2026-08-23-package-build-contracts.md` | After `03` and `04B`; additive fixture/package exports without old-surface removal — its `runtime-validation`/study-projection root re-exports require Plan 04's `LEARN-008` module and `LEARN-006A` export on integration. |
| 4 | `07` | `ADAPTER` | `review-remediation/07-live-adapters` | `docs/superpowers/plans/2026-08-23-live-provider-adapters.md` | After `04B`, `05`, `06`. |
| 4 | `09` | `DATA` | `review-remediation/09-data-privacy` | `docs/superpowers/plans/2026-08-23-persistence-postgres-privacy.md` | After `04B`, `06`. |
| 5 | `08` | `SERVICE` | `review-remediation/08-service-runtime` | `docs/superpowers/plans/2026-08-23-agent-service-runtime.md` | After `04B`, `05`, `06`, `09`; consumes the final Plan 09 PDF and selected `D-04` durable ports. |
| 6 | `11` | `WEBAPI` | `review-remediation/11-web-api-security` | `docs/superpowers/plans/2026-08-23-web-api-security.md` | Directly after `05`, `08`, and `14A`; also directly after `13A` when `D-07B` is selected. `04B`, `06`, and `09` are already ancestors through `08`. |
| 7 | `10` | `WEBSESSION` | `review-remediation/10-web-session` | `docs/superpowers/plans/2026-08-23-web-session-audio.md` | Directly after `04B`, `05`, `08`, `11`, `12A`, `13A`, and `14A`; `09` is already an ancestor through `08`. |
| 8 | `13B` | `FRONTEND` | `review-remediation/13-frontend` | `docs/superpowers/plans/2026-08-23-frontend-accessibility-performance.md` | After `10` and `11`; final deletion, selected `D-06`, accessibility, mounted UI, and performance gates. |
| 9 | `14B` | `PACKAGE` | `review-remediation/14-package-build` | `docs/superpowers/plans/2026-08-23-package-build-contracts.md` | Directly after `13B` and its additive predecessor `14A`; `10` and `11` are already ancestors through `13B`. Removes the old package surface and lands selected `D-06`/build contract. |
| 10 | `12B` | `RELEASE` | `review-remediation/12-release-ci` | `docs/superpowers/plans/2026-08-23-release-monitor-ci-supply-chain.md` | Final lane merge after `07`, `08`, `09`, `10`, `11`, `13B`, `14B`; final release/workflow integration. |

No source lane may mark its own row complete in `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`. Plan 15 and the integration coordinator are its only writers. This coordinator phase validates source handoffs and applies reconciliation changes only after inspecting exact commits and proof.

## File ownership locked before execution

**This integration coordinator phase owns:**

- Create: `scripts/integration-readiness.mjs`
- Create: `scripts/integration-readiness.test.mjs`
- Create: `scripts/public-contract.mjs`
- Create: `scripts/public-contract.test.mjs`
- Create: `docs/release-readiness.md`
- Create: `docs/public-contract.json`
- Modify: `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `SECURITY.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `agent/README.md`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `docs/learner-loop-contract.md`
- Modify: `docs/data-governance.md`
- Modify: `docs/deployment-runbook.md`
- Regenerate when implementation changed topology or public flow: `docs/assets/architecture.svg`, `docs/assets/architecture-mobile.svg`, `docs/assets/lifecycle.svg`, `docs/assets/lifecycle-mobile.svg`, `docs/assets/loop.svg`, `docs/assets/loop-mobile.svg`

**This coordinator phase does not own production hotspots from plans 03–14.** In particular it must not independently change `apps/web/**`, `packages/**`, `agent/crates/**`, `agent/migrations/**`, `Dockerfile.monitor`, `agent/Dockerfile`, `.github/workflows/validate.yml`, `scripts/validate-workflow.test.mjs`, `scripts/deployment-runbook.test.mjs`, `scripts/release-check.mjs`, `scripts/production-release-gate.mjs`, `scripts/release-evidence-imports.mjs`, `scripts/hosted-monitor-runner.mjs`, `scripts/live-provider-smoke.mjs`, `scripts/e2e-browser.mjs`, or their lane-owned tests. Plan 12 is the sole workflow/release/monitor/E2E-script owner. If combined-tree proof or final docs expose a defect in one of those files, route the fix to the owning lane, merge its new commit, compute a new frozen SHA, and rerun all invalidated gates.

## Evidence ladder

| Level | Mandatory proof | Skip policy |
| --- | --- | --- |
| Level 1 — lane and ledger proof | Exact input commit for every plan 03–14; RED/GREEN/adversarial evidence for every canonical finding; 128/128 component-instance reconciliation; every recorded decision resolved in code/docs. | No skip. Missing evidence is `FAIL`. |
| Level 2 — frozen combined-tree proof | Clean worktree; forced TypeScript graph; script tests; Rust fmt/clippy/workspace/all-target tests/build; direct real-loopback WS replay; production-shaped 2 s/10 s/45 s voice transport at 44.1/48 kHz; synthetic and fake-provider browser stories; release evidence generation and separate stored-bundle verification; redaction; dependency audits; shell/identity/signature/timeout/orphan/mutation controls. | No skip. Cache-only results and permission-denied early returns are `FAIL`. |
| Level 3 — disposable durable proof | Fresh PostgreSQL 16; migrations from empty database; migration replay; complete required Postgres data/service suite twice in two fresh databases; application restart; two store/service instances; atomic replay/concurrency; deletion and non-resurrection; row/schema privacy canaries. | No skip. Missing Docker/Postgres/client tooling is `FAIL`. |
| External — `OPS-01` through `OPS-06` | Hosted exact-SHA GitHub checks, enforced rules, exact-deploy Railway proof, live provider/ZDR proof, real microphone/cross-browser/screen-reader proof, and release-owner decision. | Unavailable prerequisites are `BLOCKED_EXTERNAL` with the full skip-reason object. Never infer `PASS`. |

The human/operations register is fixed:

| ID | Accountable human/role | Required action and evidence |
| --- | --- | --- |
| `OPS-01` | GitHub billing/account owner | Clear Actions billing or minutes restrictions and authorize the exact-SHA Validate run; capture the successful run and artifact identities. |
| `OPS-02` | GitHub repository administrator | Enable and verify protected-branch/ruleset enforcement for the stable `Required validation` context, including administrators or an audited break-glass path. |
| `OPS-03` | Railway project owner/operator | Provision/access the project, deploy web/agent/monitor from the exact SHA, and capture deployment IDs, output-image digests distinct from pinned build inputs, origins, in-band SHAs, restart/drain/rollback, and durable object identity. |
| `OPS-04` | Provider security/billing owner | Attest provider secrets at their consuming services, ZDR status, quota, model identity, and cost authorization; run one sanitized exact-deploy live proof. |
| `OPS-05` | Device/accessibility operator | Execute and record the real microphone, cross-browser, VoiceOver/NVDA, keyboard, zoom, forced-colors, and reduced-motion matrix. |
| `OPS-06` | Named release owner | Review the exact post-merge bundle and record the final `proceed` decision or remain `BLOCKED_EXTERNAL`. |

## Normative execution order and freeze barrier

The numbered sections define ownership and proof contracts; this dependency order is mandatory where a section contains both tracked implementation and ignored execution evidence:

1. complete Task 1;
2. complete Task 2 Steps 1–5, verifying the sixteen Program-integrated nodes without merging, cherry-picking, or rebasing a lane;
3. complete and commit every tracked implementation change from Tasks 3–7 and Task 10 Steps 1–4;
4. run Task 2 Steps 6–7 and record the first `FROZEN_SHA`/`RUN_ID` only after the worktree is clean;
5. execute Task 6 Steps 4–5, Task 3 Step 5, Task 4's frozen commands, Task 5 Steps 5–8, and Task 7 Step 7 on that exact SHA;
6. execute Task 8. Any review fix supersedes the run, returns through its owning lane, regenerates affected public contracts, and repeats Steps 2–5 with a new SHA/run ID;
7. only after independent closure execute Task 9 and Task 10 Steps 5–8.

No pre-freeze command result is Level 1, 2, or 3 evidence. No tracked file may change between the final freeze and the final classifier. This barrier resolves the apparent numeric ordering: proof implementation is prepared before freeze; proof execution and status emission happen after it.

---

### Task 1: `INTEGRATION-001` — Define the Integration Evidence Contract and Terminal Classifier

**Files:**
- Create: `scripts/integration-readiness.mjs`
- Create: `scripts/integration-readiness.test.mjs`

- [ ] **Step 1: Write the failing schema and classifier tests**

Create `scripts/integration-readiness.test.mjs` with table-driven tests importing:

```js
import {
  BLOCKED_EXTERNAL_REASON_CODES,
  EXTERNAL_GATE_IDS,
  INTEGRATION_EVIDENCE_SCHEMA,
  MAIN_RECONCILIATION_SCHEMA,
  TERMINAL_STATUSES,
  assertFrozenIdentity,
  deriveTerminalStatus,
  renderIntegrationMarkdown,
  validateIntegrationEvidence,
  validateMainReconciliation,
} from "./integration-readiness.mjs";
```

The tests must establish these exact constants:

```js
assert.equal(INTEGRATION_EVIDENCE_SCHEMA, "viva.integration_readiness.v1");
assert.equal(MAIN_RECONCILIATION_SCHEMA, "viva.main_reconciliation.v1");
assert.deepEqual(TERMINAL_STATUSES, [
  "CODE_REMEDIATION_COMPLETE",
  "CODE_COMPLETE_EXTERNAL_GATES_PENDING",
  "RELEASE_READY",
]);
assert.deepEqual(EXTERNAL_GATE_IDS, ["OPS-01", "OPS-02", "OPS-03", "OPS-04", "OPS-05", "OPS-06"]);
assert.deepEqual(BLOCKED_EXTERNAL_REASON_CODES, [
  "GITHUB_ACTIONS_BILLING_UNAVAILABLE",
  "GITHUB_RULE_ADMIN_ACCESS_REQUIRED",
  "RAILWAY_PROJECT_OR_DEPLOYMENT_UNAVAILABLE",
  "PROVIDER_ZDR_OR_SECRET_UNAVAILABLE",
  "DEVICE_BROWSER_OR_SCREENREADER_UNAVAILABLE",
  "RELEASE_OWNER_DECISION_UNAVAILABLE",
]);
```

Add one test per decision row:

| Levels 1–3 + docs/ledger/review | External gates | Expected result |
| --- | --- | --- |
| at least one non-pass | any | return `undefined`; omit `terminal_status` |
| all pass | all six `PASS` | `RELEASE_READY` |
| all pass | none `FAIL`, at least one fully reasoned `BLOCKED_EXTERNAL` | `CODE_COMPLETE_EXTERNAL_GATES_PENDING` |
| all pass | every other external state, including at least one `FAIL` | `CODE_REMEDIATION_COMPLETE` |

External `FAIL` has precedence over `BLOCKED_EXTERNAL`: if one gate failed and another is blocked, derive `CODE_REMEDIATION_COMPLETE`. A not-yet-run required external check qualifies for pending status only after it is recorded as `BLOCKED_EXTERNAL` with the complete external reason object. Before classification, the finalizer must materialize any omitted or unreasoned required external gate as a named external `FAIL` record; it must not silently coerce it to `BLOCKED_EXTERNAL`. The resulting terminal status is `CODE_REMEDIATION_COMPLETE`, and the loop remains open.

Test that presence of `terminal_status` while a mandatory gate is non-PASS fails validation; a mandatory gate cannot use `BLOCKED_EXTERNAL`; a `PASS` external gate cannot carry `skip_reason`; an external `FAIL` cannot carry `skip_reason` and must name its executed evidence/reproduction; a `BLOCKED_EXTERNAL` gate must carry every skip-reason field, including the attempted command/URL and last observed external state; every identity SHA must be 40 lowercase hexadecimal characters; `live_main_sha_at_freeze` must be an ancestor of `frozen_sha`; all command and artifact records must bind to `identity.frozen_sha`; `RELEASE_READY` must include owner decision `proceed`; and Markdown rendering is deterministic.

Add main-reconciliation tests for all three legal states: `NOT_REQUIRED` proves live main is already ancestral and has empty delta/review fields; `REVIEW_REQUIRED` has exact main-only commits/paths and null approval/merge fields; `RECONCILED` requires Program-coordinator, every affected-owner, and independent approvals, a reconciliation merge containing the exact live-main SHA, all focused gates PASS, and the post-reconciliation tip. Reject a reconciliation authored/merged by Plan 15, an unreviewed conflict resolution, an unowned path, or a second merge of any recorded lane PR head.

Add Program-input tests for the exact sixteen-node set and predecessor matrix. Reject one combined `04`, `12`, `13`, or `14` record; equal A/B PR heads or merge commits; `13A` without `12A` as a predecessor; `13A` after `10`; `08` without `09` as a predecessor or merged before `09`; `10` without direct predecessors `04B`, `05`, `08`, `11`, `12A`, `13A`, and `14A`; selected `D-07B` without `13A` before `11`; `13B` before either `10` or `11`; `14B` before `14A` or `13B`; `12B` before any required capability node; owner-scope leakage; a merge SHA occurring twice or not on first-parent history; and any seventeenth Plan 03–14 lane PR merged into the integration branch.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
node --test scripts/integration-readiness.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/integration-readiness.mjs`.

- [ ] **Step 3: Implement the exact JSON schema validator**

Create `scripts/integration-readiness.mjs`. Export the constants above and validate this top-level shape without coercion:

```json
{
  "schema": "viva.integration_readiness.v1",
  "run_id": "20260823T180000Z-0123456789ab",
  "generated_at": "2026-08-23T18:00:00.000Z",
  "identity": {
    "repository": "backbay-labs/viva",
    "branch": "review-remediation/integration",
    "audit_base_sha": "4d5d8276f03635ca74c04f4d500d13ce62198dd0",
    "live_main_sha_at_start": "4d5d8276f03635ca74c04f4d500d13ce62198dd0",
    "live_main_sha_at_freeze": "4d5d8276f03635ca74c04f4d500d13ce62198dd0",
    "frozen_sha": "0123456789abcdef0123456789abcdef01234567",
    "worktree_clean": true,
    "frozen_at": "2026-08-23T18:00:00.000Z"
  },
  "lane_inputs": [],
  "main_reconciliation": {
    "status": "NOT_REQUIRED",
    "live_main_sha": "4d5d8276f03635ca74c04f4d500d13ce62198dd0",
    "reconciliation_merge_sha": null,
    "artifact": null
  },
  "program_reconciliations": [],
  "coverage": {
    "component_finding_instances_expected": 128,
    "component_finding_instances_reconciled": 128,
    "unresolved_rows": [],
    "ledger_sha256": "64 lowercase hex characters"
  },
  "levels": {
    "level_1": { "status": "PASS", "commands": [], "artifacts": [] },
    "level_2": { "status": "FAIL", "commands": [], "artifacts": [] },
    "level_3": { "status": "FAIL", "commands": [], "artifacts": [] }
  },
  "docs_contract": { "status": "FAIL", "artifacts": [] },
  "independent_review": { "status": "FAIL", "findings": [], "artifact": null },
  "external_gates": [],
  "deploy_binding": null,
  "release_owner": null,
  "supersedes_run_id": null,
  "sanitized": true
}
```

This example is an active mandatory-evidence run, so `terminal_status` is deliberately absent. `main_reconciliation.status` is exactly `NOT_REQUIRED` or `RECONCILED`; `REVIEW_REQUIRED` cannot pass Level 1 or enter a terminal document. While any mandatory gate is non-PASS, `external_gates` may be empty or partial and cannot affect classification. Once every mandatory gate passes, require exactly `OPS-01`–`OPS-06`; each must be `PASS`, `FAIL`, or `BLOCKED_EXTERNAL`, and only then add the derived `terminal_status`.

Each `lane_inputs` entry must contain `node_id`, `topological_rank`, `namespace`, `split_phase`, `plan_path`, `branch`, `pr_number`, `pr_url`, `pr_commit_shas`, `pr_head_sha`, `integration_merge_sha`, `merge_parent_shas`, `predecessor_node_ids`, `decision_branch`, `included_in_frozen_sha`, `finding_ids`, `proof_artifacts`, and `owner_acknowledged_handoff`. Require exactly the sixteen node IDs above and exactly twelve unique namespaces. Reject duplicate node IDs, PRs, PR-head SHAs, integration-merge SHAs, finding IDs, or proof paths; repeated namespace/branch/plan values are required only for the four A/B lane pairs. Every `pr_commit_shas` list is non-empty, unique, in PR order, ends in `pr_head_sha`, and names only commits reachable from that head. `split_phase` is `"A"` or `"B"` for those eight entries and `null` otherwise. `decision_branch` records the selected decisions relevant to that node, including `D-07B` on `13A`/`11` when selected and `D-06A` or `D-06B` on `13B`/`14B`.

`program_reconciliations` is empty on the first clean Program tip. A later independent-review fix adds one entry per Program-coordinator reconciliation commit with exact fields `source_owner_namespace`, `source_commit_sha`, `source_review_pr`, `source_diff_sha256`, `coordinator_commit_sha`, `coordinator_diff_sha256`, `changed_paths`, `affected_node_ids`, `affected_finding_ids`, `owner_approval`, `independent_review_approval`, `focused_gates`, and `included_in_frozen_sha`. Reject a missing approval, non-PASS focused gate, unequal source/coordinator diff hashes, coordinator commit not ancestral to `frozen_sha`, changed path outside the named owner, duplicate coordinator commit, second lane merge, or a new node ID. The owner source commit may remain on its review branch; only its reviewed diff and the coordinator reconciliation commit are included in the candidate. These records preserve the sixteen-node Program manifest rather than disguising corrective history as a seventeenth integration node.

Each command record must contain:

```json
{
  "id": "forced_ts_graph",
  "argv": ["bunx", "turbo", "run", "typecheck", "lint", "test", "build", "--force"],
  "cwd": ".",
  "started_at": "2026-08-23T18:00:00.000Z",
  "finished_at": "2026-08-23T18:05:00.000Z",
  "duration_ms": 300000,
  "exit_code": 0,
  "status": "PASS",
  "frozen_sha": "0123456789abcdef0123456789abcdef01234567",
  "stdout_sha256": "64 lowercase hex characters",
  "stderr_sha256": "64 lowercase hex characters",
  "cache_mode": "forced"
}
```

Each artifact record must contain this exact shape. `path` must be repository-relative, under ignored `artifacts/`, and resolve without `..` or symlink escape:

```json
{
  "id": "level_2_release_bundle",
  "path": "artifacts/integration-readiness/20260823T180000Z-0123456789ab/level-2/release-check/evidence.json",
  "media_type": "application/json",
  "sha256": "64 lowercase hex characters",
  "bytes": 12345,
  "created_at": "2026-08-23T18:05:00.000Z",
  "frozen_sha": "0123456789abcdef0123456789abcdef01234567",
  "run_id": "20260823T180000Z-0123456789ab",
  "sanitized": true,
  "forbidden_hits": 0
}
```

Each `BLOCKED_EXTERNAL` record must contain this exact object; `blocked_at` and `next_check_at` must parse as UTC timestamps and `applies_to_frozen_sha` must match the frozen SHA:

```json
{
  "id": "OPS-03",
  "status": "BLOCKED_EXTERNAL",
  "skip_reason": {
    "code": "RAILWAY_PROJECT_OR_DEPLOYMENT_UNAVAILABLE",
    "owner": "release-operations",
    "blocked_at": "2026-08-23T18:00:00.000Z",
    "attempted": "exact command or URL attempted, for example the exact Railway deploy command or project URL",
    "last_observed_state": "exact last externally observed state, for example project access denied",
    "required_action": "Provision or grant access to the Viva Railway project and deploy web, agent, and monitor from the frozen SHA.",
    "required_evidence": "Railway deployment IDs, deployed output-image digests distinct from pinned build inputs, service origins, two durable monitor state transitions, monitor run IDs, and in-band deploy_sha values all bound to the frozen SHA.",
    "next_check_at": "2026-08-24T18:00:00.000Z",
    "applies_to_frozen_sha": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

The Markdown renderer must generate this exact heading order and field grammar from the validated JSON; hand-edited Markdown is rejected:

```markdown
# Viva Release Readiness Evidence

- Schema: `viva.integration_readiness.v1`
- Run ID: `20260823T180000Z-0123456789ab`
- Frozen SHA: `0123456789abcdef0123456789abcdef01234567`
- Generated at: `2026-08-23T18:00:00.000Z`
- Integration state: `ACTIVE_MANDATORY_EVIDENCE_INCOMPLETE`
- Terminal status emitted: `false`
- Sanitized: `true`

## Identity
## Lane reconciliation
## Mandatory evidence
### Level 1
### Level 2
### Level 3
## Public contract
## Independent review
## External gates
## Deploy/run binding
## Release decision
## Superseded evidence
```

For a mandatory-complete run, replace the two active-state lines with exactly `- Terminal status: CODE_REMEDIATION_COMPLETE`, `- Terminal status: CODE_COMPLETE_EXTERNAL_GATES_PENDING`, or `- Terminal status: RELEASE_READY`. `ACTIVE_MANDATORY_EVIDENCE_INCOMPLETE` is a Markdown-only progress label and must never enter the JSON `terminal_status` field. Every level and external-gate section renders a fixed `ID | Status | Frozen SHA | Artifact SHA-256 | Owner | Reason code` table. Missing values render `null`, never a friendly omission. The renderer must never render environment values whose key contains `KEY`, `TOKEN`, `SECRET`, `BEARER`, `PASSWORD`, `AUDIO`, `TRANSCRIPT`, `ANSWER`, `PROMPT`, or `SOURCE_CONTEXT`.

Implement the `capture-program-input`, `verify-program-dag`, `bind-program-inputs`, `main-reconciliation-not-required`, `main-reconciliation-request`, and `record-handoff` CLIs used in Tasks 2 and 6 as deterministic evidence operations. Capture and DAG verification read Git/GitHub artifacts already supplied as paths; binding adds only the final frozen SHA and renders JSON/Markdown. None invokes Git merge/cherry-pick/rebase or mutates a PR. The main commands write only `NOT_REQUIRED` or `REVIEW_REQUIRED`; they never mark a review approved or upgrade the document to `RECONCILED`. `record-handoff` reads `--namespace`, a comma-separated `--files` list, `--frozen-sha`, and `--output`; hashes each named tracked file at the frozen SHA; resolves the namespace's A/B node records from the bound lane inputs; writes the handoff JSON described in Task 6 Step 5; and mutates nothing.

- [ ] **Step 4: Run unit, negative, and determinism controls**

Run:

```bash
node --test scripts/integration-readiness.test.mjs
```

Expected: PASS. The negative controls must demonstrate that changing the frozen SHA; emitting any terminal status while a mandatory gate is non-PASS; passing a raw final document with one OPS gate omitted; downgrading a mandatory gate to `BLOCKED_EXTERNAL`; adding an incomplete external reason; or setting `RELEASE_READY` without `proceed` fails validation. Positive controls must prove that the finalizer materializes an omitted/unreasoned external gate as `FAIL`, that mandatory PASS plus any external `FAIL` emits `CODE_REMEDIATION_COMPLETE`, and that neither case closes the remediation loop.

- [ ] **Step 5: Commit the evidence contract**

```bash
git add scripts/integration-readiness.mjs scripts/integration-readiness.test.mjs
git commit -m "test: define integrated release evidence contract"
```

---

### Task 2: `INTEGRATION-002` — Verify Program Integration Inputs and Freeze the Candidate Without Re-merging Lanes

**Files:**
- Create at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/lane-inputs.json`
- Create at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/merge-ledger.md`
- Create if current main diverged, ignored: `artifacts/integration-readiness/main-reconciliation-${LIVE_MAIN_SHA}.json`
- Read only: `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`

- [ ] **Step 1: Refresh local, remote, GitHub, workflow, PR, protection, and ruleset state**

Run from a clean integration worktree:

```bash
set -euo pipefail
git fetch origin main --prune
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
AUDIT_BASE_SHA="4d5d8276f03635ca74c04f4d500d13ce62198dd0"
LIVE_MAIN_SHA="$(git rev-parse origin/main)"
REMOTE_SHA="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
PREFREEZE_DIR="artifacts/integration-readiness/pre-freeze"
mkdir -p "$PREFREEZE_DIR"
test "$LIVE_MAIN_SHA" = "$REMOTE_SHA"
git cat-file -e "$AUDIT_BASE_SHA^{commit}"
git status --porcelain=v1
gh run list --workflow Validate --branch main --limit 20 --json databaseId,headSha,status,conclusion,createdAt,updatedAt,url
gh pr list --state all --limit 100 --json number,title,state,headRefName,headRefOid,baseRefName,mergeCommit,updatedAt,url
PROTECTION_BODY="$(mktemp)"
PROTECTION_ERROR="$(mktemp)"
if gh api "repos/$REPO/branches/main/protection" >"$PROTECTION_BODY" 2>"$PROTECTION_ERROR"; then
  cp "$PROTECTION_BODY" "$PREFREEZE_DIR/main-protection-prefreeze.json"
elif rg -q 'HTTP 404|Not Found' "$PROTECTION_ERROR"; then
  printf '%s\n' '{"status":"UNPROTECTED","reason":"branch protection API returned 404"}' \
    > "$PREFREEZE_DIR/main-protection-prefreeze.json"
else
  cat "$PROTECTION_ERROR" >&2
  exit 1
fi
gh api "repos/$REPO/rulesets" > "$PREFREEZE_DIR/rulesets-prefreeze.json"
```

Expected: `LIVE_MAIN_SHA` and `REMOTE_SHA` match. Record the returned state in the run evidence; do not require live main or external state to match the 2026-08-23 seed. `AUDIT_BASE_SHA` remains fixed because the 21 reviews, finding arithmetic, and lane plans were authored against it.

- [ ] **Step 2: Verify the Program-owned combined integration tip and planning baseline**

```bash
set -euo pipefail
AUDIT_BASE_SHA="4d5d8276f03635ca74c04f4d500d13ce62198dd0"
test "$(git branch --show-current)" = "review-remediation/integration"
INTEGRATION_TIP_SHA="$(git rev-parse HEAD)"
PROGRAM_BASE_SHA="$(git log --format='%H' --grep='^docs: define review remediation program$' "$AUDIT_BASE_SHA"..HEAD)"
test "$(printf '%s\n' "$PROGRAM_BASE_SHA" | sed '/^$/d' | wc -l | tr -d ' ')" = "1"
git merge-base --is-ancestor "$AUDIT_BASE_SHA" "$PROGRAM_BASE_SHA"
git merge-base --is-ancestor "$PROGRAM_BASE_SHA" "$INTEGRATION_TIP_SHA"
test -f docs/superpowers/plans/2026-08-23-review-remediation-swarm-program.md
test -f docs/superpowers/plans/2026-08-23-integrated-evidence-and-release-readiness.md
test -z "$(git diff --name-only "$AUDIT_BASE_SHA" "$PROGRAM_BASE_SHA" | awk '
  !/^(\.gitignore|docs\/superpowers\/reviews\/|docs\/superpowers\/plans\/2026-08-23-)/
')"
test -z "$(git status --porcelain=v1)"
```

Expected: clean `review-remediation/integration` worktree whose history contains the combined tip produced by Program Tasks 4–5 plus any already-committed Plan 15 evidence/docs work, with the planning-only `PROGRAM_BASE_SHA` still identifiable and ancestral. Plan 15 does not recreate the branch, reset to the Program base, check out a lane branch, or merge a lane head.

- [ ] **Step 3: Capture the exact sixteen source PR and Program merge records**

Read the sixteen node PR numbers from the coordinator ledger. For each node, capture and verify the PR rather than resolving the current branch head:

```bash
set -euo pipefail
PREFREEZE_DIR="artifacts/integration-readiness/pre-freeze"
INTEGRATION_TIP_SHA="$(git rev-parse HEAD)"
gh pr view "$PR_NUMBER" \
  --json number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,files,commits \
  > "$PREFREEZE_DIR/pr-${PR_NUMBER}.json"
PR_HEAD_SHA="$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid)"
INTEGRATION_MERGE_SHA="$(gh pr view "$PR_NUMBER" --json mergeCommit --jq .mergeCommit.oid)"
gh pr view "$PR_NUMBER" --json commits --jq '.commits[].oid' \
  > "$PREFREEZE_DIR/pr-${PR_NUMBER}-commits.txt"
test -s "$PREFREEZE_DIR/pr-${PR_NUMBER}-commits.txt"
test "$(gh pr view "$PR_NUMBER" --json state --jq .state)" = "MERGED"
test "$(gh pr view "$PR_NUMBER" --json baseRefName --jq .baseRefName)" = "review-remediation/integration"
test "$(gh pr view "$PR_NUMBER" --json headRefName --jq .headRefName)" = "$EXPECTED_BRANCH"
git cat-file -e "$PR_HEAD_SHA^{commit}"
git cat-file -e "$INTEGRATION_MERGE_SHA^{commit}"
while IFS= read -r PR_COMMIT_SHA; do
  git cat-file -e "$PR_COMMIT_SHA^{commit}"
  git merge-base --is-ancestor "$PR_COMMIT_SHA" "$PR_HEAD_SHA"
done < "$PREFREEZE_DIR/pr-${PR_NUMBER}-commits.txt"
test "$(tail -n 1 "$PREFREEZE_DIR/pr-${PR_NUMBER}-commits.txt")" = "$PR_HEAD_SHA"
git merge-base --is-ancestor "$INTEGRATION_MERGE_SHA" "$INTEGRATION_TIP_SHA"
MERGE_PARENTS="$(git show -s --format='%P' "$INTEGRATION_MERGE_SHA")"
printf '%s\n' "$MERGE_PARENTS" | tr ' ' '\n' | rg -Fx "$PR_HEAD_SHA"
node scripts/integration-readiness.mjs capture-program-input \
  --node-id "$NODE_ID" \
  --expected-branch "$EXPECTED_BRANCH" \
  --pr-json "$PREFREEZE_DIR/pr-${PR_NUMBER}.json" \
  --pr-commits "$PREFREEZE_DIR/pr-${PR_NUMBER}-commits.txt" \
  --integration-merge-sha "$INTEGRATION_MERGE_SHA" \
  --capture-dir "$PREFREEZE_DIR"
```

Expected: each exact PR head is a parent of its exact Program integration merge commit, and every integration merge commit is already ancestral to `INTEGRATION_TIP_SHA`. Record the values in `lane-inputs.json`; never substitute the lane branch's later tip. The A/B entries for Plans 04, 12, 13, and 14 must have the same expected branch but different PR numbers, PR heads, and integration merge commits.

- [ ] **Step 4: Verify the Program merge DAG, split-node scope, ownership, and absence of duplicate merges**

Run the ancestry command for every manifest predecessor edge; run the occurrence/path commands for every one of the sixteen nodes; then generate the first-parent/merged-PR inputs and invoke `verify-program-dag` once:

```bash
PREFREEZE_DIR="artifacts/integration-readiness/pre-freeze"
INTEGRATION_TIP_SHA="$(git rev-parse HEAD)"
PROGRAM_BASE_SHA="$(git log --format='%H' --grep='^docs: define review remediation program$' 4d5d8276f03635ca74c04f4d500d13ce62198dd0..HEAD)"
git merge-base --is-ancestor "$PREDECESSOR_INTEGRATION_MERGE_SHA" "$CONSUMER_INTEGRATION_MERGE_SHA"
test "$(git rev-list --first-parent "$PROGRAM_BASE_SHA".."$INTEGRATION_TIP_SHA" | rg -Fxc "$INTEGRATION_MERGE_SHA")" = "1"
git diff --name-only "$INTEGRATION_MERGE_SHA^1" "$INTEGRATION_MERGE_SHA" \
  > "$PREFREEZE_DIR/node-${NODE_ID}-paths.txt"
git rev-list --first-parent --reverse "$PROGRAM_BASE_SHA".."$INTEGRATION_TIP_SHA" \
  > "$PREFREEZE_DIR/integration-first-parent.txt"
gh pr list --base review-remediation/integration --state merged --limit 100 \
  --json number,url,headRefName,headRefOid,mergeCommit,mergedAt \
  > "$PREFREEZE_DIR/merged-integration-prs.json"
node scripts/integration-readiness.mjs verify-program-dag \
  --capture-dir "$PREFREEZE_DIR" \
  --first-parent "$PREFREEZE_DIR/integration-first-parent.txt" \
  --merged-prs "$PREFREEZE_DIR/merged-integration-prs.json" \
  --program docs/superpowers/plans/2026-08-23-review-remediation-swarm-program.md \
  --ledger docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md
```

Validate all predecessor sets from the input table, not a convenient total-order approximation. In addition, prove:

- `03` is the first remediation merge after `PROGRAM_BASE_SHA`;
- `04A` precedes `06`, and `06` precedes `04B`;
- `12A` precedes `13A`, proving the mounted global-error tests receive Plan 12's exact `happy-dom`/global-registrator manifest-and-lock handoff;
- `09` precedes `08`, proving final service integration receives the Plan 09 PDF and selected `D-04` durable-port contracts;
- `12A`, `13A`, and `14A` precede `10`;
- when the recorded decision is `D-07B`, `13A` also precedes `11` and its exact bootstrap-removal prerequisite is present before the Plan 11 deletion merge;
- `13B` follows both `10` and `11` and contains the final deletion, selected `D-06`, accessibility, mounted UI, and performance gates;
- `14B` follows its additive predecessor `14A` as well as `13B`, `10`, and `11`, and contains old-surface removal plus the selected build/static-export disposition;
- `12B` is the last lane merge and follows all capability consumers named in the table;
- each changed path belongs to that node's permanent owner or an explicit temporary/additive handoff in the Program ownership table;
- the sixteen recorded integration merge commits occur exactly once on the integration first-parent history, and there is no seventeenth/unrecorded merge from any Plan 03–14 lane branch.

Any commit after `12B` and before `FROZEN_SHA` must be either a Plan 15 commit confined to its owned paths or an explicit Program-coordinator reconciliation commit. A coordinator reconciliation record must name the owner-authored source commit or review PR, changed paths, affected node/finding IDs, affected-owner approval, independent-review approval, focused gates, and exact coordinator commit. An unclassified post-`12B` commit, direct Plan 15 edit to a production/workflow hotspot, or second merge of a lane branch is failure.

Expected: the already-integrated history satisfies the Program DAG and ownership contract. Any missing, duplicate, out-of-order, or unrecorded lane merge returns to the Program coordinator and owning lane. Plan 15 must not repair history by merging or cherry-picking the branch again.

- [ ] **Step 5: Verify current-main reconciliation and derive the final 128-row ledger inputs**

If `LIVE_MAIN_SHA` is already ancestral to `INTEGRATION_TIP_SHA`, record `NOT_REQUIRED`. If it is not, Plan 15 stops before freeze and writes a reconciliation request containing the exact main-only commits, paths, ownership mapping, conflicts, affected finding IDs, and gates to rerun:

```bash
AUDIT_BASE_SHA="4d5d8276f03635ca74c04f4d500d13ce62198dd0"
LIVE_MAIN_SHA="$(git rev-parse origin/main)"
INTEGRATION_TIP_SHA="$(git rev-parse HEAD)"
PREFREEZE_DIR="artifacts/integration-readiness/pre-freeze"
if git merge-base --is-ancestor "$LIVE_MAIN_SHA" "$INTEGRATION_TIP_SHA"; then
  node scripts/integration-readiness.mjs main-reconciliation-not-required \
    --audit-base-sha "$AUDIT_BASE_SHA" \
    --live-main-sha "$LIVE_MAIN_SHA" \
    --combined-tip-sha "$INTEGRATION_TIP_SHA" \
    --output "artifacts/integration-readiness/main-reconciliation-${LIVE_MAIN_SHA}.json"
else
  MAIN_INTEGRATION_MERGE_BASE="$(git merge-base "$LIVE_MAIN_SHA" "$INTEGRATION_TIP_SHA")"
  git log --format='%H %aI %s' "$INTEGRATION_TIP_SHA".."$LIVE_MAIN_SHA" \
    > "$PREFREEZE_DIR/main-only-commits.txt"
  git diff --name-status "$MAIN_INTEGRATION_MERGE_BASE" "$LIVE_MAIN_SHA" \
    > "$PREFREEZE_DIR/main-only-paths.txt"
  node scripts/integration-readiness.mjs main-reconciliation-request \
    --audit-base-sha "$AUDIT_BASE_SHA" \
    --live-main-sha "$LIVE_MAIN_SHA" \
    --combined-tip-sha "$INTEGRATION_TIP_SHA" \
    --commits "$PREFREEZE_DIR/main-only-commits.txt" \
    --paths "$PREFREEZE_DIR/main-only-paths.txt" \
    --program docs/superpowers/plans/2026-08-23-review-remediation-swarm-program.md \
    --ledger docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md \
    --output "artifacts/integration-readiness/main-reconciliation-${LIVE_MAIN_SHA}.json"
  printf '%s\n' "Program coordinator reconciliation required for $LIVE_MAIN_SHA; Plan 15 must not merge it" >&2
  exit 1
fi
```

The reconciliation document has exact schema `viva.main_reconciliation.v1` and fields `audit_base_sha`, `live_main_sha`, `previous_combined_tip_sha`, `main_only_commits`, `changed_paths`, `path_owner_dispositions`, `conflicts`, `affected_node_ids`, `affected_finding_ids`, `focused_gates`, `requester_role`, `program_coordinator_review`, `affected_owner_reviews`, `independent_review`, `merge_actor_role`, `reconciliation_merge_sha`, `post_reconciliation_tip_sha`, and `status`. `NOT_REQUIRED` requires empty delta/review fields and proves live-main ancestry. A request uses `requester_role: PLAN_15_EVIDENCE`, `status: REVIEW_REQUIRED`, and null review/merge fields. A completed document requires `merge_actor_role: PROGRAM_COORDINATOR`, every affected owner plus independent review `APPROVED`, every focused gate `PASS`, and `status: RECONCILED` before it can enter Level 1 evidence.

Only the Program coordinator may incorporate that exact main snapshot, after affected lane owners and an independent reviewer approve `artifacts/integration-readiness/main-reconciliation-${LIVE_MAIN_SHA}.json` and its focused-gate list. The coordinator records the reviewed reconciliation commit in the ledger and reruns every affected consumer gate. Plan 15 then restarts Task 2, verifies that the exact `live_main_sha` and `reconciliation_merge_sha` are ancestral to the new combined tip, and never performs a second merge of a source branch.

Generate a reconciliation that proves:

```text
component review documents = 12
component finding instances = 128
critical + important + minor = 2 + 44 + 82 = 128
source lane namespaces = 12
program integration nodes = 16
unmapped source instances = 0
duplicate source instances without canonical alias = 0
canonical rows with missing proof = 0
UNSTARTED rows = 0
DECISION_BLOCKED rows = 0
```

Every `DUPLICATE_ALIAS` must point to one canonical ID whose proof satisfies the union of its source obligations. Every `EXTERNAL_EVIDENCE` row must map to a non-empty set of `OPS-01`–`OPS-06` gates and must not be counted as code PASS; the row is externally satisfied only when every named gate is `PASS`. Task 10 Step 4's final tracked ledger edit adds an explicit `external_gates` column to each `EXTERNAL_EVIDENCE` row using this fixed mapping: Quality `QLT-01`, Index `QLT-01`, Index `R10`, and Security component `R6` → {`OPS-01`, `OPS-02`}; Index `A1` → {`OPS-01`, `OPS-02`, `OPS-03`, `OPS-05`}; Quality `QLT-03`, Index `QLT-03`, Index `R7`, and Project `U3` → {`OPS-01`}; Project `U1` → {`OPS-04`}; Project `U2` → {`OPS-03`}; Project `U4`, Correctness `A1`, Frontend `FE-08`, and Project `U5` → {`OPS-05`}; Reliability `A1` → {`OPS-03`, `OPS-04`}. Rows credited to `INTEGRATION-001`/`INTEGRATION-006` keep those canonical IDs for the contract definition while their external evidence binds to Task 9 artifacts. Each canonical proof must point through one of the sixteen verified node records to an exact PR head and Program integration merge commit. This step derives and validates the reconciliation inputs; Task 10 Step 4 performs Plan 15's final tracked ledger edit before the freeze.

- [ ] **Step 6: Commit integration-owned evidence and docs changes before freezing**

Complete the tracked implementation portions of Tasks 3–7 and Task 10 Steps 1–4, including Plan 15's final ledger reconciliation, then run. Do not execute or credit Levels 1–3 yet:

```bash
git fetch origin main --prune
LATEST_MAIN_SHA="$(git rev-parse origin/main)"
if ! git merge-base --is-ancestor "$LATEST_MAIN_SHA" HEAD; then
  printf '%s\n' "main advanced to $LATEST_MAIN_SHA; stop for the Program coordinator's reviewed main reconciliation, then restart Task 2" >&2
  exit 1
fi
LIVE_MAIN_SHA_AT_FREEZE="$LATEST_MAIN_SHA"
git status --short
git diff --check
git add -- scripts/integration-readiness.mjs scripts/integration-readiness.test.mjs scripts/public-contract.mjs scripts/public-contract.test.mjs README.md CONTRIBUTING.md SECURITY.md .github/PULL_REQUEST_TEMPLATE.md agent/README.md docs/REQUIREMENTS.md docs/learner-loop-contract.md docs/data-governance.md docs/deployment-runbook.md docs/release-readiness.md docs/public-contract.json docs/assets docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md
git commit -m "chore: integrate remediation evidence and public contracts"
```

Expected: explicit staging includes only integration-owned paths. If a listed file did not change, Git ignores it.

- [ ] **Step 7: Freeze one clean SHA**

```bash
set -euo pipefail
test -z "$(git status --porcelain=v1)"
FROZEN_SHA="$(git rev-parse HEAD)"
test "$(printf '%s' "$FROZEN_SHA" | wc -c | tr -d ' ')" = "40"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
mkdir -p "artifacts/integration-readiness/$RUN_ID"
git show --no-patch --format='%H%n%P%n%aI%n%s' "$FROZEN_SHA" > "artifacts/integration-readiness/$RUN_ID/frozen-commit.txt"
mv artifacts/integration-readiness/pre-freeze \
  "artifacts/integration-readiness/$RUN_ID/program-capture"
node scripts/integration-readiness.mjs bind-program-inputs \
  --capture-dir "artifacts/integration-readiness/$RUN_ID/program-capture" \
  --reconciliation-history-dir artifacts/integration-readiness \
  --frozen-sha "$FROZEN_SHA" \
  --output "artifacts/integration-readiness/$RUN_ID/lane-inputs.json" \
  --markdown "artifacts/integration-readiness/$RUN_ID/merge-ledger.md"
```

Expected: clean worktree and one immutable `FROZEN_SHA`; the bound inputs contain exactly sixteen verified nodes and no merge action. Any later tracked edit creates a new SHA, marks this run `superseded`, and forces a new Level 1–3 run.

---

### Task 3: `INTEGRATION-003` — Make Level 1 Lane Proof and Finding Reconciliation Executable

**Files:**
- Modify: `scripts/integration-readiness.mjs`
- Modify: `scripts/integration-readiness.test.mjs`
- Read only: `docs/superpowers/reviews/*.md`
- Read only: `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`

- [ ] **Step 1: Write failing Level 1 reconciliation tests**

Add fixtures that deliberately omit one of the 128 instances, duplicate an instance without `DUPLICATE_ALIAS`, leave a decision unresolved, point a proof to a different PR-head SHA, list a Program merge that is not an ancestor of the frozen SHA, omit one split node, reuse one A/B PR or merge commit, and give an `INTEGRATION-`-owned record a fabricated lane node/PR tuple.

Expected errors, respectively:

```text
coverage reconciliation expected 128 instances
duplicate finding instance lacks canonical alias
decision-blocked finding remains unresolved
proof artifact is not bound to the node PR head SHA
integration merge SHA is not included in frozen SHA
integration manifest expected 16 Program nodes
split phases must use distinct PR and merge commits
integration-owned record must bind to a coordinator commit
```

- [ ] **Step 2: Run the Level 1 tests and verify RED**

```bash
node --test scripts/integration-readiness.test.mjs
```

Expected: FAIL because Level 1 reconciliation is not implemented.

- [ ] **Step 3: Implement Level 1 validation**

Require each canonical remediation record to contain:

```json
{
  "canonical_id": "CRIT-AUDIO-01",
  "source_instances": ["Web UI Critical 1", "COR-01", "FE-02", "QLT-02"],
  "owner_namespace": "CRIT",
  "node_id": "03",
  "pr_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "integration_merge_sha": "89abcdef0123456789abcdef0123456789abcdef",
  "red_command": "exact command",
  "red_failure": "exact pre-fix failure signal",
  "green_command": "exact command",
  "green_result": "PASS",
  "adversarial_control": "exact negative or mutation control",
  "artifact_paths": ["artifacts/lane-proof/CRIT-AUDIO-01.json"],
  "status": "PASS"
}
```

Reject prose-only proof, missing RED when the disposition is `TESTED_FIX`, source-grep-only proof for behavioral claims, artifacts outside ignored `artifacts/`, or any record whose node/PR-head/integration-merge tuple is absent from `lane_inputs`.

Records whose `canonical_id` begins with `INTEGRATION-` use `owner_namespace: "INTEGRATION"`, `node_id: null`, `pr_head_sha: null`, and `integration_merge_sha: null`, and instead carry `coordinator_commit_sha` — a Plan 15 commit that must be ancestral to `frozen_sha` and confined to Plan-15-owned paths. The validator requires exactly one of the lane tuple or `coordinator_commit_sha`, never both, and still rejects prose-only proof.

- [ ] **Step 4: Run the complete Level 1 tests**

```bash
node --test scripts/integration-readiness.test.mjs
```

Expected: PASS, including all negative controls.

- [ ] **Step 5: Produce Level 1 evidence on the candidate**

```bash
node scripts/integration-readiness.mjs reconcile \
  --ledger docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md \
  --lane-inputs "artifacts/integration-readiness/$RUN_ID/lane-inputs.json" \
  --frozen-sha "$FROZEN_SHA" \
  --output "artifacts/integration-readiness/$RUN_ID/level-1.json"
```

Expected: `status: PASS`, 128 reconciled instances, zero unresolved rows, exactly twelve lane namespaces, exactly sixteen verified Program integration nodes, and every recorded PR commit/head plus integration merge SHA included in `FROZEN_SHA`.

---

### Task 4: `INTEGRATION-004` — Run Forced Level 2 Combined TypeScript, Rust, Browser, WebSocket, Release, and Audit Gates

**Files:**
- Modify: `scripts/integration-readiness.mjs`
- Modify: `scripts/integration-readiness.test.mjs`
- Create at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/level-2/`

- [ ] **Step 1: Write failing command-recording and frozen-SHA tests**

Test that the command runner:

- captures stdout and stderr in separate immutable files;
- hashes both files;
- records argv without shell interpolation;
- fails if `git rev-parse HEAD` changes before or after a command;
- fails if the worktree becomes dirty;
- treats signal, timeout, missing executable, or permission-denied skip as `FAIL`;
- never records secret environment values;
- cannot overwrite a prior command ID.

- [ ] **Step 2: Run the tests and verify RED**

```bash
node --test scripts/integration-readiness.test.mjs
```

Expected: FAIL because the combined gate runner is absent.

- [ ] **Step 3: Implement the frozen command runner, then execute the TypeScript/script graph after freeze**

Implement the runner and make its unit tests pass before Task 2 Step 7. Only after Task 2 freezes the clean tree, run each command below through that runner, checking the frozen SHA before and after:

```bash
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)'
test "$(bun --version)" = "1.3.3"
test "$(rustc --version | awk '{print $2}')" = "1.94.1"
bun install --frozen-lockfile
bunx turbo run typecheck lint test build --force
node --test scripts/*.test.mjs
node -e 'import("@viva/core/runtime-validation").then((m) => { if (typeof m.validateLearnerLoopContract !== "function" || typeof m.parseVivaServerFrame !== "function") process.exit(1); })'
bun run module:concentration
bun run redaction:check
bun run release:hygiene
```

Expected:

- dependency install does not change `bun.lock`;
- Turbo reports zero cached tasks for the forced graph;
- all package and script tests pass;
- redaction and generated-artifact hygiene pass fail-closed.

- [ ] **Step 4: Execute the full Rust graph without loopback skip authority**

```bash
cargo audit --version | rg -qx 'cargo-audit(-audit)? 0\.22\.0'
rustup run nightly-2026-04-21 rustc --version
test "$(cargo +nightly-2026-04-21 udeps --version)" = "cargo-udeps 0.1.60"
test "$(cargo mutants --version)" = "cargo-mutants 25.3.1"
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml --workspace --all-targets --all-features -- -D warnings
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP cargo test --manifest-path agent/Cargo.toml --workspace --all-targets --all-features --no-fail-fast
cargo build --manifest-path agent/Cargo.toml --workspace --all-targets --all-features
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP bun run agent:replay:ws
bun run agent:deps:unused
bun run agent:domain:mutants
cargo test --manifest-path agent/Cargo.toml -p data pdf_ingestion_fails_closed_ -- --nocapture
```

Expected: PASS. A loopback `PermissionDenied` early return, ignored network test, zero matching test in a required handoff family, unused dependency, or missed/no-generated domain mutant is `FAIL`. Before these commands, verify the installed tools are exactly nightly `nightly-2026-04-21`, `cargo-udeps` 0.1.60, and `cargo-mutants` 25.3.1; missing or drifted tools are failure, not a skip. `cargo-audit` prints `cargo-audit-audit 0.22.0` when invoked via the cargo subcommand, which is why the version check accepts that form.

The `pdf_ingestion_fails_closed_` family is unconditional Plan 08/09 handoff proof. When the coordinator ledger records `D-04 = SOFT_DELETE_UNDO`, additionally run `cargo test --manifest-path agent/Cargo.toml -p data study_set_restore_ -- --nocapture`; zero matching tests is then `FAIL`, and the memory-backed `study_set_restore_` family does not replace the durable `postgres_study_set_restore_` family in Level 3. When `D-04 = CONFIRM_DELETE`, Plan 09 publishes no restore family; skip that command and instead require at least one passing test from Plan 09 Task 9's memory-backed retention/finalization filter `cargo test --manifest-path agent/Cargo.toml -p data selected_d05 -- --nocapture`.

Also require at least one matching, executed test per preserved-behavior family credited to `INTEGRATION-004`, using the exact filters published in the owning lanes' plans for: public-bind-without-auth rejection (Plan 08), session-token/nonce admission mutations (Plans 05/08), forged browser source/tool frame rejection (Plans 05/08), live-provider/ZDR admission gating (Plan 07), and redaction/sanitization marker mutations (Plan 12). Zero matches for any family is `FAIL`; record each family's filter and matched-count in the Level 2 command log.

- [ ] **Step 5: Execute the cross-language protocol, long-audio, and browser matrices**

Plan 12 (`RELEASE` lane, via `scripts/e2e-browser.mjs`/`scripts/e2e-browser.test.mjs`) must make `VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1` fail unless the story executes 2 s, 10 s, and 45 s answers at both 44.1 kHz and 48 kHz through the production client controller and real Rust WebSocket service. Route a defective transport-matrix gate to Plan 12; the underlying protocol fixtures remain Plan 05's. Run:

```bash
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP bun run e2e:browser:audio:negative
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP bun run e2e:browser:audio

env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP \
VIVA_E2E_AGENT_PROVIDER=synthetic \
VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 \
VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 \
VIVA_E2E_DEPLOY_SHA="$FROZEN_SHA" \
VIVA_E2E_ARTIFACT_DIR="artifacts/integration-readiness/$RUN_ID/level-2/browser-synthetic" \
  bun run e2e:browser

env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP \
VIVA_E2E_AGENT_PROVIDER=fake_cartesia_gemini \
VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 \
VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 \
VIVA_E2E_DEPLOY_SHA="$FROZEN_SHA" \
VIVA_E2E_ARTIFACT_DIR="artifacts/integration-readiness/$RUN_ID/level-2/browser-fake-provider" \
  bun run e2e:browser
```

Required result fields:

```json
{
  "deploy_sha": "same frozen SHA",
  "voice_transport": {
    "durations_seconds": [2, 10, 45],
    "source_sample_rates_hz": [44100, 48000],
    "max_serialized_frame_bytes": 65536,
    "oversized_frames": 0,
    "explicit_turn_end": true,
    "transcript_received": true,
    "evaluation_received": true,
    "recap_received": true
  },
  "console_errors": 0,
  "page_errors": 0,
  "sanitized": true
}
```

Also require mounted session, citation challenge, reconnect/lease, latest-token, terminal recap copy, upload cap/token stripping, deletion confirmation, keyboard landmark, forced-colors, reduced-motion, and 200% text-zoom stories from their owning lanes. Harness-authored `page.setContent` frames cannot certify product behavior.

- [ ] **Step 6: Execute hermetic release evidence and independent stored-bundle verification**

Generate an ephemeral local HMAC secret without writing it to logs:

```bash
LOCAL_RELEASE_HMAC="$(openssl rand -hex 32)"
export VIVA_RELEASE_RUN_ID="$RUN_ID"
export VIVA_RELEASE_DEPLOY_SHA="$FROZEN_SHA"
export VIVA_RELEASE_BUNDLE_SIGNING_SECRET="$LOCAL_RELEASE_HMAC"
export VIVA_AGENT_PROVIDER="fake_cartesia_gemini"
export VIVA_RELEASE_ARTIFACT_DIR="artifacts/integration-readiness/$RUN_ID/level-2/release-check"
unset DATABASE_URL VIVA_AGENT_DATABASE_URL CARTESIA_API_KEY GEMINI_API_KEY
unset VIVA_VOICE_SESSION_TOKEN_SECRET VIVA_VOICE_WS_BEARER_TOKEN VIVA_AGENT_REST_BEARER_TOKEN
unset VIVA_FAILURE_CONTROL_ENABLED VIVA_FAILURE_CONTROL_SECRET
bun run release:check
VIVA_RELEASE_BUNDLE_SIGNING_SECRET="$VIVA_RELEASE_BUNDLE_SIGNING_SECRET" \
  bun run release:verify -- \
  "artifacts/integration-readiness/$RUN_ID/level-2/release-check/evidence.json"
unset LOCAL_RELEASE_HMAC VIVA_RELEASE_BUNDLE_SIGNING_SECRET
```

Expected: generation PASS; Plan 12's separate `release:verify` process reads the stored file, requires HMAC-SHA-256 for production evidence, verifies the full canonical payload, run ID, SHA, environment/mode, timestamps, and sanitization, and rejects `sha256-self`, a missing key, a modified payload, a mismatched SHA, a mismatched run ID, stale/future evidence, and an enabled failure harness. Local fake-provider proof is mandatory Level 2 evidence but is not hosted production proof.

- [ ] **Step 7: Execute dependency and supply-chain audits**

```bash
bun audit
cargo audit --file agent/Cargo.lock --no-fetch --deny warnings
```

Expected: both exit 0 with no unresolved advisory. Local Rust audit uses the existing advisory DB with `--no-fetch`; Plan 12's hosted `bun run audit` fetches current advisory state and is the release acceptance gate. This level does not accept a prose waiver. Also require workflow/action references to use full commit SHAs, runtime base images to use immutable digests, SQLx to exclude unused database drivers, and the domain dependency boundary gate to fail closed when its inspection tools fail.

- [ ] **Step 8: Execute the adversarial control set**

The combined script suite must include and pass controls for:

```text
missing rg and failing rg/git in shell gates
old single-frame 2-second audio implementation
wrong protocol size/version/close-reason fixture
wrong deploy SHA or run ID
unsigned bundle and signature downgrade
missing sanitized field
stale and future-dated evidence
enabled failure-control harness
hostile inherited auth/database/provider env
monitor timeout before partial-evidence flush
consecutive live-monitor failure count reaching two
stale ETag or duplicate run attempting to overwrite hosted monitor state
S3 transient retry then success and publish deadline failure
grandchild/orphan process after normal exit and SIGTERM
required product frame replaced by harness-authored HTML
provider limiter proof test renamed or removed
redaction marker split across Unicode normalization
```

Expected: each pre-fix mutation fails its enforcing test; the corrected combined tree passes. The `required product frame replaced by harness-authored HTML` control enforces the recorded `D-09` branch.

- [ ] **Step 9: Assemble and validate Level 2 evidence**

```bash
node scripts/integration-readiness.mjs level-2 \
  --artifact-dir "artifacts/integration-readiness/$RUN_ID/level-2" \
  --frozen-sha "$FROZEN_SHA" \
  --output "artifacts/integration-readiness/$RUN_ID/level-2.json"
```

Expected: `status: PASS`; every required command ID appears once; every exit code is zero; forced Turbo cache count is zero; browser and release artifacts bind to `FROZEN_SHA`; redaction forbidden hits are zero; and audits pass.

---

### Task 5: `INTEGRATION-005` — Make Disposable Real PostgreSQL Proof Mandatory and Repeatable

**Files:**
- Read only: `docs/superpowers/plans/2026-08-23-persistence-postgres-privacy.md`
- Modify: `scripts/integration-readiness.mjs`
- Modify: `scripts/integration-readiness.test.mjs`

- [ ] **Step 1: Write failing Level 3 evidence-validation tests**

Test all of these evidence paths:

- both suite passes use different fresh Postgres 16 container IDs, ports, and database identities;
- either suite pass missing `DATA_POSTGRES_REQUIRED=1` fails;
- a failed first pass prevents a PASS summary;
- logs and JSON never contain the database password;
- missing or zero-match canary tests fail;
- migration count mismatch or any unsuccessful `_sqlx_migrations` row fails.
- equal container IDs, host ports, PostgreSQL system identifiers, or composite database identities across the two passes fail.

- [ ] **Step 2: Run the new tests and verify RED**

```bash
node --test scripts/integration-readiness.test.mjs
```

Expected: FAIL because Level 3 evidence validation does not exist.

- [ ] **Step 3: Verify Plan 09 published the required canary suite**

Before starting Postgres, require the Plan 09 test list to contain these exact canaries:

```text
postgres_selected_d05_policy_removes_exact_canary_fields
postgres_deleted_fixture_is_not_resurrected_by_seed_or_store_reconstruction
postgres_repeated_delete_is_idempotent_and_content_free
postgres_delete_canary_scan_covers_every_learner_text_table
postgres_delete_serializes_against_every_artifact_writer
postgres_store_conformance_all_owned_ports
postgres_full_migration_chain_runs_from_empty_schema_twice_via_ledger
postgres_upgrade_0014_to_latest_preserves_rows_and_applies_cleanup
```

When the recorded decision is `D-04 = SOFT_DELETE_UNDO`, the list must additionally contain `postgres_study_set_restore_survives_store_reconstruction`, `postgres_study_set_restore_is_visible_to_second_instance`, `postgres_study_set_restore_and_expiry_purge_have_one_legal_winner`, and `postgres_study_set_restore_expired_finalizes_selected_d05_policy_and_canary`; when `D-04 = CONFIRM_DELETE`, their absence is required and their presence is failure.

Also require at least one Plan 09 test matching each of `postgres_*_authorization_*`, `postgres_record_answer_*`, and `postgres_voice_usage_and_*`. Zero matches is failure. These are the two-instance authorization and concurrency families; do not replace them with source-string checks.

Required Level 3 JSON fields:

```json
{
  "schema": "viva.integration_postgres_proof.v1",
  "run_id": "same integration run ID",
  "frozen_sha": "same frozen SHA",
  "postgres": {
    "major": 16,
    "server_version": "captured from SELECT version()",
    "image_reference": "postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5",
    "image_id": "captured immutable local image ID"
  },
  "suite_passes": [
    {
      "pass": 1,
      "container_id": "64 lowercase hex characters",
      "host_port": 55432,
      "server_system_identifier": "captured pg_control_system system_identifier",
      "data": { "database_name_sha256": "64 lowercase hex characters", "database_oid": 16384, "database_identity_sha256": "64 lowercase hex characters", "status": "PASS" },
      "service": { "database_name_sha256": "64 lowercase hex characters", "database_oid": 16385, "database_identity_sha256": "64 lowercase hex characters", "status": "PASS" }
    },
    {
      "pass": 2,
      "container_id": "different 64 lowercase hex characters",
      "host_port": 55433,
      "server_system_identifier": "different pg_control_system system_identifier",
      "data": { "database_name_sha256": "64 lowercase hex characters", "database_oid": 16384, "database_identity_sha256": "different 64 lowercase hex characters", "status": "PASS" },
      "service": { "database_name_sha256": "64 lowercase hex characters", "database_oid": 16385, "database_identity_sha256": "different 64 lowercase hex characters", "status": "PASS" }
    }
  ],
  "migration_chain": { "expected": 18, "applied": 18, "all_success": true, "replay_clean": true },
  "canaries": {
    "application_restart": "PASS",
    "two_instances": "PASS",
    "concurrent_replay": "PASS",
    "deletion_purge": "PASS",
    "restart_non_resurrection": "PASS",
    "privacy_schema": "PASS"
  },
  "sanitized": true,
  "status": "PASS"
}
```

The migration count in the implementation must be derived from the exact merged migration files and `MIGRATIONS` ledger, not hardcoded to 18. The reviewed chain ended at `0014`; Plan 09 reserves `0015`–`0018`, so the example shows the expected post-remediation chain while the validator rejects either a missing reserved migration or an extra unledgered file.

- [ ] **Step 4: Run the Level 3 validator tests**

```bash
node --test scripts/integration-readiness.test.mjs
```

Expected: PASS, including two-container identity, mandatory-env, redaction, and zero-match controls.

- [ ] **Step 5: Start two disposable PostgreSQL 16 instances**

```bash
set -euo pipefail
PG_CONTAINER_A="viva-data-postgres-pass-1"
PG_CONTAINER_B="viva-data-postgres-pass-2"
PG_PASSWORD="viva_test_only"
PG_IMAGE_REF="postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5"
test -z "$(docker ps --all --quiet --filter "name=^/${PG_CONTAINER_A}$")"
test -z "$(docker ps --all --quiet --filter "name=^/${PG_CONTAINER_B}$")"
cleanup_plan15_postgres() {
  docker stop "$PG_CONTAINER_A" "$PG_CONTAINER_B" >/dev/null 2>&1 || true
}
trap cleanup_plan15_postgres EXIT INT TERM
docker pull "$PG_IMAGE_REF"
PG_IMAGE_ID="$(docker image inspect "$PG_IMAGE_REF" --format '{{.Id}}')"
docker run --detach --rm \
  --name "$PG_CONTAINER_A" \
  --env POSTGRES_USER=viva \
  --env POSTGRES_PASSWORD="$PG_PASSWORD" \
  --env POSTGRES_DB=viva_data_test \
  --publish 127.0.0.1:55432:5432 \
  "$PG_IMAGE_REF"
docker run --detach --rm \
  --name "$PG_CONTAINER_B" \
  --env POSTGRES_USER=viva \
  --env POSTGRES_PASSWORD="$PG_PASSWORD" \
  --env POSTGRES_DB=viva_data_test \
  --publish 127.0.0.1:55433:5432 \
  "$PG_IMAGE_REF"
until docker exec "$PG_CONTAINER_A" pg_isready -U viva -d viva_data_test; do sleep 1; done
until docker exec "$PG_CONTAINER_B" pg_isready -U viva -d viva_data_test; do sleep 1; done
docker exec "$PG_CONTAINER_A" createdb -U viva viva_service_test
docker exec "$PG_CONTAINER_B" createdb -U viva viva_service_test
PG_CONTAINER_A_ID="$(docker inspect "$PG_CONTAINER_A" --format '{{.Id}}')"
PG_CONTAINER_B_ID="$(docker inspect "$PG_CONTAINER_B" --format '{{.Id}}')"
PG_SYSTEM_A="$(docker exec "$PG_CONTAINER_A" psql -U viva -d viva_data_test -Atqc 'SELECT system_identifier FROM pg_control_system()')"
PG_SYSTEM_B="$(docker exec "$PG_CONTAINER_B" psql -U viva -d viva_data_test -Atqc 'SELECT system_identifier FROM pg_control_system()')"
test "$PG_CONTAINER_A_ID" != "$PG_CONTAINER_B_ID"
test "$PG_SYSTEM_A" != "$PG_SYSTEM_B"
mkdir -p "artifacts/integration-readiness/$RUN_ID/level-3-postgres"
: > "artifacts/integration-readiness/$RUN_ID/level-3-postgres/pass-1-database-identities.tsv"
: > "artifacts/integration-readiness/$RUN_ID/level-3-postgres/pass-2-database-identities.tsv"
for DB_NAME in viva_data_test viva_service_test; do
  docker exec "$PG_CONTAINER_A" psql -U viva -d "$DB_NAME" -Atqc \
    "SELECT current_database(), oid FROM pg_database WHERE datname = current_database()" \
    >> "artifacts/integration-readiness/$RUN_ID/level-3-postgres/pass-1-database-identities.tsv"
  docker exec "$PG_CONTAINER_B" psql -U viva -d "$DB_NAME" -Atqc \
    "SELECT current_database(), oid FROM pg_database WHERE datname = current_database()" \
    >> "artifacts/integration-readiness/$RUN_ID/level-3-postgres/pass-2-database-identities.tsv"
done
```

Expected: two fresh disposable servers, each with newly created `viva_data_test` and `viva_service_test` databases, PostgreSQL major 16, different container IDs and system identifiers, two database OIDs, and one captured immutable image ID. The Level 3 validator hashes the `(system_identifier, database name, database OID)` tuples into per-pass composite identities and requires all pass-1/pass-2 counterparts to differ. If either exact container name already exists or either fixed port is occupied, stop before creating evidence; do not stop, remove, or attach to an existing container or database.

- [ ] **Step 6: Run the complete suite twice plus required canaries**

```bash
DATA_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_data_test \
  cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
SERVICE_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55432/viva_service_test \
  cargo test --manifest-path agent/Cargo.toml -p agent-service postgres_ -- --ignored --test-threads=1 --nocapture

DATA_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55433/viva_data_test \
  cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
SERVICE_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://viva:viva_test_only@127.0.0.1:55433/viva_service_test \
  cargo test --manifest-path agent/Cargo.toml -p agent-service postgres_ -- --ignored --test-threads=1 --nocapture
```

Expected: PASS with two different fresh PostgreSQL servers/databases, full Plan 09 data suite and Postgres service suite in both, complete migration chain/replay, application/store reconstruction, two-instance authorization, concurrency/replay, deletion/purge, non-resurrection, and privacy schema proof. `DATA_POSTGRES_REQUIRED=1` and `SERVICE_POSTGRES_REQUIRED=1` convert a missing database or skipped durable test into failure.

- [ ] **Step 7: Destroy the disposable instances and verify cleanup**

```bash
docker stop "$PG_CONTAINER_A" "$PG_CONTAINER_B"
trap - EXIT INT TERM
unset PG_PASSWORD
unset PG_IMAGE_REF
test -z "$(docker ps --filter "name=^/${PG_CONTAINER_A}$" --format '{{.ID}}')"
test -z "$(docker ps --filter "name=^/${PG_CONTAINER_B}$" --format '{{.ID}}')"
```

Expected: the run-scoped container and databases are gone; evidence remains under ignored `artifacts/` and contains no password or full connection string.

- [ ] **Step 8: Validate Level 3 binding**

```bash
node scripts/integration-readiness.mjs level-3 \
  --command-log-dir "artifacts/integration-readiness/$RUN_ID/level-3-postgres" \
  --postgres-image-id "$PG_IMAGE_ID" \
  --frozen-sha "$FROZEN_SHA" \
  --output "artifacts/integration-readiness/$RUN_ID/level-3.json"
```

Expected: `status: PASS`; no suite was skipped; both database passes and every canary are PASS; frozen SHA and run ID match.

---

### Task 6: `INTEGRATION-006` — Verify Plan 12 Made Hosted Validation and Durable PostgreSQL Proof Continuous

**Files:**
- Read only: `.github/workflows/validate.yml`
- Read only: `scripts/validate-workflow.test.mjs`
- Read only: `scripts/ci-durable-postgres.sh`
- Read only: `scripts/ci-durable-postgres.test.mjs`
- Modify: `scripts/integration-readiness.test.mjs`

- [ ] **Step 1: Add integration-owned acceptance tests for the Plan 12 workflow handoff**

Extend `scripts/integration-readiness.test.mjs` to inspect the workflow and require:

```text
top-level permissions: contents: read
all actions pinned to a full 40-character commit SHA
explicit supported Node 24 setup
Bun 1.3.3 and Rust 1.94.1
quality-and-audit job
loopback-and-browser job with direct WebSocket replay and no skip authority
both synthetic and fake-provider browser commands with the voice transport matrix required
durable-postgres job on pull_request, push main, and workflow_dispatch
PostgreSQL 16 service
scripts/ci-durable-postgres.sh invocation and behavioral shell test
required-validation aggregate with if: always()
artifact upload only after redaction and evidence validation
no provider keys or production secrets in default jobs
```

Reject `if: github.event_name == 'workflow_dispatch'` on the durable job, floating `uses: ...@vN` tags, and any required step with `continue-on-error: true`.

- [ ] **Step 2: Run the workflow contract tests**

```bash
node --test scripts/validate-workflow.test.mjs scripts/ci-durable-postgres.test.mjs scripts/integration-readiness.test.mjs
```

Expected: PASS after Plan 12 handoff. If it fails, return the exact expectation to Plan 12; Plan 15 must not patch the workflow or its owned test.

- [ ] **Step 3: Verify the required Plan 12 job contracts**

Plan 12 must publish these stable job IDs and aggregate display name:

```text
quality-and-audit
loopback-and-browser
durable-postgres
required-validation -> Required validation
```

`quality-and-audit` runs the frozen install, Node 24 script tests, a real Node import of `@viva/core/runtime-validation`, hostile unknown-field/bypass tests, `bun run module:concentration`, `bun run audit`, TypeScript/Rust format, clippy, test, build, hygiene, Plan 06's `agent:deps:unused`, and Plan 06's `agent:domain:mutants` gate. The concentration record remains attributed to its Plan 07/08/09/13 capability owner; Plan 15 cannot waive or perform the extraction. The latter two Rust gates must use the lane-pinned nightly `nightly-2026-04-21`, `cargo-udeps` 0.1.60, and `cargo-mutants` 25.3.1, with no empty/zero-mutant acceptance. `loopback-and-browser` depends on it and runs direct WS replay, both required browser matrix commands, the fake-provider release check, redaction, then artifact upload. `durable-postgres` invokes `scripts/ci-durable-postgres.sh`, uses separate `viva_data_test` and `viva_service_test` databases, forbids optional-database skips, and propagates either Cargo command's failure. `required-validation` has `needs: [quality-and-audit, loopback-and-browser, durable-postgres]`, `if: always()`, and fails unless every upstream result is exactly `success`. Only its display name `Required validation` is the stable branch-protection context; skipped/cancelled upstream jobs cannot turn it green.

The workflow's required browser invocations are exactly:

```bash
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP \
VIVA_E2E_AGENT_PROVIDER=synthetic \
VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 \
VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 \
VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" \
VIVA_E2E_ARTIFACT_DIR=artifacts/ci/browser-voice-matrix/synthetic \
  bun run e2e:browser
env -u VIVA_ALLOW_LOOPBACK_TEST_SKIP \
VIVA_E2E_AGENT_PROVIDER=fake_cartesia_gemini \
VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO=1 \
VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX=1 \
VIVA_E2E_DEPLOY_SHA="$(git rev-parse HEAD)" \
VIVA_E2E_ARTIFACT_DIR=artifacts/ci/browser-voice-matrix/fake-provider \
  bun run e2e:browser
```

The hosted consumption boundary downloads the selected stored bundle to `artifacts/downloaded-release/evidence.json` and runs exactly:

```bash
VIVA_RELEASE_BUNDLE_SIGNING_SECRET="$VIVA_RELEASE_BUNDLE_SIGNING_SECRET" \
  bun run release:verify -- artifacts/downloaded-release/evidence.json
```

Neither invocation may regenerate the bundle or select a mutable latest object.

The durable CI job is continuous proof on one hosted PostgreSQL service, not a substitute for Task 5's mandatory two-fresh-container Level 3 proof. After the DATA/SERVICE handoff, the script's commands must be equivalent to these exact filters, with only explicit disposable CI credentials/host/port allowed to differ:

```bash
DATA_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/viva_data_test \
  cargo test --manifest-path agent/Cargo.toml -p data postgres_ -- --ignored --test-threads=1 --nocapture
SERVICE_POSTGRES_REQUIRED=1 \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/viva_service_test \
  cargo test --manifest-path agent/Cargo.toml -p agent-service postgres_ -- --ignored --test-threads=1 --nocapture
```

If the already-merged `12B` node still contains its reviewed pre-handoff `optional_postgres` data/service filters, fail the handoff and return it to Plan 12 plus the Program coordinator. Plan 15 does not amend or re-merge the lane; after the owner correction is integrated by the coordinator, restart Task 2 against the new combined tip.

Verify the full action commit SHAs selected by Plan 12 and the package/runtime pins selected by Plans 12/14. Do not invent different pins during conflict resolution.

- [ ] **Step 4: Run workflow and script contract tests on the combined tree**

```bash
node --test scripts/validate-workflow.test.mjs scripts/ci-durable-postgres.test.mjs scripts/integration-readiness.test.mjs scripts/deployment-runbook.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Record the Plan 12 handoff in Level 1 evidence**

```bash
node scripts/integration-readiness.mjs record-handoff \
  --namespace RELEASE \
  --files .github/workflows/validate.yml,scripts/validate-workflow.test.mjs,scripts/ci-durable-postgres.sh,scripts/ci-durable-postgres.test.mjs \
  --frozen-sha "$FROZEN_SHA" \
  --output "artifacts/integration-readiness/$RUN_ID/plan-12-workflow-handoff.json"
```

Task 1 Step 3 owns the `record-handoff` implementation in `scripts/integration-readiness.mjs`; this task modifies only `scripts/integration-readiness.test.mjs`.

Expected: evidence names the exact `12A` and `12B` PR heads/integration merge SHAs, binds the workflow artifact to `12B`, and records the stable check names and combined-tree test result.

---

### Task 7: `INTEGRATION-007` — Regenerate Public Contracts from Shipped Behavior

**Files:**
- Create: `scripts/public-contract.mjs`
- Create: `scripts/public-contract.test.mjs`
- Create: `docs/public-contract.json`
- Create: `docs/release-readiness.md`
- Create at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/docs-contract.json`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `SECURITY.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `agent/README.md`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `docs/learner-loop-contract.md`
- Modify: `docs/data-governance.md`
- Modify: `docs/deployment-runbook.md`
- Read only: `scripts/deployment-runbook.test.mjs`
- Regenerate if affected: `docs/assets/architecture.svg`
- Regenerate if affected: `docs/assets/architecture-mobile.svg`
- Regenerate if affected: `docs/assets/lifecycle.svg`
- Regenerate if affected: `docs/assets/lifecycle-mobile.svg`
- Regenerate if affected: `docs/assets/loop.svg`
- Regenerate if affected: `docs/assets/loop-mobile.svg`

- [ ] **Step 1: Write failing public-contract drift tests**

`scripts/public-contract.test.mjs` must prove that `node scripts/public-contract.mjs --check` fails when:

- README claims a study mode the mounted product does not send;
- README claims PDF extraction while the agent fails PDFs closed or lacks page-aware fixtures;
- README names `packages/core` as scheduling authority when the persisted writer is elsewhere;
- docs omit the actual audio lifecycle/frame cap;
- docs call optional/manual Postgres proof continuous;
- docs say the domain purity gate enforces I/O boundaries when it does not;
- docs say deletion purges data that the selected policy tombstones;
- deployment docs omit exact deploy SHA/run ID/HMAC verification;
- `docs/learner-loop-contract.md` omits fields from the canonical JSON;
- diagram files name removed providers, stores, routes, or authority edges;
- `docs/REQUIREMENTS.md` fails to label vision/non-shipped requirements separately from current behavior.

- [ ] **Step 2: Run the public-contract test and verify RED**

```bash
node --test scripts/public-contract.test.mjs
node scripts/public-contract.mjs --check
```

Expected: FAIL on the reviewed false or stale claims.

- [ ] **Step 3: Implement deterministic public-contract generation**

`node scripts/public-contract.mjs --write` must derive `docs/public-contract.json` from executable sources and tests, never from README prose. Its exact top-level fields are:

```json
{
  "schema": "viva.public_contract.v1",
  "source_manifest_sha256": "64 lowercase hex characters",
  "protocol": {},
  "voice_transport": {},
  "study_modes": [],
  "ingestion": {},
  "evaluation": {},
  "scheduling": {},
  "study_projection": {},
  "durability": {},
  "privacy": {},
  "provider_modes": [],
  "validation": {},
  "release_evidence": {},
  "external_evidence_required": [],
  "sanitized": true
}
```

Inputs must include the shared TS contract, Rust protocol/constants, canonical learner-loop JSON, package/workspace scripts, migration list, workflow job names, release evidence schema, and actual mounted web behavior tests. Any source disagreement makes `--write` fail rather than selecting one silently. `source_manifest_sha256` hashes those inputs and excludes generated outputs, avoiding an impossible self-referential Git SHA inside a tracked generated file; Level 2 evidence binds the generated artifact to the final frozen SHA.

The same implementation must expose `--evidence --frozen-sha <SHA> --output <PATH>`. It first performs the full `--check`, then writes ignored schema `viva.public_contract_evidence.v1` with exact fields `frozen_sha`, `source_manifest_sha256`, `public_contract_sha256`, `document_sha256` keyed by every owned public document and generated diagram, `checked_source_paths`, `drift_count`, `sanitized`, and `status`. It exits nonzero instead of writing `PASS` when any source, document, or generated diagram is missing or stale.

- [ ] **Step 4: Reconcile every public claim**

Update the docs according to implementation at the combined candidate:

- `README.md`: shipped capabilities only; voice framing/turn lifecycle; actual evaluator/scheduler/study projection; supported ingestion formats; real mounted modes; synthetic/fake/live distinction; local versus durable/hosted/live evidence; narrowly accurate and separate `agent:purity` and `agent:residue` claims.
- `docs/REQUIREMENTS.md`: retain product vision, but label it as vision and link to `docs/public-contract.json` for shipped status.
- `CONTRIBUTING.md`: exact default gate, required durable CI, true domain-boundary control, exact browser/WS commands, and public-contract regeneration. State that `agent:purity` enforces the `agent-domain` direct normal-dependency allowlist plus forbidden I/O imports and does not prove adapter purity or live behavior; state separately that `agent:residue` checks removed Chef Luca/cooking vocabulary.
- `.github/PULL_REQUEST_TEMPLATE.md`: the same actual required checks and separate `agent:purity`/`agent:residue` claims; use the repository's existing uppercase path and do not create a case-variant duplicate.
- `SECURITY.md`: actual preflight auth, trusted proxy model, secret strength/rotation, non-root containers, headers, dependency audits, and external live-provider proof boundary.
- `agent/README.md`: exact provider/store/session config, supported protocol, restart/multi-instance expectations, and no claim that optional local Postgres equals release proof.
- `docs/learner-loop-contract.md`: exact fields and authorities from canonical JSON.
- `docs/data-governance.md`: selected deletion policy, retained derived data, provider ZDR evidence, real typed/mic disclosure, and proof levels (per recorded `D-05`/`D-08`).
- `docs/deployment-runbook.md`: exact SHA/run/deploy binding, stored-bundle verifier, Railway separation, Postgres migration/restart proof, rollback/drain, and `BLOCKED_EXTERNAL` semantics.
- `docs/release-readiness.md`: terminal status definitions, evidence ladder, OPS register, and the rule that external conditions never inherit PASS from local proof.

These SVGs are hand-authored: when topology changed, edit each affected desktop/mobile pair together directly in the SVG markup so node/edge labels match `docs/public-contract.json` (providers, stores, routes, authority edges), and treat `public-contract.mjs --check`'s diagram assertions — which scan the SVG text for removed provider/store/route/authority names — as the drift oracle. No external diagram generator exists or is required. A diagram must not represent fixture paths as production authority.

- [ ] **Step 5: Generate and check public contracts**

```bash
node scripts/public-contract.mjs --write
node scripts/public-contract.mjs --check
node --test scripts/public-contract.test.mjs scripts/deployment-runbook.test.mjs
git diff --check
```

Expected: PASS; a second `--write` produces no diff; Markdown and JSON agree; the source manifest is stable. If the Plan 12-owned deployment-runbook test fails because a truthful doc changed its contract, return the exact test update to Plan 12 and merge its fix before freezing.

- [ ] **Step 6: Commit truthful public contracts**

```bash
git add README.md CONTRIBUTING.md SECURITY.md .github/PULL_REQUEST_TEMPLATE.md agent/README.md docs/REQUIREMENTS.md docs/learner-loop-contract.md docs/data-governance.md docs/deployment-runbook.md docs/release-readiness.md docs/public-contract.json docs/assets scripts/public-contract.mjs scripts/public-contract.test.mjs
git commit -m "docs: bind public contract to shipped behavior"
```

- [ ] **Step 7: Recheck and bind the docs contract after the candidate freeze**

```bash
node scripts/public-contract.mjs --check
node --test scripts/public-contract.test.mjs scripts/deployment-runbook.test.mjs
node scripts/public-contract.mjs --evidence \
  --frozen-sha "$FROZEN_SHA" \
  --output "artifacts/integration-readiness/$RUN_ID/docs-contract.json"
```

Expected: `status: PASS`, `drift_count: 0`, all owned public docs and applicable desktop/mobile diagram pairs are hashed, and the evidence binds to `FROZEN_SHA`. A tracked regeneration after this command supersedes the run.

---

### Task 8: `INTEGRATION-008` — Perform Independent Whole-Tree Review, Fix Through Owners, and Re-freeze

**Files:**
- Create at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/independent-review.md`
- Create at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/independent-review.json`
- Modify only through owning lanes: files named by review findings

- [ ] **Step 1: Commission an independent read-only review of the frozen tree**

The reviewer must not be the integration author or an owner of plans 03–14. Give the reviewer:

```text
BASE_SHA
FROZEN_SHA
all 21 review documents
the 128-row coverage ledger
all twelve lane plans and all sixteen exact node PR-head/integration-merge SHA pairs
Level 1–3 JSON and logs
public-contract JSON/Markdown
current workflow and release bundle
```

Require findings-first output with `Critical`, `Important`, `Minor`, file/line evidence, affected canonical IDs, violated gate, reproduction command, and whether the issue invalidates Levels 1, 2, or 3.

- [ ] **Step 2: Require adversarial whole-tree checks**

The reviewer must independently inspect at least:

```text
one authoritative learner outcome from browser input to persisted schedule and recap
one 45-second 44.1 kHz and one 45-second 48 kHz turn
one reconnect after unclean close and lease release
one citation challenge with zero grading/mastery mutation
one hostile upload/create response and size cap
one real Postgres delete, restart, and two-instance replay
one mismatched deploy/run/signature rejection
one timeout/consecutive-failure/rollback monitor chain
one dependency-audit and supply-chain pin trace
one strict raw-contract validation/import trace plus module-concentration owner/budget trace
one public-doc claim traced to executable evidence
```

Expected: review artifact is bound to `FROZEN_SHA`, names commands actually run, and contains no unverified `PASS`.

- [ ] **Step 3: Route every finding to its owner**

For any finding:

1. mark the current run `superseded`;
2. send the finding to the owning plan lane;
3. require the owner to author an exact corrective commit or review PR with RED, minimal fix, GREEN, and an adversarial control;
4. require affected-owner and independent-review approval of that exact diff;
5. return the approved diff to the Program coordinator, who incorporates it once as an explicit reconciliation commit without merging the lane branch a second time;
6. record the owner source commit/PR, coordinator reconciliation commit, affected paths/node/finding IDs, approvals, and focused gates, then rerun Task 2 against the new combined tip;
7. update lane-input correction history and ledger reconciliation without adding a seventeenth Program node;
8. regenerate public contracts if behavior changed;
9. compute a new `FROZEN_SHA` and `RUN_ID`;
10. rerun all Levels 1–3, not only the targeted test.

Integration may resolve final public-doc and integration-evidence conflicts it owns, but it may not patch production or workflow hotspots directly, merge a lane branch again, or classify the owner-authored correction as a new Program node.

- [ ] **Step 4: Run a closure review on the new frozen SHA**

The same independent reviewer or a second independent reviewer must verify every previous finding closed and inspect the new diff. `independent_review.status` becomes `PASS` only when there are no open Critical/Important/Minor findings affecting required acceptance. Deferred polish is not allowed if it maps to one of the 128 verified instances.

- [ ] **Step 5: Validate the candidate after the review/fix round**

```bash
node scripts/integration-readiness.mjs validate \
  --run-dir "artifacts/integration-readiness/$RUN_ID" \
  --frozen-sha "$FROZEN_SHA"
```

Expected: Levels 1–3 PASS, docs contract PASS, independent review PASS, clean worktree, all evidence bound to the same frozen SHA.

---

### Task 9: `INTEGRATION-009` — Record External Conditional Gates `OPS-01` Through `OPS-06`

**Files:**
- Modify at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/external-gates.json`
- Modify at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/release-readiness.md`

- [ ] **Step 1: `OPS-01` — GitHub Actions billing and exact-SHA hosted execution**

Push the frozen branch without changing it:

```bash
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
if test "$FROZEN_SHA" = "$(git rev-parse origin/main)"; then
  EVIDENCE_BRANCH=main
else
  test "$(git branch --show-current)" = "review-remediation/integration"
  git push --set-upstream origin review-remediation/integration
  EVIDENCE_BRANCH=review-remediation/integration
fi
gh workflow run Validate --ref "$EVIDENCE_BRANCH"
DISPATCHED_RUN_ID="$(gh run list --workflow Validate --branch "$EVIDENCE_BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$DISPATCHED_RUN_ID" --exit-status || true
gh run list --workflow Validate --branch "$EVIDENCE_BRANCH" --limit 20 \
  --json databaseId,headSha,status,conclusion,url \
  > "artifacts/integration-readiness/$RUN_ID/github-runs.json"
HOSTED_RUN_ID="$(node -e '
  const fs = require("node:fs");
  const runs = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const match = runs.find((run) => run.headSha === process.argv[2] && run.conclusion === "success");
  if (match) process.stdout.write(String(match.databaseId));
' "artifacts/integration-readiness/$RUN_ID/github-runs.json" "$FROZEN_SHA")"
test -n "$HOSTED_RUN_ID"
gh run view "$HOSTED_RUN_ID" --json databaseId,headSha,status,conclusion,jobs,url \
  > "artifacts/integration-readiness/$RUN_ID/github-run.json"
gh api "repos/$REPO/actions/runs/$HOSTED_RUN_ID/artifacts" \
  > "artifacts/integration-readiness/$RUN_ID/github-artifacts.json"
mkdir -p "artifacts/integration-readiness/$RUN_ID/github-download"
gh run download "$HOSTED_RUN_ID" \
  --dir "artifacts/integration-readiness/$RUN_ID/github-download"
```

Wait for the dispatched run to complete before selecting it; a non-success conclusion is evaluated by the `PASS`/`FAIL`/`BLOCKED_EXTERNAL` rules of this step, and inability to start the run at all maps to `GITHUB_ACTIONS_BILLING_UNAVAILABLE`. `PASS` requires a completed successful run whose `headSha` equals `FROZEN_SHA`, whose `quality-and-audit`, `loopback-and-browser`, and `durable-postgres` jobs each concluded `success`, whose aggregate `Required validation` check concluded `success`, and whose uploaded artifacts bind to that SHA. If Actions cannot start or is suspended by billing/minutes, record `BLOCKED_EXTERNAL` with code `GITHUB_ACTIONS_BILLING_UNAVAILABLE`. A local rerun cannot substitute.

- [ ] **Step 2: `OPS-02` — Branch protection and repository rulesets**

Refresh:

```bash
PROTECTION_BODY="$(mktemp)"
PROTECTION_ERROR="$(mktemp)"
if gh api "repos/$REPO/branches/main/protection" >"$PROTECTION_BODY" 2>"$PROTECTION_ERROR"; then
  cp "$PROTECTION_BODY" "artifacts/integration-readiness/$RUN_ID/main-protection.json"
elif rg -q 'HTTP 404|Not Found' "$PROTECTION_ERROR"; then
  printf '%s\n' '{"status":"UNPROTECTED","reason":"branch protection API returned 404"}' \
    > "artifacts/integration-readiness/$RUN_ID/main-protection.json"
else
  cat "$PROTECTION_ERROR" >&2
  exit 1
fi
gh api "repos/$REPO/rulesets" > "artifacts/integration-readiness/$RUN_ID/rulesets.json"
```

`PASS` requires enforced pull requests, no unreviewed direct pushes, administrator coverage or a documented audited break-glass actor, the exact stable required context `Required validation`, stale-review dismissal after code changes, and no bypass that lets the release owner skip evidence. The hosted run evidence separately proves that aggregate's three upstream job IDs all succeeded. If repo-admin action is unavailable, record `BLOCKED_EXTERNAL` with code `GITHUB_RULE_ADMIN_ACCESS_REQUIRED`. The 2026-08-23 observation of no protection/empty rulesets is not execution evidence.

- [ ] **Step 3: `OPS-03` — Railway exact deploy/run binding**

Deploy web, agent, and hosted monitor from `FROZEN_SHA`. Capture without exposing secrets:

```text
Railway project ID hash
service IDs/names
web deployment ID
agent deployment ID
monitor deployment ID
web deployed output-image digest
agent deployed output-image digest
monitor deployed output-image digest
agent/monitor pinned base-image digests and monitor Bun archive SHA-256 as separate build-input fields
web origin
agent origin
hosted monitor run ID and durable object prefix
in-band web/agent/monitor deploy_sha
deployment created_at timestamps
```

`PASS` requires all three in-band SHAs equal `FROZEN_SHA`; deployment IDs, pinned build-input digests, and deployed output-image digests are distinct typed fields; the hosted browser manifest uses the same run ID; `/live`, authenticated `/ready`, WSS, drain, rollback, restart, and durable publication pass; and the stored release bundle is verified after download. The hosted monitor must also execute two distinct synthetic/failure-control run IDs from fresh local artifact directories against `viva-hosted-monitor/state/live-monitor-state.v1.json`: the first finalizes consecutive failure state `1`, the second observes that state and atomically advances it to `2` using ETag compare-and-swap. Evidence must show idempotent run reservation/finalization, stale-ETag rejection, and manifest-last publication. A process-local counter, reused run directory, duplicate run ID, or manifest written before terminal state is failure. If project access, durable object-store access, or deployment is unavailable, record `BLOCKED_EXTERNAL` with code `RAILWAY_PROJECT_OR_DEPLOYMENT_UNAVAILABLE`.

Fetch the object selected by the exact hosted manifest into the Plan 12 consumption path, then verify it without regenerating or rewriting it:

```bash
test -f artifacts/downloaded-release/evidence.json
VIVA_RELEASE_BUNDLE_SIGNING_SECRET="$VIVA_RELEASE_BUNDLE_SIGNING_SECRET" \
  bun run release:verify -- artifacts/downloaded-release/evidence.json
```

The download command is the exact provider/object-store command recorded in the hosted manifest and `docs/deployment-runbook.md`; its selected object key, version ID/ETag, SHA-256, run ID, deploy IDs, and deploy SHA must be captured before the verifier runs. Selecting a lexicographic "latest" object is failure.

- [ ] **Step 4: `OPS-04` — Provider secrets, ZDR, quota, and live proof**

`PASS` requires current account/project ZDR confirmations, secret presence attested by the services that consume them, Gemini RPM/TPM evidence, Cartesia/Gemini model identity, the release cost cap, and a sanitized one-turn live smoke whose `deploy_sha`, `run_id`, environment, Railway deployment IDs, and Postgres durability match the frozen release identity. It must reach `recap_ready` and show zero forbidden hits. Never copy keys into the monitor or evidence merely to prove presence.

If ZDR approval, quota, secret-store access, or a budget-authorized run is unavailable, record `BLOCKED_EXTERNAL` with code `PROVIDER_ZDR_OR_SECRET_UNAVAILABLE`. Fake-provider evidence cannot become PASS for this gate.

- [ ] **Step 5: `OPS-05` — Real device, browser, microphone, and assistive technology**

Run and record this minimum matrix against the exact Railway web/agent deployment:

| Platform | Browser/AT | Required proof |
| --- | --- | --- |
| macOS | Safari + VoiceOver + real 44.1/48 kHz microphone | consent, record, 45 s submit, feedback, source, recap, transcript disclosure semantics, keyboard/focus |
| Windows | Chrome + NVDA + real microphone | same flow, announcements, focus, controls, reconnect |
| Windows | Firefox + keyboard + real microphone | same voice lifecycle and no protocol/frame failure |
| iOS | Safari + VoiceOver + device microphone | mobile targets, permissions, interruption/reconnect, recap |

Evidence may contain device/browser versions, sample rate, timing, event counts, accessibility observations, and sanitized screenshots with synthetic material. It must not contain raw audio, transcript, answers, provider payloads, secrets, or real learner identities. If the matrix cannot be run, record `BLOCKED_EXTERNAL` with code `DEVICE_BROWSER_OR_SCREENREADER_UNAVAILABLE`. Automated local Chromium is not PASS.

- [ ] **Step 6: `OPS-06` — Release owner decision**

The release owner reviews the exact JSON/Markdown bundle after `OPS-01` through `OPS-05`. A PASS record must contain:

```json
{
  "id": "OPS-06",
  "status": "PASS",
  "owner": "named accountable release owner",
  "decision": "proceed",
  "decided_at": "UTC timestamp",
  "frozen_sha": "same frozen SHA",
  "run_id": "same run ID",
  "web_deploy_id": "same bound web deployment ID",
  "agent_deploy_id": "same bound agent deployment ID",
  "release_bundle_sha256": "same independently verified bundle hash"
}
```

If no authorized owner is available or the owner has not decided, record `BLOCKED_EXTERNAL` with code `RELEASE_OWNER_DECISION_UNAVAILABLE`. Silence is never `proceed`.

---

### Task 10: `INTEGRATION-010` — Reconcile PRs, Ledger, Deploy Identity, and Emit the Final Status

**Files:**
- Modify before Task 2 freezes the tree: `scripts/integration-readiness.mjs`
- Modify before Task 2 freezes the tree: `scripts/integration-readiness.test.mjs`
- Modify before Task 2 freezes the tree: `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`
- Create at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/integration-readiness.json`
- Create at execution time, ignored: `artifacts/integration-readiness/$RUN_ID/integration-readiness.md`

- [ ] **Step 1: Write failing PR/ledger/deploy reconciliation tests**

Reject:

- a lane PR whose head commit is absent from `FROZEN_SHA`;
- an open remediation PR with no disposition;
- a merged PR whose merge commit is absent from `main` after reconciliation;
- a coverage row marked complete without proof at the frozen SHA;
- deployment IDs compared to Git SHAs as if they were the same type;
- a pinned base-image or Bun archive digest recorded as a deployed output-image digest;
- web/agent/monitor evidence with different run IDs or environments;
- a GitHub check whose `headSha` differs from `FROZEN_SHA`;
- a stored release bundle generated before the final review/fix SHA;
- any present `terminal_status` while a mandatory Levels 1–3/docs/ledger/review gate is non-PASS;
- `CODE_COMPLETE_EXTERNAL_GATES_PENDING` when any external gate is `FAIL`;
- `CODE_REMEDIATION_COMPLETE` when the external set is either all `PASS` or cleanly pending with no `FAIL`;
- `RELEASE_READY` with any external gate that is not `PASS`.

- [ ] **Step 2: Run reconciliation tests and verify RED**

```bash
node --test scripts/integration-readiness.test.mjs
```

Expected: FAIL until PR/ledger/deploy reconciliation is implemented.

- [ ] **Step 3: Implement exact deploy/run binding**

Require this typed structure for production:

```json
{
  "git": { "frozen_sha": "40 hex", "main_sha": "40 hex or null before merge" },
  "github": { "run_id": "numeric string", "run_attempt": 1, "head_sha": "same frozen SHA" },
  "release": { "run_id": "integration run ID", "bundle_sha256": "64 hex", "verified_at": "UTC" },
  "build_inputs": { "agent_base_image_digest": "sha256:64 hex", "monitor_base_image_digest": "sha256:64 hex", "monitor_bun_archive_sha256": "64 hex" },
  "web": { "deployment_id": "platform ID", "output_image_digest": "sha256:64 hex", "deploy_sha": "same frozen SHA", "origin": "https origin" },
  "agent": { "deployment_id": "platform ID", "output_image_digest": "sha256:64 hex", "deploy_sha": "same frozen SHA", "origin": "https origin" },
  "monitor": { "deployment_id": "platform ID", "output_image_digest": "sha256:64 hex", "deploy_sha": "same frozen SHA", "run_id": "same release run ID", "object_prefix": "immutable run prefix", "state_object_key": "viva-hosted-monitor/state/live-monitor-state.v1.json", "state_etag": "durable object ETag" },
  "hosted_browser": { "run_id": "same release run ID", "web_deployment_id": "same web ID", "agent_deployment_id": "same agent ID", "deploy_sha": "same frozen SHA" },
  "live_smoke": { "run_id": "same release run ID", "agent_deployment_id": "same agent ID", "deploy_sha": "same frozen SHA", "environment": "production" },
  "all_bindings_match": true
}
```

Deployment IDs, pinned build-input digests, deployed output-image digests, Git SHAs, object ETags, and run IDs are different types and must be compared only to their corresponding fields. A pinned base-image or Bun archive digest cannot satisfy a deployed output-image field.

- [ ] **Step 4: Reconcile every PR and ledger row**

Create or reuse one draft integration PR so every lane and final head has one durable ledger entry, then refresh PRs and exact heads:

```bash
git push --set-upstream origin review-remediation/integration
INTEGRATION_PR_NUMBER="$(gh pr list \
  --head review-remediation/integration \
  --base main \
  --state open \
  --json number \
  --jq '.[0].number // empty')"
if test -z "$INTEGRATION_PR_NUMBER"; then
  INTEGRATION_PR_URL="$(gh pr create \
    --draft \
    --base main \
    --head review-remediation/integration \
    --title "Integrate review remediation and release evidence" \
    --body "Integrates Plans 03-15. No release claim is made until the exact post-merge SHA satisfies the evidence ladder and OPS-01 through OPS-06.")"
  INTEGRATION_PR_NUMBER="${INTEGRATION_PR_URL##*/}"
fi
gh pr list --state all --limit 100 --json number,title,state,headRefName,headRefOid,baseRefName,mergeCommit,updatedAt,url
gh pr view "$INTEGRATION_PR_NUMBER" --json headRefOid,mergeStateStatus,statusCheckRollup,reviews,reviewDecision,commits,url
```

Creating this draft PR during the pre-freeze phase is a deliberate refinement of Program Section 2's sequencing sentence: the draft exists only as a durable reconciliation ledger anchor and makes no release claim; it is marked ready (`gh pr ready`) and merged solely in Step 7, after mandatory gates pass and a terminal-status evaluation exists, which preserves the Program's intent that no release PR reaches `main` before Plan 15 records a terminal status. Recording this refinement in the Program doc itself belongs to the Program coordinator's reconciliation, not to Plan 15.

For each of the sixteen Program node PRs, record `included_exact_head` with its already-verified integration merge commit; a required node cannot use `superseded_by_included_commit` or `excluded_with_reason`. Other historical/remediation PRs may use `superseded_by_included_commit` or `excluded_with_reason`, but exclusion cannot satisfy a coverage row. Reconcile the five reviewed stale PRs #94–#98 against current state rather than assuming they remain open. Plan 15 performs the final coverage-ledger edit only after the Program coordinator has validated the exact node history and the commit/proof checks pass; source lanes never write completion into the ledger. After Task 2 Step 7, push the frozen head and rerun `gh pr view`; its `headRefOid` must equal `FROZEN_SHA` before hosted credit or merge.

- [ ] **Step 5: Generate final JSON and Markdown from one source**

```bash
node scripts/integration-readiness.mjs finalize \
  --run-dir "artifacts/integration-readiness/$RUN_ID" \
  --frozen-sha "$FROZEN_SHA" \
  --json "artifacts/integration-readiness/$RUN_ID/integration-readiness.json" \
  --markdown "artifacts/integration-readiness/$RUN_ID/integration-readiness.md"
```

Expected:

- no `terminal_status` field if any Levels 1–3/docs/ledger/review gate is non-PASS; integration remains active;
- `CODE_REMEDIATION_COMPLETE` if every mandatory gate passes but the external set qualifies for neither all-PASS release nor clean fully reasoned pending—normally because an OPS gate is `FAIL`; this is not a release claim and the loop remains open;
- `CODE_COMPLETE_EXTERNAL_GATES_PENDING` if every mandatory gate passes, no OPS gate failed, and at least one OPS gate is `BLOCKED_EXTERNAL` with a complete recorded reason;
- `RELEASE_READY` only if every mandatory and external gate passes with exact binding, owner `proceed`, and `identity.frozen_sha == deploy_binding.git.main_sha == origin/main`. Before the integration PR merges, keep `OPS-06` blocked or record a separate non-terminal merge authorization; do not emit `RELEASE_READY` for a PR-only SHA.

- [ ] **Step 6: Independently verify the final stored bundle**

```bash
VIVA_RELEASE_BUNDLE_SIGNING_SECRET="$VIVA_RELEASE_BUNDLE_SIGNING_SECRET" \
  bun run release:verify -- artifacts/downloaded-release/evidence.json
node scripts/integration-readiness.mjs validate \
  --run-dir "artifacts/integration-readiness/$RUN_ID" \
  --frozen-sha "$FROZEN_SHA"
```

Expected: both PASS in separate processes at the evidence consumption boundary.

- [ ] **Step 7: Merge and recheck `main` only after required hosted gates permit it**

```bash
gh pr ready "$INTEGRATION_PR_NUMBER"
gh pr view "$INTEGRATION_PR_NUMBER" --json headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision,url
gh pr merge "$INTEGRATION_PR_NUMBER" --merge --match-head-commit "$FROZEN_SHA"
git fetch origin main --prune
MAIN_SHA="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$FROZEN_SHA" "$MAIN_SHA"
gh run list --workflow Validate --branch main --limit 20 --json databaseId,headSha,status,conclusion,url
```

Expected: merge is exact-head, `main` contains the PR's `FROZEN_SHA`, required protection was active at merge time, and a post-merge Validate run passes on `MAIN_SHA`.

GitHub's merge commit normally makes `MAIN_SHA` differ from the PR head. That identity change invalidates all same-SHA evidence. In that case run this exact transition and then repeat the normative proof loop; ancestry is not a substitute for exact-SHA proof:

```bash
if test "$MAIN_SHA" != "$FROZEN_SHA"; then
  SUPERSEDED_RUN_ID="$RUN_ID"
  node scripts/integration-readiness.mjs supersede \
    --run-dir "artifacts/integration-readiness/$SUPERSEDED_RUN_ID" \
    --superseded-by-sha "$MAIN_SHA"
  git switch --detach "$MAIN_SHA"
  FROZEN_SHA="$MAIN_SHA"
  RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
  mkdir -p "artifacts/integration-readiness/$RUN_ID"
  git show --no-patch --format='%H%n%P%n%aI%n%s' "$FROZEN_SHA" \
    > "artifacts/integration-readiness/$RUN_ID/frozen-commit.txt"
fi
```

On the post-merge SHA, rerun Task 3 Step 5, all Task 4 commands, Task 5 Steps 5–8, public-contract `--check`, Task 8's independent whole-tree closure review, and `OPS-01`–`OPS-06`. Redeploy web/agent/monitor from `MAIN_SHA`, download and verify the new exact-run bundle, and regenerate final JSON/Markdown. Only that post-merge run may become `RELEASE_READY`.

- [ ] **Step 8: Emit the post-merge final status and verify no tracked change occurred after the final freeze**

```bash
node scripts/integration-readiness.mjs finalize \
  --run-dir "artifacts/integration-readiness/$RUN_ID" \
  --frozen-sha "$FROZEN_SHA" \
  --json "artifacts/integration-readiness/$RUN_ID/integration-readiness.json" \
  --markdown "artifacts/integration-readiness/$RUN_ID/integration-readiness.md"
test -z "$(git status --porcelain=v1)"
test "$(git rev-parse HEAD)" = "$FROZEN_SHA"
git diff --check "$FROZEN_SHA^" "$FROZEN_SHA"
```

Expected: `artifacts/` remains ignored and uncommitted and HEAD still equals `FROZEN_SHA`. All tracked implementation, ledger, and docs work from Tasks 1, 3–7, and 10 must be committed before Task 2 Step 7. Any later tracked edit supersedes the run and requires a new freeze plus Levels 1–3.

---

## Completion checklist

- [ ] All sixteen Program nodes across plans 03–14 have exact PR commit arrays, heads, and integration-merge SHAs recorded and included in the frozen SHA; no lane branch was re-merged by Plan 15.
- [ ] Coverage ledger reconciliation reports 128/128 instances, 2 Critical, 44 Important, 82 Minor, with no unresolved code or decision row.
- [ ] Level 1 passes on the frozen SHA.
- [ ] Level 2 passes with forced TS, full Rust, browser, WS, release, redaction, audit, and adversarial controls.
- [ ] Level 3 passes against disposable PostgreSQL 16 with the full suite twice and every restart/multi-instance/concurrency/deletion canary.
- [ ] Public contracts regenerate deterministically and match shipped behavior.
- [ ] Independent whole-tree review and any owner-routed fix round are closed on the frozen SHA.
- [ ] `OPS-03` is honestly `BLOCKED_EXTERNAL`, or hosted monitor evidence proves durable ETag-CAS state `1` to `2` across distinct run IDs and deployed output-image digests are not confused with pinned build inputs.
- [ ] `OPS-01` through `OPS-06` are each either honestly `BLOCKED_EXTERNAL` or supported by exact evidence; none is inferred.
- [ ] Final JSON and Markdown validate, are sanitized, and bind all commands/artifacts/deploys/runs to one SHA.
- [ ] The final top-level status is exactly one of the three permitted values and satisfies its truth table.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-23-integrated-evidence-and-release-readiness.md`. Execute this plan only after Program Task 5 has integrated the exact Plans 03–14 source commits and proof handoffs as the sixteen-node DAG. Use subagent-driven execution for owner-routed corrections and a separate read-only reviewer for the whole-tree closure review. Plan 15 owns the final ledger/public-contract reconciliation; the Program coordinator validates integration history, and source lanes never self-certify ledger completion.
