// INTEGRATION-006 — integration-owned acceptance of the Plan 12 hosted-validation handoff.
//
// Plan 12 is the sole workflow owner. These are the CONSUMER's acceptance tests: Plan 15
// asserts the contract it depends on and, when an assertion fails, returns the exact
// expectation to Plan 12 rather than patching `.github/workflows/validate.yml` or any
// Plan-12-owned test. Every file this suite reads is read-only to this lane, and the
// mutation controls at the bottom run against in-memory clones, so no Plan-12 file is ever
// written — not even transiently.
//
// The rules read the parsed YAML the runner would execute, never the source text alone, so
// a commented-out step, a `workflow_dispatch`-only job, or a mutable tag that merely
// mentions a version cannot satisfy them. Each rule is stated once and then proved
// load-bearing by a mutation that must make it throw; a rule that survives its own mutation
// is a hard failure, because a green acceptance suite that cannot fail accepts nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { PROGRAM_NODES } from "./integration-readiness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = ".github/workflows/validate.yml";
const DURABLE_SCRIPT = "scripts/ci-durable-postgres.sh";
const DURABLE_TEST = "scripts/ci-durable-postgres.test.mjs";
const WORKFLOW_TEST = "scripts/validate-workflow.test.mjs";
const CONTRACT_TEST = "scripts/release-contract-validation.test.mjs";
const PACKAGE_TEST = "scripts/package-build-contract.test.mjs";

const PROOF_JOBS = ["quality-and-audit", "loopback-and-browser", "durable-postgres"];
const AGGREGATE_JOB = "required-validation";
const AGGREGATE_NAME = "Required validation";
const SKIP_AUTHORITY = "VIVA_ALLOW_LOOPBACK_TEST_SKIP";
const PINNED_SHA = /@[0-9a-f]{40}$/;

const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");
const WORKFLOW_SOURCE = read(WORKFLOW_PATH);

/** One immutable snapshot per rule invocation, so a mutation can never leak sideways. */
const context = () => {
  const workflow = parse(WORKFLOW_SOURCE);
  const jobs = workflow.jobs;
  const steps = (job) => jobs[job]?.steps ?? [];
  return {
    source: WORKFLOW_SOURCE,
    workflow,
    jobs,
    steps,
    allSteps: () => Object.values(jobs).flatMap((job) => job.steps ?? []),
    runText: (job) =>
      steps(job)
        .map((step) => String(step.run ?? ""))
        .join("\n"),
    files: {
      durable: read(DURABLE_SCRIPT),
      durableTest: read(DURABLE_TEST),
      workflowTest: read(WORKFLOW_TEST),
      contractTest: read(CONTRACT_TEST),
      packageTest: read(PACKAGE_TEST),
    },
  };
};

// --- Task 6 Step 3's hosted consumption boundary ---
//
// The boundary downloads the SELECTED stored bundle and verifies it unmodified. It is absent
// from this tree (routing item R-12-A, returned to Plan 12), so the rule below is conditional:
// it says nothing while nothing has landed, and it refuses a wrong landing — a boundary that
// regenerates the bundle it verifies, selects a mutable `latest` object, verifies a path other
// than the plan's, or verifies before downloading. Stating the contract executably is what
// makes the routing item actionable instead of prose.
const HOSTED_BUNDLE = "artifacts/downloaded-release/evidence.json";
const HOSTED_VERIFY = `bun run release:verify -- ${HOSTED_BUNDLE}`;

const stepText = (step) =>
  [
    String(step.run ?? ""),
    String(step.uses ?? ""),
    JSON.stringify(step.with ?? {}),
    JSON.stringify(step.env ?? {}),
  ].join("\n");

const jobSteps = (jobs) =>
  Object.entries(jobs).flatMap(([job, definition]) =>
    (definition.steps ?? []).map((step, index) => ({ job, index, text: stepText(step) })),
  );

const hostedConsumptionBoundaryPresent = (jobs) =>
  jobSteps(jobs).some(
    (entry) => entry.text.includes("release:verify") || entry.text.includes("downloaded-release"),
  );

