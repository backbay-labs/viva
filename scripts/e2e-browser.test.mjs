// RELEASE-023: the browser harness's decision logic is tested by *running* it,
// not by reading its source. Every reducer below is imported and exercised
// directly; `e2e-browser.mjs` is import-safe (its story runs only when the file
// is the process entrypoint) precisely so this file can do that.
//
// The retained source scans live in `e2e-browser-static.test.mjs` and cover
// only structural bans a reducer cannot express ("no REST bearer in browser
// JavaScript").
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHostedSyntheticIdentity,
  assertHostedWebSocketTarget,
  failureControlReplayClientFrames,
  LEARNING_TRUTH_CHECKS,
  normalizeComparableWsUrl,
  normalizeHostedHttpUrl,
  normalizeHostedWsUrl,
  postAnswerProtocolProofFromEvents,
  recordServerFramePayload,
  redactSensitiveDiagnostic,
  summarizeLearningTruth,
  summarizeVoiceTransportMatrix,
  terminalProofFromServerEvents,
  VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS,
  VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ,
  voiceTransportMatrixCellsFromAudioEvidence,
  waitForFailureControlTerminal,
} from "./e2e-browser.mjs";

test("hosted URL normalization strips credentials-bearing query, fragment, and trailing slash noise", () => {
  assert.equal(
    normalizeHostedHttpUrl("https://web.example.com/?session_token=leak#fragment", "TEST_URL"),
    "https://web.example.com",
  );
  assert.equal(
    normalizeHostedHttpUrl("https://web.example.com/app////", "TEST_URL"),
    "https://web.example.com/app",
  );
  assert.throws(
    () => normalizeHostedHttpUrl("ws://web.example.com", "TEST_URL"),
    /TEST_URL must use http:\/\/ or https:\/\//,
  );
  assert.equal(
    normalizeHostedWsUrl("wss://agent.example.com/ws?x=1", "WS_URL"),
    "wss://agent.example.com/ws",
  );
  assert.throws(
    () => normalizeHostedWsUrl("https://agent.example.com/ws", "WS_URL"),
    /WS_URL must use ws:\/\/ or wss:\/\//,
  );
});

test("websocket target comparison ignores query and fragment but never the origin or path", () => {
  assert.equal(
    normalizeComparableWsUrl("wss://agent.example.com/ws?session_token=leak#f"),
    "wss://agent.example.com/ws",
  );

  assert.doesNotThrow(() =>
    assertHostedWebSocketTarget(
      ["wss://agent.example.com/ws?session_token=secret-value"],
      "wss://agent.example.com/ws",
    ),
  );
  assert.throws(
    () =>
      assertHostedWebSocketTarget(["wss://attacker.example.com/ws"], "wss://agent.example.com/ws"),
    /did not connect to configured agent WebSocket/,
  );
});

test("the websocket-target failure message never republishes an observed URL's credentials", () => {
  let message = "";
  try {
    assertHostedWebSocketTarget(
      ["wss://user:hunter2@attacker.example.com/ws?session_token=secret-value"],
      "wss://agent.example.com/ws",
    );
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /attacker\.example\.com/);
  assert.doesNotMatch(message, /hunter2/);
  assert.doesNotMatch(message, /secret-value/);
});

test("hosted synthetic identity rejection refuses anything that could be a real learner", () => {
  assert.doesNotThrow(() => assertHostedSyntheticIdentity({ userId: "synthetic-monitor-1" }));
  assert.doesNotThrow(() => assertHostedSyntheticIdentity({ userId: "hosted-monitor" }));
  for (const userId of ["user-1", "learner-42", "synthetic-learner-1", "monitor-student"]) {
    assert.throws(
      () => assertHostedSyntheticIdentity({ userId }),
      /requires a synthetic monitor user identity/,
      `identity ${userId} must be refused`,
    );
  }
});

test("terminal proof is reduced from the observed event stream, never asserted from a flag", () => {
  const events = [
    { type: "question_started", terminalReason: null },
    { type: "session_phase", terminalReason: null },
    { type: "session_phase", terminalReason: "partial_stage_success" },
  ];

  const proof = terminalProofFromServerEvents(events, {
    failureClass: "partial_stage_success",
    scenarioId: "deterministic_partial_recap",
    stage: "websocket",
    terminalReason: "partial_stage_success",
    validationRunId: "browser-story-test",
  });
  assert.equal(proof.event_index, 2);
  assert.equal(proof.terminal_reason, "partial_stage_success");
  assert.equal(proof.validation_run_id, "browser-story-test");
  assert.equal(proof.sanitized, true);

  // A stream that never carried the terminal yields no proof at all: an
  // absent reduction is a `null`, not an optimistic default.
  assert.equal(
    terminalProofFromServerEvents(events.slice(0, 2), {
      failureClass: "partial_stage_success",
      scenarioId: "deterministic_partial_recap",
      stage: "websocket",
      terminalReason: "partial_stage_success",
      validationRunId: "browser-story-test",
    }),
    null,
  );
  // A different terminal reason on the wire is not this scenario's proof.
  assert.equal(
    terminalProofFromServerEvents(events, {
      failureClass: "provider_timeout",
      scenarioId: "deterministic_partial_recap",
      stage: "websocket",
      terminalReason: "provider_timeout",
      validationRunId: "browser-story-test",
    }),
    null,
  );
});

