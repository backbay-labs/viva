import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHostedMonitorPlan,
  buildObjectKey,
  isPublishableHostedArtifact,
  isRejectedHostedArtifact,
  normalizeHostedUrl,
  putS3Object,
  publishableHostedFiles,
  remainingPublishMs,
  summarizeHostedRun,
  writePublishedManifest,
} from "./hosted-monitor-runner.mjs";

const baseEnv = Object.freeze({
  VIVA_HOSTED_AGENT_HTTP_URL: "https://agent.example.com/",
  VIVA_HOSTED_AGENT_WS_URL: "wss://agent.example.com/ws",
  VIVA_HOSTED_ARTIFACT_BUCKET: "viva-monitor-evidence",
  VIVA_HOSTED_ARTIFACT_ENDPOINT: "https://storage.railway.app",
  VIVA_HOSTED_ARTIFACT_KEY_ID: "redacted-key-id",
  VIVA_HOSTED_ARTIFACT_REGION: "auto",
  VIVA_HOSTED_ARTIFACT_SECRET_KEY: "redacted-secret-key",
  VIVA_HOSTED_FAKE_PROVIDER_AGENT_HTTP_URL: "https://fake-agent.example.com/",
  VIVA_HOSTED_FAKE_PROVIDER_AGENT_WS_URL: "wss://fake-agent.example.com/ws",
  VIVA_HOSTED_FAKE_PROVIDER_WEB_URL: "https://fake-web.example.com/",
  VIVA_HOSTED_FAILURE_CONTROL_AGENT_HTTP_URL: "https://failure-agent.example.com/",
  VIVA_HOSTED_FAILURE_CONTROL_AGENT_WS_URL: "wss://failure-agent.example.com/ws",
  VIVA_HOSTED_FAILURE_CONTROL_WEB_URL: "https://failure-web.example.com/",
  VIVA_HOSTED_REST_BEARER_TOKEN: "redacted-rest-bearer",
  VIVA_HOSTED_RUN_ID: "run-2026-06-23T19-20-00Z",
  VIVA_HOSTED_SYNTHETIC_STUDY_SET_ID: "biology-midterm",
  VIVA_HOSTED_SYNTHETIC_USER_ID: "synthetic-monitor-user",
  VIVA_HOSTED_WEB_URL: "https://web.example.com/",
  VIVA_VOICE_SESSION_TOKEN_SECRET: "redacted-session-secret",
});

test("hosted monitor plan runs scheduled synthetic browser proof against hosted URLs", () => {
  const plan = buildHostedMonitorPlan(baseEnv);

  assert.equal(plan.mode, "scheduled");
  assert.equal(plan.artifactPrefix, "viva-hosted-monitor/scheduled/run-2026-06-23T19-20-00Z");
  assert.equal(plan.runs.length, 1);
  assert.equal(plan.runs[0].name, "scheduled_hosted_synthetic_monitor");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_WEB_URL, "https://web.example.com");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_AGENT_HTTP_URL, "https://agent.example.com");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_AGENT_WS_URL, "wss://agent.example.com/ws");
  assert.equal(plan.runs[0].env.VIVA_E2E_HOSTED_REST_BEARER_TOKEN, "redacted-rest-bearer");
  assert.equal(plan.runs[0].env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID, "synthetic-monitor-user");
  assert.equal(plan.runs[0].env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID, "biology-midterm");
  assert.equal(plan.runs[0].env.VIVA_E2E_SYNTHETIC_USER_ID, "synthetic-monitor-user");
  assert.equal(plan.runs[0].env.VIVA_E2E_SYNTHETIC_STUDY_SET_ID, "biology-midterm");
  assert.equal(plan.runs[0].env.VIVA_E2E_STOP_TO_RECAP, undefined);
  assert.equal(plan.runs[0].env.VIVA_E2E_REQUIRE_POST_ANSWER_SOURCE_FOLIO, "0");
  assert.equal(plan.runTimeoutMs, 600000);
  assert.equal(plan.publishTimeoutMs, 120000);
});