function assertHostedConsumptionBoundary(jobs) {
  const entries = jobSteps(jobs);
  const verifiers = entries.filter((entry) => entry.text.includes("release:verify"));
  assert.equal(verifiers.length, 1, "exactly one step may verify the stored release bundle");
  const [verify] = verifiers;
  assert.ok(verify.text.includes(HOSTED_VERIFY), `the boundary must run exactly: ${HOSTED_VERIFY}`);
  const siblings = entries.filter((entry) => entry.job === verify.job);
  const regenerates = siblings.filter((entry) => entry.text.includes("release:check"));
  assert.equal(
    regenerates.length,
    0,
    `${verify.job} must verify the stored bundle, never regenerate the one it verifies`,
  );
  const downloads = siblings.filter(
    (entry) => entry.index < verify.index && entry.text.includes(HOSTED_BUNDLE),
  );
  assert.ok(downloads.length > 0, `the stored bundle must be downloaded to ${HOSTED_BUNDLE} first`);
  for (const download of downloads) {
    assert.doesNotMatch(download.text, /latest/i, "a mutable latest object may not be selected");
  }
}

/** Task 6 Step 1's required properties and Step 3's published job contracts. */
const RULES = [
  {
    id: "permissions",
    title: "top-level permissions grant only contents: read",
    run: (c) => assert.deepEqual(c.workflow.permissions, { contents: "read" }),
  },
  {
    id: "pinned_actions",
    title: "every action is pinned to a full 40-character commit SHA, never a floating tag",
    run: (c) => {
      const uses = c
        .allSteps()
        .map((step) => step.uses)
        .filter(Boolean);
      assert.ok(uses.length > 0, "the workflow must use at least one action");
      for (const reference of uses) {
        assert.match(reference, PINNED_SHA, `${reference} is not pinned to a commit SHA`);
        assert.doesNotMatch(reference, /@v\d+(\.\d+)*$/, `${reference} is a floating tag`);
      }
    },
  },
  {
    id: "runtime_pins",
    title: "Node 24, Bun 1.3.3, and Rust 1.94.1 are set up explicitly",
    run: (c) => {
      const withUses = (needle) =>
        c.allSteps().filter((step) => String(step.uses ?? "").includes(needle));
      const node = withUses("actions/setup-node");
      assert.ok(node.length > 0, "the workflow must set up Node explicitly");
      for (const setup of node) assert.equal(String(setup.with["node-version"]), "24");
      const bun = withUses("oven-sh/setup-bun");
      assert.ok(bun.length > 0, "the workflow must set up Bun explicitly");
      for (const setup of bun) assert.equal(String(setup.with["bun-version"]), "1.3.3");
      const rust = withUses("rust-toolchain").map((step) => String(step.with.toolchain));
      assert.ok(rust.includes("1.94.1"), "Rust 1.94.1 must be the default toolchain");
      assert.ok(rust.includes("nightly-2026-04-21"), "the lane-pinned nightly must be installed");
    },
  },
  {
    id: "published_jobs",
    title: "the three proof jobs and the stable aggregate exist under their published ids",
    run: (c) => {
      for (const job of [...PROOF_JOBS, AGGREGATE_JOB]) {
        assert.ok(Object.hasOwn(c.jobs, job), `Plan 12 must publish the stable job id ${job}`);
      }
      assert.equal(c.jobs[AGGREGATE_JOB].name, AGGREGATE_NAME);
    },
  },
  {
    id: "quality_and_audit",
    title: "quality-and-audit runs the frozen install and every required proof command",
    run: (c) => {
      const runs = c.runText("quality-and-audit");
      for (const command of [
        "bun install --frozen-lockfile",
        "node --test scripts/*.test.mjs",
        "bun run audit",
        "bun run module:concentration",
        "bun run validate",
        "bun run agent:deps:unused",
        "bun run agent:domain:mutants",
      ]) {
        assert.ok(runs.includes(command), `quality-and-audit must run ${command}`);
      }
      // The real Node import of `@viva/core/runtime-validation` and the hostile
      // unknown-field/bypass tests reach CI through the Node 24 script suite above.
      assert.match(c.files.contractTest, /@viva\/core\/runtime-validation/);
      assert.match(c.files.packageTest, /@viva\/core\/runtime-validation/);
    },
  },
  {
    id: "loopback_replay",
    title: "loopback-and-browser runs the direct WebSocket replay with no skip authority",
    run: (c) => {
      assert.equal(c.jobs["loopback-and-browser"].needs, "quality-and-audit");
      assert.ok(c.runText("loopback-and-browser").includes("bun run agent:replay:ws"));
      assert.equal(c.source.includes(SKIP_AUTHORITY), false, `${SKIP_AUTHORITY} must never be set`);
    },
  },
  {
    id: "browser_matrix",
    title: "both browser matrix commands require the transport matrix and bind the deploy SHA",
    run: (c) => {
      const browserSteps = c
        .steps("loopback-and-browser")
        .filter((step) => String(step.run ?? "").trim() === "bun run e2e:browser");
      assert.equal(browserSteps.length, 2, "both browser matrix commands are required");
      for (const provider of ["synthetic", "fake_cartesia_gemini"]) {
        const step = browserSteps.find((entry) => entry.env?.VIVA_E2E_AGENT_PROVIDER === provider);
        assert.ok(step, `the ${provider} browser matrix command is required`);
        assert.equal(String(step.env.VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX), "1");
        assert.equal(String(step.env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO), "1");
        assert.match(String(step.env.VIVA_E2E_DEPLOY_SHA), /github\.sha|git rev-parse HEAD/);
        assert.match(
          String(step.env.VIVA_E2E_ARTIFACT_DIR),
          /^artifacts\/ci\/browser-voice-matrix\//,
        );
      }
    },
  },
  {
    id: "durable_triggers",
    title: "durable-postgres runs on pull_request, push to main, and workflow_dispatch",
    run: (c) => {
      const on = c.workflow.on ?? c.workflow[true];
      assert.ok(Object.hasOwn(on, "pull_request"), "pull_request must trigger the workflow");
      assert.ok(Object.hasOwn(on, "workflow_dispatch"), "workflow_dispatch must trigger it");
      assert.deepEqual(on.push.branches, ["main"]);
      assert.equal(
        Object.hasOwn(c.jobs["durable-postgres"], "if"),
        false,
        "durable-postgres must not be narrowed below the workflow triggers by an if: condition",
      );
    },
  },
  {
    id: "durable_service",
    title: "durable-postgres uses a digest-pinned PostgreSQL 16 service and the behavioral script",
    run: (c) => {
      const service = c.jobs["durable-postgres"].services.postgres;
      assert.match(String(service.image), /^postgres:16@sha256:[0-9a-f]{64}$/);
      assert.ok(c.runText("durable-postgres").includes(DURABLE_SCRIPT));
      assert.ok(c.files.durableTest.includes(DURABLE_SCRIPT), "the script needs a behavioral test");
      for (const filter of [
        "DATA_POSTGRES_REQUIRED",
        "SERVICE_POSTGRES_REQUIRED",
        "viva_data_test",
        "viva_service_test",
        "--ignored --test-threads=1 --nocapture",
      ]) {
        assert.ok(c.files.durable.includes(filter), `${DURABLE_SCRIPT} must use ${filter}`);
      }
      // If 12B still carried its reviewed pre-handoff `optional_postgres` filters the
      // durable proof would select zero tests; the script must refuse such a log instead.
      assert.match(c.files.durable, /optional_postgres.*instead of the required-mode suite/s);
    },
  },
  {
    id: "aggregate",
    title: "required-validation is if: always() and fails unless every upstream result is success",
    run: (c) => {
      const aggregate = c.jobs[AGGREGATE_JOB];
      assert.equal(String(aggregate.if).trim(), "always()");
      assert.deepEqual(aggregate.needs, PROOF_JOBS);
      const gate = c.steps(AGGREGATE_JOB).at(-1);
      for (const job of PROOF_JOBS) {
        assert.ok(
          JSON.stringify(gate.env).includes(`needs.${job}.result`),
          `the aggregate must read needs.${job}.result`,
        );
      }
      const successes = String(gate.run).match(/= success/g) ?? [];
      assert.equal(successes.length, PROOF_JOBS.length, "every upstream result must be success");
    },
  },
  {
    id: "upload_order",
    title: "the evidence bundle is uploaded only after redaction and evidence validation",
    run: (c) => {
      const browserSteps = c.steps("loopback-and-browser");
      const index = (needle) =>
        browserSteps.findIndex((step) => String(step.run ?? "").includes(needle));
      const upload = browserSteps.findIndex((step) =>
        String(step.uses ?? "").includes("upload-artifact"),
      );
      assert.ok(upload >= 0, "the sanitized bundle must be uploaded");
      const release = index("bun run release:check");
      const redaction = index("bun run redaction:check");
      assert.ok(release >= 0, "release evidence must be generated before upload");
      assert.ok(redaction >= 0, "redaction must run before upload");
      assert.ok(release < upload, "release:check must precede the upload");
      assert.ok(redaction < upload, "redaction:check must precede the upload");
      assert.equal(String(browserSteps[upload].if).trim(), "success()");
    },
  },
  {
    id: "no_secrets",
    title: "no default job reads a provider key or a production secret",
    run: (c) => {
      assert.equal(c.source.includes("secrets."), false, "no default job may read a secret");
      for (const step of c.allSteps()) {
        for (const key of Object.keys(step.env ?? {})) {
          assert.doesNotMatch(key, /_API_KEY$|_SECRET$|_BEARER_TOKEN$/, key);
        }
      }
    },
  },
  {
    id: "hosted_consumption",
    title: "a landed hosted consumption boundary verifies the stored bundle without remaking it",
    run: (c) => {
      // Absent at this tree; R-12-A returns the expectation to Plan 12. A partial or wrong
      // landing is caught here rather than passing because no rule mentioned it.
      if (!hostedConsumptionBoundaryPresent(c.jobs)) return;
      assertHostedConsumptionBoundary(c.jobs);
    },
  },
  {
    id: "no_continue_on_error",
    title: "no required step opts out of failing the job",
    run: (c) => {
      for (const [name, job] of Object.entries(c.jobs)) {
        for (const step of job.steps ?? []) {
          assert.notEqual(step["continue-on-error"], true, `${name}: ${step.name}`);
        }
        assert.notEqual(job["continue-on-error"], true, `${name} must not continue on error`);
      }
    },
  },
];

