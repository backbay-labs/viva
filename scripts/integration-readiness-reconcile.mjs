// INTEGRATION-010 — PR/ledger/deploy reconciliation and the exact deploy/run binding.
//
// Task 10's whole subject is identity confusion, so this module's organising rule is that
// every identity in a release claim has a TYPE and is only ever compared to its own kind:
// Git SHAs, platform deployment IDs, pinned build-input digests, deployed output-image
// digests, durable-object ETags, hosted (numeric) run IDs, and integration run IDs are seven
// different things. A pinned base-image or Bun archive digest can never satisfy a deployed
// output-image field; a deployment ID can never satisfy a SHA field; web/agent/monitor
// evidence can never mix run IDs or environments. `all_bindings_match` is never accepted as
// an assertion: it is derived from those typed fields, and a document that claims it while
// the fields disagree is rejected. The reconciliation half is pure logic over captured
// GitHub/ledger data — it merges nothing, opens nothing, and mutates no PR — so the live
// `gh` run stays the coordinator's. The `finalize`/`validate` verbs assemble one document
// from a run directory and render the JSON and the Markdown from that single source; the
// terminal-status omission logic is the Task 1 classifier, called, never reimplemented.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  check,
  exactKeys,
  fail,
  flag,
  gitIsAncestor,
  HEX40,
  HEX64,
  INTEGRATION_EVIDENCE_SCHEMA,
  isRecord,
  keys,
  LANE_BRANCH_PATTERN,
  MAIN_RECONCILIATION_SCHEMA,
  RUN_ID,
  readJson,
  requireArray,
  requireEvidencePath,
  requireInstant,
  requireSha,
  requireText,
  TERMINAL_STATUSES,
  writeJson,
} from "./integration-readiness-shared.mjs";

export const PR_RECONCILIATION_SCHEMA = "viva.pr_reconciliation.v1";
/** The only three dispositions a reconciled pull request may carry. */
export const PR_DISPOSITIONS = Object.freeze([
  "included_exact_head",
  "superseded_by_included_commit",
  "excluded_with_reason",
]);
export const MONITOR_STATE_OBJECT_KEY = "viva-hosted-monitor/state/live-monitor-state.v1.json";
export const DEPLOY_ENVIRONMENT = "production";
export const INTEGRATION_BRANCH = "review-remediation/integration";

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const HOSTED_RUN_ID = /^[1-9][0-9]*$/;
const PR_STATES = Object.freeze(["OPEN", "CLOSED", "MERGED"]);
const COVERAGE_STATES = Object.freeze(["COMPLETE", "OPEN"]);
const SERVICE_NAMES = Object.freeze(["web", "agent", "monitor"]);
const COMPONENT_FINDING_INSTANCES = 128;

// --- The typed field rules ---
/** One rule per identity kind. Nothing here accepts a value of a neighbouring type. */
const TYPES = {
  any: () => {},
  sha: (value, label) =>
    check(typeof value === "string" && HEX40.test(value), `${label} must be a 40-hex Git SHA`),
  shaOrNull: (value, label) =>
    check(
      value === null || (typeof value === "string" && HEX40.test(value)),
      `${label} must be a 40-hex Git SHA or null`,
    ),
  digest: (value, label) =>
    check(
      typeof value === "string" && IMAGE_DIGEST.test(value),
      `${label} must be a sha256: image digest`,
    ),
  hex64: (value, label) =>
    check(typeof value === "string" && HEX64.test(value), `${label} must be 64 lowercase hex`),
  runId: (value, label) =>
    check(
      typeof value === "string" && RUN_ID.test(value),
      `${label} must be an integration run ID`,
    ),
  hostedRunId: (value, label) =>
    check(
      typeof value === "string" && HOSTED_RUN_ID.test(value),
      `${label} must be a numeric hosted run ID`,
    ),
  attempt: (value, label) =>
    check(Number.isInteger(value) && value > 0, `${label} must be a positive integer attempt`),
  instant: requireInstant,
  text: requireText,
  deploymentId: (value, label) => {
    requireText(value, label);
    check(!HEX40.test(value), `${label} must be a platform deployment ID, not a Git SHA`);
    const digested = IMAGE_DIGEST.test(value) || HEX64.test(value);
    check(!digested, `${label} must be a platform deployment ID, not an image digest`);
    const numbered = RUN_ID.test(value) || HOSTED_RUN_ID.test(value);
    check(!numbered, `${label} must be a platform deployment ID, not a run ID`);
  },
  etag: (value, label) => {
    requireText(value, label);
    check(!HEX40.test(value), `${label} must be an object ETag, not a Git SHA`);
    check(!IMAGE_DIGEST.test(value), `${label} must be an object ETag, not an image digest`);
    check(!RUN_ID.test(value), `${label} must be an object ETag, not a run ID`);
  },
  origin: (value, label) => {
    requireText(value, label);
    let parsed = null;
    try {
      parsed = new URL(value);
    } catch {
      parsed = null;
    }
    const bare =
      parsed !== null &&
      parsed.protocol === "https:" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin === value;
    check(bare, `${label} must be an https origin with no path, query, or fragment`);
  },
};

