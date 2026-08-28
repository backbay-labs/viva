// INTEGRATION-010 — PR/ledger/deploy reconciliation and the exact deploy/run binding.
//
// Task 10 Step 1's rejection list is the spec, and every row of it is driven here from one
// valid fixture per subject so a rule that stops firing cannot hide behind a bespoke
// document: each table applies `{dotted path: value}` patches to a base the same test first
// proves valid. The typed binding is the point of the deploy tests — deployment IDs, Git
// SHAs, pinned build-input digests, deployed output-image digests, object ETags, and the two
// different kinds of run ID are separate types, and a pinned digest can never satisfy a
// deployed output-image field. `all_bindings_match` is asserted nowhere: it is derived from
// the typed fields, and a document that claims it while the fields disagree is rejected.
// Marker names are spelled plainly here as everywhere (A-39.2); this file is a `.test.mjs`
// and the redaction audit does not scan it, but the norm is the norm.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deployBindingFixture,
  FIXTURE_FROZEN_SHA,
  FIXTURE_RUN_ID,
  fixtureDeploymentId,
  fixtureDigest,
  fixtureHex,
} from "./integration-readiness-fixtures.mjs";
import {
  assembleIntegrationEvidence,
  assertTerminalStatus,
  deriveAllBindingsMatch,
  MONITOR_STATE_OBJECT_KEY,
  PR_DISPOSITIONS,
  PR_RECONCILIATION_SCHEMA,
  renderDeployBindingSection,
  validateDeployBinding,
  validatePullRequestReconciliation,
} from "./integration-readiness-reconcile.mjs";
import { PROGRAM_NODES } from "./integration-readiness-shared.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "scripts", "integration-readiness.mjs");
const FROZEN_SHA = FIXTURE_FROZEN_SHA;
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const RUN_ID = FIXTURE_RUN_ID;
const OTHER_RUN_ID = "20260824T180000Z-fedcba987654";
const FROZEN_AT = "2026-08-23T18:00:00.000Z";
const WEB_ID = fixtureDeploymentId("web");
const AGENT_ID = fixtureDeploymentId("agent");
const hex = fixtureHex;
const digest = fixtureDigest;

// --- Fixtures ---

const binding = deployBindingFixture;

const bindingContext = (extra = {}) => ({ frozenSha: FROZEN_SHA, runId: RUN_ID, ...extra });

const laneInputs = () =>
  PROGRAM_NODES.map((node, index) => ({
    node_id: node.node_id,
    namespace: node.namespace,
    branch: node.branch,
    pr_number: 101 + index,
    pr_head_sha: hex(40, `${node.node_id}-head`),
    integration_merge_sha: hex(40, `${node.node_id}-merge`),
  }));

const prUrl = (number) => `https://github.com/backbay-labs/viva/pull/${number}`;

const nodePullRequest = (node) => ({
  number: node.pr_number,
  url: prUrl(node.pr_number),
  state: "MERGED",
  head_ref_name: node.branch,
  head_sha: node.pr_head_sha,
  merge_commit_sha: node.integration_merge_sha,
  node_id: node.node_id,
  disposition: "included_exact_head",
  integration_merge_sha: node.integration_merge_sha,
  superseded_by_sha: null,
  reason: null,
});

/** One reviewed stale PR per non-node disposition, so both legal branches stay covered. */
const staleSuperseded = () => ({
  number: 94,
  url: prUrl(94),
  state: "CLOSED",
  head_ref_name: "review-remediation/09-data-privacy",
  head_sha: hex(40, "stale-94-head"),
  merge_commit_sha: null,
  node_id: null,
  disposition: "superseded_by_included_commit",
  integration_merge_sha: null,
  superseded_by_sha: hex(40, "09-head"),
  reason: "reworked and landed inside the recorded 09 PR head",
});

const staleExcluded = () => ({
  number: 95,
  url: prUrl(95),
  state: "CLOSED",
  head_ref_name: "chore/stale-experiment",
  head_sha: hex(40, "stale-95-head"),
  merge_commit_sha: null,
  node_id: null,
  disposition: "excluded_with_reason",
  integration_merge_sha: null,
  superseded_by_sha: null,
  reason: "abandoned spike; no finding instance depends on it",
});

const coverageRow = (overrides = {}) => ({
  row_id: "R1",
  canonical_id: "CRIT-001",
  status: "COMPLETE",
  proof_pull_request_numbers: [101],
  proof_artifacts: ["artifacts/lane-proof/03.json"],
  proof_frozen_sha: FROZEN_SHA,
  ...overrides,
});

const reconciliation = (overrides = {}) => ({
  schema: PR_RECONCILIATION_SCHEMA,
  frozen_sha: FROZEN_SHA,
  frozen_at: FROZEN_AT,
  main_sha_after_reconciliation: null,
  integration_pull_request: {
    number: 140,
    url: prUrl(140),
    state: "OPEN",
    head_sha: FROZEN_SHA,
    merge_commit_sha: null,
  },
  pull_requests: [...laneInputs().map(nodePullRequest), staleSuperseded(), staleExcluded()],
  checks: [
    {
      name: "Required validation",
      head_sha: FROZEN_SHA,
      status: "COMPLETED",
      conclusion: "SUCCESS",
    },
  ],
  coverage_rows: [coverageRow()],
  stored_bundle: {
    run_id: RUN_ID,
    sha256: hex(64, "bundle"),
    source_sha: FROZEN_SHA,
    generated_at: "2026-08-23T18:30:00.000Z",
    verified_at: "2026-08-23T18:40:00.000Z",
  },
  ...overrides,
});

