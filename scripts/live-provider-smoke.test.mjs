import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  auditLiveSmokeEvidence,
  buildLiveSmokeConfig,
  configurationFailureEvidence,
  configurationFailureEvidenceWithMonitorState,
  createDeadline,
  interruptedEvidence,
  liveMonitorEvidence,
  runLiveProviderSmoke,
  smokeSessionConfigFrame,
  smokeStopFrame,
  summarizeServerFrame,
} from "./live-provider-smoke.mjs";

const LIVE_PROVIDER_SMOKE_PATH = "scripts/live-provider-smoke.mjs";

test("live provider smoke is skipped unless explicitly enabled", () => {
  const config = buildLiveSmokeConfig({ env: {} });

  assert.equal(config.enabled, false);
  assert.equal(config.provider, "cartesia_gemini");
  assert.equal(config.deploySha, "unknown");
  assert.equal(config.model, "gemini-3.5-flash");
  assert.equal(config.agentDeployId, null);
  assert.match(config.outputPath, /artifacts[/\\]live-provider-smoke[/\\]evidence\.json$/);
});

test("live provider smoke config reads an explicit agent deploy id, distinct from deploy_sha and run_id", () => {
  const withoutAgentDeployId = buildLiveSmokeConfig({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
      VIVA_LIVE_SMOKE_MAX_TURNS: "1",
      VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
      VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
      VIVA_LIVE_SMOKE_AUDIO_FILE: "/tmp/answer.pcm",
    },
  });
  assert.equal(withoutAgentDeployId.agentDeployId, null);

  const withAgentDeployId = buildLiveSmokeConfig({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
      VIVA_LIVE_SMOKE_MAX_TURNS: "1",
      VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
      VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
      VIVA_LIVE_SMOKE_AUDIO_FILE: "/tmp/answer.pcm",
      VIVA_LIVE_SMOKE_RUN_ID: "run-2026-06-23a",
      VIVA_LIVE_SMOKE_AGENT_DEPLOY_ID: "agent-deploy-456",
      GITHUB_SHA: "deploy-sha-123",
    },
  });
  assert.equal(withAgentDeployId.agentDeployId, "agent-deploy-456");
  assert.equal(withAgentDeployId.runId, "run-2026-06-23a");
  assert.equal(withAgentDeployId.deploySha, "deploy-sha-123");
});

test("enabled live provider smoke requires the explicit secrets-confirmed attestation, never raw provider keys", () => {
  // RELEASE-016/021: the smoke never consumes CARTESIA_API_KEY/GEMINI_API_KEY
  // directly -- the agent deployment is the only component that holds them.
  // A caller confirms they are configured (with zero-data-retention approved)
  // on that deployment via one explicit attestation flag instead.
  assert.throws(
    () =>
      buildLiveSmokeConfig({
        env: {
          VIVA_LIVE_PROVIDER_SMOKE: "1",
        },
      }),
    /live provider secrets confirmation is required/,
  );
  assert.throws(
    () =>
      buildLiveSmokeConfig({
        env: {
          VIVA_LIVE_PROVIDER_SMOKE: "1",
          // Even if a hostile/leftover parent env happens to carry raw
          // provider keys, they must never substitute for the explicit
          // attestation flag.
          CARTESIA_API_KEY: "cartesia-secret",
          GEMINI_API_KEY: "gemini-secret",
        },
      }),
    /live provider secrets confirmation is required/,
  );

  assert.throws(
    () =>
      buildLiveSmokeConfig({
        env: {
          VIVA_LIVE_PROVIDER_SMOKE: "1",
          VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        },
      }),
    /missing live smoke cap/,
  );

  assert.throws(
    () =>
      buildLiveSmokeConfig({
        env: {
          VIVA_LIVE_PROVIDER_SMOKE: "1",
          VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
          VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
          VIVA_LIVE_SMOKE_MAX_TURNS: "1",
          VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
          VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        },
      }),
    /missing live smoke audio input/,
  );
});

test("enabled live provider smoke never reads or retains raw provider key values even when present", () => {
  const config = buildLiveSmokeConfig({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      CARTESIA_API_KEY: "leaked-cartesia-key-value",
      GEMINI_API_KEY: "leaked-gemini-key-value",
      VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
      VIVA_LIVE_SMOKE_MAX_TURNS: "1",
      VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
      VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
      VIVA_LIVE_SMOKE_AUDIO_FILE: "/tmp/answer.pcm",
    },
  });

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /leaked-cartesia-key-value/);
  assert.doesNotMatch(serialized, /leaked-gemini-key-value/);
});

test("live provider smoke holds no protocol-version literal of its own", async () => {
  // RELEASE-028 / A-03: the smoke used to declare `const PROTOCOL_VERSION = 5`
  // and only a source-text comparison against the shared contract noticed when
  // that number went stale. The number now comes from the server's own
  // validated `ready` frame, so there is nothing left here to drift.
  const smokeSource = await readFile(LIVE_PROVIDER_SMOKE_PATH, "utf8");

  assert.doesNotMatch(smokeSource, /const PROTOCOL_VERSION = \d+/);
  assert.match(smokeSource, /validatedVoiceFrameForRelease/);
  assert.match(smokeSource, /protocolVersion: proof\.protocol_version/);
});

test("configuration failures emit live-monitor rollback evidence", () => {
  const evidence = configurationFailureEvidence({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES: "1",
      GEMINI_MODEL: "gemini-live-test",
      GITHUB_SHA: "deploy-sha-123",
      VIVA_LIVE_SMOKE_RUN_ID: "run-2026-06-18a",
      VIVA_LIVE_SMOKE_AGENT_DEPLOY_ID: "agent-deploy-456",
    },
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  });

  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure_stage, "configuration");
  assert.equal(evidence.failure_class, "provider_auth_failure");
  assert.equal(evidence.deploy_sha, "deploy-sha-123");
  assert.equal(evidence.model, "gemini-live-test");
  assert.equal(evidence.run_id, "run-2026-06-18a");
  assert.equal(evidence.agent_deploy_id, "agent-deploy-456");
  assert.equal(evidence.monitor.failure_class, "live_monitor_failure");
  assert.equal(evidence.monitor.live_monitor_attempt_count, 1);
  assert.equal(evidence.monitor.live_monitor_consecutive_failures, 2);
  assert.equal(evidence.monitor.deploy_sha, "deploy-sha-123");
  assert.equal(evidence.monitor.model, "gemini-live-test");
  assert.equal(evidence.monitor.run_id, "run-2026-06-18a");
  assert.equal(evidence.monitor.agent_deploy_id, "agent-deploy-456");
  assert.equal(evidence.monitor.signal, "live_monitor_failure");
  assert.equal(evidence.monitor.terminal_reason, "configuration_error");
});