const shapeOf = (definition) =>
  Object.freeze(Object.fromEntries(keys(definition).map((field) => field.split(":"))));

function validateTyped(value, spec, label) {
  const names = Object.keys(spec);
  check(isRecord(value), `${label} must be an object`);
  for (const name of names) check(Object.hasOwn(value, name), `${label} missing field: ${name}`);
  for (const key of Object.keys(value)) {
    check(names.includes(key), `${label} unknown field: ${key}`);
  }
  for (const name of names) TYPES[spec[name]](value[name], `${label}.${name}`);
}

// --- The exact deploy/run binding ---
const GIT_SPEC = shapeOf("frozen_sha:sha main_sha:shaOrNull");
const GITHUB_SPEC = shapeOf("run_id:hostedRunId run_attempt:attempt head_sha:sha");
const RELEASE_SPEC = shapeOf("run_id:runId bundle_sha256:hex64 verified_at:instant");
const BUILD_INPUTS_SPEC = shapeOf(`agent_base_image_digest:digest monitor_base_image_digest:digest
  monitor_bun_archive_sha256:hex64`);
const DEPLOYED_SPEC = shapeOf(
  "deployment_id:deploymentId output_image_digest:digest deploy_sha:sha origin:origin",
);
const MONITOR_SPEC = shapeOf(`deployment_id:deploymentId output_image_digest:digest deploy_sha:sha
  run_id:runId object_prefix:text state_object_key:text state_etag:etag`);
const HOSTED_BROWSER_SPEC = shapeOf(`run_id:runId web_deployment_id:deploymentId
  agent_deployment_id:deploymentId deploy_sha:sha`);
const LIVE_SMOKE_SPEC = shapeOf(`run_id:runId agent_deployment_id:deploymentId deploy_sha:sha
  environment:text`);
const BINDING_KEYS = keys(`git github release build_inputs web agent monitor hosted_browser
  live_smoke all_bindings_match`);

/**
 * The three pinned build inputs, in both the prefixed and bare spellings a copy/paste
 * would produce. A deployed output-image digest may never be any of them.
 */
function pinnedBuildInputs(binding) {
  const inputs = isRecord(binding?.build_inputs) ? binding.build_inputs : {};
  const archive = inputs.monitor_bun_archive_sha256;
  const spellings = typeof archive === "string" ? [archive, `sha256:${archive}`] : [];
  return [inputs.agent_base_image_digest, inputs.monitor_base_image_digest, ...spellings].filter(
    (value) => typeof value === "string",
  );
}

/**
 * Derived, never asserted: every typed identity a production release claim binds together.
 * It is deliberately tolerant of malformed input so it can be evaluated on a document the
 * validator would reject, which is what makes the assertion check meaningful.
 */
export function deriveAllBindingsMatch(binding, frozenSha) {
  const doc = isRecord(binding) ? binding : {};
  const git = doc.git ?? {};
  const github = doc.github ?? {};
  const release = doc.release ?? {};
  const [web, agent, monitor] = SERVICE_NAMES.map((name) => doc[name] ?? {});
  const browser = doc.hosted_browser ?? {};
  const smoke = doc.live_smoke ?? {};
  const sha = frozenSha ?? git.frozen_sha;
  const runId = release.run_id;
  const pinned = pinnedBuildInputs(doc);
  return [
    git.frozen_sha === sha,
    git.main_sha === sha,
    github.head_sha === sha,
    [web, agent, monitor, browser, smoke].every((entry) => entry.deploy_sha === sha),
    [monitor, browser, smoke].every((entry) => entry.run_id === runId),
    browser.web_deployment_id === web.deployment_id,
    browser.agent_deployment_id === agent.deployment_id,
    smoke.agent_deployment_id === agent.deployment_id,
    smoke.environment === DEPLOY_ENVIRONMENT,
    monitor.state_object_key === MONITOR_STATE_OBJECT_KEY,
    [web, agent, monitor].every((entry) => !pinned.includes(entry.output_image_digest)),
  ].every(Boolean);
}