// --- Patch/assert helpers ---

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

const prIndex = (number) => reconciliation().pull_requests.findIndex((pr) => pr.number === number);
const pr = (number, field) => `pull_requests.${prIndex(number)}.${field}`;

const reconcileOptions = (extra = {}) => ({
  laneInputs: laneInputs(),
  isAncestor: () => true,
  ...extra,
});

/**
 * Every rejection is a mutation control: the base must validate first, so a table row that
 * stops firing is a failure rather than a fixture that was never legal.
 */
function rejectsEach(base, table, run) {
  assert.ok(run(base), "the mutation control base must validate before any patch is applied");
  for (const [changes, expected] of table) {
    assert.throws(() => run(patch(base, changes)), expected, `unmutated: ${Object.keys(changes)}`);
  }
}

const bindingRejects = (table, extra = {}) =>
  rejectsEach(binding(), table, (value) => validateDeployBinding(value, bindingContext(extra)));

const reconcileRejects = (table, extra = {}) =>
  rejectsEach(reconciliation(), table, (value) =>
    validatePullRequestReconciliation(value, reconcileOptions(extra)),
  );

// --- The typed deploy/run binding ---

test("the typed deploy binding accepts the exact production structure", () => {
  const validated = validateDeployBinding(binding(), bindingContext());
  assert.equal(validated.git.frozen_sha, FROZEN_SHA);
  assert.equal(validated.all_bindings_match, true);
  assert.equal(validated.monitor.state_object_key, MONITOR_STATE_OBJECT_KEY);
});

test("the binding rejects unknown, missing, and coerced top-level sections", () => {
  bindingRejects([
    [{ extra_section: {} }, /unknown field: extra_section/],
    [{ live_smoke: undefined }, /missing field: live_smoke/],
    [{ hosted_browser: undefined }, /missing field: hosted_browser/],
    [{ build_inputs: undefined }, /missing field: build_inputs/],
    [{ all_bindings_match: "true" }, /all_bindings_match must be a boolean/],
    [{ "web.extra": 1 }, /deploy_binding\.web unknown field: extra/],
    [{ "monitor.origin": "https://monitor.example.invalid" }, /monitor unknown field: origin/],
  ]);
});

test("deployment IDs are never compared to Git SHAs as if they were the same type", () => {
  bindingRejects([
    [{ "web.deployment_id": FROZEN_SHA }, /web\.deployment_id .*not a Git SHA/],
    [{ "agent.deployment_id": OTHER_SHA }, /agent\.deployment_id .*not a Git SHA/],
    [{ "monitor.deployment_id": FROZEN_SHA }, /monitor\.deployment_id .*not a Git SHA/],
    [
      { "hosted_browser.web_deployment_id": FROZEN_SHA },
      /hosted_browser\.web_deployment_id .*not a Git SHA/,
    ],
    [
      { "live_smoke.agent_deployment_id": FROZEN_SHA },
      /live_smoke\.agent_deployment_id .*not a Git SHA/,
    ],
    [{ "web.deploy_sha": WEB_ID }, /web\.deploy_sha must be a 40-hex Git SHA/],
    [{ "github.head_sha": WEB_ID }, /github\.head_sha must be a 40-hex Git SHA/],
    [{ "git.main_sha": WEB_ID }, /git\.main_sha must be a 40-hex Git SHA or null/],
  ]);
});

test("a deployment ID is never an image digest, a run ID, or a numeric hosted run ID", () => {
  bindingRejects([
    [{ "web.deployment_id": digest("output-web") }, /web\.deployment_id .*not an image digest/],
    [{ "agent.deployment_id": hex(64, "x") }, /agent\.deployment_id .*not an image digest/],
    [{ "monitor.deployment_id": RUN_ID }, /monitor\.deployment_id .*not a run ID/],
    [{ "web.deployment_id": "31401218406" }, /web\.deployment_id .*not a run ID/],
  ]);
});

test("a pinned base-image or Bun archive digest can never satisfy a deployed output field", () => {
  bindingRejects([
    [
      { "web.output_image_digest": digest("agent-base") },
      /web\.output_image_digest is a pinned build input/,
    ],
    [
      { "agent.output_image_digest": digest("agent-base") },
      /agent\.output_image_digest is a pinned build input/,
    ],
    [
      { "monitor.output_image_digest": digest("monitor-base") },
      /monitor\.output_image_digest is a pinned build input/,
    ],
    [
      { "monitor.output_image_digest": `sha256:${hex(64, "bun-archive")}` },
      /monitor\.output_image_digest is a pinned build input/,
    ],
  ]);
});

