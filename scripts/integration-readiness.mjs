#!/usr/bin/env node
// INTEGRATION-001 — the integration evidence contract and the terminal classifier.
//
// The single authority for what a Plan 15 evidence run may claim: it validates the
// `viva.integration_readiness.v1` and `viva.main_reconciliation.v1` documents without
// coercion, derives the one legal terminal status, and renders the Markdown that
// `docs/release-readiness.md` is generated from. Three rules drive every branch and none
// may be relaxed: (1) `terminal_status` cannot exist while any mandatory gate is non-PASS
// — the Markdown says `ACTIVE_MANDATORY_EVIDENCE_INCOMPLETE` and that label never enters
// the JSON; (2) `BLOCKED_EXTERNAL` is legal only on `OPS-01`..`OPS-06`, so a missing
// executable, absent database, skipped test, cache-only result or local failure is a
// mandatory `FAIL`; (3) a required external gate that was omitted, or blocked without a
// complete reason, is materialized as a named external `FAIL` before classification,
// never silently coerced to `BLOCKED_EXTERNAL`, and the status it produces keeps the
// remediation loop open. The CLI verbs are deterministic operations over Git/GitHub
// artifacts already captured to files: none merges, cherry-picks, rebases, or mutates a
// PR, because Plan 15 verifies the Program's integration history, never re-creates it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EVIDENCE_LEVEL_COMMANDS } from "./integration-readiness-levels.mjs";
// The primitives below live in the sibling module A-39.3 granted this namespace, so the
// entrypoint stays thin and every file stays inside the unbudgeted 1,200-line ceiling.
import {
  EXTERNAL_GATE_IDS, LANES, LANE_BRANCH_PATTERN, MANDATORY_STATUSES, NAMESPACES, NODE_BY_ID,
  PROGRAM_NODES, RUN_ID, check, csv, exactKeys, flag, git, gitIsAncestor, isRecord, keys,
  parseFlags, readJson, readLines, requireArray, requireEvidencePath, requireHex64, requireInstant,
  requireSha, requireStatus, requireText, sha256, shape, validateShape, writeJson,
  isGuardedEnvironmentKey,
} from "./integration-readiness-shared.mjs";
import { REDACTED_VALUE } from "./redaction-control.mjs";

export {
  EXTERNAL_GATE_IDS, PROGRAM_NODES, IntegrationEvidenceError,
} from "./integration-readiness-shared.mjs";

export const INTEGRATION_EVIDENCE_SCHEMA = "viva.integration_readiness.v1";
export const MAIN_RECONCILIATION_SCHEMA = "viva.main_reconciliation.v1";
export const INTEGRATION_HANDOFF_SCHEMA = "viva.integration_handoff.v1";
export const TERMINAL_STATUSES = Object.freeze(
  "CODE_REMEDIATION_COMPLETE CODE_COMPLETE_EXTERNAL_GATES_PENDING RELEASE_READY".split(" "),
);
/** One reason code per external gate, in `EXTERNAL_GATE_IDS` order. */
export const BLOCKED_EXTERNAL_REASON_CODES = Object.freeze(
  `GITHUB_ACTIONS_BILLING_UNAVAILABLE GITHUB_RULE_ADMIN_ACCESS_REQUIRED
   RAILWAY_PROJECT_OR_DEPLOYMENT_UNAVAILABLE PROVIDER_ZDR_OR_SECRET_UNAVAILABLE
   DEVICE_BROWSER_OR_SCREENREADER_UNAVAILABLE RELEASE_OWNER_DECISION_UNAVAILABLE`.split(/\s+/),
);
/** Markdown-only progress label. It must never appear in the JSON contract. */
export const ACTIVE_MARKDOWN_STATE = "ACTIVE_MANDATORY_EVIDENCE_INCOMPLETE";

const EXTERNAL_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED_EXTERNAL"]);
const MATERIALIZED = Object.freeze(["REQUIRED_GATE_OMITTED", "INCOMPLETE_EXTERNAL_REASON"]);
const MAIN_STATUSES = Object.freeze(["NOT_REQUIRED", "REVIEW_REQUIRED", "RECONCILED"]);
const SPLIT_PHASE_MESSAGE = "split phases must use distinct PR and merge commits";
const D07B_MESSAGE = "selected D-07B requires 13A before 11";
const COMPONENT_FINDING_INSTANCES = 128;

// --- The declarative shape layer ---
const DECISION_SELECTOR = /^D-0[1-9][AB]?(?::[A-Z_]+)?$/;

const IDENTITY_SPEC = shape(`repository:text branch:text audit_base_sha:sha
  live_main_sha_at_start:sha live_main_sha_at_freeze:sha frozen_sha:sha worktree_clean:isTrue
  frozen_at:instant`);
const COMMAND_SPEC = shape(`id:text argv:array cwd:text started_at:instant finished_at:instant
  duration_ms:count exit_code:integer status:gate frozen_sha:sha stdout_sha256:hex64
  stderr_sha256:hex64 cache_mode:text`);
const ARTIFACT_SPEC = shape(`id:text path:path media_type:text sha256:hex64 bytes:count
  created_at:instant frozen_sha:sha run_id:runId sanitized:isTrue forbidden_hits:isZero`);
const SKIP_REASON_SPEC = shape(`code:text owner:text blocked_at:instant attempted:text
  last_observed_state:text required_action:text required_evidence:text next_check_at:instant
  applies_to_frozen_sha:sha`);
const GATE_EVIDENCE_SPEC = shape(`owner:text executed_at:instant attempted:text
  observed_state:text reproduction:text artifacts:array materialized_reason:any`);
const LANE_INPUT_SPEC = shape(`node_id:text topological_rank:any namespace:any split_phase:any
  plan_path:any branch:any pr_number:any pr_url:any pr_commit_shas:array pr_head_sha:sha
  integration_merge_sha:sha merge_parent_shas:array predecessor_node_ids:array decision_branch:array
  included_in_frozen_sha:isTrue finding_ids:array proof_artifacts:array
  owner_acknowledged_handoff:isTrue`);
const SERVICE_SPEC = shape(`name:text deployment_id:text image_digest:text origin:text
  in_band_sha:sha`);
const COVERAGE_KEYS = keys(`component_finding_instances_expected
  component_finding_instances_reconciled unresolved_rows ledger_sha256`);
const TOP_LEVEL_KEYS = keys(`schema run_id generated_at identity lane_inputs main_reconciliation
  program_reconciliations coverage levels docs_contract independent_review external_gates
  deploy_binding release_owner supersedes_run_id sanitized`);
const RECONCILIATION_KEYS = keys(`source_owner_namespace source_commit_sha source_review_pr
  source_diff_sha256 coordinator_commit_sha coordinator_diff_sha256 changed_paths affected_node_ids
  affected_finding_ids owner_approval independent_review_approval focused_gates
  included_in_frozen_sha`);
const MAIN_KEYS = keys(`schema audit_base_sha live_main_sha previous_combined_tip_sha
  main_only_commits changed_paths path_owner_dispositions conflicts affected_node_ids
  affected_finding_ids focused_gates requester_role program_coordinator_review
  affected_owner_reviews independent_review merge_actor_role reconciliation_merge_sha
  post_reconciliation_tip_sha status`);

