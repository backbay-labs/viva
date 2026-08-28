import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

/**
 * `RELEASE-027`: the required-workflow contract, asserted against the *parsed*
 * job/step structures rather than against workflow source text.
 *
 * The reviewed baseline test matched source strings, so it could not tell an
 * active step from a commented-out one, a required job from a
 * `workflow_dispatch`-only job, or a pinned action from a mutable tag that
 * merely mentions a version. Every assertion below reads the YAML document the
 * runner itself would execute, using the exact root `yaml` 2.8.2 dev dependency
 * locked and audited in `RELEASE-024`.
 */

const WORKFLOW_PATH = ".github/workflows/validate.yml";
const DEPENDABOT_PATH = ".github/dependabot.yml";
const DURABLE_SCRIPT_PATH = "scripts/ci-durable-postgres.sh";

/** The three proof jobs the stable aggregate job requires, plus the aggregate. */
const PROOF_JOBS = ["quality-and-audit", "loopback-and-browser", "durable-postgres"];
const AGGREGATE_JOB = "required-validation";

async function loadWorkflow() {
  const source = await readFile(WORKFLOW_PATH, "utf8");
  return { source, workflow: parse(source) };
}

async function loadRootPackage() {
  return JSON.parse(await readFile("package.json", "utf8"));
}

/** Every step of every job, tagged with the job it belongs to. */
function allSteps(workflow) {
  return Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
    (job.steps ?? []).map((step, index) => ({ jobId, index, step })),
  );
}

function jobSteps(workflow, jobId) {
  const job = workflow.jobs[jobId];
  assert.ok(job, `workflow must define the ${jobId} job`);
  return job.steps ?? [];
}

/** Index of the first step in `jobId` whose `run` contains `needle`. */
function runStepIndex(workflow, jobId, needle) {
  return jobSteps(workflow, jobId).findIndex(
    (step) => typeof step.run === "string" && step.run.includes(needle),
  );
}

function runStepsContaining(workflow, needle) {
  return allSteps(workflow).filter(
    ({ step }) => typeof step.run === "string" && step.run.includes(needle),
  );
}

/**
 * Reserved static-export tokens are assembled from fragments so this policy
 * test never itself becomes a hit for `RELEASE-031`'s repository-wide
 * deletion-proof scan (and so that scan needs no exclusion for it).
 */
const STATIC = ["STAT", "IC"].join("");
const STATIC_LOWER = STATIC.toLowerCase();
const STATIC_TITLE = `${STATIC[0]}${STATIC_LOWER.slice(1)}`;
const RESERVED_STATIC_TOKENS = Object.freeze([
  ["VIVA", STATIC, "EXPORT"].join("_"),
  ["NEXT", "PUBLIC", "VIVA", STATIC, "EXPORT"].join("_"),
  `viva${STATIC_TITLE}Export${"Enabled"}`,
  `${STATIC_LOWER}${"Export"}`,
  ["build", STATIC_LOWER].join(":"),
  ["e2e", STATIC_LOWER].join(":"),
]);

/**
 * Every `bun run <script>` the required workflow reaches — directly, or through
 * a root script it invokes — must resolve to a declared script. A command that
 * does not resolve makes the job red by construction, and nothing else in this
 * file would notice: the parsed-step assertions check that a command is *there*,
 * never that it can run.
 *
 * Two do not resolve on this tree, both by design and both mandated by Task 17
 * Step 4 item 1: `RELEASE-024`'s dependency audit and `RELEASE-030`'s module
 * concentration ratchet are Plan 12 Tasks 14 and 16, authored by this lane's
 * parallel manifest/ratchet unit. This unit must not add them — guessing another
 * unit's script body, and colliding with its `package.json` hunk, is worse than
 * declaring the dependency.
 *
 * So it is declared: enumerated, owner-attributed, and exact in BOTH directions.
 * A third unresolved command fails, and so does an entry whose script has since
 * landed — the integration wave that merges both units must empty this map, and
 * cannot quietly leave a stale excuse behind.
 */
// Both declared handoffs landed in the combined 12B admission that merged the
// parallel units, and this map emptied in the same wave — its own rule above.
const PENDING_CROSS_UNIT_SCRIPTS = new Map([]);

/** Every `bun run` invocation in `text`, as `{ cwd, script }`. */
function bunRunInvocations(text) {
  const invocations = [];
  const pattern = /\bbun run (?:--cwd (\S+) )?([A-Za-z0-9][A-Za-z0-9:._-]*)/g;
  for (const match of text.matchAll(pattern)) {
    invocations.push({ cwd: match[1], script: match[2] });
  }
  return invocations;
}

