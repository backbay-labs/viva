#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  failureMatrixEvidence,
  LIVE_PROVIDER_FAILURE_MATRIX,
  liveProviderFailureForSmokeReason,
} from "./live-provider-failure-matrix.mjs";
import { assertNoForbiddenEvidenceMarkers } from "./redaction-control.mjs";
import {
  isReleaseVoiceTerminalReason,
  validatedVoiceFrameForRelease,
} from "./release-contract-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_PROVIDER = "cartesia_gemini";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_AGENT_HTTP_URL = "http://127.0.0.1:4318";
const DEFAULT_BOOTSTRAP_TEXT =
  "Live smoke study note: ATP synthase uses a proton gradient to produce ATP. State the mechanism in one concise sentence.";
const REQUIRED_EVENT_KEYS = Object.freeze([
  "question",
  "final_transcript",
  "answer_eval",
  "source_ref",
  "audio_chunk",
  "recap",
]);
const SAFE_EVENT_CODES = Object.freeze({
  session_phase: "session_phase",
  question_started: "question",
  transcript_delta: "transcript_delta",
  transcript_final: "final_transcript",
  answer_evaluated: "answer_eval",
  source_reference: "source_ref",
  concept_status: "concept_status",
  manuscript_intent: "manuscript_intent",
  recap_ready: "recap",
  audio_delta: "audio_chunk",
  cancellation: "cancellation",
  structured_error: "structured_error",
});
// BAC-527: a genuine server structured_error event may name its own reason
// via `source`; only retain it verbatim when it is one of the server's
// allow-listed failure reasons, never an arbitrary provider-controlled
// string.
const RECOGNIZED_STRUCTURED_ERROR_SOURCES = new Set(
  LIVE_PROVIDER_FAILURE_MATRIX.flatMap((entry) => entry.smoke_terminal_reasons ?? []),
);

/**
 * BAC-527: one monotonic deadline shared by every live-smoke stage —
 * readiness, bootstrap, socket open, ready, question, and recap — so a slow
 * earlier stage correspondingly shrinks the time budget left for the ones
 * after it, instead of each stage getting a fresh full cap.
 */
export function createDeadline({ nowMs, durationMs }) {
  const deadlineAt = nowMs + durationMs;
  return {
    deadlineAt,
    remainingMs(currentNowMs) {
      const remaining = deadlineAt - currentNowMs;
      if (remaining <= 0) {
        throw new Error("live smoke deadline exceeded");
      }
      return remaining;
    },
  };
}

/**
 * BAC-527: the sanitized evidence written when the runner's supervisory
 * SIGTERM interrupts an in-flight run. Deliberately minimal — counters,
 * stage, run/deploy binding, signal name, and timestamps only; never the
 * current frame, audio bytes, transcript, answer, prompt, or session token.
 */
export function interruptedEvidence(state, signal) {
  return {
    schema: "viva.live_provider_smoke.v1",
    generated_at: new Date().toISOString(),
    deploy_sha: state?.deploySha ?? "unknown",
    model: state?.model ?? DEFAULT_GEMINI_MODEL,
    provider: LIVE_PROVIDER,
    run_id: state?.runId ?? null,
    agent_deploy_id: state?.agentDeployId ?? null,
    status: "failed",
    partial: true,
    failure_stage: state?.stage ?? "unknown",
    failure_class: "timeout",
    terminal_reason: "killed_by_runner",
    signal,
    event_counts: state?.eventCounts ?? null,
    privacy: privacyEvidence(),
  };
}

export function buildLiveSmokeConfig({ env = process.env, rootDir = root } = {}) {
  const artifactDir = liveSmokeArtifactDir(env, rootDir);
  const deploySha = deploymentSha(env);
  const outputPath = liveSmokeOutputPath(env, rootDir);
  const enabled = liveSmokeEnabled(env);
  const model = liveSmokeModel(env);
  const provider = LIVE_PROVIDER;
  const runId = env.VIVA_LIVE_SMOKE_RUN_ID?.trim() || null;
  // RELEASE-003/007/008: the release's own agent deploy identity, distinct
  // from deploy_sha (a git commit) and run_id (this smoke's own run). Set
  // explicitly rather than inferred, so it can be bound and verified
  // against VIVA_RELEASE_AGENT_DEPLOY_ID by the production gate.
  const agentDeployId = env.VIVA_LIVE_SMOKE_AGENT_DEPLOY_ID?.trim() || null;
  if (!enabled) {
    return {
      agentDeployId,
      artifactDir,
      deploySha,
      enabled,
      model,
      outputPath,
      provider,
      runId,
    };
  }

  if (env.VIVA_AGENT_PROVIDER && env.VIVA_AGENT_PROVIDER !== provider) {
    throw new Error("live smoke provider mismatch");
  }
  // RELEASE-016/021: the smoke never holds or consumes raw Cartesia/Gemini
  // keys -- the agent deployment is the only component that does. The
  // caller instead attests, with one explicit flag, that those keys and
  // their zero-data-retention approvals are already configured there.
  if (env.VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED !== "1") {
    throw new Error("live provider secrets confirmation is required when smoke is enabled");
  }

  const caps = {
    max_duration_ms: requiredPositiveInteger(env, "VIVA_LIVE_SMOKE_MAX_DURATION_MS"),
    max_turns: requiredPositiveInteger(env, "VIVA_LIVE_SMOKE_MAX_TURNS"),
    max_session_cost_usd: requiredPositiveNumber(env, "VIVA_VOICE_WS_MAX_SESSION_COST_USD"),
    max_audio_bytes: requiredPositiveInteger(env, "VIVA_LIVE_SMOKE_MAX_AUDIO_BYTES"),
    max_tokens: optionalPositiveInteger(env, "VIVA_LIVE_SMOKE_MAX_TOKENS"),
  };
  const audioFile = requiredValue(
    env,
    "VIVA_LIVE_SMOKE_AUDIO_FILE",
    "missing live smoke audio input",
  );
  const httpBaseUrl = trimTrailingSlash(
    env.VIVA_LIVE_SMOKE_AGENT_HTTP_URL ??
      env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL ??
      httpUrlFromWs(env.VIVA_LIVE_SMOKE_AGENT_WS_URL ?? env.NEXT_PUBLIC_VIVA_AGENT_WS_URL) ??
      DEFAULT_AGENT_HTTP_URL,
  );
  const wsUrl =
    env.VIVA_LIVE_SMOKE_AGENT_WS_URL ??
    env.NEXT_PUBLIC_VIVA_AGENT_WS_URL ??
    wsUrlFromHttp(httpBaseUrl);

  return {
    agentDeployId,
    artifactDir,
    audioFile,
    bearerToken: env.VIVA_VOICE_WS_BEARER_TOKEN?.trim() || null,
    bootstrapText: env.VIVA_LIVE_SMOKE_BOOTSTRAP_TEXT || DEFAULT_BOOTSTRAP_TEXT,
    caps,
    deploySha,
    enabled,
    expectedRemoteMaxSessionCostUsd: optionalPositiveNumber(
      env,
      "VIVA_LIVE_SMOKE_EXPECTED_REMOTE_MAX_SESSION_COST_USD",
    ),
    httpBaseUrl,
    liveMonitorConsecutiveFailures: optionalNonNegativeInteger(
      env.VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES,
    ),
    model,
    origin: env.VIVA_LIVE_SMOKE_ORIGIN?.trim() || null,
    outputPath,
    provider,
    runId,
    suppliedSession: suppliedSessionFromEnv(env),
    wsUrl,
  };
}