test("configuration failures preserve previous persisted live-monitor failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-config-prior-"));
  const evidencePath = path.join(tempDir, "evidence.json");
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      schema: "viva.live_provider_smoke.v1",
      deploy_sha: "deploy-sha-123",
      model: "gemini-live-test",
      status: "failed",
      monitor: {
        deploy_sha: "deploy-sha-123",
        live_monitor_consecutive_failures: 2,
        model: "gemini-live-test",
      },
    })}\n`,
  );

  try {
    const evidence = await configurationFailureEvidenceWithMonitorState({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_SMOKE_EVIDENCE_PATH: evidencePath,
        GEMINI_MODEL: "gemini-live-test",
        GITHUB_SHA: "deploy-sha-123",
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.monitor.live_monitor_consecutive_failures, 3);
    assert.equal(evidence.monitor.terminal_reason, "configuration_error");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("server frames summarize to safe counters without raw protocol payload", () => {
  const frames = [
    readyFrame(),
    eventFrame("transcript_final", {
      response_id: "response-1",
      text: "raw speech text must not be retained",
      confidence: 0.97,
    }),
    eventFrame("answer_evaluated", {
      response_id: "response-1",
      evaluation: { concise_feedback: "answer feedback must not be retained" },
    }),
    eventFrame("source_reference", {
      response_id: "response-1",
      source: { source_id: "source-1", excerpt: "source excerpt must not be retained" },
    }),
    eventFrame("audio_delta", {
      response_id: "response-1",
      frame: { pcm16_base64: "AQIDBA==" },
    }),
    eventFrame("recap_ready", {
      response_id: "response-1",
      recap: { next_action: "raw recap must not be retained" },
    }),
  ];

  const summaries = frames.map(summarizeServerFrame);
  assert.equal(summaries[0].kind, "ready");
  assert.equal(summaries[1].event_code, "final_transcript");
  assert.equal(summaries[2].event_code, "answer_eval");
  assert.equal(summaries[3].event_code, "source_ref");
  assert.equal(summaries[4].event_code, "audio_chunk");
  assert.equal(summaries[5].event_code, "recap");
  assert.deepEqual(
    summarizeServerFrame(
      eventFrame("recap_ready", {
        response_id: "response-partial",
        partial_reason: "provider_timeout",
        recap: { next_action: "raw partial recap must not be retained" },
      }),
    ),
    {
      event_code: "recap",
      kind: "event",
      partial_reason: "provider_timeout",
    },
  );

  const serialized = JSON.stringify(summaries);
  assert.doesNotMatch(serialized, /raw speech text/);
  assert.doesNotMatch(serialized, /answer feedback/);
  assert.doesNotMatch(serialized, /source excerpt/);
  assert.doesNotMatch(serialized, /raw recap/);
  assert.doesNotMatch(serialized, /AQIDBA==/);
  assert.doesNotMatch(serialized, /transcript_final/);
  assert.doesNotMatch(serialized, /pcm16_base64/);
});

test("live smoke evidence audit rejects secret values and raw payload markers", () => {
  const safe = {
    schema: "viva.live_provider_smoke.v1",
    generated_at: "2026-06-18T00:00:00.000Z",
    enabled: true,
    status: "passed",
    provider: "cartesia_gemini",
    caps: {
      max_duration_ms: 60000,
      max_turns: 1,
      max_session_cost_usd: 0.25,
      max_audio_bytes: 4096,
    },
    readiness: {
      ready: true,
      brain: {
        provider: "cartesia_gemini",
        configured: true,
        selectable: true,
        live_runtime: true,
      },
      store: {
        available: true,
        durable: true,
      },
    },
    bootstrap: {
      server_study_created: true,
      signed_session_attached: true,
    },
    websocket: {
      opened: true,
      event_counts: {
        question: 1,
        final_transcript: 1,
        answer_eval: 1,
        source_ref: 1,
        audio_chunk: 2,
        recap: 1,
      },
      required_events: {
        question: true,
        final_transcript: true,
        answer_eval: true,
        source_ref: true,
        audio_chunk: true,
        recap: true,
      },
    },
    usage: {
      events_before: 2,
      events_after: 3,
      events_delta: 1,
      cost_budget_usd: 0.25,
    },
    privacy: {
      raw_audio_retained: false,
      transcript_content_retained: false,
      answer_content_retained: false,
      full_notes_retained: false,
      prompt_content_retained: false,
      source_excerpts_retained: false,
      provider_secret_values_recorded: false,
    },
  };

  assert.doesNotThrow(() =>
    auditLiveSmokeEvidence(safe, {
      CARTESIA_API_KEY: "cartesia-secret-value",
      GEMINI_API_KEY: "gemini-secret-value",
    }),
  );

  assert.throws(
    () => auditLiveSmokeEvidence({ ...safe, leaked: "CARTESIA_API_KEY=cartesia-secret-value" }, {}),
    /forbidden payload marker/,
  );
  assert.throws(
    () =>
      auditLiveSmokeEvidence(
        { ...safe, leaked: "cartesia-secret-value" },
        {
          CARTESIA_API_KEY: "cartesia-secret-value",
        },
      ),
    /secret value/,
  );
  assert.throws(
    () => auditLiveSmokeEvidence({ ...safe, leaked: "pcm16_base64" }, {}),
    /forbidden payload marker/,
  );
});

test("live monitor stuck-checking evidence is reserved for recap timeouts", () => {
  const recapTimeout = liveMonitorEvidence({
    consecutiveFailures: 1,
    deploySha: "deploy-sha-123",
    model: "gemini-live-test",
    status: "failed",
    terminalReason: "recap_timeout",
    runId: "run-2026-06-23a",
    agentDeployId: "agent-deploy-456",
  });
  const turnCapExceeded = liveMonitorEvidence({
    consecutiveFailures: 1,
    status: "failed",
    terminalReason: "turn_cap_exceeded",
  });

  assert.equal(recapTimeout.stuck_checking_sessions, 1);
  assert.equal(recapTimeout.live_monitor_consecutive_failures, 2);
  assert.equal(recapTimeout.deploy_sha, "deploy-sha-123");
  assert.equal(recapTimeout.model, "gemini-live-test");
  assert.equal(recapTimeout.run_id, "run-2026-06-23a");
  assert.equal(recapTimeout.agent_deploy_id, "agent-deploy-456");
  assert.equal(turnCapExceeded.stuck_checking_sessions, 0);
  assert.equal(turnCapExceeded.live_monitor_consecutive_failures, 2);
  assert.equal(turnCapExceeded.deploy_sha, "unknown");
  assert.equal(turnCapExceeded.model, "gemini-3.5-flash");
  // Correlation identity is optional input -- an omitted run/deploy id must
  // surface as null, never as the literal string "undefined" or a thrown
  // error, since not every liveMonitorEvidence caller has both in scope.
  assert.equal(turnCapExceeded.run_id, null);
  assert.equal(turnCapExceeded.agent_deploy_id, null);
});

test("createDeadline computes remaining milliseconds and throws once exhausted", () => {
  const deadline = createDeadline({ nowMs: 1_000, durationMs: 90_000 });

  assert.equal(deadline.remainingMs(31_000), 60_000);
  assert.equal(deadline.remainingMs(1_000), 90_000);
  assert.throws(() => deadline.remainingMs(91_001), /live smoke deadline exceeded/);
  assert.throws(() => deadline.remainingMs(91_000), /live smoke deadline exceeded/);
});

test("runLiveProviderSmoke shares one deadline across readiness, question, and recap waits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-deadline-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new FakeSocket();
  const originalSend = socket.send.bind(socket);
  // Consume roughly a third of the total deadline responding to the
  // question, exactly like a slow-but-successful provider turn.
  socket.send = (data) => {
    if (typeof data === "string" && JSON.parse(data).type === "session_config") {
      setTimeout(() => {
        socket.message(eventFrame("session_phase", { phase: "listening" }));
        socket.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
      }, 100);
      socket.sent.push(data);
      return;
    }
    if (Buffer.isBuffer(data)) {
      // Never answer after the question: forces the recap wait to exhaust
      // whatever budget the shared deadline has left, rather than being
      // handed a fresh full cap of its own.
      socket.sent.push(data);
      return;
    }
    originalSend(data);
  };

  try {
    const startedAt = Date.now();
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        // A small total envelope: enough for the ~100ms question delay,
        // but nowhere near enough for a *second* fresh cap on top of it.
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "300",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
      },
      fetchImpl: async (url) => {
        // Readiness itself consumes real time too, and must count against
        // the same shared deadline as the websocket stages.
        if (String(url).endsWith("/health/brain")) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return jsonResponse(200, brainHealth());
        }
        if (String(url).endsWith("/ready")) return jsonResponse(200, readyBody());
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: { id: "server-study-set", user_id: "user-1", ingestion_status: "ready" },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.websocket.terminal_reason, "recap_timeout");
    // If every stage were still handed a fresh 300ms cap of its own (the
    // pre-fix bug), the readiness delay plus the question delay plus a
    // *full fresh* recap timeout would take at least ~460ms. Sharing one
    // 300ms deadline across every stage keeps the whole run well under
    // that regardless of how the elapsed time is distributed.
    assert.ok(
      elapsedMs < 420,
      `expected the shared deadline to bound total elapsed time, got ${elapsedMs}ms`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("interruptedEvidence produces a minimal sanitized partial-failure shape for each named stage", () => {
  for (const stage of ["readiness", "websocket_question", "websocket_recap"]) {
    const evidence = interruptedEvidence(
      {
        stage,
        eventCounts: stage === "websocket_recap" ? { question: 1, recap: 0 } : null,
        deploySha: "deploy-sha-123",
        model: "gemini-live-test",
        runId: "run-2026-06-23a",
        agentDeployId: "agent-deploy-456",
      },
      "SIGTERM",
    );

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.partial, true);
    assert.equal(evidence.terminal_reason, "killed_by_runner");
    assert.equal(evidence.failure_class, "timeout");
    assert.equal(evidence.failure_stage, stage);
    assert.equal(evidence.signal, "SIGTERM");
    assert.equal(evidence.deploy_sha, "deploy-sha-123");
    assert.equal(evidence.run_id, "run-2026-06-23a");
    assert.equal(evidence.agent_deploy_id, "agent-deploy-456");
    assert.equal(typeof evidence.generated_at, "string");
    assert.doesNotThrow(() => auditLiveSmokeEvidence(evidence, {}));

    const allowedKeys = new Set([
      "schema",
      "generated_at",
      "deploy_sha",
      "model",
      "provider",
      "run_id",
      "agent_deploy_id",
      "status",
      "partial",
      "failure_stage",
      "failure_class",
      "terminal_reason",
      "signal",
      "event_counts",
      "privacy",
    ]);
    for (const key of Object.keys(evidence)) {
      assert.ok(allowedKeys.has(key), `interrupted evidence must not carry an extra field: ${key}`);
    }
  }
});

test("a real live-provider-smoke process writes complete audited partial evidence on SIGTERM", async () => {
  const artifactDir = path.resolve(process.cwd(), "artifacts/live-provider-smoke-test");
  await rm(artifactDir, { recursive: true, force: true });
  // The child is interrupted only once it has DEMONSTRABLY reached the stalled
  // readiness fetch. A fixed sleep was the previous synchronization primitive
  // and made this test load-flaky: under parallel load the child had not always
  // finished module loading -- and therefore had not installed its SIGTERM
  // handler -- within the sleep, so the signal hit Node's default disposition
  // and no evidence was ever written. The server's own first request is the
  // real signal that the handler is installed and the stage is open.
  let readinessRequestObserved;
  const readinessRequested = new Promise((resolve) => {
    readinessRequestObserved = resolve;
  });
  const stalledServer = http.createServer(() => {
    // Deliberately never respond, holding the readiness stage open until
    // the process is signaled.
    readinessRequestObserved();
  });
  await new Promise((resolve) => stalledServer.listen(0, "127.0.0.1", resolve));
  const { port } = stalledServer.address();

  try {
    const child = spawn(process.execPath, ["scripts/live-provider-smoke.mjs"], {
      cwd: path.resolve(process.cwd()),
      env: {
        ...process.env,
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: "/nonexistent.pcm",
        // Small but real: the smoke must not need process.exit() to stop
        // promptly, but this also bounds worst-case cleanup time if the
        // SIGTERM path ever regresses back to hanging on the deadline.
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "5000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: `http://127.0.0.1:${port}`,
        VIVA_LIVE_SMOKE_ARTIFACT_DIR: "artifacts/live-provider-smoke-test",
        VIVA_LIVE_SMOKE_RUN_ID: "run-sigterm-integration",
        VIVA_LIVE_SMOKE_AGENT_DEPLOY_ID: "agent-deploy-sigterm",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    // Wait for the child to actually reach the stalled readiness fetch, then
    // interrupt it the same way the hosted runner's supervisory kill does.
    await Promise.race([
      readinessRequested,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`child never reached the readiness fetch; stderr: ${stderr}`)),
          20_000,
        ),
      ),
    ]);
    child.kill("SIGTERM");

    // The plan is explicit: do not call process.exit() before the write
    // resolves. So SIGTERM must produce the evidence file promptly, but the
    // process itself may legitimately keep running afterward until a
    // supervisory SIGKILL arrives — exactly like the hosted runner's own
    // bounded fallback. Poll for the file rather than the process exit.
    const evidencePath = path.join(artifactDir, "evidence.json");
    const raw = await waitForFileContent(evidencePath, 2000);
    const evidence = JSON.parse(raw);

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.partial, true);
    assert.equal(evidence.terminal_reason, "killed_by_runner");
    assert.equal(evidence.failure_class, "timeout");
    assert.equal(evidence.run_id, "run-sigterm-integration");
    assert.equal(evidence.agent_deploy_id, "agent-deploy-sigterm");
    assert.doesNotThrow(() => auditLiveSmokeEvidence(evidence, {}));

    // Confirm the bounded fallback: SIGKILL now cleanly ends the process
    // that SIGTERM alone deliberately left running.
    child.kill("SIGKILL");
    const { signal } = await Promise.race([
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`child never exited; stderr: ${stderr}`)), 3000),
      ),
    ]);
    assert.equal(signal, "SIGKILL");
  } finally {
    await new Promise((resolve) => stalledServer.close(resolve));
    await rm(artifactDir, { recursive: true, force: true });
  }
});