test("output-image digests, pinned digests, and archive hashes keep their own shapes", () => {
  bindingRejects([
    [
      { "web.output_image_digest": hex(64, "output-web") },
      /web\.output_image_digest must be a sha256:/,
    ],
    [{ "agent.output_image_digest": FROZEN_SHA }, /agent\.output_image_digest must be a sha256:/],
    [
      { "build_inputs.agent_base_image_digest": hex(64, "agent-base") },
      /build_inputs\.agent_base_image_digest must be a sha256:/,
    ],
    [
      { "build_inputs.monitor_bun_archive_sha256": digest("bun-archive") },
      /build_inputs\.monitor_bun_archive_sha256 must be 64 lowercase hex/,
    ],
    [
      { "web.output_image_digest": digest("output-agent") },
      /web and agent recorded the same deployed output-image digest/,
    ],
    [{ "agent.deployment_id": WEB_ID }, /web and agent recorded the same deployment ID/],
  ]);
});

test("a hosted GitHub run ID and an integration run ID are different types", () => {
  bindingRejects([
    [{ "github.run_id": RUN_ID }, /github\.run_id must be a numeric hosted run ID/],
    [{ "github.run_id": 31401218406 }, /github\.run_id must be a numeric hosted run ID/],
    [{ "release.run_id": "31401218406" }, /release\.run_id must be an integration run ID/],
    [{ "monitor.run_id": "31401218406" }, /monitor\.run_id must be an integration run ID/],
    [{ "github.run_attempt": "1" }, /github\.run_attempt/],
    [{ "github.run_attempt": 0 }, /github\.run_attempt/],
  ]);
});

test("a durable object ETag is never a Git SHA, an image digest, or a run ID", () => {
  bindingRejects([
    [{ "monitor.state_etag": FROZEN_SHA }, /monitor\.state_etag .*not a Git SHA/],
    [
      { "monitor.state_etag": digest("output-monitor") },
      /monitor\.state_etag .*not an image digest/,
    ],
    [{ "monitor.state_etag": RUN_ID }, /monitor\.state_etag .*not a run ID/],
    [{ "monitor.state_etag": "" }, /monitor\.state_etag/],
    [
      { "monitor.state_object_key": "viva-hosted-monitor/state/other.json" },
      /monitor\.state_object_key must be viva-hosted-monitor/,
    ],
    [
      { "monitor.object_prefix": "viva-hosted-monitor/runs/other" },
      /monitor\.object_prefix must name the monitor run ID/,
    ],
  ]);
});

test("service origins are https origins with no path, query, or fragment", () => {
  bindingRejects([
    [{ "web.origin": "http://web.example.invalid" }, /web\.origin must be an https origin/],
    [
      { "agent.origin": "https://agent.example.invalid/ws" },
      /agent\.origin must be an https origin/,
    ],
    [{ "web.origin": "web.example.invalid" }, /web\.origin must be an https origin/],
  ]);
});

test("a GitHub check whose head SHA differs from the frozen SHA is rejected", () => {
  bindingRejects([
    [{ "github.head_sha": OTHER_SHA }, /github\.head_sha is not the frozen SHA/],
    [{ "git.frozen_sha": OTHER_SHA }, /git\.frozen_sha is not the frozen SHA/],
    [{ "web.deploy_sha": OTHER_SHA }, /web\.deploy_sha is not the frozen SHA/],
    [{ "agent.deploy_sha": OTHER_SHA }, /agent\.deploy_sha is not the frozen SHA/],
    [{ "monitor.deploy_sha": OTHER_SHA }, /monitor\.deploy_sha is not the frozen SHA/],
    [
      { "hosted_browser.deploy_sha": OTHER_SHA },
      /hosted_browser\.deploy_sha is not the frozen SHA/,
    ],
    [{ "live_smoke.deploy_sha": OTHER_SHA }, /live_smoke\.deploy_sha is not the frozen SHA/],
  ]);
});

test("web, agent, and monitor evidence may never mix run IDs or environments", () => {
  bindingRejects([
    [{ "monitor.run_id": OTHER_RUN_ID }, /monitor\.run_id is not the release run ID/],
    [{ "hosted_browser.run_id": OTHER_RUN_ID }, /hosted_browser\.run_id is not the release run ID/],
    [{ "live_smoke.run_id": OTHER_RUN_ID }, /live_smoke\.run_id is not the release run ID/],
    [{ "release.run_id": OTHER_RUN_ID }, /release\.run_id is not the integration run ID/],
    [{ "live_smoke.environment": "staging" }, /live_smoke\.environment must be production/],
    [
      { "hosted_browser.web_deployment_id": AGENT_ID },
      /hosted_browser\.web_deployment_id is not the web deployment ID/,
    ],
    [
      { "hosted_browser.agent_deployment_id": WEB_ID },
      /hosted_browser\.agent_deployment_id is not the agent deployment ID/,
    ],
    [
      { "live_smoke.agent_deployment_id": WEB_ID },
      /live_smoke\.agent_deployment_id is not the agent deployment ID/,
    ],
  ]);
});

test("all_bindings_match is derived from the typed fields and never merely asserted", () => {
  assert.equal(deriveAllBindingsMatch(binding()), true);
  const table = [
    { "git.main_sha": null },
    { "git.main_sha": OTHER_SHA },
    { "github.head_sha": OTHER_SHA },
    { "agent.deploy_sha": OTHER_SHA },
    { "monitor.run_id": OTHER_RUN_ID },
    { "live_smoke.environment": "staging" },
    { "hosted_browser.web_deployment_id": AGENT_ID },
    { "monitor.state_object_key": "viva-hosted-monitor/state/other.json" },
    { "web.output_image_digest": digest("agent-base") },
  ];
  for (const changes of table) {
    assert.equal(
      deriveAllBindingsMatch(patch(binding(), changes)),
      false,
      `${Object.keys(changes)}`,
    );
  }
});