export async function runLiveProviderSmoke({
  createWebSocket = createDefaultWebSocket,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
  readFileImpl = readFile,
  interruptState = null,
} = {}) {
  const config = buildLiveSmokeConfig({ env });
  if (!config.enabled) {
    const evidence = skippedEvidence(config, now);
    auditLiveSmokeEvidence(evidence, env);
    return evidence;
  }

  const monitorConfig = {
    ...config,
    liveMonitorConsecutiveFailures: await previousLiveMonitorConsecutiveFailures(
      config,
      readFileImpl,
    ),
  };
  const base = baseEvidence(config, now);
  const finish = (terminalReason, stage, extra = {}) => {
    const evidence = failedEvidence(base, monitorConfig, terminalReason, stage, extra);
    auditLiveSmokeEvidence(evidence, env);
    return evidence;
  };

  // BAC-527: readiness, bootstrap, socket open, ready, question, and recap
  // all share this one deadline — each stage receives only whatever time is
  // left, never a fresh full cap of its own.
  const deadline = createDeadline({
    nowMs: now().getTime(),
    durationMs: config.caps.max_duration_ms,
  });
  if (interruptState) {
    interruptState.deploySha = config.deploySha;
    interruptState.model = config.model;
    interruptState.runId = config.runId;
    interruptState.agentDeployId = config.agentDeployId;
    interruptState.stage = "readiness";
  }

  let readiness;
  try {
    readiness = await collectReadiness(config, fetchImpl, deadline.remainingMs(now().getTime()));
  } catch {
    return finish("readiness_unavailable", "readiness", { readiness: readinessUnavailable() });
  }

  if (!readinessPasses(readiness)) {
    return finish(readinessFailureSmokeReason(readiness), "readiness", { readiness });
  }
  if (!remoteCostCapPasses(readiness, config)) {
    return finish("cost_budget", "readiness", { readiness });
  }

  let audioBytes;
  try {
    audioBytes = await readFileImpl(config.audioFile);
    if (audioBytes.length === 0 || audioBytes.length > config.caps.max_audio_bytes) {
      throw new Error("audio size outside configured cap");
    }
  } catch {
    return finish("audio_input_unavailable", "audio_input", { readiness });
  }

  if (interruptState) interruptState.stage = "bootstrap";
  let bootstrap;
  try {
    bootstrap = await bootstrapSession(config, fetchImpl, deadline.remainingMs(now().getTime()));
  } catch {
    return finish("bootstrap_failed", "bootstrap", { readiness });
  }

  const websocket = await collectWebSocketProof({
    audioBytes,
    bootstrap,
    config,
    createWebSocket,
    deadline,
    interruptState,
    now,
  });
  const usageAfter = await collectUsageSnapshot(config, fetchImpl).catch(() => null);
  const requiredEvents = requiredEventSummary(websocket.event_counts);
  const websocketStatus =
    websocket.opened &&
    websocket.ready_frame_observed &&
    Object.values(requiredEvents).every(Boolean) &&
    websocket.event_counts.structured_error === 0 &&
    websocket.event_counts.transport_error === 0 &&
    websocket.event_counts.protocol_error === 0 &&
    websocket.terminal_reason === "recap_observed"
      ? "passed"
      : "failed";
  const usage = usageEvidence(readiness.usage, usageAfter, config);
  const tokenBudgetExceeded =
    websocketStatus === "passed" && tokenUsageCapFailure(readiness.usage, usageAfter, config);
  const status = tokenBudgetExceeded ? "failed" : websocketStatus;
  const terminalReason = tokenBudgetExceeded
    ? "cost_budget"
    : (websocket.terminal_reason ?? "websocket_failed");
  const websocketEvidence = {
    readiness,
    bootstrap: {
      server_study_created: bootstrap.serverStudyCreated,
      signed_session_attached: bootstrap.signedSessionAttached,
    },
    websocket: {
      ...websocket,
      required_events: requiredEvents,
    },
    usage,
  };
  if (status === "failed") {
    return finish(terminalReason, tokenBudgetExceeded ? "usage" : "websocket", websocketEvidence);
  }
  const evidence = {
    ...base,
    status,
    ...websocketEvidence,
    monitor: liveMonitorEvidence({
      agentDeployId: config.agentDeployId,
      consecutiveFailures: monitorConfig.liveMonitorConsecutiveFailures,
      deploySha: config.deploySha,
      model: config.model,
      runId: config.runId,
      status,
      terminalReason,
    }),
  };
  auditLiveSmokeEvidence(evidence, env);
  return evidence;
}

