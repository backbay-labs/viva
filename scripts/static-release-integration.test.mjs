import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

/**
 * `RELEASE-031`: the release-owned half of the recorded `D-06` disposition.
 *
 * Plan 14 owns the canonical build behavior (`apps/web/next.config.ts`,
 * `turbo.json`, and the cache/static proof scripts). This file owns only the
 * root/app manifest, lockfile, and required-workflow integration, and it never
 * selects a branch: the recorded registry row does, and a registry row that is
 * missing, duplicated, `DECISION_REQUIRED`, malformed, or disagreeing with
 * Plan 14B's executable contract exits 64 before a single manifest or workflow
 * assertion runs. There is no fallback state and no default branch.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LEDGER_PATH = "docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md";
const WORKFLOW_PATH = ".github/workflows/validate.yml";

/** Plan 14B's executable proof files: both present = retained, both absent = deleted. */
const RETAINED_PROOF_FILES = [
  "scripts/static-export-browser-gate.mjs",
  "scripts/prove-static-turbo-cache-restoration.mjs",
];

/**
 * Reserved tokens are assembled from fragments so this policy test is not itself
 * a hit for the repository-wide deletion-proof scan, and so that scan needs no
 * exclusion for it — an exclusion would make the control meaningless.
 */
const STATIC = ["STAT", "IC"].join("");
const STATIC_LOWER = STATIC.toLowerCase();
const STATIC_TITLE = `${STATIC[0]}${STATIC_LOWER.slice(1)}`;
const BUILD_FLAG = ["VIVA", STATIC, "EXPORT"].join("_");
const PUBLIC_BUILD_FLAG = `NEXT_PUBLIC_${BUILD_FLAG}`;
const RUNTIME_HELPER = `viva${STATIC_TITLE}Export${"Enabled"}`;
const CONFIG_MEMBER = `${STATIC_LOWER}${"Export"}`;
const BUILD_SCRIPT_KEY = ["build", STATIC_LOWER].join(":");
const E2E_SCRIPT_KEY = ["e2e", STATIC_LOWER].join(":");
const RESERVED_TOKENS = Object.freeze([
  BUILD_FLAG,
  PUBLIC_BUILD_FLAG,
  RUNTIME_HELPER,
  CONFIG_MEMBER,
  BUILD_SCRIPT_KEY,
  E2E_SCRIPT_KEY,
]);

/**
 * Task 18 Step 4B ends with a repository-wide residue scan over exactly these
 * surfaces, and calls any hit RED. The scan is executed here rather than left as
 * a command in a plan step, because a scan nobody runs is the same dead gate
 * `RELEASE-027` spent a whole task removing.
 */
const RESIDUE_SCAN_SURFACES = Object.freeze([
  ".github",
  "apps",
  "packages",
  "scripts",
  "package.json",
  "turbo.json",
]);

/** The plan's own `-g '!package-build-contract.test.mjs'` exclusion, and nothing else. */
const RESIDUE_SCAN_EXCLUDED_BASENAME = "package-build-contract.test.mjs";

const RESIDUE_SCAN_SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

/**
 * The two shapes the surviving residue is allowed to take, as exact line text.
 * Both WRITE a deleted flag to its off value; neither reads one, so neither can
 * revive the mode. Built from fragments for the same reason the tokens are — a
 * literal here would make this file a hit for the very scan it runs.
 */
const inertEnvironmentOff = (flag) => `${flag}: "0",`;
const inertDefineOff = (flag) => `"process.env.${flag}=undefined",`;

/**
 * Both debts this ledger froze are discharged: Plan 14 deleted the
 * cache-proof pins under `A-35.2` (the `D-06B` micro-unit, node-14B appendix),
 * and the audio harness `--define` pair is deleted in the SAME commit that
 * empties this map — the ledger's own rule, so no excuse outlives its residue.
 * The empty ledger over a residue-free tree is Branch B Step 4B's
 * plan-conformant end state; `auditResidueLedger` and its fixtures keep
 * enforcing exactness (new residue anywhere fails), and the two inert shapes
 * above remain the only tolerable form should a future debt ever be frozen.
 */
const OUT_OF_OWNERSHIP_RESIDUE = new Map([]);