async function waitForFileContent(filePath, timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT" || Date.now() >= deadlineAt) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

test("runLiveProviderSmoke proves readiness, bootstrap, websocket events, and usage counts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const fetchCalls = [];
  const socket = new FakeSocket();
  const createdSockets = [];

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_VOICE_WS_BEARER_TOKEN: "bearer-secret-value",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_TOKENS: "4096",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
        VIVA_LIVE_SMOKE_ORIGIN: "https://app.viva.test",
        GEMINI_MODEL: "gemini-live-test",
        GITHUB_SHA: "release-sha-123",
        VIVA_LIVE_SMOKE_RUN_ID: "run-2026-06-18a",
        VIVA_LIVE_SMOKE_AGENT_DEPLOY_ID: "agent-deploy-456",
      },
      fetchImpl: async (url, init = {}) => {
        fetchCalls.push({ url: String(url), init });
        if (String(url).endsWith("/health/brain")) {
          return jsonResponse(
            200,
            brainHealth({
              totalTokens: fetchCalls.length > 2 ? 1060 : 1000,
              usageEvents: fetchCalls.length > 2 ? 8 : 7,
            }),
          );
        }
        if (String(url).endsWith("/ready")) {
          return jsonResponse(200, readyBody());
        }
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: {
              id: "server-study-set",
              user_id: "user-1",
              ingestion_status: "ready",
            },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: (url, protocols, options) => {
        createdSockets.push({ url, protocols, options });
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "passed");
    assert.equal(evidence.readiness.ready, true);
    assert.equal(evidence.readiness.voice_limits.max_session_cost_usd, 0.25);
    assert.equal(evidence.bootstrap.server_study_created, true);
    assert.equal(evidence.bootstrap.signed_session_attached, true);
    assert.equal(evidence.websocket.event_counts.question, 1);
    assert.equal(evidence.websocket.event_counts.final_transcript, 1);
    assert.equal(evidence.websocket.event_counts.answer_eval, 1);
    assert.equal(evidence.websocket.event_counts.source_ref, 1);
    assert.equal(evidence.websocket.event_counts.audio_chunk, 1);
    assert.equal(evidence.websocket.event_counts.recap, 1);
    assert.equal(evidence.websocket.close_code, 1000);
    assert.equal(evidence.websocket.close_clean, true);
    assert.equal(evidence.usage.events_before, 7);
    assert.equal(evidence.usage.events_after, 8);
    assert.equal(evidence.usage.events_delta, 1);
    assert.equal(evidence.usage.tokens_before, 1000);
    assert.equal(evidence.usage.tokens_after, 1060);
    assert.equal(evidence.usage.tokens_delta, 60);
    assert.equal(evidence.usage.max_tokens, 4096);
    assert.equal(createdSockets[0].url, "wss://agent.viva.test/ws");
    assert.deepEqual(createdSockets[0].protocols, [
      "viva-voice",
      "bearer.YmVhcmVyLXNlY3JldC12YWx1ZQ",
    ]);
    assert.equal(createdSockets[0].options.origin, "https://app.viva.test");
    assert.equal(
      fetchCalls.find((call) => call.url.endsWith("/study-sets/paste")).init.headers.origin,
      "https://app.viva.test",
    );
    assert.equal(evidence.deploy_sha, "release-sha-123");
    assert.equal(evidence.model, "gemini-live-test");
    assert.equal(evidence.run_id, "run-2026-06-18a");
    assert.equal(evidence.agent_deploy_id, "agent-deploy-456");
    assert.equal(evidence.monitor.deploy_sha, "release-sha-123");
    assert.equal(evidence.monitor.model, "gemini-live-test");
    assert.equal(evidence.monitor.run_id, "run-2026-06-18a");
    assert.equal(evidence.monitor.agent_deploy_id, "agent-deploy-456");

    const sessionConfig = JSON.parse(socket.sent.find((entry) => typeof entry === "string"));
    assert.equal(sessionConfig.type, "session_config");
    assert.equal(sessionConfig.session.study_set_id, "server-study-set");
    assert.equal(sessionConfig.session.session_id, "server-session");
    assert.deepEqual(sessionConfig.session.source_context, []);
    assert.equal(sessionConfig.session_token, "viva1.server-token-secret");
    assert(Buffer.isBuffer(socket.sent.find((entry) => Buffer.isBuffer(entry))));

    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /cartesia-secret-value/);
    assert.doesNotMatch(serialized, /gemini-secret-value/);
    assert.doesNotMatch(serialized, /bearer-secret-value/);
    assert.doesNotMatch(serialized, /viva1\.server-token-secret/);
    assert.doesNotMatch(serialized, /raw answer/);
    assert.doesNotMatch(serialized, /raw source excerpt/);
    assert.doesNotMatch(serialized, /pcm16_base64/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke fails closed when usage exceeds the configured token cap", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-token-cap-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new FakeSocket();
  let healthCalls = 0;

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TOKENS: "4",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) {
          healthCalls += 1;
          return jsonResponse(
            200,
            brainHealth({
              totalTokens: healthCalls > 1 ? 1005 : 1000,
              usageEvents: healthCalls > 1 ? 8 : 7,
            }),
          );
        }
        if (String(url).endsWith("/ready")) {
          return jsonResponse(200, readyBody());
        }
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: {
              id: "server-study-set",
              user_id: "user-1",
              ingestion_status: "ready",
            },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure_stage, "usage");
    assert.equal(evidence.terminal_reason, "cost_budget");
    assert.equal(evidence.failure.failure_class, "quota_rate_failure");
    assert.equal(evidence.usage.tokens_before, 1000);
    assert.equal(evidence.usage.tokens_after, 1005);
    assert.equal(evidence.usage.tokens_delta, 5);
    assert.equal(evidence.usage.max_tokens, 4);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke rejects live targets without the expected remote cost cap", async () => {
  let socketOpened = false;

  const evidence = await runLiveProviderSmoke({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      VIVA_LIVE_SMOKE_AUDIO_FILE: "/tmp/not-read-before-cost-cap.pcm",
      VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
      VIVA_LIVE_SMOKE_MAX_TURNS: "1",
      VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
      VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD: "0.25",
      VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
      VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "http://127.0.0.1:4318",
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/health/brain")) {
        return jsonResponse(200, brainHealth({ maxSessionCostUsd: 0.5 }));
      }
      if (String(url).endsWith("/ready")) {
        return jsonResponse(200, readyBody({ maxSessionCostUsd: 0.5 }));
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    createWebSocket: () => {
      socketOpened = true;
      throw new Error("must not open socket before remote cost cap is verified");
    },
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  });

  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure_stage, "readiness");
  assert.equal(evidence.terminal_reason, "cost_budget");
  assert.equal(evidence.failure.failure_class, "quota_rate_failure");
  assert.equal(evidence.readiness.voice_limits.max_session_cost_usd, 0.5);
  assert.equal(socketOpened, false);

  // BAC-527: the remote-cost-cap failure must return the same complete top-level
  // shape as every other failure branch, not a partial evidence object.
  assert.equal(evidence.failure_class, "quota_rate_failure");
  assert.ok(evidence.monitor, "remote cost-cap failure must include monitor evidence");
  assert.equal(evidence.monitor.failure_class, "live_monitor_failure");
  assert.equal(evidence.monitor.terminal_reason, "cost_budget");
  assert.equal(evidence.monitor.live_monitor_consecutive_failures, 1);
});