/** Executable step text only: a commented-out command is not an invocation. */
function executableRunBodies(workflow) {
  return allSteps(workflow)
    .filter(({ step }) => typeof step.run === "string")
    .map(({ jobId, step }) => ({
      where: `workflow job ${jobId}`,
      text: step.run
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n"),
    }));
}

test("every bun run command the workflow reaches resolves, or is a recorded cross-unit pending", async () => {
  const { workflow } = await loadWorkflow();
  const rootPackage = await loadRootPackage();
  const appPackage = JSON.parse(await readFile("apps/web/package.json", "utf8"));

  const sources = [
    ...executableRunBodies(workflow),
    ...Object.entries(rootPackage.scripts).map(([name, body]) => ({
      where: `root script ${name}`,
      text: body,
    })),
  ];

  const unresolved = [];
  for (const { where, text } of sources) {
    for (const { cwd, script } of bunRunInvocations(text)) {
      const manifest = cwd === undefined ? rootPackage : cwd === "apps/web" ? appPackage : null;
      assert.ok(manifest, `${where} runs a script in unmapped workspace ${cwd}`);
      if (manifest.scripts?.[script] !== undefined) continue;
      unresolved.push({ where, script, cwd });
    }
  }

  const blocking = unresolved
    .filter(({ cwd, script }) => cwd !== undefined || !PENDING_CROSS_UNIT_SCRIPTS.has(script))
    .map(({ where, script }) => `${where}: bun run ${script}`);
  assert.deepEqual(
    blocking,
    [],
    "these commands resolve to no declared script and no recorded cross-unit handoff covers " +
      "them, so the job is red by construction",
  );

  // Exact the other way too: an entry whose script has landed is a stale excuse.
  for (const [script, owner] of PENDING_CROSS_UNIT_SCRIPTS) {
    assert.equal(
      rootPackage.scripts[script],
      undefined,
      `"${script}" (${owner}) has landed — delete its PENDING_CROSS_UNIT_SCRIPTS entry so this ` +
        "gate asserts the resolved command instead of excusing it",
    );
    assert.ok(
      unresolved.some((entry) => entry.script === script),
      `"${script}" (${owner}) is excused but nothing invokes it; delete the entry`,
    );
  }
});

test("the required workflow grants only least-privilege top-level permissions", async () => {
  const { workflow } = await loadWorkflow();

  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    assert.equal(
      job.permissions,
      undefined,
      `${jobId} must inherit the least-privilege top-level permissions`,
    );
  }
});

test("every action reference is an immutable 40-character commit SHA with a reviewable version comment", async () => {
  const { source, workflow } = await loadWorkflow();

  const uses = allSteps(workflow)
    .map(({ jobId, step }) => ({ jobId, uses: step.uses }))
    .filter((entry) => entry.uses !== undefined);
  assert.ok(uses.length > 0, "the workflow must reference at least one action");

  for (const { jobId, uses: reference } of uses) {
    assert.match(
      reference,
      /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/,
      `${jobId} pins ${reference} to a mutable ref instead of a commit SHA`,
    );
  }

  // Dependabot rewrites the SHA and the trailing comment together; without the
  // comment a reviewer cannot tell which release a 40-hex ref actually is.
  for (const line of source.split("\n")) {
    if (!line.includes("uses:")) continue;
    assert.match(
      line,
      /uses: \S+@[0-9a-f]{40} # \S+/,
      `pinned action line lacks its version comment: ${line.trim()}`,
    );
  }
});

test("Node 24, Bun 1.3.3, and both Rust toolchains are explicit and correctly ordered", async () => {
  const { workflow } = await loadWorkflow();
  const steps = allSteps(workflow).map(({ jobId, index, step }) => ({ jobId, index, step }));

  const nodeSteps = steps.filter(({ step }) => step.uses?.startsWith("actions/setup-node@"));
  assert.ok(nodeSteps.length > 0, "a required job must set up Node explicitly");
  for (const { step } of nodeSteps) {
    assert.equal(String(step.with?.["node-version"]), "24");
  }

  const bunSteps = steps.filter(({ step }) => step.uses?.startsWith("oven-sh/setup-bun@"));
  assert.ok(bunSteps.length > 0, "a required job must set up Bun explicitly");
  for (const { step } of bunSteps) {
    assert.equal(step.with?.["bun-version"], "1.3.3");
  }

  const rustSteps = steps.filter(({ step }) => step.uses?.startsWith("dtolnay/rust-toolchain@"));
  assert.ok(rustSteps.length > 0, "a required job must install Rust explicitly");
  for (const { step } of rustSteps) {
    // The action derives its toolchain from the git ref when no input is given.
    // A SHA-pinned ref carries no version, so the toolchain must be explicit or
    // the job silently installs whatever the action defaults to.
    assert.ok(step.with?.toolchain, "a SHA-pinned rust-toolchain step must name its toolchain");
  }

  const qualityRust = jobSteps(workflow, "quality-and-audit")
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.uses?.startsWith("dtolnay/rust-toolchain@"));
  const nightly = qualityRust.find(({ step }) => step.with.toolchain === "nightly-2026-04-21");
  const pinned = qualityRust.find(({ step }) => step.with.toolchain === "1.94.1");
  assert.ok(nightly, "quality-and-audit must install the pinned cargo-udeps nightly");
  assert.ok(pinned, "quality-and-audit must install the pinned 1.94.1 toolchain");
  assert.ok(
    nightly.index < pinned.index,
    "1.94.1 must install last so it, not the nightly, is the default toolchain",
  );
});