for (const rule of RULES) {
  test(`Plan 12 handoff: ${rule.title}`, () => rule.run(context()));
}

/**
 * One mutation per rule, applied to an in-memory clone. Plan-12-owned files are never
 * written; the mutation exists only inside this process.
 */
const MUTATIONS = [
  ["permissions", (c) => Object.assign(c.workflow, { permissions: { contents: "write" } })],
  ["pinned_actions", (c) => (c.jobs["quality-and-audit"].steps[0].uses = "actions/checkout@v4")],
  ["runtime_pins", (c) => (c.jobs["quality-and-audit"].steps[1].with["node-version"] = 22)],
  ["published_jobs", (c) => (c.jobs[AGGREGATE_JOB].name = "Validation")],
  [
    "quality_and_audit",
    (c) => {
      const steps = c.jobs["quality-and-audit"].steps;
      c.jobs["quality-and-audit"].steps = steps.filter(
        (step) => !String(step.run ?? "").includes("bun run agent:domain:mutants"),
      );
    },
  ],
  ["loopback_replay", (c) => (c.source = `${c.source}\n      ${SKIP_AUTHORITY}: "1"\n`)],
  [
    "browser_matrix",
    (c) => {
      const step = c.jobs["loopback-and-browser"].steps.find(
        (entry) => entry.env?.VIVA_E2E_AGENT_PROVIDER === "synthetic",
      );
      step.env.VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX = "0";
    },
  ],
  [
    "durable_triggers",
    (c) => (c.jobs["durable-postgres"].if = "github.event_name == 'workflow_dispatch'"),
  ],
  [
    "durable_service",
    (c) => (c.files.durable = c.files.durable.replaceAll("SERVICE_POSTGRES_REQUIRED", "X")),
  ],
  ["aggregate", (c) => (c.jobs[AGGREGATE_JOB].if = "success()")],
  [
    "upload_order",
    (c) => {
      const steps = c.jobs["loopback-and-browser"].steps;
      const upload = steps.findIndex((step) => String(step.uses ?? "").includes("upload-artifact"));
      steps.unshift(steps.splice(upload, 1)[0]);
    },
  ],
  ["no_secrets", (c) => (c.jobs["quality-and-audit"].steps[0].env = { CARTESIA_API_KEY: "x" })],
  [
    // A wrong landing, not an absent one: the boundary exists and regenerates the bundle it
    // then "verifies", with no download step at all.
    "hosted_consumption",
    (c) =>
      c.jobs["loopback-and-browser"].steps.push({
        name: "Verify the release bundle",
        run: `bun run release:check\n${HOSTED_VERIFY}`,
      }),
  ],
  [
    "no_continue_on_error",
    (c) => (c.jobs["durable-postgres"].steps.at(-1)["continue-on-error"] = true),
  ],
];

