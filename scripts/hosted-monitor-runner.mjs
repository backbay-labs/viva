#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostedArtifactRoot = path.join(root, "artifacts/hosted-monitor");
const defaultRunTimeoutMs = 10 * 60 * 1000;
const forbiddenArtifactMarkers = [
  "pcm16_base64",
  "answer_text",
  "transcript_final",
  "source_context",
  "pasted_text",
  "session_token",
  "viva1.",
  "session-secret",
  "CARTESIA_API_KEY",
  "GEMINI_API_KEY",
  "Bearer ",
  "bearer.",
];

export function buildHostedMonitorPlan(env = process.env) {
  const mode = (env.VIVA_HOSTED_RUNNER_MODE || "scheduled").trim();
  if (!["scheduled", "pr"].includes(mode)) {
    throw new Error("VIVA_HOSTED_RUNNER_MODE must be scheduled or pr");
  }

  const syntheticUserId = requiredValue(env, "VIVA_HOSTED_SYNTHETIC_USER_ID");
  const syntheticStudySetId = requiredValue(env, "VIVA_HOSTED_SYNTHETIC_STUDY_SET_ID");
  assertSyntheticIdentity(syntheticUserId);
  const runTimeoutMs = positiveInteger(env.VIVA_HOSTED_RUN_TIMEOUT_MS, defaultRunTimeoutMs);

  const runId = sanitizeRunId(
    env.VIVA_HOSTED_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  const artifactPrefix = `viva-hosted-monitor/${mode}/${runId}`;
  const baseTarget = hostedTargetFromEnv(env, {
    agentHttpName: "VIVA_HOSTED_AGENT_HTTP_URL",
    agentWsName: "VIVA_HOSTED_AGENT_WS_URL",
    provider: env.VIVA_E2E_AGENT_PROVIDER || "synthetic",
    webName: "VIVA_HOSTED_WEB_URL",
  });
  const baseEnv = {
    NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID: syntheticStudySetId,
    NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID: syntheticUserId,
    VIVA_E2E_SYNTHETIC_STUDY_SET_ID: syntheticStudySetId,
    VIVA_E2E_SYNTHETIC_USER_ID: syntheticUserId,
    VIVA_HOSTED_RUN_ID: runId,
    VIVA_VOICE_SESSION_TOKEN_SECRET: requiredValue(env, "VIVA_VOICE_SESSION_TOKEN_SECRET"),
  };
  const syntheticTarget = {
    ...baseTarget,
    provider: "synthetic",
  };
  const fakeTarget =
    mode === "pr"
      ? hostedTargetFromEnv(env, {
          agentHttpName: "VIVA_HOSTED_FAKE_PROVIDER_AGENT_HTTP_URL",
          agentWsName: "VIVA_HOSTED_FAKE_PROVIDER_AGENT_WS_URL",
          provider: "fake_cartesia_gemini",
          webName: "VIVA_HOSTED_FAKE_PROVIDER_WEB_URL",
        })
      : null;
  const runs =
    mode === "scheduled"
      ? [
          {
            name: "scheduled_hosted_synthetic_monitor",
            env: runEnv(baseEnv, syntheticTarget, {
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
            }),
            timeoutMs: runTimeoutMs,
          },
        ]
      : [
          {
            name: "pr_hosted_synthetic_matrix",
            env: runEnv(baseEnv, syntheticTarget, {
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "1",
            }),
            timeoutMs: runTimeoutMs,
          },
          {
            name: "pr_hosted_fake_provider_matrix",
            env: runEnv(baseEnv, fakeTarget, {
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
            }),
            timeoutMs: runTimeoutMs,
          },
          {
            name: "pr_hosted_failure_control_provider_rate_limited",
            env: runEnv(baseEnv, syntheticTarget, {
              VIVA_E2E_FAILURE_CONTROL_SCENARIO:
                env.VIVA_E2E_FAILURE_CONTROL_SCENARIO || "provider_rate_limited",
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
              VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS: baseTarget.webUrl,
              VIVA_FAILURE_CONTROL_ENABLED: "1",
              VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY:
                env.VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY || "1",
              VIVA_FAILURE_CONTROL_SECRET: requiredValue(env, "VIVA_FAILURE_CONTROL_SECRET"),
              VIVA_FAILURE_CONTROL_STUDY_SET_IDS: syntheticStudySetId,
              VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS: syntheticUserId,
            }),
            timeoutMs: runTimeoutMs,
          },
        ];

  return {
    artifactPrefix,
    artifactStore: {
      accessKeyId: requiredValue(env, "VIVA_HOSTED_ARTIFACT_KEY_ID"),
      bucket: requiredValue(env, "VIVA_HOSTED_ARTIFACT_BUCKET"),
      endpoint: normalizeHostedUrl(requiredValue(env, "VIVA_HOSTED_ARTIFACT_ENDPOINT")),
      region: env.VIVA_HOSTED_ARTIFACT_REGION || "auto",
      secretAccessKey: requiredValue(env, "VIVA_HOSTED_ARTIFACT_SECRET_KEY"),
    },
    hostedAgentHttpUrl: baseTarget.agentHttpUrl,
    hostedAgentWsUrl: baseTarget.agentWsUrl,
    hostedWebUrl: baseTarget.webUrl,
    mode,
    runId,
    runTimeoutMs,
    runs,
    syntheticStudySetId,
    syntheticUserId,
  };
}

function hostedTargetFromEnv(env, { agentHttpName, agentWsName, provider, webName }) {
  return {
    agentHttpUrl: normalizeHostedUrl(requiredValue(env, agentHttpName)),
    agentWsUrl: normalizeWebSocketUrl(requiredValue(env, agentWsName)),
    provider,
    webUrl: normalizeHostedUrl(requiredValue(env, webName)),
  };
}

function runEnv(baseEnv, target, extra = {}) {
  return {
    ...baseEnv,
    VIVA_E2E_AGENT_PROVIDER: target.provider,
    VIVA_E2E_HOSTED_AGENT_HTTP_URL: target.agentHttpUrl,
    VIVA_E2E_HOSTED_AGENT_WS_URL: target.agentWsUrl,
    VIVA_E2E_HOSTED_WEB_URL: target.webUrl,
    ...extra,
  };
}

export function normalizeHostedUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("hosted URLs must use http:// or https://");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.toString().replace(/\/$/g, "");
}

