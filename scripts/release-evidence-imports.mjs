import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_EVIDENCE_AGE_SECONDS = 24 * 60 * 60;
const PROVIDER_FAILURE_OBSERVATIONS_SCHEMA = "viva.provider_failure_observations.v1";
const HOSTED_MONITOR_SCHEMA = "viva.hosted_monitor_run.v1";

export async function readHostedMonitorEvidence({
  env = process.env,
  mode = "pr",
  now = new Date(),
  productionRequested = false,
  root = process.cwd(),
} = {}) {
  const manifestPath = await resolveHostedMonitorEvidencePath({ env, mode, productionRequested, root });
  if (manifestPath === null) {
    if (productionRequested) {
      throw new Error("hosted monitor manifest is required for production release evidence");
    }
    return null;
  }
  const manifest = await readOptionalJson(manifestPath);
  if (manifest === null && productionRequested) {
    throw new Error(`hosted monitor manifest is required for production release evidence: ${manifestPath}`);
  }
  if (manifest !== null) {
    validateHostedMonitorManifest(manifest, { env, now, productionRequested });
  }
  return manifest;
}

export function matrixResultsFromHostedMonitorEvidence(
  manifest,
  {
    env = process.env,
    now = new Date(),
    productionRequested = false,
    requiredScenarioIds = [],
  } = {},
) {
  if (manifest === null) {
    if (productionRequested) {
      throw new Error("hosted monitor manifest is required for production release evidence");
    }
    return [];
  }
  validateHostedMonitorManifest(manifest, { env, now, productionRequested });
  const requiredScenarioIdSet = new Set(requiredScenarioIds);
  const expectedDeployIds = releaseDeployIdsFromEnv(env);
  const runs = Array.isArray(manifest.runs) ? manifest.runs : [];
  const passedRuns = runs.filter(
    (run) =>
      run?.status === "passed" &&
      run.sanitized === true &&
      typeof run.scenario_id === "string" &&
      run.scenario_id.length > 0,
  );

  if (productionRequested) {
    // RELEASE-003/007/008: an incomplete expected identity must fail
    // closed, never silently skip the comparison -- otherwise a run's own
    // (unverified) reported deploy ids stand in unexamined. And every
    // passed run is checked, not only the ones a required recovery
    // scenario names, so a non-required run's deploy ids can never be
    // "inherited" from elsewhere without being mapped to the actual
    // selected target.
    if (!expectedDeployIds.complete) {
      throw new Error(
        "hosted monitor deploy identity requires VIVA_RELEASE_WEB_DEPLOY_ID and VIVA_RELEASE_AGENT_DEPLOY_ID",
      );
    }
    for (const run of passedRuns) {
      if (
        run.hosted_e2e?.deploy_ids?.web !== expectedDeployIds.web ||
        run.hosted_e2e?.deploy_ids?.agent !== expectedDeployIds.agent
      ) {
        throw new Error(`hosted monitor deploy identity mismatch for ${run.scenario_id}`);
      }
    }
  }

  const results = passedRuns.map((run) => ({
    scenario_id: run.scenario_id,
    status: "passed",
    runner: run.runner ?? null,
    artifact_dir: run.artifact_dir ?? null,
    terminal_reason: run.hosted_e2e?.terminal_reason ?? null,
    failure_class: run.hosted_e2e?.failure_class ?? null,
    recap_success: run.hosted_e2e?.recap_success === true,
    sanitized: true,
  }));

  if (productionRequested) {
    const resultScenarioIds = new Set(results.map((entry) => entry.scenario_id));
    const missingScenarioIds = requiredScenarioIds.filter((id) => !resultScenarioIds.has(id));
    if (missingScenarioIds.length > 0) {
      throw new Error(
        `hosted monitor manifest missing required production scenarios: ${missingScenarioIds.join(",")}`,
      );
    }
  }

  return results;
}

export async function readProviderFailureObservations({
  env = process.env,
  now = new Date(),
  productionRequested = false,
  requiredQueryIds = [],
  root = process.cwd(),
} = {}) {
  const observationsPath = path.resolve(
    root,
    env.VIVA_RELEASE_PROVIDER_FAILURE_OBSERVATIONS_PATH ??
      "artifacts/provider-failure-observability/observations.json",
  );
  const evidence = await readOptionalJson(observationsPath);
  if (evidence === null) {
    if (productionRequested) {
      throw new Error("provider failure observations are required for production release evidence");
    }
    return [];
  }
  if (evidence.schema !== PROVIDER_FAILURE_OBSERVATIONS_SCHEMA) {
    throw new Error(`provider failure observations schema must be ${PROVIDER_FAILURE_OBSERVATIONS_SCHEMA}`);
  }
  validateGeneratedAt(evidence.generated_at, {
    maxAgeSeconds: maxEvidenceAgeSeconds(env),
    now,
    subject: "provider failure observations",
  });
  validateRunId(evidence, env, "provider failure observations");
  if (evidence.sanitized !== true) {
    throw new Error("provider failure observations must be sanitized");
  }
  const observations = Array.isArray(evidence.observations)
    ? evidence.observations
        .filter(
          (entry) =>
            entry?.sanitized === true &&
            typeof entry.query_id === "string" &&
            entry.query_id.length > 0,
        )
        .map((entry) => ({ ...entry }))
    : [];

  if (productionRequested) {
    const observedQueryIds = new Set(observations.map((entry) => entry.query_id));
    const missingQueryIds = requiredQueryIds.filter((id) => !observedQueryIds.has(id));
    if (missingQueryIds.length > 0) {
      throw new Error(
        `provider failure observations missing required queries: ${missingQueryIds.join(",")}`,
      );
    }
  }

  return observations;
}

