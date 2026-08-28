/**
 * `RELEASE-030` — the executable module concentration ratchet.
 *
 * `scripts/module-concentration-policy.json` is the budget; this file is the
 * gate. It proves every budgeted path exists, that each ceiling is exactly the
 * recorded formula applied to the frozen baseline, that no file has grown past
 * its ceiling, that no unbudgeted release/monitor/E2E file has crossed the
 * 1,200-line threshold, and that every deferred extraction is recorded as
 * explicit accepted debt with the five fields its owning plan demands.
 *
 * Upward baseline edits are caught by `PINNED_FREEZE`: raising a number in the
 * JSON alone fails here, so a budget can only move with a visible two-file edit.
 *
 * Recorded deviation from Plan 12 Task 16 Step 1: the plan's table pins
 * `reviewed_lines` at `4d5d8276f03635ca74c04f4d500d13ce62198dd0`. Nodes 07, 08,
 * 09 and 13A have since performed their own extractions and the remediation
 * program's own tests grew several of the same files, so the ratchet is frozen
 * at the merged post-extraction sizes (per the coordinator's 12B dispatch) with
 * `reviewed_lines` retained per entry so the drift stays auditable.
 *
 * Post-review-remediation amend: this file also proves the plan's flat
 * 600-line cap on each E2E extracted module (`extracted_module_ceiling`)
 * for real, against that fixed constant -- never against a per-module
 * ratchet ceiling a commit could author for itself. A prior HARNESS-W07
 * commit did exactly that (checked `current <= entry.ceiling` instead),
 * which an adversarial review rejected as a lane-self-granted sanction of
 * a plan-locked constant. See `extractedModulesDerivedFrom`/
 * `FLAT_CEILING_NAMED_EXCEPTIONS` and the test below for the restored
 * check, and
 * `module-concentration-policy.json`'s `frozen_baseline_note` for how
 * `e2e-browser-story.mjs` now satisfies it (a thin barrel over further
 * derived children, budgeted separately by the ordinary ratchet mechanism).
 *
 * Second post-review-remediation amend: the first amend's restored check
 * still walked a hardcoded three-element list (`PLANNED_E2E_MODULES`),
 * silently excluding the six further-derived children the SAME commit
 * created -- so the flat cap bound a 61-line barrel and two files that were
 * never close to the limit, and constrained nothing real. A control adding
 * a hypothetical 900-line derived module with its own budget entry and
 * `PINNED_FREEZE` row left every one of this file's checks passing
 * (reproduced fresh at `artifacts/sdd/evidence/w07-amend2-planned-modules-
 * gap-red.txt`). Fixed by deriving the subject set from the policy's own
 * `derived_from` graph (`extractedModulesDerivedFrom`, rooted at `scripts/
 * e2e-browser.mjs`) instead of a hand-maintained list, so a later split or
 * addition is bound automatically; the one file that still cannot fit
 * (`e2e-browser-story-runner.mjs`) is a single named exception whose
 * validity is keyed to the live `RELEASE-030-E2E-EXTRACTION` accepted-debt
 * record (`FLAT_CEILING_NAMED_EXCEPTIONS`) -- retire that record and the
 * cap re-arms for that file with no further code change here.
 */

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const POLICY_PATH = "scripts/module-concentration-policy.json";

const KNOWN_OWNERS = new Set(["Plan 07", "Plan 08", "Plan 09", "Plan 12", "Plan 13"]);

/**
 * The independent anchor for every frozen baseline and owner. It exists so that
 * an upward edit to the JSON alone fails: a budget may only move by a
 * deliberate, reviewable edit to both files.
 */