export function validateDeployBinding(binding, options = {}) {
  const { frozenSha, runId, ready = false } = options;
  const at = "deploy_binding";
  exactKeys(binding, BINDING_KEYS, at);
  const claimed = binding.all_bindings_match;
  check(typeof claimed === "boolean", `${at}.all_bindings_match must be a boolean`);
  validateTyped(binding.git, GIT_SPEC, `${at}.git`);
  validateTyped(binding.github, GITHUB_SPEC, `${at}.github`);
  validateTyped(binding.release, RELEASE_SPEC, `${at}.release`);
  validateTyped(binding.build_inputs, BUILD_INPUTS_SPEC, `${at}.build_inputs`);
  validateTyped(binding.web, DEPLOYED_SPEC, `${at}.web`);
  validateTyped(binding.agent, DEPLOYED_SPEC, `${at}.agent`);
  validateTyped(binding.monitor, MONITOR_SPEC, `${at}.monitor`);
  validateTyped(binding.hosted_browser, HOSTED_BROWSER_SPEC, `${at}.hosted_browser`);
  validateTyped(binding.live_smoke, LIVE_SMOKE_SPEC, `${at}.live_smoke`);
  const pinned = pinnedBuildInputs(binding);
  for (const name of SERVICE_NAMES) {
    const pinnedOutput = pinned.includes(binding[name].output_image_digest);
    const detail = "is a pinned build input, not a deployed output-image digest";
    check(!pinnedOutput, `${at}.${name}.output_image_digest ${detail}`);
  }
  for (const [left, right] of [
    ["web", "agent"],
    ["web", "monitor"],
    ["agent", "monitor"],
  ]) {
    const sameId = binding[left].deployment_id === binding[right].deployment_id;
    check(!sameId, `${left} and ${right} recorded the same deployment ID`);
    const sameImage = binding[left].output_image_digest === binding[right].output_image_digest;
    check(!sameImage, `${left} and ${right} recorded the same deployed output-image digest`);
  }
  check(binding.git.frozen_sha === frozenSha, `${at}.git.frozen_sha is not the frozen SHA`);
  check(binding.github.head_sha === frozenSha, `${at}.github.head_sha is not the frozen SHA`);
  for (const name of [...SERVICE_NAMES, "hosted_browser", "live_smoke"]) {
    check(binding[name].deploy_sha === frozenSha, `${at}.${name}.deploy_sha is not the frozen SHA`);
  }
  check(binding.release.run_id === runId, `${at}.release.run_id is not the integration run ID`);
  for (const name of ["monitor", "hosted_browser", "live_smoke"]) {
    const bound = binding[name].run_id === binding.release.run_id;
    check(bound, `${at}.${name}.run_id is not the release run ID`);
  }
  const environment = binding.live_smoke.environment === DEPLOY_ENVIRONMENT;
  check(environment, `${at}.live_smoke.environment must be ${DEPLOY_ENVIRONMENT}`);
  const browserWeb = binding.hosted_browser.web_deployment_id === binding.web.deployment_id;
  check(browserWeb, `${at}.hosted_browser.web_deployment_id is not the web deployment ID`);
  for (const [name, field] of [
    ["hosted_browser", "agent_deployment_id"],
    ["live_smoke", "agent_deployment_id"],
  ]) {
    const bound = binding[name][field] === binding.agent.deployment_id;
    check(bound, `${at}.${name}.${field} is not the agent deployment ID`);
  }
  const stateKey = binding.monitor.state_object_key === MONITOR_STATE_OBJECT_KEY;
  check(stateKey, `${at}.monitor.state_object_key must be ${MONITOR_STATE_OBJECT_KEY}`);
  const prefixed = binding.monitor.object_prefix.includes(binding.monitor.run_id);
  check(prefixed, `${at}.monitor.object_prefix must name the monitor run ID`);
  const derived = deriveAllBindingsMatch(binding, frozenSha);
  if (claimed !== derived) {
    check(!claimed, `${at}.all_bindings_match is asserted but the typed bindings do not match`);
    fail(`${at}.all_bindings_match must be the derived value ${derived}`);
  }
  if (ready) {
    const merged = binding.git.main_sha === frozenSha;
    check(merged, `RELEASE_READY requires ${at}.git.main_sha to equal the frozen SHA`);
    check(derived, `RELEASE_READY requires a derived ${at}.all_bindings_match`);
  }
  return binding;
}

