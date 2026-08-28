#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBrowserStoryArtifactFiles,
  assertReleaseBrowserEvidence,
  normalizeBrowserEvidence,
  releaseDurableStateClaim,
  shouldSkipMissingBrowserResult,
} from "./browser-evidence.mjs";
import {
  buildFailureControlPlan,
  failureControlHarnessEvidence,
} from "./failure-control-harness.mjs";
import { buildHostedE2eMatrixContract, summarizeHostedE2eResult } from "./hosted-e2e-matrix.mjs";
import fixtureProviderFailureDashboard from "./fixtures/provider-failure-dashboard-samples.json" with {
  type: "json",
};
import {
  assertProviderFailureObservabilityEvidence,
  providerFailureObservabilityEvidence,
} from "./provider-failure-observability.mjs";
import {
  assertProviderLimiterEnabledForRelease,
  parseProviderLimiterAdmissionProof,
  providerLimiterReleaseEvidence,
  PROVIDER_LIMITER_ADMISSION_TEST_ARGS,
} from "./provider-limiter-evidence.mjs";
import {
  buildProviderReadinessMatrix,
  LIVE_PROVIDER_GATE_COMMAND_NAME,
  PROVIDER_READINESS_TARGETS,
} from "./provider-readiness-matrix.mjs";
import {
  buildContainerProvenanceEvidence,
  finalizeReleaseEvidenceBundle,
  isPinnedImageRef,
  REQUIRED_PROVIDER_FAILURE_OBSERVATIONS,
  REQUIRED_RECOVERY_SCENARIOS,
} from "./production-release-gate.mjs";
import {
  awaitPortBound,
  installSignalCleanup,
  spawnManaged,
  spawnWithPortRetry,
} from "./process-supervisor.mjs";
import { auditTextArtifacts } from "./redaction-control.mjs";
import {
  auditReleaseEvidence,
  buildReleaseGateEvidence,
  createCommandRunner,
  providerReadinessChildEnv,
  providerReadinessLogPaths,
} from "./release-check-core.mjs";
import {
  matrixResultsFromHostedMonitorEvidence,
  readHostedMonitorEvidence,
  readProviderFailureObservations,
} from "./release-evidence-imports.mjs";
import {
  assertRollbackReleaseGate,
  buildRollbackReleaseEvidence,
  ROLLBACK_DRAIN_PROOF_COMMANDS,
} from "./rollback-drain-criteria.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.resolve(
  root,
  process.env.VIVA_RELEASE_ARTIFACT_DIR ?? "artifacts/release-check",
);
const failureArtifactDir = path.resolve(root, "artifacts/release-check-failures");
const agentServiceBinary = path.join(
  root,
  "agent/target/debug",
  process.platform === "win32" ? "agent-service.exe" : "agent-service",
);
// RELEASE-005/006/009: one shared command registry/executor -- duplicate
// names rejected before any spawn, explicit-environment isolated, spawn
// errors routed through the awaited promise, streams flushed before a
// command record is finalized.
const { run, commands } = createCommandRunner({ artifactDir, root, parentEnv: process.env });
const durableStateReleaseClaimed = process.env.VIVA_RELEASE_DURABLE_STATE_CLAIMED === "1";

// RELEASE-015: a Ctrl-C or a CI SIGTERM mid-release must not leave a bound
// agent-service behind for the next run to race. Both signals route through
// one idempotent teardown of every readiness child still running.
const readinessChildren = new Set();
installSignalCleanup({
  cleanup: async () => {
    for (const child of readinessChildren) {
      await child.stop({ graceMs: 5_000 }).catch(() => {});
    }
    readinessChildren.clear();
    process.exit(1);
  },
});

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const outputPath = path.join(artifactDir, "evidence.json");

