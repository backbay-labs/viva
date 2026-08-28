// INTEGRATION-001 — the integration evidence contract and terminal classifier.
//
// Every schema branch, every classifier row, all three main-reconciliation states
// and the Markdown renderer are driven from fixtures here: all three terminal
// values, the no-emission state, and every FAIL / BLOCKED_EXTERNAL shape. Only the
// ownership-table and CLI tests read Git, and they use this repository's own HEAD
// so the hashing path runs for real. Negative controls are tables of `{dotted
// path: value}` patches over one valid base document, so a rule that stops firing
// cannot hide behind a bespoke fixture. Marker NAMES are spelled plainly and allowed to
// flag: the audit is never spelled around, and the coordinator supplies the sanction row
// (A-39.2). Fragment assembly is only for key-shaped VALUES a hosting scanner would match.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BLOCKED_EXTERNAL_REASON_CODES,
  EXTERNAL_GATE_IDS,
  INTEGRATION_EVIDENCE_SCHEMA,
  MAIN_RECONCILIATION_SCHEMA,
  PROGRAM_NODES,
  TERMINAL_STATUSES,
  assertFrozenIdentity,
  assertGeneratedMarkdown,
  deriveTerminalStatus,
  finalizeIntegrationEvidence,
  parseProgramOwnership,
  renderIntegrationMarkdown,
  validateIntegrationEvidence,
  validateMainReconciliation,
} from "./integration-readiness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "scripts", "integration-readiness.mjs");
const FROZEN_SHA = "0123456789abcdef0123456789abcdef01234567";
const MAIN_SHA = "4d5d8276f03635ca74c04f4d500d13ce62198dd0";
const RUN_ID = "20260823T180000Z-0123456789ab";
const NEVER = "ffffffffffffffffffffffffffffffffffffffff";
const hex = (length, seed) => createHash("sha256").update(seed).digest("hex").slice(0, length);
const sha = (seed) => hex(40, seed);

// --- Fixtures ---

const identity = () => ({
  repository: "backbay-labs/viva",
  branch: "review-remediation/integration",
  audit_base_sha: MAIN_SHA,
  live_main_sha_at_start: MAIN_SHA,
  live_main_sha_at_freeze: MAIN_SHA,
  frozen_sha: FROZEN_SHA,
  worktree_clean: true,
  frozen_at: "2026-08-23T18:00:00.000Z",
});

const command = (id, status) => ({
  id,
  argv: ["bunx", "turbo", "run", "typecheck", "lint", "test", "build", "--force"],
  cwd: ".",
  started_at: "2026-08-23T18:00:00.000Z",
  finished_at: "2026-08-23T18:05:00.000Z",
  duration_ms: 300000,
  exit_code: 0,
  status,
  frozen_sha: FROZEN_SHA,
  stdout_sha256: hex(64, `${id}-stdout`),
  stderr_sha256: hex(64, `${id}-stderr`),
  cache_mode: "forced",
});

const artifact = (id, relative) => ({
  id,
  path: `artifacts/integration-readiness/${RUN_ID}/${relative}`,
  media_type: "application/json",
  sha256: hex(64, id),
  bytes: 12345,
  created_at: "2026-08-23T18:05:00.000Z",
  frozen_sha: FROZEN_SHA,
  run_id: RUN_ID,
  sanitized: true,
  forbidden_hits: 0,
});

const level = (id, status) => ({
  status,
  commands: [command(`${id}_command`, status)],
  artifacts: [artifact(`${id}_artifact`, `${id}/evidence.json`)],
});

const gateEvidence = (id, overrides = {}) => ({
  owner: "release-operations",
  executed_at: "2026-08-23T18:10:00.000Z",
  attempted: `exact command executed for ${id}`,
  observed_state: `exact externally observed state for ${id}`,
  reproduction: `node scripts/integration-readiness.mjs external --gate ${id}`,
  artifacts: [artifact(`${id.toLowerCase().replace("-", "_")}_evidence`, `external/${id}.json`)],
  materialized_reason: null,
  ...overrides,
});

const skipReason = (id, overrides = {}) => ({
  code: BLOCKED_EXTERNAL_REASON_CODES[EXTERNAL_GATE_IDS.indexOf(id)],
  owner: "release-operations",
  blocked_at: "2026-08-23T18:00:00.000Z",
  attempted: `exact command or URL attempted for ${id}`,
  last_observed_state: "project access denied",
  required_action: `Grant the ${id} accountable owner access and rerun on the frozen SHA.`,
  required_evidence: "Deployment IDs, image digests, origins, and in-band SHAs on the frozen SHA.",
  next_check_at: "2026-08-24T18:00:00.000Z",
  applies_to_frozen_sha: FROZEN_SHA,
  ...overrides,
});

const passGate = (id) => ({ id, status: "PASS", evidence: gateEvidence(id) });
const failGate = (id) => ({ id, status: "FAIL", evidence: gateEvidence(id) });
const blockedGate = (id) => ({ id, status: "BLOCKED_EXTERNAL", skip_reason: skipReason(id) });
const gatesWith = (id, build) => EXTERNAL_GATE_IDS.map((g) => (g === id ? build(g) : passGate(g)));

const laneInputs = () =>
  PROGRAM_NODES.map((node, index) => ({
    node_id: node.node_id,
    topological_rank: node.topological_rank,
    namespace: node.namespace,
    split_phase: node.split_phase,
    plan_path: node.plan_path,
    branch: node.branch,
    pr_number: 101 + index,
    pr_url: prUrl(101 + index),
    pr_commit_shas: [sha(`${node.node_id}-c1`), sha(`${node.node_id}-head`)],
    pr_head_sha: sha(`${node.node_id}-head`),
    integration_merge_sha: sha(`${node.node_id}-merge`),
    merge_parent_shas: [sha(`${node.node_id}-base`), sha(`${node.node_id}-head`)],
    predecessor_node_ids: [...node.predecessor_node_ids],
    // D-06B DELETE is the recorded decision; only the 13B/14B rows carry it.
    decision_branch: ["13B", "14B"].includes(node.node_id) ? ["D-06B"] : [],
    included_in_frozen_sha: true,
    finding_ids: [`FIND-${node.node_id}`],
    proof_artifacts: [`artifacts/lane-proof/${node.node_id}.json`],
    owner_acknowledged_handoff: true,
  }));

const NO_MERGE = { reconciliation_merge_sha: null, artifact: null };
const prUrl = (number) => `https://github.com/backbay-labs/viva/pull/${number}`;
const firstParent = () => PROGRAM_NODES.map((node) => sha(`${node.node_id}-merge`));

const mergedPullRequests = () =>
  PROGRAM_NODES.map((node, index) => ({
    number: 101 + index,
    headRefName: node.branch,
    mergeCommit: { oid: sha(`${node.node_id}-merge`) },
  }));