test("every acceptance rule is load-bearing under its own mutation", () => {
  assert.equal(MUTATIONS.length, RULES.length, "every rule needs a mutation control");
  for (const [id, mutate] of MUTATIONS) {
    const rule = RULES.find((entry) => entry.id === id);
    assert.ok(rule, `no rule named ${id}`);
    const mutated = context();
    mutate(mutated);
    assert.throws(
      () => rule.run(mutated),
      (error) => error instanceof assert.AssertionError,
      `the ${id} rule survived its mutation and therefore accepts nothing`,
    );
    // The real files are untouched: a fresh context still satisfies the rule.
    rule.run(context());
  }
});

// --- R-12-A: the hosted consumption boundary Plan 12 has not landed yet ---

const boundaryJobs = (steps) => ({ "hosted-release-verification": { steps } });
const DOWNLOAD = {
  name: "Download the selected stored bundle",
  run: `aws s3 cp "s3://viva-release/\${{ needs.publish.outputs.object_key }}" ${HOSTED_BUNDLE}`,
};
const VERIFY = {
  name: "Verify the downloaded bundle",
  run: `VIVA_RELEASE_BUNDLE_SIGNING_SECRET="$VIVA_RELEASE_BUNDLE_SIGNING_SECRET" \\\n  ${HOSTED_VERIFY}`,
};

