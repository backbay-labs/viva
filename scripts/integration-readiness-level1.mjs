// INTEGRATION-003 — Level 1 lane proof and finding reconciliation, made executable.
//
// Level 1 is the only mandatory level that proves *provenance* rather than behavior: every
// canonical remediation record must point through one of the sixteen verified Program node
// records to an exact PR head and integration merge commit that the frozen SHA already
// contains, and the 128 component finding instances must reconcile with zero unmapped,
// unaliased, unproven, UNSTARTED, or decision-blocked rows.
//
// Two inputs are read rather than hardcoded, because both are coordinator-owned and both
// move: the finding-coverage ledger supplies the corpus arithmetic and the recorded
// decision selections, and `docs/decisions/2026-08-23-plan-amendments.md` supplies the
// amendments that make the node manifest read AS AMENDED — the sub-branch a node was
// admitted from (A-04's `review-remediation/12a`, A-06's `13a`) and the appendix admission
// PRs that ride a node (A-14's supplementary 04B fix, A-36.1/A-38.1's squashed node-08
// appendices, A-38.4's 14B appendix, A-40.1's node-11 appendix). Hardcoding the
// pre-amendment expectations would make Level 1 reject the history the Program actually
// integrated, so the parse is the contract and this module never edits either document.
import {
  check,
  EXTERNAL_GATE_IDS,
  exactKeys,
  fail,
  isRecord,
  keys,
  NAMESPACES,
  NODE_BY_ID,
  PROGRAM_NODES,
  RUN_ID,
  requireArray,
  requireEvidencePath,
  requireHex64,
  requireInstant,
  requireSha,
  requireText,
  sha256,
  shape,
  validateShape,
} from "./integration-readiness-shared.mjs";

export const LEVEL_1_SCHEMA = "viva.integration_level_1.v1";
export const COMPONENT_FINDING_INSTANCES = 128;
export const COMPONENT_REVIEW_DOCUMENTS = 12;
export const LANE_NAMESPACE_COUNT = 12;
export const PROGRAM_NODE_COUNT = PROGRAM_NODES.length;
export const LEDGER_PATH =
  "docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md";
export const AMENDMENTS_PATH = "docs/decisions/2026-08-23-plan-amendments.md";
export const CANONICAL_DISPOSITIONS = Object.freeze(
  "TESTED_FIX BATCH_FIX DUPLICATE_ALIAS DECISION_BLOCKED EXTERNAL_EVIDENCE DEFERRED".split(" "),
);
export const DECISION_IDS = Object.freeze(
  "D-01 D-02 D-03 D-04 D-05 D-06 D-07 D-08 D-09".split(" "),
);

const INSTANCES_MESSAGE = `coverage reconciliation expected ${COMPONENT_FINDING_INSTANCES} instances`;
const DECISION_MESSAGE = "decision-blocked finding remains unresolved";
const HEAD_MESSAGE = "proof artifact is not bound to the node PR head SHA";
const FROZEN_MESSAGE = "integration merge SHA is not included in frozen SHA";
const MANIFEST_MESSAGE = `integration manifest expected ${PROGRAM_NODE_COUNT} Program nodes`;
const SPLIT_MESSAGE = "split phases must use distinct PR and merge commits";
const ALIAS_MESSAGE = "duplicate finding instance lacks canonical alias";
const COORDINATOR_MESSAGE = "integration-owned record must bind to a coordinator commit";
const TUPLE_MESSAGE = "names a node tuple absent from lane_inputs";

/** A proof cell must name something a shell can run, not a claim about the code. */
const EXECUTABLE =
  /^(?:[A-Z][A-Z0-9_]*=\S*\s+)*(?:env|cargo|bun|bunx|node|npx|npm|pnpm|sh|bash|docker|psql|git|rustup|openssl|rg|grep|ag|ack|scripts\/[\w./-]+|\.\/[\w./-]+)\b/;
/** A source scan proves a spelling, never a behavior. */
const GREP_ONLY = /^(?:rg|grep|ag|ack)\b/;
const BEHAVIORAL = Object.freeze(["TESTED_FIX"]);