test("post-answer proof binds source_reference and concept_status to the same response id", () => {
  const events = [
    { type: "answer_evaluated", responseId: "resp-1" },
    { type: "source_reference", responseId: "resp-1", sourceId: "src-lecture-5-slide-18" },
    { type: "concept_status", responseId: "resp-1", conceptId: "nadh", conceptStatus: "shaky" },
  ];
  const proof = postAnswerProtocolProofFromEvents(events, 1_000, 1_250);

  assert.equal(proof.responseId, "resp-1");
  assert.equal(proof.sourceReferenceEventSeen, true);
  assert.equal(proof.conceptStatusEventSeen, true);
  assert.equal(proof.conceptId, "nadh");
  assert.equal(proof.conceptStatus, "shaky");
  assert.equal(proof.latencyMs, 250);
});

test("post-answer proof refuses events that belong to a different response or precede the answer", () => {
  const crossBound = postAnswerProtocolProofFromEvents([
    { type: "answer_evaluated", responseId: "resp-2" },
    { type: "source_reference", responseId: "resp-1", sourceId: "src-1" },
    { type: "concept_status", responseId: "resp-1", conceptId: "nadh", conceptStatus: "strong" },
  ]);
  assert.equal(crossBound.sourceReferenceEventSeen, false);
  assert.equal(crossBound.conceptStatusEventSeen, false);

  const beforeAnswer = postAnswerProtocolProofFromEvents([
    { type: "source_reference", responseId: "resp-1", sourceId: "src-1" },
    { type: "concept_status", responseId: "resp-1", conceptId: "nadh", conceptStatus: "strong" },
    { type: "answer_evaluated", responseId: "resp-1" },
  ]);
  assert.equal(beforeAnswer.sourceReferenceEventSeen, false);
  assert.equal(beforeAnswer.conceptStatusEventSeen, false);

  const empty = postAnswerProtocolProofFromEvents([]);
  assert.equal(empty.responseId, null);
  assert.equal(empty.latencyMs, null);
});

test("sanitized diagnostics keep session material out of harness failure text", () => {
  const raw =
    "navigation failed at http://localhost:3000/session#session_token=viva1.abcDEF-123 with Bearer sk-should-not-appear";
  const redacted = redactSensitiveDiagnostic(raw);

  assert.doesNotMatch(redacted, /viva1\.abcDEF-123/);
  assert.doesNotMatch(redacted, /sk-should-not-appear/);
  assert.match(redacted, /redacted/);
});

// ---------------------------------------------------------------------------
// RELEASE-023 negative control: a source scan cannot tell a real reducer from
// an impostor that names the same identifiers and passes unconditionally. The
// behavioral assertion can.
// ---------------------------------------------------------------------------
test("a source-passing impostor reducer is rejected behaviorally where a regex would have approved it", () => {
  const brokenEvidence = failingMatrixEvidence();

  function summarizeVoiceTransportMatrixImpostor() {
    // Every token the retired structural scan looked for is present in this
    // function's own source text: VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX,
    // audio_end, audio_turn_accepted, transcript_final, recap_ready.
    return { passed: true, failures: [], missing_cells: [] };
  }

  const impostorSource = summarizeVoiceTransportMatrixImpostor.toString();
  // The old regex-shaped proof: satisfied by the impostor.
  assert.match(impostorSource, /VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX/);
  assert.match(impostorSource, /audio_turn_accepted/);
  assert.match(impostorSource, /audio_end/);
  assert.equal(summarizeVoiceTransportMatrixImpostor(brokenEvidence).passed, true);

  // The behavioral proof: the impostor's unconditional pass is exactly what
  // the real reducer refuses.
  const real = summarizeVoiceTransportMatrix({ ...brokenEvidence, required: true });
  assert.equal(real.passed, false);
  assert.ok(real.failures.length > 0);
});

// ---------------------------------------------------------------------------
// RELEASE-023 required voice-transport matrix
// ---------------------------------------------------------------------------

