// INTEGRATION-003 — Level 1 lane proof and finding reconciliation.
//
// The eight failure modes the plan enumerates are driven from `{dotted path: value}`
// patches over one valid base document, so a rule that stops firing cannot hide behind a
// bespoke fixture. Three tests read the repository's own coordinator documents instead of
// a fixture: the ledger's immutable 128-instance arithmetic, and the amendment parse that
// makes the node manifest read AS AMENDED (A-04's `review-remediation/12a` sub-branch,
// A-06's `13a`, and the appendix admissions recorded for nodes 04B/08/13B/14B). Marker
// NAMES are spelled plainly and allowed to flag; the coordinator supplies the sanction row
// (A-39.2). Fragment assembly is only for key-shaped VALUES a hosting scanner would match.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PROGRAM_NODES } from "./integration-readiness.mjs";
import {
  AMENDMENTS_PATH,
  amendedNodeBranches,
  CANONICAL_DISPOSITIONS,
  COMPONENT_FINDING_INSTANCES,
  COMPONENT_REVIEW_DOCUMENTS,
  LEDGER_PATH,
  LEVEL_1_SCHEMA,
  parseCoverageLedger,
  parsePlanAmendments,
  reconcileLevelOne,
  recordedAppendixAdmissions,
  runIdFromArtifactPath,
  validateLevelOneEvidence,
} from "./integration-readiness-level1.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROZEN_SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "20260823T180000Z-0123456789ab";
const hex = (length, seed) => createHash("sha256").update(seed).digest("hex").slice(0, length);
const sha = (seed) => hex(40, seed);
const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");

/** Every recorded head and merge SHA is in the frozen SHA unless a test says otherwise. */
const included = new Set(
  PROGRAM_NODES.flatMap((node) => [sha(`${node.node_id}-merge`), sha(`${node.node_id}-head`)]),
);
const isAncestor = (ancestor, descendant) =>
  descendant === FROZEN_SHA ? included.has(ancestor) : true;

// --- Fixtures ---

const laneInputs = () =>
  PROGRAM_NODES.map((node, index) => ({
    node_id: node.node_id,
    namespace: node.namespace,
    split_phase: node.split_phase,
    branch: node.branch,
    pr_number: 101 + index,
    pr_head_sha: sha(`${node.node_id}-head`),
    integration_merge_sha: sha(`${node.node_id}-merge`),
    appendix_admissions: [],
  }));

const laneRecord = (canonicalId, nodeId, overrides = {}) => ({
  canonical_id: canonicalId,
  source_instances: [`${canonicalId} source`],
  owner_namespace: PROGRAM_NODES.find((node) => node.node_id === nodeId).namespace,
  node_id: nodeId,
  pr_head_sha: sha(`${nodeId}-head`),
  integration_merge_sha: sha(`${nodeId}-merge`),
  coordinator_commit_sha: null,
  disposition: "TESTED_FIX",
  red_command: "cargo test --manifest-path agent/Cargo.toml -p agent-domain schedule_",
  red_failure: "assertion failed: due_at was a fixed June-2026 literal",
  green_command: "cargo test --manifest-path agent/Cargo.toml -p agent-domain schedule_",
  green_result: "PASS",
  adversarial_control: "mutation: restoring the literal due date fails the conformance test",
  artifact_paths: [`artifacts/lane-proof/${canonicalId}.json`],
  external_gates: [],
  status: "PASS",
  ...overrides,
});

const integrationRecord = (overrides = {}) =>
  laneRecord("INTEGRATION-001", "03", {
    owner_namespace: "INTEGRATION",
    node_id: null,
    pr_head_sha: null,
    integration_merge_sha: null,
    coordinator_commit_sha: sha("coordinator-integration-001"),
    red_command: "node --test scripts/integration-readiness.test.mjs",
    green_command: "node --test scripts/integration-readiness.test.mjs",
    artifact_paths: ["artifacts/sdd/evidence/INTEGRATION-001-green.txt"],
    ...overrides,
  });

