import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESIDUE_SCRIPT = path.join(REPO_ROOT, "scripts", "check-legacy-domain-residue.sh");
const PURITY_SCRIPT = path.join(REPO_ROOT, "scripts", "check-agent-domain-purity.sh");
const SEARCH_ROOTS = ["agent", "packages", "apps"];

const temporaryDirectories = [];

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cleanTree() {
  const root = temporaryDirectory("viva-residue-clean-");
  for (const searchRoot of SEARCH_ROOTS) {
    mkdirSync(path.join(root, searchRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(root, searchRoot, "src", "main.rs"),
      "fn main() {\n    println!(\"study session ready\");\n}\n",
    );
  }
  return root;
}

function plant(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function stubBinDirectory(name, script) {
  const directory = temporaryDirectory("viva-shell-gate-bin-");
  if (name) {
    const executable = path.join(directory, name);
    writeFileSync(executable, script);
    chmodSync(executable, 0o755);
  }
  return directory;
}

function runShellGate(script, { cwd, env }) {
  return spawnSync("/bin/sh", [script], {
    cwd,
    env,
    encoding: "utf8",
  });
}

function runResidueGate({ cwd, env = { ...process.env } }) {
  return runShellGate(RESIDUE_SCRIPT, { cwd, env });
}

test("legacy residue gate fails closed when rg is missing", () => {
  const emptyBin = stubBinDirectory(null, "");

  const result = runResidueGate({ cwd: cleanTree(), env: { PATH: emptyBin } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rg is required/);
});

test("legacy residue gate propagates an rg exit status greater than 1", () => {
  const failingRg = stubBinDirectory(
    "rg",
    '#!/bin/sh\necho "rg: unable to traverse input" >&2\nexit 2\n',
  );

  const result = runResidueGate({
    cwd: cleanTree(),
    env: { ...process.env, PATH: `${failingRg}${path.delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /rg failed with exit status 2/);
});

test("legacy residue gate treats rg exit 1 as a clean tree", () => {
  const noMatchRg = stubBinDirectory("rg", "#!/bin/sh\nexit 1\n");

  const result = runResidueGate({
    cwd: cleanTree(),
    env: { ...process.env, PATH: `${noMatchRg}${path.delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 0);
});

test("legacy residue gate fails on a planted residue token and prints the match", () => {
  const root = cleanTree();
  plant(root, "agent/src/legacy.rs", "// start_cook was the old entrypoint\nfn recipe() {}\n");

  const result = runResidueGate({ cwd: root });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent\/src\/legacy\.rs/);
  assert.match(result.stderr, /start_cook/);
});

test("legacy residue gate scans every shipped search root", () => {
  for (const [searchRoot, token] of [
    ["agent", "Chef Luca"],
    ["packages", "LUCA_PROMPT"],
    ["apps", "CookingSession"],
  ]) {
    const root = cleanTree();
    plant(root, path.join(searchRoot, "src", "residue.ts"), `export const marker = "${token}";\n`);

    const result = runResidueGate({ cwd: root });

    assert.equal(result.status, 1, `${searchRoot} residue must fail the gate`);
    assert.match(result.stderr, new RegExp(token.replace(/\s/g, "\\s")));
  }
});

test("legacy residue gate ignores build output and unshipped directories", () => {
  const root = cleanTree();
  plant(root, "agent/target/debug/build.rs", "// pantry ingredient allergen\n");
  plant(root, "docs/superpowers/plans/old-plan.md", "Chef Luca cooking recipe pantry\n");

  const result = runResidueGate({ cwd: root });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /passed/);
});

test("legacy residue gate fails closed when a search root cannot be traversed", () => {
  const root = cleanTree();
  rmSync(path.join(root, "apps"), { recursive: true, force: true });

  const result = runResidueGate({ cwd: root });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /apps/);
});

test("purity entrypoint fails closed when node is missing", () => {
  const emptyBin = stubBinDirectory(null, "");

  const result = runShellGate(PURITY_SCRIPT, { cwd: REPO_ROOT, env: { PATH: emptyBin } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node is required/);
});

test("shell gates never swallow a tool failure with an unconditional truth", () => {
  for (const script of [RESIDUE_SCRIPT, PURITY_SCRIPT]) {
    const source = readFileSync(script, "utf8");
    assert.ok(!source.includes("|| true"), `${script} must not contain '|| true'`);
    assert.match(source, /set -eu/);
  }
});