test("an asserted all_bindings_match that the typed fields do not support is rejected", () => {
  const preMerge = patch(binding(), { "git.main_sha": null, all_bindings_match: false });
  assert.equal(validateDeployBinding(preMerge, bindingContext()).all_bindings_match, false);
  assert.throws(
    () => validateDeployBinding(patch(preMerge, { all_bindings_match: true }), bindingContext()),
    /all_bindings_match is asserted but the typed bindings do not match/,
  );
  assert.throws(
    () => validateDeployBinding(patch(binding(), { all_bindings_match: false }), bindingContext()),
    /all_bindings_match must be the derived value/,
  );
});

test("a RELEASE_READY binding requires a matched main SHA and derived all_bindings_match", () => {
  const ready = bindingContext({ ready: true });
  assert.equal(validateDeployBinding(binding(), ready).all_bindings_match, true);
  const preMerge = patch(binding(), { "git.main_sha": null, all_bindings_match: false });
  assert.throws(
    () => validateDeployBinding(preMerge, ready),
    /RELEASE_READY requires deploy_binding\.git\.main_sha to equal the frozen SHA/,
  );
});

test("the binding renders a deterministic typed Markdown section", () => {
  const lines = renderDeployBindingSection(binding());
  const rendered = lines.join("\n");
  assert.deepEqual(lines, renderDeployBindingSection(binding()));
  assert.match(
    rendered,
    /^- Deploy binding frozen SHA: `0123456789abcdef0123456789abcdef01234567`$/m,
  );
  assert.match(rendered, /^- All bindings match: `true`$/m);
  assert.match(rendered, /\| web \| viva-web-deployment-01 \| sha256:[0-9a-f]{64} \|/);
  assert.match(rendered, /\| monitor \| viva-monitor-deployment-01 \| sha256:[0-9a-f]{64} \|/);
  assert.match(rendered, /^- Pinned build inputs: /m);
  assert.deepEqual(renderDeployBindingSection(null), ["- Deploy binding: `null`", ""]);
});

// --- PR, check, coverage, and stored-bundle reconciliation ---

test("the reconciliation accepts sixteen included exact heads plus reviewed stale PRs", () => {
  const document = validatePullRequestReconciliation(reconciliation(), reconcileOptions());
  assert.equal(document.pull_requests.length, 18);
  assert.deepEqual(PR_DISPOSITIONS, [
    "included_exact_head",
    "superseded_by_included_commit",
    "excluded_with_reason",
  ]);
  assert.equal(PR_RECONCILIATION_SCHEMA, "viva.pr_reconciliation.v1");
});

test("a lane PR whose head commit is absent from the frozen SHA is rejected", () => {
  assert.throws(
    () =>
      validatePullRequestReconciliation(
        reconciliation(),
        reconcileOptions({ isAncestor: (candidate) => candidate !== hex(40, "05-head") }),
      ),
    /lane PR 103 head [0-9a-f]{40} is absent from the frozen SHA/,
  );
  assert.throws(
    () =>
      validatePullRequestReconciliation(
        reconciliation(),
        reconcileOptions({ isAncestor: (candidate) => candidate !== hex(40, "06-merge") }),
      ),
    /lane PR 106 integration merge [0-9a-f]{40} is absent from the frozen SHA/,
  );
});

test("an open remediation PR with no disposition is rejected", () => {
  reconcileRejects([
    [
      {
        pull_requests: [
          ...reconciliation().pull_requests,
          {
            ...staleExcluded(),
            number: 96,
            url: prUrl(96),
            state: "OPEN",
            head_ref_name: "review-remediation/13-frontend",
            disposition: null,
            reason: null,
          },
        ],
      },
      /open remediation PR 96 has no disposition/,
    ],
    [{ [pr(94, "disposition")]: null }, /open remediation PR 94 has no disposition/],
    [{ [pr(94, "disposition")]: "ignored" }, /PR 94 disposition is unrecorded: ignored/],
  ]);
});

test("a merged PR whose merge commit is absent from main after reconciliation is rejected", () => {
  const merged = reconciliation({ main_sha_after_reconciliation: OTHER_SHA });
  assert.ok(validatePullRequestReconciliation(merged, reconcileOptions()));
  assert.throws(
    () =>
      validatePullRequestReconciliation(
        merged,
        reconcileOptions({
          isAncestor: (candidate, into) =>
            !(into === OTHER_SHA && candidate === hex(40, "08-merge")),
        }),
      ),
    /merged PR 111 merge commit [0-9a-f]{40} is absent from main after reconciliation/,
  );
  reconcileRejects([
    [{ [pr(101, "merge_commit_sha")]: null }, /merged PR 101 has no merge commit/],
  ]);
});