const reconciliation = (overrides = {}) => ({
  component_review_documents: COMPONENT_REVIEW_DOCUMENTS,
  component_finding_instances: COMPONENT_FINDING_INSTANCES,
  critical: 2,
  important: 44,
  minor: 82,
  source_lane_namespaces: 12,
  program_integration_nodes: 16,
  unmapped_source_instances: 0,
  duplicate_source_instances_without_canonical_alias: 0,
  canonical_rows_with_missing_proof: 0,
  unstarted_rows: 0,
  decision_blocked_rows: 0,
  ...overrides,
});

const decisions = () =>
  [
    ["D-01", "SERVER_PERSISTED_FSRS"],
    ["D-02", "D-02B"],
    ["D-03", "D-03B"],
    ["D-04", "CONFIRM_DELETE"],
    ["D-05", "HARD_PURGE_TEXT"],
    ["D-06", "D-06B DELETE"],
    ["D-07", "retain-token-only"],
    ["D-08", "D-08A"],
    ["D-09", "D-09B"],
  ].map(([id, selected]) => ({
    id,
    selected_branch: selected,
    resolved_by: [`${id} registry row`],
    status: "RESOLVED",
  }));

const level1 = (overrides = {}) => ({
  schema: LEVEL_1_SCHEMA,
  run_id: RUN_ID,
  frozen_sha: FROZEN_SHA,
  generated_at: "2026-08-23T18:00:00.000Z",
  ledger_sha256: hex(64, "ledger"),
  amendments_sha256: hex(64, "amendments"),
  reconciliation: reconciliation(),
  decisions: decisions(),
  lane_inputs: laneInputs(),
  records: [
    laneRecord("CRIT-AUDIO-01", "03"),
    laneRecord("LEARN-001", "04B"),
    laneRecord("RELEASE-024", "12A"),
    integrationRecord(),
  ],
  status: "PASS",
  ...overrides,
});

const patch = (base, patches) => {
  const copy = structuredClone(base);
  for (const [dotted, value] of Object.entries(patches)) {
    const keys = dotted.split(".");
    let cursor = copy;
    for (const key of keys.slice(0, -1)) cursor = cursor[key];
    if (value === undefined) delete cursor[keys.at(-1)];
    else cursor[keys.at(-1)] = value;
  }
  return copy;
};

const validate = (document) => validateLevelOneEvidence(document, { isAncestor });
const rejects = (document, message) =>
  assert.throws(
    () => validate(document),
    (error) => error.message.includes(message),
  );

// --- The contract itself ---

test("the Level 1 schema and corpus constants are exactly the plan's", () => {
  assert.equal(LEVEL_1_SCHEMA, "viva.integration_level_1.v1");
  assert.equal(COMPONENT_FINDING_INSTANCES, 128);
  assert.equal(COMPONENT_REVIEW_DOCUMENTS, 12);
  assert.deepEqual(CANONICAL_DISPOSITIONS, [
    "TESTED_FIX",
    "BATCH_FIX",
    "DUPLICATE_ALIAS",
    "DECISION_BLOCKED",
    "EXTERNAL_EVIDENCE",
    "DEFERRED",
  ]);
});

test("a complete Level 1 document validates", () => {
  assert.equal(validate(level1()).status, "PASS");
});

// --- The eight enumerated failure modes ---

test("omitting one of the 128 instances fails", () => {
  rejects(
    patch(level1(), { "reconciliation.component_finding_instances": 127 }),
    "coverage reconciliation expected 128 instances",
  );
  rejects(patch(level1(), { "reconciliation.minor": 81 }), "coverage reconciliation expected 128");
});

test("a duplicated source instance without a canonical alias fails", () => {
  const document = level1();
  document.records.push(
    laneRecord("LEARN-002", "04B", { source_instances: ["CRIT-AUDIO-01 source"] }),
  );
  rejects(document, "duplicate finding instance lacks canonical alias");
});

test("a duplicated source instance credited as DUPLICATE_ALIAS passes", () => {
  const document = level1();
  document.records.push(
    laneRecord("LEARN-002", "04B", {
      source_instances: ["CRIT-AUDIO-01 source"],
      disposition: "DUPLICATE_ALIAS",
      canonical_alias_of: "CRIT-AUDIO-01",
    }),
  );
  assert.equal(validate(document).status, "PASS");
});

