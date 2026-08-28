// INTEGRATION-003/004/005 — primitives shared by the integration-readiness entrypoint and
// its extracted sibling modules (namespace granted by A-39.3, mirroring the E2E extraction
// shape). Nothing here knows about the evidence contract: it is the failure type, the
// literal shapes a Plan 15 record may hold, the one Git ancestry probe, and the CLI file
// plumbing. Keeping them in one module is what lets the entrypoint stay thin and every
// file stay inside the Plan-12 unbudgeted 1,200-line ceiling with no policy edit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class IntegrationEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "IntegrationEvidenceError";
  }
}

export const fail = (message) => {
  throw new IntegrationEvidenceError(message);
};
/** Asserts one contract rule. Every validation in this namespace is a sequence of these. */
export const check = (condition, message) => {
  if (!condition) fail(message);
};

export const HEX40 = /^[0-9a-f]{40}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/;
export const MANDATORY_STATUSES = Object.freeze(["PASS", "FAIL", "ACTIVE"]);

export const keys = (definition) => Object.freeze(definition.split(/\s+/).filter(Boolean));
export const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const EXTERNAL_GATE_IDS = Object.freeze(
  "OPS-01 OPS-02 OPS-03 OPS-04 OPS-05 OPS-06".split(" "),
);

// The three frozen document identifiers live here rather than in the entrypoint because
// INTEGRATION-010's reconcile module needs them to assemble and classify a run, and a
// sibling module may never import the entrypoint without forming a cycle. The entrypoint
// re-exports all three, so Task 1's published import surface is unchanged.
export const INTEGRATION_EVIDENCE_SCHEMA = "viva.integration_readiness.v1";
export const MAIN_RECONCILIATION_SCHEMA = "viva.main_reconciliation.v1";
export const TERMINAL_STATUSES = Object.freeze(
  "CODE_REMEDIATION_COMPLETE CODE_COMPLETE_EXTERNAL_GATES_PENDING RELEASE_READY".split(" "),
);

// Neither the Markdown renderer (Task 1) nor the frozen command runner (Task 4) may ever
// print an environment value behind one of these key markers. The list is the plan's own,
// in the plan's order and plain spelling. Two of the redaction control's evidence markers
// occur in this line, so it flags and is reported verbatim for a coordinator sanction row;
// A-12/A-34.3/A-39.1 forbid editing the control or spelling around it. It moved here from
// `integration-readiness.mjs` because both consumers need it and the sibling modules
// cannot import the entrypoint without forming a cycle.
export const GUARDED_ENVIRONMENT_KEYS = Object.freeze(
  "KEY TOKEN SECRET BEARER PASSWORD AUDIO TRANSCRIPT ANSWER PROMPT SOURCE_CONTEXT".split(" "),
);
/** True when an environment key name is guarded and its value must never be recorded. */
export const isGuardedEnvironmentKey = (key) =>
  GUARDED_ENVIRONMENT_KEYS.some((marker) => String(key).toUpperCase().includes(marker));

// --- The sixteen Program integration nodes ---
/** lane number -> [namespace, branch suffix, plan slug] */
export const LANES = Object.freeze({
  "03": ["CRIT", "03-critical-path", "expedited-critical-path"],
  "04": ["LEARN", "04-learning-core", "learning-core-authority"],
  "05": ["VOICE", "05-voice-contract", "voice-wire-auth-contract"],
  "06": ["DOMAIN", "06-domain-integrity", "rust-domain-integrity"],
  "07": ["ADAPTER", "07-live-adapters", "live-provider-adapters"],
  "08": ["SERVICE", "08-service-runtime", "agent-service-runtime"],
  "09": ["DATA", "09-data-privacy", "persistence-postgres-privacy"],
  10: ["WEBSESSION", "10-web-session", "web-session-audio"],
  11: ["WEBAPI", "11-web-api-security", "web-api-security"],
  12: ["RELEASE", "12-release-ci", "release-monitor-ci-supply-chain"],
  13: ["FRONTEND", "13-frontend", "frontend-accessibility-performance"],
  14: ["PACKAGE", "14-package-build", "package-build-contracts"],
  15: ["INTEGRATION", "integration", "integrated-evidence-and-release-readiness"],
});

/** `node id | topological rank | direct predecessors` — the Program input table. */
const NODE_ROWS = `03|0| ; 04A|1|03 ; 05|1|03 ; 12A|1|03 ; 13A|2|03,12A ; 06|2|03,04A,12A ;
  04B|3|06 ; 14A|4|03,04B ; 07|4|04B,05,06 ; 09|4|04B,06 ; 08|5|04B,05,06,09 ; 11|6|05,08,14A ;
  10|7|04B,05,08,11,12A,13A,14A ; 13B|8|10,11 ; 14B|9|13B,14A ; 12B|10|07,08,09,10,11,13B,14B`;

