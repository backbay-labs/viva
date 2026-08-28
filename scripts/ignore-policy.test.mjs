import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * `RELEASE-027`: the dotenv ignore policy, proved by asking git itself.
 *
 * The reviewed `.gitignore` listed `.env`, `.env.local`, and `.env.*.local`
 * only at the repository root plus a single `agent/.env` line, so
 * `apps/web/.env.production`, `packages/core/.env.local`, `.envrc`, and
 * `.env.secrets` were all committable. Matching the ignore file's *source text*
 * cannot prove what git actually ignores — precedence between a pattern and a
 * later negation is a git rule, not a string property — so every assertion here
 * runs `git check-ignore --no-index -v --stdin` and reads its verdict.
 *
 * No fixture file is created anywhere: `check-ignore` classifies pathnames, so
 * the isolated fixture paths below never exist on disk and this test can never
 * leave a secret-looking file in the workspace.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A path prefix that exists in no checkout, so a fixture can never collide. */
const FIXTURE_DIR = "tmp-ignore-policy-fixture";

const IGNORED_BASENAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.test.local",
  ".envrc",
  ".env.secrets",
];

const VISIBLE_BASENAMES = [".env.example", ".env.production.example"];

/** Root plus two nested depths, so "every nested depth" is actually exercised. */
function fixturePaths(basename) {
  return [
    basename,
    `${FIXTURE_DIR}/${basename}`,
    `${FIXTURE_DIR}/nested/deeper/${basename}`,
  ];
}

function git(args, { input } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} could not run: ${result.error.message}`);
  }
  return result;
}

/**
 * Returns one verdict per requested path. `--no-index` makes the answer a pure
 * function of the ignore rules rather than of what happens to be tracked, `-v`
 * names the deciding rule, and `--non-matching` forces a line even for paths no
 * rule touches — so a missing line is a real fault, never a silent pass.
 */
function checkIgnore(paths) {
  const result = git(["check-ignore", "--no-index", "-v", "--non-matching", "--stdin"], {
    input: `${paths.join("\n")}\n`,
  });
  assert.ok(
    result.status === 0 || result.status === 1,
    `git check-ignore failed (${result.status}): ${result.stderr}`,
  );

  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, paths.length, "git must return exactly one verdict per path");

  const verdicts = new Map();
  for (const line of lines) {
    // `<source>:<line>:<pattern>\t<path>`; an unmatched path reports `::\t<path>`.
    const separator = line.lastIndexOf("\t");
    assert.ok(separator > 0, `unparsable check-ignore verdict: ${line}`);
    const decision = line.slice(0, separator);
    const subject = line.slice(separator + 1);
    const fields = decision.split(":");
    assert.equal(fields.length, 3, `ambiguous check-ignore verdict: ${line}`);
    const [source, lineNumber, pattern] = fields;
    assert.ok(!verdicts.has(subject), `git returned two verdicts for ${subject}`);
    verdicts.set(subject, { source, lineNumber, pattern });
  }
  for (const subject of paths) {
    assert.ok(verdicts.has(subject), `git returned no verdict for ${subject}`);
  }
  return verdicts;
}

test("git and git check-ignore are available, and their absence is fatal rather than skipped", () => {
  const version = git(["--version"]);
  assert.equal(version.status, 0, `git is required for the ignore policy: ${version.stderr}`);

  // A repository without the command would answer 129 (usage) or 128 (fatal);
  // a policy that silently passed in that state would be worthless.
  const probe = git(["check-ignore", "--no-index", "-v", "--non-matching", "--stdin"], {
    input: ".env\n",
  });
  assert.ok(probe.status === 0 || probe.status === 1, `git check-ignore is required: ${probe.stderr}`);
});

test("every non-template dotenv path is ignored at the root and at every nested depth", () => {
  const paths = IGNORED_BASENAMES.flatMap(fixturePaths);
  const verdicts = checkIgnore(paths);

  for (const subject of paths) {
    const { source, pattern } = verdicts.get(subject);
    assert.notEqual(pattern, "", `${subject} is not ignored by any rule`);
    assert.ok(!pattern.startsWith("!"), `${subject} is re-included by ${pattern}`);
    assert.equal(source, ".gitignore", `${subject} must be decided by the repository ignore file`);
  }
});

test("template dotenv paths stay visible at the root and at every nested depth", () => {
  const paths = VISIBLE_BASENAMES.flatMap(fixturePaths);
  const verdicts = checkIgnore(paths);

  for (const subject of paths) {
    const { pattern } = verdicts.get(subject);
    // Either no rule touches the template, or the deciding rule is a negation.
    assert.ok(
      pattern === "" || pattern.startsWith("!"),
      `${subject} must remain committable, but ${pattern} ignores it`,
    );
  }

  // The same call is also the positive control: it must have proved the
  // negations are reachable at all, not merely that no rule matched.
  const nested = verdicts.get(`${FIXTURE_DIR}/nested/deeper/.env.example`);
  assert.ok(nested.pattern.startsWith("!"), "the nested template negation must be the deciding rule");
});

test("the ignore file states the fail-closed dotenv policy exactly once", () => {
  const result = git(["check-ignore", "--no-index", "-v", "--stdin"], { input: ".env\n" });
  assert.equal(result.status, 0, "the bare root .env must be ignored");
  const [decision] = result.stdout.trim().split("\t");
  const [, , pattern] = decision.split(":");
  assert.equal(pattern, "**/.env*", "one general rule must cover every depth");
});

test("no tracked path is a non-template dotenv file", () => {
  const result = git(["ls-files", "-z"]);
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);

  const tracked = result.stdout.split("\0").filter((entry) => entry.length > 0);
  assert.ok(tracked.length > 0, "the repository must have tracked files");

  const offenders = tracked.filter((entry) => {
    const basename = path.posix.basename(entry);
    if (!basename.startsWith(".env")) return false;
    return !(basename === ".env.example" || /^\.env\..+\.example$/.test(basename));
  });
  assert.deepEqual(offenders, [], "a non-template dotenv file is tracked in the repository");
});

/**
 * The other way a file leaves a required gate without anyone deciding it should:
 * the checker skips it for being too large. Biome's default ceiling is 1 MiB and
 * an over-size file is a WARNING, not an error — `Checked 0 files` still exits 0
 * inside a directory run — so the skip is invisible in `bun run lint` output.
 *
 * `RELEASE-027`'s dotenv work above proves what git ignores; this proves what the
 * formatter/linter ignores, on the same principle: ask the tool, do not read the
 * config and assume. The coordinator's 12B dispatch directed the `files.maxSize`
 * ceiling that admits Plan 05's 6.5 MiB v5 audio-turn fixture; what follows is
 * the standing proof that the ceiling is sized to the tree rather than picked.
 */
const BIOME_CONFIG = "biome.json";
const BIOME_BINARY = "node_modules/.bin/biome";

/** Tracked files Biome's own `files.includes` negations do not exclude. */
function biomeCheckedTrackedFiles(config) {
  const excluded = (config.files?.includes ?? [])
    .filter((entry) => entry.startsWith("!"))
    .map((entry) => entry.slice(1));

  const listed = git(["ls-files", "-z"]);
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);

  return listed.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .filter(
      (entry) => !excluded.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`)),
    )
    .map((entry) => ({ entry, size: statSync(path.join(root, entry)).size }));
}