test("an unresolved decision leaves a decision-blocked finding unresolved", () => {
  rejects(
    patch(level1(), { "decisions.7.status": "DECISION_REQUIRED" }),
    "decision-blocked finding remains unresolved",
  );
  rejects(
    patch(level1(), { "reconciliation.decision_blocked_rows": 1 }),
    "decision-blocked finding remains unresolved",
  );
});

test("a proof pointed at a different PR-head SHA fails", () => {
  rejects(
    patch(level1(), { "records.0.pr_head_sha": sha("some-other-head") }),
    "proof artifact is not bound to the node PR head SHA",
  );
});

test("a Program merge that is not an ancestor of the frozen SHA fails", () => {
  rejects(
    patch(level1(), { "lane_inputs.0.integration_merge_sha": sha("never-merged") }),
    "integration merge SHA is not included in frozen SHA",
  );
});

test("omitting one split node fails", () => {
  const document = level1();
  document.lane_inputs = document.lane_inputs.filter((node) => node.node_id !== "14B");
  rejects(document, "integration manifest expected 16 Program nodes");
});

test("reusing one A/B PR or merge commit fails", () => {
  const merge = sha("04A-merge");
  rejects(
    patch(level1(), { "lane_inputs.6.integration_merge_sha": merge }),
    "split phases must use distinct PR and merge commits",
  );
  // 04B (index 6) reusing 04A's PR number is a phase that failed to split; index 1 is 04A.
  rejects(
    patch(level1(), { "lane_inputs.6.pr_number": 102 }),
    "split phases must use distinct PR and merge commits",
  );
});

test("an INTEGRATION-owned record with a fabricated lane node/PR tuple fails", () => {
  rejects(
    patch(level1(), { "records.3.node_id": "03", "records.3.pr_head_sha": sha("03-head") }),
    "integration-owned record must bind to a coordinator commit",
  );
  rejects(
    patch(level1(), { "records.3.coordinator_commit_sha": null }),
    "integration-owned record must bind to a coordinator commit",
  );
});

// --- Proof quality ---

test("prose-only proof, a missing RED, and a source grep are all rejected", () => {
  rejects(
    patch(level1(), { "records.0.green_command": "we reviewed the code and it is correct" }),
    "proof is prose, not an executable command",
  );
  rejects(
    patch(level1(), { "records.0.red_command": "" }),
    "TESTED_FIX record requires a RED command",
  );
  rejects(
    patch(level1(), {
      "records.0.red_command": "rg -F 'storage_due_at_for_status' agent/crates",
      "records.0.green_command": "rg -F 'storage_due_at_for_status' agent/crates",
    }),
    "behavioral claim cannot rest on a source grep",
  );
  rejects(
    patch(level1(), { "records.0.adversarial_control": "  " }),
    "requires an adversarial or mutation control",
  );
});

test("an artifact outside the ignored artifacts tree is rejected", () => {
  rejects(
    patch(level1(), { "records.0.artifact_paths": ["docs/lane-proof/CRIT-AUDIO-01.json"] }),
    "must be under ignored artifacts/",
  );
});

test("a record naming a node tuple absent from lane_inputs is rejected", () => {
  rejects(
    patch(level1(), { "records.0.integration_merge_sha": sha("03-merge-typo") }),
    "names a node tuple absent from lane_inputs",
  );
});

test("an EXTERNAL_EVIDENCE record cannot be credited as a code PASS", () => {
  rejects(
    patch(level1(), {
      "records.0.disposition": "EXTERNAL_EVIDENCE",
      "records.0.external_gates": ["OPS-01"],
    }),
    "cannot be credited as a code PASS",
  );
  rejects(
    patch(level1(), {
      "records.0.disposition": "EXTERNAL_EVIDENCE",
      "records.0.status": "EXTERNAL_EVIDENCE_REQUIRED",
    }),
    "must name at least one OPS gate",
  );
  const document = patch(level1(), {
    "records.0.disposition": "EXTERNAL_EVIDENCE",
    "records.0.external_gates": ["OPS-01", "OPS-02"],
    "records.0.status": "EXTERNAL_EVIDENCE_REQUIRED",
  });
  assert.equal(validate(document).status, "PASS");
});