test("cargo-audit, cargo-udeps, and cargo-mutants install at their exact pinned versions with --locked", async () => {
  const { workflow } = await loadWorkflow();
  const installs = runStepsContaining(workflow, "cargo install").map(({ step }) => step.run);
  const expected = [
    ["cargo-audit", "0.22.0"],
    ["cargo-udeps", "0.1.60"],
    ["cargo-mutants", "25.3.1"],
  ];

  for (const [tool, version] of expected) {
    const matching = installs.filter((run) => run.includes(tool));
    assert.equal(matching.length, 1, `${tool} must be installed exactly once`);
    assert.match(
      matching[0],
      new RegExp(`cargo install ${tool} --version ${version.replace(/\./g, "\\.")} --locked`),
      `${tool} must install at exactly ${version} with --locked`,
    );
  }
});

test("no required step re-enables the loopback test skip", async () => {
  const { source, workflow } = await loadWorkflow();
  const rootPackage = await loadRootPackage();

  assert.doesNotMatch(source, /VIVA_ALLOW_LOOPBACK_TEST_SKIP/);
  assert.equal(runStepsContaining(workflow, "VIVA_ALLOW_LOOPBACK_TEST_SKIP").length, 0);
  assert.doesNotMatch(rootPackage.scripts["agent:test"], /VIVA_ALLOW_LOOPBACK_TEST_SKIP/);
  assert.doesNotMatch(rootPackage.scripts.validate, /VIVA_ALLOW_LOOPBACK_TEST_SKIP/);
  assert.doesNotMatch(rootPackage.scripts["validate:agent"], /VIVA_ALLOW_LOOPBACK_TEST_SKIP/);
});

test("no required job or step can mask its own failure", async () => {
  const { workflow } = await loadWorkflow();

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["continue-on-error"], undefined, `${jobId} must not continue on error`);
    for (const step of job.steps ?? []) {
      assert.equal(
        step["continue-on-error"],
        undefined,
        `a step in ${jobId} must not continue on error`,
      );
    }
  }
});

test("no required step reads a provider key, production signing secret, or session secret", async () => {
  const { source, workflow } = await loadWorkflow();

  // The no-secret validation workflow reads no repository secret at all: one
  // `secrets.` expression is enough to hand a required job a live credential.
  assert.doesNotMatch(source, /\bsecrets\./);

  const forbidden = [
    "CARTESIA_API_KEY",
    "GEMINI_API_KEY",
    "VIVA_RELEASE_BUNDLE_SIGNING_SECRET",
    "VIVA_VOICE_SESSION_TOKEN_SECRET",
    "VIVA_VOICE_WS_BEARER_TOKEN",
    "VIVA_FAILURE_CONTROL_SECRET",
    "VIVA_E2E_HOSTED_REST_BEARER_TOKEN",
  ];
  for (const { jobId, step } of allSteps(workflow)) {
    const env = Object.keys(step.env ?? {});
    for (const name of forbidden) {
      assert.ok(!env.includes(name), `${jobId} must not pass ${name} to a required step`);
      if (typeof step.run === "string") {
        assert.ok(!step.run.includes(name), `${jobId} must not reference ${name}`);
      }
    }
  }
  for (const name of forbidden) {
    assert.ok(!Object.keys(workflow.env ?? {}).includes(name));
  }
});

test("the default validation step carries no ambient provider selection", async () => {
  const { workflow } = await loadWorkflow();
  const validate = runStepsContaining(workflow, "bun run validate");

  assert.equal(validate.length, 1, "bun run validate must run exactly once");
  // An ambient `VIVA_AGENT_PROVIDER` on this step is a real fault, not a
  // stylistic one: `scripts/live-provider-smoke.mjs` refuses outright when an
  // ambient provider disagrees with its own configured provider
  // (RELEASE-016/021), and `agent-service`'s config reads the same variable
  // during `agent:test`. Turbo does not declare it, so no package task needs it.
  assert.equal(validate[0].step.env?.VIVA_AGENT_PROVIDER, undefined);
});