async function resolveHostedMonitorEvidencePath({ env, mode, productionRequested, root }) {
  // RELEASE-003/007/008: a production import must name the exact run it
  // wants before anything else is resolved -- even when an explicit
  // manifest path is also supplied, so a mistakenly-pointed path can never
  // substitute for a genuine run-id binding, and so the lexicographic
  // "latest" fallback below is structurally unreachable in production.
  if (productionRequested && !stringOrNull(env.VIVA_RELEASE_RUN_ID)) {
    throw new Error(
      "hosted monitor manifest resolution requires VIVA_RELEASE_RUN_ID for production release evidence",
    );
  }

  const explicit =
    env.VIVA_RELEASE_HOSTED_MONITOR_MANIFEST_PATH ?? env.VIVA_HOSTED_MONITOR_MANIFEST_PATH;
  if (explicit) return path.resolve(root, explicit);

  const runId = env.VIVA_RELEASE_RUN_ID ?? env.VIVA_HOSTED_RUN_ID;
  const monitorMode = hostedMonitorModeForRelease({ env, mode });
  if (runId) {
    return path.join(root, "artifacts/hosted-monitor", monitorMode, sanitizeRunId(runId), "manifest.json");
  }

  return latestHostedMonitorManifestPath(root, monitorMode);
}

function hostedMonitorModeForRelease({ env, mode }) {
  const explicit = env.VIVA_RELEASE_HOSTED_MONITOR_MODE ?? env.VIVA_HOSTED_RUNNER_MODE;
  if (explicit) return explicit;
  return mode === "production" ? "pr" : mode;
}

async function latestHostedMonitorManifestPath(root, monitorMode) {
  const modeDir = path.join(root, "artifacts/hosted-monitor", monitorMode);
  let entries;
  try {
    entries = await readdir(modeDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const runDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const latestRunId = runDirs.at(-1);
  return latestRunId === undefined ? null : path.join(modeDir, latestRunId, "manifest.json");
}

function validateHostedMonitorManifest(manifest, { env, now, productionRequested }) {
  if (manifest?.schema !== HOSTED_MONITOR_SCHEMA) {
    throw new Error(`hosted monitor manifest schema must be ${HOSTED_MONITOR_SCHEMA}`);
  }
  if (productionRequested && manifest.mode !== "pr") {
    throw new Error("hosted monitor manifest mode must be pr for production release evidence");
  }
  validateGeneratedAt(manifest.generated_at, {
    maxAgeSeconds: maxEvidenceAgeSeconds(env),
    now,
    subject: "hosted monitor manifest",
  });
  validateRunId(manifest, env, "hosted monitor manifest");
  // RELEASE-003/007/008: missing/null must fail exactly like an explicit
  // false -- only a literal `true` proves the manifest was sanitized.
  if (manifest.sanitized !== true) {
    throw new Error("hosted monitor manifest must be sanitized");
  }
}

function validateGeneratedAt(value, { maxAgeSeconds, now, subject }) {
  const generatedAt = parseDate(value);
  const observedAt = now instanceof Date ? now : new Date(now);
  if (generatedAt === null || Number.isNaN(generatedAt.getTime())) {
    throw new Error(`${subject} generated_at must be a valid timestamp`);
  }
  const ageSeconds = Math.floor((observedAt.getTime() - generatedAt.getTime()) / 1000);
  if (ageSeconds < 0) {
    throw new Error(`${subject} is future-dated`);
  }
  if (ageSeconds > maxAgeSeconds) {
    throw new Error(`${subject} is stale`);
  }
}

function validateRunId(evidence, env, subject) {
  const expectedRunId = env.VIVA_RELEASE_RUN_ID;
  if (expectedRunId && evidence.run_id !== expectedRunId) {
    throw new Error(`${subject} run_id does not match VIVA_RELEASE_RUN_ID`);
  }
}

function releaseDeployIdsFromEnv(env) {
  const web = stringOrNull(env.VIVA_RELEASE_WEB_DEPLOY_ID);
  const agent = stringOrNull(env.VIVA_RELEASE_AGENT_DEPLOY_ID);
  return {
    agent,
    complete: web !== null && agent !== null,
    web,
  };
}

function maxEvidenceAgeSeconds(env) {
  const value = Number.parseInt(
    env.VIVA_RELEASE_HOSTED_MONITOR_MAX_AGE_SECONDS ??
      env.VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS ??
      "",
    10,
  );
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_EVIDENCE_AGE_SECONDS;
}

async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseDate(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return new Date(value);
}

function sanitizeRunId(value) {
  return String(value).replaceAll(/[^A-Za-z0-9_.-]/g, "-").slice(0, 128);
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
