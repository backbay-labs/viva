import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Semantic purity gate for `agent-domain`.
 *
 * The gate inspects two things and claims nothing more:
 *   1. the crate's direct normal dependency set, read from `cargo metadata`;
 *   2. the module paths every `agent-domain` source file imports or names.
 *
 * It does not prove live behavior, adapter purity, or that the compiled binary
 * performs no I/O. Those claims belong to runtime tests, not to this script.
 */

export const AGENT_DOMAIN_PACKAGE_NAME = "agent-domain";
export const AGENT_DOMAIN_MANIFEST_RELATIVE_PATH = "agent/crates/agent-domain/Cargo.toml";
export const AGENT_DOMAIN_SOURCE_RELATIVE_DIR = "agent/crates/agent-domain/src";
export const WORKSPACE_MANIFEST_RELATIVE_PATH = "agent/Cargo.toml";

/** Dependencies the I/O-free domain crate always needs. */
export const AGENT_DOMAIN_BASE_DEPENDENCIES = Object.freeze([
  "async-trait",
  "base64",
  "bytes",
  "futures-util",
  "serde",
  "serde_json",
  "thiserror",
  "tokio",
]);

/**
 * The review-scheduling seam recorded as `D-01 SERVER_PERSISTED_FSRS`.
 *
 * `docs/decisions/2026-08-23-d-01-review-scheduling-authority.md` pins the Rust
 * crate `fsrs = "=6.6.1"` as the scheduling authority, and Plan 03 declares it in
 * `agent/crates/agent-domain/Cargo.toml` under that exact pin. It is a pure
 * spaced-repetition calculation library — it opens no file, socket, or process —
 * so it belongs on this boundary rather than outside it. The version pin lives in
 * the manifest and the decision document; this list only records that the name is
 * sanctioned.
 */
export const AGENT_DOMAIN_REVIEW_SCHEDULING_DEPENDENCIES = Object.freeze(["fsrs"]);

/**
 * Pure validation libraries the boundary recognizes as non-I/O.
 *
 * `uuid` is declared by the domain manifest only when `D-04 DELETION_UX` selects
 * `SOFT_DELETE_UNDO`; under `CONFIRM_DELETE` it is absent and the
 * unused-dependency gate is the independent absence backstop. `chrono` is also
 * recognized here, but its presence is not a D-04 signal: the D-01 scheduling
 * seam above uses it for UTC instants, so it is declared under `CONFIRM_DELETE`
 * too.
 */
export const AGENT_DOMAIN_CONDITIONAL_DEPENDENCIES = Object.freeze(["chrono", "uuid"]);

export const AGENT_DOMAIN_DEPENDENCY_ALLOWLIST = Object.freeze(
  [
    ...AGENT_DOMAIN_BASE_DEPENDENCIES,
    ...AGENT_DOMAIN_REVIEW_SCHEDULING_DEPENDENCIES,
    ...AGENT_DOMAIN_CONDITIONAL_DEPENDENCIES,
  ].sort(),
);

/** Module roots the domain crate may never import or name. */
export const FORBIDDEN_MODULE_PATHS = Object.freeze([
  "std::fs",
  "std::net",
  "std::process",
  "tokio::fs",
  "tokio::net",
  "tokio::process",
  "tokio::signal",
]);

export const CARGO_METADATA_ARGS = Object.freeze([
  "metadata",
  "--manifest-path",
  WORKSPACE_MANIFEST_RELATIVE_PATH,
  "--format-version",
  "1",
  "--no-deps",
]);

const FORBIDDEN_USAGE_PATTERN =
  /(?<![A-Za-z0-9_:])(std|tokio)\s*::\s*(fs|net|process|signal)(?![A-Za-z0-9_])/g;

function toPosixPath(value) {
  return String(value).split(path.sep).join("/").replace(/\\/g, "/");
}

function splitTopLevel(input) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of input) {
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function normalizeUsePath(raw) {
  let normalized = raw.replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/, "");
  normalized = normalized.replace(/\s+/g, "");
  normalized = normalized.replace(/^::/, "");
  if (normalized.endsWith("::self")) {
    normalized = normalized.slice(0, -"::self".length);
  }
  return normalized;
}

/**
 * Flattens a Rust `use` tree into fully qualified module paths so grouped
 * imports such as `use std::{fs, net};` and `use tokio::{net::TcpStream, fs};`
 * are seen as `std::fs`, `std::net`, `tokio::net::TcpStream`, and `tokio::fs`.
 */
