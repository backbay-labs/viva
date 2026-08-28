/**
 * `RELEASE-024` — the executable dependency policy.
 *
 * This file is the acceptance gate for Plan 12 Task 14: it pins the exact
 * manifest versions the plan names, proves the resolved `bun.lock` actually
 * carries the remediated transitive versions, proves the Rust lock carries the
 * patched advisory versions, and proves the unused SQLx driver path is outside
 * the feature-resolved build graph.
 *
 * Two recorded deviations from the plan text, both escalated in the unit report:
 *
 * 1. The plan pins root `yaml` to exactly `2.8.2`. Advisory
 *    GHSA-48c2-rrv3-qjmp (published after the plan was authored) makes every
 *    `yaml >=2.0.0 <2.8.3` vulnerable, and the plan's own rule is "do not use a
 *    permanent audit ignore". The pin is therefore the patched `2.8.3`, still
 *    exact, so Plan 06's semantic workflow/domain policy tests keep a pinned
 *    YAML parser.
 * 2. The plan asserts `rsa`, `sqlx-mysql`, and `sqlx-sqlite` are "absent from
 *    `agent/Cargo.lock`". `Cargo.lock` is feature-agnostic — it records every
 *    optional dependency of every resolved package whether or not a feature
 *    activates it — so no manifest edit available to any lane can remove those
 *    names from the lock (proof:
 *    `artifacts/sdd/evidence/task-14-cargo-lock-superset-proof.txt`). The
 *    security property the plan is after is asserted directly instead: the
 *    MySQL/SQLite driver path is absent from the feature-resolved dependency
 *    graph for every target, so none of it is ever compiled or shipped.
 * 3. Deviation 2 leaves exactly one residual: `cargo audit` still denies
 *    RUSTSEC-2023-0071 (`rsa` 0.9.10, no fixed upgrade), reachable only
 *    through the never-compiled MySQL path. The plan's Task 14 Step 5 says
 *    "Do not add an ignore for the unfixed RSA advisory" — written on the
 *    false premise that the MySQL path could be pruned from the lock. Escalated
 *    as blocker B-1 (`artifacts/sdd/ledger.md`); ratified by coordinator
 *    amendment A-33 (`docs/decisions/2026-08-23-plan-amendments.md`), which
 *    supersedes that line on the falsified premise and requires exactly this: a
 *    scoped `cargo-audit` ignore of RUSTSEC-2023-0071 co-located with a comment
 *    citing the absence proof, kept honest by the build-graph test below and
 *    the exact-single-entry pin that follows it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** Advisory floors this policy refuses to resolve below. */
const RESOLVED_JS_FLOORS = Object.freeze({
  postcss: "8.5.23",
  nanoid: "3.3.16",
  sharp: "0.35.3",
});

/** Advisory floors for the Rust lock, from Plan 12 Task 14 Step 2. */
const RESOLVED_RUST_FLOORS = Object.freeze({
  "quinn-proto": "0.11.17",
  anyhow: "1.0.104",
  "event-listener": "5.4.2",
});

/**
 * SQLx driver crates that must never enter the compiled graph. The lockfile
 * carries their names as an unavoidable feature-agnostic superset; the build
 * graph is the surface that matters and the one this policy gates.
 */
const FORBIDDEN_BUILD_GRAPH_CRATES = Object.freeze(["sqlx-mysql", "sqlx-sqlite", "rsa", "flume"]);

/**
 * A-33: the exact, and only, cargo-audit advisory this workspace may scope
 * out. Any second entry would silently widen a decision the coordinator
 * ratified for this one unfixable advisory alone.
 */
const PERMITTED_AUDIT_IGNORE_IDS = Object.freeze(["RUSTSEC-2023-0071"]);

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), "utf8"));
}

async function readText(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

function compareSemver(left, right) {
  const parse = (value) => value.split(".").map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) - (b[index] ?? 0);
    }
  }
  return 0;
}

/** Every version `bun.lock` resolved for a package name, in file order. */
function lockedJsVersions(lockText, name) {
  const pattern = new RegExp(
    `"(?:[^"]*/)?${name.replace(/[/@.-]/g, "\\$&")}"\\s*:\\s*\\[\\s*"${name.replace(
      /[/@.-]/g,
      "\\$&",
    )}@(\\d+\\.\\d+\\.\\d+[^"]*)"`,
    "g",
  );
  const found = [];
  for (const match of lockText.matchAll(pattern)) {
    found.push(match[1]);
  }
  return found;
}