const cell = (value) => (value === null || value === undefined ? "null" : String(value));

/** The `## Deploy/run binding` body. Every field renders; nothing is friendly-omitted. */
export function renderDeployBindingSection(binding) {
  if (!isRecord(binding)) return ["- Deploy binding: `null`", ""];
  const line = (label, value) => `- ${label}: \`${cell(value)}\``;
  const { git, github, release, build_inputs: inputs, monitor } = binding;
  const browser = binding.hosted_browser;
  const smoke = binding.live_smoke;
  return [
    line("Deploy binding frozen SHA", git.frozen_sha),
    line("Deploy binding main SHA", git.main_sha),
    line("Deploy binding run ID", release.run_id),
    line("Hosted run", `${github.run_id} attempt ${github.run_attempt} head ${github.head_sha}`),
    line("Release bundle", `${release.bundle_sha256} verified ${release.verified_at}`),
    line(
      "Pinned build inputs",
      `agent ${inputs.agent_base_image_digest}, monitor ${inputs.monitor_base_image_digest}, ` +
        `bun archive ${inputs.monitor_bun_archive_sha256}`,
    ),
    line(
      "Monitor durable state",
      `${monitor.state_object_key} prefix ${monitor.object_prefix} etag ${monitor.state_etag}`,
    ),
    line(
      "Hosted browser",
      `run ${browser.run_id} web ${browser.web_deployment_id} agent ${browser.agent_deployment_id}`,
    ),
    line(
      "Live smoke",
      `run ${smoke.run_id} agent ${smoke.agent_deployment_id} environment ${smoke.environment}`,
    ),
    line("All bindings match", binding.all_bindings_match),
    "",
    "| Service | Deployment ID | Output image digest | Deploy SHA | Origin |",
    "| --- | --- | --- | --- | --- |",
    ...SERVICE_NAMES.map((name) => {
      const service = binding[name];
      const identity = `${service.deployment_id} | ${service.output_image_digest}`;
      return `| ${name} | ${identity} | ${service.deploy_sha} | ${cell(service.origin)} |`;
    }),
    "",
  ];
}

// --- The terminal status, under each of its forbidden conditions ---
/**
 * The Task 1 classifier owns the derivation; this owns the refusals, so that a document
 * carrying a hand-written status is rejected by the exact rule it violated.
 */
export function assertTerminalStatus(document, { complete, derived } = {}) {
  if (!Object.hasOwn(document ?? {}, "terminal_status")) return;
  const status = document.terminal_status;
  const legal = TERMINAL_STATUSES.includes(status);
  check(legal, `terminal_status must be one of ${TERMINAL_STATUSES.join(", ")}`);
  check(complete === true, "terminal_status is forbidden while a mandatory gate is non-PASS");
  const gates = Array.isArray(document.external_gates) ? document.external_gates : [];
  const named = (predicate) =>
    gates
      .filter(predicate)
      .map((gate) => gate?.id)
      .join(", ");
  if (status === "RELEASE_READY") {
    const unproven = named((gate) => gate?.status !== "PASS");
    check(
      unproven === "",
      `RELEASE_READY requires every external gate to be PASS; ${unproven} is not`,
    );
  }
  if (status === "CODE_COMPLETE_EXTERNAL_GATES_PENDING") {
    const failed = named((gate) => gate?.status === "FAIL");
    const detail =
      "CODE_COMPLETE_EXTERNAL_GATES_PENDING is forbidden while an external gate is FAIL";
    check(failed === "", `${detail}: ${failed}`);
  }
  if (status === "CODE_REMEDIATION_COMPLETE") {
    const failed = gates.some((gate) => gate?.status === "FAIL");
    const clean = "CODE_REMEDIATION_COMPLETE is forbidden while the external set is all PASS or";
    check(failed || derived === status, `${clean} cleanly pending`);
  }
  check(status === derived, "terminal_status does not match the derived classification");
}