/**
 * BAC-527: every failure branch returns the same complete top-level shape —
 * `failure`, `failure_class`, `monitor`, `terminal_reason`, and
 * `failure_stage` — so a remote-cost-cap rejection is exactly as
 * classifiable as any other live-smoke failure.
 */
function failedEvidence(base, monitorConfig, terminalReason, stage, extra = {}) {
  const failure = liveProviderFailureForSmokeReason(terminalReason);
  return {
    ...base,
    ...extra,
    status: "failed",
    failure_stage: stage,
    failure,
    failure_class: failure.failure_class,
    monitor: failedMonitorEvidence(monitorConfig, terminalReason),
    terminal_reason: terminalReason,
  };
}

/**
 * RELEASE-028: validate before believing anything.
 *
 * This function used to branch on `frame.type`, `frame.event.type`,
 * `frame.event.phase`, `frame.event.terminal_reason`, `partial_reason` and
 * `source` on a bare `JSON.parse` result — so a payload that merely *looked*
 * like a frame could set a terminal reason and reach the evidence file. Every
 * frame now goes through the published strict validator first; only its
 * reconstructed, frozen value is read, and an invalid frame yields the single
 * stable sanitized code with none of the offending content.
 */
export function summarizeServerFrame(frame) {
  let validated;
  try {
    validated = validatedVoiceFrameForRelease(frame);
  } catch (error) {
    return {
      kind: "invalid",
      event_code: error?.code ?? "voice_server_frame_invalid",
    };
  }
  if (validated.type === "ready") {
    return {
      kind: "ready",
      brain: summarizeBrain(validated.brain),
      input_encoding: validated.input_encoding,
      protocol_version: validated.version,
      sample_rate_hz: validated.sample_rate_hz,
      store: summarizeStore(validated.store),
    };
  }
  if (validated.type === "error") {
    return {
      event_code: "structured_error",
      kind: "event",
    };
  }
  if (validated.type === "audio_turn_accepted") {
    // A well-formed acceptance is a real event, not an unrecognized shape:
    // classifying it as "unknown" would have made a correct server frame a
    // protocol failure.
    return {
      event_code: "audio_turn_accepted",
      kind: "event",
    };
  }
  const eventCode = SAFE_EVENT_CODES[validated.event.type] ?? "unknown_event";
  const summary = {
    event_code: eventCode,
    kind: "event",
  };
  if (eventCode === "session_phase") {
    summary.phase = validated.event.phase;
    // The terminal reason is already a member of the published closed
    // vocabulary (the validator enforces it); the membership check is kept as
    // the explicit statement of that dependency.
    if (isReleaseVoiceTerminalReason(validated.event.terminal_reason)) {
      summary.terminal_reason = validated.event.terminal_reason;
    }
  }
  if (eventCode === "recap" && isReleaseVoiceTerminalReason(validated.event.partial_reason)) {
    summary.partial_reason = validated.event.partial_reason;
  }
  if (eventCode === "structured_error") {
    summary.source = safeEnum(validated.event.source);
  }
  return summary;
}

/**
 * RELEASE-028 / A-03: the smoke's own client frames carry the version the
 * *server* just advertised in its validated `ready` frame — never a literal in
 * this file, which is exactly what drifted to `4` while the contract moved to
 * `5` and was only caught by a source-text comparison.
 */
export function smokeSessionConfigFrame({ session, clientGenerationId, protocolVersion }) {
  assertNegotiatedProtocol(protocolVersion, clientGenerationId);
  return {
    type: "session_config",
    version: protocolVersion,
    client_generation_id: clientGenerationId,
    session_token: session.signedSession ?? "",
    session: {
      session_id: session.sessionId,
      user_id: session.userId,
      study_set_id: session.studySetId,
      mode: "quiz",
      source_context: [],
      active_concepts: [],
    },
  };
}

export function smokeStopFrame({ clientGenerationId, protocolVersion }) {
  assertNegotiatedProtocol(protocolVersion, clientGenerationId);
  return {
    type: "stop",
    version: protocolVersion,
    client_generation_id: clientGenerationId,
  };
}

function assertNegotiatedProtocol(protocolVersion, clientGenerationId) {
  if (!Number.isInteger(protocolVersion)) {
    throw new Error(
      "live smoke client frames require the protocol version negotiated from the server's validated ready frame",
    );
  }
  if (typeof clientGenerationId !== "string" || clientGenerationId.length === 0) {
    throw new Error("live smoke client frames require a client generation id");
  }
}

export function auditLiveSmokeEvidence(evidence, env = process.env) {
  assertNoForbiddenEvidenceMarkers(evidence, { context: "live smoke evidence", env });
}