const LEVEL_1_KEYS = keys(`schema run_id frozen_sha generated_at ledger_sha256 amendments_sha256
  reconciliation decisions lane_inputs records status`);
const RECONCILIATION_SPEC = shape(`component_review_documents:count
  component_finding_instances:count critical:count important:count minor:count
  source_lane_namespaces:count program_integration_nodes:count unmapped_source_instances:count
  duplicate_source_instances_without_canonical_alias:count canonical_rows_with_missing_proof:count
  unstarted_rows:count decision_blocked_rows:count`);
const NODE_SPEC = shape(`node_id:text namespace:text split_phase:any branch:text pr_number:integer
  pr_head_sha:sha integration_merge_sha:sha appendix_admissions:array`);
const APPENDIX_SPEC = shape(`pr_number:integer amendment_id:text pr_head_sha:sha
  integration_merge_sha:sha pr_commit_shas:array`);
const RECORD_SPEC = shape(`canonical_id:text source_instances:array owner_namespace:text node_id:any
  pr_head_sha:any integration_merge_sha:any coordinator_commit_sha:any disposition:text
  red_command:any red_failure:any green_command:text green_result:text adversarial_control:any
  artifact_paths:array external_gates:array status:text`);
const DECISION_SPEC = shape(`id:text selected_branch:text resolved_by:array status:text`);

// --- The coordinator documents ---