function matrixCell(overrides = {}) {
  return {
    duration_seconds: 2,
    source_sample_rate_hz: 48_000,
    chunk_sample_rate_hz: 24_000,
    frames_sent: 100,
    final_sequence: 99,
    max_chunk_raw_bytes: 960,
    max_text_frame_bytes: 1_400,
    contiguous_sequence: true,
    distinct_turn_ids: 1,
    turn_id: "turn-1",
    accepted_turn_id: "turn-1",
    accepted_final_sequence: 99,
    audio_end_status: "sent",
    audio_turn_accepted_count: 1,
    transcript_final_count: 1,
    answer_evaluated_count: 1,
    next_ready: true,
    closed_before_acceptance: false,
    backpressure_reordered: 0,
    backpressure_dropped: 0,
    lower_layer_matches: 1,
    ...overrides,
  };
}

function fullMatrixCells() {
  const cells = [];
  for (const rate of VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ) {
    for (const seconds of VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS) {
      cells.push(
        matrixCell({
          duration_seconds: seconds,
          source_sample_rate_hz: rate,
          frames_sent: seconds * 50,
          final_sequence: seconds * 50 - 1,
          accepted_final_sequence: seconds * 50 - 1,
          turn_id: `turn-${rate}-${seconds}`,
          accepted_turn_id: `turn-${rate}-${seconds}`,
        }),
      );
    }
  }
  return cells;
}

function passingMatrixEvidence(overrides = {}) {
  return {
    required: true,
    loopbackSkipped: false,
    cells: fullMatrixCells(),
    negativeControl: { case: "oversized-single-chunk", passed: true, rejected: true },
    ...overrides,
  };
}

function failingMatrixEvidence() {
  return passingMatrixEvidence({ cells: fullMatrixCells().slice(0, 1) });
}

test("the required matrix passes only on all six duration/sample-rate cells", () => {
  const summary = summarizeVoiceTransportMatrix(passingMatrixEvidence());

  assert.equal(summary.required, true);
  assert.equal(summary.passed, true);
  assert.deepEqual(summary.missing_cells, []);
  assert.equal(summary.cells.length, 6);
  assert.deepEqual(
    [...new Set(summary.cells.map((cell) => cell.source_sample_rate_hz))].sort(),
    [...VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ].sort(),
  );
  assert.deepEqual(summary.sanitized, true);
});

test("an absent duration/rate cell fails the required matrix and names exactly what is missing", () => {
  const cells = fullMatrixCells().filter(
    (cell) => !(cell.duration_seconds === 45 && cell.source_sample_rate_hz === 44_100),
  );
  const summary = summarizeVoiceTransportMatrix(passingMatrixEvidence({ cells }));

  assert.equal(summary.passed, false);
  assert.deepEqual(summary.missing_cells, [
    { duration_seconds: 45, source_sample_rate_hz: 44_100 },
  ]);
});

test("the matrix is not required, and does not fail the run, unless it was explicitly requested", () => {
  const summary = summarizeVoiceTransportMatrix({
    required: false,
    loopbackSkipped: false,
    cells: [],
    negativeControl: null,
  });
  assert.equal(summary.required, false);
  assert.equal(summary.passed, true);
});

test("every required matrix invariant fails closed on its own", () => {
  const cases = [
    ["oversized text frame", { max_text_frame_bytes: 64 * 1024 + 1 }, /text frame/i],
    ["oversized audio chunk", { max_chunk_raw_bytes: 8_193 }, /chunk/i],
    ["non-contiguous sequence", { contiguous_sequence: false }, /contiguous/i],
    ["missing audio_end", { audio_end_status: "queued" }, /audio_end/i],
    ["absent acceptance", { audio_turn_accepted_count: 0 }, /audio_turn_accepted/i],
    ["acceptance for another turn", { accepted_turn_id: "turn-other" }, /turn/i],
    ["acceptance of the wrong final sequence", { accepted_final_sequence: 7 }, /final_sequence/i],
    ["two transcripts", { transcript_final_count: 2 }, /transcript/i],
    ["zero evaluations", { answer_evaluated_count: 0 }, /evaluation/i],
    ["no recap or next question", { next_ready: false }, /recap|next question/i],
    ["close before acceptance", { closed_before_acceptance: true }, /close/i],
    ["backpressure reorder", { backpressure_reordered: 1 }, /reorder/i],
    ["backpressure drop", { backpressure_dropped: 1 }, /drop/i],
    ["zero-match lower-layer test", { lower_layer_matches: 0 }, /lower.layer/i],
    ["more than one turn identity", { distinct_turn_ids: 2 }, /turn/i],
  ];

  for (const [label, mutation, pattern] of cases) {
    const cells = fullMatrixCells();
    cells[0] = { ...cells[0], ...mutation };
    const summary = summarizeVoiceTransportMatrix(passingMatrixEvidence({ cells }));
    assert.equal(summary.passed, false, `${label} must fail the required matrix`);
    assert.ok(
      summary.failures.some((failure) => pattern.test(failure)),
      `${label} must be named in the failures: ${summary.failures.join(" | ")}`,
    );
  }
});