async function collectReadiness(config, fetchImpl, timeoutMs) {
  const health = await fetchJson(
    fetchImpl,
    `${config.httpBaseUrl}/health/brain`,
    { headers: restHeaders(config, false) },
    timeoutMs,
  );
  const ready = await fetchJson(
    fetchImpl,
    `${config.httpBaseUrl}/ready`,
    { headers: restHeaders(config, false) },
    timeoutMs,
  );
  const healthBrain = health.body?.brain ?? {};
  const readyBrain = ready.body?.brain ?? {};
  const healthStore = objectOrNull(health.body?.store);
  const readyStore = objectOrNull(ready.body?.store);
  const healthStoreFields = healthStore ?? {};
  const readyStoreFields = readyStore ?? {};
  return {
    access: summarizeAccess(ready.body?.access ?? health.body?.access),
    failure_kind: stringOrNull(ready.body?.failure_kind ?? health.body?.failure_kind),
    health_http_status: health.http_status,
    ready_http_status: ready.http_status,
    ready: ready.body?.ready === true,
    readiness_status: stringOrNull(ready.body?.readiness_status ?? health.body?.readiness_status),
    brain: {
      provider: healthBrain.provider ?? readyBrain.provider ?? null,
      configured: healthBrain.configured === true && readyBrain.configured === true,
      selectable: healthBrain.selectable === true && readyBrain.selectable === true,
      live_runtime: healthBrain.live_runtime === true || readyBrain.live_runtime === true,
    },
    voice_limits: {
      max_session_cost_usd: numberOrNull(
        ready.body?.voice_limits?.max_session_cost_usd ??
          health.body?.voice_limits?.max_session_cost_usd,
      ),
    },
    store: {
      backend: healthStoreFields.backend ?? readyStoreFields.backend ?? null,
      observed: healthStore !== null || readyStore !== null,
      available: healthStoreFields.available === true && readyStoreFields.available === true,
      durable: healthStoreFields.durable === true && readyStoreFields.durable === true,
      nonce_replay_protection:
        healthStoreFields.nonce_replay_protection === true &&
        readyStoreFields.nonce_replay_protection === true,
    },
    usage: usageSnapshotFromBody(health.body?.usage),
  };
}

async function collectUsageSnapshot(config, fetchImpl) {
  const health = await fetchJson(fetchImpl, `${config.httpBaseUrl}/health/brain`, {
    headers: restHeaders(config, false),
  });
  return usageSnapshotFromBody(health.body?.usage);
}

function readinessPasses(readiness) {
  return (
    readiness.ready === true &&
    readiness.ready_http_status === 200 &&
    readiness.brain.provider === LIVE_PROVIDER &&
    readiness.brain.configured === true &&
    readiness.brain.selectable === true &&
    readiness.brain.live_runtime === true &&
    readiness.store.available === true &&
    readiness.store.durable === true &&
    readiness.store.nonce_replay_protection === true
  );
}

function readinessFailureSmokeReason(readiness) {
  if (readinessIsAccessOrProbeFailure(readiness)) {
    return "readiness_not_live_selectable";
  }
  if (
    readiness.store.available !== true ||
    readiness.store.durable !== true ||
    readiness.store.nonce_replay_protection !== true
  ) {
    return "durability_degraded";
  }
  return "readiness_not_live_selectable";
}

function readinessIsAccessOrProbeFailure(readiness) {
  if (
    readiness.access.status !== "unknown" &&
    readiness.access.status !== "ok" &&
    readiness.access.status !== "allowed"
  ) {
    return true;
  }
  if (readiness.failure_kind === "access_denied") return true;
  if (readiness.readiness_status === "access_denied") return true;
  if (readiness.ready_http_status === 401 || readiness.ready_http_status === 403) return true;
  if (readiness.health_http_status === 401 || readiness.health_http_status === 403) return true;
  return (
    readiness.store.observed !== true &&
    (readiness.ready_http_status !== 200 || readiness.health_http_status !== 200)
  );
}

function remoteCostCapPasses(readiness, config) {
  if (config.expectedRemoteMaxSessionCostUsd == null) return true;
  const reported = readiness.voice_limits?.max_session_cost_usd;
  return (
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported > 0 &&
    reported <= config.expectedRemoteMaxSessionCostUsd
  );
}

async function bootstrapSession(config, fetchImpl, timeoutMs) {
  if (config.suppliedSession) {
    return {
      serverStudyCreated: false,
      session: config.suppliedSession,
      signedSessionAttached: Boolean(config.suppliedSession.signedSession),
    };
  }
  const response = await fetchJson(
    fetchImpl,
    `${config.httpBaseUrl}/study-sets/paste`,
    {
      body: JSON.stringify({
        course: "Live Smoke",
        pasted_text: config.bootstrapText,
        title: "Viva Live Smoke",
      }),
      headers: restHeaders(config, true),
      method: "POST",
    },
    timeoutMs,
  );
  if (response.http_status !== 201) {
    throw new Error("bootstrap request failed");
  }
  const studySetId = response.body?.study_set?.id;
  const userId = response.body?.study_set?.user_id ?? "user-1";
  const sessionId = response.body?.session_id;
  if (!hasValue(studySetId) || !hasValue(sessionId)) {
    throw new Error("bootstrap response missing session identity");
  }
  return {
    serverStudyCreated: true,
    session: {
      sessionId,
      signedSession: hasValue(response.body?.session_token) ? response.body.session_token : null,
      studySetId,
      userId,
    },
    signedSessionAttached: hasValue(response.body?.session_token),
  };
}