const PINNED_FREEZE = Object.freeze({
  // A-37: re-frozen at the combined 12B admission — the A-32/A-34 appendix
  // tests landed after the original freeze. The JSON entry carries the record.
  "agent/crates/agent-service/tests/voice_ws.rs": { lines: 20594, owner: "Plan 08" },
  "agent/crates/agent-service/src/ws.rs": { lines: 882, owner: "Plan 08" },
  "agent/crates/agent-service/src/ws/admission.rs": { lines: 1586, owner: "Plan 08" },
  "agent/crates/agent-service/src/ws/turn.rs": { lines: 1307, owner: "Plan 08" },
  "agent/crates/agent-service/src/ws/terminal.rs": { lines: 1222, owner: "Plan 08" },
  "agent/crates/agent-service/src/ws/tests.rs": { lines: 4611, owner: "Plan 08" },
  "agent/crates/agent-service/src/app.rs": { lines: 721, owner: "Plan 08" },
  "agent/crates/data/src/memory.rs": { lines: 6314, owner: "Plan 09" },
  "agent/crates/data/src/memory/store_conformance.rs": { lines: 2269, owner: "Plan 09" },
  "agent/crates/data/src/memory/learning.rs": { lines: 1506, owner: "Plan 09" },
  "agent/crates/data/src/memory/ingestion.rs": { lines: 1235, owner: "Plan 09" },
  "agent/crates/data/src/postgres.rs": { lines: 2005, owner: "Plan 09" },
  "agent/crates/data/src/postgres/learning.rs": { lines: 1564, owner: "Plan 09" },
  "agent/crates/agent-adapters/src/cartesia_gemini/runner.rs": { lines: 5135, owner: "Plan 07" },
  "agent/crates/agent-adapters/src/cartesia_gemini/llm.rs": { lines: 4591, owner: "Plan 07" },
  "apps/web/app/globals.css": { lines: 10, owner: "Plan 13" },
  "apps/web/app/styles/session.css": { lines: 2311, owner: "Plan 13" },
  "apps/web/app/styles/landing.css": { lines: 1431, owner: "Plan 13" },
  // RELEASE-030-E2E-EXTRACTION (HARNESS-W07 unit): the entrypoint moved from
  // ratchet to the fixed entrypoint ceiling (2881 -> 172 lines: 167, then +5
  // net lines restoring the hosted-mode `waitForHttp` readiness wait an
  // adversarial review found silently dropped by the extraction). The three
  // plan-named extracted modules (this file, `e2e-browser-plan.mjs`,
  // `e2e-browser-runtime.mjs`) now each hold to the plan's literal flat
  // 600-line module cap for real: `e2e-browser-story.mjs` is a thin barrel
  // (61 lines) over six further-derived children of its own, not a
  // self-authored ratchet on 2456 lines the way the first extraction pass
  // shipped it — that shape is exactly what the adversarial review's critical
  // finding rejected (the per-module gate below had been changed to check
  // each module's own ceiling instead of the plan's flat constant). See the
  // policy JSON's `frozen_baseline_note` and `accepted_debt` for why one of
  // those six children (`e2e-browser-story-runner.mjs`) is disclosed rather
  // than forced under 600 or split further.
  "scripts/e2e-browser.mjs": { lines: 172, owner: "Plan 12" },
  "scripts/e2e-browser-plan.mjs": { lines: 317, owner: "Plan 12" },
  "scripts/e2e-browser-runtime.mjs": { lines: 243, owner: "Plan 12" },
  "scripts/e2e-browser-story.mjs": { lines: 61, owner: "Plan 12" },
  "scripts/e2e-browser-story-actions.mjs": { lines: 271, owner: "Plan 12" },
  "scripts/e2e-browser-story-preview.mjs": { lines: 165, owner: "Plan 12" },
  "scripts/e2e-browser-story-evidence.mjs": { lines: 380, owner: "Plan 12" },
  "scripts/e2e-browser-story-matrix.mjs": { lines: 305, owner: "Plan 12" },
  "scripts/e2e-browser-story-learning-truth.mjs": { lines: 293, owner: "Plan 12" },
  "scripts/e2e-browser-story-runner.mjs": { lines: 1124, owner: "Plan 12" },
  "scripts/e2e-browser-story.test.mjs": { lines: 1203, owner: "Plan 12" },
  "scripts/e2e-browser-audio.mjs": { lines: 628, owner: "Plan 12" },
  "scripts/live-provider-smoke.test.mjs": { lines: 2320, owner: "Plan 12" },
  "scripts/live-provider-smoke.mjs": { lines: 1498, owner: "Plan 12" },
  "scripts/hosted-monitor-runner.mjs": { lines: 1390, owner: "Plan 12" },
  "scripts/hosted-monitor-runner.test.mjs": { lines: 1982, owner: "Plan 12" },
  // A-42: re-frozen at the W-07 harness admission — the coordinator sanction
  // inventory is append-only data by design. The JSON entry carries the record.
  "scripts/redaction-control.mjs": { lines: 3432, owner: "Plan 12" },
  // A-37: re-frozen at the combined 12B admission — the A-31.4 closures
  // landed after the original freeze. The JSON entry carries the record.
  "scripts/frontend-accessibility.mjs": { lines: 2929, owner: "Plan 13" },
  "scripts/frontend-quality.test.mjs": { lines: 1956, owner: "Plan 13" },
});