test("a required Program node PR may never be superseded or excluded", () => {
  reconcileRejects([
    [
      {
        [pr(101, "disposition")]: "excluded_with_reason",
        [pr(101, "integration_merge_sha")]: null,
      },
      /required Program node PR 101 cannot use excluded_with_reason/,
    ],
    [
      {
        [pr(105, "disposition")]: "superseded_by_included_commit",
        [pr(105, "integration_merge_sha")]: null,
        [pr(105, "superseded_by_sha")]: hex(40, "13A-head"),
      },
      /required Program node PR 105 cannot use superseded_by_included_commit/,
    ],
    [{ [pr(101, "head_sha")]: OTHER_SHA }, /PR 101 head does not match the Program manifest/],
    [
      { [pr(101, "integration_merge_sha")]: OTHER_SHA },
      /PR 101 integration merge does not match the Program manifest/,
    ],
    [{ [pr(101, "node_id")]: "05" }, /PR 101 is recorded against node 05/],
    [{ [pr(94, "node_id")]: "03" }, /PR 94 names Program node 03 without an included exact head/],
    [
      { pull_requests: reconciliation().pull_requests.filter((entry) => entry.number !== 116) },
      /Program node 12B PR 116 is missing from the reconciliation/,
    ],
  ]);
});

test("each non-node disposition carries exactly the evidence its branch requires", () => {
  reconcileRejects([
    [{ [pr(94, "superseded_by_sha")]: null }, /PR 94 superseded_by_sha/],
    [{ [pr(94, "integration_merge_sha")]: OTHER_SHA }, /PR 94 cannot record an integration merge/],
    [{ [pr(95, "reason")]: null }, /PR 95 excluded_with_reason requires a reason/],
    [{ [pr(95, "reason")]: "  " }, /PR 95 excluded_with_reason requires a reason/],
    [{ [pr(95, "superseded_by_sha")]: OTHER_SHA }, /PR 95 cannot record a superseding commit/],
    [{ [pr(101, "superseded_by_sha")]: OTHER_SHA }, /PR 101 cannot record a superseding commit/],
  ]);
});

test("a GitHub check whose headSha differs from the frozen SHA is rejected", () => {
  reconcileRejects([
    [
      { "checks.0.head_sha": OTHER_SHA },
      /GitHub check Required validation headSha [0-9a-f]{40} is not the frozen SHA/,
    ],
    [{ "checks.0.head_sha": "not-a-sha" }, /checks\[0\]\.head_sha must be a 40-hex Git SHA/],
    [
      { "integration_pull_request.head_sha": OTHER_SHA },
      /the integration PR head [0-9a-f]{40} is not the frozen SHA/,
    ],
  ]);
});

test("a coverage row marked complete without proof at the frozen SHA is rejected", () => {
  reconcileRejects([
    [
      { "coverage_rows.0.proof_frozen_sha": OTHER_SHA },
      /coverage row R1 is marked complete without proof at the frozen SHA/,
    ],
    [
      { "coverage_rows.0.proof_frozen_sha": null },
      /coverage row R1 is marked complete without proof at the frozen SHA/,
    ],
    [{ "coverage_rows.0.proof_artifacts": [] }, /coverage row R1 names no proof artifact/],
    [
      { "coverage_rows.0.proof_artifacts": ["docs/proof.json"] },
      /coverage row R1 proof path must be under ignored artifacts/,
    ],
    [
      { "coverage_rows.0.proof_pull_request_numbers": [] },
      /coverage row R1 names no proof pull request/,
    ],
    [
      { "coverage_rows.0.proof_pull_request_numbers": [999] },
      /coverage row R1 names an unrecorded PR 999/,
    ],
  ]);
});

test("an excluded PR can never satisfy a coverage row", () => {
  reconcileRejects([
    [
      { "coverage_rows.0.proof_pull_request_numbers": [95] },
      /coverage row R1 is satisfied by excluded PR 95/,
    ],
    [
      { "coverage_rows.0.proof_pull_request_numbers": [101, 95] },
      /coverage row R1 is satisfied by excluded PR 95/,
    ],
  ]);
  const open = reconciliation({
    coverage_rows: [coverageRow({ status: "OPEN", proof_frozen_sha: null })],
  });
  assert.ok(validatePullRequestReconciliation(open, reconcileOptions()));
  assert.throws(
    () =>
      validatePullRequestReconciliation(
        reconciliation({ coverage_rows: [coverageRow({ status: "OPEN" })] }),
        reconcileOptions(),
      ),
    /coverage row R1 is not complete and must not claim frozen-SHA proof/,
  );
});

test("a stored release bundle generated before the final review SHA is rejected", () => {
  reconcileRejects([
    [
      { "stored_bundle.source_sha": OTHER_SHA },
      /the stored release bundle was generated from [0-9a-f]{40}, not the final review SHA/,
    ],
    [
      { "stored_bundle.generated_at": "2026-08-23T17:59:59.000Z" },
      /the stored release bundle predates the final review SHA/,
    ],
    [
      { "stored_bundle.verified_at": "2026-08-23T18:29:59.000Z" },
      /the stored release bundle was verified before it was generated/,
    ],
    [{ "stored_bundle.run_id": "20260823-run" }, /stored_bundle\.run_id/],
    [{ "stored_bundle.sha256": hex(32, "bundle") }, /stored_bundle\.sha256/],
    [{ schema: "viva.pr_reconciliation.v2" }, /schema must be viva\.pr_reconciliation\.v1/],
  ]);
});

