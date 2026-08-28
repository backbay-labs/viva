import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