test("runLiveProviderSmoke fails closed when the live provider is not selectable", async () => {
  let socketOpened = false;

  const evidence = await runLiveProviderSmoke({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      VIVA_LIVE_SMOKE_AUDIO_FILE: "/tmp/not-read-before-readiness.pcm",
      VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
      VIVA_LIVE_SMOKE_MAX_TURNS: "1",
      VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
      VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
      VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "http://127.0.0.1:4318",
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/health/brain")) {
        return jsonResponse(200, brainHealth({ selectable: false, liveRuntime: false }));
      }
      if (String(url).endsWith("/ready")) {
        return jsonResponse(
          503,
          readyBody({ ready: false, selectable: false, liveRuntime: false }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    createWebSocket: () => {
      socketOpened = true;
      throw new Error("must not open socket before readiness passes");
    },
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  });

  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure_stage, "readiness");
  assert.equal(evidence.failure_class, "provider_auth_failure");
  assert.equal(evidence.failure.failure_class, "provider_auth_failure");
  assert.equal(evidence.failure.terminal_reason, "provider_auth_failed");
  assert.equal(evidence.monitor.failure_class, "live_monitor_failure");
  assert.equal(evidence.monitor.live_monitor_attempt_count, 1);
  assert.equal(evidence.monitor.live_monitor_consecutive_failures, 1);
  assert.equal(evidence.monitor.signal, "live_monitor_failure");
  assert.equal(evidence.monitor.terminal_reason, "readiness_not_live_selectable");
  assert.deepEqual(evidence.failure.terminal_session_phase, {
    type: "session_phase",
    phase: "recap",
    terminal_reason: "provider_auth_failed",
  });
  assert.equal(evidence.failure.sanitized_evidence, true);
  assert.equal(evidence.failure.user_copy.next_action_label, "Check provider access");
  assert.equal(evidence.readiness.ready, false);
  assert.equal(evidence.readiness.brain.selectable, false);
  assert.equal(evidence.readiness.brain.live_runtime, false);
  assert.equal(socketOpened, false);
});

test("runLiveProviderSmoke fails closed when readiness lacks nonce replay protection", async () => {
  let socketOpened = false;

  const evidence = await runLiveProviderSmoke({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      VIVA_LIVE_SMOKE_AUDIO_FILE: "/tmp/not-read-before-readiness.pcm",
      VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
      VIVA_LIVE_SMOKE_MAX_TURNS: "1",
      VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
      VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
      VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "http://127.0.0.1:4318",
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/health/brain")) {
        return jsonResponse(200, brainHealth({ nonceReplayProtection: false }));
      }
      if (String(url).endsWith("/ready")) {
        return jsonResponse(200, readyBody({ nonceReplayProtection: false }));
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    createWebSocket: () => {
      socketOpened = true;
      throw new Error("must not open socket before durable readiness passes");
    },
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  });

  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure_stage, "readiness");
  assert.equal(evidence.failure.failure_class, "durability_degraded");
  assert.equal(evidence.failure.terminal_reason, "durability_degraded");
  assert.deepEqual(evidence.failure.terminal_session_phase, {
    type: "session_phase",
    phase: "recap",
    terminal_reason: "durability_degraded",
  });
  assert.equal(evidence.failure.sanitized_evidence, true);
  assert.equal(evidence.failure.user_copy.next_action_label, "Start a fresh turn");
  assert.equal(evidence.terminal_reason, "durability_degraded");
  assert.equal(evidence.readiness.store.available, true);
  assert.equal(evidence.readiness.store.durable, true);
  assert.equal(evidence.readiness.store.nonce_replay_protection, false);
  assert.equal(socketOpened, false);
});