test("a skipped loopback can never satisfy the required matrix", () => {
  const summary = summarizeVoiceTransportMatrix(passingMatrixEvidence({ loopbackSkipped: true }));
  assert.equal(summary.passed, false);
  assert.ok(summary.failures.some((failure) => /loopback/i.test(failure)));
});

test("the pre-v5 single-frame rejection stays a required negative control of the matrix", () => {
  const missing = summarizeVoiceTransportMatrix(passingMatrixEvidence({ negativeControl: null }));
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.some((failure) => /negative control/i.test(failure)));

  const unrejected = summarizeVoiceTransportMatrix(
    passingMatrixEvidence({
      negativeControl: { case: "oversized-single-chunk", passed: false, rejected: false },
    }),
  );
  assert.equal(unrejected.passed, false);
  assert.ok(unrejected.failures.some((failure) => /negative control/i.test(failure)));
});

test("matrix cells are derived from the audio harness's own executed evidence", () => {
  const cells = voiceTransportMatrixCellsFromAudioEvidence({
    case: "streamed-turns",
    source_sample_rate_hz: 44_100,
    max_text_frame_bytes: 64 * 1024,
    max_chunk_bytes: 8_192,
    evaluation: { passed: true, failures: [] },
    observation: {
      capture_source_sample_rate_hz: 44_100,
      capture_target_sample_rate_hz: 24_000,
      distinct_turn_ids: 3,
      socket_open_after_all: true,
      stale_events: 0,
      turns: [
        {
          seconds: 2,
          chunks_sent: 100,
          final_sequence: 99,
          max_chunk_raw_bytes: 960,
          end_result_status: "sent",
          acceptances: 1,
          turn_id: "turn-1",
          accepted_turn_id: "turn-1",
          accepted_final_sequence: 99,
          transcripts: ["received 96000 PCM16 bytes"],
          evaluations: 1,
          phase_after_turn: "correction",
          socket_status_after_turn: "open",
          chunk_send_statuses: { sent: 100 },
        },
      ],
    },
  });

  assert.equal(cells.length, 1);
  assert.equal(cells[0].duration_seconds, 2);
  assert.equal(cells[0].source_sample_rate_hz, 44_100);
  assert.equal(cells[0].audio_end_status, "sent");
  assert.equal(cells[0].audio_turn_accepted_count, 1);
  assert.equal(cells[0].transcript_final_count, 1);
  assert.equal(cells[0].answer_evaluated_count, 1);
  assert.equal(cells[0].closed_before_acceptance, false);
  assert.equal(cells[0].lower_layer_matches, 1);
  assert.equal(cells[0].contiguous_sequence, true);

  // A harness run that reported its own failures contributes no passing cell.
  const failed = voiceTransportMatrixCellsFromAudioEvidence({
    case: "streamed-turns",
    source_sample_rate_hz: 44_100,
    evaluation: { passed: false, failures: ["turn 2s: a single chunk carried the whole turn"] },
    observation: { turns: [] },
  });
  assert.deepEqual(failed, []);
});
test("recordServerFramePayload only records frames the shared v5 contract accepts", () => {
  const events = [];
  recordServerFramePayload(
    JSON.stringify({
      type: "event",
      version: 5,
      event: {
        type: "concept_status",
        response_id: "resp-1",
        concept_id: "nadh",
        status: "shaky",
      },
    }),
    events,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "concept_status");
  assert.equal(events[0].conceptId, "nadh");
  assert.equal(events[0].conceptStatus, "shaky");

  // Unparseable text, an unknown frame type, a wrong version, and an unknown
  // nested field are all refused before anything branches on them.
  const rejected = [];
  recordServerFramePayload("{not json", rejected);
  recordServerFramePayload(JSON.stringify({ type: "nope", version: 5 }), rejected);
  recordServerFramePayload(
    JSON.stringify({ type: "event", version: 4, event: { type: "session_phase", phase: "ready" } }),
    rejected,
  );
  recordServerFramePayload(
    JSON.stringify({
      type: "event",
      version: 5,
      event: { type: "session_phase", phase: "ready", smuggled: "hostile-value" },
    }),
    rejected,
  );
  assert.deepEqual(
    rejected.map((event) => event.type),
    [
      "invalid_server_frame",
      "invalid_server_frame",
      "invalid_server_frame",
      "invalid_server_frame",
    ],
  );
  assert.equal(JSON.stringify(rejected).includes("hostile-value"), false);
});

