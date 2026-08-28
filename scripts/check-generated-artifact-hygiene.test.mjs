import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(root, "scripts/check-generated-artifact-hygiene.sh");
const SH_BIN = "/bin/sh";

// RELEASE-001: the exact intended scan roots/pattern, pinned so a
// test-injected scope change (an added exclusion glob, a dropped root) is
// caught rather than silently narrowing what this gate protects.
const REQUIRED_IGNORED_PATHS = [
  ".next",
  ".turbo",
  "node_modules",
  "coverage",
  "out",
  "artifacts",
  "apps/web/.next",
  "apps/web/.turbo",
  "apps/web/node_modules",
  "apps/web/out",
  "packages/core/.turbo",
  "packages/core/node_modules",
  "packages/tokens/.turbo",
  "packages/tokens/node_modules",
  "packages/ui-web/.turbo",
  "packages/ui-web/node_modules",
  "agent/target",
];

const GENERATED_PATH_PATTERN =
  "(^|/)(node_modules|\\.next|\\.turbo|coverage|target|out|artifacts)(/|$)|(^|/)dist(/|$)|\\.tsbuildinfo$";

test("missing git exits non-zero with 'git is required'", () => {
  const binDir = makeStubBinDir({ includeGit: false });
  const result = runHygieneScript({ cwd: root, pathEnv: binDir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git is required/);
});

test("missing rg exits non-zero with 'rg is required'", () => {
  const binDir = makeStubBinDir({ includeRg: false });
  const result = runHygieneScript({ cwd: root, pathEnv: binDir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rg is required/);
});

test("rg exit 1 means no matches and the gate passes", () => {
  const repo = makeScratchRepo();
  try {
    const binDir = makeStubBinDir({ rgExitCode: 1 });
    const result = runHygieneScript({ cwd: repo, pathEnv: binDir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Generated artifact hygiene check passed/);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("rg exit 2 propagates as a failure, never a silent clean pass", () => {
  const repo = makeScratchRepo();
  try {
    const binDir = makeStubBinDir({ rgExitCode: 2 });
    const result = runHygieneScript({ cwd: repo, pathEnv: binDir });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /passed/);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

// A stub that only misbehaves for one of the two rg invocations (keyed on
// which temp file it is scanning) so a fix applied to only one of the two
// duplicated exit-status guards cannot hide behind the other one still being
// correct. Parameterized across BOTH scans: a single stub that only ever
// misbehaves for one side (e.g. always exits 1, "no matches", for the other)
// necessarily leaves the untargeted guard's own status at 1 -- inside its own
// accepted range -- so it can never observably fail regardless of whether
// that guard is correct or itself silently widened. Each iteration below is
// therefore the only way to prove its own named guard, and not the other one
// still being correct, is what makes the overall run fail.
for (const targetFile of ["tracked-files", "diff-files"]) {
  test(`the ${targetFile} scan's own rg exit 2 propagates independently, not just when both scans happen to fail alike`, () => {
    const repo = makeScratchRepo();
    try {
      const rgScript = [
        "#!/bin/sh",
        'file="$2"',
        'case "$file" in',
        `  */${targetFile}) exit 2 ;;`,
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n");
      const binDir = makeStubBinDir({ rgScript });
      const result = runHygieneScript({ cwd: repo, pathEnv: binDir });
      assert.equal(result.status, 2, `the ${targetFile} scan's own rg exit 2 must propagate on its own`);
      assert.doesNotMatch(result.stdout, /passed/);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });
}

for (const subcommand of ["ls-files", "diff", "diff-cached"]) {
  test(`git ${subcommand} failure propagates and cannot become an empty match set`, () => {
    const repo = makeScratchRepo();
    try {
      const realGit = resolveOnPath("git");
      const gitScript = [
        "#!/bin/sh",
        'if [ "$1" = "diff" ] && [ "$2" = "--cached" ]; then probe="diff-cached"; else probe="$1"; fi',
        `if [ "$probe" = "${subcommand}" ]; then`,
        `  echo "stub git: simulated failure for ${subcommand}" >&2`,
        "  exit 7",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n");
      const binDir = makeStubBinDir({ gitScript });
      const result = runHygieneScript({ cwd: repo, pathEnv: binDir });
      assert.notEqual(result.status, 0, "a git failure must not be swallowed into a clean pass");
      assert.doesNotMatch(result.stdout, /passed/);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });
}

test("a real generated path still fails with its current diagnostic", () => {
  // `dist` is matched by generated_path_pattern but is deliberately not one
  // of required_ignored_paths' own roots, so this exercises the
  // tracked/diff scan itself rather than the separate ignore pre-check.
  // (A path under one of the required_ignored_paths roots, e.g.
  // node_modules, cannot be used here: once any file beneath it is
  // force-tracked, `git check-ignore` genuinely reports the directory
  // itself as no longer ignored, which is real git behavior unrelated to
  // this gate and would trip the earlier, unrelated ignore pre-check.)
  const repo = makeScratchRepo();
  try {
    const distDir = path.join(repo, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, "bundle.js"), "// built\n");
    runSetup("git", ["add", "-f", "dist/bundle.js"], repo);
    const binDir = makeStubBinDir();
    const result = runHygieneScript({ cwd: repo, pathEnv: binDir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Generated artifact paths are tracked:/);
    assert.match(result.stderr, /dist\/bundle\.js/);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("the hygiene gate scans exactly its intended generated-path pattern and required-ignored-path roots", () => {
  const source = readFileSync(scriptPath, "utf8");

  const patternMatch = source.match(/generated_path_pattern='([^']*)'/);
  assert.ok(patternMatch, "generated_path_pattern must be a single-quoted literal");
  assert.equal(
    patternMatch[1],
    GENERATED_PATH_PATTERN,
    "the intended generated-path pattern must not silently narrow or widen",
  );

  const requiredBlockMatch = source.match(/required_ignored_paths="\n([\s\S]*?)\n"/);
  assert.ok(requiredBlockMatch, "required_ignored_paths must be a literal newline-delimited block");
  const actualPaths = requiredBlockMatch[1].split("\n").filter(Boolean);
  assert.deepEqual(
    actualPaths,
    REQUIRED_IGNORED_PATHS,
    "the required-ignored-paths root list must not silently drop or add a root",
  );
});

function resolveOnPath(name) {
  const result = spawnSync(SH_BIN, ["-c", `command -v ${name}`], { encoding: "utf8" });
  const resolved = result.stdout.trim();
  if (!resolved) throw new Error(`test setup: ${name} not found on PATH`);
  return resolved;
}

function makeStubBinDir({
  includeGit = true,
  includeRg = true,
  gitScript = null,
  rgScript = null,
  rgExitCode = null,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "viva-hygiene-bin-"));
  for (const util of ["mktemp", "sort", "cat", "rm"]) {
    symlinkSync(resolveOnPath(util), path.join(dir, util));
  }
  if (includeGit) {
    if (gitScript) {
      writeFileSync(path.join(dir, "git"), gitScript);
      chmodSync(path.join(dir, "git"), 0o755);
    } else {
      symlinkSync(resolveOnPath("git"), path.join(dir, "git"));
    }
  }
  if (includeRg) {
    if (rgScript) {
      writeFileSync(path.join(dir, "rg"), rgScript);
      chmodSync(path.join(dir, "rg"), 0o755);
    } else if (rgExitCode !== null) {
      writeFileSync(path.join(dir, "rg"), `#!/bin/sh\nexit ${rgExitCode}\n`);
      chmodSync(path.join(dir, "rg"), 0o755);
    } else {
      symlinkSync(resolveOnPath("rg"), path.join(dir, "rg"));
    }
  }
  return dir;
}

function makeScratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "viva-hygiene-repo-"));
  runSetup("git", ["init", "-q"], dir);
  runSetup("git", ["config", "user.email", "hygiene-test@example.com"], dir);
  runSetup("git", ["config", "user.name", "Hygiene Test"], dir);
  writeFileSync(path.join(dir, ".gitignore"), `${REQUIRED_IGNORED_PATHS.join("\n")}\n`);
  writeFileSync(path.join(dir, "README.md"), "hygiene fixture\n");
  runSetup("git", ["add", ".gitignore", "README.md"], dir);
  runSetup("git", ["commit", "-q", "-m", "init"], dir);
  return dir;
}

function runSetup(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `test setup command failed: ${bin} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function runHygieneScript({ cwd, pathEnv }) {
  return spawnSync(SH_BIN, [scriptPath], { cwd, encoding: "utf8", env: { PATH: pathEnv } });
}