test("runLiveProviderSmoke preserves access-denied readiness failures without store evidence", async () => {
  let socketOpened = false;

  const evidence = await runLiveProviderSmoke({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
      VIVA_LIVE_SMOKE_AUDIO_FILE: "/tmp/not-read-before-readiness.pcm",
      VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
      VIVA_LIVE_SMOKE_MAX_TURNS: "1",
      VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
      VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
      VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "http://127.0.0.1:4318",
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/health/brain")) {
        return jsonResponse(403, accessDeniedReadinessBody());
      }
      if (String(url).endsWith("/ready")) {
        return jsonResponse(403, accessDeniedReadinessBody());
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    createWebSocket: () => {
      socketOpened = true;
      throw new Error("must not open socket after access-denied readiness");
    },
    now: () => new Date("2026-06-18T00:00:00.000Z"),
  });

  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure_stage, "readiness");
  assert.equal(evidence.failure.failure_class, "provider_auth_failure");
  assert.equal(evidence.failure.terminal_reason, "provider_auth_failed");
  assert.equal(evidence.terminal_reason, "readiness_not_live_selectable");
  assert.equal(evidence.readiness.access.status, "denied");
  assert.equal(evidence.readiness.failure_kind, "access_denied");
  assert.equal(evidence.readiness.store.observed, false);
  assert.equal(socketOpened, false);
});