// --- Frozen identity ---
/** Every record that must carry `identity.frozen_sha` and, where present, `run_id`. */
function boundRecords(doc) {
  const levels = Object.values(doc?.levels ?? {});
  return [
    ...levels.flatMap((level) => [...(level?.commands ?? []), ...(level?.artifacts ?? [])]),
    ...(doc?.docs_contract?.artifacts ?? []),
    ...(doc?.external_gates ?? []).flatMap((gate) => gate?.evidence?.artifacts ?? []),
    doc?.independent_review?.artifact,
    doc?.main_reconciliation?.artifact,
    doc?.release_owner?.artifact,
  ].filter(isRecord);
}

export function assertFrozenIdentity(document, { isAncestor = gitIsAncestor } = {}) {
  const identity = document?.identity;
  validateShape(identity, IDENTITY_SPEC, "identity", { join: "." });
  const ancestral = isAncestor(identity.live_main_sha_at_freeze, identity.frozen_sha);
  check(ancestral, "identity.live_main_sha_at_freeze is not an ancestor of frozen_sha");
  for (const record of boundRecords(document)) {
    const id = typeof record.id === "string" ? record.id : "record";
    check(record.frozen_sha === identity.frozen_sha, `${id} is not bound to identity frozen_sha`);
    const boundRun = !Object.hasOwn(record, "run_id") || record.run_id === document.run_id;
    check(boundRun, `${id} is not bound to identity run_id`);
  }
  return identity;
}

// --- Command, artifact, and external-gate records ---
function validateCommand(record) {
  validateShape(record, COMMAND_SPEC, "command", { optional: ["environment"] });
  const literal = record.argv.every((token) => typeof token === "string" && token !== "");
  check(literal && record.argv.length > 0, "command argv must be a non-empty string array");
  check(!path.isAbsolute(record.cwd) && !record.cwd.includes(".."), "command cwd must be relative");
  const ordered = Date.parse(record.finished_at) >= Date.parse(record.started_at);
  check(ordered, "command finished_at precedes started_at");
  const cached = ["forced", "not_applicable"].includes(record.cache_mode);
  check(cached, "command cache_mode must be forced; a cache-only result is FAIL");
  const environment = record.environment;
  check(environment === undefined || isRecord(environment), "command environment must be an object");
}

function validateArtifact(record, document) {
  validateShape(record, ARTIFACT_SPEC, "artifact");
  const bound = !document || record.run_id === document.run_id;
  check(bound, `artifact ${record.id} is not bound to identity run_id`);
}

function validateSkipReason(gate, frozenSha) {
  const id = gate.id;
  check(isRecord(gate.skip_reason), `${id}: BLOCKED_EXTERNAL gate requires skip_reason`);
  validateShape(gate.skip_reason, SKIP_REASON_SPEC, `${id}: skip_reason`, { join: "." });
  const expected = BLOCKED_EXTERNAL_REASON_CODES[EXTERNAL_GATE_IDS.indexOf(id)];
  check(gate.skip_reason.code === expected, `${id}: skip_reason.code must be ${expected}`);
  const bound = gate.skip_reason.applies_to_frozen_sha === frozenSha;
  check(bound, `${id}: skip_reason.applies_to_frozen_sha must match the frozen SHA`);
}

function validateExternalGate(gate, document) {
  exactKeys(gate, keys("id status"), "external gate", ["skip_reason", "evidence"]);
  const id = gate.id;
  check(EXTERNAL_GATE_IDS.includes(id), `unknown external gate: ${String(id)}`);
  requireStatus(gate.status, EXTERNAL_STATUSES, id);
  if (gate.status === "BLOCKED_EXTERNAL") {
    validateSkipReason(gate, document.identity.frozen_sha);
    check(!Object.hasOwn(gate, "evidence"), `${id}: BLOCKED_EXTERNAL cannot carry evidence`);
    return;
  }
  check(!Object.hasOwn(gate, "skip_reason"), `${id}: ${gate.status} gate cannot carry skip_reason`);
  const evidence = gate.evidence;
  check(isRecord(evidence), `${id}: recorded gate must name executed evidence`);
  const reproduced = typeof evidence.reproduction === "string" && evidence.reproduction.trim();
  check(Boolean(reproduced), `${id}: recorded gate must name its reproduction`);
  validateShape(evidence, GATE_EVIDENCE_SPEC, `${id}: evidence`, { join: "." });
  for (const artifact of evidence.artifacts) validateArtifact(artifact, document);
  if (evidence.materialized_reason === null) {
    check(evidence.artifacts.length > 0, `${id}: recorded gate must name executed evidence`);
    return;
  }
  const reason = MATERIALIZED.includes(evidence.materialized_reason);
  check(reason, `${id}: evidence.materialized_reason is unrecorded`);
  check(gate.status === "FAIL", `${id}: a materialized gate must be FAIL`);
}

