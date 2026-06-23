#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostedArtifactRoot = path.join(root, "artifacts/hosted-monitor");
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

  const hostedWebUrl = normalizeHostedUrl(requiredValue(env, "VIVA_HOSTED_WEB_URL"));
  const hostedAgentHttpUrl = normalizeHostedUrl(requiredValue(env, "VIVA_HOSTED_AGENT_HTTP_URL"));
  const hostedAgentWsUrl = normalizeWebSocketUrl(requiredValue(env, "VIVA_HOSTED_AGENT_WS_URL"));
  const syntheticUserId = requiredValue(env, "VIVA_HOSTED_SYNTHETIC_USER_ID");
  const syntheticStudySetId = requiredValue(env, "VIVA_HOSTED_SYNTHETIC_STUDY_SET_ID");
  assertSyntheticIdentity(syntheticUserId);

  const runId = sanitizeRunId(
    env.VIVA_HOSTED_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  const artifactPrefix = `viva-hosted-monitor/${mode}/${runId}`;
  const baseEnv = {
    NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID: syntheticStudySetId,
    NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID: syntheticUserId,
    VIVA_E2E_AGENT_PROVIDER: env.VIVA_E2E_AGENT_PROVIDER || "synthetic",
    VIVA_E2E_HOSTED_AGENT_HTTP_URL: hostedAgentHttpUrl,
    VIVA_E2E_HOSTED_AGENT_WS_URL: hostedAgentWsUrl,
    VIVA_E2E_HOSTED_WEB_URL: hostedWebUrl,
    VIVA_HOSTED_RUN_ID: runId,
    VIVA_VOICE_SESSION_TOKEN_SECRET: requiredValue(env, "VIVA_VOICE_SESSION_TOKEN_SECRET"),
  };
  const runs =
    mode === "scheduled"
      ? [
          {
            name: "scheduled_hosted_synthetic_monitor",
            env: {
              ...baseEnv,
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
              VIVA_E2E_STOP_TO_RECAP: "1",
            },
          },
        ]
      : [
          {
            name: "pr_hosted_synthetic_matrix",
            env: {
              ...baseEnv,
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "1",
            },
          },
          {
            name: "pr_hosted_failure_control_provider_rate_limited",
            env: {
              ...baseEnv,
              VIVA_E2E_FAILURE_CONTROL_SCENARIO:
                env.VIVA_E2E_FAILURE_CONTROL_SCENARIO || "provider_rate_limited",
              VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO: "0",
              VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS: hostedWebUrl,
              VIVA_FAILURE_CONTROL_ENABLED: "1",
              VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY:
                env.VIVA_FAILURE_CONTROL_MAX_SESSIONS_PER_IDENTITY || "1",
              VIVA_FAILURE_CONTROL_SECRET: requiredValue(env, "VIVA_FAILURE_CONTROL_SECRET"),
              VIVA_FAILURE_CONTROL_STUDY_SET_IDS: syntheticStudySetId,
              VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS: syntheticUserId,
            },
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
    hostedAgentHttpUrl,
    hostedAgentWsUrl,
    hostedWebUrl,
    mode,
    runId,
    runs,
    syntheticStudySetId,
    syntheticUserId,
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

  const manifestPath = path.join(outputDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`);
  await auditHostedArtifacts(outputDir);
  const uploaded = await publishDirectoryToS3(outputDir, plan.artifactPrefix, plan.artifactStore);
  const published = {
    ...summary,
    durable_artifact_store: {
      bucket: plan.artifactStore.bucket,
      object_prefix: plan.artifactPrefix,
      uploaded_files: uploaded.length,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(published, null, 2)}\n`);
  console.log(JSON.stringify(published, null, 2));
}

async function runHostedE2E(run, runDir) {
  const stdout = createWriteStream(path.join(runDir, "e2e.stdout.log"));
  const stderr = createWriteStream(path.join(runDir, "e2e.stderr.log"));
  const child = spawn("bun", ["run", "e2e:browser"], {
    cwd: root,
    env: {
      ...process.env,
      ...run.env,
      VIVA_E2E_ARTIFACT_DIR: runDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const code = await new Promise((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  stdout.end();
  stderr.end();
  if (code !== 0) {
    throw new Error(`${run.name} failed with exit code ${code}`);
  }
}

async function publishDirectoryToS3(directory, prefix, store) {
  const uploaded = [];
  for (const file of await listFiles(directory)) {
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
  const signature = hmacHex(signingKey(store.secretAccessKey, dateStamp, store.region), stringToSign);
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
    if (!isTextArtifact(file)) continue;
    const text = await readFile(file, "utf8");
    for (const marker of forbiddenArtifactMarkers) {
      if (text.includes(marker)) {
        throw new Error(`hosted monitor artifact ${path.relative(root, file)} includes forbidden marker`);
      }
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
      if (value && value.length >= 8 && text.includes(value)) {
        throw new Error(`hosted monitor artifact ${path.relative(root, file)} includes secret value from ${name}`);
      }
    }
  }
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
    throw new Error("VIVA_HOSTED_SYNTHETIC_USER_ID must be a synthetic monitor identity, never a learner");
  }
}

function requiredValue(env, name) {
  const value = env[name];
  if (!value || !String(value).trim()) throw new Error(`${name} is required`);
  return String(value).trim();
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
