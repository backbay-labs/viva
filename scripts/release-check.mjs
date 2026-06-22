#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProviderReadinessMatrix,
  LIVE_PROVIDER_GATE_COMMAND_NAME,
  PROVIDER_READINESS_TARGETS,
} from "./provider-readiness-matrix.mjs";
import {
  assertBrowserStoryArtifactFiles,
  assertReleaseBrowserEvidence,
  normalizeBrowserEvidence,
  shouldSkipMissingBrowserResult,
} from "./browser-evidence.mjs";

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
const commands = [];

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  await run("generated_artifact_hygiene", "bun", ["run", "release:hygiene"]);
  await run("provider_readiness_matrix_unit_tests", "node", [
    "--test",
    "scripts/provider-readiness-matrix.test.mjs",
  ]);
  await run("browser_evidence_unit_tests", "node", ["--test", "scripts/browser-evidence.test.mjs"]);
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
  const browserResult =
    process.env.VIVA_RELEASE_CHECK_SKIP_BROWSER === "1"
      ? await readExistingBrowserResult()
      : await runBrowserE2E();
  const providerReadiness = await collectProviderReadiness();
  const fixtureHashes = await hashFixtureFiles(path.join(root, "agent/fixtures/voice-protocol"));
  const artifactAudit = await auditGeneratedArtifacts([
    artifactDir,
    path.join(root, "artifacts/e2e-browser"),
    path.join(root, "artifacts/e2e-browser-fake-provider"),
  ]);
  const outputPath = path.join(artifactDir, "evidence.json");
  const evidence = {
    generated_at: new Date().toISOString(),
    schema: "viva.release_evidence.v1",
    commands,
    fixture_hashes: fixtureHashes,
    provider_readiness: providerReadiness,
    browser_e2e: browserResult,
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
  };

  auditSanitizedEvidence(evidence);
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
}

async function runBrowserE2E() {
  await run("browser_e2e_fake_provider_smoke", "bun", ["run", "e2e:browser"], {
    VIVA_E2E_ARTIFACT_DIR: path.join(root, "artifacts/e2e-browser-fake-provider"),
    VIVA_E2E_AGENT_PROVIDER: "fake_cartesia_gemini",
    VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
  });
  await run("browser_e2e_synthetic_provider", "bun", ["run", "e2e:browser"], {
    VIVA_E2E_ARTIFACT_DIR: path.join(root, "artifacts/e2e-browser"),
    VIVA_E2E_AGENT_PROVIDER: "synthetic",
    VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "1",
  });
  return readExistingBrowserResult();
}

async function readExistingBrowserResult() {
  const resultPath = path.join(root, "artifacts/e2e-browser/result.json");
  try {
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    await assertBrowserStoryArtifactFiles(result, root);
    const evidence = normalizeBrowserEvidence(result);
    assertReleaseBrowserEvidence(evidence);
    return evidence;
  } catch (error) {
    if (shouldSkipMissingBrowserResult(error, process.env.VIVA_RELEASE_CHECK_SKIP_BROWSER)) {
      return {
        skipped: true,
        reason: "VIVA_RELEASE_CHECK_SKIP_BROWSER=1 and no existing browser result was found",
      };
    }
    throw error;
  }
}

async function run(name, command, args, extraEnv = {}) {
  const started = Date.now();
  const stdoutPath = path.join(artifactDir, `${name}.stdout.log`);
  const stderrPath = path.join(artifactDir, `${name}.stderr.log`);
  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const code = await new Promise((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  stdout.end();
  stderr.end();
  const record = {
    name,
    command: [command, ...args].join(" "),
    exit_code: code,
    duration_ms: Date.now() - started,
    stdout_log: path.relative(root, stdoutPath),
    stderr_log: path.relative(root, stderrPath),
  };
  commands.push(record);
  if (code !== 0) {
    throw new Error(`${name} failed with exit code ${code}`);
  }
  return record;
}

async function collectProviderReadiness() {
  const endpointEvidence = [];
  for (const target of PROVIDER_READINESS_TARGETS) {
    endpointEvidence.push(await collectProviderReadinessTarget(target));
  }
  return buildProviderReadinessMatrix(endpointEvidence);
}

async function collectProviderReadinessTarget(target) {
  const port = await freePort();
  const stdoutPath = path.join(artifactDir, `readiness-agent-${target.provider}.stdout.log`);
  const stderrPath = path.join(artifactDir, `readiness-agent-${target.provider}.stderr.log`);
  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  const child = spawn(agentServiceBinary, [], {
    cwd: root,
    env: {
      ...process.env,
      ...target.env,
      VIVA_AGENT_BIND_ADDR: `127.0.0.1:${port}`,
      VIVA_AGENT_PROVIDER: target.provider,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childExit = { value: null };
  child.once("exit", (code, signal) => {
    childExit.value = { code, signal };
  });
  child.once("error", (error) => {
    childExit.value = { error: error.message };
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
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
    await stopChild(child);
    stdout.end();
    stderr.end();
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

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const terminated = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (terminated) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await exited;
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

function auditSanitizedEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  const forbidden = [
    "pcm16_base64",
    "answer_text",
    "transcript_final",
    "source_context",
    "NADH donates high-energy electrons",
    "received 4 PCM16 bytes",
    "CARTESIA_API_KEY",
    "GEMINI_API_KEY",
    "viva-release-check-cartesia-placeholder-key",
    "viva-release-check-gemini-placeholder-key",
    "Bearer ",
  ];
  for (const needle of forbidden) {
    if (serialized.includes(needle)) {
      throw new Error(`release evidence includes forbidden payload marker: ${needle}`);
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
    if (value && value.length >= 8 && serialized.includes(value)) {
      throw new Error(`release evidence includes secret value from ${name}`);
    }
  }
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
    workflow_artifact_name: "viva-release-evidence-${{ github.sha }}",
  };
}

async function auditGeneratedArtifacts(dirs) {
  const forbidden = [
    "pcm16_base64",
    "answer_text",
    "transcript_final",
    "source_context",
    "pasted_text",
    "session_token",
    "viva1.",
    "session-secret",
    "preload stroke volume cardiac output",
    "Stroke volume rises as ventricular preload",
    "NADH donates high-energy electrons",
    "received 4 PCM16 bytes",
    "CARTESIA_API_KEY",
    "GEMINI_API_KEY",
    "viva-release-check-cartesia-placeholder-key",
    "viva-release-check-gemini-placeholder-key",
    "Bearer ",
  ];
  let scanned_files = 0;
  for (const dir of dirs) {
    for (const file of await listFiles(dir)) {
      const relative = path.relative(root, file);
      if (file.endsWith(".zip")) {
        throw new Error(`release artifact includes unsanitized trace archive: ${relative}`);
      }
      if (!isTextArtifact(file)) continue;
      scanned_files += 1;
      const text = await readFile(file, "utf8");
      for (const needle of forbidden) {
        if (text.includes(needle)) {
          throw new Error(`artifact ${relative} includes forbidden payload marker: ${needle}`);
        }
      }
      for (const [name, value] of Object.entries(process.env)) {
        if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
        if (value && value.length >= 8 && text.includes(value)) {
          throw new Error(`artifact ${relative} includes secret value from ${name}`);
        }
      }
    }
  }
  return {
    scanned_files,
    forbidden_hits: 0,
  };
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isTextArtifact(file) {
  return /\.(json|log|txt|stdout|stderr)$/i.test(file);
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("Could not allocate a free local port"));
      });
    });
  });
}