/** Every version `agent/Cargo.lock` resolved for a crate name. */
function lockedRustVersions(lockText, name) {
  const pattern = new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`, "g");
  const found = [];
  for (const match of lockText.matchAll(pattern)) {
    found.push(match[1]);
  }
  return found;
}

function cargoTreeInverse(crate) {
  return spawnSync(
    "cargo",
    ["tree", "--manifest-path", "agent/Cargo.toml", "-i", crate, "--target", "all"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RUSTUP_TOOLCHAIN: "1.94.1" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

test("root package.json exposes fail-closed audit scripts and validate runs them", async () => {
  const rootPackage = await readJson("package.json");
  const scripts = rootPackage.scripts ?? {};

  assert.equal(scripts["audit:js"], "bun audit");
  assert.equal(scripts["audit:rust"], "cargo audit --file agent/Cargo.lock --deny warnings");
  assert.equal(scripts.audit, "bun run audit:js && bun run audit:rust");
  assert.match(
    scripts.validate ?? "",
    /(^|&&\s*)bun run audit(\s|$)/,
    `validate must run the composite audit; got: ${scripts.validate}`,
  );
});

test("root dev dependencies carry the exact pins the program depends on", async () => {
  const rootPackage = await readJson("package.json");
  const devDependencies = rootPackage.devDependencies ?? {};

  assert.equal(devDependencies["@viva/core"], "workspace:*");

  const yamlPin = devDependencies.yaml;
  assert.match(yamlPin ?? "", EXACT_VERSION, "root yaml must be an exact pin, not a range");
  assert.ok(
    compareSemver(yamlPin, "2.8.3") >= 0,
    `root yaml must be at least 2.8.3 (GHSA-48c2-rrv3-qjmp); got ${yamlPin}`,
  );

  assert.equal(devDependencies.playwright, "1.61.0");
});

test("Node 24 imports @viva/core/runtime-validation with no loader or source-relative fallback", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const m = await import("@viva/core/runtime-validation");' +
        'if (typeof m.parseVivaServerFrame !== "function") process.exit(2);',
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS"),
      ),
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("bun.lock resolves @viva/core as the local workspace package", async () => {
  const lockText = await readText("bun.lock");
  assert.match(lockText, /"@viva\/core":\s*\["@viva\/core@workspace:packages\/core"\]/);
});

test("apps/web pins Next and the mounted DOM runtime exactly", async () => {
  const webPackage = await readJson("apps/web/package.json");

  assert.equal(webPackage.dependencies?.next, "16.3.2");
  assert.equal(webPackage.devDependencies?.["happy-dom"], "20.11.6");
  assert.equal(webPackage.devDependencies?.["@happy-dom/global-registrator"], "20.11.6");
});

test("bun.lock resolves the remediated JavaScript versions", async () => {
  const lockText = await readText("bun.lock");

  const nextVersions = lockedJsVersions(lockText, "next");
  assert.deepEqual([...new Set(nextVersions)], ["16.3.2"], `resolved next: ${nextVersions}`);

  for (const [name, floor] of Object.entries(RESOLVED_JS_FLOORS)) {
    const resolved = lockedJsVersions(lockText, name);
    assert.ok(resolved.length > 0, `${name} must be resolved in bun.lock`);
    for (const version of resolved) {
      assert.ok(
        compareSemver(version, floor) >= 0,
        `${name}@${version} is below the advisory floor ${floor}`,
      );
    }
  }

  for (const name of ["happy-dom", "@happy-dom/global-registrator"]) {
    const resolved = lockedJsVersions(lockText, name);
    assert.deepEqual([...new Set(resolved)], ["20.11.6"], `resolved ${name}: ${resolved}`);
  }
});

test("the workspace SQLx declaration is Postgres-only", async () => {
  const manifest = await readText("agent/Cargo.toml");
  const declaration = manifest.match(/^sqlx = \{[^\n]*\}$/m)?.[0];
  assert.ok(declaration, "agent/Cargo.toml must declare a workspace sqlx dependency");

  const features = [...declaration.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);
  for (const required of [
    "runtime-tokio",
    "tls-rustls",
    "postgres",
    "uuid",
    "chrono",
    "json",
    "migrate",
  ]) {
    assert.ok(features.includes(required), `sqlx must enable ${required}; got ${features}`);
  }
  for (const forbidden of ["mysql", "sqlite", "any"]) {
    assert.equal(
      features.includes(forbidden),
      false,
      `sqlx must not enable the ${forbidden} driver feature`,
    );
  }
});

test("the recorded D-04 CONFIRM_DELETE branch and agent-domain's manifest agree", async () => {
  const domainManifest = await readText("agent/crates/agent-domain/Cargo.toml");
  const dependencies = domainManifest.split(/^\[dev-dependencies\]$/m)[0];

  // A-16.2: `chrono.workspace` is NOT a D-04 signal — Plan 03's D-01 scheduling
  // seam declares it under CONFIRM_DELETE too. `uuid.workspace` is the signal.
  assert.equal(
    /^uuid\.workspace\s*=\s*true$/m.test(dependencies),
    false,
    "uuid must be absent from agent-domain under D-04 CONFIRM_DELETE",
  );

  // The CONFIRM_DELETE branch is proven in-tree by the compile-fail absence
  // suite; SOFT_DELETE_UNDO would have deleted these files instead.
  const compileFail = await readText("agent/crates/agent-domain/tests/compile_fail.rs");
  assert.match(compileFail, /d04_restore_types_absent\.rs/);
  assert.match(compileFail, /d04_restore_methods_absent\.rs/);
});

test("cargo-udeps stays required under either D-04 branch and carries no allowlist", async () => {
  const rootPackage = await readJson("package.json");
  const unusedDependencyCommand = rootPackage.scripts?.["agent:deps:unused"];

  // `RELEASE-027` owns adding this command. Whenever it exists it must be the
  // unfiltered workspace proof — no branch may waive or narrow it.
  if (unusedDependencyCommand !== undefined) {
    assert.match(unusedDependencyCommand, /\budeps\b/);
    assert.match(unusedDependencyCommand, /--workspace/);
    assert.match(unusedDependencyCommand, /--all-targets/);
    assert.doesNotMatch(unusedDependencyCommand, /--exclude|--allow|ignore/i);
  }
});

test("agent/Cargo.lock carries the patched advisory versions", async () => {
  const lockText = await readText("agent/Cargo.lock");

  for (const [name, floor] of Object.entries(RESOLVED_RUST_FLOORS)) {
    const resolved = lockedRustVersions(lockText, name);
    assert.ok(resolved.length > 0, `${name} must be present in agent/Cargo.lock`);
    for (const version of resolved) {
      assert.ok(
        compareSemver(version, floor) >= 0,
        `${name} ${version} is below the advisory floor ${floor}`,
      );
    }
  }
});

test("the unused SQLx driver path never enters the compiled dependency graph", () => {
  for (const crate of FORBIDDEN_BUILD_GRAPH_CRATES) {
    const result = cargoTreeInverse(crate);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      "",
      `${crate} is compiled into the workspace:\n${result.stdout}`,
    );
  }
});

test("the cargo-audit ignore list scopes exactly the unfixable RSA advisory", async () => {
  const configText = await readText(".cargo/audit.toml");

  const advisoriesSection = configText.match(/^\[advisories\]\n([\s\S]*?)(?=\n\[|$)/m)?.[1];
  assert.ok(advisoriesSection, ".cargo/audit.toml must declare an [advisories] table");

  const ignoreList = advisoriesSection.match(/^ignore\s*=\s*\[([^\]]*)\]/m)?.[1];
  assert.ok(
    ignoreList !== undefined,
    ".cargo/audit.toml [advisories] must declare an ignore = [...] list",
  );

  const ignoredIds = [...ignoreList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    ignoredIds,
    [...PERMITTED_AUDIT_IGNORE_IDS],
    `the audit ignore list must contain exactly ${JSON.stringify(PERMITTED_AUDIT_IGNORE_IDS)} ` +
      `(A-33); a second or substitute entry would silently widen a decision ` +
      `ratified for this one unfixable advisory alone — got ${JSON.stringify(ignoredIds)}`,
  );
});