// --- PR, check, coverage, and stored-bundle reconciliation ---
const PR_SPEC = shapeOf(`number:any url:any state:any head_ref_name:text head_sha:sha
  merge_commit_sha:shaOrNull node_id:any disposition:any integration_merge_sha:shaOrNull
  superseded_by_sha:shaOrNull reason:any`);
const INTEGRATION_PR_KEYS = keys("number url state head_sha merge_commit_sha");
const CHECK_SPEC = shapeOf("name:text head_sha:sha status:text conclusion:text");
const COVERAGE_ROW_KEYS = keys(`row_id canonical_id status proof_pull_request_numbers
  proof_artifacts proof_frozen_sha`);
const BUNDLE_SPEC = shapeOf(
  "run_id:runId sha256:hex64 source_sha:sha generated_at:instant verified_at:instant",
);
const RECONCILIATION_KEYS = keys(`schema frozen_sha frozen_at main_sha_after_reconciliation
  integration_pull_request pull_requests checks coverage_rows stored_bundle`);

const isRemediationBranch = (branch) =>
  LANE_BRANCH_PATTERN.test(branch) || branch === INTEGRATION_BRANCH;

function validatePullRequestRecord(record, document, isAncestor) {
  validateTyped(record, PR_SPEC, `pull request ${record?.number}`);
  const number = record.number;
  check(Number.isInteger(number) && number > 0, "a pull request number must be a positive integer");
  const url = typeof record.url === "string" && record.url.endsWith(`/pull/${number}`);
  check(url, `PR ${number} url must name its own pull request`);
  check(PR_STATES.includes(record.state), `PR ${number} state is unrecorded: ${record.state}`);
  const known = record.disposition === null || PR_DISPOSITIONS.includes(record.disposition);
  check(known, `PR ${number} disposition is unrecorded: ${record.disposition}`);
  const owed = record.state === "OPEN" || isRemediationBranch(record.head_ref_name);
  check(record.disposition !== null || !owed, `open remediation PR ${number} has no disposition`);
  if (record.state !== "MERGED") return;
  check(record.merge_commit_sha !== null, `merged PR ${number} has no merge commit`);
  const mainSha = document.main_sha_after_reconciliation;
  if (mainSha === null) return;
  const landed = isAncestor(record.merge_commit_sha, mainSha);
  const detail = `is absent from main after reconciliation`;
  check(landed, `merged PR ${number} merge commit ${record.merge_commit_sha} ${detail}`);
}

function validateDisposition(record, frozenSha, isAncestor) {
  const number = record.number;
  const reasoned = typeof record.reason === "string" && record.reason.trim() !== "";
  if (record.disposition === "included_exact_head") {
    check(record.state === "MERGED", `included PR ${number} must be MERGED`);
    check(record.superseded_by_sha === null, `PR ${number} cannot record a superseding commit`);
    requireSha(record.integration_merge_sha, `PR ${number} integration_merge_sha`);
    const head = isAncestor(record.head_sha, frozenSha);
    check(head, `lane PR ${number} head ${record.head_sha} is absent from the frozen SHA`);
    const merge = isAncestor(record.integration_merge_sha, frozenSha);
    const at = record.integration_merge_sha;
    check(merge, `lane PR ${number} integration merge ${at} is absent from the frozen SHA`);
    return;
  }
  check(record.integration_merge_sha === null, `PR ${number} cannot record an integration merge`);
  if (record.disposition === "superseded_by_included_commit") {
    requireSha(record.superseded_by_sha, `PR ${number} superseded_by_sha`);
    const included = isAncestor(record.superseded_by_sha, frozenSha);
    const at = record.superseded_by_sha;
    check(included, `PR ${number} superseding commit ${at} is absent from the frozen SHA`);
    return;
  }
  if (record.disposition === "excluded_with_reason") {
    check(record.superseded_by_sha === null, `PR ${number} cannot record a superseding commit`);
    check(reasoned, `PR ${number} excluded_with_reason requires a reason`);
  }
}