test("the hosted consumption boundary contract accepts a correct landing", () => {
  assertHostedConsumptionBoundary(boundaryJobs([DOWNLOAD, VERIFY]));
  assert.equal(hostedConsumptionBoundaryPresent(boundaryJobs([DOWNLOAD, VERIFY])), true);
  assert.equal(hostedConsumptionBoundaryPresent(boundaryJobs([])), false);
});

test("every way of landing the boundary wrongly is refused", () => {
  const defects = [
    ["no download at all", [VERIFY], /must be downloaded to/],
    ["verified before downloading", [VERIFY, DOWNLOAD], /must be downloaded to/],
    [
      "regenerated instead of consumed",
      [DOWNLOAD, { name: "Regenerate", run: "bun run release:check" }, VERIFY],
      /never regenerate the one it verifies/,
    ],
    [
      "a mutable latest object selected",
      [{ ...DOWNLOAD, run: `aws s3 cp "s3://viva-release/latest.json" ${HOSTED_BUNDLE}` }, VERIFY],
      /mutable latest object/,
    ],
    [
      "a different bundle path verified",
      [
        { ...DOWNLOAD, run: `aws s3 cp "s3://viva-release/k" ${HOSTED_BUNDLE}` },
        { name: "Verify", run: "bun run release:verify -- artifacts/release-check/evidence.json" },
      ],
      /must run exactly/,
    ],
    ["verified twice", [DOWNLOAD, VERIFY, { ...VERIFY, name: "Again" }], /exactly one step/],
  ];
  for (const [label, steps, message] of defects) {
    assert.throws(
      () => assertHostedConsumptionBoundary(boundaryJobs(steps)),
      (error) => error instanceof assert.AssertionError && message.test(error.message),
      `a boundary with ${label} must be refused`,
    );
  }
});

