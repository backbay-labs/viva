import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditLiveSmokeEvidence,
  buildLiveSmokeConfig,
  runLiveProviderSmoke,
  summarizeServerFrame,
} from "./live-provider-smoke.mjs";

const LIVE_PROVIDER_SMOKE_PATH = "scripts/live-provider-smoke.mjs";
const AGENT_CONTRACT_PATH = "packages/core/src/agent-contract.ts";

test("live provider smoke is skipped unless explicitly enabled", () => {
  const config = buildLiveSmokeConfig({ env: {} });

  assert.equal(config.enabled, false);
  assert.equal(config.provider, "cartesia_gemini");
  assert.match(config.outputPath, /artifacts[/\\]live-provider-smoke[/\\]evidence\.json$/);
});

test("enabled live provider smoke requires explicit caps and audio input", () => {
  assert.throws(
    () =>
      buildLiveSmokeConfig({
        env: {
          VIVA_LIVE_PROVIDER_SMOKE: "1",
          CARTESIA_API_KEY: "cartesia-secret",
          GEMINI_API_KEY: "gemini-secret",
        },
      }),
    /zero-data-retention confirmation/,
  );

  assert.throws(
    () =>
      buildLiveSmokeConfig({
        env: {
          VIVA_LIVE_PROVIDER_SMOKE: "1",
          CARTESIA_API_KEY: "cartesia-secret",
          GEMINI_API_KEY: "gemini-secret",
          CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
          GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
        },
      }),
    /missing live smoke cap/,
  );

  assert.throws(
    () =>
      buildLiveSmokeConfig({
        env: {
          VIVA_LIVE_PROVIDER_SMOKE: "1",
          CARTESIA_API_KEY: "cartesia-secret",
          GEMINI_API_KEY: "gemini-secret",
          CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
          GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
          VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
          VIVA_LIVE_SMOKE_MAX_TURNS: "1",
          VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
          VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        },
      }),
    /missing live smoke audio input/,
  );
});

test("live provider smoke uses the shared voice protocol version", async () => {
  const [smokeSource, contractSource] = await Promise.all([
    readFile(LIVE_PROVIDER_SMOKE_PATH, "utf8"),
    readFile(AGENT_CONTRACT_PATH, "utf8"),
  ]);
  const smokeVersion = numericConstant(smokeSource, "PROTOCOL_VERSION");
  const contractVersion = numericConstant(contractSource, "VIVA_VOICE_PROTOCOL_VERSION");

  assert.equal(smokeVersion, contractVersion);
});

test("server frames summarize to safe counters without raw protocol payload", () => {
  const frames = [
    {
      type: "ready",
      version: 4,
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
    },
    {
      type: "event",
      version: 4,
      event: {
        type: "transcript_final",
        response_id: "response-1",
        text: "raw speech text must not be retained",
        confidence: 0.97,
      },
    },
    {
      type: "event",
      version: 4,
      event: {
        type: "answer_evaluated",
        response_id: "response-1",
        evaluation: {
          conciseFeedback: "answer feedback must not be retained",
        },
      },
    },
    {
      type: "event",
      version: 4,
      event: {
        type: "source_reference",
        response_id: "response-1",
        source: {
          source_id: "source-1",
          excerpt: "source excerpt must not be retained",
        },
      },
    },
    {
      type: "event",
      version: 4,
      event: {
        type: "audio_delta",
        response_id: "response-1",
        frame: {
          pcm16_base64: "AQIDBA==",
        },
      },
    },
    {
      type: "event",
      version: 4,
      event: {
        type: "recap_ready",
        response_id: "response-1",
        recap: {
          nextAction: "raw recap must not be retained",
        },
      },
    },
  ];

  const summaries = frames.map(summarizeServerFrame);
  assert.equal(summaries[0].kind, "ready");
  assert.equal(summaries[1].event_code, "final_transcript");
  assert.equal(summaries[2].event_code, "answer_eval");
  assert.equal(summaries[3].event_code, "source_ref");
  assert.equal(summaries[4].event_code, "audio_chunk");
  assert.equal(summaries[5].event_code, "recap");

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
        CARTESIA_API_KEY: "cartesia-secret-value",
        GEMINI_API_KEY: "gemini-secret-value",
        CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
        GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
        VIVA_VOICE_WS_BEARER_TOKEN: "bearer-secret-value",
        VIVA_LIVE_SMOKE_AUDIO_FILE: audioPath,
        VIVA_LIVE_SMOKE_MAX_DURATION_MS: "60000",
        VIVA_LIVE_SMOKE_MAX_TURNS: "1",
        VIVA_VOICE_WS_MAX_SESSION_COST_USD: "0.25",
        VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES: "4096",
        VIVA_LIVE_SMOKE_AGENT_HTTP_URL: "https://agent.viva.test",
        VIVA_LIVE_SMOKE_ORIGIN: "https://app.viva.test",
      },
      fetchImpl: async (url, init = {}) => {
        fetchCalls.push({ url: String(url), init });
        if (String(url).endsWith("/health/brain")) {
          return jsonResponse(200, brainHealth({ usageEvents: fetchCalls.length > 2 ? 8 : 7 }));
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

test("runLiveProviderSmoke fails closed when the live provider is not selectable", async () => {
  let socketOpened = false;

  const evidence = await runLiveProviderSmoke({
    env: {
      VIVA_LIVE_PROVIDER_SMOKE: "1",
      CARTESIA_API_KEY: "cartesia-secret-value",
      GEMINI_API_KEY: "gemini-secret-value",
      CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
      GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
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
  assert.equal(evidence.failure.failure_class, "provider_auth_failure");
  assert.equal(evidence.failure.terminal_reason, "provider_auth_failed");
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
      CARTESIA_API_KEY: "cartesia-secret-value",
      GEMINI_API_KEY: "gemini-secret-value",
      CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
      GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
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
      CARTESIA_API_KEY: "cartesia-secret-value",
      GEMINI_API_KEY: "gemini-secret-value",
      CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
      GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
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
        CARTESIA_API_KEY: "cartesia-secret-value",
        GEMINI_API_KEY: "gemini-secret-value",
        CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
        GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
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
        CARTESIA_API_KEY: "cartesia-secret-value",
        GEMINI_API_KEY: "gemini-secret-value",
        CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
        GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
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
    assert.equal(evidence.websocket.event_counts.structured_error, 1);
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
        CARTESIA_API_KEY: "cartesia-secret-value",
        GEMINI_API_KEY: "gemini-secret-value",
        CARTESIA_ZERO_DATA_RETENTION_ENABLED: "1",
        GEMINI_ZERO_DATA_RETENTION_APPROVED: "1",
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
    assert.equal(evidence.websocket.terminal_reason, "rate_limit");
    assert.equal(evidence.failure.failure_class, "quota_rate_failure");
    assert.equal(evidence.failure.terminal_reason, "provider_rate_limited");
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

function readyFrame() {
  return {
    type: "ready",
    version: 4,
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
              conciseFeedback: "raw feedback",
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
              nextAction: "raw recap",
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
        this.message({
          type: "error",
          version: 4,
          message: "provider raw payload with prompt text must not be retained",
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

function eventFrame(type, event) {
  return {
    type: "event",
    version: 4,
    event: {
      type,
      ...event,
    },
  };
}

function numericConstant(source, name) {
  const match = source.match(new RegExp(`const ${name} = (\\d+)`));
  assert(match, `missing numeric constant ${name}`);
  return Number(match[1]);
}