function validateRequiredNodePullRequests(document, laneInputs) {
  const byNumber = new Map(document.pull_requests.map((record) => [record.number, record]));
  const required = new Set();
  for (const node of laneInputs) {
    const record = byNumber.get(node.pr_number);
    const id = node.node_id;
    check(
      Boolean(record),
      `Program node ${id} PR ${node.pr_number} is missing from the reconciliation`,
    );
    required.add(node.pr_number);
    const exact = record.disposition === "included_exact_head";
    check(exact, `required Program node PR ${record.number} cannot use ${record.disposition}`);
    const named = record.node_id === id;
    check(named, `PR ${record.number} is recorded against node ${record.node_id}, not ${id}`);
    const head = record.head_sha === node.pr_head_sha;
    check(head, `PR ${record.number} head does not match the Program manifest`);
    const merge = record.integration_merge_sha === node.integration_merge_sha;
    check(merge, `PR ${record.number} integration merge does not match the Program manifest`);
  }
  for (const record of document.pull_requests) {
    if (required.has(record.number) || record.node_id === null) continue;
    const at = record.node_id;
    fail(`PR ${record.number} names Program node ${at} without an included exact head`);
  }
}

function validateCoverageRows(document) {
  const byNumber = new Map(document.pull_requests.map((record) => [record.number, record]));
  for (const row of requireArray(document.coverage_rows, "coverage_rows")) {
    exactKeys(row, COVERAGE_ROW_KEYS, "coverage row");
    const id = requireText(row.row_id, "coverage row row_id");
    requireText(row.canonical_id, `coverage row ${id} canonical_id`);
    check(COVERAGE_STATES.includes(row.status), `coverage row ${id} status is unrecorded`);
    const numbers = requireArray(row.proof_pull_request_numbers, `coverage row ${id} proof PRs`);
    const artifacts = requireArray(row.proof_artifacts, `coverage row ${id} proof artifacts`);
    if (row.status !== "COMPLETE") {
      const clean = row.proof_frozen_sha === null;
      check(clean, `coverage row ${id} is not complete and must not claim frozen-SHA proof`);
      continue;
    }
    const proven = row.proof_frozen_sha === document.frozen_sha;
    check(proven, `coverage row ${id} is marked complete without proof at the frozen SHA`);
    check(artifacts.length > 0, `coverage row ${id} names no proof artifact`);
    for (const artifact of artifacts)
      requireEvidencePath(artifact, `coverage row ${id} proof path`);
    check(numbers.length > 0, `coverage row ${id} names no proof pull request`);
    for (const number of numbers) {
      const record = byNumber.get(number);
      check(Boolean(record), `coverage row ${id} names an unrecorded PR ${number}`);
      const excluded = record.disposition === "excluded_with_reason";
      check(!excluded, `coverage row ${id} is satisfied by excluded PR ${number}`);
    }
  }
}

function validateStoredBundle(document) {
  const bundle = document.stored_bundle;
  validateTyped(bundle, BUNDLE_SPEC, "stored_bundle");
  const sourced = bundle.source_sha === document.frozen_sha;
  const at = bundle.source_sha;
  check(sourced, `the stored release bundle was generated from ${at}, not the final review SHA`);
  const generated = Date.parse(bundle.generated_at) >= Date.parse(document.frozen_at);
  check(generated, "the stored release bundle predates the final review SHA");
  const verified = Date.parse(bundle.verified_at) >= Date.parse(bundle.generated_at);
  check(verified, "the stored release bundle was verified before it was generated");
}

export function validatePullRequestReconciliation(document, options = {}) {
  const { laneInputs = [], isAncestor = gitIsAncestor } = options;
  exactKeys(document, RECONCILIATION_KEYS, "pr reconciliation");
  const schema = document.schema === PR_RECONCILIATION_SCHEMA;
  check(schema, `schema must be ${PR_RECONCILIATION_SCHEMA}`);
  const frozenSha = requireSha(document.frozen_sha, "frozen_sha");
  requireInstant(document.frozen_at, "frozen_at");
  TYPES.shaOrNull(document.main_sha_after_reconciliation, "main_sha_after_reconciliation");
  const integration = document.integration_pull_request;
  exactKeys(integration, INTEGRATION_PR_KEYS, "integration_pull_request");
  requireSha(integration.head_sha, "integration_pull_request.head_sha");
  const headed = integration.head_sha === frozenSha;
  check(headed, `the integration PR head ${integration.head_sha} is not the frozen SHA`);
  const records = requireArray(document.pull_requests, "pull_requests");
  const seen = new Set();
  for (const record of records) {
    validatePullRequestRecord(record, document, isAncestor);
    check(!seen.has(record.number), `duplicate pull request record: ${record.number}`);
    seen.add(record.number);
  }
  validateRequiredNodePullRequests(document, laneInputs);
  for (const record of records) validateDisposition(record, frozenSha, isAncestor);
  for (const [index, entry] of requireArray(document.checks, "checks").entries()) {
    validateTyped(entry, CHECK_SPEC, `checks[${index}]`);
    const bound = entry.head_sha === frozenSha;
    check(bound, `GitHub check ${entry.name} headSha ${entry.head_sha} is not the frozen SHA`);
  }
  validateCoverageRows(document);
  validateStoredBundle(document);
  return document;
}

