#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.resolve(
  root,
  process.env.VIVA_RELEASE_ARTIFACT_DIR ?? "artifacts/release-check",
);
const commands = [];

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  await run("generated_artifact_hygiene", "bun", ["run", "release:hygiene"]);
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
  ]);
  const evidence = {
    generated_at: new Date().toISOString(),
    schema: "viva.release_evidence.v1",
    commands,
    fixture_hashes: fixtureHashes,
    provider_readiness: providerReadiness,
    browser_e2e: browserResult,
    artifact_audit: artifactAudit,
    privacy: {
      raw_audio_persisted: false,
      transcripts_persisted: false,
      answers_persisted: false,
      raw_source_excerpts_in_bundle: false,
      secrets_in_bundle: false,
    },
  };

  auditSanitizedEvidence(evidence);
  const outputPath = path.join(artifactDir, "evidence.json");
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Sanitized release evidence written to ${path.relative(root, outputPath)}`);
} catch (error) {
  await writeFile(
    path.join(artifactDir, "failure.json"),
    `${JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        commands,
      },
      null,
      2,
    )}\n`,
  ).catch(() => {});
  throw error;
}

async function runBrowserE2E() {
  await run("browser_e2e_fake_provider", "bun", ["run", "e2e:browser"], {
    VIVA_E2E_ARTIFACT_DIR: path.join(root, "artifacts/e2e-browser"),
  });
  return readExistingBrowserResult();
}

async function readExistingBrowserResult() {
  const resultPath = path.join(root, "artifacts/e2e-browser/result.json");
  try {
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    return {
      artifact_dir: result.artifact_dir,
      pending_gate: result.pending_gate === true,
      server_paste_ready: result.server_paste_ready === true,
      connected_recap: result.connected_recap === true,
      local_only_actions_hidden: result.local_only_actions_hidden === true,
      console_error_count: Array.isArray(result.console_errors) ? result.console_errors.length : 0,
      page_error_count: Array.isArray(result.page_errors) ? result.page_errors.length : 0,
    };
  } catch (error) {
    if (process.env.VIVA_RELEASE_CHECK_SKIP_BROWSER === "1") {
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
  const port = await freePort();
  const stdoutPath = path.join(artifactDir, "readiness-agent.stdout.log");
  const stderrPath = path.join(artifactDir, "readiness-agent.stderr.log");
  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  const child = spawn(
    "cargo",
    ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service"],
    {
      cwd: root,
      env: {
        ...process.env,
        VIVA_AGENT_BIND_ADDR: `127.0.0.1:${port}`,
        VIVA_AGENT_PROVIDER: "fake_cartesia_gemini",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  try {
    const ready = await waitForReady(`http://127.0.0.1:${port}/ready`);
    return {
      ready: ready.ready === true,
      provider: ready.brain?.provider,
      configured: ready.brain?.configured === true,
      selectable: ready.brain?.selectable === true,
      live_runtime: ready.brain?.live_runtime === true,
      store: {
        backend: ready.store?.backend,
        available: ready.store?.available === true,
        durable: ready.store?.durable === true,
        raw_audio_persistence: ready.store?.raw_audio_persistence === true,
        transcript_persistence: ready.store?.transcript_persistence === true,
      },
    };
  } finally {
    child.kill("SIGTERM");
    stdout.end();
    stderr.end();
  }
}

async function waitForReady(url) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 120_000) {
    try {
      const response = await fetch(url);
      const json = await response.json();
      if (response.ok && json.ready === true) return json;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for provider readiness${lastError ? `: ${lastError.message}` : ""}`,
  );
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