try {
  const generatedAt = new Date();
  const generatedAtIso = generatedAt.toISOString();
  const productionRequested = process.env.VIVA_PRODUCTION_RELEASE === "1";
  const failureControlPlan = buildFailureControlPlan();
  const failureControlEvidence = failureControlHarnessEvidence(failureControlPlan);
  // RELEASE-002/RELEASE-020: fail fast, before spending any cargo time,
  // when the provider limiter is explicitly disabled -- the truthful
  // evidence itself (which must attest an *executed, single-passed* Rust
  // test; see below) can only be built after the exact test command runs.
  assertProviderLimiterEnabledForRelease(process.env);
  let providerLimiterEvidence;
  if (failureControlPlan.enabled) {
    throw new Error("failure-control harness must be disabled for release evidence generation");
  }
  await run("generated_artifact_hygiene", "bun", ["run", "release:hygiene"]);
  await run("provider_readiness_matrix_unit_tests", "node", [
    "--test",
    "scripts/provider-readiness-matrix.test.mjs",
  ]);
  await run("browser_evidence_unit_tests", "node", ["--test", "scripts/browser-evidence.test.mjs"]);
  await run("failure_control_harness_unit_tests", "node", [
    "--test",
    "scripts/failure-control-harness.test.mjs",
  ]);
  await run("provider_limiter_evidence_unit_tests", "node", [
    "--test",
    "scripts/provider-limiter-evidence.test.mjs",
  ]);
  await run("production_release_gate_unit_tests", "node", [
    "--test",
    "scripts/production-release-gate.test.mjs",
  ]);
  await run("rollback_drain_criteria_unit_tests", "node", [
    "--test",
    "scripts/rollback-drain-criteria.test.mjs",
  ]);
  await runRollbackDrainProofCommands();
  await run("provider_failure_observability_unit_tests", "node", [
    "--test",
    "scripts/provider-failure-observability.test.mjs",
  ]);
  await run("hosted_e2e_matrix_unit_tests", "node", [
    "--test",
    "scripts/hosted-e2e-matrix.test.mjs",
  ]);
  await run("provider_gate_tests", "cargo", [
    "test",
    "--manifest-path",
    "agent/Cargo.toml",
    "-p",
    "agent-service",
    "fake_provider",
    "--",
    "--nocapture",
  ]);
  const providerLimiterAdmissionRecord = await run(
    "provider_limiter_behavior_tests",
    "cargo",
    PROVIDER_LIMITER_ADMISSION_TEST_ARGS,
  );
  const providerLimiterAdmissionLog = await readFile(
    path.join(root, providerLimiterAdmissionRecord.stdout_log),
    "utf8",
  );
  // A zero-test `--exact` filter still exits 0 -- cargo's own exit code
  // (already checked by run() above) cannot distinguish "the test ran and
  // passed" from "the filter matched nothing." Parsing the captured log and
  // requiring exactly one passed execution is what makes this evidence
  // attest real, executed behavior rather than a self-compared string.
  const providerLimiterAdmissionProof = parseProviderLimiterAdmissionProof(
    providerLimiterAdmissionLog,
  );
  providerLimiterEvidence = providerLimiterReleaseEvidence({
    env: process.env,
    proof: providerLimiterAdmissionProof,
  });
  await run(LIVE_PROVIDER_GATE_COMMAND_NAME, "cargo", [
    "test",
    "--manifest-path",
    "agent/Cargo.toml",
    "-p",
    "agent-adapters",
    "cartesia_gemini_brain",
    "--",
    "--nocapture",
  ]);
  await run("agent_service_binary_build", "cargo", [
    "build",
    "--manifest-path",
    "agent/Cargo.toml",
    "-p",
    "agent-service",
  ]);
  await run("direct_websocket_replay", "bun", ["run", "agent:replay:ws"]);
  const browserSkipShortcut = process.env.VIVA_RELEASE_CHECK_SKIP_BROWSER === "1";
  const browserResult = browserSkipShortcut
    ? await readExistingBrowserResult()
    : await runBrowserE2E();
  const releaseDurableStateClaimed = releaseDurableStateClaim(
    browserResult,
    durableStateReleaseClaimed,
  );
  const providerReadiness = await collectProviderReadiness();
  const rollbackDrain = buildRollbackReleaseEvidence();
  assertRollbackReleaseGate(rollbackDrain);
  const providerFailureObservations = await readProviderFailureObservations({
    env: process.env,
    now: generatedAt,
    productionRequested,
    requiredQueryIds: REQUIRED_PROVIDER_FAILURE_OBSERVATIONS,
    root,
  });
  const providerFailureObservability = providerFailureObservabilityEvidence({
    fixture: fixtureProviderFailureDashboard,
    observations: providerFailureObservations,
    releaseEvidencePath: path.relative(root, outputPath),
  });
  assertProviderFailureObservabilityEvidence(providerFailureObservability);
  const hostedMonitorEvidence = await readHostedMonitorEvidence({
    env: process.env,
    mode: productionRequested ? "production" : "pr",
    now: generatedAt,
    productionRequested,
    root,
  });
  const hostedMonitorMatrixResults = matrixResultsFromHostedMonitorEvidence(hostedMonitorEvidence, {
    env: process.env,
    now: generatedAt,
    productionRequested,
    requiredScenarioIds: REQUIRED_RECOVERY_SCENARIOS,
  });
  const hostedE2eMatrix = {
    ...buildHostedE2eMatrixContract({
      generatedAt: generatedAtIso,
      mode: productionRequested ? "production" : "pr",
      runId: process.env.VIVA_RELEASE_RUN_ID ?? null,
    }),
    results: hostedMonitorMatrixResults,
  };
  const liveSmokeEvidence = await readOptionalJson(liveSmokeEvidencePath());
  const containerProvenanceEvidence = buildContainerProvenanceEvidence({
    buildInputs: await readContainerBuildInputs(),
    env: process.env,
  });
  const fixtureHashes = await hashFixtureFiles(path.join(root, "agent/fixtures/voice-protocol"));
  const artifactAudit = await auditGeneratedArtifacts([
    artifactDir,
    path.join(root, "artifacts/e2e-browser"),
    path.join(root, "artifacts/e2e-browser-fake-provider"),
    path.join(root, "artifacts/live-provider-smoke"),
  ]);
  const draftEvidence = {
    generated_at: generatedAtIso,
    schema: "viva.release_evidence.v1",
    commands,
    release_claims: {
      durable_state: releaseDurableStateClaimed,
    },
    container_provenance: containerProvenanceEvidence,
    fixture_hashes: fixtureHashes,
    provider_readiness: providerReadiness,
    failure_control_harness: failureControlEvidence,
    rollback_drain: rollbackDrain,
    provider_failure_observability: providerFailureObservability,
    provider_limiter: providerLimiterEvidence,
    hosted_e2e_matrix: hostedE2eMatrix,
    live_smoke: liveSmokeEvidence,
    browser_e2e: browserResult,
    release_gate: buildReleaseGateEvidence({
      browserResult,
      browserSkipShortcut,
      env: process.env,
      generatedAt,
    }),
    artifact_audit: artifactAudit,
    release_bundle: buildReleaseBundleManifest(outputPath, commands, browserResult),
    privacy: {
      consent_disclosure_in_product: true,
      data_handling_statement: "docs/data-governance.md",
      tester_deletion_procedure: "docs/data-governance.md#delete-this-testers-session-data",
      provider_retention_statement: "docs/data-governance.md#provider-retention-and-zero-retention",
      raw_audio_persisted: false,
      transcripts_persisted: false,
      answers_persisted: false,
      raw_source_excerpts_in_bundle: false,
      secrets_in_bundle: false,
      consent_records_contain_raw_payloads: false,
      governance_artifacts_contain_raw_payloads: false,
      deletion_proof: {
        in_memory_unit_test: "deletion_removes_session_nonces_and_answer_envelopes",
        optional_postgres_test:
          "optional_postgres_privacy_deletes_purge_usage_and_preserve_deleted_sessions_when_database_url_is_set",
        proves_removed: [
          "nonce rows",
          "answer-attempt envelopes",
          "usage rows",
          "concept-status events",
          "recaps",
          "review items",
        ],
        proves_session_tombstoned: true,
      },
      provider_zero_retention: {
        cartesia: {
          services: ["Ink STT", "Sonic TTS"],
          account_setting_required: true,
          confirmation_flag: "CARTESIA_ZERO_DATA_RETENTION_ENABLED=1",
          confirmed_in_default_release_evidence: false,
        },
        gemini: {
          service: "Gemini Developer API",
          project_approval_required: true,
          confirmation_flag: "GEMINI_ZERO_DATA_RETENTION_APPROVED=1",
          confirmed_in_default_release_evidence: false,
        },
      },
    },
    sanitized: true,
  };

  auditReleaseEvidence(draftEvidence, { context: "release evidence", env: process.env });
  const evidence = finalizeReleaseEvidenceBundle({
    evidence: draftEvidence,
    env: process.env,
    now: generatedAt,
  });
  auditReleaseEvidence(evidence, { context: "release evidence", env: process.env });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Sanitized release evidence written to ${path.relative(root, outputPath)}`);
} catch (error) {
  await rm(failureArtifactDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(failureArtifactDir, { recursive: true }).catch(() => {});
  await writeFile(
    path.join(failureArtifactDir, "failure.json"),
    `${JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        commands,
        releasable_artifact_dir_deleted: path.relative(root, artifactDir),
        unsafe_to_attach: true,
      },
      null,
      2,
    )}\n`,
  ).catch(() => {});
  await rm(artifactDir, { recursive: true, force: true }).catch(() => {});
  throw error;
} finally {
  for (const child of readinessChildren) {
    await child.stop({ graceMs: 5_000 }).catch(() => {});
  }
  readinessChildren.clear();
}

async function runBrowserE2E() {
  // W-07: the disposable durable-store URL the browser story needs to reach an
  // authenticated session, threaded through unchanged. Absent, `e2e-browser.mjs`
  // refuses the run by name rather than degrading to the retired unsigned entry.
  const browserDatabaseUrl = process.env.VIVA_E2E_AGENT_DATABASE_URL?.trim() || "";
  await run("browser_e2e_fake_provider_smoke", "bun", ["run", "e2e:browser"], {
    VIVA_E2E_AGENT_DATABASE_URL: browserDatabaseUrl,
    VIVA_E2E_ARTIFACT_DIR: path.join(root, "artifacts/e2e-browser-fake-provider"),
    VIVA_E2E_AGENT_PROVIDER: "fake_cartesia_gemini",
    VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
  });
  await run("browser_e2e_synthetic_provider", "bun", ["run", "e2e:browser"], {
    VIVA_E2E_AGENT_DATABASE_URL: browserDatabaseUrl,
    VIVA_E2E_ARTIFACT_DIR: path.join(root, "artifacts/e2e-browser"),
    VIVA_E2E_AGENT_PROVIDER: "synthetic",
    VIVA_E2E_DURABLE_STATE_RELEASE_CLAIMED: durableStateReleaseClaimed ? "1" : "0",
    VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "1",
  });
  return readExistingBrowserResult();
}

async function runRollbackDrainProofCommands() {
  for (const proofCommand of ROLLBACK_DRAIN_PROOF_COMMANDS) {
    await run(proofCommand.name, proofCommand.command, proofCommand.args);
  }
}

async function readExistingBrowserResult() {
  const resultPath = path.join(root, "artifacts/e2e-browser/result.json");
  try {
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    await assertBrowserStoryArtifactFiles(result, root);
    const evidence = normalizeBrowserEvidence({
      ...result,
      durable_state_release_claimed:
        result.durable_state_release_claimed === true || durableStateReleaseClaimed,
    });
    assertReleaseBrowserEvidence(evidence);
    return {
      ...evidence,
      hosted_e2e: summarizeHostedE2eResult(result),
    };
  } catch (error) {
    if (
      shouldSkipMissingBrowserResult(
        error,
        process.env.VIVA_RELEASE_CHECK_SKIP_BROWSER,
        durableStateReleaseClaimed,
      )
    ) {
      return {
        skipped: true,
        reason: "VIVA_RELEASE_CHECK_SKIP_BROWSER=1 and no existing browser result was found",
      };
    }
    throw error;
  }
}

function liveSmokeEvidencePath() {
  return path.resolve(
    root,
    process.env.VIVA_RELEASE_LIVE_SMOKE_EVIDENCE_PATH ??
      process.env.VIVA_LIVE_SMOKE_EVIDENCE_PATH ??
      "artifacts/live-provider-smoke/evidence.json",
  );
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

async function collectProviderReadiness() {
  const endpointEvidence = [];
  for (const target of PROVIDER_READINESS_TARGETS) {
    endpointEvidence.push(await collectProviderReadinessTarget(target));
  }
  return buildProviderReadinessMatrix(endpointEvidence);
}

/**
 * RELEASE-015: the readiness child is the real agent-service binary bound to a
 * probed loopback port. Two defects lived here. `freePort()` closes its probe
 * socket before the binary gets there, so a racing process could own the port
 * and the readiness wait would then time out against that stranger instead of
 * reporting a bind conflict. And a plain SIGTERM to one pid could leave the
 * bound process behind for the next provider target to collide with.
 *
 * The allocation now runs through the shared bounded-retry boundary, and the
 * child is a supervised process group whose logs are closed only after it is
 * actually gone.
 */
async function collectProviderReadinessTarget(target) {
  const started = await spawnWithPortRetry({
    label: `${target.provider} readiness agent`,
    attempts: 2,
    start: ({ port, attempt }) =>
      // RELEASE-029: the locally-spawned agent-service binary receives an
      // explicitly constructed environment — the fixed operational allowlist
      // plus this target's own constructed (never ambient-copied) provider
      // configuration.
      //
      // RELEASE-015: the log pair is derived from the ATTEMPT. `spawnManaged`
      // truncates on open, so a shared pair would erase the first attempt's
      // EADDRINUSE line — the diagnostic that justified the retry.
      spawnManaged({
        command: agentServiceBinary,
        args: [],
        cwd: root,
        env: providerReadinessChildEnv({ target, port, parentEnv: process.env }),
        ...providerReadinessLogPaths({ artifactDir, provider: target.provider, attempt }),
        label: `${target.provider} readiness agent`,
      }),
    observeBind: ({ handle, port }) => awaitPortBound({ handle, port, timeoutMs: 120_000 }),
  });
  const child = started.value;
  const port = started.port;
  readinessChildren.add(child);
  const childExit = {
    get value() {
      if (child.spawnError) return { error: child.spawnError.message };
      return child.exitResult;
    },
  };
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForEndpoint(
      `${baseUrl}/health/brain`,
      `${target.provider} /health/brain`,
      childExit,
      (record) =>
        record.http_status === target.expected.health_http_status &&
        record.body?.brain?.provider === target.provider,
    );
    const ready = await waitForEndpoint(
      `${baseUrl}/ready`,
      `${target.provider} /ready`,
      childExit,
      (record) =>
        record.http_status === target.expected.ready_http_status &&
        record.body?.ready === target.expected.ready &&
        record.body?.brain?.provider === target.provider,
    );
    return {
      provider: target.provider,
      health_brain: health,
      ready,
    };
  } finally {
    await child.stop({ graceMs: 5_000 });
    readinessChildren.delete(child);
  }
}

async function waitForEndpoint(url, description, childExit, predicate) {
  const started = Date.now();
  let lastError;
  let lastRecord;
  while (Date.now() - started < 120_000) {
    if (childExit.value) {
      throw new Error(
        `Agent exited before ${description} became observable: ${JSON.stringify(childExit.value)}`,
      );
    }
    try {
      const response = await fetch(url);
      const text = await response.text();
      const body = text.length > 0 ? JSON.parse(text) : {};
      const record = {
        http_status: response.status,
        body,
      };
      lastRecord = record;
      if (predicate(record)) return record;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for ${description}${
      lastRecord ? `; last response ${JSON.stringify(summarizeEndpointRecord(lastRecord))}` : ""
    }${lastError ? `; last error ${lastError.message}` : ""}`,
  );
}