export function buildObjectKey(prefix, relativePath) {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const normalizedRelative = relativePath.replaceAll("\\", "/").replace(/^\/+/g, "");
  if (
    !normalizedRelative ||
    path.posix.isAbsolute(normalizedRelative) ||
    normalizedRelative.split("/").includes("..")
  ) {
    throw new Error(`unsafe artifact path: ${relativePath}`);
  }
  return `${normalizedPrefix}/${normalizedRelative}`;
}

async function main() {
  const plan = buildHostedMonitorPlan();
  const outputDir = path.join(hostedArtifactRoot, plan.mode, plan.runId);
  await mkdir(outputDir, { recursive: true });
  const summary = {
    schema: "viva.hosted_monitor_run.v1",
    generated_at: new Date().toISOString(),
    mode: plan.mode,
    run_id: plan.runId,
    artifact_prefix: plan.artifactPrefix,
    hosted_web_origin: plan.hostedWebUrl,
    hosted_agent_origin: plan.hostedAgentHttpUrl,
    runner_identity: {
      synthetic_user_id: plan.syntheticUserId,
      study_set_id: plan.syntheticStudySetId,
      learner_identity_used: false,
    },
    runs: [],
  };

  for (const run of plan.runs) {
    const runDir = path.join(outputDir, run.name);
    await mkdir(runDir, { recursive: true });
    await runHostedE2E(run, runDir);
    const result = JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8"));
    await auditHostedArtifacts(runDir);
    summary.runs.push({
      name: run.name,
      artifact_dir: path.relative(root, runDir),
      browser_story_artifact: result.browser_story_artifact,
      browser_story_frames: Array.isArray(result.browser_story?.frames)
        ? result.browser_story.frames.map((frame) => frame.id).filter(Boolean)
        : [],
      failure_control_terminal: result.failure_control_terminal
        ? {
            scenario_id: result.failure_control_terminal.scenario_id,
            terminal_reason: result.failure_control_terminal.terminal_reason,
            sanitized: result.failure_control_terminal.sanitized === true,
          }
        : null,
      manuscript_ready: result.manuscript_ready === true,
      page_error_count: Array.isArray(result.page_errors) ? result.page_errors.length : 0,
      sanitized: true,
    });
  }

  const published = await writePublishedManifest(outputDir, summary, plan);
  await auditHostedArtifacts(outputDir);
  const uploaded = await publishDirectoryToS3(outputDir, plan.artifactPrefix, plan.artifactStore);
  if (uploaded.length + 1 !== published.durable_artifact_store.uploaded_files) {
    throw new Error("hosted monitor upload count drifted before manifest publication");
  }
  await putS3Object(
    plan.artifactStore,
    buildObjectKey(plan.artifactPrefix, "manifest.json"),
    Buffer.from(`${JSON.stringify(published, null, 2)}\n`),
    "application/json",
  );
  console.log(JSON.stringify(published, null, 2));
}