/**
 * The E2E extraction's root. Every budget entry transitively `derived_from`
 * this path (direct or indirect) is an extracted E2E module and is subject
 * to the plan's flat `extracted_module_ceiling`.
 */
const E2E_EXTRACTION_ROOT = "scripts/e2e-browser.mjs";

/**
 * The flat 600-line module cap binds every extracted E2E module except the
 * paths named here -- and even a named exception only holds while its
 * cited accepted-debt record is still live: present in `policy.
 * accepted_debt`, matched by both `id` and `path`. Retire the debt record
 * (drop the id, or repoint its `path` elsewhere) and the exception stops
 * applying on the very next run -- the flat cap re-arms for that file
 * automatically, no edit needed here.
 *
 * This is deliberately a short, human-edited, hardcoded list keyed to a
 * SPECIFIC debt id -- not "any path named by any live accepted-debt entry
 * is exempt". That looser shape would let a future commit dodge the flat
 * cap for a brand-new oversized file just by authoring its own debt
 * record (accepted-debt structural validation below checks the required
 * fields are non-empty prose, not that the debt is real); this file's own
 * `REQUIRED_DEBT_FIELDS` test does not and cannot police that. Only a path
 * a human has named in this array, in a reviewed commit to this file, can
 * ever be exempted.
 */
const FLAT_CEILING_NAMED_EXCEPTIONS = Object.freeze([
  Object.freeze({ path: "scripts/e2e-browser-story-runner.mjs", debtId: "RELEASE-030-E2E-EXTRACTION" }),
]);

/**
 * Every budget path transitively `derived_from` `rootPath`, computed from
 * the policy's own graph rather than hand-listed -- so a later commit that
 * splits or adds an E2E module is bound by the flat-cap test automatically
 * instead of silently sitting outside a stale hardcoded list (see the
 * mutation-control evidence cited in this file's header comment).
 */