test("CI never pairs a bare cargo test name with --exact", async () => {
  const { workflow } = await loadWorkflow();
  const durable = await readFile(DURABLE_SCRIPT_PATH, "utf8");

  // `cargo test <bare name> -- --exact` exits 0 while selecting zero tests, so
  // a renamed or moved test silently turns a required proof into a no-op. The
  // release orchestrator's one legitimate `--exact` use is scoped to a single
  // `--test` binary *and* parses the log for one executed test; nothing in the
  // workflow or the durable script may reintroduce the unguarded form.
  for (const { jobId, step } of allSteps(workflow)) {
    if (typeof step.run !== "string") continue;
    assert.ok(!step.run.includes("--exact"), `${jobId} must not filter cargo tests with --exact`);
  }
  // Comment lines are excluded deliberately: the durable script's header explains
  // why the flag is absent, and that explanation must not read as a violation.
  const executable = durable
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.ok(!executable.includes("--exact"), "the durable script must not filter with --exact");
  assert.match(executable, /--ignored --test-threads=1/);
});

test("root package.json maps the purity and residue gates and validate:agent runs both unmasked", async () => {
  const rootPackage = await loadRootPackage();

  assert.equal(rootPackage.scripts["agent:purity"], "scripts/check-agent-domain-purity.sh");
  assert.equal(rootPackage.scripts["agent:residue"], "scripts/check-legacy-domain-residue.sh");

  const validateAgent = rootPackage.scripts["validate:agent"];
  assert.match(validateAgent, /bun run agent:purity/);
  assert.match(validateAgent, /bun run agent:residue/);
  // `&&` propagates the first non-zero status; `;`, `||`, and `|| true` do not.
  assert.doesNotMatch(validateAgent, /;|\|\||set \+e/);
  assert.match(rootPackage.scripts.validate, /bun run validate:agent/);
});

test("the legacy-domain residue gate keeps every pattern that makes it a gate", async () => {
  // Wiring `agent:residue` into `validate:agent` unmasked (the test above) is
  // what makes this gate load-bearing — and the moment a required command turns
  // red, the cheapest-looking fix is to narrow the pattern that caught it. It is
  // also the only fix that would be wrong: the recorded remedy for merged legacy
  // vocabulary is A-11's reword of the offending line, with the gate untouched.
  //
  // So the gate's own vocabulary is pinned here. Narrowing it now fails this
  // test before it can quietly launder residue past `bun run validate`.
  const gate = await readFile("scripts/check-legacy-domain-residue.sh", "utf8");

  const pattern = gate.match(/^residue_pattern="(.+)"$/m);
  assert.ok(pattern, "the residue gate must declare a single residue_pattern");
  for (const vocabulary of [
    "LUCA_",
    "Chef Luca",
    "luca_prompt",
    "CookingSession",
    "Voice Lab",
    "safety_confirm",
    "start_cook",
    "recipe",
    "ingredient",
    "allergen",
    "pantry",
    "fridge",
    "KB_SNAPSHOT_PATH",
  ]) {
    assert.ok(
      pattern[1].includes(vocabulary),
      `the residue gate no longer scans for ${vocabulary}`,
    );
  }

  // Scope and verdict, not just vocabulary: a gate that scans nothing, or that
  // reports a hit without failing, is narrowed just as effectively.
  assert.match(gate, /^search_roots="agent packages apps"$/m);
  assert.match(gate, /rg -n -i "\$\{residue_pattern\}"/);
  assert.match(gate, /Luca domain residue found[\s\S]*?exit 1/);
});

/** Direct `[dependencies]` names declared by a Cargo manifest, in order. */
function directCargoDependencies(manifestText) {
  const section = manifestText.split(/^\[/m).find((block) => block.startsWith("dependencies]"));
  if (section === undefined) return [];
  return section
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.match(/^([A-Za-z0-9_-]+)\s*[.=]/))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}

test("the recorded D-04 branch is readable from agent-domain's own direct dependencies", async () => {
  // Plan Step 1's purity clause: direct `chrono`/`uuid` in the domain crate are
  // allowed only for `SOFT_DELETE_UNDO`; `CONFIRM_DELETE` requires them absent.
  //
  // As amended by the coordinator's Plan 06 sequencing note item 2, `chrono` is
  // struck from that absence set: Plan 03's merged `D-01 SERVER_PERSISTED_FSRS`
  // seam legitimately declares it for the review-scheduling authority, which has
  // nothing to do with deletion. `uuid` carries the whole clause.
  const manifest = await readFile("agent/crates/agent-domain/Cargo.toml", "utf8");
  const direct = directCargoDependencies(manifest);

  assert.ok(direct.includes("chrono"), "D-01's scheduling seam declares chrono directly");
  assert.ok(
    !direct.includes("uuid"),
    "the recorded D-04 CONFIRM_DELETE branch has no soft-delete identity to mint, so agent-domain " +
      "must declare no direct uuid dependency",
  );

  // Controls for the reader, so the parser is not trusted on one real input.
  assert.deepEqual(
    directCargoDependencies(
      '[dependencies]\nchrono.workspace = true\nuuid = "1"\n\n[dev-dependencies]\nproptest = "1"\n',
    ),
    ["chrono", "uuid"],
  );
  assert.deepEqual(directCargoDependencies('[dev-dependencies]\nuuid = "1"\n'), []);
  assert.deepEqual(directCargoDependencies('[dependencies]\n# uuid = "1"\n'), []);
});