async function collectWebSocketProof({
  audioBytes,
  bootstrap,
  config,
  createWebSocket,
  deadline,
  interruptState,
  now,
}) {
  const eventCounts = zeroEventCounts();
  if (interruptState) interruptState.eventCounts = eventCounts;
  const phaseCounts = {};
  const createdSocket = createWebSocket(
    config.wsUrl,
    vivaAgentProtocols(config.bearerToken),
    config.origin ? { origin: config.origin } : {},
  );
  const socket =
    createdSocket && typeof createdSocket.then === "function" ? await createdSocket : createdSocket;
  const cleanup = [];
  const proof = {
    close_clean: null,
    close_code: null,
    event_counts: eventCounts,
    opened: false,
    phase_counts: phaseCounts,
    protocol_version: null,
    ready: null,
    ready_frame_observed: false,
    terminal_reason: null,
    turns_seen: 0,
  };
  const clientGenerationId = `live-smoke-${config.runId ?? "unknown"}-1`;
  const openDeferred = deferred();
  const readyDeferred = deferred();
  const questionDeferred = deferred();
  const recapDeferred = deferred();
  let settled = false;
  const completeWithTerminalFailure = (reason) => {
    proof.terminal_reason = reason;
    readyDeferred.resolve();
    questionDeferred.resolve();
    recapDeferred.resolve();
  };
  const throwIfTerminalFailure = () => {
    if (proof.terminal_reason && proof.terminal_reason !== "recap_observed") {
      throw new Error(proof.terminal_reason);
    }
  };

  cleanup.push(
    onSocket(socket, "open", () => {
      proof.opened = true;
      openDeferred.resolve();
    }),
  );
  cleanup.push(
    onSocket(socket, "message", (event) => {
      let frame;
      try {
        frame = parseSocketMessage(event);
      } catch {
        // Not even parseable JSON: a protocol-shaped failure, distinct from
        // a genuine server-sent structured_error.
        eventCounts.protocol_error += 1;
        completeWithTerminalFailure("invalid_server_frame");
        return;
      }
      const summary = summarizeServerFrame(frame);
      if (summary.kind === "ready") {
        proof.ready_frame_observed = true;
        proof.protocol_version = summary.protocol_version;
        proof.ready = {
          brain: summary.brain,
          input_encoding: summary.input_encoding,
          sample_rate_hz: summary.sample_rate_hz,
          store: summary.store,
        };
        readyDeferred.resolve();
        return;
      }
      if (summary.kind === "invalid" || summary.kind === "unknown") {
        // Valid JSON, but not a frame shape the shared protocol recognizes:
        // also protocol-shaped, not a transport or structured-error signal.
        eventCounts.protocol_error += 1;
        completeWithTerminalFailure("invalid_server_frame");
        return;
      }
      if (summary.kind !== "event") return;
      const code = summary.event_code;
      if (Object.hasOwn(eventCounts, code)) {
        eventCounts[code] += 1;
      } else {
        eventCounts.unknown_event += 1;
      }
      if (code === "session_phase" && summary.phase) {
        phaseCounts[summary.phase] = (phaseCounts[summary.phase] ?? 0) + 1;
        if (summary.terminal_reason) {
          completeWithTerminalFailure(summary.terminal_reason);
        }
      }
      if (code === "question") {
        questionDeferred.resolve();
      }
      if (code === "answer_eval") {
        proof.turns_seen += 1;
        if (proof.turns_seen > config.caps.max_turns) {
          proof.terminal_reason = "turn_cap_exceeded";
          recapDeferred.resolve();
        }
      }
      if (code === "structured_error") {
        // Only a valid, protocol-conformant server error frame reaches
        // here; retain the server's own allowed failure class when it
        // names one, instead of collapsing every structured_error to the
        // same generic label.
        proof.terminal_reason =
          recognizedStructuredErrorReason(summary.source) ?? "server_error_frame";
      }
      if (code === "recap" && summary.partial_reason) {
        if (!proof.terminal_reason || proof.terminal_reason === "recap_observed") {
          proof.terminal_reason = summary.partial_reason;
        }
      } else if (code === "recap" && !proof.terminal_reason) {
        proof.terminal_reason = "recap_observed";
        sendJson(
          socket,
          smokeStopFrame({
            clientGenerationId,
            protocolVersion: proof.protocol_version,
          }),
        );
        recapDeferred.resolve();
      }
    }),
  );
  cleanup.push(
    onSocket(socket, "close", (event) => {
      proof.close_code = integerOrNull(event?.code);
      proof.close_clean =
        event?.wasClean === true ? true : event?.wasClean === false ? false : null;
      if (!settled && proof.terminal_reason !== "recap_observed") {
        if (!proof.terminal_reason) {
          // Only an otherwise-unexplained close is a transport failure; a
          // close that follows an already-known reason (a structured_error
          // event, a terminal session_phase, turn-cap exceeded, ...) must
          // not also count as a separate transport failure.
          eventCounts.transport_error += 1;
          proof.terminal_reason = "socket_closed_before_recap";
        }
        recapDeferred.resolve();
      }
    }),
  );
  cleanup.push(
    onSocket(socket, "error", () => {
      eventCounts.transport_error += 1;
      proof.terminal_reason = "socket_error";
      recapDeferred.resolve();
    }),
  );

  try {
    if (interruptState) interruptState.stage = "websocket_open";
    await withTimeout(
      openDeferred.promise,
      deadline.remainingMs(now().getTime()),
      "socket_open_timeout",
    );
    throwIfTerminalFailure();
    if (interruptState) interruptState.stage = "websocket_ready";
    await withTimeout(
      readyDeferred.promise,
      deadline.remainingMs(now().getTime()),
      "ready_frame_timeout",
    );
    throwIfTerminalFailure();
    sendJson(
      socket,
      smokeSessionConfigFrame({
        session: bootstrap.session,
        clientGenerationId,
        protocolVersion: proof.protocol_version,
      }),
    );
    if (interruptState) interruptState.stage = "websocket_question";
    await withTimeout(
      questionDeferred.promise,
      deadline.remainingMs(now().getTime()),
      "question_event_timeout",
    );
    throwIfTerminalFailure();
    socket.send(Buffer.from(audioBytes));
    if (interruptState) interruptState.stage = "websocket_recap";
    await withTimeout(
      recapDeferred.promise,
      deadline.remainingMs(now().getTime()),
      "recap_timeout",
    );
    throwIfTerminalFailure();
    settled = true;
  } catch (error) {
    proof.terminal_reason = safeEnum(error instanceof Error ? error.message : "websocket_failed");
  } finally {
    if (proof.terminal_reason === "recap_observed" && proof.close_code === null) {
      proof.close_code = 1000;
      proof.close_clean = true;
    }
    for (const remove of cleanup) remove();
    closeSocket(socket);
  }
  return proof;
}