test("a v5 error frame is reduced from its typed code, not from a v4 top-level message", () => {
  const events = [];
  recordServerFramePayload(
    JSON.stringify({
      type: "error",
      version: 5,
      error: { code: "VOICE_AUTH_INVALID", message: "session auth failed", retryable: false },
    }),
    events,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "server_error");
  assert.equal(events[0].errorCode, "VOICE_AUTH_INVALID");
  assert.equal(events[0].terminalReason, "session_auth_rejected");
});

// ---------------------------------------------------------------------------
// RELEASE-028 / Task 13 Step 1: "thrown messages, evidence, logs, and browser
// results contain none of the ... transcript, answer, token, or raw JSON".
//
// A *valid* structured error is the path the invalid-frame rejection cannot
// cover: the frame is well-formed, so the validator accepts it, and its
// `error.message` is free text the SERVER authored. `redactSensitiveDiagnostic`
// only strips session tokens and bearer patterns, so anything else in that
// string reaches `failure.json` and the rethrown harness error verbatim unless
// the reducer refuses to retain it in the first place.
// ---------------------------------------------------------------------------
test("a server-authored error message reaches neither the event record nor the thrown failure text", async () => {
  const sentinel = "NADH-donates-electrons-learner-answer-sentinel";
  const events = [];
  recordServerFramePayload(
    JSON.stringify({
      type: "error",
      version: 5,
      error: {
        code: "VOICE_CLIENT_FRAME_MALFORMED",
        message: `rejected turn text: ${sentinel}`,
        retryable: false,
      },
    }),
    events,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "server_error");
  assert.equal(events[0].errorCode, "VOICE_CLIENT_FRAME_MALFORMED");
  assert.equal(
    JSON.stringify(events).includes(sentinel),
    false,
    "the recorded event must retain the typed code only, never the server's free text",
  );

  // The same event, reduced into the timeout diagnostic that `main()`'s catch
  // writes verbatim into `failure.json` and rethrows.
  let thrown = "";
  try {
    await waitForFailureControlTerminal(
      events,
      {
        scenario: {
          id: "deterministic_partial_recap",
          failure_class: "provider_timeout",
          stage: "websocket",
          terminal_reason: "provider_timeout",
        },
      },
      10,
    );
  } catch (error) {
    thrown = error.message;
  }
  assert.match(thrown, /Timed out waiting for failure-control/);
  assert.match(thrown, /VOICE_CLIENT_FRAME_MALFORMED/);
  assert.equal(thrown.includes(sentinel), false);
  assert.equal(redactSensitiveDiagnostic(thrown).includes(sentinel), false);
});

test("the browser-side replay frame is built from the server's own validated ready frame", () => {
  const built = failureControlReplayClientFrames({
    readyFrame: {
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
    },
    clientGenerationId: "replay-generation-1",
    session: {
      sessionId: "voice-session-1",
      studySetId: "biology-midterm",
      userId: "user-1",
      sessionToken: "viva1.replay-token",
    },
  });

  // A-03's recorded latent defect: this frame used to be a v4-shaped
  // session_config (no client_generation_id) built from a local literal, which
  // a v5 server refuses outright.
  assert.equal(built.sessionConfig.version, 5);
  assert.equal(built.sessionConfig.client_generation_id, "replay-generation-1");
  assert.deepEqual(Object.keys(built.sessionConfig).sort(), [
    "client_generation_id",
    "session",
    "session_token",
    "type",
    "version",
  ]);
  assert.equal("initial_goal" in built.sessionConfig.session, false);
});

test("the replay frame builder refuses a ready frame the shared validator does not accept", () => {
  for (const readyFrame of [
    { type: "ready", version: 4 },
    { type: "event", version: 5, event: { type: "session_phase", phase: "ready" } },
    null,
  ]) {
    assert.throws(
      () =>
        failureControlReplayClientFrames({
          readyFrame,
          clientGenerationId: "replay-generation-1",
          session: { sessionId: "s", studySetId: "set", userId: "u", sessionToken: "t" },
        }),
      (error) => error.code === "voice_server_frame_invalid",
    );
  }
});

// ---------------------------------------------------------------------------
// Task 7 Step 2 / Plan 04 LEARN-012 Step 3: the eight learning-truth checks.
//
// Plan 04's LEARN-012 Step 3 stays BLOCKED until this lane confirms the harness
// asserts them, and "screenshot existence alone is insufficient" — so each one
// is proved here by driving the reducer, and each one is proved to fail closed
// on its own.
// ---------------------------------------------------------------------------