function extractedModulesDerivedFrom(policy, rootPath) {
  const childrenByParent = new Map();
  for (const entry of policy.budgets) {
    if (entry.derived_from === undefined) {
      continue;
    }
    if (!childrenByParent.has(entry.derived_from)) {
      childrenByParent.set(entry.derived_from, []);
    }
    childrenByParent.get(entry.derived_from).push(entry.path);
  }

  const modules = [];
  const seen = new Set();
  const queue = [...(childrenByParent.get(rootPath) ?? [])];
  for (const path of queue) {
    seen.add(path);
  }
  while (queue.length > 0) {
    const path = queue.shift();
    modules.push(path);
    for (const child of childrenByParent.get(path) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return modules;
}

/** Fields every accepted-debt record must carry, per its owning plan. */
const REQUIRED_DEBT_FIELDS = Object.freeze([
  "id",
  "path",
  "owner",
  "authority",
  "remaining",
  "remaining_lines",
  "invariant_reason",
  "blocking_dependency",
  "follow_up",
  "acceptance_command",
]);

/** `wc -l` semantics: the number of newline characters in the file. */
async function lineCount(relativePath) {
  const text = await readFile(join(root, relativePath), "utf8");
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

async function exists(relativePath) {
  try {
    await stat(join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function walk(relativeRoot) {
  const absolute = join(root, relativeRoot);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      files.push(...(await walk(relative(root, child))));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, child).split("\\").join("/"));
    }
  }
  return files;
}

async function readPolicy() {
  return JSON.parse(await readFile(join(root, POLICY_PATH), "utf8"));
}

test("the concentration policy records the reviewed and frozen baselines and the exact formula", async () => {
  const policy = await readPolicy();

  assert.equal(policy.schema_version, 1);
  assert.equal(policy.reviewed_baseline_sha, "4d5d8276f03635ca74c04f4d500d13ce62198dd0");
  assert.match(policy.frozen_baseline_sha, /^[0-9a-f]{40}$/);
  assert.equal(policy.ratchet_multiplier, 1.05);
  assert.equal(policy.entrypoint_ceiling, 1200);
  assert.equal(policy.extracted_module_ceiling, 600);
  assert.equal(policy.unbudgeted_file_ceiling, 1200);
  assert.ok(Array.isArray(policy.budgets) && policy.budgets.length > 0);
  assert.ok(Array.isArray(policy.accepted_debt));
});

test("every budgeted path exists and carries a known owner and a real boundary", async () => {
  const policy = await readPolicy();
  const seen = new Set();

  for (const entry of policy.budgets) {
    assert.equal(typeof entry.path, "string", `budget entry without a path: ${entry.owner}`);
    assert.equal(seen.has(entry.path), false, `${entry.path} is budgeted twice`);
    seen.add(entry.path);

    assert.ok(await exists(entry.path), `${entry.path} is budgeted but missing from the tree`);
    assert.ok(
      KNOWN_OWNERS.has(entry.owner),
      `${entry.path} names an unknown extraction owner: ${entry.owner}`,
    );
    assert.equal(
      typeof entry.boundary === "string" && entry.boundary.trim().length >= 20,
      true,
      `${entry.path} has no authority-boundary text`,
    );
    assert.equal(
      typeof entry.frozen_at === "string" && entry.frozen_at.trim().length > 0,
      true,
      `${entry.path} does not record where its baseline was frozen`,
    );
  }
});

test("no frozen baseline or owner has been edited upward without its anchor", async () => {
  const policy = await readPolicy();
  const fromPolicy = Object.fromEntries(
    policy.budgets.map((entry) => [entry.path, { lines: entry.frozen_lines, owner: entry.owner }]),
  );

  assert.deepEqual(fromPolicy, { ...PINNED_FREEZE });
});

test("every ceiling is exactly the recorded formula applied to the frozen baseline", async () => {
  const policy = await readPolicy();

  for (const entry of policy.budgets) {
    assert.ok(
      Number.isInteger(entry.frozen_lines) && entry.frozen_lines >= 0,
      `${entry.path} has no integer frozen baseline`,
    );
    assert.ok(
      entry.reviewed_lines === null ||
        (Number.isInteger(entry.reviewed_lines) && entry.reviewed_lines > 0),
      `${entry.path} has a malformed reviewed_lines record`,
    );

    if (entry.ceiling_basis === "ratchet") {
      assert.equal(
        entry.ceiling,
        Math.ceil(entry.frozen_lines * policy.ratchet_multiplier),
        `${entry.path} ceiling is not ceil(frozen_lines * ${policy.ratchet_multiplier})`,
      );
      continue;
    }

    assert.equal(
      entry.ceiling_basis,
      "entrypoint",
      `${entry.path} has an unknown ceiling basis: ${entry.ceiling_basis}`,
    );
    assert.equal(
      entry.ceiling,
      policy.entrypoint_ceiling,
      `${entry.path} is an entrypoint and must take the fixed entrypoint ceiling`,
    );
  }
});

test("no budgeted file exceeds its ceiling", async () => {
  const policy = await readPolicy();
  const failures = [];

  for (const entry of policy.budgets) {
    const current = await lineCount(entry.path);
    if (current > entry.ceiling) {
      failures.push(
        `${entry.path}: ${current} lines exceeds the ${entry.ceiling}-line ceiling. ` +
          `Owner: ${entry.owner}. Boundary: ${entry.boundary}`,
      );
    }
  }

  assert.deepEqual(failures, [], failures.join("\n"));
});

test("each extracted module inherits its parent budget's owner", async () => {
  const policy = await readPolicy();
  const byPath = new Map(policy.budgets.map((entry) => [entry.path, entry]));

  for (const entry of policy.budgets) {
    if (entry.derived_from === undefined) {
      continue;
    }
    const parent = byPath.get(entry.derived_from);
    assert.ok(parent, `${entry.path} is derived from an unbudgeted path: ${entry.derived_from}`);
    assert.equal(
      entry.owner,
      parent.owner,
      `${entry.path} must keep its parent's extraction owner (${parent.owner})`,
    );
  }
});

test("no unbudgeted release, monitor, or E2E file has crossed the 1,200-line threshold", async () => {
  const policy = await readPolicy();
  const budgeted = new Set(policy.budgets.map((entry) => entry.path));
  const offenders = [];

  for (const watchedRoot of policy.watched_roots) {
    for (const file of await walk(watchedRoot)) {
      if (!policy.watched_extensions.some((extension) => file.endsWith(extension))) {
        continue;
      }
      if (budgeted.has(file)) {
        continue;
      }
      const current = await lineCount(file);
      if (current > policy.unbudgeted_file_ceiling) {
        offenders.push(`${file}: ${current} lines and no budget entry`);
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("every deferred extraction is recorded as accepted debt with all required fields", async () => {
  const policy = await readPolicy();
  const budgetedPaths = new Set(policy.budgets.map((entry) => entry.path));

  assert.ok(policy.accepted_debt.length > 0, "the freeze must record its deferred sub-splits");

  const ids = new Set();
  for (const debt of policy.accepted_debt) {
    for (const field of REQUIRED_DEBT_FIELDS) {
      const value = debt[field];
      const filled =
        typeof value === "number"
          ? Number.isInteger(value) && value > 0
          : String(value ?? "").trim().length > 0;
      assert.equal(filled, true, `accepted debt ${debt.id}: missing ${field}`);
    }
    assert.equal(ids.has(debt.id), false, `duplicate accepted-debt id ${debt.id}`);
    ids.add(debt.id);
    assert.ok(
      budgetedPaths.has(debt.path),
      `accepted debt ${debt.id} names an unbudgeted path: ${debt.path}`,
    );
    assert.ok(
      KNOWN_OWNERS.has(debt.owner),
      `accepted debt ${debt.id} names an unknown owner: ${debt.owner}`,
    );
  }

  // Lane 09's two deferred sub-splits and Plan 12's own deferred E2E
  // extraction must each be present by id — a silent drop is a policy
  // failure. A prior HARNESS-W07 commit retired `RELEASE-030-E2E-EXTRACTION`
  // here on the strength of a self-authored per-module ceiling; an
  // adversarial review rejected that (the flat 600-line module cap must be
  // real, and the debt's own `acceptance_command` had never actually passed
  // on this tree), so it is restored, rescoped to what genuinely remains.
  for (const requiredId of [
    "DATA-015-DEFERRED-MEMORY-FACADE",
    "DATA-015-DEFERRED-POSTGRES-FACADE",
    "RELEASE-030-E2E-EXTRACTION",
  ]) {
    assert.ok(ids.has(requiredId), `accepted debt ${requiredId} is missing from the freeze`);
  }
});

test("the Plan 12 E2E entrypoint is either under 1,200 lines or carries its extraction debt", async () => {
  const policy = await readPolicy();
  const entry = policy.budgets.find((candidate) => candidate.path === "scripts/e2e-browser.mjs");
  assert.ok(entry, "the E2E entrypoint must be budgeted");

  const current = await lineCount(entry.path);
  if (current <= policy.entrypoint_ceiling) {
    return;
  }

  const debt = policy.accepted_debt.find((record) => record.id === entry.pending_extraction);
  assert.ok(
    debt,
    `scripts/e2e-browser.mjs is ${current} lines, above the ${policy.entrypoint_ceiling}-line ` +
      "entrypoint ceiling, and carries no recorded extraction debt",
  );
  assert.equal(debt.path, entry.path);
  assert.equal(debt.target_ceiling, policy.entrypoint_ceiling);
  assert.equal(debt.target_extracted_module_ceiling, policy.extracted_module_ceiling);
});

test("every extracted E2E module -- the full derived_from closure, not a hand-picked subset -- stays inside the plan's flat 600-line module ceiling or a live named debt exception", async () => {
  const policy = await readPolicy();
  const byPath = new Map(policy.budgets.map((entry) => [entry.path, entry]));
  const exceptionByPath = new Map(
    FLAT_CEILING_NAMED_EXCEPTIONS.map((exception) => [exception.path, exception]),
  );

  // Plan 12 Task 16 Step 1 is a literal, fixed constant ("each new
  // extracted module is capped at 600 lines"), independent of each entry's
  // own ratchet ceiling in the budgets table above (that ratchet still
  // applies, separately, via "no budgeted file exceeds its ceiling" — a
  // file could in principle sit under its own tight ratchet and still be
  // checked against this flat constant, or vice versa).
  //
  // An adversarial review of a prior HARNESS-W07 commit found this test
  // rewritten to check `current <= entry.ceiling` instead — a per-module
  // ratchet ceiling the SAME commit authored from the module's own oversized
  // measured size — which let `policy.extracted_module_ceiling` survive only
  // as the self-referential assertion below, applied to no file on the tree.
  // That was reverted; a second review then found the reverted check's
  // SUBJECT SET was still a hardcoded three-element list that excluded the
  // six further-derived children the same commit created, so the restored
  // flat check bound a 61-line barrel and two files never near the limit —
  // constraining nothing real (control: a hypothetical 900-line derived
  // module with its own budget entry left every check, including this one,
  // passing). The subject set below is now the full `derived_from` closure
  // rooted at the E2E entrypoint, computed rather than hand-listed, so a
  // later split or addition is bound automatically.
  const modules = extractedModulesDerivedFrom(policy, E2E_EXTRACTION_ROOT);
  assert.ok(
    modules.length >= 3,
    "the E2E extraction's derived_from graph produced no modules -- the policy is missing the extraction's budget entries",
  );

  // A-42 backstop against the residual escape hatch the second review named:
  // derived_from is author-controlled data, so a budgeted e2e-browser-*.mjs
  // file that simply OMITS the field would fall out of the closure and out of
  // this gate. Every budgeted file in the family, other than the entrypoint
  // and the audio harness, must therefore appear in the computed closure.
  const closure = new Set(modules);
  for (const entry of policy.budgets) {
    if (!/^scripts\/e2e-browser-.*\.mjs$/.test(entry.path)) continue;
    if (entry.path.endsWith(".test.mjs")) continue;
    if (entry.path === "scripts/e2e-browser-audio.mjs") continue;
    assert.ok(
      closure.has(entry.path),
      `${entry.path} is a budgeted E2E-family module missing from the derived_from closure -- ` +
        "declare its derived_from lineage so the flat cap binds it",
    );
  }

  for (const modulePath of modules) {
    if (!(await exists(modulePath))) {
      continue;
    }
    const entry = byPath.get(modulePath);
    assert.ok(entry, `${modulePath} exists but carries no budget entry`);
    const current = await lineCount(modulePath);

    const exception = exceptionByPath.get(modulePath);
    if (exception) {
      const debt = policy.accepted_debt.find(
        (record) => record.id === exception.debtId && record.path === modulePath,
      );
      if (debt) {
        // The named exception is live: the flat cap does not bind this
        // file while its cited debt record still names it. Its ordinary
        // ratchet ceiling still applies, separately (checked above by "no
        // budgeted file exceeds its ceiling").
        // A-42: the disclosure the coordinator ratifies must stay true —
        // the recorded overage tracks the file's real size, so ratchet-legal
        // growth cannot silently stale the number.
        assert.equal(
          debt.remaining_lines,
          current - policy.extracted_module_ceiling,
          `${modulePath}'s accepted-debt remaining_lines is stale: recorded ` +
            `${debt.remaining_lines}, actual overage ${current - policy.extracted_module_ceiling}`,
        );
        continue;
      }
      // The debt record retired (its id was dropped from accepted_debt, or
      // its `path` was repointed off this file): the exception lapses and
      // the flat cap re-arms for this file with no edit needed here.
    }

    assert.ok(
      current <= policy.extracted_module_ceiling,
      `${modulePath}: ${current} lines exceeds the plan's flat ${policy.extracted_module_ceiling}-line extracted-module ceiling. Owner: Plan 12`,
    );
  }
});

test("root package.json exposes module:concentration and validate runs it", async () => {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const scripts = rootPackage.scripts ?? {};

  assert.equal(
    scripts["module:concentration"],
    "node --test scripts/module-concentration-policy.test.mjs",
  );
  assert.match(
    scripts.validate ?? "",
    /(^|&&\s*)bun run module:concentration(\s|$)/,
    `validate must run the concentration ratchet; got: ${scripts.validate}`,
  );
});