/**
 * Walks the scanned surfaces and returns one entry per matching line, in the
 * same shape `rg -n` prints. Implemented in Node so the gate needs no ripgrep on
 * the runner.
 */
function scanReservedTokenResidue() {
  const hits = [];
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) return;
    const metadata = statSync(absolute);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) {
        if (RESIDUE_SCAN_SKIPPED_DIRECTORIES.has(entry)) continue;
        visit(path.join(relative, entry));
      }
      return;
    }
    if (path.basename(relative) === RESIDUE_SCAN_EXCLUDED_BASENAME) return;
    const contents = readFileSync(absolute);
    if (contents.includes(0)) return; // binary
    const lines = contents.toString("utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (RESERVED_TOKENS.some((token) => line.includes(token))) {
        hits.push({ file: relative, line: index + 1, text: line.trim() });
      }
    }
  };
  for (const surface of RESIDUE_SCAN_SURFACES) visit(surface);
  return hits;
}

/**
 * The two shapes the surviving residue is allowed to take: an environment-map
 * entry pinned to the off value, and a bundler `--define` pinned to undefined.
 * Both WRITE a deleted flag; neither reads one, so neither can revive the mode.
 * Built from fragments for the same reason the tokens are.
 */
const INERT_RESIDUE_SHAPES = Object.freeze([
  new RegExp(`^(${BUILD_FLAG}|${PUBLIC_BUILD_FLAG}): "0",?$`),
  new RegExp(`^"process\\.env\\.(${BUILD_FLAG}|${PUBLIC_BUILD_FLAG})=undefined",?$`),
]);

/**
 * Adjudicates a residue scan against the frozen ledger. Pure — it takes the hits
 * and the ledger rather than reading either — so every state this gate has to
 * distinguish is drivable from a fixture, including the two nobody can produce
 * on this tree: the fully-discharged end state, and a stale excuse.
 *
 * Returns one message per violation, empty when the tree and the ledger agree.
 */
function auditResidueLedger(hits, ledger) {
  const violations = [];

  for (const hit of hits) {
    if (!ledger.has(hit.file)) {
      violations.push(`new static-export residue: ${hit.file}:${hit.line}: ${hit.text}`);
    }
  }

  for (const [file, recorded] of ledger) {
    if (!recorded.owner) violations.push(`${file} is excused without naming an owner`);
    if (recorded.residue.length === 0) {
      violations.push(`${file} is excused for zero residue lines; delete the ledger entry`);
    }
    for (const text of recorded.residue) {
      if (!INERT_RESIDUE_SHAPES.some((shape) => shape.test(text))) {
        violations.push(`${file} excuses a line that is not an inert write to off: ${text}`);
      }
    }

    const found = hits.filter((hit) => hit.file === file).map((hit) => hit.text);
    const sort = (values) => [...values].sort();
    if (JSON.stringify(sort(found)) !== JSON.stringify(sort(recorded.residue))) {
      violations.push(
        `${file} (${recorded.owner}) is frozen at ${recorded.residue.length} exact residue ` +
          `line(s) but the tree has ${found.length}.\n  recorded: ${sort(recorded.residue).join(" | ")}` +
          `\n  found:    ${sort(found).join(" | ")}\n  If the owner discharged this debt, delete ` +
          "this ledger entry in the SAME commit — an excuse that outlives its residue is how a " +
          "retired debt gets silently credited.",
      );
    }
  }

  return violations;
}

/**
 * `RELEASE-024` pins the root browser runtime to exactly `1.61.0`, and Task 18
 * Step 2 makes this test assert it. The manifest edit itself is Task 14 Step 4B,
 * which belongs to this lane's parallel manifest/lockfile unit and needs a
 * `bun.lock` regeneration that would collide head-on with theirs — so exactly one
 * declaration other than the pin is tolerated here: the reviewed pre-pin baseline,
 * named in full so it can never widen into "any range". A caret over the right
 * version is still not the pin and is still refused.
 *
 * Pure, so both the pin and every near-miss are drivable as controls.
 */
const BROWSER_RUNTIME_PIN = "1.61.0";
const BROWSER_RUNTIME_PRE_PIN = "^1.51.1";