export function expandUseTree(spec) {
  const trimmed = String(spec).trim();
  const open = trimmed.indexOf("{");
  if (open === -1) {
    const normalized = normalizeUsePath(trimmed);
    return normalized.length > 0 ? [normalized] : [];
  }

  let depth = 0;
  let close = -1;
  for (let index = open; index < trimmed.length; index += 1) {
    if (trimmed[index] === "{") {
      depth += 1;
    } else if (trimmed[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) {
    const normalized = normalizeUsePath(trimmed.slice(0, open));
    return normalized.length > 0 ? [normalized] : [];
  }

  const prefix = trimmed.slice(0, open).replace(/::\s*$/, "").trim();
  const expanded = [];
  for (const part of splitTopLevel(trimmed.slice(open + 1, close))) {
    expanded.push(...expandUseTree(prefix.length > 0 ? `${prefix}::${part}` : part));
  }
  return expanded;
}

function forbiddenPathFor(modulePath) {
  return FORBIDDEN_MODULE_PATHS.find(
    (forbidden) => modulePath === forbidden || modulePath.startsWith(`${forbidden}::`),
  );
}

/**
 * Returns every forbidden module path a source file imports or names.
 * Both grouped `use` trees and inline qualified usages are inspected.
 */
export function findForbiddenIoReferences(sourceText) {
  const findings = new Set();

  for (const match of String(sourceText).matchAll(/\b(?:pub\s+)?use\s+([^;]+);/g)) {
    for (const modulePath of expandUseTree(match[1])) {
      const forbidden = forbiddenPathFor(modulePath);
      if (forbidden !== undefined) {
        findings.add(forbidden);
      }
    }
  }

  for (const match of String(sourceText).matchAll(FORBIDDEN_USAGE_PATTERN)) {
    const modulePath = `${match[1]}::${match[2]}`;
    const forbidden = forbiddenPathFor(modulePath);
    if (forbidden !== undefined) {
      findings.add(forbidden);
    }
  }

  return [...findings].sort();
}

function normalizeSourceEntry(entry, index) {
  if (typeof entry === "string") {
    return { path: `<source-${index}>`, text: entry };
  }
  if (entry !== null && typeof entry === "object") {
    return {
      path: entry.path === undefined ? `<source-${index}>` : String(entry.path),
      text: entry.text,
    };
  }
  return { path: `<source-${index}>`, text: undefined };
}

export function selectAgentDomainPackage(metadata) {
  if (metadata === null || typeof metadata !== "object" || !Array.isArray(metadata.packages)) {
    throw new Error("cargo metadata payload is missing a packages array");
  }

  const matches = metadata.packages.filter(
    (entry) =>
      entry !== null && typeof entry === "object" && entry.name === AGENT_DOMAIN_PACKAGE_NAME,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${AGENT_DOMAIN_PACKAGE_NAME} package in cargo metadata, found ${matches.length}`,
    );
  }

  const [packageEntry] = matches;
  const manifestPath = toPosixPath(packageEntry.manifest_path ?? "");
  if (!manifestPath.endsWith(`/${AGENT_DOMAIN_MANIFEST_RELATIVE_PATH}`)) {
    throw new Error(
      `${AGENT_DOMAIN_PACKAGE_NAME} manifest path is not ${AGENT_DOMAIN_MANIFEST_RELATIVE_PATH}: ${manifestPath}`,
    );
  }

  return packageEntry;
}

export function assertDependencyAllowlist(packageEntry) {
  if (!Array.isArray(packageEntry.dependencies)) {
    throw new Error(`${AGENT_DOMAIN_PACKAGE_NAME} metadata is missing a dependencies array`);
  }

  const names = [];
  for (const dependency of packageEntry.dependencies) {
    if (dependency === null || typeof dependency !== "object") {
      throw new Error(`${AGENT_DOMAIN_PACKAGE_NAME} has a malformed dependency entry`);
    }
    const kind = dependency.kind ?? "normal";
    if (kind !== "normal") {
      continue;
    }
    const name = dependency.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`${AGENT_DOMAIN_PACKAGE_NAME} has an unnamed normal dependency`);
    }
    if (typeof dependency.path === "string" && dependency.path.length > 0) {
      throw new Error(
        `${AGENT_DOMAIN_PACKAGE_NAME} dependency "${name}" is a path dependency; the domain crate must not depend on workspace infrastructure crates`,
      );
    }
    if (!AGENT_DOMAIN_DEPENDENCY_ALLOWLIST.includes(name)) {
      throw new Error(
        `${AGENT_DOMAIN_PACKAGE_NAME} dependency "${name}" is not in the agent-domain allowlist (allowed: ${AGENT_DOMAIN_DEPENDENCY_ALLOWLIST.join(", ")})`,
      );
    }
    names.push(name);
  }

  return names.sort();
}

export function assertNoForbiddenIo(sources) {
  if (!Array.isArray(sources)) {
    throw new Error("agent-domain source list must be an array of source files");
  }
  if (sources.length === 0) {
    throw new Error("found no agent-domain source files to inspect");
  }

  for (const [index, entry] of sources.entries()) {
    const source = normalizeSourceEntry(entry, index);
    if (typeof source.text !== "string") {
      throw new Error(`agent-domain source ${source.path} is unreadable`);
    }
    const findings = findForbiddenIoReferences(source.text);
    if (findings.length > 0) {
      throw new Error(
        `agent-domain source ${source.path} references forbidden I/O module(s): ${findings.join(", ")}`,
      );
    }
  }

  return sources.length;
}

export function assertAgentDomainBoundary(metadata, sources) {
  const packageEntry = selectAgentDomainPackage(metadata);
  const dependencies = assertDependencyAllowlist(packageEntry);
  const sourceFileCount = assertNoForbiddenIo(sources);

  return {
    package: packageEntry.name,
    version: packageEntry.version === undefined ? "unknown" : String(packageEntry.version),
    manifestPath: toPosixPath(packageEntry.manifest_path ?? ""),
    dependencies,
    sourceFileCount,
  };
}

function collectRustSources(directory, repoRoot, files) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    throw new Error(`unable to read agent-domain source directory ${directory}: ${cause.message}`);
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRustSources(fullPath, repoRoot, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".rs")) {
      continue;
    }
    let text;
    try {
      text = readFileSync(fullPath, "utf8");
    } catch (cause) {
      throw new Error(`unable to read agent-domain source file ${fullPath}: ${cause.message}`);
    }
    files.push({ path: toPosixPath(path.relative(repoRoot, fullPath)), text });
  }

  return files;
}

export function readAgentDomainSources(repoRoot = process.cwd()) {
  const sourceDirectory = path.join(repoRoot, AGENT_DOMAIN_SOURCE_RELATIVE_DIR);
  const files = collectRustSources(sourceDirectory, repoRoot, []);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

/**
 * Reads the declared normal dependency names from a Cargo manifest. Dev and
 * build dependencies are deliberately excluded: only normal dependencies reach
 * the compiled domain library.
 */
export function parseManifestDependencyNames(manifestText) {
  if (typeof manifestText !== "string") {
    throw new Error("agent-domain manifest text must be a string");
  }

  const names = new Set();
  let inNormalDependencies = false;

  for (const rawLine of manifestText.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("[")) {
      const header = line.replace(/^\[+/, "").replace(/\]+$/, "").trim();
      const subTable = /^(?:target\..+\.)?dependencies\.([A-Za-z0-9_.-]+)$/.exec(header);
      if (subTable !== null) {
        names.add(subTable[1]);
        inNormalDependencies = false;
        continue;
      }
      inNormalDependencies = /^(?:target\..+\.)?dependencies$/.test(header);
      continue;
    }
    if (!inNormalDependencies) {
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*(?:\.[A-Za-z0-9_-]+\s*)*=/.exec(line);
    if (assignment !== null) {
      names.add(assignment[1]);
    }
  }

  return [...names].sort();
}

function stripTomlComment(rawLine) {
  let inString = false;
  for (let index = 0; index < rawLine.length; index += 1) {
    const character = rawLine[index];
    if (character === '"' && rawLine[index - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (character === "#" && !inString) {
      return rawLine.slice(0, index);
    }
  }
  return rawLine;
}

export function formatPurityReport(report) {
  return [
    `agent-domain purity gate inspected ${report.package} ${report.version} (${report.manifestPath})`,
    `allowed direct dependencies: ${report.dependencies.join(", ")}`,
    `scanned ${report.sourceFileCount} source file${report.sourceFileCount === 1 ? "" : "s"} for forbidden I/O modules (${FORBIDDEN_MODULE_PATHS.join(", ")})`,
    "this gate proves the dependency boundary and forbidden imports only; it does not prove live behavior or adapter purity",
  ].join("\n");
}

export function runPurityGate({
  spawn = spawnSync,
  readSources = readAgentDomainSources,
  log = console.log,
  cwd = process.cwd(),
} = {}) {
  const result = spawn("cargo", [...CARGO_METADATA_ARGS], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result === null || typeof result !== "object") {
    throw new Error("cargo metadata failed: the metadata command returned no result");
  }
  if (result.error) {
    throw new Error(`cargo metadata failed to launch: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed with exit status ${result.status}: ${String(result.stderr ?? "").trim()}`,
    );
  }

  let metadata;
  try {
    metadata = JSON.parse(String(result.stdout));
  } catch (cause) {
    throw new Error(`cargo metadata produced invalid JSON: ${cause.message}`);
  }

  const sources = readSources(cwd);
  const report = assertAgentDomainBoundary(metadata, sources);
  log(formatPurityReport(report));
  return report;
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runPurityGate();
  } catch (error) {
    console.error(`agent-domain purity gate failed: ${error.message}`);
    process.exit(1);
  }
}
