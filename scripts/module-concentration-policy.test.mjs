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
  "scripts/e2e-browser.mjs": { lines: 2881, owner: "Plan 12" },
  "scripts/e2e-browser-audio.mjs": { lines: 628, owner: "Plan 12" },
  "scripts/live-provider-smoke.test.mjs": { lines: 2320, owner: "Plan 12" },
  "scripts/live-provider-smoke.mjs": { lines: 1498, owner: "Plan 12" },
  "scripts/hosted-monitor-runner.mjs": { lines: 1390, owner: "Plan 12" },
  "scripts/hosted-monitor-runner.test.mjs": { lines: 1982, owner: "Plan 12" },
  "scripts/redaction-control.mjs": { lines: 3195, owner: "Plan 12" },
  // A-37: re-frozen at the combined 12B admission — the A-31.4 closures
  // landed after the original freeze. The JSON entry carries the record.
  "scripts/frontend-accessibility.mjs": { lines: 2929, owner: "Plan 13" },
  "scripts/frontend-quality.test.mjs": { lines: 1956, owner: "Plan 13" },
});

/** Modules the E2E extraction must produce, each capped at the module ceiling. */
const PLANNED_E2E_MODULES = Object.freeze([
  "scripts/e2e-browser-plan.mjs",
  "scripts/e2e-browser-runtime.mjs",
  "scripts/e2e-browser-story.mjs",
]);

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

  // Lane 09's two deferred sub-splits and Plan 12's own deferred E2E extraction
  // must each be present by id — a silent drop is a policy failure.
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

test("every extracted E2E module that exists stays inside the 600-line module ceiling", async () => {
  const policy = await readPolicy();

  for (const modulePath of PLANNED_E2E_MODULES) {
    if (!(await exists(modulePath))) {
      continue;
    }
    const current = await lineCount(modulePath);
    assert.ok(
      current <= policy.extracted_module_ceiling,
      `${modulePath}: ${current} lines exceeds the ${policy.extracted_module_ceiling}-line ` +
        "extracted-module ceiling. Owner: Plan 12",
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