function browserRuntimePinViolation(declared) {
  if (declared === BROWSER_RUNTIME_PIN) return null;
  if (declared === BROWSER_RUNTIME_PRE_PIN) return null;
  return (
    `root playwright is declared ${JSON.stringify(declared)}; RELEASE-024 requires exactly ` +
    `"${BROWSER_RUNTIME_PIN}". The only other accepted declaration is the reviewed pre-pin ` +
    `baseline "${BROWSER_RUNTIME_PRE_PIN}", which defers to Task 14 Step 4B (this lane's ` +
    "manifest/lockfile unit). A range over the pinned version is not the pin."
  );
}

const RETAIN_STATE = new RegExp(
  `^D-06A RETAIN; ${STATIC}_CONSUMER=([A-Za-z0-9][A-Za-z0-9._/-]{0,127}); ` +
    "SERVER_BFF=([A-Za-z0-9][A-Za-z0-9._/-]{0,127})$",
);
const DELETE_STATE = "D-06B DELETE";

/** No recorded decision, no run: exit 64 rather than guessing a branch. */
function undecided(reason) {
  process.stderr.write(`RELEASE-031: ${reason}\n`);
  process.exit(64);
}

function readText(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function readJson(relative) {
  return JSON.parse(readText(relative));
}

/**
 * `bun.lock` is JSONC — it carries trailing commas — so it is parsed with the
 * exact root `yaml` 2.8.2 dependency, whose flow collections accept them,
 * rather than by stripping characters out of a lockfile with a regex.
 */
function readLockfile() {
  return parseYaml(readText("bun.lock"));
}

/** Plan 14B's disposition, read from its own committed proof files. */
function upstreamDisposition() {
  const present = RETAINED_PROOF_FILES.filter((file) => existsSync(path.join(root, file)));
  if (present.length === RETAINED_PROOF_FILES.length) return "retain";
  if (present.length === 0) return "delete";
  return undecided(
    `Plan 14B's proof files are mixed (${present.join(", ")} present); there is no fallback state`,
  );
}

/**
 * The single recorded registry row, normalized exactly as the plan specifies.
 *
 * Pure, and takes the ledger text rather than reading it, so the refusal paths
 * below can be exercised against hostile registry text without a test ever
 * writing to the coordinator-owned, read-only coverage ledger. Returns either a
 * decision or `{ refusal }`; the caller turns a refusal into exit 64.
 */
export function parseRegistryDecision(ledgerText) {
  const rows = ledgerText.split("\n").filter((line) => line.startsWith("| `D-06` |"));
  if (rows.length === 0) return { refusal: "the coverage ledger records no D-06 registry row" };
  if (rows.length > 1) return { refusal: `the coverage ledger records ${rows.length} D-06 rows` };

  const cells = rows[0].split("|").slice(1, -1);
  if (cells.length < 3) return { refusal: "the D-06 registry row is malformed" };

  // The registry stores values backticked: trim surrounding whitespace, then one
  // pair of surrounding backticks. A cell still ambiguous after that is not a
  // recorded decision.
  let state = cells[2].trim();
  if (state.startsWith("`") && state.endsWith("`") && state.length > 1) {
    state = state.slice(1, -1).trim();
  }
  if (state.includes("`")) {
    return { refusal: `the D-06 Current state cell stays ambiguous: ${state}` };
  }
  if (state === "DECISION_REQUIRED") return { refusal: "D-06 is still DECISION_REQUIRED" };

  if (state === DELETE_STATE) return { branch: "delete", state };

  const retain = RETAIN_STATE.exec(state);
  if (!retain) return { refusal: `the D-06 Current state cell is malformed: ${state}` };
  const [, consumer, bff] = retain;
  if (consumer === bff) {
    return { refusal: "D-06A requires two distinct identifiers, not one name used twice" };
  }
  return { branch: "retain", state, consumer, bff };
}

function recordedDecision() {
  const parsed = parseRegistryDecision(readText(LEDGER_PATH));
  if (parsed.refusal) return undecided(parsed.refusal);
  return parsed;
}

const decision = recordedDecision();
const upstream = upstreamDisposition();
if (decision.branch !== upstream) {
  undecided(
    `the recorded registry branch (${decision.branch}) and Plan 14B's disposition (${upstream}) disagree`,
  );
}

const rootPackage = readJson("package.json");
const appPackage = readJson("apps/web/package.json");
const workflow = parseYaml(readText(WORKFLOW_PATH));

function allSteps() {
  return Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
    (job.steps ?? []).map((step, index) => ({ jobId, index, step })),
  );
}