test("runLiveProviderSmoke classifies malformed-stream failures without retaining payloads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new MalformedStreamSocket();

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) {
          return jsonResponse(200, brainHealth());
        }
        if (String(url).endsWith("/ready")) {
          return jsonResponse(200, readyBody());
        }
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: {
              id: "server-study-set",
              user_id: "user-1",
              ingestion_status: "ready",
            },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure_stage, "websocket");
    assert.equal(evidence.websocket.terminal_reason, "server_error_frame");
    assert.equal(evidence.failure.failure_class, "malformed_stream");
    assert.equal(evidence.failure.terminal_reason, "provider_malformed_stream");
    assert.equal(evidence.failure.sanitized_evidence, true);

    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /provider raw payload with prompt text/);
    assert.doesNotMatch(serialized, /cartesia-secret-value/);
    assert.doesNotMatch(serialized, /gemini-secret-value/);
    assert.doesNotMatch(serialized, /viva1\.server-token-secret/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke classifies invalid JSON frames as malformed stream failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new InvalidJsonSocket();

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) {
          return jsonResponse(200, brainHealth());
        }
        if (String(url).endsWith("/ready")) {
          return jsonResponse(200, readyBody());
        }
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: {
              id: "server-study-set",
              user_id: "user-1",
              ingestion_status: "ready",
            },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure_stage, "websocket");
    assert.equal(evidence.websocket.terminal_reason, "invalid_server_frame");
    assert.equal(evidence.failure.failure_class, "malformed_stream");
    assert.equal(evidence.failure.terminal_reason, "provider_malformed_stream");
    // BAC-527: malformed JSON is a protocol-shaped failure, not a genuine
    // server-sent structured_error — the two counters must stay distinct.
    assert.equal(evidence.websocket.event_counts.protocol_error, 1);
    assert.equal(evidence.websocket.event_counts.structured_error, 0);
    assert.equal(evidence.websocket.event_counts.transport_error, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke classifies an unrecognized-but-valid frame type as a protocol failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new UnknownFrameTypeSocket();

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) return jsonResponse(200, brainHealth());
        if (String(url).endsWith("/ready")) return jsonResponse(200, readyBody());
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: { id: "server-study-set", user_id: "user-1", ingestion_status: "ready" },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.websocket.terminal_reason, "invalid_server_frame");
    assert.equal(evidence.websocket.event_counts.protocol_error, 1);
    assert.equal(evidence.websocket.event_counts.structured_error, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke classifies raw socket transport failures distinctly from protocol and structured errors", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new TransportErrorSocket();
  const commonEnv = {
    VIVA_LIVE_PROVIDER_SMOKE: "1",
    VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
    VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
    VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
    VIVA_LIVE_SMOKE_MAX_TURNS: "1",
    VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
    VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
    VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
  };
  const commonFetch = async (url) => {
    if (String(url).endsWith("/health/brain")) return jsonResponse(200, brainHealth());
    if (String(url).endsWith("/ready")) return jsonResponse(200, readyBody());
    if (String(url).endsWith("/study-sets/paste")) {
      return jsonResponse(201, {
        study_set: { id: "server-study-set", user_id: "user-1", ingestion_status: "ready" },
        session_id: "server-session",
        session_token: "viva1.server-token-secret",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const evidence = await runLiveProviderSmoke({
      env: commonEnv,
      fetchImpl: commonFetch,
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.websocket.terminal_reason, "socket_error");
    assert.equal(evidence.failure.failure_class, "network_disconnect");
    assert.equal(evidence.websocket.event_counts.transport_error, 1);
    assert.equal(evidence.websocket.event_counts.protocol_error, 0);
    assert.equal(evidence.websocket.event_counts.structured_error, 0);

    const closeSocket = new UnexpectedCloseSocket();
    const secondEvidence = await runLiveProviderSmoke({
      env: commonEnv,
      fetchImpl: commonFetch,
      createWebSocket: () => {
        queueMicrotask(() => {
          closeSocket.open();
          closeSocket.message(readyFrame());
        });
        return closeSocket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(secondEvidence.status, "failed");
    assert.equal(secondEvidence.websocket.terminal_reason, "socket_closed_before_recap");
    assert.equal(secondEvidence.failure.failure_class, "network_disconnect");
    assert.equal(secondEvidence.websocket.event_counts.transport_error, 1);
    assert.equal(secondEvidence.websocket.event_counts.protocol_error, 0);
    assert.equal(secondEvidence.websocket.event_counts.structured_error, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke retains the server's own allowed failure class for a recognized structured_error source", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new StructuredErrorSourceSocket("provider_rate_limited");

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) return jsonResponse(200, brainHealth());
        if (String(url).endsWith("/ready")) return jsonResponse(200, readyBody());
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: { id: "server-study-set", user_id: "user-1", ingestion_status: "ready" },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    // The source names a recognized reason, so it must be retained verbatim
    // instead of collapsing to the generic "server_error_frame" label.
    assert.equal(evidence.websocket.terminal_reason, "provider_rate_limited");
    assert.equal(evidence.failure.failure_class, "quota_rate_failure");
    assert.equal(evidence.websocket.event_counts.structured_error, 1);
    assert.equal(evidence.websocket.event_counts.protocol_error, 0);
    assert.equal(evidence.websocket.event_counts.transport_error, 0);

    const unrecognizedSocket = new StructuredErrorSourceSocket("totally_made_up_source");
    const secondEvidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) return jsonResponse(200, brainHealth());
        if (String(url).endsWith("/ready")) return jsonResponse(200, readyBody());
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: { id: "server-study-set", user_id: "user-1", ingestion_status: "ready" },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          unrecognizedSocket.open();
          unrecognizedSocket.message(readyFrame());
        });
        return unrecognizedSocket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(secondEvidence.websocket.terminal_reason, "server_error_frame");
    assert.equal(secondEvidence.websocket.event_counts.structured_error, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke maps runtime rate terminal phases to quota-rate failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new TerminalReasonSocket("rate_limit");

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
        VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES: "2",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) {
          return jsonResponse(200, brainHealth());
        }
        if (String(url).endsWith("/ready")) {
          return jsonResponse(200, readyBody());
        }
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: {
              id: "server-study-set",
              user_id: "user-1",
              ingestion_status: "ready",
            },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure_stage, "websocket");
    assert.equal(evidence.failure_class, "quota_rate_failure");
    assert.equal(evidence.websocket.terminal_reason, "rate_limit");
    assert.equal(evidence.failure.failure_class, "quota_rate_failure");
    assert.equal(evidence.failure.terminal_reason, "provider_rate_limited");
    assert.equal(evidence.monitor.failure_class, "live_monitor_failure");
    assert.equal(evidence.monitor.live_monitor_attempt_count, 1);
    assert.equal(evidence.monitor.live_monitor_consecutive_failures, 3);
    assert.equal(evidence.monitor.signal, "live_monitor_failure");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke increments previous persisted live-monitor failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-prior-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  const evidencePath = path.join(tempDir, "evidence.json");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      schema: "viva.live_provider_smoke.v1",
      deploy_sha: "release-sha-123",
      model: "gemini-live-test",
      status: "failed",
      monitor: {
        deploy_sha: "release-sha-123",
        live_monitor_consecutive_failures: 2,
        model: "gemini-live-test",
      },
    })}\n`,
  );

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_EVIDENCE_PATH: evidencePath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
        GEMINI_MODEL: "gemini-live-test",
        GITHUB_SHA: "release-sha-123",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) {
          return jsonResponse(503, brainHealth({ liveRuntime: false, selectable: false }));
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.monitor.live_monitor_consecutive_failures, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke resets persisted live-monitor failures across deploys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-prior-deploy-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  const evidencePath = path.join(tempDir, "evidence.json");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      schema: "viva.live_provider_smoke.v1",
      deploy_sha: "old-release-sha",
      model: "gemini-live-test",
      status: "failed",
      monitor: {
        deploy_sha: "old-release-sha",
        live_monitor_consecutive_failures: 2,
        model: "gemini-live-test",
      },
    })}\n`,
  );

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_EVIDENCE_PATH: evidencePath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
        GEMINI_MODEL: "gemini-live-test",
        GITHUB_SHA: "new-release-sha",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) {
          return jsonResponse(503, brainHealth({ liveRuntime: false, selectable: false }));
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.deploy_sha, "new-release-sha");
    assert.equal(evidence.monitor.live_monitor_consecutive_failures, 1);
    assert.equal(evidence.monitor.deploy_sha, "new-release-sha");
    assert.equal(evidence.monitor.model, "gemini-live-test");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLiveProviderSmoke does not pass on provider-failure partial recap", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "viva-live-smoke-"));
  const audioPath = path.join(tempDir, "answer.pcm");
  await writeFile(audioPath, Buffer.from([1, 2, 3, 4]));
  const socket = new PartialFailureRecapSocket("provider_timeout");

  try {
    const evidence = await runLiveProviderSmoke({
      env: {
        VIVA_LIVE_PROVIDER_SMOKE: "1",
        VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health/brain")) {
          return jsonResponse(200, brainHealth());
        }
        if (String(url).endsWith("/ready")) {
          return jsonResponse(200, readyBody());
        }
        if (String(url).endsWith("/study-sets/paste")) {
          return jsonResponse(201, {
            study_set: {
              id: "server-study-set",
              user_id: "user-1",
              ingestion_status: "ready",
            },
            session_id: "server-session",
            session_token: "viva1.server-token-secret",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
          socket.message(readyFrame());
        });
        return socket;
      },
      now: () => new Date("2026-06-18T00:00:00.000Z"),
    });

    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure_stage, "websocket");
    assert.equal(evidence.websocket.terminal_reason, "provider_timeout");
    assert.equal(evidence.failure.failure_class, "timeout");
    assert.equal(evidence.failure.terminal_reason, "provider_timeout");
    assert.equal(evidence.websocket.event_counts.recap, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function readyBody({
  maxSessionCostUsd = 0.25,
  ready = true,
  selectable = true,
  liveRuntime = true,
  nonceReplayProtection = true,
} = {}) {
  return {
    ready,
    brain: {
      provider: "cartesia_gemini",
      configured: true,
      selectable,
      live_runtime: liveRuntime,
    },
    voice_limits: {
      max_session_cost_usd: maxSessionCostUsd,
    },
    store: {
      backend: "postgres",
      available: true,
      durable: true,
      nonce_replay_protection: nonceReplayProtection,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    },
  };
}

function brainHealth({
  maxSessionCostUsd = 0.25,
  totalTokens = 1000,
  usageEvents = 7,
  selectable = true,
  liveRuntime = true,
  nonceReplayProtection = true,
} = {}) {
  return {
    provider: "cartesia_gemini",
    status: selectable ? "configured" : "unavailable",
    brain: {
      provider: "cartesia_gemini",
      configured: true,
      selectable,
      live_runtime: liveRuntime,
    },
    voice_limits: {
      max_session_cost_usd: maxSessionCostUsd,
    },
    store: {
      backend: "postgres",
      available: true,
      durable: true,
      nonce_replay_protection: nonceReplayProtection,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    },
    usage: {
      events: usageEvents,
      total_tokens: totalTokens,
    },
  };
}

function accessDeniedReadinessBody() {
  return {
    access: {
      reason: "missing_live_smoke_bearer",
      status: "denied",
    },
    error: "access_denied",
    failure_kind: "access_denied",
    readiness_status: "access_denied",
  };
}

// RELEASE-028: the fake server now speaks the real v5 wire contract. These
// fixtures used to be `version: 4` and structurally partial -- the published
// validator refuses them, which is the whole point: a frame the real server
// could not have sent must never reach the smoke's counters or evidence.
function readyFrame() {
  return {
    type: "ready",
    version: FIXTURE_PROTOCOL_VERSION,
    protocol: { preferred_version: 5, supported_versions: [5] },
    sample_rate_hz: 24000,
    input_encoding: "pcm_s16le",
    brain: {
      provider: "cartesia_gemini",
      configured: true,
      selectable: true,
      live_runtime: true,
    },
    store: {
      backend: "postgres",
      available: true,
      durable: true,
      nonce_replay_protection: true,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    },
  };
}

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = 0;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((entry) => entry !== listener),
    );
  }

  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        this.message(
          eventFrame("transcript_final", {
            response_id: "response-1",
            text: "raw answer text",
          }),
        );
        this.message(
          eventFrame("answer_evaluated", {
            response_id: "response-1",
            evaluation: {
              concise_feedback: "raw feedback",
            },
          }),
        );
        this.message(
          eventFrame("source_reference", {
            response_id: "response-1",
            source: {
              source_id: "source-1",
              excerpt: "raw source excerpt",
            },
          }),
        );
        this.message(
          eventFrame("audio_delta", {
            response_id: "response-1",
            frame: {
              pcm16_base64: "AQIDBA==",
            },
          }),
        );
        this.message(
          eventFrame("recap_ready", {
            response_id: "response-1",
            recap: {
              next_action: "raw recap",
            },
          }),
        );
      });
    }
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: true });
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  rawMessage(data) {
    this.emit("message", { data });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class MalformedStreamSocket extends FakeSocket {
  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        // A real v5 protocol error frame: typed code, derived retryability,
        // and the raw provider text confined to `error.message` where the
        // smoke must still refuse to retain it.
        this.message({
          type: "error",
          version: FIXTURE_PROTOCOL_VERSION,
          error: {
            code: "VOICE_INTERNAL_SERIALIZATION",
            message: "provider raw payload with prompt text must not be retained",
            retryable: true,
          },
        });
        this.close(1011, "provider stream failed");
      });
    }
  }
}