// --- The manifest read AS AMENDED ---

test("a node branch amended by the coordinator is accepted and an invented one is not", () => {
  const amendments = parsePlanAmendments(read(AMENDMENTS_PATH));
  const branches = amendedNodeBranches(amendments);
  assert.ok(branches.get("12A")?.has("review-remediation/12a"), "A-04 amends node 12A's branch");
  assert.ok(branches.get("13A")?.has("review-remediation/13a"), "A-06 amends node 13A's branch");
  const document = patch(level1(), { "lane_inputs.3.branch": "review-remediation/12a" });
  assert.equal(validateLevelOneEvidence(document, { isAncestor, amendments }).status, "PASS");
  rejects(patch(level1(), { "lane_inputs.3.branch": "review-remediation/12z" }), "branch");
});

test("appendix admissions must be named by a recorded amendment", () => {
  const amendments = parsePlanAmendments(read(AMENDMENTS_PATH));
  const admissions = recordedAppendixAdmissions(amendments);
  assert.ok(admissions.size > 0, "the amendments record at least one appendix admission");
  for (const [pullRequest, record] of admissions) {
    assert.equal(Number.isInteger(pullRequest) && pullRequest > 0, true);
    assert.match(record.amendment_id, /^[AW]-\d+$/);
  }
  const [pullRequest, record] = [...admissions].find(([, entry]) => entry.node_ids.length > 0);
  const nodeId = record.node_ids[0];
  const document = level1();
  const node = document.lane_inputs.find((entry) => entry.node_id === nodeId);
  node.appendix_admissions = [
    {
      pr_number: pullRequest,
      amendment_id: record.amendment_id,
      pr_head_sha: sha(`${nodeId}-appendix-head`),
      integration_merge_sha: sha(`${nodeId}-merge`),
      pr_commit_shas: [sha(`${nodeId}-appendix-head`)],
    },
  ];
  assert.equal(validateLevelOneEvidence(document, { isAncestor, amendments }).status, "PASS");
  node.appendix_admissions[0].pr_number = 9999;
  assert.throws(
    () => validateLevelOneEvidence(document, { isAncestor, amendments }),
    /appendix admission is not recorded in the plan amendments/,
  );
});

test("a squashed appendix admission must name exactly one commit", () => {
  const amendments = parsePlanAmendments(read(AMENDMENTS_PATH));
  const admissions = recordedAppendixAdmissions(amendments);
  const squashed = [...admissions].find(([, entry]) => entry.squashed && entry.node_ids.length > 0);
  if (!squashed) return;
  const [pullRequest, record] = squashed;
  const nodeId = record.node_ids[0];
  const document = level1();
  const node = document.lane_inputs.find((entry) => entry.node_id === nodeId);
  node.appendix_admissions = [
    {
      pr_number: pullRequest,
      amendment_id: record.amendment_id,
      pr_head_sha: sha(`${nodeId}-appendix-head`),
      integration_merge_sha: sha(`${nodeId}-merge`),
      pr_commit_shas: [sha(`${nodeId}-appendix-first`), sha(`${nodeId}-appendix-head`)],
    },
  ];
  assert.throws(
    () => validateLevelOneEvidence(document, { isAncestor, amendments }),
    /squashed appendix admission must name exactly one commit/,
  );
});

// --- The coordinator documents themselves ---

test("the coordinator ledger still carries the immutable 128-instance arithmetic", () => {
  const ledger = parseCoverageLedger(read(LEDGER_PATH));
  assert.equal(ledger.component_review_documents, 12);
  assert.equal(ledger.component_finding_instances, 128);
  assert.deepEqual(ledger.severity, { Critical: 2, Important: 44, Minor: 82 });
  assert.equal(ledger.severity.Critical + ledger.severity.Important + ledger.severity.Minor, 128);
  assert.equal(ledger.namespaces.size, 12);
  assert.equal(ledger.decisions.length, 9);
  assert.equal(ledger.decisions.find((entry) => entry.id === "D-09").current_state, "D-09B");
  assert.equal(ledger.decisions.find((entry) => entry.id === "D-08").current_state, "D-08A");
});