// --- Terminal status under each forbidden condition ---

const terminal = (status, gates, extra = {}) =>
  assertTerminalStatus({ terminal_status: status, external_gates: gates }, extra);

const gate = (id, status) => ({ id, status });
const allPass = () =>
  ["OPS-01", "OPS-02", "OPS-03", "OPS-04", "OPS-05", "OPS-06"].map((id) => gate(id, "PASS"));
const withGate = (id, status) =>
  allPass().map((entry) => (entry.id === id ? gate(id, status) : entry));

test("no terminal status may be emitted while a mandatory gate is non-PASS", () => {
  for (const status of [
    "CODE_REMEDIATION_COMPLETE",
    "CODE_COMPLETE_EXTERNAL_GATES_PENDING",
    "RELEASE_READY",
  ]) {
    assert.throws(
      () => terminal(status, allPass(), { complete: false, derived: undefined }),
      /terminal_status is forbidden while a mandatory gate is non-PASS/,
    );
  }
  assert.equal(assertTerminalStatus({}, { complete: false, derived: undefined }), undefined);
  assert.throws(
    () => terminal("SHIP_IT", allPass(), { complete: true, derived: "RELEASE_READY" }),
    /terminal_status must be one of/,
  );
});

test("CODE_COMPLETE_EXTERNAL_GATES_PENDING is forbidden while any external gate is FAIL", () => {
  const gates = withGate("OPS-05", "FAIL");
  assert.throws(
    () =>
      terminal("CODE_COMPLETE_EXTERNAL_GATES_PENDING", gates, {
        complete: true,
        derived: "CODE_REMEDIATION_COMPLETE",
      }),
    /CODE_COMPLETE_EXTERNAL_GATES_PENDING is forbidden while an external gate is FAIL: OPS-05/,
  );
  assert.equal(
    terminal("CODE_COMPLETE_EXTERNAL_GATES_PENDING", withGate("OPS-03", "BLOCKED_EXTERNAL"), {
      complete: true,
      derived: "CODE_COMPLETE_EXTERNAL_GATES_PENDING",
    }),
    undefined,
  );
});

test("CODE_REMEDIATION_COMPLETE is forbidden while the external set is clean", () => {
  assert.throws(
    () =>
      terminal("CODE_REMEDIATION_COMPLETE", allPass(), {
        complete: true,
        derived: "RELEASE_READY",
      }),
    /CODE_REMEDIATION_COMPLETE is forbidden while the external set is all PASS or cleanly pending/,
  );
  assert.throws(
    () =>
      terminal("CODE_REMEDIATION_COMPLETE", withGate("OPS-03", "BLOCKED_EXTERNAL"), {
        complete: true,
        derived: "CODE_COMPLETE_EXTERNAL_GATES_PENDING",
      }),
    /CODE_REMEDIATION_COMPLETE is forbidden while the external set is all PASS or cleanly pending/,
  );
  assert.equal(
    terminal("CODE_REMEDIATION_COMPLETE", withGate("OPS-05", "FAIL"), {
      complete: true,
      derived: "CODE_REMEDIATION_COMPLETE",
    }),
    undefined,
  );
});

test("RELEASE_READY is forbidden while any external gate is not PASS", () => {
  for (const status of ["FAIL", "BLOCKED_EXTERNAL"]) {
    assert.throws(
      () =>
        terminal("RELEASE_READY", withGate("OPS-06", status), {
          complete: true,
          derived: "CODE_REMEDIATION_COMPLETE",
        }),
      /RELEASE_READY requires every external gate to be PASS; OPS-06 is not/,
    );
  }
  assert.throws(
    () => terminal("RELEASE_READY", [], { complete: true, derived: "CODE_REMEDIATION_COMPLETE" }),
    /terminal_status does not match the derived classification/,
  );
  assert.equal(
    terminal("RELEASE_READY", allPass(), { complete: true, derived: "RELEASE_READY" }),
    undefined,
  );
});

// --- Assembly: the coordinator supplies data, the assembler derives the document ---

test("the assembled document derives coverage, mandatory blocks, and NOT_REQUIRED main", () => {
  const identity = { frozen_sha: FROZEN_SHA, live_main_sha_at_freeze: OTHER_SHA };
  const document = assembleIntegrationEvidence({
    runId: RUN_ID,
    generatedAt: FROZEN_AT,
    identity,
    laneInputs: { lane_inputs: [] },
    levelOne: {
      status: "PASS",
      ledger_sha256: hex(64, "ledger"),
      reconciliation: {
        component_finding_instances: 128,
        unstarted_rows: 2,
        decision_blocked_rows: 1,
      },
    },
    levelTwo: { status: "PASS", commands: [], artifacts: [] },
    levelThree: { status: "FAIL" },
    docsContract: { status: "PASS", artifacts: [] },
    independentReview: { status: "PASS", findings: [], artifact: null },
  });
  assert.equal(document.coverage.component_finding_instances_expected, 128);
  assert.equal(document.coverage.component_finding_instances_reconciled, 128);
  assert.deepEqual(document.coverage.unresolved_rows, [
    "unstarted_rows: 2",
    "decision_blocked_rows: 1",
  ]);
  assert.equal(document.coverage.ledger_sha256, hex(64, "ledger"));
  assert.deepEqual(document.levels.level_3, { status: "FAIL", commands: [], artifacts: [] });
  assert.deepEqual(document.main_reconciliation, {
    status: "NOT_REQUIRED",
    live_main_sha: OTHER_SHA,
    reconciliation_merge_sha: null,
    artifact: null,
  });
  assert.equal(document.deploy_binding, null);
  assert.equal(document.release_owner, null);
  assert.equal(document.supersedes_run_id, null);
  assert.equal(document.sanitized, true);
  assert.equal(Object.hasOwn(document, "terminal_status"), false);
});