function summarizeEndpointRecord(record) {
  return {
    http_status: record.http_status,
    provider: record.body?.provider,
    ready: record.body?.ready,
    status: record.body?.status,
    brain_provider: record.body?.brain?.provider,
    configured: record.body?.brain?.configured,
    selectable: record.body?.brain?.selectable,
    live_runtime: record.body?.brain?.live_runtime,
  };
}

// RELEASE-026: parse the two committed, digest-pinned Dockerfiles
// themselves for the `container_provenance.build_inputs` record, rather
// than hand-maintaining a second, independently-drifting copy of the same
// digests/checksums in JS. A FROM line without a pinned sha256 digest fails
// closed here (via isPinnedImageRef), before any evidence is written.
async function readContainerBuildInputs() {
  const [agentDockerfile, monitorDockerfile] = await Promise.all([
    readFile(path.join(root, "agent/Dockerfile"), "utf8"),
    readFile(path.join(root, "Dockerfile.monitor"), "utf8"),
  ]);
  const agentStages = parseDockerfileFromStages(agentDockerfile);
  const monitorStages = parseDockerfileFromStages(monitorDockerfile);
  const bunArchiveChecksums = parseBunArchiveChecksums(monitorDockerfile);
  return {
    base_images: {
      rust_builder: requirePinnedImageRef(
        agentStages.get("builder"),
        "agent/Dockerfile FROM ... AS builder",
      ),
      debian_runtime: requirePinnedImageRef(
        agentStages.get("runtime"),
        "agent/Dockerfile FROM ... AS runtime",
      ),
      playwright_monitor: requirePinnedImageRef(
        [...monitorStages.values()][0],
        "Dockerfile.monitor FROM",
      ),
    },
    bun_archives: {
      "linux/amd64": requireBunArchiveChecksum(bunArchiveChecksums, "amd64"),
      "linux/arm64": requireBunArchiveChecksum(bunArchiveChecksums, "arm64"),
    },
    bun_version: "1.3.3",
  };
}