// --- Program ownership, the manifest, and the merge DAG ---
function globToRegExp(pattern) {
  const quote = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = pattern
    .split("**")
    .map((part) => part.split("*").map(quote).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

const expandBraces = (token) => {
  const match = /^(.*)\{([^}]+)\}(.*)$/.exec(token);
  if (!match) return [token];
  return match[2].split(",").map((option) => `${match[1]}${option.trim()}${match[3]}`);
};

/**
 * Parses Program Section 4's exclusive ownership table into path matchers. The
 * permanent-owner column wins; a cell naming two plans in sequence (the runbook's
 * "Plan 12 ... then Plan 15") resolves to the first — the owner during the lane merges.
 */
export function parseProgramOwnership(markdown) {
  const section = markdown.split(/^## 4\. /m)[1]?.split(/^## /m)[0] ?? "";
  const entries = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|") || /^\|\s*-+/.test(line) || /\|\s*Surface\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 4) continue;
    const namespace = LANES[/Plan\s+(\d{2})/.exec(cells[2])?.[1]]?.[0];
    if (!namespace) continue;
    for (const token of cells[0].matchAll(/`([^`]+)`/g)) {
      for (const pattern of expandBraces(token[1].trim())) {
        if (!pattern.includes("/") && !pattern.includes(".")) continue;
        const matcher = globToRegExp(pattern);
        entries.push({ pattern, namespace, matches: (file) => matcher.test(file) });
      }
    }
  }
  return entries;
}

function ownerNamespaceForPath(file, ownership) {
  let owner = null;
  let best = -1;
  for (const entry of ownership) {
    const matches = entry.matches ?? ((name) => globToRegExp(entry.pattern).test(name));
    if (entry.pattern.length > best && matches(file)) {
      owner = entry.namespace;
      best = entry.pattern.length;
    }
  }
  return owner;
}

function validateLaneInputRecord(node, expected, selectedD07B, isAncestor) {
  const id = node.node_id;
  validateShape(node, LANE_INPUT_SPEC, `${id}:`);
  for (const field of ["topological_rank", "namespace", "split_phase", "plan_path", "branch"]) {
    check(node[field] === expected[field], `${id}: ${field} must match the Program manifest`);
  }
  check(Number.isInteger(node.pr_number) && node.pr_number > 0, `${id}: pr_number must be positive`);
  const url = typeof node.pr_url === "string" && node.pr_url.startsWith("https://github.com/");
  check(url && node.pr_url.endsWith(`/pull/${node.pr_number}`), `${id}: pr_url must name its PR`);
  const commits = node.pr_commit_shas;
  check(commits.length > 0, `${id}: pr_commit_shas must be non-empty`);
  for (const [i, sha] of commits.entries()) requireSha(sha, `${id}: pr_commit_shas[${i}]`);
  check(new Set(commits).size === commits.length, `${id}: pr_commit_shas must be unique`);
  check(commits.at(-1) === node.pr_head_sha, `${id}: pr_commit_shas must end in pr_head_sha`);
  for (const sha of commits) {
    const reachable = isAncestor(sha, node.pr_head_sha);
    check(reachable, `${id}: pr_commit_shas names a commit that is not reachable: ${sha}`);
  }
  const parents = node.merge_parent_shas;
  check(parents.length >= 2, `${id}: merge_parent_shas needs at least two parents`);
  for (const [i, sha] of parents.entries()) requireSha(sha, `${id}: merge_parent_shas[${i}]`);
  check(parents.includes(node.pr_head_sha), `${id}: merge_parent_shas must include pr_head_sha`);
  const allowed = new Set(expected.predecessor_node_ids);
  if (id === "11" && selectedD07B) allowed.add("13A");
  const declared = new Set(node.predecessor_node_ids);
  const exact =
    expected.predecessor_node_ids.every((entry) => declared.has(entry)) &&
    [...declared].every((entry) => allowed.has(entry));
  check(exact, `${id}: predecessor_node_ids is not the manifest set`);
  for (const selector of node.decision_branch) {
    const known = typeof selector === "string" && DECISION_SELECTOR.test(selector);
    check(known, `${id}: decision_branch selector is unrecorded`);
  }
  check(node.finding_ids.length > 0, `${id}: finding_ids must be a non-empty array`);
  for (const [i, f] of node.finding_ids.entries()) requireText(f, `${id}: finding_ids[${i}]`);
  for (const proof of node.proof_artifacts) requireEvidencePath(proof, `${id}: proof path`);
}

function validateProgramManifest(nodes, options) {
  const { isAncestor = gitIsAncestor, firstParent, mergedPullRequests } = options;
  const { ownership, nodePaths, handoffPaths, frozenBinding = true } = options;
  requireArray(nodes, "lane_inputs");
  const expected16 = "integration manifest expected 16 Program nodes";
  check(nodes.length === PROGRAM_NODES.length, expected16);
  const byId = new Map();
  for (const node of nodes) {
    const id = requireText(node?.node_id, "lane input node_id");
    check(!byId.has(id), `duplicate node id: ${id}`);
    byId.set(id, node);
  }
  for (const node of PROGRAM_NODES) check(byId.has(node.node_id), expected16);
  for (const id of byId.keys()) check(NODE_BY_ID.has(id), expected16);
  const selectedD07B = nodes.some((node) => (node.decision_branch ?? []).includes("D-07B"));
  for (const node of nodes) {
    const bound = frozenBinding ? node : { ...node, included_in_frozen_sha: true };
    validateLaneInputRecord(bound, NODE_BY_ID.get(node.node_id), selectedD07B, isAncestor);
  }
  const namespaces = new Set(nodes.map((node) => node.namespace));
  check(namespaces.size === 12, "integration manifest expected twelve lane namespaces");
  // A collision inside one namespace is an A/B phase that failed to split; a
  // collision across namespaces is a plain duplicate record.
  for (const field of ["pr_number", "pr_head_sha", "integration_merge_sha"]) {
    const seen = new Map();
    for (const node of nodes) {
      const previous = seen.get(node[field]);
      check(!previous || previous.namespace !== node.namespace, SPLIT_PHASE_MESSAGE);
      check(!previous, `duplicate ${field}: ${node[field]}`);
      seen.set(node[field], node);
    }
  }
  for (const [field, label] of [["finding_ids", "finding id"], ["proof_artifacts", "proof path"]]) {
    const seen = new Set();
    for (const node of nodes) {
      for (const value of node[field]) {
        check(!seen.has(value), `duplicate ${label}: ${value}`);
        seen.add(value);
      }
    }
  }
  const d06 = ["13B", "14B"].map((id) => {
    const selectors = byId.get(id).decision_branch.filter((value) => value.startsWith("D-06"));
    check(selectors.length === 1, `${id}: decision_branch must record D-06A or D-06B`);
    return selectors[0];
  });
  check(d06[0] === d06[1], "13B and 14B must record the same D-06 selector");
  if (Array.isArray(firstParent)) {
    const positionOf = new Map();
    for (const node of PROGRAM_NODES.map((entry) => byId.get(entry.node_id))) {
      const at = firstParent.flatMap((sha, i) => (sha === node.integration_merge_sha ? [i] : []));
      check(at.length > 0, `integration merge SHA is not on first-parent history: ${node.node_id}`);
      check(at.length === 1, `integration merge SHA occurs more than once: ${node.node_id}`);
      positionOf.set(node.node_id, at[0]);
    }
    const ordered = [...positionOf.entries()].sort((a, b) => a[1] - b[1]);
    check(ordered[0][0] === "03", "03 must be the first recorded lane merge");
    check(ordered.at(-1)[0] === "12B", "12B must be the last recorded lane merge");
    for (const node of nodes) {
      for (const predecessor of node.predecessor_node_ids) {
        const inOrder = positionOf.get(predecessor) < positionOf.get(node.node_id);
        check(inOrder, `${node.node_id} is merged before its predecessor ${predecessor}`);
      }
    }
    check(!selectedD07B || positionOf.get("13A") < positionOf.get("11"), D07B_MESSAGE);
  }
  const declaredD07B = !selectedD07B || byId.get("11").predecessor_node_ids.includes("13A");
  check(declaredD07B, D07B_MESSAGE);
  if (Array.isArray(mergedPullRequests)) {
    const recorded = new Set(nodes.map((node) => node.integration_merge_sha));
    for (const pr of mergedPullRequests) {
      if (!LANE_BRANCH_PATTERN.test(pr?.headRefName ?? "")) continue;
      const known = recorded.has(pr?.mergeCommit?.oid);
      check(known, `unrecorded lane PR merged into the integration branch: ${pr.number}`);
    }
  }
  if (Array.isArray(ownership) && isRecord(nodePaths)) {
    for (const node of nodes) {
      for (const changed of nodePaths[node.node_id] ?? []) {
        const owner = ownerNamespaceForPath(changed, ownership);
        if (!owner || owner === node.namespace) continue;
        const handed = (handoffPaths?.[node.node_id] ?? []).includes(changed);
        check(handed, `owner-scope leakage at node ${node.node_id}: ${changed}`);
      }
    }
  }
  return nodes;
}

/**
 * A coordinator reconciliation commit preserves the sixteen-node manifest rather
 * than disguising corrective history as a seventeenth integration node.
 */
function validateProgramReconciliations(document, isAncestor) {
  const seen = new Set();
  const merges = new Set(document.lane_inputs.map((node) => node.integration_merge_sha));
  for (const record of requireArray(document.program_reconciliations, "program_reconciliations")) {
    exactKeys(record, RECONCILIATION_KEYS, "program reconciliation");
    const at = `program reconciliation ${record.coordinator_commit_sha}`;
    const owned = NAMESPACES.includes(record.source_owner_namespace);
    check(owned, `${at}: source_owner_namespace is unknown`);
    requireSha(record.source_commit_sha, `${at} source_commit_sha`);
    requireSha(record.coordinator_commit_sha, `${at} coordinator_commit_sha`);
    requireHex64(record.source_diff_sha256, `${at} source_diff_sha256`);
    requireHex64(record.coordinator_diff_sha256, `${at} coordinator_diff_sha256`);
    const sameDiff = record.source_diff_sha256 === record.coordinator_diff_sha256;
    check(sameDiff, `${at}: the coordinator diff must equal the reviewed owner diff`);
    check(!seen.has(record.coordinator_commit_sha), `${at}: duplicate coordinator commit`);
    seen.add(record.coordinator_commit_sha);
    check(!merges.has(record.coordinator_commit_sha), `${at}: second lane merge`);
    for (const nodeId of requireArray(record.affected_node_ids, `${at} affected_node_ids`)) {
      check(NODE_BY_ID.has(nodeId), `${at}: affected_node_ids names a new node`);
    }
    requireArray(record.affected_finding_ids, `${at} affected_finding_ids`);
    requireArray(record.changed_paths, `${at} changed_paths`);
    for (const approval of [record.owner_approval, record.independent_review_approval]) {
      check(approval?.status === "APPROVED", `${at}: every approval must be APPROVED`);
    }
    const gates = requireArray(record.focused_gates, `${at} focused_gates`);
    const passing = gates.length > 0 && gates.every((gate) => gate?.status === "PASS");
    check(passing, `${at}: every focused gate must be PASS`);
    check(record.included_in_frozen_sha === true, `${at}: included_in_frozen_sha must be true`);
    const ancestral = isAncestor(record.coordinator_commit_sha, document.identity.frozen_sha);
    check(ancestral, `${at}: coordinator commit is not ancestral to the frozen SHA`);
  }
}

// --- Mandatory gate state and the terminal classifier ---
const coveragePasses = (coverage) =>
  isRecord(coverage) &&
  coverage.component_finding_instances_expected === COMPONENT_FINDING_INSTANCES &&
  coverage.component_finding_instances_reconciled === COMPONENT_FINDING_INSTANCES &&
  Array.isArray(coverage.unresolved_rows) &&
  coverage.unresolved_rows.length === 0;

function mandatoryGateStates(document) {
  const main = document?.main_reconciliation?.status;
  const reconciled = main === "NOT_REQUIRED" || main === "RECONCILED";
  return [
    ["level_1", document?.levels?.level_1?.status],
    ["level_2", document?.levels?.level_2?.status],
    ["level_3", document?.levels?.level_3?.status],
    ["docs_contract", document?.docs_contract?.status],
    ["independent_review", document?.independent_review?.status],
    ["main_reconciliation", reconciled ? "PASS" : "FAIL"],
    ["coverage", coveragePasses(document?.coverage) ? "PASS" : "FAIL"],
  ];
}

const mandatoryEvidenceComplete = (document) =>
  mandatoryGateStates(document).every(([, status]) => status === "PASS");

export function deriveTerminalStatus(document) {
  if (!mandatoryEvidenceComplete(document)) return undefined;
  const byId = new Map((document.external_gates ?? []).map((gate) => [gate?.id, gate]));
  const required = EXTERNAL_GATE_IDS.map((id) => byId.get(id));
  const held = (gate, ...allowed) => isRecord(gate) && allowed.includes(gate.status);
  if (required.every((gate) => held(gate, "PASS"))) return "RELEASE_READY";
  // An external FAIL, an omitted gate, and any other unrecorded state all fall
  // through to CODE_REMEDIATION_COMPLETE, which keeps the remediation loop open.
  const pending = required.every((gate) => held(gate, "PASS", "BLOCKED_EXTERNAL"));
  return pending ? "CODE_COMPLETE_EXTERNAL_GATES_PENDING" : "CODE_REMEDIATION_COMPLETE";
}

const materializedGate = (id, reason, document) => ({
  id,
  status: "FAIL",
  evidence: {
    owner: "integration-coordinator",
    executed_at: document.generated_at,
    attempted: `finalize required external gate ${id} on ${document.identity.frozen_sha}`,
    observed_state: `${id} ${reason === "REQUIRED_GATE_OMITTED" ? "was not recorded for this frozen SHA" : "was blocked without a complete external reason"}`,
    reproduction: `node scripts/integration-readiness.mjs finalize --run-id ${document.run_id}`,
    artifacts: [],
    materialized_reason: reason,
  },
});

/**
 * Materializes every omitted or unreasoned required external gate as a named external
 * FAIL, then classifies. It never coerces a gate to BLOCKED_EXTERNAL, and never emits a
 * terminal status while a mandatory gate is non-PASS.
 */
export function finalizeIntegrationEvidence(document, options = {}) {
  const draft = structuredClone(document);
  delete draft.terminal_status;
  if (mandatoryEvidenceComplete(draft)) {
    const recorded = new Map((draft.external_gates ?? []).map((gate) => [gate?.id, gate]));
    draft.external_gates = EXTERNAL_GATE_IDS.map((id) => {
      const gate = recorded.get(id);
      if (!isRecord(gate)) return materializedGate(id, "REQUIRED_GATE_OMITTED", draft);
      if (gate.status !== "BLOCKED_EXTERNAL") return gate;
      try {
        validateSkipReason(gate, draft.identity.frozen_sha);
        return gate;
      } catch {
        return materializedGate(id, "INCOMPLETE_EXTERNAL_REASON", draft);
      }
    });
    const derived = deriveTerminalStatus(draft);
    if (derived) draft.terminal_status = derived;
  }
  return validateIntegrationEvidence(draft, options);
}

// --- The evidence document ---
export function validateIntegrationEvidence(document, options = {}) {
  const { isAncestor = gitIsAncestor } = options;
  exactKeys(document, TOP_LEVEL_KEYS, "integration evidence", ["terminal_status"]);
  const schema = document.schema === INTEGRATION_EVIDENCE_SCHEMA;
  check(schema, `schema must be ${INTEGRATION_EVIDENCE_SCHEMA}`);
  check(RUN_ID.test(document.run_id ?? ""), "run_id is malformed");
  requireInstant(document.generated_at, "generated_at");
  check(document.sanitized === true, "sanitized must be true");
  const superseded = document.supersedes_run_id;
  check(superseded === null || RUN_ID.test(superseded ?? ""), "supersedes_run_id is malformed");
  assertFrozenIdentity(document, { isAncestor });
  const mr = document.main_reconciliation;
  exactKeys(mr, keys("status live_main_sha reconciliation_merge_sha artifact"), "main_reconciliation");
  const state = ["NOT_REQUIRED", "RECONCILED"].includes(mr.status);
  check(state, "main_reconciliation.status must be NOT_REQUIRED or RECONCILED");
  requireSha(mr.live_main_sha, "main_reconciliation.live_main_sha");
  if (mr.status === "RECONCILED") {
    requireSha(mr.reconciliation_merge_sha, "main_reconciliation.reconciliation_merge_sha");
    check(isRecord(mr.artifact), "main_reconciliation.artifact is required");
  } else {
    check(mr.reconciliation_merge_sha === null, "main_reconciliation.reconciliation_merge_sha");
  }
  if (isRecord(mr.artifact)) validateArtifact(mr.artifact, document);
  const cov = document.coverage;
  exactKeys(cov, COVERAGE_KEYS, "coverage");
  const counted =
    cov.component_finding_instances_expected === COMPONENT_FINDING_INSTANCES &&
    cov.component_finding_instances_reconciled === COMPONENT_FINDING_INSTANCES;
  check(counted, `coverage reconciliation expected ${COMPONENT_FINDING_INSTANCES} instances`);
  const unresolved = requireArray(cov.unresolved_rows, "coverage unresolved_rows");
  check(unresolved.length === 0, "coverage unresolved_rows must be empty");
  requireHex64(cov.ledger_sha256, "coverage ledger_sha256");
  exactKeys(document.levels, keys("level_1 level_2 level_3"), "levels");
  for (const [id, level] of Object.entries(document.levels)) {
    exactKeys(level, keys("status commands artifacts"), `levels.${id}`);
    requireStatus(level.status, MANDATORY_STATUSES, `levels.${id}`);
    for (const rec of requireArray(level.commands, `levels.${id}.commands`)) validateCommand(rec);
    for (const rec of requireArray(level.artifacts, `levels.${id}.artifacts`)) {
      validateArtifact(rec, document);
    }
  }
  const docs = document.docs_contract;
  exactKeys(docs, keys("status artifacts"), "docs_contract");
  requireStatus(docs.status, MANDATORY_STATUSES, "docs_contract");
  for (const rec of requireArray(docs.artifacts, "docs_contract.artifacts")) {
    validateArtifact(rec, document);
  }
  const rev = document.independent_review;
  exactKeys(rev, keys("status findings artifact"), "independent_review");
  requireStatus(rev.status, MANDATORY_STATUSES, "independent_review");
  requireArray(rev.findings, "independent_review.findings");
  if (rev.artifact !== null) validateArtifact(rev.artifact, document);
  validateProgramManifest(document.lane_inputs, { ...options, isAncestor });
  validateProgramReconciliations(document, isAncestor);
  const complete = mandatoryEvidenceComplete(document);
  const gateIds = [];
  for (const gate of requireArray(document.external_gates, "external_gates")) {
    validateExternalGate(gate, document);
    check(!gateIds.includes(gate.id), `duplicate external gate: ${gate.id}`);
    gateIds.push(gate.id);
  }
  if (complete) {
    for (const id of EXTERNAL_GATE_IDS) {
      check(gateIds.includes(id), `required external gate is missing: ${id}`);
    }
  }
  if (Object.hasOwn(document, "terminal_status")) {
    const legal = TERMINAL_STATUSES.includes(document.terminal_status);
    check(legal, `terminal_status must be one of ${TERMINAL_STATUSES.join(", ")}`);
    check(complete, "terminal_status is forbidden while a mandatory gate is non-PASS");
    const derived = document.terminal_status === deriveTerminalStatus(document);
    check(derived, "terminal_status does not match the derived classification");
  }
  validateDeployAndOwner(document);
  return document;
}

function validateDeployAndOwner(document) {
  const ready = document.terminal_status === "RELEASE_READY";
  const frozenSha = document.identity.frozen_sha;
  const binding = document.deploy_binding;
  if (binding === null) {
    check(!ready, "RELEASE_READY requires a deploy binding for web, agent, and monitor");
  } else {
    exactKeys(binding, keys("frozen_sha run_id services"), "deploy_binding");
    const bound = binding.frozen_sha === frozenSha && binding.run_id === document.run_id;
    check(bound, "deploy_binding must bind to the frozen SHA and run ID");
    const services = requireArray(binding.services, "deploy_binding.services");
    const names = services.map((service) => service?.name);
    for (const required of ["web", "agent", "monitor"]) {
      check(names.includes(required), `deploy_binding is missing the ${required} identity`);
    }
    for (const service of services) {
      validateShape(service, SERVICE_SPEC, "deploy_binding.services");
      const digest = /^sha256:[0-9a-f]{64}$/.test(service.image_digest);
      check(digest, "deploy_binding.services image_digest must be a sha256 digest");
      check(service.in_band_sha === frozenSha, "deploy_binding.services in_band_sha is unbound");
    }
  }
  const owner = document.release_owner;
  if (owner !== null) {
    exactKeys(owner, keys("owner decision decided_at artifact"), "release_owner");
    requireText(owner.owner, "release_owner.owner");
    check(["proceed", "hold"].includes(owner.decision), "release_owner.decision is not recorded");
    requireInstant(owner.decided_at, "release_owner.decided_at");
    if (owner.artifact !== null) validateArtifact(owner.artifact, document);
  }
  const proceed = !ready || owner?.decision === "proceed";
  check(proceed, "RELEASE_READY requires release owner decision proceed");
}

// --- Main reconciliation ---
const approved = (review) => isRecord(review) && review.status === "APPROVED";

function assertPathsOwned(document) {
  const owned = new Set(document.path_owner_dispositions.map((entry) => entry.path));
  for (const changed of document.changed_paths) {
    check(owned.has(changed), `changed path has no owner disposition: ${changed}`);
  }
}

export function validateMainReconciliation(document, options = {}) {
  const { isAncestor = gitIsAncestor, laneInputs } = options;
  const doc = document;
  exactKeys(doc, MAIN_KEYS, "main reconciliation");
  check(doc.schema === MAIN_RECONCILIATION_SCHEMA, `schema must be ${MAIN_RECONCILIATION_SCHEMA}`);
  for (const field of ["audit_base_sha", "live_main_sha", "previous_combined_tip_sha"]) {
    requireSha(doc[field], field);
  }
  check(MAIN_STATUSES.includes(doc.status), `status must be one of ${MAIN_STATUSES.join(", ")}`);
  for (const commit of requireArray(doc.main_only_commits, "main_only_commits")) {
    exactKeys(commit, keys("sha authored_at subject"), "main_only_commits entry");
    requireSha(commit.sha, "main_only_commits sha");
  }
  for (const changed of requireArray(doc.changed_paths, "changed_paths")) requireText(changed, "path");
  for (const entry of requireArray(doc.path_owner_dispositions, "path_owner_dispositions")) {
    exactKeys(entry, keys("path owner_namespace disposition"), "path_owner_dispositions entry");
    const owned = [...NAMESPACES, "PROGRAM"].includes(entry.owner_namespace);
    check(owned, "path_owner_dispositions names an unknown owner");
  }
  for (const conflict of requireArray(doc.conflicts, "conflicts")) {
    exactKeys(conflict, keys("path resolution resolved_by review_status"), "conflicts entry");
  }
  for (const nodeId of requireArray(doc.affected_node_ids, "affected_node_ids")) {
    check(NODE_BY_ID.has(nodeId), `affected_node_ids names an unknown node: ${nodeId}`);
  }
  requireArray(doc.affected_finding_ids, "affected_finding_ids");
  for (const gate of requireArray(doc.focused_gates, "focused_gates")) {
    exactKeys(gate, keys("id status"), "focused_gates entry");
    requireStatus(gate.status, MANDATORY_STATUSES, `focused gate ${gate.id}`);
  }
  const deltaEmpty = [
    doc.main_only_commits,
    doc.changed_paths,
    doc.path_owner_dispositions,
    doc.conflicts,
    doc.affected_node_ids,
    doc.affected_finding_ids,
    doc.focused_gates,
  ].every((list) => list.length === 0);
  const reviewsNull =
    doc.program_coordinator_review === null &&
    doc.affected_owner_reviews.length === 0 &&
    doc.independent_review === null &&
    doc.merge_actor_role === null &&
    doc.reconciliation_merge_sha === null &&
    doc.post_reconciliation_tip_sha === null;
  const requested = doc.requester_role === "PLAN_15_EVIDENCE";
  if (doc.status === "NOT_REQUIRED") {
    check(requested, "requester_role must be PLAN_15_EVIDENCE");
    check(deltaEmpty, "NOT_REQUIRED requires empty delta fields");
    check(reviewsNull, "NOT_REQUIRED requires null review and merge fields");
    const ancestral = isAncestor(doc.live_main_sha, doc.previous_combined_tip_sha);
    check(ancestral, "live_main_sha is not an ancestor of previous_combined_tip_sha");
    return doc;
  }
  if (doc.status === "REVIEW_REQUIRED") {
    check(requested, "requester_role must be PLAN_15_EVIDENCE for a Plan 15 request");
    const delta = doc.main_only_commits.length > 0 && doc.changed_paths.length > 0;
    check(delta, "REVIEW_REQUIRED requires the exact main-only commits and paths");
    check(reviewsNull, "REVIEW_REQUIRED requires null review and merge fields");
    assertPathsOwned(doc);
    return doc;
  }
  const coordinator = doc.merge_actor_role === "PROGRAM_COORDINATOR";
  check(coordinator, "merge_actor_role must be PROGRAM_COORDINATOR, never Plan 15");
  check(approved(doc.program_coordinator_review), "program_coordinator_review must be APPROVED");
  const owners = doc.affected_owner_reviews.length > 0 && doc.affected_owner_reviews.every(approved);
  check(owners, "RECONCILED requires an approval from every affected owner");
  check(approved(doc.independent_review), "independent_review must be APPROVED");
  const gates = doc.focused_gates.length > 0 && doc.focused_gates.every((g) => g.status === "PASS");
  check(gates, "every focused gate must be PASS");
  requireSha(doc.reconciliation_merge_sha, "reconciliation_merge_sha");
  requireSha(doc.post_reconciliation_tip_sha, "post_reconciliation_tip_sha");
  for (const conflict of doc.conflicts) {
    const reviewed = conflict.review_status === "APPROVED";
    check(reviewed, `conflict resolution is unreviewed: ${conflict.path}`);
  }
  const contains = isAncestor(doc.live_main_sha, doc.reconciliation_merge_sha);
  check(contains, "the reconciliation merge must contain the exact live main SHA");
  const tip = isAncestor(doc.reconciliation_merge_sha, doc.post_reconciliation_tip_sha);
  check(tip, "post_reconciliation_tip_sha must contain the reconciliation merge");
  assertPathsOwned(doc);
  if (Array.isArray(laneInputs)) {
    const lane = new Set(laneInputs.flatMap((n) => [n.pr_head_sha, n.integration_merge_sha]));
    const commits = doc.main_only_commits.map((commit) => commit.sha);
    for (const candidate of [doc.reconciliation_merge_sha, ...commits]) {
      check(!lane.has(candidate), `second merge of a recorded lane commit: ${candidate}`);
    }
  }
  return doc;
}

// --- Deterministic Markdown ---
const cell = (value) => (value === null || value === undefined ? "null" : String(value));
const bullet = (label, value) => `- ${label}: \`${cell(value)}\``;
const TABLE_HEADER = [
  "| ID | Status | Frozen SHA | Artifact SHA-256 | Owner | Reason code |",
  "| --- | --- | --- | --- | --- | --- |",
];
const row = (id, status, frozen, sha256, owner, reason) =>
  `| ${cell(id)} | ${cell(status)} | ${cell(frozen)} | ${cell(sha256)} | ${cell(owner)} | ${cell(reason)} |`;
const artifactRow = (record) => row(record.id, null, record.frozen_sha, record.sha256, null, null);

function environmentLine(level) {
  const entries = [];
  for (const command of level?.commands ?? []) {
    for (const [key, value] of Object.entries(command.environment ?? {}).sort()) {
      const guarded = isGuardedEnvironmentKey(key);
      entries.push(guarded ? `\`${REDACTED_VALUE}\`` : `\`${key}=${value}\``);
    }
  }
  return entries.length === 0 ? "- Environment: `null`" : `- Environment: ${entries.join(", ")}`;
}

function levelSection(id, level, frozen) {
  const lines = [`### Level ${id.slice(-1)}`, "", environmentLine(level), "", ...TABLE_HEADER];
  lines.push(row(id, level.status, frozen, null, null, null));
  for (const command of level.commands) {
    lines.push(row(command.id, command.status, command.frozen_sha, null, null, null));
  }
  return [...lines, ...level.artifacts.map(artifactRow), ""];
}

function externalGateRow(gate, frozen) {
  if (gate.status === "BLOCKED_EXTERNAL") {
    const reason = gate.skip_reason;
    return row(gate.id, gate.status, reason.applies_to_frozen_sha, null, reason.owner, reason.code);
  }
  const sha256 = gate.evidence.artifacts[0]?.sha256 ?? null;
  return row(gate.id, gate.status, frozen, sha256, gate.evidence.owner, null);
}

export function renderIntegrationMarkdown(document) {
  const ident = document.identity ?? {};
  const frozen = ident.frozen_sha ?? null;
  const mr = document.main_reconciliation ?? {};
  const cov = document.coverage ?? {};
  const docs = document.docs_contract ?? {};
  const rev = document.independent_review ?? {};
  const bind = document.deploy_binding;
  const own = document.release_owner;
  const out = [];
  const p = (...values) => out.push(...values);
  p("# Viva Release Readiness Evidence", "");
  p(bullet("Schema", document.schema), bullet("Run ID", document.run_id));
  p(bullet("Frozen SHA", frozen), bullet("Generated at", document.generated_at));
  p(
    ...(mandatoryEvidenceComplete(document)
      ? [`- Terminal status: ${document.terminal_status ?? deriveTerminalStatus(document)}`]
      : [bullet("Integration state", ACTIVE_MARKDOWN_STATE), bullet("Terminal status emitted", false)]),
  );
  p(bullet("Sanitized", document.sanitized), "", "## Identity", "");
  p(bullet("Repository", ident.repository), bullet("Branch", ident.branch));
  p(bullet("Audit base SHA", ident.audit_base_sha), bullet("Frozen at", ident.frozen_at));
  p(bullet("Live main SHA at start", ident.live_main_sha_at_start));
  p(bullet("Live main SHA at freeze", ident.live_main_sha_at_freeze));
  p(bullet("Worktree clean", ident.worktree_clean));
  p("", "## Lane reconciliation", "");
  p(bullet("Main reconciliation", mr.status), bullet("Live main SHA", mr.live_main_sha));
  p(bullet("Reconciliation merge SHA", mr.reconciliation_merge_sha));
  p(bullet("Program reconciliations", (document.program_reconciliations ?? []).length), "");
  p(...renderLaneTable(document.lane_inputs ?? []), "", "## Mandatory evidence", "");
  const reconciled = `${cell(cov.component_finding_instances_reconciled)}/${cell(cov.component_finding_instances_expected)} reconciled`;
  p(bullet("Coverage", reconciled), bullet("Unresolved rows", (cov.unresolved_rows ?? []).length));
  p(bullet("Ledger SHA-256", cov.ledger_sha256), "");
  for (const level of ["level_1", "level_2", "level_3"]) {
    p(...levelSection(level, document.levels[level], frozen));
  }
  p("## Public contract", "", ...TABLE_HEADER);
  p(row("docs_contract", docs.status, frozen, null, null, null));
  p(...(docs.artifacts ?? []).map(artifactRow), "", "## Independent review", "");
  p(bullet("Findings", (rev.findings ?? []).length));
  p(bullet("Independent review artifact", rev.artifact?.id ?? null), "");
  p(...TABLE_HEADER, row("independent_review", rev.status, frozen, null, null, null));
  if (rev.artifact) p(artifactRow(rev.artifact));
  p("", "## External gates", "", ...TABLE_HEADER);
  const gates = new Map((document.external_gates ?? []).map((gate) => [gate.id, gate]));
  for (const gateId of EXTERNAL_GATE_IDS) {
    const gate = gates.get(gateId);
    p(gate ? externalGateRow(gate, frozen) : row(gateId, null, null, null, null, null));
  }
  p("", "## Deploy/run binding", "");
  if (!bind) {
    p(bullet("Deploy binding", null), "");
  } else {
    p(bullet("Deploy binding frozen SHA", bind.frozen_sha));
    p(bullet("Deploy binding run ID", bind.run_id), "");
    p("| Service | Deployment ID | Image digest | Origin | In-band SHA |");
    p("| --- | --- | --- | --- | --- |");
    const line = (s) =>
      `| ${s.name} | ${s.deployment_id} | ${s.image_digest} | ${s.origin} | ${s.in_band_sha} |`;
    p(...bind.services.map(line), "");
  }
  p("## Release decision", "", bullet("Release owner", own?.owner ?? null));
  p(bullet("Decision", own?.decision ?? null), bullet("Decided at", own?.decided_at ?? null), "");
  p("## Superseded evidence", "", bullet("Supersedes run ID", document.supersedes_run_id ?? null));
  return `${out.join("\n").trimEnd()}\n`;
}

function renderLaneTable(nodes) {
  const ordered = PROGRAM_NODES.map((entry) =>
    nodes.find((node) => node.node_id === entry.node_id),
  ).filter(Boolean);
  return [
    "| Node | Rank | Namespace | Phase | PR | PR head | Integration merge | In frozen SHA |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...ordered.map(
      (n) =>
        `| ${n.node_id} | ${n.topological_rank} | ${n.namespace} | ${cell(n.split_phase)} | ${n.pr_number} | ${n.pr_head_sha} | ${n.integration_merge_sha} | ${cell(n.included_in_frozen_sha)} |`,
    ),
  ];
}

/** Hand-edited Markdown is rejected: the document is the only source of truth. */
export function assertGeneratedMarkdown(document, markdown) {
  const generated = renderIntegrationMarkdown(document) === markdown;
  check(generated, "Markdown was not generated from this evidence document");
}

// --- Deterministic CLI evidence operations ---
/** Records one already-merged Program PR from captured GitHub output. Merges nothing. */
function captureProgramInput(flags) {
  const nodeId = flag(flags, "node-id");
  const expected = NODE_BY_ID.get(nodeId);
  check(Boolean(expected), `unknown Program node: ${nodeId}`);
  check(flag(flags, "expected-branch") === expected.branch, `${nodeId}: expected branch mismatch`);
  const pr = readJson(flag(flags, "pr-json"));
  const mergeSha = flag(flags, "integration-merge-sha");
  check(pr.state === "MERGED", `${nodeId}: PR ${pr.number} is not MERGED`);
  const based = pr.baseRefName === "review-remediation/integration";
  check(based, `${nodeId}: PR ${pr.number} does not target the integration branch`);
  check(pr.headRefName === expected.branch, `${nodeId}: PR head branch mismatch`);
  const parents = git(["show", "--no-patch", "--format=%P", mergeSha], "utf8").trim().split(/\s+/);
  writeJson(path.join(flag(flags, "capture-dir"), `node-${nodeId}.json`), {
    ...expected,
    predecessor_node_ids: [...expected.predecessor_node_ids],
    pr_number: pr.number,
    pr_url: pr.url,
    pr_commit_shas: readLines(flag(flags, "pr-commits")),
    pr_head_sha: pr.headRefOid,
    integration_merge_sha: mergeSha,
    merge_parent_shas: parents.filter(Boolean),
    decision_branch: csv(flags.get("decision-branch")),
    included_in_frozen_sha: null,
    finding_ids: csv(flags.get("finding-ids")),
    proof_artifacts: csv(flags.get("proof-artifacts")),
    owner_acknowledged_handoff: flags.get("owner-acknowledged") !== "false",
  });
}

function readCapturedNodes(captureDir) {
  const nodes = readdirSync(captureDir)
    .filter((name) => /^node-.+\.json$/.test(name))
    .sort()
    .map((name) => readJson(path.join(captureDir, name)));
  check(nodes.length > 0, `no captured Program inputs in ${captureDir}`);
  return nodes;
}

function verifyProgramDag(flags) {
  const captureDir = flag(flags, "capture-dir");
  const nodes = readCapturedNodes(captureDir);
  const nodePaths = {};
  for (const node of nodes) {
    const file = path.join(captureDir, `node-${node.node_id}-paths.txt`);
    nodePaths[node.node_id] = existsSync(file) ? readLines(file) : [];
  }
  validateProgramManifest(nodes, {
    firstParent: readLines(flag(flags, "first-parent")),
    mergedPullRequests: readJson(flag(flags, "merged-prs")),
    ownership: parseProgramOwnership(readFileSync(flag(flags, "program"), "utf8")),
    nodePaths,
    frozenBinding: false,
  });
  const ledger = readFileSync(flag(flags, "ledger"), "utf8");
  for (const [, lane, recorded] of ledger.matchAll(/^Plan (\d{2}) merge SHA: ([0-9a-f]{40})$/gm)) {
    const owner = LANES[lane]?.[0];
    const merges = nodes.filter((n) => n.namespace === owner).map((n) => n.integration_merge_sha);
    const claimed = merges.length === 0 || merges.includes(recorded);
    check(claimed, `ledger records merge ${recorded} for Plan ${lane} that no node claims`);
  }
  process.stdout.write(`Program DAG verified for ${nodes.length} nodes.\n`);
}

/** Adds only the frozen SHA to the already-verified capture, then renders it. */
function bindProgramInputs(flags) {
  const frozenSha = requireSha(flag(flags, "frozen-sha"), "--frozen-sha");
  const captured = readCapturedNodes(flag(flags, "capture-dir")).map((node) => ({
    ...node,
    included_in_frozen_sha: true,
  }));
  validateProgramManifest(captured, {});
  const historyDir = flags.get("reconciliation-history-dir");
  const reconciliations = [];
  for (const name of historyDir ? readdirSync(historyDir).sort() : []) {
    if (!/^main-reconciliation-[0-9a-f]{40}\.json$/.test(name)) continue;
    const record = validateMainReconciliation(readJson(path.join(historyDir, name)), {});
    check(record.status !== "REVIEW_REQUIRED", `${name} is REVIEW_REQUIRED before the freeze`);
    reconciliations.push({ file: name, status: record.status });
  }
  const laneInputs = PROGRAM_NODES.map((entry) =>
    captured.find((node) => node.node_id === entry.node_id),
  );
  writeJson(flag(flags, "output"), {
    schema: INTEGRATION_EVIDENCE_SCHEMA,
    frozen_sha: frozenSha,
    generated_at: new Date().toISOString(),
    main_reconciliations: reconciliations,
    lane_inputs: laneInputs,
  });
  const markdown = flags.get("markdown");
  if (!markdown) return;
  mkdirSync(path.dirname(path.resolve(markdown)), { recursive: true });
  const header = ["# Viva Program Integration Merge Ledger", "", `- Frozen SHA: \`${frozenSha}\``];
  header.push(`- Program nodes: \`${laneInputs.length}\``, "");
  writeFileSync(markdown, [...header, ...renderLaneTable(laneInputs), ""].join("\n"));
}

function baseMainReconciliation(flags, status) {
  const document = {
    schema: MAIN_RECONCILIATION_SCHEMA,
    audit_base_sha: flag(flags, "audit-base-sha"),
    live_main_sha: flag(flags, "live-main-sha"),
    previous_combined_tip_sha: flag(flags, "combined-tip-sha"),
    requester_role: "PLAN_15_EVIDENCE",
    status,
  };
  const empty = keys(`main_only_commits changed_paths path_owner_dispositions conflicts
    affected_node_ids affected_finding_ids focused_gates affected_owner_reviews`);
  const absent = keys(`program_coordinator_review independent_review merge_actor_role
    reconciliation_merge_sha post_reconciliation_tip_sha`);
  for (const key of empty) document[key] = [];
  for (const key of absent) document[key] = null;
  return document;
}

function mainReconciliationNotRequired(flags) {
  const document = baseMainReconciliation(flags, "NOT_REQUIRED");
  validateMainReconciliation(document, {});
  writeJson(flag(flags, "output"), document);
}

/** Writes the request only. It never approves a review or claims RECONCILED. */
function mainReconciliationRequest(flags) {
  const document = baseMainReconciliation(flags, "REVIEW_REQUIRED");
  const ownership = parseProgramOwnership(readFileSync(flag(flags, "program"), "utf8"));
  document.main_only_commits = readLines(flag(flags, "commits")).map((line) => {
    const [commitSha, authoredAt, ...subject] = line.split(/\s+/);
    return { sha: commitSha, authored_at: authoredAt, subject: subject.join(" ") };
  });
  const paths = readLines(flag(flags, "paths"));
  document.changed_paths = paths.map((line) => line.split("\t").at(-1).trim());
  document.path_owner_dispositions = document.changed_paths.map((changed) => ({
    path: changed,
    owner_namespace: ownerNamespaceForPath(changed, ownership) ?? "PROGRAM",
    disposition: "OWNER_REVIEW_REQUIRED",
  }));
  const owners = [...new Set(document.path_owner_dispositions.map((e) => e.owner_namespace))];
  document.focused_gates = owners
    .sort()
    .map((namespace) => ({ id: `${namespace.toLowerCase()}_focused_gate`, status: "ACTIVE" }));
  validateMainReconciliation(document, {});
  writeJson(flag(flags, "output"), document);
}

/** Hashes each named tracked file at the frozen SHA and binds it to the lane's B node. */
function recordHandoff(flags) {
  const namespace = flag(flags, "namespace");
  const frozenSha = requireSha(flag(flags, "frozen-sha"), "--frozen-sha");
  const output = flag(flags, "output");
  const files = csv(flag(flags, "files"));
  check(files.length > 0, "--files must name at least one tracked file");
  const sibling = path.join(path.dirname(path.resolve(output)), "lane-inputs.json");
  const bound = readJson(flags.get("lane-inputs") ?? sibling);
  const nodes = (bound.lane_inputs ?? bound)
    .filter((node) => node.namespace === namespace)
    .sort((left, right) => left.topological_rank - right.topological_rank);
  check(nodes.length > 0, `no bound lane input records for namespace ${namespace}`);
  const boundNodeId = nodes.at(-1).node_id;
  writeJson(output, {
    schema: INTEGRATION_HANDOFF_SCHEMA,
    namespace,
    frozen_sha: frozenSha,
    generated_at: new Date().toISOString(),
    nodes: nodes.map((node) => ({
      node_id: node.node_id,
      split_phase: node.split_phase,
      pr_number: node.pr_number,
      pr_head_sha: node.pr_head_sha,
      integration_merge_sha: node.integration_merge_sha,
    })),
    files: files.map((file) => {
      const blob = git(["show", `${frozenSha}:${file}`]);
      return { path: file, sha256: sha256(blob), bytes: blob.length, bound_node_id: boundNodeId };
    }),
    owner_acknowledged_handoff: nodes.every((node) => node.owner_acknowledged_handoff === true),
  });
}

const CLI_COMMANDS = new Map([
  ["capture-program-input", captureProgramInput],
  ["verify-program-dag", verifyProgramDag],
  ["bind-program-inputs", bindProgramInputs],
  ["main-reconciliation-not-required", mainReconciliationNotRequired],
  ["main-reconciliation-request", mainReconciliationRequest],
  ["record-handoff", recordHandoff],
  ...EVIDENCE_LEVEL_COMMANDS,
]);

function main(argv) {
  const command = CLI_COMMANDS.get(argv[0]);
  if (!command) {
    process.stderr.write(`Unknown command: ${String(argv[0])}\n`);
    process.stderr.write(`Expected one of: ${[...CLI_COMMANDS.keys()].join(", ")}\n`);
    process.exitCode = 64;
    return;
  }
  try {
    command(parseFlags(argv.slice(1)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