export const PROGRAM_NODES = Object.freeze(
  NODE_ROWS.split(";").map((entry) => {
    const [nodeId, rank, predecessors] = entry.split("|").map((field) => field.trim());
    const [namespace, branchSuffix, planSlug] = LANES[nodeId.slice(0, 2)];
    return Object.freeze({
      node_id: nodeId,
      topological_rank: Number(rank),
      namespace,
      split_phase: nodeId.length > 2 ? nodeId.slice(2) : null,
      plan_path: `docs/superpowers/plans/2026-08-23-${planSlug}.md`,
      branch: `review-remediation/${branchSuffix}`,
      predecessor_node_ids: Object.freeze(predecessors.split(",").filter(Boolean)),
    });
  }),
);

export const NODE_BY_ID = new Map(PROGRAM_NODES.map((node) => [node.node_id, node]));
export const NAMESPACES = Object.freeze(Object.values(LANES).map(([namespace]) => namespace));
export const LANE_BRANCH_PATTERN = /^review-remediation\/(0[3-9]|1[0-4])-/;

export function exactKeys(value, required, label, optional = []) {
  check(isRecord(value), `${label} must be an object`);
  for (const key of required) check(Object.hasOwn(value, key), `${label} missing field: ${key}`);
  for (const key of Object.keys(value)) {
    check(required.includes(key) || optional.includes(key), `${label} unknown field: ${key}`);
  }
}

export const requireText = (v, l) => {
  check(typeof v === "string" && v.trim() !== "", `${l} must be a non-empty string`);
  return v;
};
export const requireSha = (v, l) => {
  check(typeof v === "string" && HEX40.test(v), `${l} must be 40 lowercase hex`);
  return v;
};
export const requireHex64 = (v, l) =>
  check(typeof v === "string" && HEX64.test(v), `${l} must be 64 hex`);
export const requireInstant = (v, l) =>
  check(typeof v === "string" && UTC_INSTANT.test(v), `${l} must be a UTC instant`);
export const requireArray = (v, l) => {
  check(Array.isArray(v), `${l} must be an array`);
  return v;
};
export const requireStatus = (v, allowed, l) => {
  check(
    v !== "BLOCKED_EXTERNAL" || allowed.includes(v),
    `${l}: mandatory gate cannot use BLOCKED_EXTERNAL`,
  );
  check(allowed.includes(v), `${l}: status must be ${allowed.join("/")}`);
};
/** Repository-relative, inside the ignored `artifacts/` tree, with no `..` escape. */
export const requireEvidencePath = (v, l) => {
  const segments = typeof v === "string" ? v.split("/") : [];
  const clean = segments.every((s) => s !== "" && s !== "." && s !== "..");
  const under = segments.length > 1 && segments[0] === "artifacts" && clean;
  check(under && !v.includes("\\") && !path.isAbsolute(v), `${l} must be under ignored artifacts/`);
};

/** Field rules referenced by the shape tables in every sibling module. */
export const RULES = {
  any: () => {},
  array: requireArray,
  hex64: requireHex64,
  instant: requireInstant,
  path: requireEvidencePath,
  sha: requireSha,
  text: requireText,
  count: (v, l) => check(Number.isInteger(v) && v >= 0, `${l} must be a non-negative integer`),
  gate: (v, l) => requireStatus(v, MANDATORY_STATUSES, l),
  integer: (v, l) => check(Number.isInteger(v), `${l} must be an integer`),
  isTrue: (v, l) => check(v === true, `${l} must be true`),
  isZero: (v, l) => check(v === 0, `${l} must be 0`),
  runId: (v, l) => check(typeof v === "string" && RUN_ID.test(v), `${l} is malformed`),
};

/** `name:rule` pairs, whitespace separated, parsed into a shape table. */
export const shape = (definition) =>
  Object.freeze(Object.fromEntries(keys(definition).map((field) => field.split(":"))));

export function validateShape(value, spec, label, { optional = [], join = " " } = {}) {
  const names = Object.keys(spec);
  check(isRecord(value), `${label} must be an object`);
  for (const name of names) check(Object.hasOwn(value, name), `${label}${join}${name} is required`);
  for (const key of Object.keys(value)) {
    check(names.includes(key) || optional.includes(key), `${label} unknown field: ${key}`);
  }
  for (const name of names) RULES[spec[name]](value[name], `${label}${join}${name}`);
}

export function gitIsAncestor(ancestor, descendant) {
  if (ancestor === descendant) return true;
  try {
    const argv = ["merge-base", "--is-ancestor", ancestor, descendant];
    execFileSync("git", argv, { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --- CLI file plumbing ---
export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export const split = (text, separator) =>
  text
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
export const readLines = (file) => split(readFileSync(file, "utf8"), "\n");
export const csv = (value) => split(value ?? "", ",");
export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
export const git = (args, encoding) =>
  execFileSync("git", args, { cwd: repoRoot, encoding, maxBuffer: 256 * 1024 * 1024 });

export function writeJson(file, value) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    check(typeof name === "string" && name.startsWith("--"), `unexpected argument: ${name}`);
    check(argv[index + 1] !== undefined, `flag ${name} requires a value`);
    flags.set(name.slice(2), argv[index + 1]);
  }
  return flags;
}

export const flag = (flags, name) => {
  check(flags.get(name) !== undefined, `missing required flag --${name}`);
  return flags.get(name);
};