test("Plan 06's domain-quality policy test, once it lands, names the gates this wiring provides", async () => {
  // Plan Step 1's remaining purity clause names `scripts/rust-domain-quality-policy.test.mjs`,
  // which is absent from this tree by the coordinator's own Plan 06 sequencing
  // note item 1: the commit stays on lane 06's branch and merges in this 12B
  // wave, because it asserts the very commands and workflow steps this task adds.
  //
  // Nothing is fabricated in its place. This arms itself the moment the file
  // lands and then proves the handoff is the one this wiring implements.
  const policyPath = "scripts/rust-domain-quality-policy.test.mjs";
  let policy;
  try {
    policy = await readFile(policyPath, "utf8");
  } catch (error) {
    assert.equal(error.code, "ENOENT", `${policyPath} could not be read: ${error.message}`);
    return;
  }

  const rootPackage = await loadRootPackage();
  for (const script of ["agent:deps:unused", "agent:domain:mutants"]) {
    assert.ok(policy.includes(script), `${policyPath} must name the ${script} gate`);
    assert.ok(rootPackage.scripts[script], `this wiring must provide the ${script} gate`);
  }
  assert.ok(policy.includes(WORKFLOW_PATH), `${policyPath} must read the required workflow`);
});

test("root package.json exposes the exact Plan 06 unused-dependency and mutation commands", async () => {
  const rootPackage = await loadRootPackage();

  assert.equal(
    rootPackage.scripts["agent:deps:unused"],
    "cargo +nightly-2026-04-21 udeps --manifest-path agent/Cargo.toml --workspace --all-targets",
  );
  assert.equal(
    rootPackage.scripts["agent:domain:mutants"],
    "cargo mutants --manifest-path agent/crates/agent-domain/Cargo.toml -p agent-domain " +
      "-F 'response_id|can_transition_to|restart_after_cancellation|terminate|terminal_reason|" +
      "require_failure|sanitize_stage_token|sanitize_stage_metadata|is_durability|" +
      "pending_answer_attempts_for_session|record_voice_session|study_session_durable_counts|" +
      "answer_attempt_was_recorded|close_voice_session|active_question|record_voice_usage|" +
      "record_turn_outcome|session_learning_evidence|record_challenge_resolution|" +
      "select_next_question|authenticated_study_projection|restore_study_set|" +
      "finalize_expired_study_set_deletions|try_new|validate_fail_closed|pcm16_base64|" +
      "from_base64' --timeout 120",
  );
});

test("agent:deps:unused carries no allowlist under either recorded D-04 branch", async () => {
  const rootPackage = await loadRootPackage();
  const command = rootPackage.scripts["agent:deps:unused"];

  // An allowlist is exactly how an unused-dependency proof is neutered: under
  // `CONFIRM_DELETE` the domain crate must carry neither `chrono` nor `uuid`,
  // and under `SOFT_DELETE_UNDO` it must carry both as genuinely used direct
  // dependencies. Neither branch may be reached by excluding the crate.
  assert.doesNotMatch(command, /--exclude\b|--allow\b|--ignore\b|allowlist/);
  assert.match(command, /--workspace --all-targets$/);
});

test("quality-and-audit runs the Plan 06 unused-dependency and focused mutation proofs", async () => {
  const { workflow } = await loadWorkflow();

  for (const command of ["bun run agent:deps:unused", "bun run agent:domain:mutants"]) {
    const matches = runStepsContaining(workflow, command);
    assert.equal(matches.length, 1, `${command} must run exactly once`);
    assert.equal(matches[0].jobId, "quality-and-audit");
    assert.equal(matches[0].step["continue-on-error"], undefined);
  }
});