const cells = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
const unquote = (value) => value.replace(/`/g, "").trim();
const isDataRow = (line) => line.startsWith("|") && !/^\|\s*-+/.test(line);

/**
 * Reads the finding-coverage ledger's immutable corpus arithmetic, its owning-plan
 * namespaces, its decision registry, and the status of every traceability row.
 */
export function parseCoverageLedger(markdown) {
  const lines = markdown.split("\n");
  const severity = { Critical: 0, Important: 0, Minor: 0 };
  const namespaces = new Set();
  const decisions = [];
  const statuses = { PROVEN: 0, UNSTARTED: 0, DECISION_BLOCKED: 0 };
  const rows = [];
  const canonicalIds = new Set();
  let section = "";
  let componentSections = 0;
  let inComponents = false;
  let inOwners = false;
  let inDecisions = false;
  for (const line of lines) {
    if (line.startsWith("## ") || line.startsWith("### ")) {
      section = line.replace(/^#+\s*/, "");
      inOwners = line.startsWith("## Owning plan filenames");
      inDecisions = line.startsWith("## Coordinator decision registry");
      if (line.startsWith("## Component finding-instance ledger")) inComponents = true;
      else if (line.startsWith("## ")) inComponents = false;
      if (inComponents && line.startsWith("### ")) {
        if (/^### Finding-instance versus canonical-task reconciliation/.test(line)) {
          inComponents = false;
        } else componentSections += 1;
      }
      continue;
    }
    if (!isDataRow(line)) continue;
    const columns = cells(line);
    if (inOwners && columns.length === 2) {
      const namespace = unquote(columns[0]);
      if (/^[A-Z]+$/.test(namespace) && namespace !== "INTEGRATION") namespaces.add(namespace);
      continue;
    }
    if (inDecisions && /^`D-0\d`$/.test(columns[0] ?? "")) {
      decisions.push({
        id: unquote(columns[0]),
        scope: columns[1],
        current_state: unquote(columns[2]),
        blocks: columns[3] ?? "",
      });
      continue;
    }
    if (columns.length < 6) continue;
    const row = {
      section,
      source_key: columns[0],
      canonical_id: unquote(columns[1]),
      disposition: unquote(columns[3]),
      required_proof: columns[4],
      status: unquote(columns[5]),
    };
    if (!/^[A-Z][A-Z0-9-]+$/.test(row.canonical_id)) continue;
    rows.push(row);
    canonicalIds.add(row.canonical_id);
    if (Object.hasOwn(statuses, row.status)) statuses[row.status] += 1;
    const severityLabel = /^(Critical|Important|Minor)\b/.exec(row.source_key)?.[1];
    if (inComponents && severityLabel) severity[severityLabel] += 1;
  }
  const instances = severity.Critical + severity.Important + severity.Minor;
  return {
    component_review_documents: componentSections,
    component_finding_instances: instances,
    severity,
    namespaces,
    decisions,
    statuses,
    rows,
    canonical_ids: canonicalIds,
  };
}

const AMENDMENT_HEADING =
  /^## ((?:[AW]-\d+)(?:\s*\+\s*[AW]-\d+)*)\s+\((\d{4}-\d{2}-\d{2})\)\s+[—-]+\s*(.+)$/;
const NODE_MENTION = /\bnodes?[\s-]+(0[3-9]|1[0-4])([AB])?\b/gi;
const BRANCH_MENTION = /`review-remediation\/([A-Za-z0-9._-]+)`/g;
const PULL_REQUEST_MENTION = /#(\d+)\b/g;

const mentionedNodes = (text) => {
  const found = new Set();
  for (const match of text.matchAll(NODE_MENTION)) {
    const id = `${match[1]}${(match[2] ?? "").toUpperCase()}`;
    if (NODE_BY_ID.has(id)) found.add(id);
  }
  return [...found];
};

/**
 * Parses every coordinator-ratified amendment and waiver into a record. Clauses that admit
 * an appendix or supplementary PR are extracted separately so an admission binds to the
 * exact PR number and node the coordinator named, never to the whole amendment's text.
 */
export function parsePlanAmendments(markdown) {
  const sections = [];
  let current = null;
  for (const line of markdown.split("\n")) {
    const heading = AMENDMENT_HEADING.exec(line);
    if (heading) {
      current = { ids: heading[1].split("+").map((id) => id.trim()), date: heading[2] };
      current.title = heading[3].trim();
      current.body = [current.title];
      sections.push(current);
      continue;
    }
    if (line.startsWith("## ")) current = null;
    else if (current) current.body.push(line);
  }
  const amendments = [];
  for (const section of sections) {
    const body = section.body.join("\n");
    const clauses = body
      .split(/\n(?=\s*\d+\.\s)|\n{2,}/)
      .map((c) => c.trim())
      .filter(Boolean);
    for (const id of section.ids) {
      const admissions = [];
      for (const clause of clauses) {
        if (!/appendix|supplementar/i.test(clause)) continue;
        for (const match of clause.matchAll(PULL_REQUEST_MENTION)) {
          admissions.push({
            pull_request: Number(match[1]),
            amendment_id: id,
            node_ids: mentionedNodes(clause),
            squashed: /squash/i.test(clause),
          });
        }
      }
      amendments.push({
        id,
        date: section.date,
        title: section.title,
        body,
        node_ids: mentionedNodes(body),
        branches: [...body.matchAll(BRANCH_MENTION)].map((m) => `review-remediation/${m[1]}`),
        pull_requests: [...body.matchAll(PULL_REQUEST_MENTION)].map((m) => Number(m[1])),
        admissions,
      });
    }
  }
  return amendments;
}

/** node id -> the branches a coordinator amendment authorized that node to be admitted from. */
export function amendedNodeBranches(amendments) {
  const branches = new Map();
  for (const amendment of amendments) {
    if (amendment.node_ids.length !== 1 || amendment.branches.length === 0) continue;
    const nodeId = amendment.node_ids[0];
    if (!branches.has(nodeId)) branches.set(nodeId, new Set());
    for (const branch of amendment.branches) branches.get(nodeId).add(branch);
  }
  return branches;
}

/** PR number -> the appendix/supplementary admission a coordinator amendment recorded. */
export function recordedAppendixAdmissions(amendments) {
  const admissions = new Map();
  for (const amendment of amendments) {
    for (const admission of amendment.admissions) {
      const previous = admissions.get(admission.pull_request);
      if (previous) {
        previous.node_ids = [...new Set([...previous.node_ids, ...admission.node_ids])];
        previous.squashed = previous.squashed || admission.squashed;
        continue;
      }
      admissions.set(admission.pull_request, { ...admission });
    }
  }
  return admissions;
}

// --- Level 1 validation ---

function validateReconciliation(reconciliation) {
  validateShape(reconciliation, RECONCILIATION_SPEC, "reconciliation", { join: "." });
  const { critical, important, minor } = reconciliation;
  const counted = reconciliation.component_finding_instances === COMPONENT_FINDING_INSTANCES;
  check(counted && critical + important + minor === COMPONENT_FINDING_INSTANCES, INSTANCES_MESSAGE);
  const documents = reconciliation.component_review_documents === COMPONENT_REVIEW_DOCUMENTS;
  check(
    documents,
    `coverage reconciliation expected ${COMPONENT_REVIEW_DOCUMENTS} review documents`,
  );
  const namespaces = reconciliation.source_lane_namespaces === LANE_NAMESPACE_COUNT;
  check(namespaces, `coverage reconciliation expected ${LANE_NAMESPACE_COUNT} lane namespaces`);
  check(reconciliation.program_integration_nodes === PROGRAM_NODE_COUNT, MANIFEST_MESSAGE);
  check(reconciliation.unmapped_source_instances === 0, "unmapped source instances must be zero");
  check(reconciliation.duplicate_source_instances_without_canonical_alias === 0, ALIAS_MESSAGE);
  const proven = reconciliation.canonical_rows_with_missing_proof === 0;
  check(proven, "canonical rows with missing proof must be zero");
  check(reconciliation.unstarted_rows === 0, "UNSTARTED rows must be zero");
  check(reconciliation.decision_blocked_rows === 0, DECISION_MESSAGE);
}

function validateDecisions(decisions) {
  requireArray(decisions, "decisions");
  const byId = new Map();
  for (const decision of decisions) {
    validateShape(decision, DECISION_SPEC, `decision ${decision?.id ?? "?"}`, { join: "." });
    check(DECISION_IDS.includes(decision.id), `unknown decision: ${decision.id}`);
    check(!byId.has(decision.id), `duplicate decision: ${decision.id}`);
    byId.set(decision.id, decision);
    check(decision.status === "RESOLVED", DECISION_MESSAGE);
  }
  for (const id of DECISION_IDS) check(byId.has(id), `decision is unrecorded: ${id}`);
}

function validateAppendixAdmission(node, admission, admissions) {
  const label = `node ${node.node_id} appendix admission`;
  validateShape(admission, APPENDIX_SPEC, label, { join: " " });
  const recorded = admissions.get(admission.pr_number);
  const message = `appendix admission is not recorded in the plan amendments: #${admission.pr_number}`;
  check(Boolean(recorded), message);
  const named = recorded.amendment_id === admission.amendment_id;
  check(
    named,
    `${label} #${admission.pr_number} names amendment ${admission.amendment_id}, not ${recorded.amendment_id}`,
  );
  const scoped = recorded.node_ids.length === 0 || recorded.node_ids.includes(node.node_id);
  check(
    scoped,
    `appendix admission ${admission.pr_number} is not recorded for node ${node.node_id}`,
  );
  const commits = requireArray(admission.pr_commit_shas, `${label} pr_commit_shas`);
  check(commits.length > 0, `${label} pr_commit_shas must be non-empty`);
  for (const [index, commit] of commits.entries()) requireSha(commit, `${label} commit ${index}`);
  check(
    commits.at(-1) === admission.pr_head_sha,
    `${label} pr_commit_shas must end in pr_head_sha`,
  );
  const squashed = !recorded.squashed || commits.length === 1;
  check(
    squashed,
    `squashed appendix admission must name exactly one commit: #${admission.pr_number}`,
  );
}

