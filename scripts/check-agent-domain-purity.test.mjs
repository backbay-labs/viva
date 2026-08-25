import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_DOMAIN_BASE_DEPENDENCIES,
  AGENT_DOMAIN_CONDITIONAL_DEPENDENCIES,
  AGENT_DOMAIN_DEPENDENCY_ALLOWLIST,
  AGENT_DOMAIN_MANIFEST_RELATIVE_PATH,
  AGENT_DOMAIN_REVIEW_SCHEDULING_DEPENDENCIES,
  AGENT_DOMAIN_SOURCE_RELATIVE_DIR,
  assertAgentDomainBoundary,
  formatPurityReport,
  parseManifestDependencyNames,
  readAgentDomainSources,
  runPurityGate,
} from "./check-agent-domain-purity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";

function dependency(name, overrides = {}) {
  return {
    name,
    source: REGISTRY_SOURCE,
    req: "^1",
    kind: null,
    rename: null,
    optional: false,
    uses_default_features: true,
    features: [],
    target: null,
    registry: null,
    ...overrides,
  };
}

function metadataWithDependencies(dependencies, packageOverrides = {}) {
  return {
    packages: [
      {
        name: "agent-domain",
        version: "0.1.0",
        manifest_path: `${REPO_ROOT}/${AGENT_DOMAIN_MANIFEST_RELATIVE_PATH}`,
        dependencies,
        ...packageOverrides,
      },
      {
        name: "agent-service",
        version: "0.1.0",
        manifest_path: `${REPO_ROOT}/agent/crates/agent-service/Cargo.toml`,
        dependencies: [
          dependency("axum"),
          dependency("agent-domain", { source: null, path: "/x" }),
        ],
      },
    ],
    workspace_members: [],
  };
}

const cleanMetadata = metadataWithDependencies(
  AGENT_DOMAIN_BASE_DEPENDENCIES.map((name) => dependency(name)),
);

function metadataWithDependency(name, overrides = {}) {
  return metadataWithDependencies([
    ...AGENT_DOMAIN_BASE_DEPENDENCIES.map((allowed) => dependency(allowed)),
    dependency(name, overrides),
  ]);
}

const cleanSources = [
  { path: "agent/crates/agent-domain/src/lib.rs", text: "pub mod brain;\npub mod ports;\n" },
  {
    path: "agent/crates/agent-domain/src/brain.rs",
    text: "use serde::{Deserialize, Serialize};\nuse tokio::{sync::mpsc, task::AbortHandle};\n",
  },
];

test("accepts the checked-in domain dependency allowlist and clean sources", () => {
  const report = assertAgentDomainBoundary(cleanMetadata, cleanSources);

  assert.equal(report.package, "agent-domain");
  assert.equal(report.version, "0.1.0");
  assert.deepEqual(report.dependencies, [...AGENT_DOMAIN_BASE_DEPENDENCIES].sort());
  assert.equal(report.sourceFileCount, 2);
});

test("rejects an infrastructure dependency", () => {
  assert.throws(
    () => assertAgentDomainBoundary(metadataWithDependency("reqwest"), cleanSources),
    /reqwest.*not in the agent-domain allowlist/,
  );
});

test("rejects every named infrastructure dependency, not only reqwest", () => {
  for (const name of ["sqlx", "axum", "tokio-tungstenite", "hyper", "rustls", "dotenvy"]) {
    assert.throws(
      () => assertAgentDomainBoundary(metadataWithDependency(name), cleanSources),
      new RegExp(`${name}.*not in the agent-domain allowlist`),
    );
  }
});