const evidence = (overrides = {}) => ({
  schema: INTEGRATION_EVIDENCE_SCHEMA,
  run_id: RUN_ID,
  generated_at: "2026-08-23T18:00:00.000Z",
  identity: identity(),
  lane_inputs: laneInputs(),
  main_reconciliation: { status: "NOT_REQUIRED", live_main_sha: MAIN_SHA, ...NO_MERGE },
  program_reconciliations: [],
  coverage: {
    component_finding_instances_expected: 128,
    component_finding_instances_reconciled: 128,
    unresolved_rows: [],
    ledger_sha256: hex(64, "ledger"),
  },
  levels: {
    level_1: level("level_1", "PASS"),
    level_2: level("level_2", "FAIL"),
    level_3: level("level_3", "FAIL"),
  },
  docs_contract: { status: "FAIL", artifacts: [] },
  independent_review: { status: "FAIL", findings: [], artifact: null },
  external_gates: [],
  deploy_binding: null,
  release_owner: null,
  supersedes_run_id: null,
  sanitized: true,
  ...overrides,
});

/** Mandatory Levels 1-3 / docs / ledger / review all PASS; externals as supplied. */
const mandatoryComplete = (externalGates, overrides = {}) =>
  evidence({
    levels: {
      level_1: level("level_1", "PASS"),
      level_2: level("level_2", "PASS"),
      level_3: level("level_3", "PASS"),
    },
    docs_contract: { status: "PASS", artifacts: [artifact("docs_contract", "docs-contract.json")] },
    independent_review: {
      status: "PASS",
      findings: [],
      artifact: artifact("independent_review", "review.json"),
    },
    external_gates: externalGates,
    ...overrides,
  });

const deployBinding = () => ({
  frozen_sha: FROZEN_SHA,
  run_id: RUN_ID,
  services: ["web", "agent", "monitor"].map((name) => ({
    name,
    deployment_id: `deploy-${name}`,
    image_digest: `sha256:${hex(64, `image-${name}`)}`,
    origin: `https://${name}.example.invalid`,
    in_band_sha: FROZEN_SHA,
  })),
});

const releaseOwner = (decision) => ({
  owner: "named-release-owner",
  decision,
  decided_at: "2026-08-23T19:00:00.000Z",
  artifact: artifact("release_decision", "release-decision.json"),
});

/** A RELEASE_READY document: all six gates PASS, bound deploy identity, `proceed`. */
const releaseReady = () =>
  mandatoryComplete(EXTERNAL_GATE_IDS.map(passGate), {
    deploy_binding: deployBinding(),
    release_owner: releaseOwner("proceed"),
    terminal_status: "RELEASE_READY",
  });

const review = (role, status) => ({
  role,
  actor: `${role.toLowerCase()}-actor`,
  status,
  reviewed_at: "2026-08-23T17:00:00.000Z",
});

const mainReconciliation = (overrides = {}) => ({
  schema: MAIN_RECONCILIATION_SCHEMA,
  audit_base_sha: MAIN_SHA,
  live_main_sha: MAIN_SHA,
  previous_combined_tip_sha: sha("combined-tip"),
  main_only_commits: [],
  changed_paths: [],
  path_owner_dispositions: [],
  conflicts: [],
  affected_node_ids: [],
  affected_finding_ids: [],
  focused_gates: [],
  requester_role: "PLAN_15_EVIDENCE",
  program_coordinator_review: null,
  affected_owner_reviews: [],
  independent_review: null,
  merge_actor_role: null,
  reconciliation_merge_sha: null,
  post_reconciliation_tip_sha: null,
  status: "NOT_REQUIRED",
  ...overrides,
});

const reviewRequired = (overrides = {}) =>
  mainReconciliation({
    status: "REVIEW_REQUIRED",
    live_main_sha: sha("live-main"),
    main_only_commits: [
      { sha: sha("main-only-1"), authored_at: "2026-08-23T12:00:00.000Z", subject: "fix: docs" },
    ],
    changed_paths: ["apps/web/proxy.ts"],
    path_owner_dispositions: [
      { path: "apps/web/proxy.ts", owner_namespace: "WEBAPI", disposition: "OWNER_REVIEW_REQUIRED" },
    ],
    affected_node_ids: ["11"],
    affected_finding_ids: ["FIND-11"],
    focused_gates: [{ id: "web_api_security", status: "ACTIVE" }],
    ...overrides,
  });

const reconciled = (overrides = {}) =>
  reviewRequired({
    status: "RECONCILED",
    conflicts: [
      {
        path: "apps/web/proxy.ts",
        resolution: "kept the live-main header ordering and re-ran the focused gate",
        resolved_by: "program-coordinator",
        review_status: "APPROVED",
      },
    ],
    focused_gates: [{ id: "web_api_security", status: "PASS" }],
    program_coordinator_review: review("PROGRAM_COORDINATOR", "APPROVED"),
    affected_owner_reviews: [{ owner_namespace: "WEBAPI", ...review("OWNER", "APPROVED") }],
    independent_review: review("INDEPENDENT", "APPROVED"),
    merge_actor_role: "PROGRAM_COORDINATOR",
    reconciliation_merge_sha: sha("reconciliation-merge"),
    post_reconciliation_tip_sha: sha("post-reconciliation-tip"),
    ...overrides,
  });

// --- Patch/assert helpers ---

const options = (extra = {}) => ({ isAncestor: () => true, ...extra });

/** Applies `{dotted path: value}` edits to a deep clone; `undefined` deletes the key. */
function patch(base, changes) {
  const document = structuredClone(base);
  for (const [dotted, value] of Object.entries(changes)) {
    const keys = dotted.split(".");
    let cursor = document;
    for (const key of keys.slice(0, -1)) cursor = cursor[key];
    if (value === undefined) delete cursor[keys.at(-1)];
    else cursor[keys.at(-1)] = value;
  }
  return document;
}

const invalid = (document, expected, extra = {}) =>
  assert.throws(() => validateIntegrationEvidence(document, options(extra)), expected);

const rejects = (changes, expected, base = evidence(), extra = {}) =>
  invalid(patch(base, changes), expected, extra);

const laneIndex = (id) => PROGRAM_NODES.findIndex((node) => node.node_id === id);
const lane = (id, field) => `lane_inputs.${laneIndex(id)}.${field}`;
const laneOf = (document, id) => document.lane_inputs[laneIndex(id)];

const rejectsMain = (document, expected, extra = {}) =>
  assert.throws(() => validateMainReconciliation(document, options(extra)), expected);

// --- Frozen constants and the Program manifest ---

test("the contract exports the exact frozen schema, status, gate, and reason constants", () => {
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
});