class InvalidJsonSocket extends FakeSocket {
  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        this.rawMessage('{"type":"event","version":4,"event":');
        this.close(1011, "provider stream failed");
      });
    }
  }
}

class TerminalReasonSocket extends FakeSocket {
  constructor(terminalReason) {
    super();
    this.terminalReason = terminalReason;
  }

  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        this.message(
          eventFrame("session_phase", {
            phase: "recap",
            terminal_reason: this.terminalReason,
          }),
        );
        this.close(1008, this.terminalReason);
      });
    }
  }
}

class PartialFailureRecapSocket extends FakeSocket {
  constructor(terminalReason) {
    super();
    this.terminalReason = terminalReason;
  }

  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        this.message(
          eventFrame("recap_ready", {
            response_id: "response-1",
            partial_reason: this.terminalReason,
            recap: {
              next_action: "raw partial recap",
            },
          }),
        );
        this.message(
          eventFrame("recap_ready", {
            response_id: "response-late-normal-recap",
            recap: {
              next_action: "raw late normal recap",
            },
          }),
        );
        this.message(
          eventFrame("session_phase", {
            phase: "recap",
            terminal_reason: this.terminalReason,
          }),
        );
        this.close(1011, this.terminalReason);
      });
    }
  }
}

class UnknownFrameTypeSocket extends FakeSocket {
  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        this.message({ type: "totally_unrecognized_frame_type", version: 4 });
      });
    }
  }
}

class TransportErrorSocket extends FakeSocket {
  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        this.emit("error", {});
      });
    }
  }
}

class UnexpectedCloseSocket extends FakeSocket {
  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        this.close(1006, "abnormal closure");
      });
    }
  }
}

class StructuredErrorSourceSocket extends FakeSocket {
  constructor(source) {
    super();
    this.source = source;
  }

  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "session_config") {
        queueMicrotask(() => {
          this.message(eventFrame("session_phase", { phase: "listening" }));
          this.message(eventFrame("question_started", { response_id: "response-1", question: {} }));
        });
      }
    } else if (Buffer.isBuffer(data)) {
      queueMicrotask(() => {
        this.message(
          eventFrame("structured_error", {
            source: this.source,
            message: "sanitized structured error",
          }),
        );
        this.close(1011, "structured error");
      });
    }
  }
}

const FIXTURE_PROTOCOL_VERSION = 5;

const FIXTURE_SOURCE = Object.freeze({
  source_id: "src-lecture-5-slide-18",
  document_id: "lec-5",
  span: "slide:18",
  excerpt: "NADH donates high-energy electrons to the electron transport chain.",
  confidence: "high",
  retrieval_reason: "server fixture source",
});

const FIXTURE_QUESTION = Object.freeze({
  question_id: "q-oxidative-phosphorylation-nadh",
  concept_id: "oxidative-phosphorylation",
  prompt: "Explain the role of NADH in oxidative phosphorylation.",
  expected_terms: ["electron transport chain"],
  follow_up: "Now connect that electron flow to ATP synthase.",
  rubric: {
    policy_version: "viva.semantic-rubric.v1",
    criteria: [
      {
        criterion_id: "crit-oxphos-donor",
        concept_id: "oxidative-phosphorylation",
        claim: "NADH donates high-energy electrons to the electron transport chain.",
        source_id: "src-lecture-5-slide-18",
        required: true,
      },
    ],
  },
  source: FIXTURE_SOURCE,
});

const FIXTURE_RECAP = Object.freeze({
  schema: "viva.study_session_recap.v2",
  voice_session_id: "voice-session-1",
  headline: "Strong concepts: 1 of 1.",
  summary: "Graded concepts: 1. Evaluated turns: 1. Deferred turns: 0.",
  concepts: [
    {
      concept_id: "oxidative-phosphorylation",
      label: "Oxidative phosphorylation",
      status: "strong",
    },
  ],
  review_schedule: [
    {
      concept_id: "oxidative-phosphorylation",
      due_at: "1970-01-01T00:00:00.000Z",
      authority: "server_persisted_fsrs",
    },
  ],
  next_action: "Review the scheduled concepts on their due dates.",
  source_moments: [{ response_id: "response-1", source_id: "src-lecture-5-slide-18" }],
  deferred_turns: 0,
});