test("hosted monitor PR mode includes the failure-control browser slice", () => {
  const plan = buildHostedMonitorPlan({
    ...baseEnv,
    VIVA_FAILURE_CONTROL_SECRET: "redacted-control-secret",
    VIVA_HOSTED_RUNNER_MODE: "pr",
  });

  assert.equal(plan.mode, "pr");
  assert.deepEqual(
    plan.runs.map((run) => run.name),
    [
      "pr_hosted_synthetic_matrix",
      "pr_hosted_fake_provider_matrix",
      "pr_hosted_failure_control_provider_rate_limited",
    ],
  );
  assert.equal(plan.runs[1].env.VIVA_E2E_AGENT_PROVIDER, "fake_cartesia_gemini");
  assert.equal(plan.runs[1].env.VIVA_E2E_HOSTED_WEB_URL, "https://fake-web.example.com");
  assert.equal(plan.runs[2].env.VIVA_E2E_FAILURE_CONTROL_SCENARIO, "provider_rate_limited");
  assert.equal(plan.runs[2].env.VIVA_E2E_HOSTED_WEB_URL, "https://failure-web.example.com");
  assert.equal(
    plan.runs[2].env.VIVA_E2E_HOSTED_AGENT_HTTP_URL,
    "https://failure-agent.example.com",
  );
  assert.equal(
    plan.runs[2].env.VIVA_FAILURE_CONTROL_ALLOWED_ORIGINS,
    "https://failure-web.example.com",
  );
  assert.equal(plan.runs[2].env.VIVA_FAILURE_CONTROL_ENABLED, "1");
  assert.equal(plan.runs[2].env.VIVA_FAILURE_CONTROL_SYNTHETIC_USER_IDS, "synthetic-monitor-user");
  assert.equal(plan.runs[2].env.VIVA_FAILURE_CONTROL_STUDY_SET_IDS, "biology-midterm");
});

test("hosted monitor rejects learner-like runner identities", () => {
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_SYNTHETIC_USER_ID: "learner-123",
      }),
    /synthetic monitor identity/,
  );
});

test("hosted monitor requires durable artifact store settings", () => {
  const { VIVA_HOSTED_ARTIFACT_BUCKET, ...env } = baseEnv;

  assert.throws(() => buildHostedMonitorPlan(env), /VIVA_HOSTED_ARTIFACT_BUCKET/);
});

test("hosted monitor validates run timeout", () => {
  assert.equal(
    buildHostedMonitorPlan({
      ...baseEnv,
      VIVA_HOSTED_RUN_TIMEOUT_MS: "120000",
    }).runTimeoutMs,
    120000,
  );
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_RUN_TIMEOUT_MS: "0",
      }),
    /VIVA_HOSTED_RUN_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_PUBLISH_TIMEOUT_MS: "0",
      }),
    /VIVA_HOSTED_PUBLISH_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () =>
      buildHostedMonitorPlan({
        ...baseEnv,
        VIVA_HOSTED_RUN_ID: "..",
      }),
    /must not be empty or a dot path segment/,
  );
});