function learningTruthEvents(overrides = {}) {
  const events = [
    {
      type: "question_started",
      responseId: "resp-1",
      questionId: "question-nadh-1",
      conceptId: "nadh",
      turnId: "turn-1",
    },
    { type: "transcript_final", responseId: "resp-1" },
    {
      type: "answer_evaluated",
      responseId: "resp-1",
      questionId: "question-nadh-1",
      evaluationLabel: "mostly correct",
      conceptStatus: "shaky",
    },
    { type: "source_reference", responseId: "resp-1", sourceId: "src-lecture-5-slide-18" },
    { type: "concept_status", responseId: "resp-1", conceptId: "nadh", conceptStatus: "shaky" },
    {
      type: "question_started",
      responseId: "resp-2",
      questionId: "question-atp-2",
      conceptId: "atp-synthase",
      turnId: "turn-2",
    },
    {
      type: "turn_deferred",
      responseId: "resp-2",
      questionId: "question-atp-2",
      turnId: "turn-2",
      deferralReason: "insufficient_semantic_evidence",
      canRetrySameQuestion: true,
    },
    {
      type: "recap_ready",
      responseId: "resp-3",
      recapSchema: "viva.study_session_recap.v2",
      recapPartial: false,
      recapDeferredTurns: 1,
      recapConcepts: [{ conceptId: "nadh", status: "shaky" }],
      reviewSchedule: [
        {
          conceptId: "nadh",
          dueAt: "2026-08-29T09:00:00Z",
          authority: "server_persisted_fsrs",
        },
      ],
    },
  ];
  return overrides.events ?? events;
}

function learningTruthVisible(overrides = {}) {
  return {
    authenticatedEntry: true,
    deferredMasteryVisible: false,
    deferredRecoveryVisible: true,
    disconnectionCopyVisible: false,
    evaluatedTurnVisible: true,
    examAt: "2026-09-15T00:00:00Z",
    honestBeginActionVisible: true,
    modeGoalCommandVisible: false,
    modeSuggestionChipsVisible: false,
    questionPromptVisible: true,
    recapVisible: true,
    recapVisibleAfterClose: true,
    reviewAuthorityVisible: true,
    secondQuestionPromptVisible: true,
    ...overrides,
  };
}

test("the learning-truth summary names Plan 04's eight assertions and passes only on all of them", () => {
  const summary = summarizeLearningTruth({
    required: true,
    events: learningTruthEvents(),
    visible: learningTruthVisible(),
  });

  assert.deepEqual(
    summary.checks.map((check) => check.id),
    [...LEARNING_TRUTH_CHECKS],
  );
  assert.equal(LEARNING_TRUTH_CHECKS.length, 8);
  assert.equal(summary.required, true);
  assert.equal(summary.passed, true, summary.failures.join(" | "));
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.sanitized, true);
});

test("the learning-truth summary is recorded but cannot fail a run that did not require it", () => {
  const summary = summarizeLearningTruth({ required: false, events: [], visible: {} });
  assert.equal(summary.required, false);
  assert.equal(summary.passed, true);
  assert.equal(summary.checks.length, 8);
  assert.ok(summary.checks.every((check) => check.passed === false));
});