test("recognizes chrono and uuid as pure validation dependencies", () => {
  assert.deepEqual([...AGENT_DOMAIN_CONDITIONAL_DEPENDENCIES], ["chrono", "uuid"]);
  assert.deepEqual(
    [...AGENT_DOMAIN_DEPENDENCY_ALLOWLIST].sort(),
    [
      ...AGENT_DOMAIN_BASE_DEPENDENCIES,
      ...AGENT_DOMAIN_REVIEW_SCHEDULING_DEPENDENCIES,
      ...AGENT_DOMAIN_CONDITIONAL_DEPENDENCIES,
    ].sort(),
  );

  const report = assertAgentDomainBoundary(
    metadataWithDependencies([
      ...AGENT_DOMAIN_BASE_DEPENDENCIES.map((name) => dependency(name)),
      ...AGENT_DOMAIN_REVIEW_SCHEDULING_DEPENDENCIES.map((name) => dependency(name)),
      ...AGENT_DOMAIN_CONDITIONAL_DEPENDENCIES.map((name) => dependency(name)),
    ]),
    cleanSources,
  );

  assert.deepEqual(report.dependencies, [...AGENT_DOMAIN_DEPENDENCY_ALLOWLIST].sort());
});

test("recognizes exactly fsrs as the sanctioned D-01 scheduling dependency", () => {
  assert.deepEqual([...AGENT_DOMAIN_REVIEW_SCHEDULING_DEPENDENCIES], ["fsrs"]);

  const report = assertAgentDomainBoundary(metadataWithDependency("fsrs"), cleanSources);
  assert.ok(report.dependencies.includes("fsrs"));

  // The seam admits one crate by name. A neighbouring scheduling library is not
  // covered by D-01 and must still be rejected.
  for (const name of ["fsrs-optimizer", "rs-fsrs", "supermemo2"]) {
    assert.throws(
      () => assertAgentDomainBoundary(metadataWithDependency(name), cleanSources),
      new RegExp(`${name}.*not in the agent-domain allowlist`),
    );
  }
});

test("rejects a path dependency even when it borrows an allowlisted crate name", () => {
  assert.throws(
    () =>
      assertAgentDomainBoundary(
        metadataWithDependency("serde", {
          source: null,
          path: `${REPO_ROOT}/agent/crates/data`,
        }),
        cleanSources,
      ),
    /serde.*path dependency/,
  );

  assert.throws(
    () =>
      assertAgentDomainBoundary(
        metadataWithDependency("data", { source: null, path: `${REPO_ROOT}/agent/crates/data` }),
        cleanSources,
      ),
    /data.*path dependency/,
  );
});

test("ignores dev and build dependencies when enforcing the normal allowlist", () => {
  const report = assertAgentDomainBoundary(
    metadataWithDependencies([
      ...AGENT_DOMAIN_BASE_DEPENDENCIES.map((name) => dependency(name)),
      dependency("trybuild", { kind: "dev" }),
      dependency("proptest", { kind: "dev" }),
      dependency("cc", { kind: "build" }),
    ]),
    cleanSources,
  );

  assert.deepEqual(report.dependencies, [...AGENT_DOMAIN_BASE_DEPENDENCIES].sort());
});

test("rejects direct I/O imports", () => {
  for (const source of [
    "use std::fs::File;",
    "use std::net::TcpStream;",
    "use std::{fs, net};",
    "use tokio::{net::TcpStream, fs};",
    "use std::process::{Command, Stdio};",
    "tokio::net::TcpStream::connect(addr).await;",
    'std::process::Command::new("curl");',
  ]) {
    assert.throws(() => assertAgentDomainBoundary(cleanMetadata, [source]), /forbidden I\/O/);
  }
});

test("rejects every forbidden tokio runtime module", () => {
  for (const source of [
    "use tokio::fs::File;",
    "use tokio::process::Command;",
    "use tokio::signal::ctrl_c;",
    "use tokio::signal;",
    "use tokio::{signal, sync::mpsc};",
    "use std::{sync::Arc, fs::File};",
    "use std::net::{TcpListener, TcpStream};",
    "let listener = std::net::TcpListener::bind(addr)?;",
    "tokio::fs::read_to_string(path).await?;",
    "use std::fs as filesystem;",
    "use tokio::net::{self, TcpStream};",
  ]) {
    assert.throws(() => assertAgentDomainBoundary(cleanMetadata, [source]), /forbidden I\/O/);
  }
});