function validateLaneInputs(laneInputs, options) {
  const { frozenSha, isAncestor, amendedBranches, admissions } = options;
  requireArray(laneInputs, "lane_inputs");
  check(laneInputs.length === PROGRAM_NODE_COUNT, MANIFEST_MESSAGE);
  const byId = new Map();
  for (const node of laneInputs) {
    validateShape(node, NODE_SPEC, `node ${node?.node_id ?? "?"}`);
    const expected = NODE_BY_ID.get(node.node_id);
    check(Boolean(expected), MANIFEST_MESSAGE);
    check(!byId.has(node.node_id), `duplicate node id: ${node.node_id}`);
    byId.set(node.node_id, node);
    check(node.namespace === expected.namespace, `node ${node.node_id}: namespace mismatch`);
    check(node.split_phase === expected.split_phase, `node ${node.node_id}: split_phase mismatch`);
    const allowed = new Set([expected.branch, ...(amendedBranches.get(node.node_id) ?? [])]);
    const branch = allowed.has(node.branch);
    check(
      branch,
      `node ${node.node_id}: branch ${node.branch} is neither the Program branch nor amended`,
    );
    check(isAncestor(node.integration_merge_sha, frozenSha), FROZEN_MESSAGE);
    const head = isAncestor(node.pr_head_sha, frozenSha);
    check(head, `PR head SHA is not included in frozen SHA: ${node.node_id}`);
    for (const admission of requireArray(node.appendix_admissions, "appendix_admissions")) {
      validateAppendixAdmission(node, admission, admissions);
    }
  }
  for (const node of PROGRAM_NODES) check(byId.has(node.node_id), MANIFEST_MESSAGE);
  for (const field of ["pr_number", "pr_head_sha", "integration_merge_sha"]) {
    const seen = new Map();
    for (const node of laneInputs) {
      const previous = seen.get(node[field]);
      check(!previous || previous.namespace !== node.namespace, SPLIT_MESSAGE);
      check(!previous, `duplicate ${field}: ${node[field]}`);
      seen.set(node[field], node);
    }
  }
  return byId;
}