/** The valid v5 body for each event kind a fixture builds on top of. */
const FIXTURE_EVENT_BODIES = Object.freeze({
  session_phase: () => ({ phase: "listening" }),
  question_started: () => ({
    turn_id: "turn-1",
    response_id: "response-1",
    question: structuredClone(FIXTURE_QUESTION),
  }),
  transcript_delta: () => ({ response_id: "response-1", text: "an answer" }),
  transcript_final: () => ({ response_id: "response-1", text: "an answer", confidence: null }),
  answer_evaluated: () => ({
    response_id: "response-1",
    evaluation: {
      question_id: "q-oxidative-phosphorylation-nadh",
      answer_text: "an answer",
      label: "strong",
      concise_feedback: "The chain description held.",
      retry_prompt: "Say precisely where the pumped protons accumulate.",
      source: structuredClone(FIXTURE_SOURCE),
      concept_status: "strong",
      confidence_score: 0.86,
    },
  }),
  source_reference: () => ({ response_id: "response-1", source: structuredClone(FIXTURE_SOURCE) }),
  concept_status: () => ({
    response_id: "response-1",
    concept_id: "oxidative-phosphorylation",
    status: "strong",
  }),
  manuscript_intent: () => ({
    response_id: "response-1",
    intent: { type: "scene_intent", register: "examining", emphasis: "measured" },
  }),
  audio_delta: () => ({ response_id: "response-1", frame: { pcm16_base64: "AQIDBA==" } }),
  cancellation: () => ({ response_id: "response-1" }),
  recap_ready: () => ({
    response_id: "response-1",
    recap: structuredClone(FIXTURE_RECAP),
    partial: false,
  }),
  structured_error: () => ({
    source: "gemini",
    code: "provider_timeout",
    message: "The provider did not answer in time.",
    terminality: "terminal",
    terminal_reason: "provider_timeout",
  }),
});

/**
 * Build a valid v5 event frame, merging the caller's overrides into the real
 * body for that event kind. A `recap_ready` override that supplies only
 * `partial_reason` still produces a complete, contract-valid recap.
 */
function eventFrame(type, event = {}) {
  const base = FIXTURE_EVENT_BODIES[type]?.() ?? {};
  const body = mergeFixture(base, event);
  if (type === "recap_ready" && typeof body.partial_reason === "string") {
    body.partial = true;
  }
  return {
    type: "event",
    version: FIXTURE_PROTOCOL_VERSION,
    event: { type, ...body },
  };
}

function mergeFixture(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = mergeFixture(merged[key], value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

// RELEASE-028: every decoded frame is validated by the published strict
// validator *before* the smoke branches on type, event, terminality, failure
// class, or evidence fields.
test("the smoke summarizes only frames the published validator accepts", () => {
  const ready = summarizeServerFrame({
    type: "ready",
    version: 5,
    protocol: { preferred_version: 5, supported_versions: [5] },
    sample_rate_hz: 24_000,
    input_encoding: "pcm_s16le",
    brain: { provider: "synthetic", configured: true, selectable: true, live_runtime: false },
    store: {
      backend: "in_memory",
      available: true,
      durable: false,
      nonce_replay_protection: true,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    },
  });
  assert.equal(ready.kind, "ready");
  assert.equal(ready.protocol_version, 5);
  assert.equal(ready.sample_rate_hz, 24_000);
});

test("a frame carrying an unknown nested field is invalid, and its hostile value never enters the summary", () => {
  const summary = summarizeServerFrame({
    type: "event",
    version: 5,
    event: {
      type: "session_phase",
      phase: "recap",
      terminal_reason: "provider_timeout",
      viva_hostile_unknown_key: "viva-hostile-sentinel-value-9f2a",
    },
  });

  assert.equal(summary.kind, "invalid");
  assert.equal(summary.event_code, "voice_server_frame_invalid");
  assert.equal(JSON.stringify(summary).includes("viva-hostile-sentinel-value-9f2a"), false);
  assert.equal(JSON.stringify(summary).includes("provider_timeout"), false);
});

test("a wrong protocol version is rejected before any terminal reason is believed", () => {
  const summary = summarizeServerFrame({
    type: "event",
    version: 4,
    event: { type: "session_phase", phase: "recap", terminal_reason: "provider_timeout" },
  });

  assert.equal(summary.kind, "invalid");
  assert.equal(summary.event_code, "voice_server_frame_invalid");
});

test("a valid structured server error stays distinct from a malformed protocol frame", () => {
  const structured = summarizeServerFrame({
    type: "event",
    version: 5,
    event: {
      type: "structured_error",
      source: "gemini",
      code: "provider_timeout",
      message: "The provider did not answer in time.",
      terminality: "terminal",
      terminal_reason: "provider_timeout",
    },
  });
  assert.equal(structured.kind, "event");
  assert.equal(structured.event_code, "structured_error");
  assert.equal(structured.source, "gemini");

  const malformed = summarizeServerFrame({ type: "error", version: 5, error: { code: "nope" } });
  assert.equal(malformed.kind, "invalid");
  assert.notEqual(malformed.event_code, "structured_error");
});

test("the smoke's own client frames take their version from the validated ready frame, never a local literal", () => {
  const frame = smokeSessionConfigFrame({
    session: { sessionId: "s-1", studySetId: "set-1", userId: "u-1", signedSession: "viva1.token" },
    clientGenerationId: "smoke-generation-1",
    protocolVersion: 5,
  });

  assert.deepEqual(Object.keys(frame).sort(), [
    "client_generation_id",
    "session",
    "session_token",
    "type",
    "version",
  ]);
  assert.equal(frame.version, 5);
  assert.equal(frame.client_generation_id, "smoke-generation-1");
  // The v5 session object carries no `initial_goal`: the server's
  // deny-unknown-fields decoder refuses the whole frame if it does.
  assert.equal("initial_goal" in frame.session, false);

  const stop = smokeStopFrame({ clientGenerationId: "smoke-generation-1", protocolVersion: 5 });
  assert.deepEqual(stop, {
    type: "stop",
    version: 5,
    client_generation_id: "smoke-generation-1",
  });

  assert.throws(
    () => smokeSessionConfigFrame({ session: { sessionId: "s" }, clientGenerationId: "g" }),
    /protocol version/i,
  );
});

test("the smoke's client session_config matches the committed v5 wire fixture's exact member set", async () => {
  const fixture = JSON.parse(
    await readFile("agent/fixtures/voice-protocol/v5/client-session-config-signed.json", "utf8"),
  );
  const frame = smokeSessionConfigFrame({
    session: { sessionId: "s-1", studySetId: "set-1", userId: "u-1", signedSession: "viva1.token" },
    clientGenerationId: "smoke-generation-1",
    protocolVersion: fixture.version,
  });

  assert.deepEqual(Object.keys(frame).sort(), Object.keys(fixture).sort());
  assert.deepEqual(Object.keys(frame.session).sort(), Object.keys(fixture.session).sort());
});