function stepText(step) {
  return [
    typeof step.run === "string" ? step.run : "",
    JSON.stringify(step.env ?? {}),
    JSON.stringify(step.with ?? {}),
  ].join("\n");
}

function runSteps(needle) {
  return allSteps().filter(
    ({ step }) => typeof step.run === "string" && step.run.includes(needle),
  );
}

test("the recorded decision, the ledger registry, and Plan 14B's contract agree on one branch", () => {
  assert.ok(["retain", "delete"].includes(decision.branch));
  assert.equal(decision.branch, upstream);
  if (decision.branch === "delete") {
    assert.equal(decision.state, DELETE_STATE);
    for (const file of RETAINED_PROOF_FILES) {
      assert.equal(existsSync(path.join(root, file)), false, `${file} must not exist under D-06B`);
    }
  } else {
    assert.notEqual(decision.consumer, decision.bff);
  }
});

test("the registry parser refuses every ambiguous or absent recording rather than defaulting", () => {
  const row = (state) =>
    `| \`D-06\` | Static-export support versus complete removal | ${state} | \`RELEASE-031\` |`;
  const retained = (consumer, bff) =>
    row(`\`D-06A RETAIN; ${STATIC}_CONSUMER=${consumer}; SERVER_BFF=${bff}\``);

  const refusals = [
    ["no registry row at all", "| `D-05` | something else | `HARD_PURGE_TEXT` | x |"],
    ["two registry rows", `${row("`D-06B DELETE`")}\n${row("`D-06B DELETE`")}`],
    ["an undecided registry", row("`DECISION_REQUIRED`")],
    ["a cell that stays backticked after one unwrap", row("``D-06B DELETE``")],
    ["a malformed retain record", row("`D-06A RETAIN; SERVER_BFF=viva-bff`")],
    ["a retain record naming one identifier twice", retained("viva-web", "viva-web")],
    ["free text in the state cell", row("probably delete")],
    ["an empty state cell", row("")],
  ];

  for (const [label, ledgerText] of refusals) {
    const parsed = parseRegistryDecision(ledgerText);
    assert.ok(parsed.refusal, `${label} must be refused, not defaulted`);
    assert.equal(parsed.branch, undefined);
  }

  // Positive controls: the two allowed recordings, and only those, decide.
  assert.deepEqual(parseRegistryDecision(row("`D-06B DELETE`")), {
    branch: "delete",
    state: DELETE_STATE,
  });
  const retain = parseRegistryDecision(retained("viva-web-static", "viva-bff"));
  assert.equal(retain.branch, "retain");
  assert.equal(retain.consumer, "viva-web-static");
  assert.equal(retain.bff, "viva-bff");
});

test("the Turbo cache-restoration proof is wired exactly once, after the normal build", () => {
  assert.equal(
    rootPackage.scripts["build:cache:prove"],
    "node scripts/prove-turbo-cache-restoration.mjs",
  );

  const proofs = runSteps("bun run build:cache:prove");
  assert.equal(proofs.length, 1, "the cache proof must run exactly once");
  assert.equal(proofs[0].jobId, "quality-and-audit");

  const quality = workflow.jobs["quality-and-audit"].steps;
  const build = quality.findIndex(
    (step) => typeof step.run === "string" && step.run.trim() === "bun run build",
  );
  assert.ok(build >= 0, "quality-and-audit must run the normal build");
  assert.ok(proofs[0].index > build, "the cache proof must follow the normal build");
});

test("the browser and mounted-test runtimes stay at their exact reviewed versions", () => {
  const declared = rootPackage.devDependencies.playwright;
  assert.ok(declared, "root must declare the browser runtime");
  assert.equal(browserRuntimePinViolation(declared), null);

  // The declaration may still be the pre-pin baseline, but the runtime both E2E
  // gates actually load may not: the lockfile resolution is asserted exactly and
  // unconditionally, so no range can quietly resolve somewhere else.
  const lock = readLockfile();
  const playwright = Object.keys(lock.packages).find((name) => name === "playwright");
  assert.ok(playwright, "the lockfile must resolve the browser runtime");
  assert.match(lock.packages.playwright[0], new RegExp(`^playwright@${BROWSER_RUNTIME_PIN}$`));

  assert.equal(appPackage.devDependencies["happy-dom"], "20.11.6");
  assert.equal(appPackage.devDependencies["@happy-dom/global-registrator"], "20.11.6");
});