test("permits tokio channel and task imports the domain legitimately uses", () => {
  const permitted = [
    "use tokio::{sync::mpsc, task::AbortHandle};",
    "use tokio::sync::{broadcast, mpsc, oneshot};",
    "use tokio::task::JoinHandle;",
    "use tokio::time::Duration;",
    "use std::{fmt, sync::Arc, time::Duration};",
    "use futures_util::{stream::BoxStream, StreamExt};",
    "let (sender, receiver) = tokio::sync::mpsc::channel(8);",
  ];

  const report = assertAgentDomainBoundary(
    cleanMetadata,
    permitted.map((text, index) => ({ path: `src/permitted-${index}.rs`, text })),
  );

  assert.equal(report.sourceFileCount, permitted.length);
});

test("names the offending source file and module in the violation message", () => {
  assert.throws(
    () =>
      assertAgentDomainBoundary(cleanMetadata, [
        ...cleanSources,
        { path: "agent/crates/agent-domain/src/ports.rs", text: "use std::{fs, net};\n" },
      ]),
    (error) => {
      assert.match(error.message, /forbidden I\/O/);
      assert.match(error.message, /agent\/crates\/agent-domain\/src\/ports\.rs/);
      assert.match(error.message, /std::fs/);
      return true;
    },
  );
});

test("rejects a renamed, missing, or duplicated agent-domain package", () => {
  const renamed = metadataWithDependencies(
    AGENT_DOMAIN_BASE_DEPENDENCIES.map((name) => dependency(name)),
    { name: "agent-core" },
  );
  assert.throws(
    () => assertAgentDomainBoundary(renamed, cleanSources),
    /exactly one agent-domain package/,
  );

  const duplicated = {
    packages: [...cleanMetadata.packages, cleanMetadata.packages[0]],
  };
  assert.throws(
    () => assertAgentDomainBoundary(duplicated, cleanSources),
    /exactly one agent-domain package/,
  );

  assert.throws(() => assertAgentDomainBoundary({}, cleanSources), /packages/);
});

test("rejects an agent-domain package relocated away from its checked-in manifest path", () => {
  const relocated = metadataWithDependencies(
    AGENT_DOMAIN_BASE_DEPENDENCIES.map((name) => dependency(name)),
    { manifest_path: `${REPO_ROOT}/agent/crates/agent-kitchen/Cargo.toml` },
  );

  assert.throws(
    () => assertAgentDomainBoundary(relocated, cleanSources),
    /manifest path/,
  );
});

test("rejects an unreadable source file instead of skipping it", () => {
  assert.throws(
    () =>
      assertAgentDomainBoundary(cleanMetadata, [
        ...cleanSources,
        { path: "agent/crates/agent-domain/src/ports.rs", text: null },
      ]),
    /unreadable/,
  );

  assert.throws(() => assertAgentDomainBoundary(cleanMetadata, []), /no agent-domain source files/);
  assert.throws(() => assertAgentDomainBoundary(cleanMetadata, "not-an-array"), /source list/);
});

test("cargo metadata failure is a gate failure", () => {
  const failingSpawn = () => ({
    status: 101,
    stdout: "",
    stderr: "error: could not read manifest",
  });

  assert.throws(() => runPurityGate({ spawn: failingSpawn }), /cargo metadata failed/);
});

test("a cargo binary that cannot launch is a gate failure", () => {
  const missingSpawn = () => ({
    status: null,
    stdout: "",
    stderr: "",
    error: new Error("spawnSync cargo ENOENT"),
  });

  assert.throws(() => runPurityGate({ spawn: missingSpawn }), /cargo metadata failed/);
});

test("invalid cargo metadata JSON is a gate failure", () => {
  const garbageSpawn = () => ({ status: 0, stdout: "not json", stderr: "" });

  assert.throws(() => runPurityGate({ spawn: garbageSpawn }), /invalid JSON/);
});