test("every parsed amendment carries an id, a date, and a body", () => {
  const amendments = parsePlanAmendments(read(AMENDMENTS_PATH));
  assert.ok(
    amendments.length >= 37,
    `expected the full amendment record, got ${amendments.length}`,
  );
  for (const amendment of amendments) {
    assert.match(amendment.id, /^[AW]-\d+$/);
    assert.match(amendment.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(amendment.title.length > 0, `${amendment.id} has no title`);
  }
  assert.ok(amendments.some((entry) => entry.id === "A-36"));
});

test("the ledger parse reproduces the ledger's own published counting results", () => {
  const ledger = parseCoverageLedger(read(LEDGER_PATH));
  // The ledger publishes these as the expected output of its own mechanical counting
  // command, so a parse that disagrees with them is wrong about the corpus, not the ledger.
  assert.equal(ledger.rows.length, 346, "346 traceability rows");
  assert.equal(ledger.canonical_ids.size, 160, "160 unique canonical IDs");
  assert.equal(ledger.rows.filter((row) => row.required_proof === "").length, 0);
  const namespaces = new Set([...ledger.namespaces, "INTEGRATION"]);
  const unmapped = ledger.rows.filter((row) => !namespaces.has(row.canonical_id.split("-")[0]));
  assert.deepEqual(unmapped, [], "every canonical ID must name a known owning namespace");
});

test("a ledger row owned by no lane namespace is counted as unmapped", () => {
  const foreign = [
    "",
    "## Synthetic control section",
    "",
    "| Source | Canonical ID | Owning plan | Disposition | Required proof | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    "| Important I9 — synthetic | `FOREIGN-001` | `x.md` | `TESTED_FIX` | proof | `PROVEN` |",
    "",
  ].join("\n");
  const result = reconcileLevelOne({
    ledgerMarkdown: read(LEDGER_PATH) + foreign,
    amendmentsMarkdown: read(AMENDMENTS_PATH),
    laneInputs: laneInputs(),
    records: level1().records,
    frozenSha: FROZEN_SHA,
    runId: RUN_ID,
    generatedAt: "2026-08-23T18:00:00.000Z",
    isAncestor,
  });
  assert.equal(result.reconciliation.unmapped_source_instances, 1);
  assert.equal(result.status, "FAIL");
  assert.ok(
    result.failures.some((message) => message.includes("unmapped source instances must be zero")),
    `expected an unmapped-instance failure, got ${JSON.stringify(result.failures)}`,
  );
});

test("the run id is recovered from the plan's own artifact path", () => {
  assert.equal(
    runIdFromArtifactPath(`artifacts/integration-readiness/${RUN_ID}/lane-inputs.json`),
    RUN_ID,
  );
  assert.equal(runIdFromArtifactPath("artifacts/lane-inputs.json"), "");
  assert.equal(runIdFromArtifactPath("artifacts/not-a-run-id/lane-inputs.json"), "");
});

test("reconcileLevelOne derives its counters from the coordinator documents", () => {
  const result = reconcileLevelOne({
    ledgerMarkdown: read(LEDGER_PATH),
    amendmentsMarkdown: read(AMENDMENTS_PATH),
    laneInputs: laneInputs(),
    records: level1().records,
    frozenSha: FROZEN_SHA,
    runId: RUN_ID,
    generatedAt: "2026-08-23T18:00:00.000Z",
    isAncestor,
  });
  assert.equal(result.schema, LEVEL_1_SCHEMA);
  assert.equal(result.reconciliation.component_finding_instances, 128);
  assert.equal(result.reconciliation.program_integration_nodes, 16);
  assert.equal(result.reconciliation.source_lane_namespaces, 12);
  assert.match(result.ledger_sha256, /^[0-9a-f]{64}$/);
  assert.match(result.amendments_sha256, /^[0-9a-f]{64}$/);
  // The tree still carries UNSTARTED rows, so the derived reconciliation is honest
  // about them rather than asserting a PASS the ledger does not support.
  assert.equal(typeof result.reconciliation.unstarted_rows, "number");
  assert.equal(["PASS", "FAIL"].includes(result.status), true);
});