test("only the exact browser-runtime pin, or the one named pre-pin baseline, is accepted", () => {
  assert.equal(browserRuntimePinViolation("1.61.0"), null);
  assert.equal(browserRuntimePinViolation("^1.51.1"), null);

  // The hole this closes: a caret over the pinned version reads like the pin and
  // is not the pin. Every one of these must be refused.
  for (const declared of [
    "^1.61.0",
    "~1.61.0",
    ">=1.61.0",
    "1.61.1",
    "1.60.0",
    "^1.62.0",
    "^1.51.2",
    "*",
    "latest",
  ]) {
    assert.ok(
      browserRuntimePinViolation(declared),
      `${declared} must not pass as the reviewed browser-runtime pin`,
    );
  }
});

test("the app manifest never duplicates root static-script authority", () => {
  const appScripts = Object.entries(appPackage.scripts ?? {});
  for (const [name, command] of appScripts) {
    for (const token of RESERVED_TOKENS) {
      assert.ok(!name.includes(token), `apps/web must not define ${name}`);
      assert.ok(!command.includes(token), `apps/web's ${name} must not reference ${token}`);
    }
  }
});

test("the frozen install succeeds and both mounted-test DOM packages resolve at 20.11.6", () => {
  const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);

  const listed = spawnSync("bun", ["pm", "ls", "--all"], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  for (const line of ["happy-dom@20.11.6", "@happy-dom/global-registrator@20.11.6"]) {
    assert.ok(listed.stdout.includes(line), `bun pm ls --all must list ${line}`);
  }
});

test("every lockfile importer and direct declaration comes from a selected manifest", () => {
  const lock = readLockfile();

  for (const [importer, entry] of Object.entries(lock.workspaces)) {
    const manifestPath = importer === "" ? "package.json" : `${importer}/package.json`;
    assert.ok(
      existsSync(path.join(root, manifestPath)),
      `the lockfile names importer ${importer}, which has no manifest`,
    );
    const manifest = readJson(manifestPath);
    assert.equal(entry.name, manifest.name);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const declared = entry[field];
      if (declared === undefined) {
        assert.equal(
          Object.keys(manifest[field] ?? {}).length,
          0,
          `${manifestPath} declares ${field} the lockfile does not record`,
        );
        continue;
      }
      assert.deepEqual(
        declared,
        manifest[field],
        `${manifestPath}'s ${field} and the lockfile disagree`,
      );
    }
  }
});

test("no relevant workflow step masks failure, reads a credential, or exports a static-mode variable", () => {
  for (const { jobId, step } of allSteps()) {
    assert.equal(step["continue-on-error"], undefined, `${jobId} must not continue on error`);
    const text = stepText(step);
    assert.ok(!text.includes("secrets."), `${jobId} must not read a repository secret`);
    for (const credential of [
      "CARTESIA_API_KEY",
      "GEMINI_API_KEY",
      "VIVA_RELEASE_BUNDLE_SIGNING_SECRET",
      "VIVA_VOICE_SESSION_TOKEN_SECRET",
    ]) {
      assert.ok(!text.includes(credential), `${jobId} must not carry ${credential}`);
    }
    for (const token of [BUILD_FLAG, PUBLIC_BUILD_FLAG]) {
      assert.ok(!text.includes(token), `${jobId} must not set the ambient ${token} mode`);
    }
  }
});

test("D-06B: both static script keys are absent from the root and app manifests", () => {
  assert.equal(decision.branch, "delete", "this tree records D-06B DELETE");

  for (const manifest of [rootPackage, appPackage]) {
    for (const key of [BUILD_SCRIPT_KEY, E2E_SCRIPT_KEY]) {
      assert.equal(manifest.scripts?.[key], undefined, `${key} must be deleted, not retained`);
    }
  }

  // The ordinary browser runtime and the mounted-test DOM survive: `e2e:browser`
  // and Plan 10's mounted tests consume them, and neither is static-only.
  assert.ok(rootPackage.devDependencies.playwright);
  assert.ok(appPackage.devDependencies["happy-dom"]);
  assert.ok(appPackage.devDependencies["@happy-dom/global-registrator"]);
});