// --- `finalize` and `validate`: one source for the JSON and the Markdown ---

const git = (args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const firstParentShas = () =>
  git(["rev-list", "--first-parent", "-n", "60", "HEAD"]).trim().split("\n");

const runCli = (argv) => execFileSync("node", [CLI, ...argv], { cwd: repoRoot, encoding: "utf8" });

async function withRunDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "viva-integration-010-"));
  try {
    const runDir = path.join(directory, RUN_ID);
    await mkdir(runDir, { recursive: true });
    return await run(runDir);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const write = (runDir, name, value) =>
  writeFile(path.join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);

const levelDocument = (id, status) => ({ schema: `viva.integration_${id}.v1`, status });

/** The whole run directory a coordinator's post-freeze run supplies, and nothing more. */
async function seedRunDir(runDir, { commits, overrides = {} }) {
  const frozenSha = commits[0];
  await write(runDir, "identity.json", {
    repository: "backbay-labs/viva",
    branch: "review-remediation/integration",
    audit_base_sha: commits[30],
    live_main_sha_at_start: commits[30],
    live_main_sha_at_freeze: commits[30],
    frozen_sha: frozenSha,
    worktree_clean: true,
    frozen_at: FROZEN_AT,
    ...(overrides.identity ?? {}),
  });
  await write(runDir, "lane-inputs.json", {
    frozen_sha: frozenSha,
    lane_inputs: PROGRAM_NODES.map((node, index) => ({
      node_id: node.node_id,
      topological_rank: node.topological_rank,
      namespace: node.namespace,
      split_phase: node.split_phase,
      plan_path: node.plan_path,
      branch: node.branch,
      pr_number: 101 + index,
      pr_url: prUrl(101 + index),
      pr_commit_shas: [commits[index + 40], commits[index]],
      pr_head_sha: commits[index],
      integration_merge_sha: commits[index + 16],
      merge_parent_shas: [commits[index + 32], commits[index]],
      predecessor_node_ids: [...node.predecessor_node_ids],
      decision_branch: ["13B", "14B"].includes(node.node_id) ? ["D-06B"] : [],
      included_in_frozen_sha: true,
      finding_ids: [`FIND-${node.node_id}`],
      proof_artifacts: [`artifacts/lane-proof/${node.node_id}.json`],
      owner_acknowledged_handoff: true,
    })),
  });
  await write(runDir, "level-1.json", {
    ...levelDocument("level_1", "PASS"),
    ledger_sha256: hex(64, "ledger"),
    reconciliation: {
      component_finding_instances: 128,
      unmapped_source_instances: 0,
      duplicate_source_instances_without_canonical_alias: 0,
      canonical_rows_with_missing_proof: 0,
      unstarted_rows: 0,
      decision_blocked_rows: 0,
      ...(overrides.reconciliation ?? {}),
    },
  });
  await write(runDir, "level-2.json", {
    ...levelDocument("level_2", "PASS"),
    commands: [],
    artifacts: [],
  });
  await write(runDir, "level-3.json", levelDocument("level_3", "PASS"));
  await write(runDir, "docs-contract.json", { status: "PASS", artifacts: [] });
  await write(runDir, "independent-review.json", { status: "PASS", findings: [], artifact: null });
  await write(runDir, "pr-reconciliation.json", {
    ...reconciliation({
      frozen_sha: frozenSha,
      integration_pull_request: {
        number: 140,
        url: prUrl(140),
        state: "OPEN",
        head_sha: frozenSha,
        merge_commit_sha: null,
      },
      pull_requests: PROGRAM_NODES.map((node, index) => ({
        number: 101 + index,
        url: prUrl(101 + index),
        state: "MERGED",
        head_ref_name: node.branch,
        head_sha: commits[index],
        merge_commit_sha: commits[index + 16],
        node_id: node.node_id,
        disposition: "included_exact_head",
        integration_merge_sha: commits[index + 16],
        superseded_by_sha: null,
        reason: null,
      })),
      checks: [
        {
          name: "Required validation",
          head_sha: frozenSha,
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
      ],
      coverage_rows: [coverageRow({ proof_frozen_sha: frozenSha })],
      stored_bundle: {
        run_id: RUN_ID,
        sha256: hex(64, "bundle"),
        source_sha: frozenSha,
        generated_at: "2026-08-23T18:30:00.000Z",
        verified_at: "2026-08-23T18:40:00.000Z",
      },
    }),
  });
  for (const [name, value] of Object.entries(overrides.files ?? {}))
    await write(runDir, name, value);
}

test("finalize assembles one document and renders the JSON and Markdown from it", async () => {
  const commits = firstParentShas();
  await withRunDir(async (runDir) => {
    await seedRunDir(runDir, { commits });
    const jsonPath = path.join(runDir, "integration-readiness.json");
    const markdownPath = path.join(runDir, "integration-readiness.md");
    const stdout = runCli([
      "finalize",
      "--run-dir",
      runDir,
      "--frozen-sha",
      commits[0],
      "--json",
      jsonPath,
      "--markdown",
      markdownPath,
    ]);
    const document = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.equal(document.schema, "viva.integration_readiness.v1");
    assert.equal(document.run_id, RUN_ID);
    assert.equal(document.identity.frozen_sha, commits[0]);
    assert.equal(document.lane_inputs.length, 16);
    assert.equal(document.coverage.component_finding_instances_reconciled, 128);
    assert.deepEqual(document.coverage.unresolved_rows, []);
    assert.equal(document.main_reconciliation.status, "NOT_REQUIRED");
    // Every required external gate was omitted, so each is materialized as a named FAIL and
    // the loop stays open; nothing is silently coerced to BLOCKED_EXTERNAL.
    assert.equal(document.terminal_status, "CODE_REMEDIATION_COMPLETE");
    assert.deepEqual(
      document.external_gates.map((entry) => [entry.id, entry.status]),
      allPass().map((entry) => [entry.id, "FAIL"]),
    );
    const markdown = await readFile(markdownPath, "utf8");
    assert.match(markdown, /^- Terminal status: CODE_REMEDIATION_COMPLETE$/m);
    assert.match(stdout, /CODE_REMEDIATION_COMPLETE/);
    runCli(["validate", "--run-dir", runDir, "--frozen-sha", commits[0]]);
  });
});

test("finalize omits terminal_status while a mandatory gate is non-PASS", async () => {
  const commits = firstParentShas();
  await withRunDir(async (runDir) => {
    await seedRunDir(runDir, {
      commits,
      overrides: { files: { "level-3.json": levelDocument("level_3", "FAIL") } },
    });
    const jsonPath = path.join(runDir, "integration-readiness.json");
    const markdownPath = path.join(runDir, "integration-readiness.md");
    runCli([
      "finalize",
      "--run-dir",
      runDir,
      "--frozen-sha",
      commits[0],
      "--json",
      jsonPath,
      "--markdown",
      markdownPath,
    ]);
    const document = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.equal(Object.hasOwn(document, "terminal_status"), false);
    const markdown = await readFile(markdownPath, "utf8");
    assert.match(markdown, /^- Integration state: `ACTIVE_MANDATORY_EVIDENCE_INCOMPLETE`$/m);
    assert.match(markdown, /^- Terminal status emitted: `false`$/m);
    assert.doesNotMatch(markdown, /^- Terminal status:/m);
  });
});

test("finalize refuses a mismatched frozen SHA, an unresolved ledger, and a bad reconciliation", async () => {
  const commits = firstParentShas();
  const finalize = (runDir, frozenSha) =>
    runCli([
      "finalize",
      "--run-dir",
      runDir,
      "--frozen-sha",
      frozenSha,
      "--json",
      path.join(runDir, "integration-readiness.json"),
      "--markdown",
      path.join(runDir, "integration-readiness.md"),
    ]);
  await withRunDir(async (runDir) => {
    await seedRunDir(runDir, { commits });
    assert.throws(() => finalize(runDir, commits[1]), /Command failed/);
  });
  // An unresolved ledger row cannot be rendered at all: the Task 1 contract requires an
  // empty `unresolved_rows`, so a run that still carries one has no document to emit.
  await withRunDir(async (runDir) => {
    await seedRunDir(runDir, { commits, overrides: { reconciliation: { unstarted_rows: 2 } } });
    assert.throws(() => finalize(runDir, commits[0]), /Command failed/);
    assert.equal(existsSync(path.join(runDir, "integration-readiness.json")), false);
  });
  await withRunDir(async (runDir) => {
    await seedRunDir(runDir, { commits });
    const broken = JSON.parse(await readFile(path.join(runDir, "pr-reconciliation.json"), "utf8"));
    broken.coverage_rows[0].proof_frozen_sha = OTHER_SHA;
    await write(runDir, "pr-reconciliation.json", broken);
    assert.throws(() => finalize(runDir, commits[0]), /Command failed/);
  });
});

test("validate reads the run directory and rejects a hand-edited Markdown bundle", async () => {
  const commits = firstParentShas();
  await withRunDir(async (runDir) => {
    await seedRunDir(runDir, { commits });
    const jsonPath = path.join(runDir, "integration-readiness.json");
    const markdownPath = path.join(runDir, "integration-readiness.md");
    runCli([
      "finalize",
      "--run-dir",
      runDir,
      "--frozen-sha",
      commits[0],
      "--json",
      jsonPath,
      "--markdown",
      markdownPath,
    ]);
    const markdown = await readFile(markdownPath, "utf8");
    await writeFile(markdownPath, markdown.replace("CODE_REMEDIATION_COMPLETE", "RELEASE_READY"));
    assert.throws(
      () => runCli(["validate", "--run-dir", runDir, "--frozen-sha", commits[0]]),
      /Command failed/,
    );
  });
});