test("every learning truth fails closed on its own, on the event half and on the visible half", () => {
  const cases = [
    // 1. A question from AuthenticatedStudyProjectionV1 starts.
    [
      "no question started",
      { events: learningTruthEvents().filter((event) => event.type !== "question_started") },
      "projection_question_started",
    ],
    [
      "started question carries no identity",
      {
        events: learningTruthEvents().map((event) =>
          event.type === "question_started" ? { ...event, questionId: null } : event,
        ),
      },
      "projection_question_started",
    ],
    [
      "the entry was not an authenticated start",
      { visible: learningTruthVisible({ authenticatedEntry: false }) },
      "projection_question_started",
    ],
    [
      "the prompt never became visible",
      { visible: learningTruthVisible({ questionPromptVisible: false }) },
      "projection_question_started",
    ],
    // 2. An evaluated turn persists exactly one TurnOutcome.
    [
      "the evaluation persisted no concept status",
      { events: learningTruthEvents().filter((event) => event.type !== "concept_status") },
      "evaluated_turn_persists_one_outcome",
    ],
    [
      "one response id was evaluated twice",
      {
        events: [
          ...learningTruthEvents(),
          {
            type: "answer_evaluated",
            responseId: "resp-1",
            questionId: "question-nadh-1",
            evaluationLabel: "strong",
            conceptStatus: "strong",
          },
        ],
      },
      "evaluated_turn_persists_one_outcome",
    ],
    [
      "the evaluated turn never rendered",
      { visible: learningTruthVisible({ evaluatedTurnVisible: false }) },
      "evaluated_turn_persists_one_outcome",
    ],
    // 3. A deferred turn renders recovery without mastery.
    [
      "no turn was deferred",
      { events: learningTruthEvents().filter((event) => event.type !== "turn_deferred") },
      "deferred_turn_recovers_without_mastery",
    ],
    [
      "the deferred turn also wrote mastery",
      {
        events: [
          ...learningTruthEvents(),
          {
            type: "concept_status",
            responseId: "resp-2",
            conceptId: "atp-synthase",
            conceptStatus: "strong",
          },
        ],
      },
      "deferred_turn_recovers_without_mastery",
    ],
    [
      "the deferral rendered no recovery",
      { visible: learningTruthVisible({ deferredRecoveryVisible: false }) },
      "deferred_turn_recovers_without_mastery",
    ],
    [
      "the deferral rendered mastery anyway",
      { visible: learningTruthVisible({ deferredMasteryVisible: true }) },
      "deferred_turn_recovers_without_mastery",
    ],
    // 4. A second question advances under the selected D-02.
    [
      "only one question ever started",
      {
        events: learningTruthEvents().filter(
          (event) => !(event.type === "question_started" && event.questionId === "question-atp-2"),
        ),
      },
      "second_question_advances_under_d02",
    ],
    [
      "the same question was re-asked instead of advancing",
      {
        events: learningTruthEvents().map((event) =>
          event.questionId === "question-atp-2"
            ? { ...event, questionId: "question-nadh-1" }
            : event,
        ),
      },
      "second_question_advances_under_d02",
    ],
    [
      "the second prompt never became visible",
      { visible: learningTruthVisible({ secondQuestionPromptVisible: false }) },
      "second_question_advances_under_d02",
    ],
    // 5. The recap equals the persisted outcomes.
    [
      "the recap claims a concept the session never persisted",
      {
        events: learningTruthEvents().map((event) =>
          event.type === "recap_ready"
            ? {
                ...event,
                recapConcepts: [
                  { conceptId: "nadh", status: "shaky" },
                  { conceptId: "glycolysis", status: "strong" },
                ],
              }
            : event,
        ),
      },
      "recap_equals_persisted_outcomes",
    ],
    [
      "the recap disagrees with the persisted status",
      {
        events: learningTruthEvents().map((event) =>
          event.type === "recap_ready"
            ? { ...event, recapConcepts: [{ conceptId: "nadh", status: "strong" }] }
            : event,
        ),
      },
      "recap_equals_persisted_outcomes",
    ],
    [
      "the recap is not the merged v2 schema",
      {
        events: learningTruthEvents().map((event) =>
          event.type === "recap_ready"
            ? { ...event, recapSchema: "viva.study_session_recap.v1" }
            : event,
        ),
      },
      "recap_equals_persisted_outcomes",
    ],
    [
      "the recap never rendered",
      { visible: learningTruthVisible({ recapVisible: false }) },
      "recap_equals_persisted_outcomes",
    ],
    // 6. The review schedule uses the selected D-01 authority and obeys exam policy.
    [
      "the schedule claims the rejected D-01 branch's authority",
      {
        events: learningTruthEvents().map((event) =>
          event.type === "recap_ready"
            ? {
                ...event,
                reviewSchedule: [
                  {
                    conceptId: "nadh",
                    dueAt: "2026-08-29T09:00:00Z",
                    authority: "core_fsrs_read_time",
                  },
                ],
              }
            : event,
        ),
      },
      "review_schedule_under_d01_authority",
    ],
    [
      "a due instant falls after the exam",
      {
        events: learningTruthEvents().map((event) =>
          event.type === "recap_ready"
            ? {
                ...event,
                reviewSchedule: [
                  {
                    conceptId: "nadh",
                    dueAt: "2026-09-16T09:00:00Z",
                    authority: "server_persisted_fsrs",
                  },
                ],
              }
            : event,
        ),
      },
      "review_schedule_under_d01_authority",
    ],
    [
      "a due instant is not an instant",
      {
        events: learningTruthEvents().map((event) =>
          event.type === "recap_ready"
            ? {
                ...event,
                reviewSchedule: [
                  { conceptId: "nadh", dueAt: "soon", authority: "server_persisted_fsrs" },
                ],
              }
            : event,
        ),
      },
      "review_schedule_under_d01_authority",
    ],
    [
      "the schedule authority never rendered",
      { visible: learningTruthVisible({ reviewAuthorityVisible: false }) },
      "review_schedule_under_d01_authority",
    ],
    // 7. The completed recap dominates socket close/disconnection.
    [
      "the recap was partial",
      {
        events: learningTruthEvents().map((event) =>
          event.type === "recap_ready" ? { ...event, recapPartial: true } : event,
        ),
      },
      "completed_recap_dominates_close",
    ],
    [
      "an error frame followed the recap",
      {
        events: [
          ...learningTruthEvents(),
          { type: "server_error", errorCode: "VOICE_INTERNAL_SERIALIZATION", terminalReason: null },
        ],
      },
      "completed_recap_dominates_close",
    ],
    [
      "the recap did not survive the close",
      { visible: learningTruthVisible({ recapVisibleAfterClose: false }) },
      "completed_recap_dominates_close",
    ],
    [
      "disconnection copy dominated the recap",
      { visible: learningTruthVisible({ disconnectionCopyVisible: true }) },
      "completed_recap_dominates_close",
    ],
    // 8. The selected D-03 branch: the removed mode/goal UI is absent.
    [
      "a mode/goal command surface came back",
      { visible: learningTruthVisible({ modeGoalCommandVisible: true }) },
      "d03_mode_goal_bound_or_removed_ui_absent",
    ],
    [
      "mode suggestion chips came back",
      { visible: learningTruthVisible({ modeSuggestionChipsVisible: true }) },
      "d03_mode_goal_bound_or_removed_ui_absent",
    ],
    [
      "the one honest affordance is gone",
      { visible: learningTruthVisible({ honestBeginActionVisible: false }) },
      "d03_mode_goal_bound_or_removed_ui_absent",
    ],
  ];

  for (const [label, override, expectedCheck] of cases) {
    const summary = summarizeLearningTruth({
      required: true,
      events: override.events ?? learningTruthEvents(),
      visible: override.visible ?? learningTruthVisible(),
    });
    assert.equal(summary.passed, false, `${label} must fail the required learning-truth gate`);
    const failed = summary.checks.find((check) => check.id === expectedCheck);
    assert.equal(failed?.passed, false, `${label} must fail exactly ${expectedCheck}`);
    assert.ok(
      summary.failures.some((failure) => failure.startsWith(`${expectedCheck}:`)),
      `${label} must name ${expectedCheck}: ${summary.failures.join(" | ")}`,
    );
  }
});

