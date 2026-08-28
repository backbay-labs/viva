import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_MAX_EVIDENCE_AGE_SECONDS } from "./production-release-gate.mjs";
import {
  matrixResultsFromHostedMonitorEvidence,
  readHostedMonitorEvidence,
  readProviderFailureObservations,
} from "./release-evidence-imports.mjs";

const now = new Date("2026-06-27T20:30:00.000Z");

test("hosted monitor evidence resolves the real mode/run manifest path by default", async () => {
  const root = await tempRoot();
  try {
    const manifestPath = path.join(root, "artifacts/hosted-monitor/pr/release-run-1/manifest.json");
    await writeJson(manifestPath, hostedManifest({ run_id: "release-run-1" }));

    const manifest = await readHostedMonitorEvidence({
      env: { VIVA_RELEASE_RUN_ID: "release-run-1" },
      mode: "production",
      now,
      root,
    });

    assert.equal(manifest.run_id, "release-run-1");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("hosted monitor evidence rejects stale or deploy-mismatched production manifests", () => {
  assert.throws(
    () =>
      matrixResultsFromHostedMonitorEvidence(
        hostedManifest({ generated_at: "2026-06-25T20:00:00.000Z" }),
        {
          env: productionDeployEnv(),
          now,
          productionRequested: true,
          requiredScenarioIds: ["provider_rate_limited"],
        },
      ),
    /hosted monitor manifest is stale/,
  );

  assert.throws(
    () =>
      matrixResultsFromHostedMonitorEvidence(
        hostedManifest({
          runs: [
            hostedRun("provider_rate_limited", {
              hosted_e2e: {
                deploy_ids: { web: "wrong-web", agent: "agent-1" },
                failure_class: null,
                terminal_reason: "completed",
                recap_success: true,
              },
            }),
          ],
        }),
        {
          env: productionDeployEnv(),
          now,
          productionRequested: true,
          requiredScenarioIds: ["provider_rate_limited"],
        },
      ),
    /hosted monitor deploy identity mismatch/,
  );
});

test("hosted monitor evidence must cover every production recovery scenario", () => {
  assert.throws(
    () =>
      matrixResultsFromHostedMonitorEvidence(hostedManifest(), {
        env: productionDeployEnv(),
        now,
        productionRequested: true,
        requiredScenarioIds: ["provider_rate_limited", "invalid_token"],
      }),
    /hosted monitor manifest missing required production scenarios: invalid_token/,
  );
});

test("provider failure observations are loaded from release evidence artifacts", async () => {
  const root = await tempRoot();
  try {
    const observationsPath = path.join(root, "artifacts/provider-failure-observability/observations.json");
    await writeJson(observationsPath, {
      schema: "viva.provider_failure_observations.v1",
      generated_at: now.toISOString(),
      run_id: "release-run-1",
      observations: [
        { query_id: "provider_429", sanitized: true },
        { query_id: "provider_timeout", sanitized: true },
      ],
      sanitized: true,
    });

    const observations = await readProviderFailureObservations({
      env: { VIVA_RELEASE_RUN_ID: "release-run-1" },
      now,
      productionRequested: true,
      requiredQueryIds: ["provider_429", "provider_timeout"],
      root,
    });

    assert.deepEqual(
      observations.map((entry) => entry.query_id),
      ["provider_429", "provider_timeout"],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("hosted monitor evidence requires VIVA_RELEASE_RUN_ID before resolving any production path, even an explicit manifest path", async () => {
  const root = await tempRoot();
  try {
    const manifestPath = path.join(root, "artifacts/hosted-monitor/pr/release-run-1/manifest.json");
    await writeJson(manifestPath, hostedManifest({ run_id: "release-run-1" }));

    await assert.rejects(
      () =>
        readHostedMonitorEvidence({
          env: { VIVA_RELEASE_HOSTED_MONITOR_MANIFEST_PATH: manifestPath },
          mode: "production",
          now,
          productionRequested: true,
          root,
        }),
      /VIVA_RELEASE_RUN_ID/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("hosted monitor evidence rejects a manifest whose run_id differs by one character", async () => {
  const root = await tempRoot();
  try {
    const manifestPath = path.join(root, "artifacts/hosted-monitor/pr/release-run-1/manifest.json");
    await writeJson(manifestPath, hostedManifest({ run_id: "release-run-2" }));

    await assert.rejects(
      () =>
        readHostedMonitorEvidence({
          env: {
            VIVA_RELEASE_RUN_ID: "release-run-1",
            VIVA_RELEASE_HOSTED_MONITOR_MANIFEST_PATH: manifestPath,
          },
          mode: "production",
          now,
          productionRequested: true,
          root,
        }),
      /run_id does not match VIVA_RELEASE_RUN_ID/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("hosted monitor evidence rejects a manifest with sanitized missing, null, or false", async () => {
  const root = await tempRoot();
  try {
    for (const sanitizedValue of [undefined, null, false]) {
      const manifest = hostedManifest({ run_id: "release-run-1" });
      if (sanitizedValue === undefined) delete manifest.sanitized;
      else manifest.sanitized = sanitizedValue;
      const manifestPath = path.join(root, "artifacts/hosted-monitor/pr/release-run-1/manifest.json");
      await writeJson(manifestPath, manifest);

      await assert.rejects(
        () =>
          readHostedMonitorEvidence({
            env: {
              VIVA_RELEASE_RUN_ID: "release-run-1",
              VIVA_RELEASE_HOSTED_MONITOR_MANIFEST_PATH: manifestPath,
            },
            mode: "production",
            now,
            productionRequested: true,
            root,
          }),
        /sanitized/,
        `sanitized=${sanitizedValue} must be rejected`,
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("hosted monitor evidence never falls back to the lexicographic latest manifest in production", async () => {
  const root = await tempRoot();
  try {
    // Lexicographically, "run-2" sorts after "run-1" -- a "latest" fallback
    // would silently pick "run-2", an arbitrary unrequested run, for a
    // production release that never named which run it wanted.
    await writeJson(
      path.join(root, "artifacts/hosted-monitor/pr/run-1/manifest.json"),
      hostedManifest({ run_id: "run-1" }),
    );
    await writeJson(
      path.join(root, "artifacts/hosted-monitor/pr/run-2/manifest.json"),
      hostedManifest({ run_id: "run-2" }),
    );

    await assert.rejects(
      () =>
        readHostedMonitorEvidence({
          env: {},
          mode: "production",
          now,
          productionRequested: true,
          root,
        }),
      /VIVA_RELEASE_RUN_ID/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("hosted monitor evidence may still use the lexicographic latest manifest for non-production convenience", async () => {
  const root = await tempRoot();
  try {
    await writeJson(
      path.join(root, "artifacts/hosted-monitor/pr/run-1/manifest.json"),
      hostedManifest({ run_id: "run-1" }),
    );
    await writeJson(
      path.join(root, "artifacts/hosted-monitor/pr/run-2/manifest.json"),
      hostedManifest({ run_id: "run-2" }),
    );

    const manifest = await readHostedMonitorEvidence({
      env: {},
      mode: "production",
      now,
      productionRequested: false,
      root,
    });

    assert.equal(manifest.run_id, "run-2");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("hosted monitor evidence requires complete expected deploy identity in production before trusting any run's reported deploy ids", () => {
  assert.throws(
    () =>
      matrixResultsFromHostedMonitorEvidence(hostedManifest(), {
        // VIVA_RELEASE_WEB_DEPLOY_ID/VIVA_RELEASE_AGENT_DEPLOY_ID absent --
        // silently skipping the deploy-identity check here would let a
        // manifest's own (unverified) deploy ids stand in unexamined.
        env: { VIVA_RELEASE_RUN_ID: "release-run-1" },
        now,
        productionRequested: true,
        requiredScenarioIds: ["provider_rate_limited"],
      }),
    /deploy identity/,
  );
});

test("hosted monitor evidence checks every passed run's deploy ids against the selected target, not only required-scenario runs", () => {
  assert.throws(
    () =>
      matrixResultsFromHostedMonitorEvidence(
        hostedManifest({
          runs: [
            hostedRun("happy_path", {
              hosted_e2e: {
                deploy_ids: { web: "wrong-web", agent: "agent-1" },
                failure_class: null,
                terminal_reason: "completed",
                recap_success: true,
              },
            }),
            hostedRun("provider_rate_limited"),
          ],
        }),
        {
          env: productionDeployEnv(),
          now,
          productionRequested: true,
          // "happy_path" is deliberately NOT a required recovery scenario,
          // yet its wrong deploy id must still be caught.
          requiredScenarioIds: ["provider_rate_limited"],
        },
      ),
    /hosted monitor deploy identity mismatch for happy_path/,
  );
});

test("ROW 337/RELEASE-007: a passed hosted-monitor run with a missing, false, or non-boolean sanitized field fails the whole import closed instead of being silently dropped from results", () => {
  for (const sanitizedValue of [undefined, false, "yes", 1]) {
    const run = hostedRun("provider_rate_limited");
    if (sanitizedValue === undefined) delete run.sanitized;
    else run.sanitized = sanitizedValue;

    assert.throws(
      () =>
        matrixResultsFromHostedMonitorEvidence(hostedManifest({ runs: [run] }), {
          env: {},
          now,
          productionRequested: false,
          requiredScenarioIds: [],
        }),
      /must be sanitized/,
      `sanitized=${JSON.stringify(sanitizedValue)} must fail closed, not be silently filtered out`,
    );
  }

  // A run that never claims "passed" is not a candidate for results at all
  // -- this row is scoped to the sanitized field specifically, not a general
  // widening of what counts as a result.
  assert.doesNotThrow(() =>
    matrixResultsFromHostedMonitorEvidence(
      hostedManifest({ runs: [hostedRun("provider_rate_limited", { status: "failed", sanitized: false })] }),
      { env: {}, now, productionRequested: false, requiredScenarioIds: [] },
    ),
  );
});

test("ROW 337/RELEASE-007: a provider-failure observation entry with a missing, false, or non-boolean sanitized field fails the whole import closed instead of being silently dropped", async () => {
  const root = await tempRoot();
  try {
    for (const sanitizedValue of [undefined, false, "yes", 1]) {
      const observationsPath = path.join(
        root,
        "artifacts/provider-failure-observability/observations.json",
      );
      const observation = { query_id: "provider_429", sanitized: true };
      if (sanitizedValue === undefined) delete observation.sanitized;
      else observation.sanitized = sanitizedValue;
      await writeJson(observationsPath, {
        schema: "viva.provider_failure_observations.v1",
        generated_at: now.toISOString(),
        run_id: "release-run-1",
        observations: [observation],
        sanitized: true,
      });

      await assert.rejects(
        () =>
          readProviderFailureObservations({
            env: { VIVA_RELEASE_RUN_ID: "release-run-1" },
            now,
            productionRequested: false,
            requiredQueryIds: [],
            root,
          }),
        /must be sanitized/,
        `observation sanitized=${JSON.stringify(sanitizedValue)} must fail closed, not be silently filtered out`,
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("ROW 337/RELEASE-007: a non-production import of top-level-unsanitized provider-failure observability evidence fails closed", async () => {
  const root = await tempRoot();
  try {
    const observationsPath = path.join(root, "artifacts/provider-failure-observability/observations.json");
    await writeJson(observationsPath, {
      schema: "viva.provider_failure_observations.v1",
      generated_at: now.toISOString(),
      run_id: "release-run-1",
      observations: [{ query_id: "provider_429", sanitized: true }],
      sanitized: false,
    });

    // Unlike the manifest/run/observation-entry checks above, this is proof
    // that the *existing* top-level throw (release-evidence-imports.mjs's
    // `if (evidence.sanitized !== true)`) actually executes -- it was never
    // exercised by any prior test, production-required or not.
    await assert.rejects(
      () =>
        readProviderFailureObservations({
          env: { VIVA_RELEASE_RUN_ID: "release-run-1" },
          now,
          productionRequested: false,
          requiredQueryIds: [],
          root,
        }),
      /provider failure observations must be sanitized/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("provider failure observations are required for production release checks", async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(
      () =>
        readProviderFailureObservations({
          env: {},
          now,
          productionRequested: true,
          requiredQueryIds: ["provider_429"],
          root,
        }),
      /provider failure observations are required/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("ROW 341/RELEASE-011: the hosted-monitor import rejection boundary's default staleness window is the exact same DEFAULT_MAX_EVIDENCE_AGE_SECONDS constant the release gate uses, not an independently-declared duplicate that happens to share its value", async () => {
  const root = await tempRoot();
  try {
    const manifestPath = path.join(root, "artifacts/hosted-monitor/pr/release-run-1/manifest.json");
    // One second past the shared canonical default -- if the rejection
    // boundary declared its own duplicate literal (even a byte-identical
    // one), this could still drift from the real constant on any future
    // edit; a genuinely shared import cannot.
    await writeJson(
      manifestPath,
      hostedManifest({
        run_id: "release-run-1",
        generated_at: new Date(now.getTime() - (DEFAULT_MAX_EVIDENCE_AGE_SECONDS + 1) * 1000).toISOString(),
      }),
    );

    await assert.rejects(
      () =>
        readHostedMonitorEvidence({
          env: {
            VIVA_RELEASE_RUN_ID: "release-run-1",
            VIVA_RELEASE_HOSTED_MONITOR_MANIFEST_PATH: manifestPath,
          },
          mode: "production",
          now,
          productionRequested: true,
          root,
        }),
      /hosted monitor manifest is stale/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("ROW 341/RELEASE-011: only VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS -- the same override the bundle and gate honor -- controls the hosted-monitor import's staleness window; the old, wrong-priority VIVA_RELEASE_HOSTED_MONITOR_MAX_AGE_SECONDS no longer has any effect", async () => {
  const root = await tempRoot();
  try {
    const manifestPath = path.join(root, "artifacts/hosted-monitor/pr/release-run-1/manifest.json");
    // Two hours old: stale under the default 24h window only if the default
    // were far shorter, so exercise it against a tight canonical override
    // instead, honored identically to the gate/bundle seams.
    await writeJson(
      manifestPath,
      hostedManifest({
        run_id: "release-run-1",
        generated_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    );

    // Before the fix: VIVA_RELEASE_HOSTED_MONITOR_MAX_AGE_SECONDS took
    // priority over VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS, so this stale
    // manifest would have passed under the huge, irrelevant legacy value
    // instead of correctly failing under the canonical one-hour override.
    await assert.rejects(
      () =>
        readHostedMonitorEvidence({
          env: {
            VIVA_RELEASE_RUN_ID: "release-run-1",
            VIVA_RELEASE_HOSTED_MONITOR_MANIFEST_PATH: manifestPath,
            VIVA_RELEASE_HOSTED_MONITOR_MAX_AGE_SECONDS: "999999",
            VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS: "3600",
          },
          mode: "production",
          now,
          productionRequested: true,
          root,
        }),
      /hosted monitor manifest is stale/,
    );

    // The same override, honored, also lets a manifest older than the
    // *default* pass -- proving VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS is
    // genuinely read, not merely that the legacy variable is ignored.
    const manifest = await readHostedMonitorEvidence({
      env: {
        VIVA_RELEASE_RUN_ID: "release-run-1",
        VIVA_RELEASE_HOSTED_MONITOR_MANIFEST_PATH: manifestPath,
        VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS: String(3 * 60 * 60),
      },
      mode: "production",
      now,
      productionRequested: true,
      root,
    });
    assert.equal(manifest.run_id, "release-run-1");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("ROW 341/RELEASE-011: the same canonical VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS override governs provider-failure observation staleness", async () => {
  const root = await tempRoot();
  try {
    const observationsPath = path.join(root, "artifacts/provider-failure-observability/observations.json");
    await writeJson(observationsPath, {
      schema: "viva.provider_failure_observations.v1",
      generated_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      run_id: "release-run-1",
      observations: [{ query_id: "provider_429", sanitized: true }],
      sanitized: true,
    });

    await assert.rejects(
      () =>
        readProviderFailureObservations({
          env: {
            VIVA_RELEASE_RUN_ID: "release-run-1",
            VIVA_RELEASE_PROVIDER_FAILURE_OBSERVATIONS_PATH: observationsPath,
            VIVA_RELEASE_HOSTED_MONITOR_MAX_AGE_SECONDS: "999999",
            VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS: "3600",
          },
          now,
          productionRequested: false,
          requiredQueryIds: [],
          root,
        }),
      /provider failure observations is stale/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

function hostedManifest(overrides = {}) {
  return {
    schema: "viva.hosted_monitor_run.v1",
    generated_at: "2026-06-27T20:20:00.000Z",
    mode: "pr",
    run_id: "release-run-1",
    status: "passed",
    runs: [hostedRun("provider_rate_limited")],
    sanitized: true,
    ...overrides,
  };
}

function hostedRun(scenarioId, overrides = {}) {
  return {
    name: `pr_hosted_failure_control_${scenarioId}`,
    runner: "e2e-browser",
    scenario_id: scenarioId,
    status: "passed",
    artifact_dir: `artifacts/hosted-monitor/pr/release-run-1/${scenarioId}`,
    hosted_e2e: {
      deploy_ids: { web: "web-1", agent: "agent-1" },
      failure_class: null,
      terminal_reason: "completed",
      recap_success: true,
    },
    sanitized: true,
    ...overrides,
  };
}

function productionDeployEnv(overrides = {}) {
  return {
    VIVA_RELEASE_AGENT_DEPLOY_ID: "agent-1",
    VIVA_RELEASE_RUN_ID: "release-run-1",
    VIVA_RELEASE_WEB_DEPLOY_ID: "web-1",
    ...overrides,
  };
}

async function tempRoot() {
  const dir = path.join(os.tmpdir(), `viva-release-imports-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