test("the gate runs the pinned no-deps cargo metadata command and reports its inspection", () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: JSON.stringify(cleanMetadata), stderr: "" };
  };
  const lines = [];

  const report = runPurityGate({
    spawn,
    readSources: () => cleanSources,
    log: (line) => lines.push(line),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "cargo");
  assert.deepEqual(calls[0].args, [
    "metadata",
    "--manifest-path",
    "agent/Cargo.toml",
    "--format-version",
    "1",
    "--no-deps",
  ]);
  assert.deepEqual(report.dependencies, [...AGENT_DOMAIN_BASE_DEPENDENCIES].sort());
  assert.equal(report.sourceFileCount, 2);

  const output = lines.join("\n");
  assert.match(output, /agent-domain/);
  assert.match(output, /serde_json/);
  assert.match(output, /2 source file/);
  assert.equal(formatPurityReport(report), output);
});

test("the gate propagates a source-read failure rather than passing empty", () => {
  const spawn = () => ({ status: 0, stdout: JSON.stringify(cleanMetadata), stderr: "" });
  const readSources = () => {
    throw new Error("unable to read agent-domain source directory");
  };

  assert.throws(() => runPurityGate({ spawn, readSources, log: () => {} }), /unable to read/);
});

test("manifest dependency parsing sees normal dependencies only", () => {
  const manifest = [
    "[package]",
    'name = "agent-domain"',
    "",
    "[dependencies]",
    "async-trait.workspace = true",
    'serde = { version = "1.0", features = ["derive"] }',
    "# chrono.workspace = true",
    "",
    "[dev-dependencies]",
    'trybuild = "1"',
    'proptest = "1"',
    "",
    "[dependencies.uuid]",
    "workspace = true",
    "",
    "[lints]",
    "workspace = true",
  ].join("\n");

  assert.deepEqual(parseManifestDependencyNames(manifest), ["async-trait", "serde", "uuid"]);
  assert.throws(() => parseManifestDependencyNames(null), /manifest/);
});

test("D-04 CONFIRM_DELETE keeps uuid out of the domain manifest", () => {
  const manifestText = readFileSync(
    path.join(REPO_ROOT, AGENT_DOMAIN_MANIFEST_RELATIVE_PATH),
    "utf8",
  );
  const declared = parseManifestDependencyNames(manifestText);

  // The exact declared set, so a new dependency cannot arrive unnoticed: the
  // always-needed base, plus the recorded `D-01 SERVER_PERSISTED_FSRS` seam,
  // which is `fsrs` for the algorithm and `chrono` for its UTC instants. `chrono`
  // is therefore declared under `CONFIRM_DELETE` as well, and its presence says
  // nothing about D-04.
  assert.deepEqual(
    declared,
    [
      ...AGENT_DOMAIN_BASE_DEPENDENCIES,
      ...AGENT_DOMAIN_REVIEW_SCHEDULING_DEPENDENCIES,
      "chrono",
    ].sort(),
  );

  // `uuid` is the one conditional the D-04 branch alone would add, so its absence
  // is the manifest-level half of the `CONFIRM_DELETE` absence proof.
  assert.ok(
    !declared.includes("uuid"),
    "CONFIRM_DELETE must not declare the conditional dependency uuid",
  );
});

test("the checked-in domain crate passes its own boundary", () => {
  const manifestText = readFileSync(
    path.join(REPO_ROOT, AGENT_DOMAIN_MANIFEST_RELATIVE_PATH),
    "utf8",
  );
  const sources = readAgentDomainSources(REPO_ROOT);
  const metadata = metadataWithDependencies(
    parseManifestDependencyNames(manifestText).map((name) => dependency(name)),
  );

  const report = assertAgentDomainBoundary(metadata, sources);

  assert.ok(report.sourceFileCount >= 5);
  assert.ok(
    sources.every((source) => source.path.startsWith(`${AGENT_DOMAIN_SOURCE_RELATIVE_DIR}/`)),
    "source paths must stay inside the domain source directory",
  );
  assert.ok(sources.some((source) => source.path.endsWith("/lib.rs")));
});

test("the source reader fails closed on a missing source directory", () => {
  assert.throws(
    () => readAgentDomainSources(path.join(REPO_ROOT, "scripts")),
    /unable to read agent-domain source directory/,
  );
});