test("the learning-truth summary retains no prompt, transcript, answer, or recap prose", () => {
  // The reducer only ever sees what `recordServerFramePayload` chose to keep,
  // and this proves the choice: hostile free text placed on every v5 event that
  // carries some reaches neither the sanitized record nor the summary.
  const sentinel = "student-spoken-answer-sentinel-8813";
  const events = [];
  for (const payload of [
    {
      type: "event",
      version: 5,
      event: {
        type: "question_started",
        turn_id: "turn-1",
        response_id: "resp-1",
        question: {
          question_id: "question-nadh-1",
          concept_id: "nadh",
          prompt: sentinel,
          expected_terms: [sentinel],
          follow_up: sentinel,
          rubric: {
            policy_version: "viva.semantic-rubric.v1",
            criteria: [
              {
                criterion_id: "crit-1",
                concept_id: "nadh",
                claim: sentinel,
                source_id: "src-lecture-5-slide-18",
                required: true,
              },
            ],
          },
          source: {
            source_id: "src-lecture-5-slide-18",
            document_id: "lec-5",
            span: "slide:18",
            excerpt: sentinel,
            confidence: "high",
            retrieval_reason: sentinel,
          },
        },
      },
    },
    {
      type: "event",
      version: 5,
      event: {
        type: "answer_evaluated",
        response_id: "resp-1",
        evaluation: {
          question_id: "question-nadh-1",
          answer_text: sentinel,
          label: "mostly correct",
          concise_feedback: sentinel,
          retry_prompt: sentinel,
          source: {
            source_id: "src-lecture-5-slide-18",
            document_id: "lec-5",
            span: "slide:18",
            excerpt: sentinel,
            confidence: "high",
            retrieval_reason: sentinel,
          },
          concept_status: "shaky",
          confidence_score: 0.6,
        },
      },
    },
  ]) {
    recordServerFramePayload(JSON.stringify(payload), events);
  }

  assert.equal(events.length, 2, JSON.stringify(events));
  assert.equal(events[0].questionId, "question-nadh-1");
  assert.equal(events[0].conceptId, "nadh");
  assert.equal(events[1].evaluationLabel, "mostly correct");
  assert.equal(events[1].conceptStatus, "shaky");
  assert.equal(JSON.stringify(events).includes(sentinel), false);

  const summary = summarizeLearningTruth({
    required: true,
    events,
    visible: learningTruthVisible(),
  });
  assert.equal(JSON.stringify(summary).includes(sentinel), false);
});