function sendJson(socket, payload) {
  socket.send(JSON.stringify(payload));
}

function zeroEventCounts() {
  return {
    answer_eval: 0,
    audio_chunk: 0,
    cancellation: 0,
    concept_status: 0,
    final_transcript: 0,
    manuscript_intent: 0,
    // BAC-527: transport_error (raw socket open/close/error failures),
    // protocol_error (malformed JSON or an unrecognized frame shape), and
    // structured_error (a valid, server-sent error frame) are distinct
    // counters — a failure must never be attributed to more than one.
    protocol_error: 0,
    question: 0,
    recap: 0,
    session_phase: 0,
    source_ref: 0,
    structured_error: 0,
    transcript_delta: 0,
    transport_error: 0,
    unknown_event: 0,
  };
}

function recognizedStructuredErrorReason(source) {
  return typeof source === "string" && RECOGNIZED_STRUCTURED_ERROR_SOURCES.has(source)
    ? source
    : null;
}

function requiredEventSummary(eventCounts) {
  return Object.fromEntries(REQUIRED_EVENT_KEYS.map((key) => [key, eventCounts[key] > 0]));
}

function parseSocketMessage(event) {
  const data = event?.data ?? event;
  if (typeof data === "string") return JSON.parse(data);
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString("utf8"));
  if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8"));
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
  }
  throw new Error("unsupported socket message");
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  if (timeoutMs === undefined) {
    return responseToJson(await fetchImpl(url, init));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return responseToJson(await fetchImpl(url, { ...init, signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function responseToJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    const text = typeof response.text === "function" ? await response.text() : "{}";
    body = text ? JSON.parse(text) : {};
  }
  return {
    body,
    http_status: response.status,
  };
}

function restHeaders(config, includeJson) {
  const headers = {};
  if (includeJson) headers["content-type"] = "application/json";
  if (config.origin) headers.origin = config.origin;
  if (config.bearerToken) headers.authorization = `Bearer ${config.bearerToken}`;
  return headers;
}

function vivaAgentProtocols(token) {
  if (!token) return ["viva-voice"];
  return ["viva-voice", `bearer.${base64Url(token)}`];
}

async function createDefaultWebSocket(url, protocols, options = {}) {
  if (options.origin) {
    try {
      const wsModule = await import("ws");
      const WebSocketCtor = wsModule.WebSocket ?? wsModule.default;
      return new WebSocketCtor(url, protocols, { origin: options.origin });
    } catch (_error) {
      if (!isLoopbackWebSocketUrl(url)) {
        throw new Error("origin_header_requires_ws_dependency");
      }
    }
  }
  if (typeof WebSocket === "undefined") {
    throw new Error("websocket_unavailable");
  }
  return new WebSocket(url, protocols);
}

function onSocket(socket, type, listener) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  if (typeof socket.on === "function") {
    const wrapped =
      type === "message"
        ? (data) => listener({ data })
        : type === "close"
          ? (code, reason) => listener({ code, reason, wasClean: code === 1000 })
          : listener;
    socket.on(type, wrapped);
    return () => {
      if (typeof socket.off === "function") socket.off(type, wrapped);
      else if (typeof socket.removeListener === "function") socket.removeListener(type, wrapped);
    };
  }
  throw new Error("unsupported websocket implementation");
}

function closeSocket(socket) {
  if (socket.readyState === 2 || socket.readyState === 3) return;
  if (typeof socket.close === "function") {
    socket.close(1000, "complete");
  }
}

function baseEvidence(config, now) {
  return {
    schema: "viva.live_provider_smoke.v1",
    generated_at: now().toISOString(),
    deploy_sha: config.deploySha,
    run_id: config.runId ?? null,
    agent_deploy_id: config.agentDeployId ?? null,
    enabled: true,
    failure_matrix: failureMatrixEvidence(),
    model: config.model,
    provider: config.provider,
    caps: { ...config.caps },
    privacy: privacyEvidence(),
  };
}

function skippedEvidence(config, now) {
  return {
    schema: "viva.live_provider_smoke.v1",
    generated_at: now().toISOString(),
    deploy_sha: config.deploySha,
    run_id: config.runId ?? null,
    agent_deploy_id: config.agentDeployId ?? null,
    enabled: false,
    model: config.model,
    status: "skipped",
    provider: config.provider,
    terminal_reason: "explicit_opt_in_not_set",
    privacy: privacyEvidence(),
  };
}

function privacyEvidence() {
  return {
    answer_content_retained: false,
    full_notes_retained: false,
    prompt_content_retained: false,
    provider_secret_values_recorded: false,
    raw_audio_retained: false,
    source_excerpts_retained: false,
    transcript_content_retained: false,
  };
}

export function liveMonitorEvidence({
  agentDeployId = null,
  consecutiveFailures,
  deploySha = "unknown",
  model = DEFAULT_GEMINI_MODEL,
  runId = null,
  status,
  terminalReason,
}) {
  const failed = status === "failed";
  const stuckChecking = terminalReason === "recap_timeout";
  const priorConsecutiveFailures = Number.isSafeInteger(consecutiveFailures)
    ? consecutiveFailures
    : 0;
  return {
    deploy_sha: deploySha,
    run_id: runId,
    agent_deploy_id: agentDeployId,
    failure_class: failed ? "live_monitor_failure" : null,
    live_monitor_attempt_count: 1,
    live_monitor_consecutive_failures: failed ? priorConsecutiveFailures + 1 : 0,
    model,
    sanitized: true,
    signal: failed ? "live_monitor_failure" : null,
    stage: "monitor",
    stuck_checking_sessions: stuckChecking ? 1 : 0,
    terminal_reason: terminalReason,
  };
}

export function configurationFailureEvidence({
  env = process.env,
  liveMonitorConsecutiveFailures = safeLiveMonitorConsecutiveFailures(env),
  now = () => new Date(),
} = {}) {
  const failure = liveProviderFailureForSmokeReason("configuration_error");
  const config = {
    agentDeployId: env.VIVA_LIVE_SMOKE_AGENT_DEPLOY_ID?.trim() || null,
    deploySha: deploymentSha(env),
    liveMonitorConsecutiveFailures,
    model: liveSmokeModel(env),
    runId: env.VIVA_LIVE_SMOKE_RUN_ID?.trim() || null,
  };
  return {
    schema: "viva.live_provider_smoke.v1",
    generated_at: now().toISOString(),
    deploy_sha: config.deploySha,
    run_id: config.runId,
    agent_deploy_id: config.agentDeployId,
    enabled: liveSmokeEnabled(env),
    failure_matrix: failureMatrixEvidence(),
    failure_stage: "configuration",
    failure,
    failure_class: failure.failure_class,
    model: config.model,
    monitor: failedMonitorEvidence(config, "configuration_error"),
    provider: LIVE_PROVIDER,
    status: "failed",
    terminal_reason: "configuration_error",
    privacy: privacyEvidence(),
  };
}

export async function configurationFailureEvidenceWithMonitorState({
  env = process.env,
  now = () => new Date(),
  outputPath = liveSmokeOutputPath(env),
  readFileImpl = readFile,
} = {}) {
  const config = {
    deploySha: deploymentSha(env),
    liveMonitorConsecutiveFailures: safeLiveMonitorConsecutiveFailures(env),
    model: liveSmokeModel(env),
    outputPath,
  };
  const liveMonitorConsecutiveFailures = await previousLiveMonitorConsecutiveFailures(
    config,
    readFileImpl,
  );
  return configurationFailureEvidence({
    env,
    liveMonitorConsecutiveFailures,
    now,
  });
}

function failedMonitorEvidence(config, terminalReason) {
  return liveMonitorEvidence({
    agentDeployId: config.agentDeployId ?? null,
    consecutiveFailures: config.liveMonitorConsecutiveFailures,
    deploySha: config.deploySha,
    model: config.model,
    runId: config.runId ?? null,
    status: "failed",
    terminalReason,
  });
}

function readinessUnavailable() {
  return {
    access: {
      reason: null,
      status: "unknown",
    },
    failure_kind: "dependency_unavailable",
    health_http_status: null,
    ready: false,
    ready_http_status: null,
    readiness_status: "dependency_unavailable",
    brain: {
      configured: false,
      live_runtime: false,
      provider: null,
      selectable: false,
    },
    voice_limits: {
      max_session_cost_usd: null,
    },
    store: {
      available: false,
      backend: null,
      durable: false,
      nonce_replay_protection: false,
    },
    usage: {
      events: null,
      total_tokens: null,
    },
  };
}

function usageSnapshotFromBody(usage) {
  return {
    events: integerOrNull(usage?.events),
    total_tokens: integerOrNull(usage?.total_tokens),
  };
}

function usageEvidence(before, after, config) {
  const eventsBefore = before?.events ?? null;
  const eventsAfter = after?.events ?? null;
  const tokensBefore = before?.total_tokens ?? null;
  const tokensAfter = after?.total_tokens ?? null;
  return {
    events_before: eventsBefore,
    events_after: eventsAfter,
    events_delta:
      Number.isInteger(eventsBefore) && Number.isInteger(eventsAfter)
        ? Math.max(0, eventsAfter - eventsBefore)
        : null,
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    tokens_delta:
      Number.isInteger(tokensBefore) && Number.isInteger(tokensAfter)
        ? Math.max(0, tokensAfter - tokensBefore)
        : null,
    max_tokens: config.caps.max_tokens,
    cost_budget_usd: config.caps.max_session_cost_usd,
  };
}

function tokenUsageCapFailure(before, after, config) {
  if (config.caps.max_tokens == null) return false;
  const tokensBefore = before?.total_tokens;
  const tokensAfter = after?.total_tokens;
  if (!Number.isInteger(tokensBefore) || !Number.isInteger(tokensAfter)) return true;
  return Math.max(0, tokensAfter - tokensBefore) > config.caps.max_tokens;
}

function summarizeBrain(brain) {
  return {
    configured: brain?.configured === true,
    live_runtime: brain?.live_runtime === true,
    provider: typeof brain?.provider === "string" ? brain.provider : null,
    selectable: brain?.selectable === true,
  };
}

function summarizeStore(store) {
  return {
    available: store?.available === true,
    backend: typeof store?.backend === "string" ? store.backend : null,
    durable: store?.durable === true,
    observed: store !== null && typeof store === "object",
    nonce_replay_protection: store?.nonce_replay_protection === true,
  };
}

function summarizeAccess(access) {
  return {
    reason: stringOrNull(access?.reason),
    status: stringOrNull(access?.status) ?? "unknown",
  };
}

function suppliedSessionFromEnv(env) {
  const userId = env.VIVA_LIVE_SMOKE_USER_ID?.trim();
  const studySetId = env.VIVA_LIVE_SMOKE_STUDY_SET_ID?.trim();
  const sessionId = env.VIVA_LIVE_SMOKE_SESSION_ID?.trim();
  if (!userId && !studySetId && !sessionId) return null;
  if (!userId || !studySetId || !sessionId) {
    throw new Error("live smoke supplied session identity is incomplete");
  }
  return {
    sessionId,
    signedSession: env.VIVA_LIVE_SMOKE_SESSION_TOKEN?.trim() || null,
    studySetId,
    userId,
  };
}

function requiredPositiveInteger(env, name) {
  const value = requiredValue(env, name, "missing live smoke cap");
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid live smoke cap ${name}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid live smoke cap ${name}`);
  }
  return parsed;
}

function requiredPositiveNumber(env, name) {
  const value = requiredValue(env, name, "missing live smoke cap");
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid live smoke cap ${name}`);
  }
  return parsed;
}