test("routing item R-12-A: Plan 12 has not landed the hosted consumption boundary", (t) => {
  const { jobs } = context();
  if (hostedConsumptionBoundaryPresent(jobs)) {
    // It landed: the contract above is now the acceptance, and a wrong landing fails here.
    assertHostedConsumptionBoundary(jobs);
    return;
  }
  assert.equal(WORKFLOW_SOURCE.includes("release:verify"), false);
  assert.equal(WORKFLOW_SOURCE.includes("downloaded-release"), false);
  t.diagnostic(
    `R-12-A ROUTED TO PLAN 12: no workflow step downloads the selected stored bundle to ` +
      `${HOSTED_BUNDLE} and runs \`${HOSTED_VERIFY}\`. Plan 15 owns none of ${WORKFLOW_PATH} ` +
      `and must not patch it; the contract is executable in this file's boundary rule.`,
  );
});

test("record-handoff binds the four Plan 12 workflow files to the 12A/12B node records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "viva-handoff-"));
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const laneInputs = PROGRAM_NODES.map((node, index) => ({
      node_id: node.node_id,
      namespace: node.namespace,
      topological_rank: node.topological_rank,
      pr_number: 101 + index,
      pr_head_sha: `${node.node_id.toLowerCase()}`.padEnd(40, "0"),
      integration_merge_sha: `${node.node_id.toLowerCase()}m`.padEnd(40, "0"),
      owner_acknowledged_handoff: true,
    }));
    await writeFile(
      path.join(directory, "lane-inputs.json"),
      JSON.stringify({ frozen_sha: head, lane_inputs: laneInputs }),
    );
    const output = path.join(directory, "plan-12-workflow-handoff.json");
    execFileSync(
      "node",
      [
        path.join(repoRoot, "scripts", "integration-readiness.mjs"),
        "record-handoff",
        "--namespace",
        "RELEASE",
        "--files",
        [WORKFLOW_PATH, WORKFLOW_TEST, DURABLE_SCRIPT, DURABLE_TEST].join(","),
        "--frozen-sha",
        head,
        "--output",
        output,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const handoff = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(
      handoff.nodes.map((node) => node.node_id),
      ["12A", "12B"],
    );
    assert.deepEqual(
      handoff.files.map((file) => file.path),
      [WORKFLOW_PATH, WORKFLOW_TEST, DURABLE_SCRIPT, DURABLE_TEST],
    );
    for (const file of handoff.files) {
      assert.equal(
        file.bound_node_id,
        "12B",
        "the workflow artifact binds to the final lane merge",
      );
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(handoff.owner_acknowledged_handoff, true);
    // The stable check names the branch-protection context depends on come from the same
    // workflow this handoff hashes, so the two halves of the evidence cannot drift apart.
    const { jobs } = context();
    assert.deepEqual(Object.keys(jobs), [...PROOF_JOBS, AGGREGATE_JOB]);
    assert.equal(jobs[AGGREGATE_JOB].name, AGGREGATE_NAME);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Plan 15 owns none of the files this suite inspects", () => {
  for (const owned of [WORKFLOW_PATH, WORKFLOW_TEST, DURABLE_SCRIPT, DURABLE_TEST]) {
    assert.ok(read(owned).length > 0, `${owned} must exist for the handoff to be verifiable`);
  }
  assert.equal(read(WORKFLOW_TEST).includes("integration-readiness"), false);
});