test("quality-and-audit executes the strict script tests, the audit, and the concentration ratchet on Node 24", async () => {
  const { workflow } = await loadWorkflow();
  const rootPackage = await loadRootPackage();

  const scriptTests = runStepsContaining(workflow, "node --test scripts/*.test.mjs");
  assert.equal(scriptTests.length, 1, "the Node script tests must run exactly once");
  assert.equal(scriptTests[0].jobId, "quality-and-audit");

  const setupNode = jobSteps(workflow, "quality-and-audit").findIndex((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  assert.ok(setupNode >= 0, "quality-and-audit must set up Node 24 before running the script tests");
  assert.ok(setupNode < scriptTests[0].index);

  for (const command of ["bun run audit", "bun run module:concentration"]) {
    const matches = runStepsContaining(workflow, command);
    assert.equal(matches.length, 1, `${command} must run exactly once`);
    assert.equal(matches[0].jobId, "quality-and-audit");
  }

  // `RELEASE-030`'s `module:concentration` script and its `validate` wiring are
  // authored by this lane's manifest/ratchet unit (Plan 12 Task 14/16); once the
  // script exists, `validate` must be the thing that runs it.
  if (rootPackage.scripts["module:concentration"]) {
    assert.match(rootPackage.scripts.validate, /module:concentration/);
  }
});

test("the Turbo cache-restoration proof runs exactly once, immediately after the normal build", async () => {
  const { workflow } = await loadWorkflow();
  const steps = jobSteps(workflow, "quality-and-audit");

  // `RELEASE-031`'s branch-neutral wiring: Plan 14 assigns it to this lane under
  // both D-06 branches, and it must sit against the ordinary build it proves the
  // cache restores — not against a static one, which no longer exists.
  const build = steps.findIndex(
    (step) => typeof step.run === "string" && step.run.trim() === "bun run build",
  );
  const proof = steps.findIndex(
    (step) => typeof step.run === "string" && step.run.trim() === "bun run build:cache:prove",
  );
  assert.ok(build >= 0, "quality-and-audit must run the normal build");
  assert.ok(proof >= 0, "quality-and-audit must prove Turbo cache restoration");
  assert.equal(proof, build + 1, "the cache proof must run immediately after the normal build");
  assert.equal(runStepsContaining(workflow, "bun run build:cache:prove").length, 1);
});

test("the durable Postgres proof runs on pull requests and main pushes, not only workflow_dispatch", async () => {
  const { workflow } = await loadWorkflow();

  assert.ok("pull_request" in workflow.on, "the workflow must run on pull requests");
  assert.deepEqual(workflow.on.push.branches, ["main"]);

  const durable = workflow.jobs["durable-postgres"];
  assert.ok(durable, "the workflow must define a durable-postgres job");
  assert.equal(
    durable.if,
    undefined,
    "durable-postgres must not be gated behind an event condition",
  );

  const image = durable.services.postgres.image;
  assert.match(image, /^postgres:16@sha256:[0-9a-f]{64}$/, "the Postgres service must be digest-pinned");
});

test("the durable job delegates all orchestration to scripts/ci-durable-postgres.sh", async () => {
  const { workflow } = await loadWorkflow();
  const steps = jobSteps(workflow, "durable-postgres");
  const runs = steps.filter((step) => typeof step.run === "string");

  assert.equal(runs.length, 1, "the durable job must run exactly one command");
  assert.equal(runs[0].run.trim(), "scripts/ci-durable-postgres.sh");
  for (const step of steps) {
    if (typeof step.run !== "string") continue;
    assert.ok(!step.run.includes("cargo test"), "the durable job must not duplicate cargo orchestration in YAML");
  }
});

test("A-43(b)/R-12-B: durable-postgres refuses the PENDING A-32 seed path, asserting the landed end state", async () => {
  const { workflow } = await loadWorkflow();
  const [step] = jobSteps(workflow, "durable-postgres").filter(
    (candidate) => typeof candidate.run === "string" && candidate.run.trim() === "scripts/ci-durable-postgres.sh",
  );
  assert.ok(step, "the durable-postgres proof step must exist");
  assert.equal(
    String(step.env?.VIVA_CI_POSTGRES_SEED_REQUIRED),
    "1",
    "VIVA_CI_POSTGRES_SEED_REQUIRED=1 must be set so the A-32 fixture-seeding command is mandatory, " +
      "never a silently accepted pending state, now that lane 08's viva-dev-seed-fixture binary exists",
  );
});

test("the browser job runs both frontend harnesses after the pinned Chromium install", async () => {
  const { workflow } = await loadWorkflow();
  const job = "loopback-and-browser";

  const chromium = runStepIndex(workflow, job, "playwright install");
  const accessibility = runStepIndex(workflow, job, "node scripts/frontend-accessibility.mjs");
  const performance = runStepIndex(workflow, job, "node scripts/frontend-performance.mjs");

  assert.ok(chromium >= 0, "the browser job must install the pinned Chromium");
  assert.ok(accessibility > chromium, "the accessibility harness must run after Chromium install");
  assert.ok(performance > chromium, "the performance harness must run after Chromium install");
});

test("the browser job runs the loopback replay, both voice matrices, and the audio negative control", async () => {
  const { workflow } = await loadWorkflow();
  const job = "loopback-and-browser";

  assert.ok(runStepIndex(workflow, job, "bun run agent:replay:ws") >= 0);
  assert.ok(runStepIndex(workflow, job, "bun run e2e:browser:audio:negative") >= 0);

  const matrices = jobSteps(workflow, job).filter(
    (step) => typeof step.run === "string" && step.run.includes("bun run e2e:browser") &&
      !step.run.includes("audio"),
  );
  assert.equal(matrices.length, 2, "both the synthetic and fake-provider matrices must run");
  const providers = matrices.map((step) => step.env?.VIVA_E2E_AGENT_PROVIDER).sort();
  assert.deepEqual(providers, ["fake_cartesia_gemini", "synthetic"]);
  for (const step of matrices) {
    assert.equal(step.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO, "1");
    assert.equal(step.env.VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX, "1");
  }
});

test("artifact upload runs only after release evidence and redaction succeed and archives no trace or source bundle", async () => {
  const { workflow } = await loadWorkflow();
  const job = "loopback-and-browser";
  const steps = jobSteps(workflow, job);

  const releaseCheck = runStepIndex(workflow, job, "bun run release:check");
  const redaction = runStepIndex(workflow, job, "bun run redaction:check");
  const upload = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));

  assert.ok(releaseCheck >= 0, "the browser job must produce sanitized release evidence");
  assert.ok(redaction >= 0, "the browser job must run the redaction control gate");
  assert.ok(upload > releaseCheck, "upload must follow the release evidence gate");
  assert.ok(upload > redaction, "upload must follow the redaction gate");
  assert.equal(steps[upload].if, "success()");

  const paths = steps[upload].with.path
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    assert.ok(!/trace|\.zip|source|\.map$/.test(path), `upload must not archive ${path}`);
  }
  // The frontend harnesses contribute exactly their sanitized result document.
  const frontend = paths.filter((path) => path.startsWith("artifacts/frontend-"));
  assert.deepEqual(frontend, ["artifacts/frontend-performance/result.json"]);
});