function validateProof(record) {
  const id = record.canonical_id;
  const behavioral = BEHAVIORAL.includes(record.disposition);
  if (behavioral) {
    const red = typeof record.red_command === "string" && record.red_command.trim() !== "";
    check(red, `record ${id}: a TESTED_FIX record requires a RED command`);
    requireText(record.red_failure, `record ${id}: red_failure`);
  }
  for (const [field, value] of Object.entries({
    red: record.red_command,
    green: record.green_command,
  })) {
    if (value === null || value === "") continue;
    const executable = typeof value === "string" && EXECUTABLE.test(value.trim());
    check(executable, `record ${id}: ${field} proof is prose, not an executable command`);
  }
  const grep = behavioral && GREP_ONLY.test(String(record.green_command).trim());
  check(!grep, `record ${id}: a behavioral claim cannot rest on a source grep`);
  const control =
    typeof record.adversarial_control === "string" && record.adversarial_control.trim();
  check(Boolean(control), `record ${id} requires an adversarial or mutation control`);
  const artifacts = requireArray(record.artifact_paths, `record ${id}: artifact_paths`);
  check(artifacts.length > 0, `record ${id}: artifact_paths must be non-empty`);
  for (const artifact of artifacts) requireEvidencePath(artifact, `record ${id}: artifact`);
}

function validateRecord(record, nodes) {
  validateShape(record, RECORD_SPEC, `record ${record?.canonical_id ?? "?"}`, {
    optional: ["canonical_alias_of"],
  });
  const id = record.canonical_id;
  const known = CANONICAL_DISPOSITIONS.includes(record.disposition);
  check(known, `record ${id}: unknown disposition ${record.disposition}`);
  const tuple = [record.node_id, record.pr_head_sha, record.integration_merge_sha];
  const coordinator = record.coordinator_commit_sha;
  if (id.startsWith("INTEGRATION-")) {
    const owned = record.owner_namespace === "INTEGRATION" && tuple.every((v) => v === null);
    check(owned && typeof coordinator === "string", COORDINATOR_MESSAGE);
    requireSha(coordinator, `record ${id}: coordinator_commit_sha`);
  } else {
    const lane = tuple.every((value) => typeof value === "string");
    check(
      lane && coordinator === null,
      `record ${id} must name exactly one of the lane tuple or a coordinator commit`,
    );
    const node = nodes.get(record.node_id);
    check(Boolean(node), `record ${id} ${TUPLE_MESSAGE}`);
    check(record.pr_head_sha === node.pr_head_sha, HEAD_MESSAGE);
    check(
      record.integration_merge_sha === node.integration_merge_sha,
      `record ${id} ${TUPLE_MESSAGE}`,
    );
    check(
      record.owner_namespace === node.namespace,
      `record ${id}: owner_namespace is not the node's`,
    );
  }
  if (record.disposition === "EXTERNAL_EVIDENCE") {
    const gates = requireArray(record.external_gates, `record ${id}: external_gates`);
    check(
      gates.length > 0,
      `record ${id}: an EXTERNAL_EVIDENCE row must name at least one OPS gate`,
    );
    for (const gate of gates) {
      check(EXTERNAL_GATE_IDS.includes(gate), `record ${id}: unknown external gate ${gate}`);
    }
    const credited = record.status !== "PASS";
    check(credited, `record ${id} is EXTERNAL_EVIDENCE and cannot be credited as a code PASS`);
  }
  validateProof(record);
}