function optionalNonNegativeInteger(value) {
  if (!hasValue(value)) return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error("invalid live monitor consecutive failure count");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("invalid live monitor consecutive failure count");
  }
  return parsed;
}

function optionalPositiveNumber(env, name) {
  const value = env[name]?.trim();
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid live smoke cap ${name}`);
  }
  return parsed;
}

function optionalPositiveInteger(env, name) {
  const value = env[name]?.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid live smoke cap ${name}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid live smoke cap ${name}`);
  }
  return parsed;
}

function safeLiveMonitorConsecutiveFailures(env) {
  try {
    return optionalNonNegativeInteger(env.VIVA_LIVE_MONITOR_CONSECUTIVE_FAILURES);
  } catch {
    return 0;
  }
}

async function previousLiveMonitorConsecutiveFailures(config, readFileImpl) {
  let previousArtifactFailures = 0;
  try {
    const raw = await readFileImpl(config.outputPath, "utf8");
    previousArtifactFailures = liveMonitorConsecutiveFailuresFromEvidence(JSON.parse(raw), config);
  } catch {
    previousArtifactFailures = 0;
  }
  return Math.max(config.liveMonitorConsecutiveFailures, previousArtifactFailures);
}

function liveMonitorConsecutiveFailuresFromEvidence(evidence, currentConfig = null) {
  if (
    evidence?.schema !== "viva.live_provider_smoke.v1" ||
    evidence.status !== "failed" ||
    evidence.monitor === null ||
    typeof evidence.monitor !== "object"
  ) {
    return 0;
  }
  if (currentConfig) {
    const priorDeploySha = evidence.monitor.deploy_sha ?? evidence.deploy_sha ?? null;
    const priorModel = evidence.monitor.model ?? evidence.model ?? null;
    if (priorDeploySha !== currentConfig.deploySha || priorModel !== currentConfig.model) {
      return 0;
    }
  }
  const count = evidence.monitor.live_monitor_consecutive_failures;
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function deploymentSha(env) {
  for (const name of [
    "RAILWAY_GIT_COMMIT_SHA",
    "VERCEL_GIT_COMMIT_SHA",
    "GITHUB_SHA",
    "SOURCE_VERSION",
  ]) {
    const value = env[name]?.trim();
    if (value) return value.slice(0, 64);
  }
  return "unknown";
}

function liveSmokeModel(env) {
  return (
    env.VIVA_LIVE_SMOKE_MODEL?.trim() ||
    env.GEMINI_MODEL?.trim() ||
    env.GEMINI_REALTIME_MODEL?.trim() ||
    DEFAULT_GEMINI_MODEL
  );
}

function requiredValue(env, name, message) {
  const value = env[name]?.trim();
  if (!value) throw new Error(message);
  return value;
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function objectOrNull(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function httpUrlFromWs(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else return null;
    url.pathname = url.pathname.replace(/\/ws\/?$/, "") || "/";
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

function wsUrlFromHttp(value) {
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" ? safeEnum(value) : null;
}

function safeEnum(value) {
  return String(value)
    .replace(/[^a-z0-9_.-]+/gi, "_")
    .slice(0, 80);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function withTimeout(promise, ms, reason) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isLoopbackWebSocketUrl(value) {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function writeEvidence(outputPath, evidence) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function main() {
  const outputPath = liveSmokeOutputPath(process.env);
  const interruptState = {
    stage: "startup",
    eventCounts: null,
    deploySha: deploymentSha(process.env),
    model: liveSmokeModel(process.env),
    runId: process.env.VIVA_LIVE_SMOKE_RUN_ID?.trim() || null,
  };
  let finalized = false;

  // BAC-527: single-shot finalization so the runner's supervisory SIGTERM
  // and normal completion can never race each other into a double or
  // partial write.
  const finalizeEvidence = async (evidence) => {
    if (finalized) return;
    finalized = true;
    auditLiveSmokeEvidence(evidence, process.env);
    await writeEvidence(outputPath, evidence);
    console.log(`Sanitized live smoke evidence written to ${path.relative(root, outputPath)}`);
    if (evidence.status === "failed") {
      process.exitCode = 1;
    }
  };

  const onSigterm = () => {
    void finalizeEvidence(interruptedEvidence(interruptState, "SIGTERM"));
  };
  process.once("SIGTERM", onSigterm);

  let evidence;
  try {
    evidence = await runLiveProviderSmoke({ interruptState });
  } catch {
    evidence = await configurationFailureEvidenceWithMonitorState({ outputPath });
  }
  process.removeListener("SIGTERM", onSigterm);
  await finalizeEvidence(evidence);
}

function liveSmokeEnabled(env) {
  return env.VIVA_LIVE_PROVIDER_SMOKE === "1" || env.VIVA_LIVE_SMOKE === "1";
}

function liveSmokeArtifactDir(env, rootDir = root) {
  return path.resolve(rootDir, env.VIVA_LIVE_SMOKE_ARTIFACT_DIR ?? "artifacts/live-provider-smoke");
}

function liveSmokeOutputPath(env, rootDir = root) {
  const artifactDir = liveSmokeArtifactDir(env, rootDir);
  return path.resolve(
    rootDir,
    env.VIVA_LIVE_SMOKE_EVIDENCE_PATH ?? path.join(artifactDir, "evidence.json"),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