test("required-validation is a stable aggregate that fails on any non-success upstream result", async () => {
  const { workflow } = await loadWorkflow();
  const job = workflow.jobs[AGGREGATE_JOB];

  assert.ok(job, "the workflow must expose one stable required job");
  assert.equal(job.if, "always()");
  assert.deepEqual([...job.needs].sort(), [...PROOF_JOBS].sort());

  // The gate is the LAST run-based step, not the only one: A-43(a)'s hosted
  // consumption boundary adds prior steps to this same job (never a sibling
  // job -- `needs` above is asserted exactly, so nothing else could gate the
  // aggregate), and the pass/fail check must still run last, unconditionally.
  // Exact count, not a lower bound (review-fix F2): install + place + verify
  // + the gate itself -- an arbitrary extra run step landing in this
  // branch-protection-context job must fail here, not slip in unnoticed.
  const steps = job.steps.filter((step) => typeof step.run === "string");
  assert.equal(
    steps.length,
    4,
    "required-validation must carry exactly its known run steps (install, place, verify, gate)",
  );
  const assertion = steps.at(-1);
  assert.equal(String(assertion.if).trim(), "always()", "the gate must run even if earlier steps in this job were skipped");
  const values = Object.values(assertion.env);
  for (const proofJob of PROOF_JOBS) {
    assert.ok(
      values.some((value) => value === `\${{ needs.${proofJob}.result }}`),
      `the aggregate must read ${proofJob}'s result`,
    );
  }
  // A skipped or cancelled upstream job reports `skipped`/`cancelled`, never
  // `success`, so equality (not `!= failure`) is what keeps it red.
  for (const name of Object.keys(assertion.env)) {
    assert.match(assertion.run, new RegExp(`test "\\$${name}" = success`));
  }
});