test("no tracked file is silently skipped by the formatter for exceeding its size ceiling", () => {
  const config = JSON.parse(readFileSync(path.join(root, BIOME_CONFIG), "utf8"));
  const ceiling = config.files?.maxSize;
  assert.equal(typeof ceiling, "number", `${BIOME_CONFIG} must state files.maxSize explicitly`);

  const checked = biomeCheckedTrackedFiles(config);
  assert.ok(checked.length > 0, "the repository must have tracked files");
  const largest = checked.reduce((a, b) => (b.size > a.size ? b : a));

  assert.ok(
    largest.size <= ceiling,
    `${largest.entry} is ${largest.size} bytes and the ceiling is ${ceiling}; the checker would ` +
      "skip it with a warning nobody reads",
  );

  // And the ceiling is justified rather than decorative: something in the tree
  // actually needs it. If this ever fails, the right change is deleting the
  // override, not raising it further.
  assert.ok(
    largest.size > BIOME_DEFAULT_MAX_SIZE,
    `no tracked file exceeds Biome's ${BIOME_DEFAULT_MAX_SIZE}-byte default, so the ` +
      `${BIOME_CONFIG} files.maxSize override is unnecessary and should be removed`,
  );
});

/** Biome's built-in ceiling, which the override exists to raise. */
const BIOME_DEFAULT_MAX_SIZE = 1024 * 1024;

test("the checker really does process the largest tracked file, and would not at the default", () => {
  const config = JSON.parse(readFileSync(path.join(root, BIOME_CONFIG), "utf8"));
  const largest = biomeCheckedTrackedFiles(config).reduce((a, b) => (b.size > a.size ? b : a));

  const biome = path.join(root, BIOME_BINARY);
  assert.ok(existsSync(biome), `${BIOME_BINARY} is required for this proof; run bun install`);

  const run = (extraArgs) => {
    const result = spawnSync(biome, ["check", ...extraArgs, largest.entry], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.error) throw new Error(`biome could not run: ${result.error.message}`);
    return `${result.stdout}${result.stderr}`;
  };

  const configured = run([]);
  assert.match(
    configured,
    /Checked 1 file/,
    `the configured ceiling must actually admit ${largest.entry}:\n${configured}`,
  );

  // Negative control: at Biome's default ceiling the same file is skipped, with
  // a warning and no error. This is what the tree looked like before the
  // override, and it is why "biome is green" was not evidence that this file had
  // ever been looked at.
  const defaulted = run([`--files-max-size=${BIOME_DEFAULT_MAX_SIZE}`]);
  assert.match(defaulted, /Checked 0 files/);
  assert.match(defaulted, /exceeds the configured maximum/);
});