async function writePublishedManifest(outputDir, summary, plan) {
  const manifestPath = path.join(outputDir, "manifest.json");
  const publishable = await publishableHostedFiles(outputDir);
  const published = {
    ...summary,
    durable_artifact_store: {
      bucket: plan.artifactStore.bucket,
      object_prefix: plan.artifactPrefix,
      published_artifact_policy: "text_json_logs_only",
      uploaded_files: publishable.length + 1,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(published, null, 2)}\n`);
  return published;
}

async function runHostedE2E(run, runDir) {
  const stdout = createWriteStream(path.join(runDir, "e2e.stdout.log"));
  const stderr = createWriteStream(path.join(runDir, "e2e.stderr.log"));
  const stdoutFinished = finished(stdout);
  const stderrFinished = finished(stderr);
  const child = spawn("bun", ["run", "e2e:browser"], {
    cwd: root,
    env: {
      ...process.env,
      ...run.env,
      VIVA_E2E_ARTIFACT_DIR: runDir,
      VIVA_E2E_TRACE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let timedOut = false;
  let killTimer;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    killTimer.unref?.();
  }, run.timeoutMs);
  timeout.unref?.();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? signal));
  });
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  await Promise.all([stdoutFinished, stderrFinished]);
  if (timedOut) {
    await writeFile(
      path.join(runDir, "timeout.json"),
      `${JSON.stringify({ run: run.name, sanitized: true, timeout_ms: run.timeoutMs }, null, 2)}\n`,
    );
    throw new Error(`${run.name} timed out after ${run.timeoutMs}ms`);
  }
  if (code !== 0) {
    throw new Error(`${run.name} failed with exit code ${code}`);
  }
}

async function publishDirectoryToS3(directory, prefix, store) {
  const uploaded = [];
  for (const file of await publishableHostedFiles(directory)) {
    const relative = path.relative(directory, file);
    const key = buildObjectKey(prefix, relative);
    const body = await readFile(file);
    await putS3Object(store, key, body, contentTypeFor(file));
    uploaded.push(key);
  }
  return uploaded;
}

async function putS3Object(store, key, body, contentType) {
  const endpoint = new URL(store.endpoint);
  endpoint.hostname = `${store.bucket}.${endpoint.hostname}`;
  endpoint.pathname = `/${key.split("/").map(encodeURIComponent).join("/")}`;
  const payloadHash = sha256Hex(body);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    "content-type": contentType,
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}`)
    .join("\n");
  const canonicalRequest = [
    "PUT",
    endpoint.pathname,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${store.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join("\n");
  const signature = hmacHex(
    signingKey(store.secretAccessKey, dateStamp, store.region),
    stringToSign,
  );
  const response = await fetch(endpoint, {
    body,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${store.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(`artifact upload failed for ${key} with HTTP ${response.status}`);
  }
}

async function auditHostedArtifacts(directory) {
  for (const file of await listFiles(directory)) {
    if (isRejectedHostedArtifact(file)) {
      throw new Error(`hosted monitor artifact ${path.relative(root, file)} is not allowed`);
    }
    if (!isTextArtifact(file)) continue;
    const text = await readFile(file, "utf8");
    for (const marker of forbiddenArtifactMarkers) {
      if (text.includes(marker)) {
        throw new Error(
          `hosted monitor artifact ${path.relative(root, file)} includes forbidden marker`,
        );
      }
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
      if (value && value.length >= 8 && text.includes(value)) {
        throw new Error(
          `hosted monitor artifact ${path.relative(root, file)} includes secret value from ${name}`,
        );
      }
    }
  }
}

export async function publishableHostedFiles(directory) {
  const files = [];
  for (const file of await listFiles(directory)) {
    if (path.basename(file) === "manifest.json") continue;
    if (isPublishableHostedArtifact(file)) files.push(file);
  }
  return files.sort();
}

export function isPublishableHostedArtifact(file) {
  return isTextArtifact(file) && !isRejectedHostedArtifact(file);
}

export function isRejectedHostedArtifact(file) {
  return /\.(zip|trace|har)$/i.test(file);
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

function normalizeWebSocketUrl(value) {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new Error("VIVA_HOSTED_AGENT_WS_URL must use ws:// or wss://");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/g, "");
}

function assertSyntheticIdentity(userId) {
  if (!/(synthetic|monitor|test)/i.test(userId) || /(learner|student)/i.test(userId)) {
    throw new Error(
      "VIVA_HOSTED_SYNTHETIC_USER_ID must be a synthetic monitor identity, never a learner",
    );
  }
}

function requiredValue(env, name) {
  const value = env[name];
  if (!value || !String(value).trim()) throw new Error(`${name} is required`);
  return String(value).trim();
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("VIVA_HOSTED_RUN_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

function sanitizeRunId(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
}

function contentTypeFor(file) {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".log") || file.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secret, dateStamp, region) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function isTextArtifact(file) {
  return /\.(json|log|txt|stdout|stderr)$/i.test(file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