test("A-43(a)/R-12-A: required-validation downloads the selected stored release bundle and verifies it in a fresh environment", async () => {
  const { workflow } = await loadWorkflow();
  const steps = jobSteps(workflow, AGGREGATE_JOB);
  const text = (step) =>
    [
      typeof step.run === "string" ? step.run : "",
      typeof step.uses === "string" ? step.uses : "",
      JSON.stringify(step.with ?? {}),
    ].join("\n");

  const verifyIndex = steps.findIndex(
    (step) => typeof step.run === "string" && step.run.includes("bun run release:verify"),
  );
  assert.ok(verifyIndex >= 0, "required-validation must verify the downloaded release bundle");
  const verify = steps[verifyIndex];
  assert.ok(
    verify.run.includes("bun run release:verify -- artifacts/downloaded-release/evidence.json"),
    "the boundary must run exactly the documented command",
  );
  assert.equal(
    steps.filter((step) => typeof step.run === "string" && step.run.includes("bun run release:verify")).length,
    1,
    "exactly one step may verify the stored release bundle",
  );

  // Never regenerated in the same job as it is verified (the boundary
  // consumes a STORED bundle; loopback-and-browser already owns generating
  // one via `bun run release:check`).
  assert.equal(
    steps.some((step) => typeof step.run === "string" && step.run.includes("bun run release:check")),
    false,
    "required-validation must verify the stored bundle, never regenerate the one it verifies",
  );

  // Downloaded to the exact documented path, before verification, never from
  // a mutable "latest" object.
  const downloadIndex = steps.findIndex(
    (step, index) => index < verifyIndex && text(step).includes("artifacts/downloaded-release/evidence.json"),
  );
  assert.ok(downloadIndex >= 0, "the stored bundle must be downloaded to artifacts/downloaded-release/evidence.json first");
  assert.doesNotMatch(text(steps[downloadIndex]), /latest/i, "a mutable latest object may not be selected");

  // The artifact name is keyed by this exact commit's own upload
  // (loopback-and-browser's `viva-release-evidence-${{ github.sha }}`), a
  // deterministic selection by SHA, never a separately-named "latest" pointer.
  const downloadArtifact = steps.find((step) => String(step.uses ?? "").startsWith("actions/download-artifact@"));
  assert.ok(downloadArtifact, "the boundary must use actions/download-artifact");
  assert.equal(downloadArtifact.with?.name, "viva-release-evidence-${{ github.sha }}");

  // Runs only once loopback-and-browser (which produced the bundle) has
  // actually succeeded -- never against a job that failed or was skipped.
  for (const index of [downloadIndex, verifyIndex]) {
    assert.equal(
      String(steps[index].if).trim(),
      "needs.loopback-and-browser.result == 'success'",
      "the boundary steps must not run against a bundle that was never produced",
    );
  }
});

test("Dependabot covers github-actions, npm, and cargo weekly with bounded open-PR limits", async () => {
  const dependabot = parse(await readFile(DEPENDABOT_PATH, "utf8"));

  assert.equal(dependabot.version, 2);
  const expected = [
    ["github-actions", "/"],
    ["npm", "/"],
    ["cargo", "/agent"],
  ];
  assert.equal(dependabot.updates.length, expected.length);
  for (const [ecosystem, directory] of expected) {
    const entry = dependabot.updates.find(
      (candidate) =>
        candidate["package-ecosystem"] === ecosystem && candidate.directory === directory,
    );
    assert.ok(entry, `dependabot must cover ${ecosystem} at ${directory}`);
    assert.equal(entry.schedule.interval, "weekly");
    assert.equal(typeof entry["open-pull-requests-limit"], "number");
    assert.ok(entry["open-pull-requests-limit"] > 0 && entry["open-pull-requests-limit"] <= 10);
  }
  const seen = new Set(
    dependabot.updates.map((entry) => `${entry["package-ecosystem"]}@${entry.directory}`),
  );
  assert.equal(seen.size, dependabot.updates.length, "each entry must name a unique target");
});

test("the sanitized release evidence bundle contract from the reviewed baseline is preserved", async () => {
  const { workflow } = await loadWorkflow();
  const job = "loopback-and-browser";
  const steps = jobSteps(workflow, job);
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));

  assert.equal(upload.with.name, "viva-release-evidence-${{ github.sha }}");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 14);

  const paths = upload.with.path.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const required of [
    "artifacts/release-check/evidence.json",
    "artifacts/release-check/*.stdout.log",
    "artifacts/release-check/*.stderr.log",
    "artifacts/e2e-browser/browser-story.json",
    "artifacts/e2e-browser/result.json",
    "artifacts/e2e-browser/*.png",
  ]) {
    assert.ok(paths.includes(required), `upload must retain ${required}`);
  }

  const redaction = steps.find(
    (step) => typeof step.run === "string" && step.run.includes("bun run redaction:check"),
  );
  assert.equal(
    redaction.env.VIVA_REDACTION_BASE_REF,
    "${{ github.event.pull_request.base.sha || github.event.before || 'origin/main' }}",
  );
});

test("no active workflow step names a reserved static-export token (D-06B)", async () => {
  const { workflow } = await loadWorkflow();

  for (const { jobId, step } of allSteps(workflow)) {
    const text = [
      typeof step.run === "string" ? step.run : "",
      JSON.stringify(step.env ?? {}),
      JSON.stringify(step.with ?? {}),
    ].join("\n");
    for (const token of RESERVED_STATIC_TOKENS) {
      assert.ok(!text.includes(token), `${jobId} still references the removed ${token}`);
    }
  }
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const text = JSON.stringify(job.env ?? {});
    for (const token of RESERVED_STATIC_TOKENS) {
      assert.ok(!text.includes(token), `${jobId} still exports the removed ${token}`);
    }
  }
});