function parseDockerfileFromStages(dockerfile) {
  const stages = new Map();
  let unnamedIndex = 0;
  for (const line of dockerfile.split("\n")) {
    const match = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i);
    if (!match) continue;
    const name = match[2] ?? `_unnamed_${unnamedIndex++}`;
    stages.set(name, match[1]);
  }
  return stages;
}

function parseBunArchiveChecksums(dockerfile) {
  const result = {};
  const pattern = /(amd64|arm64)\)\s*bun_archive="([^"]+)";\s*bun_sha256="([0-9a-f]{64})"/g;
  for (const match of dockerfile.matchAll(pattern)) {
    result[match[1]] = { name: match[2], sha256: match[3] };
  }
  return result;
}

function requirePinnedImageRef(value, label) {
  if (!isPinnedImageRef(value)) {
    throw new Error(`${label} must pin an image reference with a sha256 digest, found: ${value}`);
  }
  return value;
}

function requireBunArchiveChecksum(checksumsByArch, arch) {
  const checksum = checksumsByArch[arch];
  if (!checksum || typeof checksum.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(checksum.sha256)) {
    throw new Error(`Dockerfile.monitor must checksum the ${arch} Bun archive`);
  }
  return checksum;
}

async function hashFixtureFiles(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const hashes = {};
  for (const name of names) {
    const bytes = await readFile(path.join(dir, name));
    hashes[name] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return hashes;
}

function buildReleaseBundleManifest(outputPath, commandRecords, browserResult) {
  const browserArtifactDir =
    typeof browserResult.artifact_dir === "string" ? browserResult.artifact_dir : null;
  const browserFiles = Array.isArray(browserResult.browser_story?.artifact_files)
    ? browserResult.browser_story.artifact_files.filter(isSafeRelativeArtifactName)
    : [];
  return {
    evidence_json: path.relative(root, outputPath),
    command_logs: commandRecords.flatMap((record) => [record.stdout_log, record.stderr_log]),
    browser_story_artifacts:
      browserArtifactDir === null
        ? []
        : browserFiles.map((file) => path.posix.join(browserArtifactDir, file)),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expands this literal.
    workflow_artifact_name: "viva-release-evidence-${{ github.sha }}",
  };
}

async function auditGeneratedArtifacts(dirs) {
  return auditTextArtifacts(dirs, {
    context: "artifact",
    rootDir: root,
    zipMessage: (relative) => `release artifact includes unsanitized trace archive: ${relative}`,
  });
}

function isSafeRelativeArtifactName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !path.isAbsolute(name) &&
    !name.split(/[\\/]/).includes("..")
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