function validateSourceInstances(records) {
  const seen = new Map();
  for (const record of records) {
    for (const instance of requireArray(record.source_instances, "source_instances")) {
      requireText(instance, "source instance");
      const previous = seen.get(instance);
      if (!previous) {
        seen.set(instance, record);
        continue;
      }
      // One check, so every branch is load-bearing: a repeat is legal only when this
      // record is the DUPLICATE_ALIAS of the exact canonical task that already claimed it.
      const alias = record.disposition === "DUPLICATE_ALIAS" ? record.canonical_alias_of : null;
      check(
        alias === previous.canonical_id,
        `${ALIAS_MESSAGE}: ${record.canonical_id} does not alias ${previous.canonical_id}`,
      );
    }
  }
}

export function validateLevelOneEvidence(document, options = {}) {
  const { isAncestor = () => true, amendments = [] } = options;
  exactKeys(document, LEVEL_1_KEYS, "level 1 evidence", ["failures"]);
  check(document.schema === LEVEL_1_SCHEMA, `schema must be ${LEVEL_1_SCHEMA}`);
  check(RUN_ID.test(document.run_id ?? ""), "run_id is malformed");
  requireSha(document.frozen_sha, "frozen_sha");
  requireInstant(document.generated_at, "generated_at");
  requireHex64(document.ledger_sha256, "ledger_sha256");
  requireHex64(document.amendments_sha256, "amendments_sha256");
  validateReconciliation(document.reconciliation);
  validateDecisions(document.decisions);
  const nodes = validateLaneInputs(document.lane_inputs, {
    frozenSha: document.frozen_sha,
    isAncestor,
    amendedBranches: amendedNodeBranches(amendments),
    admissions: recordedAppendixAdmissions(amendments),
  });
  const records = requireArray(document.records, "records");
  check(records.length > 0, "records must name at least one canonical remediation record");
  const ids = new Set();
  for (const record of records) {
    check(isRecord(record), "record must be an object");
    check(!ids.has(record.canonical_id), `duplicate canonical record: ${record.canonical_id}`);
    ids.add(record.canonical_id);
    validateRecord(record, nodes);
  }
  validateSourceInstances(records);
  check(document.status === "PASS", `level 1 status must be PASS, not ${document.status}`);
  return document;
}

// --- Reconciliation over the coordinator documents ---

/**
 * Derives the Level 1 document from the ledger and the amendments. A failing derivation is
 * returned as a FAIL document naming its exact failure rather than thrown, so the freeze
 * barrier records why Level 1 did not pass instead of losing the reason to a stack trace.
 */