// --- `finalize` and `validate`: one assembled source for the JSON and the Markdown ---
const RUN_DIR_FILES = Object.freeze({
  identity: "identity.json",
  laneInputs: "lane-inputs.json",
  levelOne: "level-1.json",
  levelTwo: "level-2.json",
  levelThree: "level-3.json",
  docsContract: "docs-contract.json",
  independentReview: "independent-review.json",
  mainReconciliation: "main-reconciliation.json",
  programReconciliations: "program-reconciliations.json",
  externalGates: "external-gates.json",
  deployBinding: "deploy-binding.json",
  releaseOwner: "release-owner.json",
  pullRequests: "pr-reconciliation.json",
  finalJson: "integration-readiness.json",
  finalMarkdown: "integration-readiness.md",
});

/** Level 1's own counters are the only source for the unresolved-row list. */
const UNRESOLVED_COUNTERS = keys(`unmapped_source_instances
  duplicate_source_instances_without_canonical_alias canonical_rows_with_missing_proof
  unstarted_rows decision_blocked_rows`);

function readRunPart(runDir, name, required = false) {
  const file = path.join(runDir, name);
  if (existsSync(file)) return readJson(file);
  check(!required, `the run directory is missing ${name}: ${runDir}`);
  return null;
}

function mainReconciliationBlock(recorded, identity) {
  if (!isRecord(recorded)) {
    return {
      status: "NOT_REQUIRED",
      live_main_sha: identity.live_main_sha_at_freeze,
      reconciliation_merge_sha: null,
      artifact: null,
    };
  }
  if (recorded.schema !== MAIN_RECONCILIATION_SCHEMA) return recorded;
  return {
    status: recorded.status,
    live_main_sha: recorded.live_main_sha,
    reconciliation_merge_sha: recorded.reconciliation_merge_sha ?? null,
    artifact: null,
  };
}

/** Pure: the coordinator's run directory in, one unvalidated evidence document out. */
export function assembleIntegrationEvidence(parts) {
  const identity = parts.identity;
  check(isRecord(identity), `${RUN_DIR_FILES.identity} must be an object`);
  const counters = isRecord(parts.levelOne?.reconciliation) ? parts.levelOne.reconciliation : {};
  const level = (document) => ({
    status: document?.status ?? "FAIL",
    commands: document?.commands ?? [],
    artifacts: document?.artifacts ?? [],
  });
  return {
    schema: INTEGRATION_EVIDENCE_SCHEMA,
    run_id: parts.runId,
    generated_at: parts.generatedAt,
    identity,
    lane_inputs: parts.laneInputs?.lane_inputs ?? parts.laneInputs ?? [],
    main_reconciliation: mainReconciliationBlock(parts.mainReconciliation, identity),
    program_reconciliations: parts.programReconciliations ?? [],
    coverage: {
      component_finding_instances_expected: COMPONENT_FINDING_INSTANCES,
      component_finding_instances_reconciled: counters.component_finding_instances ?? 0,
      unresolved_rows: UNRESOLVED_COUNTERS.flatMap((name) =>
        Number(counters[name] ?? 0) > 0 ? [`${name}: ${counters[name]}`] : [],
      ),
      ledger_sha256: parts.levelOne?.ledger_sha256 ?? "",
    },
    levels: {
      level_1: level(parts.levelOne),
      level_2: level(parts.levelTwo),
      level_3: level(parts.levelThree),
    },
    docs_contract: {
      status: parts.docsContract?.status ?? "FAIL",
      artifacts: parts.docsContract?.artifacts ?? [],
    },
    independent_review: {
      status: parts.independentReview?.status ?? "FAIL",
      findings: parts.independentReview?.findings ?? [],
      artifact: parts.independentReview?.artifact ?? null,
    },
    external_gates: parts.externalGates ?? [],
    deploy_binding: parts.deployBinding ?? null,
    release_owner: parts.releaseOwner ?? null,
    supersedes_run_id: parts.supersedesRunId ?? null,
    sanitized: true,
  };
}