test("the Program manifest is exactly the sixteen nodes and the predecessor matrix", () => {
  assert.deepEqual(
    PROGRAM_NODES.map((n) => [
      n.node_id,
      n.topological_rank,
      n.namespace,
      n.split_phase,
      n.predecessor_node_ids,
    ]),
    [
      ["03", 0, "CRIT", null, []],
      ["04A", 1, "LEARN", "A", ["03"]],
      ["05", 1, "VOICE", null, ["03"]],
      ["12A", 1, "RELEASE", "A", ["03"]],
      ["13A", 2, "FRONTEND", "A", ["03", "12A"]],
      ["06", 2, "DOMAIN", null, ["03", "04A", "12A"]],
      ["04B", 3, "LEARN", "B", ["06"]],
      ["14A", 4, "PACKAGE", "A", ["03", "04B"]],
      ["07", 4, "ADAPTER", null, ["04B", "05", "06"]],
      ["09", 4, "DATA", null, ["04B", "06"]],
      ["08", 5, "SERVICE", null, ["04B", "05", "06", "09"]],
      ["11", 6, "WEBAPI", null, ["05", "08", "14A"]],
      ["10", 7, "WEBSESSION", null, ["04B", "05", "08", "11", "12A", "13A", "14A"]],
      ["13B", 8, "FRONTEND", "B", ["10", "11"]],
      ["14B", 9, "PACKAGE", "B", ["13B", "14A"]],
      ["12B", 10, "RELEASE", "B", ["07", "08", "09", "10", "11", "13B", "14B"]],
    ],
  );
  assert.equal(new Set(PROGRAM_NODES.map((node) => node.namespace)).size, 12);
  assert.equal(PROGRAM_NODES[laneIndex("13A")].branch, "review-remediation/13-frontend");
  assert.equal(
    PROGRAM_NODES[laneIndex("09")].plan_path,
    "docs/superpowers/plans/2026-08-23-persistence-postgres-privacy.md",
  );
});

// --- Frozen identity ---

test("assertFrozenIdentity accepts a fully bound active document", () => {
  assert.equal(assertFrozenIdentity(evidence(), options()).frozen_sha, FROZEN_SHA);
});

test("assertFrozenIdentity rejects unbound, malformed, or unclean frozen identity", () => {
  const table = [
    [{ "identity.audit_base_sha": FROZEN_SHA.toUpperCase() }, /40 lowercase hex/],
    [{ "identity.live_main_sha_at_start": "0123456789abcdef" }, /40 lowercase hex/],
    [{ "identity.live_main_sha_at_freeze": `${FROZEN_SHA}0` }, /40 lowercase hex/],
    [{ "identity.frozen_sha": "not-a-sha" }, /40 lowercase hex/],
    [{ "identity.worktree_clean": false }, /worktree_clean/],
    [{ "identity.frozen_at": "2026-08-23 18:00" }, /frozen_at/],
    [{ "identity.repository": "" }, /repository/],
    [{ "levels.level_1.commands.0.frozen_sha": sha("other") }, /not bound to identity/],
    [{ "levels.level_1.artifacts.0.frozen_sha": sha("other") }, /not bound to identity/],
    [{ "levels.level_1.artifacts.0.run_id": "20260823T180000Z-ffffffffffff" }, /not bound to/],
  ];
  for (const [changes, expected] of table) {
    assert.throws(() => assertFrozenIdentity(patch(evidence(), changes), options()), expected);
  }
});

test("assertFrozenIdentity rejects a live main SHA that is not an ancestor of the frozen SHA", () => {
  assert.throws(
    () =>
      assertFrozenIdentity(patch(evidence(), { "identity.live_main_sha_at_freeze": NEVER }), {
        isAncestor: (ancestor) => ancestor !== NEVER,
      }),
    /live_main_sha_at_freeze is not an ancestor of frozen_sha/,
  );
});

// --- Top-level schema, without coercion ---

test("the active mandatory-evidence document validates and omits terminal_status", () => {
  const document = validateIntegrationEvidence(evidence(), options());
  assert.equal(Object.hasOwn(document, "terminal_status"), false);
  assert.equal(deriveTerminalStatus(document), undefined);
});