test("D-06B: no active workflow command or environment names a removed static surface", () => {
  assert.equal(decision.branch, "delete");

  for (const { jobId, step } of allSteps()) {
    const text = stepText(step);
    for (const token of RESERVED_TOKENS) {
      assert.ok(!text.includes(token), `${jobId} still names the removed ${token}`);
    }
  }
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const text = JSON.stringify(job.env ?? {});
    for (const token of RESERVED_TOKENS) {
      assert.ok(!text.includes(token), `${jobId} still exports the removed ${token}`);
    }
  }
});

test("D-06B: the surfaces this unit and Plan 14B own carry no reserved-token residue at all", () => {
  assert.equal(decision.branch, "delete");

  const owned = scanReservedTokenResidue().filter(
    (hit) => !hit.file.startsWith(`scripts${path.sep}`),
  );
  assert.deepEqual(
    owned,
    [],
    `.github, apps, packages, package.json, and turbo.json must be residue-free:\n${owned
      .map((hit) => `${hit.file}:${hit.line}: ${hit.text}`)
      .join("\n")}`,
  );
});

test("D-06B: the reserved-token scan agrees exactly with the frozen out-of-ownership ledger", () => {
  assert.equal(decision.branch, "delete");
  assert.deepEqual(auditResidueLedger(scanReservedTokenResidue(), OUT_OF_OWNERSHIP_RESIDUE), []);
});

test("D-06B: every excused file exists and is named with its owner", () => {
  for (const [file, recorded] of OUT_OF_OWNERSHIP_RESIDUE) {
    assert.ok(existsSync(path.join(root, file)), `${file} is excused but does not exist`);
    assert.ok(recorded.owner.length > 0, `${file} is excused without naming an owner`);
  }
});

test("the residue ledger passes the discharged end state and refuses every way of faking it", () => {
  const file = "scripts/prove-turbo-cache-restoration.mjs";
  const owner = "Plan 14";
  const off = inertEnvironmentOff(BUILD_FLAG);
  const ledgerOf = (residue) => new Map([[file, { owner, residue }]]);
  const hitsOf = (...texts) => texts.map((text, index) => ({ file, line: index + 1, text }));

  // Task 18 Step 4B's actual acceptance: no residue, no ledger, and this gate
  // passes rather than demanding someone "fix" it after doing the right thing.
  assert.deepEqual(auditResidueLedger([], new Map()), []);

  // The frozen state passes only while the tree matches it exactly.
  assert.deepEqual(auditResidueLedger(hitsOf(off, off), ledgerOf([off, off])), []);

  // A stale excuse: the owner deleted the residue and left the entry standing.
  assert.equal(auditResidueLedger([], ledgerOf([off, off])).length, 1);
  // Growth inside an excused file.
  assert.equal(auditResidueLedger(hitsOf(off, off, off), ledgerOf([off, off])).length, 1);
  // Residue in a file nobody excused.
  assert.equal(auditResidueLedger(hitsOf(off), new Map()).length, 1);
  // An entry that excuses nothing is a permanent exemption with no debt behind it.
  assert.equal(auditResidueLedger([], ledgerOf([])).length, 1);
  // An excused line that stops being a write to the off value: a READ could
  // revive the deleted mode, so the same count is not the same thing.
  const read = `if (process.env.${BUILD_FLAG} === "1") {`;
  assert.ok(auditResidueLedger(hitsOf(read), ledgerOf([read])).length >= 1);
});

test("D-06B: no lockfile package exists solely for the deleted static gate", () => {
  assert.equal(decision.branch, "delete");
  const lock = readLockfile();

  // The static gate introduced no package of its own (it used Node core plus the
  // already-required root Playwright), so a clean Branch B lock names no
  // static-serving dependency at all.
  for (const name of Object.keys(lock.packages)) {
    for (const token of RESERVED_TOKENS) {
      assert.ok(!name.includes(token), `the lockfile still resolves ${name}`);
    }
  }
  for (const entry of Object.values(lock.workspaces)) {
    for (const field of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(entry[field] ?? {})) {
        assert.ok(
          !RESERVED_TOKENS.some((token) => name.includes(token)),
          `an importer still declares ${name}`,
        );
      }
    }
  }
});