export function reconcileLevelOne(input) {
  const { ledgerMarkdown, amendmentsMarkdown, laneInputs, records, frozenSha, runId } = input;
  const { generatedAt = new Date().toISOString(), isAncestor } = input;
  const ledger = parseCoverageLedger(ledgerMarkdown);
  const amendments = parsePlanAmendments(amendmentsMarkdown);
  const bySection = new Map();
  let duplicates = 0;
  for (const row of ledger.rows) {
    if (row.disposition === "DUPLICATE_ALIAS") continue;
    const key = `${row.section} ${row.source_key}`;
    if (bySection.has(key)) duplicates += 1;
    bySection.set(key, row);
  }
  const document = {
    schema: LEVEL_1_SCHEMA,
    run_id: runId,
    frozen_sha: frozenSha,
    generated_at: generatedAt,
    ledger_sha256: sha256(ledgerMarkdown),
    amendments_sha256: sha256(amendmentsMarkdown),
    reconciliation: {
      component_review_documents: ledger.component_review_documents,
      component_finding_instances: ledger.component_finding_instances,
      critical: ledger.severity.Critical,
      important: ledger.severity.Important,
      minor: ledger.severity.Minor,
      source_lane_namespaces: ledger.namespaces.size,
      program_integration_nodes: laneInputs.length,
      // A row is unmapped when its canonical ID names no lane namespace and is not one of
      // the coordinator's own INTEGRATION- rows. Counting empty IDs instead would be
      // vacuous: `parseCoverageLedger` already drops a row that has none.
      unmapped_source_instances: ledger.rows.filter((row) => {
        const namespace = row.canonical_id.split("-")[0];
        return !NAMESPACES.includes(namespace);
      }).length,
      duplicate_source_instances_without_canonical_alias: duplicates,
      canonical_rows_with_missing_proof: ledger.rows.filter((r) => r.required_proof === "").length,
      unstarted_rows: ledger.statuses.UNSTARTED,
      decision_blocked_rows: ledger.statuses.DECISION_BLOCKED,
    },
    decisions: ledger.decisions.map((decision) => ({
      id: decision.id,
      selected_branch: decision.current_state,
      resolved_by: [`${decision.id} coordinator decision registry row`],
      status: /DECISION_REQUIRED/.test(decision.current_state) ? "DECISION_REQUIRED" : "RESOLVED",
    })),
    lane_inputs: laneInputs,
    records,
    status: "PASS",
  };
  try {
    validateLevelOneEvidence(document, { isAncestor, amendments });
  } catch (error) {
    document.status = "FAIL";
    document.failures = [error.message];
  }
  return document;
}

/** Recovers `$RUN_ID` from `artifacts/integration-readiness/$RUN_ID/lane-inputs.json`. */
export function runIdFromArtifactPath(file) {
  const candidate = String(file).split("/").at(-2) ?? "";
  return RUN_ID.test(candidate) ? candidate : "";
}

/** `reconcile` — Task 3 Step 5. Reads only; writes one evidence document. */
export function reconcileCommand(flags, io) {
  const { flag, readFileSync, readJson, writeJson, gitIsAncestor } = io;
  const laneInputsPath = flag(flags, "lane-inputs");
  const bound = readJson(laneInputsPath);
  const laneInputs = (bound.lane_inputs ?? bound).map((node) => ({
    node_id: node.node_id,
    namespace: node.namespace,
    split_phase: node.split_phase,
    branch: node.branch,
    pr_number: node.pr_number,
    pr_head_sha: node.pr_head_sha,
    integration_merge_sha: node.integration_merge_sha,
    appendix_admissions: node.appendix_admissions ?? [],
  }));
  const recordsFile = flags.get("records");
  const document = reconcileLevelOne({
    ledgerMarkdown: readFileSync(flag(flags, "ledger"), "utf8"),
    amendmentsMarkdown: readFileSync(flags.get("amendments") ?? AMENDMENTS_PATH, "utf8"),
    laneInputs,
    records: recordsFile ? readJson(recordsFile) : [],
    frozenSha: requireSha(flag(flags, "frozen-sha"), "--frozen-sha"),
    // `bind-program-inputs` writes no run id, so the plan's Step 5 invocation supplies it
    // through the artifact path it already names: `.../integration-readiness/$RUN_ID/…`.
    runId: flags.get("run-id") ?? bound.run_id ?? runIdFromArtifactPath(laneInputsPath),
    generatedAt: new Date().toISOString(),
    isAncestor: gitIsAncestor,
  });
  writeJson(flag(flags, "output"), document);
  if (document.status !== "PASS") fail(`Level 1 reconciliation FAILED: ${document.failures[0]}`);
  process.stdout.write(`Level 1 reconciliation PASS for ${document.frozen_sha}.\n`);
}