test("the top-level schema rejects unknown, missing, and coerced fields", () => {
  const table = [
    [{ extra_field: true }, /unknown field: extra_field/],
    [{ supersedes_run_id: undefined }, /missing field: supersedes_run_id/],
    [{ deploy_binding: undefined }, /missing field: deploy_binding/],
    [{ schema: "viva.integration_readiness.v2" }, /schema must be viva\.integration_readiness\.v1/],
    [{ run_id: "2026-08-23-run" }, /run_id/],
    [{ run_id: "20260823T180000Z-0123456789AB" }, /run_id/],
    [{ generated_at: "2026-08-23 18:00:00" }, /generated_at/],
    [{ generated_at: "2026-08-23T18:00:00+02:00" }, /generated_at/],
    [{ sanitized: "true" }, /sanitized/],
    [{ sanitized: false }, /sanitized/],
    [{ supersedes_run_id: "run-1" }, /supersedes_run_id/],
    [{ program_reconciliations: {} }, /program_reconciliations/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected);
});

test("command records are validated without coercion", () => {
  const at = (field) => `levels.level_1.commands.0.${field}`;
  const table = [
    [{ [at("exit_code")]: "0" }, /exit_code/],
    [{ [at("duration_ms")]: 300000.5 }, /duration_ms/],
    [{ [at("duration_ms")]: -1 }, /duration_ms/],
    [{ [at("argv")]: "bunx turbo run build" }, /argv/],
    [{ [at("argv")]: [] }, /argv/],
    [{ [at("stdout_sha256")]: hex(64, "x").toUpperCase() }, /stdout_sha256/],
    [{ [at("stderr_sha256")]: hex(32, "x") }, /stderr_sha256/],
    [{ [at("cache_mode")]: "cached" }, /cache_mode/],
    [{ [at("status")]: "BLOCKED_EXTERNAL" }, /mandatory gate cannot use BLOCKED_EXTERNAL/],
    [{ [at("cwd")]: "/home/connor" }, /cwd/],
    [{ [at("finished_at")]: "2026-08-23T17:00:00.000Z" }, /finished_at/],
    [{ [at("id")]: undefined }, /command id is required/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected);
});

test("artifact records must be sanitized and repository-relative under ignored artifacts/", () => {
  const at = (field) => `levels.level_1.artifacts.0.${field}`;
  const table = [
    [{ [at("path")]: "/tmp/evidence.json" }, /artifact path/],
    [{ [at("path")]: "docs/evidence.json" }, /artifact path/],
    [{ [at("path")]: "artifacts/../docs/evidence.json" }, /artifact path/],
    [{ [at("path")]: "artifacts/integration/../../etc/evidence.json" }, /artifact path/],
    [{ [at("path")]: "artifacts" }, /artifact path/],
    [{ [at("forbidden_hits")]: 1 }, /forbidden_hits/],
    [{ [at("sanitized")]: false }, /sanitized/],
    [{ [at("bytes")]: -3 }, /bytes/],
    [{ [at("sha256")]: hex(63, "x") }, /sha256/],
    [{ [at("media_type")]: "" }, /media_type/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected);
});

test("the evidence document rejects a REVIEW_REQUIRED main reconciliation and bad coverage", () => {
  const table = [
    [
      { "main_reconciliation.status": "REVIEW_REQUIRED" },
      /main_reconciliation\.status must be NOT_REQUIRED or RECONCILED/,
    ],
    [
      { "coverage.component_finding_instances_reconciled": 127 },
      /coverage reconciliation expected 128 instances/,
    ],
    [
      { "coverage.component_finding_instances_expected": 130 },
      /coverage reconciliation expected 128 instances/,
    ],
    [{ "coverage.unresolved_rows": ["Index R7"] }, /unresolved_rows/],
    [{ "coverage.ledger_sha256": hex(32, "ledger") }, /ledger_sha256/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected);
});

// --- Mandatory gate rules ---

test("terminal_status is forbidden while any mandatory gate is non-PASS", () => {
  for (const status of TERMINAL_STATUSES) {
    rejects({ terminal_status: status }, /terminal_status is forbidden while a mandatory gate/);
  }
});

test("a mandatory gate may never be recorded as BLOCKED_EXTERNAL", () => {
  for (const field of [
    "levels.level_1.status",
    "levels.level_3.status",
    "docs_contract.status",
    "independent_review.status",
  ]) {
    rejects({ [field]: "BLOCKED_EXTERNAL" }, /mandatory gate cannot use BLOCKED_EXTERNAL/);
  }
  rejects({ "levels.level_2.status": "SKIPPED" }, /status must be/);
});

test("a recorded terminal_status must be legal and equal to the derived classification", () => {
  const ready = releaseReady();
  rejects(
    { terminal_status: "CODE_REMEDIATION_COMPLETE" },
    /terminal_status does not match the derived classification/,
    ready,
  );
  rejects({ terminal_status: "SHIP_IT" }, /terminal_status must be one of/, ready);
});

test("RELEASE_READY requires the bound deploy identity and a release owner `proceed`", () => {
  const ready = releaseReady();
  assert.equal(validateIntegrationEvidence(ready, options()).terminal_status, "RELEASE_READY");
  const table = [
    [{ release_owner: releaseOwner("hold") }, /RELEASE_READY requires release owner decision/],
    [{ release_owner: null }, /RELEASE_READY requires release owner decision/],
    [{ deploy_binding: null }, /RELEASE_READY requires a deploy binding/],
    [{ "deploy_binding.services.0.in_band_sha": sha("wrong") }, /deploy_binding/],
    [{ "deploy_binding.services.0.name": "worker" }, /deploy_binding/],
    [{ "deploy_binding.run_id": "20260823T180000Z-ffffffffffff" }, /deploy_binding/],
    [{ "release_owner.decision": "maybe" }, /release_owner/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected, ready);
});

// --- External gate rules ---

test("a PASS external gate cannot carry a skip reason and a FAIL must name executed proof", () => {
  const table = [
    [
      gatesWith("OPS-01", (id) => ({ ...passGate(id), skip_reason: skipReason(id) })),
      /OPS-01: PASS gate cannot carry skip_reason/,
    ],
    [
      gatesWith("OPS-04", (id) => ({ ...failGate(id), skip_reason: skipReason(id) })),
      /OPS-04: FAIL gate cannot carry skip_reason/,
    ],
    [
      gatesWith("OPS-04", (id) => ({
        id,
        status: "FAIL",
        evidence: gateEvidence(id, { artifacts: [] }),
      })),
      /OPS-04: recorded gate must name executed evidence/,
    ],
    [
      gatesWith("OPS-04", (id) => ({
        id,
        status: "FAIL",
        evidence: gateEvidence(id, { reproduction: "" }),
      })),
      /OPS-04: recorded gate must name its reproduction/,
    ],
    [
      gatesWith("OPS-02", (id) => ({ id, status: "BLOCKED_EXTERNAL", evidence: gateEvidence(id) })),
      /OPS-02: BLOCKED_EXTERNAL gate requires skip_reason/,
    ],
    [gatesWith("OPS-02", (id) => ({ id, status: "ACTIVE" })), /OPS-02: status must be/],
  ];
  for (const [gates, expected] of table) invalid(mandatoryComplete(gates), expected);
});

test("a BLOCKED_EXTERNAL gate must carry every skip-reason field", () => {
  const fields = `code owner blocked_at attempted last_observed_state required_action
    required_evidence next_check_at applies_to_frozen_sha`.split(/\s+/);
  for (const field of fields) {
    const gates = gatesWith("OPS-03", blockedGate);
    delete gates[2].skip_reason[field];
    invalid(mandatoryComplete(gates), new RegExp(`OPS-03: skip_reason\\.${field}`));
  }
});

test("a BLOCKED_EXTERNAL reason binds to its gate, the frozen SHA, and UTC instants", () => {
  const table = [
    [{ applies_to_frozen_sha: sha("other") }, /applies_to_frozen_sha/],
    [{ code: "GITHUB_ACTIONS_BILLING_UNAVAILABLE" }, /skip_reason\.code/],
    [{ code: "NOT_A_RECORDED_CODE" }, /skip_reason\.code/],
    [{ blocked_at: "2026-08-23T18:00:00+02:00" }, /skip_reason\.blocked_at/],
    [{ next_check_at: "tomorrow" }, /skip_reason\.next_check_at/],
    [{ attempted: "" }, /skip_reason\.attempted/],
    [{ owner: "  " }, /skip_reason\.owner/],
  ];
  for (const [overrides, expected] of table) {
    const gates = gatesWith("OPS-03", (id) => ({
      id,
      status: "BLOCKED_EXTERNAL",
      skip_reason: skipReason(id, overrides),
    }));
    invalid(mandatoryComplete(gates), expected);
  }
});

test("a mandatory-complete document requires exactly OPS-01 through OPS-06, once each", () => {
  const table = [
    [EXTERNAL_GATE_IDS.slice(0, 5).map(passGate), /required external gate is missing: OPS-06/],
    [[...EXTERNAL_GATE_IDS.map(passGate), passGate("OPS-02")], /duplicate external gate: OPS-02/],
    [[...EXTERNAL_GATE_IDS.map(passGate), passGate("OPS-07")], /unknown external gate: OPS-07/],
  ];
  for (const [gates, expected] of table) invalid(mandatoryComplete(gates), expected);
});

test("while a mandatory gate is non-PASS the external gates may be empty or partial", () => {
  assert.equal(validateIntegrationEvidence(evidence(), options()).external_gates.length, 0);
  const partial = evidence({ external_gates: [blockedGate("OPS-03")] });
  assert.equal(validateIntegrationEvidence(partial, options()).external_gates.length, 1);
  assert.equal(deriveTerminalStatus(partial), undefined);
});

// --- Terminal classifier decision table ---

test("row 1: any non-pass mandatory gate returns undefined and omits terminal_status", () => {
  for (const changes of [
    { "levels.level_2.status": "FAIL" },
    { "levels.level_3.status": "ACTIVE" },
    { "docs_contract.status": "FAIL" },
    { "independent_review.status": "FAIL" },
    { "coverage.component_finding_instances_reconciled": 127 },
    { "main_reconciliation.status": "REVIEW_REQUIRED" },
  ]) {
    const base = mandatoryComplete(EXTERNAL_GATE_IDS.map(passGate));
    assert.equal(deriveTerminalStatus(patch(base, changes)), undefined);
  }
});

test("row 2: all mandatory pass and all six external gates PASS derives RELEASE_READY", () => {
  assert.equal(deriveTerminalStatus(releaseReady()), "RELEASE_READY");
});

test("row 3: no external FAIL plus a fully reasoned block derives the pending status", () => {
  const document = mandatoryComplete(gatesWith("OPS-03", blockedGate));
  assert.equal(deriveTerminalStatus(document), "CODE_COMPLETE_EXTERNAL_GATES_PENDING");
  assert.notEqual(deriveTerminalStatus(document), "RELEASE_READY");
});

test("row 4: any external FAIL derives CODE_REMEDIATION_COMPLETE and keeps the loop open", () => {
  const document = mandatoryComplete(gatesWith("OPS-05", failGate));
  assert.equal(deriveTerminalStatus(document), "CODE_REMEDIATION_COMPLETE");
  assert.notEqual(deriveTerminalStatus(document), "RELEASE_READY");
});

test("external FAIL takes precedence over a fully reasoned BLOCKED_EXTERNAL", () => {
  const gates = EXTERNAL_GATE_IDS.map((id) => {
    if (id === "OPS-05") return failGate(id);
    if (id === "OPS-03") return blockedGate(id);
    return passGate(id);
  });
  assert.equal(deriveTerminalStatus(mandatoryComplete(gates)), "CODE_REMEDIATION_COMPLETE");
});

// --- Finalizer ---

test("the finalizer materializes an omitted required external gate as a named FAIL", () => {
  const document = finalizeIntegrationEvidence(
    mandatoryComplete(EXTERNAL_GATE_IDS.slice(0, 5).map(passGate)),
    options(),
  );
  const materialized = document.external_gates.at(-1);
  assert.equal(materialized.id, "OPS-06");
  assert.equal(materialized.status, "FAIL");
  assert.equal(materialized.evidence.materialized_reason, "REQUIRED_GATE_OMITTED");
  assert.equal(Object.hasOwn(materialized, "skip_reason"), false);
  assert.equal(document.terminal_status, "CODE_REMEDIATION_COMPLETE");
  assert.deepEqual(
    document.external_gates.map((gate) => gate.id),
    EXTERNAL_GATE_IDS,
  );
});

test("the finalizer materializes an unreasoned block as FAIL, never a silent coercion", () => {
  const gates = gatesWith("OPS-03", blockedGate);
  delete gates[2].skip_reason.required_evidence;
  const document = finalizeIntegrationEvidence(mandatoryComplete(gates), options());
  assert.equal(document.external_gates[2].status, "FAIL");
  assert.equal(
    document.external_gates[2].evidence.materialized_reason,
    "INCOMPLETE_EXTERNAL_REASON",
  );
  assert.equal(document.terminal_status, "CODE_REMEDIATION_COMPLETE");
});

test("the finalizer keeps a complete block pending and emits nothing while mandatory is red", () => {
  const pending = finalizeIntegrationEvidence(
    mandatoryComplete(gatesWith("OPS-03", blockedGate)),
    options(),
  );
  assert.equal(pending.external_gates[2].status, "BLOCKED_EXTERNAL");
  assert.equal(pending.terminal_status, "CODE_COMPLETE_EXTERNAL_GATES_PENDING");

  const active = finalizeIntegrationEvidence(evidence(), options());
  assert.equal(Object.hasOwn(active, "terminal_status"), false);
  assert.deepEqual(active.external_gates, []);
});

// --- Main reconciliation ---

test("NOT_REQUIRED proves live-main ancestry and carries empty delta and review fields", () => {
  assert.equal(validateMainReconciliation(mainReconciliation(), options()).status, "NOT_REQUIRED");
  rejectsMain(
    mainReconciliation(),
    /live_main_sha is not an ancestor of previous_combined_tip_sha/,
    { isAncestor: () => false },
  );
  rejectsMain(
    mainReconciliation({ changed_paths: ["apps/web/proxy.ts"] }),
    /NOT_REQUIRED requires empty delta fields/,
  );
  rejectsMain(
    mainReconciliation({ independent_review: review("INDEPENDENT", "APPROVED") }),
    /NOT_REQUIRED requires null review and merge fields/,
  );
});

test("REVIEW_REQUIRED records the exact main-only delta with null approval and merge fields", () => {
  assert.equal(
    validateMainReconciliation(reviewRequired(), options()).requester_role,
    "PLAN_15_EVIDENCE",
  );
  rejectsMain(
    reviewRequired({ main_only_commits: [], changed_paths: [] }),
    /REVIEW_REQUIRED requires the exact main-only commits and paths/,
  );
  rejectsMain(
    reviewRequired({ independent_review: review("INDEPENDENT", "APPROVED") }),
    /REVIEW_REQUIRED requires null review and merge fields/,
  );
  rejectsMain(reviewRequired({ requester_role: "PROGRAM_COORDINATOR" }), /requester_role/);
  rejectsMain(mainReconciliation({ status: "MERGED" }), /status must be/);
});

test("RECONCILED requires coordinator, owner, and independent approvals plus PASS focused gates", () => {
  assert.equal(validateMainReconciliation(reconciled(), options()).status, "RECONCILED");
  const table = [
    [{ affected_owner_reviews: [] }, /RECONCILED requires an approval from every affected owner/],
    [
      { program_coordinator_review: review("PROGRAM_COORDINATOR", "PENDING") },
      /program_coordinator_review/,
    ],
    [{ independent_review: null }, /independent_review/],
    [{ focused_gates: [{ id: "web_api_security", status: "FAIL" }] }, /focused gate/],
    [{ focused_gates: [] }, /focused gate/],
    [{ post_reconciliation_tip_sha: null }, /post_reconciliation_tip_sha/],
    [{ merge_actor_role: "PLAN_15_EVIDENCE" }, /merge_actor_role must be PROGRAM_COORDINATOR/],
    [
      { conflicts: [{ ...reconciled().conflicts[0], review_status: "PENDING" }] },
      /conflict resolution is unreviewed/,
    ],
    [
      { changed_paths: ["apps/web/proxy.ts", "apps/web/app/page.tsx"] },
      /changed path has no owner disposition: apps\/web\/app\/page\.tsx/,
    ],
  ];
  for (const [overrides, expected] of table) rejectsMain(reconciled(overrides), expected);
});

test("a reconciliation may never re-merge a recorded lane PR head or integration merge", () => {
  const extra = { laneInputs: laneInputs() };
  rejectsMain(
    reconciled({ reconciliation_merge_sha: sha("13B-merge") }),
    /second merge of a recorded lane/,
    extra,
  );
  rejectsMain(
    reconciled({
      main_only_commits: [
        { sha: sha("11-head"), authored_at: "2026-08-23T12:00:00.000Z", subject: "lane head" },
      ],
    }),
    /second merge of a recorded lane/,
    extra,
  );
});

// --- Program inputs: sixteen nodes, the DAG, ownership, and duplicate merges ---

test("the sixteen-node manifest with first-parent history and merged PR list validates", () => {
  const document = validateIntegrationEvidence(
    evidence(),
    options({ firstParent: firstParent(), mergedPullRequests: mergedPullRequests() }),
  );
  assert.equal(document.lane_inputs.length, 16);
});

test("one combined 04, 12, 13, or 14 record is rejected", () => {
  for (const [combined, a, b] of [
    ["04", "04A", "04B"],
    ["12", "12A", "12B"],
    ["13", "13A", "13B"],
    ["14", "14A", "14B"],
  ]) {
    const document = patch(evidence(), {
      [lane(a, "node_id")]: combined,
      [lane(a, "split_phase")]: null,
    });
    document.lane_inputs.splice(laneIndex(b), 1);
    invalid(document, /integration manifest expected 16 Program nodes/);
  }
});

test("A and B phases of a split lane must use distinct PRs, PR heads, and merge commits", () => {
  const table = [
    {
      [lane("13B", "pr_head_sha")]: sha("13A-head"),
      [lane("13B", "pr_commit_shas")]: [sha("13A-c1"), sha("13A-head")],
      [lane("13B", "merge_parent_shas")]: [sha("13B-base"), sha("13A-head")],
    },
    { [lane("14B", "integration_merge_sha")]: sha("14A-merge") },
    { [lane("12B", "pr_number")]: 104, [lane("12B", "pr_url")]: prUrl(104) },
  ];
  for (const changes of table) {
    rejects(changes, /split phases must use distinct PR and merge commits/);
  }
});

test("the predecessor matrix is enforced node by node", () => {
  const table = [
    [{ [lane("13A", "predecessor_node_ids")]: ["03"] }, /13A: predecessor_node_ids/],
    [{ [lane("08", "predecessor_node_ids")]: ["04B", "05", "06"] }, /08: predecessor_node_ids/],
    [{ [lane("13B", "predecessor_node_ids")]: ["10"] }, /13B: predecessor_node_ids/],
    [{ [lane("14B", "predecessor_node_ids")]: ["13B"] }, /14B: predecessor_node_ids/],
    [{ [lane("06", "predecessor_node_ids")]: ["03", "04A"] }, /06: predecessor_node_ids/],
    [{ [lane("12B", "predecessor_node_ids")]: ["13B"] }, /12B: predecessor_node_ids/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected);
  for (const missing of ["04B", "05", "08", "11", "12A", "13A", "14A"]) {
    const kept = PROGRAM_NODES[laneIndex("10")].predecessor_node_ids.filter((id) => id !== missing);
    rejects({ [lane("10", "predecessor_node_ids")]: kept }, /10: predecessor_node_ids/);
  }
});

test("selected D-07B requires 13A to precede 11", () => {
  const withD07B = patch(evidence(), { [lane("11", "decision_branch")]: ["D-07B"] });
  invalid(withD07B, /selected D-07B requires 13A before 11/, { firstParent: firstParent() });
  const repaired = patch(withD07B, {
    [lane("11", "predecessor_node_ids")]: ["05", "08", "13A", "14A"],
  });
  assert.equal(
    validateIntegrationEvidence(repaired, options({ firstParent: firstParent() })).lane_inputs
      .length,
    16,
  );
});

test("13B and 14B must carry one agreeing D-06 selector", () => {
  rejects({ [lane("13B", "decision_branch")]: [] }, /13B: decision_branch must record D-06A or D-06B/);
  rejects({ [lane("14B", "decision_branch")]: ["D-06A"] }, /same D-06 selector/);
  rejects({ [lane("05", "decision_branch")]: ["D-42"] }, /05: decision_branch/);
});

test("each merge SHA occurs exactly once, in predecessor order, on first-parent history", () => {
  const order = firstParent();
  const swap = (list, a, b) => {
    const copy = [...list];
    const i = copy.indexOf(sha(`${a}-merge`));
    const j = copy.indexOf(sha(`${b}-merge`));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  };
  // 13A is lifted out and re-landed immediately after 10, so 13A is the only
  // predecessor 10 now precedes and the error names it exactly.
  const lateThirteenA = order.filter((entry) => entry !== sha("13A-merge"));
  lateThirteenA.splice(lateThirteenA.indexOf(sha("10-merge")) + 1, 0, sha("13A-merge"));
  const table = [
    [order.slice(1), /integration merge SHA is not on first-parent history: 03/],
    [[...order, sha("06-merge")], /integration merge SHA occurs more than once: 06/],
    [swap(order, "08", "09"), /08 is merged before its predecessor 09/],
    [lateThirteenA, /10 is merged before its predecessor 13A/],
    [swap(order, "04B", "06"), /04B is merged before its predecessor 06/],
    [[order[1], order[0], ...order.slice(2)], /03 must be the first recorded lane merge/],
    [swap(order, "12B", "14B"), /12B must be the last recorded lane merge/],
  ];
  for (const [history, expected] of table) invalid(evidence(), expected, { firstParent: history });
});

test("no seventeenth Plan 03-14 lane PR may be merged into the integration branch", () => {
  invalid(evidence(), /unrecorded lane PR merged into the integration branch: 999/, {
    firstParent: firstParent(),
    mergedPullRequests: [
      ...mergedPullRequests(),
      {
        number: 999,
        headRefName: "review-remediation/09-data-privacy",
        mergeCommit: { oid: sha("rogue-merge") },
      },
    ],
  });
});

test("owner-scope leakage is rejected unless the path is an explicit handoff", () => {
  const ownership = [
    { pattern: "apps/web/proxy.ts", namespace: "WEBAPI" },
    { pattern: "packages/tokens/**", namespace: "FRONTEND" },
  ];
  invalid(evidence(), /owner-scope leakage at node 03: apps\/web\/proxy\.ts/, {
    ownership,
    nodePaths: { "03": ["apps/web/proxy.ts"] },
  });
  const allowed = validateIntegrationEvidence(
    evidence(),
    options({
      ownership,
      nodePaths: { "03": ["apps/web/proxy.ts", "agent/crates/agent-domain/src/study.rs"] },
      handoffPaths: { "03": ["apps/web/proxy.ts"] },
    }),
  );
  assert.equal(allowed.lane_inputs.length, 16);
});

test("duplicate node identity, PR, finding, or proof records are rejected", () => {
  const table = [
    [{ [lane("07", "node_id")]: "09" }, /duplicate node id: 09/],
    [{ [lane("07", "pr_number")]: 110, [lane("07", "pr_url")]: prUrl(110) }, /duplicate pr_number/],
    [
      {
        [lane("07", "pr_head_sha")]: sha("09-head"),
        [lane("07", "pr_commit_shas")]: [sha("07-c1"), sha("09-head")],
        [lane("07", "merge_parent_shas")]: [sha("07-base"), sha("09-head")],
      },
      /duplicate pr_head_sha/,
    ],
    [{ [lane("07", "integration_merge_sha")]: sha("09-merge") }, /duplicate integration_merge_sha/],
    [{ [lane("07", "finding_ids")]: ["FIND-09"] }, /duplicate finding id: FIND-09/],
    [{ [lane("07", "proof_artifacts")]: ["artifacts/lane-proof/09.json"] }, /duplicate proof path/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected);
});

test("PR commit lists must be ordered, unique, head-terminated, and reachable from the head", () => {
  const table = [
    [{ [lane("05", "pr_commit_shas")]: [sha("05-c1")] }, /pr_commit_shas must end in pr_head_sha/],
    [
      { [lane("05", "pr_commit_shas")]: [sha("05-c1"), sha("05-c1"), sha("05-head")] },
      /pr_commit_shas must be unique/,
    ],
    [{ [lane("05", "pr_commit_shas")]: [] }, /pr_commit_shas must be non-empty/],
    [{ [lane("05", "merge_parent_shas")]: [sha("05-base")] }, /merge_parent_shas/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected);
  invalid(evidence(), /pr_commit_shas names a commit that is not reachable/, {
    isAncestor: (ancestor) => ancestor !== sha("05-c1"),
  });
});

test("node identity fields must match the Program manifest and the frozen candidate", () => {
  const table = [
    [{ [lane("05", "split_phase")]: "A" }, /05: split_phase/],
    [{ [lane("13A", "split_phase")]: null }, /13A: split_phase/],
    [{ [lane("13A", "branch")]: "review-remediation/10-web-session" }, /13A: branch/],
    [{ [lane("13A", "namespace")]: "WEBSESSION" }, /13A: namespace/],
    [{ [lane("06", "topological_rank")]: 9 }, /06: topological_rank/],
    [
      { [lane("06", "plan_path")]: "docs/superpowers/plans/2026-08-23-web-api-security.md" },
      /06: plan_path/,
    ],
    [{ [lane("06", "included_in_frozen_sha")]: false }, /06: included_in_frozen_sha/],
    [{ [lane("06", "owner_acknowledged_handoff")]: false }, /06: owner_acknowledged_handoff/],
    [{ [lane("06", "proof_artifacts")]: ["docs/proof.json"] }, /06: proof path/],
    [{ [lane("06", "finding_ids")]: [] }, /06: finding_ids/],
    [{ [lane("06", "pr_url")]: "not-a-url" }, /06: pr_url/],
  ];
  for (const [changes, expected] of table) rejects(changes, expected);
});

test("the Program ownership table parses into a path-to-namespace map", () => {
  const ownership = parseProgramOwnership(
    execFileSync(
      "git",
      ["show", "HEAD:docs/superpowers/plans/2026-08-23-review-remediation-swarm-program.md"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const owner = (file) =>
    [...ownership]
      .sort((a, b) => b.pattern.length - a.pattern.length)
      .find((entry) => entry.matches(file))?.namespace ?? null;
  assert.equal(owner("apps/web/proxy.ts"), "WEBAPI");
  assert.equal(owner(".github/workflows/validate.yml"), "RELEASE");
  assert.equal(owner("packages/tokens/src/index.ts"), "FRONTEND");
  assert.equal(owner("scripts/integration-readiness.mjs"), "INTEGRATION");
  assert.equal(owner("agent/crates/agent-domain/src/brain.rs"), "DOMAIN");
  assert.equal(owner("agent/migrations/0004_add.sql"), "DATA");
  assert.equal(owner("agent/crates/agent-domain/src/tool_executor.rs"), "LEARN");
});

// --- Markdown rendering ---

const HEADINGS = `# Viva Release Readiness Evidence|## Identity|## Lane reconciliation|
## Mandatory evidence|### Level 1|### Level 2|### Level 3|## Public contract|
## Independent review|## External gates|## Deploy/run binding|## Release decision|
## Superseded evidence`
  .split("|")
  .map((heading) => heading.trim());

const headingsOf = (markdown) => markdown.split("\n").filter((line) => line.startsWith("#"));

test("the active document renders the exact heading order and header grammar", () => {
  const markdown = renderIntegrationMarkdown(validateIntegrationEvidence(evidence(), options()));
  assert.deepEqual(headingsOf(markdown), HEADINGS);
  assert.equal(
    markdown.split("\n").slice(0, 9).join("\n"),
    [
      "# Viva Release Readiness Evidence",
      "",
      "- Schema: `viva.integration_readiness.v1`",
      `- Run ID: \`${RUN_ID}\``,
      `- Frozen SHA: \`${FROZEN_SHA}\``,
      "- Generated at: `2026-08-23T18:00:00.000Z`",
      "- Integration state: `ACTIVE_MANDATORY_EVIDENCE_INCOMPLETE`",
      "- Terminal status emitted: `false`",
      "- Sanitized: `true`",
    ].join("\n"),
  );
});

test("a mandatory-complete run replaces the two active lines with one terminal-status line", () => {
  const finalize = (gates) => finalizeIntegrationEvidence(mandatoryComplete(gates), options());
  const table = [
    [releaseReady(), "RELEASE_READY"],
    [finalize(gatesWith("OPS-03", blockedGate)), "CODE_COMPLETE_EXTERNAL_GATES_PENDING"],
    [finalize(gatesWith("OPS-05", failGate)), "CODE_REMEDIATION_COMPLETE"],
  ];
  for (const [document, status] of table) {
    const markdown = renderIntegrationMarkdown(document);
    assert.deepEqual(headingsOf(markdown), HEADINGS);
    assert.match(markdown, new RegExp(`^- Terminal status: ${status}$`, "m"));
    assert.doesNotMatch(markdown, /^- Integration state:/m);
    assert.doesNotMatch(markdown, /^- Terminal status emitted:/m);
    assert.doesNotMatch(markdown, /ACTIVE_MANDATORY_EVIDENCE_INCOMPLETE/);
  }
});

test("every level and external-gate section renders the fixed six-column table", () => {
  const markdown = renderIntegrationMarkdown(
    finalizeIntegrationEvidence(mandatoryComplete(gatesWith("OPS-03", blockedGate)), options()),
  );
  const header = "| ID | Status | Frozen SHA | Artifact SHA-256 | Owner | Reason code |";
  assert.equal(markdown.split("\n").filter((line) => line === header).length, 6);
  assert.match(
    markdown,
    new RegExp(
      `\\| OPS-03 \\| BLOCKED_EXTERNAL \\| ${FROZEN_SHA} \\| null \\| release-operations \\| RAILWAY_PROJECT_OR_DEPLOYMENT_UNAVAILABLE \\|`,
    ),
  );
  assert.match(markdown, new RegExp(`\\| level_1 \\| PASS \\| ${FROZEN_SHA} \\| null \\| null \\| null \\|`));
  assert.match(markdown, new RegExp(`\\| level_1_artifact \\| null \\| ${FROZEN_SHA} \\| [0-9a-f]{64} \\|`));
});

test("missing values render as null rather than a friendly omission", () => {
  const markdown = renderIntegrationMarkdown(validateIntegrationEvidence(evidence(), options()));
  const labels = "Reconciliation merge SHA;Deploy binding;Release owner;Supersedes run ID;Independent review artifact";
  for (const label of labels.split(";")) {
    assert.match(markdown, new RegExp(`^- ${label}: \`null\`$`, "m"));
  }
});

test("the renderer never renders an environment value behind a sensitive key marker", () => {
  const guarded = `CARTESIA_API_KEY VIVA_SESSION_TOKEN VIVA_RELEASE_BUNDLE_SIGNING_SECRET
    VIVA_BEARER_HEADER PGPASSWORD VIVA_E2E_AUDIO_DIR VIVA_TRANSCRIPT_MODE
    VIVA_ANSWER_MODE VIVA_PROMPT_ID VIVA_SOURCE_CONTEXT`
    .split(/\s+/)
    .filter(Boolean);
  const environment = Object.fromEntries(guarded.map((key) => [key, "must-never-render"]));
  environment.VIVA_ENV = "production";
  const document = patch(evidence(), { "levels.level_2.commands.0.environment": environment });
  const markdown = renderIntegrationMarkdown(validateIntegrationEvidence(document, options()));
  assert.doesNotMatch(markdown, /must-never-render/);
  for (const key of guarded) assert.doesNotMatch(markdown, new RegExp(key));
  assert.match(markdown, /VIVA_ENV=production/);
  assert.equal(markdown.split("[redacted]").length - 1, guarded.length);
});

test("rendering is deterministic across repeated calls and key insertion order", () => {
  const document = validateIntegrationEvidence(releaseReady(), options());
  const first = renderIntegrationMarkdown(document);
  assert.equal(first, renderIntegrationMarkdown(document));
  const shuffled = Object.fromEntries(Object.entries(structuredClone(document)).reverse());
  assert.equal(renderIntegrationMarkdown(shuffled), first);
});

test("hand-edited Markdown is rejected against the validated document", () => {
  const document = validateIntegrationEvidence(releaseReady(), options());
  const markdown = renderIntegrationMarkdown(document);
  assert.equal(assertGeneratedMarkdown(document, markdown), undefined);
  assert.throws(
    () => assertGeneratedMarkdown(document, markdown.replace("RELEASE_READY", "RELEASE__READY")),
    /Markdown was not generated from this evidence document/,
  );
});

// --- Deterministic CLI evidence operations ---

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "viva-integration-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const runCli = (argv) => execFileSync("node", [CLI, ...argv], { cwd: repoRoot, encoding: "utf8" });
const headSha = () =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

test("main-reconciliation-not-required writes a NOT_REQUIRED document and merges nothing", async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, "main-reconciliation.json");
    const head = headSha();
    runCli([
      "main-reconciliation-not-required",
      "--audit-base-sha",
      MAIN_SHA,
      "--live-main-sha",
      head,
      "--combined-tip-sha",
      head,
      "--output",
      output,
    ]);
    const document = JSON.parse(await readFile(output, "utf8"));
    assert.equal(document.schema, MAIN_RECONCILIATION_SCHEMA);
    assert.equal(document.status, "NOT_REQUIRED");
    assert.equal(document.reconciliation_merge_sha, null);
    assert.equal(validateMainReconciliation(document, options()).live_main_sha, head);
  });
});

test("record-handoff binds the namespace A/B nodes and hashes each file at the frozen SHA", async () => {
  await withTempDir(async (directory) => {
    const head = headSha();
    await writeFile(
      path.join(directory, "lane-inputs.json"),
      JSON.stringify({ frozen_sha: head, lane_inputs: laneInputs() }),
    );
    const output = path.join(directory, "plan-12-workflow-handoff.json");
    runCli([
      "record-handoff",
      "--namespace",
      "RELEASE",
      "--files",
      "package.json,turbo.json",
      "--frozen-sha",
      head,
      "--output",
      output,
    ]);
    const handoff = JSON.parse(await readFile(output, "utf8"));
    assert.equal(handoff.namespace, "RELEASE");
    assert.equal(handoff.frozen_sha, head);
    assert.deepEqual(
      handoff.nodes.map((node) => node.node_id),
      ["12A", "12B"],
    );
    assert.equal(handoff.nodes[0].pr_head_sha, sha("12A-head"));
    assert.equal(handoff.nodes[1].integration_merge_sha, sha("12B-merge"));
    assert.deepEqual(
      handoff.files.map((file) => file.path),
      ["package.json", "turbo.json"],
    );
    const blob = execFileSync("git", ["show", `${head}:package.json`], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(handoff.files[0].sha256, createHash("sha256").update(blob).digest("hex"));
    assert.equal(handoff.files[0].bound_node_id, "12B");
  });
});

test("the CLI refuses an unknown command and a missing required flag", () => {
  for (const argv of [["merge-lane"], ["record-handoff", "--namespace", "RELEASE"]]) {
    assert.throws(() => runCli(argv), /Command failed/);
  }
  assert.equal(typeof laneOf(evidence(), "12B").pr_number, "number");
});