function readRunDirectory(flags) {
  const runDir = flag(flags, "run-dir");
  const runId = flags.get("run-id") ?? path.basename(path.resolve(runDir));
  check(RUN_ID.test(runId), `the run directory does not name a run ID: ${runDir}`);
  const part = (name, required) => readRunPart(runDir, name, required);
  const assembled = assembleIntegrationEvidence({
    runId,
    generatedAt: new Date().toISOString(),
    identity: part(RUN_DIR_FILES.identity, true),
    laneInputs: part(RUN_DIR_FILES.laneInputs, true),
    levelOne: part(RUN_DIR_FILES.levelOne, true),
    levelTwo: part(RUN_DIR_FILES.levelTwo, true),
    levelThree: part(RUN_DIR_FILES.levelThree, true),
    docsContract: part(RUN_DIR_FILES.docsContract, true),
    independentReview: part(RUN_DIR_FILES.independentReview, true),
    mainReconciliation: part(RUN_DIR_FILES.mainReconciliation, false),
    programReconciliations: part(RUN_DIR_FILES.programReconciliations, false),
    externalGates: part(RUN_DIR_FILES.externalGates, false),
    deployBinding: part(RUN_DIR_FILES.deployBinding, false),
    releaseOwner: part(RUN_DIR_FILES.releaseOwner, false),
    supersedesRunId: flags.get("supersedes-run-id") ?? null,
  });
  const frozenSha = requireSha(flag(flags, "frozen-sha"), "--frozen-sha");
  const recorded = assembled.identity.frozen_sha;
  // The identity file's own SHA is the evidence; the flag confirms it and never overwrites
  // it, or a run assembled against the wrong tree would relabel itself.
  check(
    recorded === frozenSha,
    `the recorded frozen_sha ${recorded} is not --frozen-sha ${frozenSha}`,
  );
  return { runDir, assembled };
}

/** Step 4's reconciliation is mandatory before any terminal status may be emitted. */
function assertRunReconciliation(runDir, document) {
  const recorded = readRunPart(runDir, RUN_DIR_FILES.pullRequests);
  if (recorded === null) {
    const emitted = Object.hasOwn(document, "terminal_status");
    check(!emitted, `a mandatory-complete run requires ${RUN_DIR_FILES.pullRequests} in ${runDir}`);
    return;
  }
  validatePullRequestReconciliation(recorded, { laneInputs: document.lane_inputs });
}

/** `finalize` — Task 10 Step 5. Renders the JSON and the Markdown from one document. */
export function finalizeCommand(flags, io) {
  const { runDir, assembled } = readRunDirectory(flags);
  const document = io.finalizeIntegrationEvidence(assembled, {});
  assertRunReconciliation(runDir, document);
  writeJson(flag(flags, "json"), document);
  const markdown = flag(flags, "markdown");
  mkdirSync(path.dirname(path.resolve(markdown)), { recursive: true });
  writeFileSync(markdown, io.renderIntegrationMarkdown(document));
  const emitted = document.terminal_status ?? "no terminal status emitted";
  process.stdout.write(`${emitted} for ${document.identity.frozen_sha}.\n`);
}

/** `validate` — Task 8 Step 5 and Task 10 Step 6, at the evidence consumption boundary. */
export function validateRunCommand(flags, io) {
  const { runDir, assembled } = readRunDirectory(flags);
  const document = io.finalizeIntegrationEvidence(assembled, {});
  assertRunReconciliation(runDir, document);
  const stored = readRunPart(runDir, RUN_DIR_FILES.finalJson);
  const markdown = path.join(runDir, RUN_DIR_FILES.finalMarkdown);
  if (stored !== null && existsSync(markdown)) {
    io.validateIntegrationEvidence(stored, {});
    io.assertGeneratedMarkdown(stored, readFileSync(markdown, "utf8"));
  }
  const gates = [
    ["level_1", document.levels.level_1.status],
    ["level_2", document.levels.level_2.status],
    ["level_3", document.levels.level_3.status],
    ["docs_contract", document.docs_contract.status],
    ["independent_review", document.independent_review.status],
  ];
  const red = gates.filter(([, status]) => status !== "PASS").map(([id]) => id);
  check(red.length === 0, `mandatory gates are not PASS: ${red.join(", ")}`);
  process.stdout.write(`Integration evidence validated for ${document.identity.frozen_sha}.\n`);
}