test("hosted monitor writes final manifest for timed-out runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-manifest-"));
  try {
    const run = { name: "scheduled_hosted_synthetic_monitor" };
    const runDir = path.join(dir, run.name);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "timeout.json"),
      `${JSON.stringify(
        {
          failure_class: "timeout",
          run: run.name,
          sanitized: true,
          status: "timed_out",
          timeout_ms: 120000,
        },
        null,
        2,
      )}\n`,
    );

    const summary = {
      schema: "viva.hosted_monitor_run.v1",
      mode: "scheduled",
      run_id: "run-id",
      runs: [
        summarizeHostedRun(
          run,
          runDir,
          runDir,
          {
            failure_class: "timeout",
            sanitized: true,
            status: "timed_out",
            timeout_ms: 120000,
          },
          null,
          dir,
        ),
      ],
    };
    const published = await writePublishedManifest(dir, summary, {
      artifactPrefix: "viva-hosted-monitor/scheduled/run-id",
      artifactStore: { bucket: "viva-monitor-evidence" },
    });

    assert.equal(published.status, "failed");
    assert.equal(published.runs[0].status, "timed_out");
    assert.equal(published.runs[0].failure_class, "timeout");
    assert.equal(published.durable_artifact_store.uploaded_files, 2);

    const stored = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(stored.status, "failed");
    assert.equal(stored.runs[0].status, "timed_out");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("hosted monitor summarizes browser artifacts below the run log directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-summary-"));
  try {
    const run = { name: "scheduled_hosted_synthetic_monitor" };
    const runDir = path.join(dir, run.name);
    const browserDir = path.join(runDir, "browser");
    await mkdir(browserDir, { recursive: true });

    const summary = summarizeHostedRun(
      run,
      runDir,
      browserDir,
      { exit_code: 0, sanitized: true, status: "passed" },
      {
        browser_story_artifact: "browser-story.json",
        browser_story: { frames: [{ id: "recap" }] },
        manuscript_ready: true,
        page_errors: [],
      },
      dir,
    );

    assert.equal(summary.artifact_dir, "scheduled_hosted_synthetic_monitor");
    assert.equal(summary.browser_story_artifact, "browser/browser-story.json");
    assert.deepEqual(summary.browser_story_frames, ["recap"]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("hosted monitor S3 uploads honor the publication deadline", async () => {
  assert.equal(remainingPublishMs(110, 100), 10);
  assert.throws(() => remainingPublishMs(99, 100), /publication timed out/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  try {
    await assert.rejects(
      () =>
        putS3Object(
          {
            accessKeyId: "redacted-key-id",
            bucket: "viva-monitor-evidence",
            endpoint: "https://storage.example.com",
            region: "auto",
            secretAccessKey: "redacted-secret-key",
          },
          "viva-hosted-monitor/scheduled/run-id/result.json",
          Buffer.from("{}\n"),
          "application/json",
          { deadlineMs: Date.now() + 20 },
        ),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted monitor normalizes URLs and object keys", () => {
  assert.equal(normalizeHostedUrl("https://web.example.com///"), "https://web.example.com");
  assert.throws(() => normalizeHostedUrl("ftp://web.example.com"), /http:\/\/ or https:\/\//);
  assert.equal(
    buildObjectKey("viva-hosted-monitor/scheduled/run-id", "browser/result.json"),
    "viva-hosted-monitor/scheduled/run-id/browser/result.json",
  );
  assert.throws(() => buildObjectKey("prefix", "../secret.txt"), /unsafe artifact path/);
});

test("hosted monitor only publishes text evidence files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-hosted-monitor-"));
  try {
    await writeFile(path.join(dir, "result.json"), "{}\n");
    await writeFile(path.join(dir, "e2e.stdout.log"), "ok\n");
    await writeFile(path.join(dir, "manifest.json"), "{}\n");
    await writeFile(path.join(dir, "source-folio.png"), "not-published");

    assert.equal(isPublishableHostedArtifact("result.json"), true);
    assert.equal(isPublishableHostedArtifact("e2e.stdout.log"), true);
    assert.equal(isPublishableHostedArtifact("source-folio.png"), false);
    assert.equal(isRejectedHostedArtifact("trace.zip"), true);
    assert.equal(isRejectedHostedArtifact("trace.tar"), true);
    assert.equal(isRejectedHostedArtifact("trace.tgz"), true);
    assert.equal(isRejectedHostedArtifact("trace.tar.gz"), true);
    assert.equal(isRejectedHostedArtifact("trace.7z"), true);
    assert.equal(isRejectedHostedArtifact("trace.rar"), true);
    assert.deepEqual(
      (await publishableHostedFiles(dir)).map((file) => path.basename(file)),
      ["e2e.stdout.log", "result.json"],
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
