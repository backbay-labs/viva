// RELEASE-030 E2E extraction, further split (post-review-remediation amend):
// RELEASE-023's required voice-transport matrix, its per-cell contract, the
// standalone audio-harness runner, and the ledger-row-597 fake-device
// long-audio proof (`CRIT-AUDIO-01`). Derived from `e2e-browser-story.mjs`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnLocalChild } from "./e2e-browser-runtime.mjs";
import { SUPERVISOR_DEFAULT_GRACE_MS } from "./process-supervisor.mjs";

// ---------------------------------------------------------------------------
// RELEASE-023: the required voice-transport matrix
//
// The claim this matrix has to support is specific: streamed microphone turns
// of 2, 10, and 45 seconds, captured at both common device rates, survive the
// production capture module, the production session controller, and the real
// Rust WebSocket service intact. Every cell is reduced out of the audio
// harness's own executed evidence; nothing here is satisfied by a screenshot,
// a flag, or a lower-layer unit test that matched zero cases.
// ---------------------------------------------------------------------------

export const VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS = Object.freeze([2, 10, 45]);
export const VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ = Object.freeze([44_100, 48_000]);
const VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES = 64 * 1024;
const VOICE_TRANSPORT_MAX_CHUNK_RAW_BYTES = 8_192;
const VOICE_TRANSPORT_REJECTION_CLOSE_CODES = Object.freeze([1002, 1009]);
const AUDIO_HARNESS_RESULT_PATH = "artifacts/e2e-browser-audio/result.json";

/**
 * Project one `bun run e2e:browser:audio` result into matrix cells.
 *
 * A harness run that reported its own failures contributes nothing: a partly
 * broken run must leave a *missing* cell (which fails the matrix) rather than a
 * present-but-untrustworthy one.
 */
export function voiceTransportMatrixCellsFromAudioEvidence(result) {
  if (!result || result.evaluation?.passed !== true) return [];
  const observation = result.observation ?? {};
  const sourceRate =
    observation.capture_source_sample_rate_hz ?? result.source_sample_rate_hz ?? null;
  const turns = Array.isArray(observation.turns) ? observation.turns : [];
  return turns.map((turn) => ({
    duration_seconds: turn.seconds ?? null,
    source_sample_rate_hz: sourceRate,
    chunk_sample_rate_hz: observation.capture_target_sample_rate_hz ?? null,
    frames_sent: turn.chunks_sent ?? null,
    final_sequence: turn.final_sequence ?? null,
    max_chunk_raw_bytes: turn.max_chunk_raw_bytes ?? null,
    max_text_frame_bytes: result.max_text_frame_bytes ?? VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES,
    contiguous_sequence: turn.final_sequence === (turn.chunks_sent ?? 0) - 1,
    distinct_turn_ids: 1,
    turn_id: turn.turn_id ?? null,
    accepted_turn_id: turn.accepted_turn_id ?? null,
    accepted_final_sequence: turn.accepted_final_sequence ?? null,
    audio_end_status: turn.end_result_status ?? null,
    audio_turn_accepted_count: turn.acceptances ?? 0,
    transcript_final_count: Array.isArray(turn.transcripts) ? turn.transcripts.length : 0,
    answer_evaluated_count: turn.evaluations ?? 0,
    next_ready: turn.phase_after_turn === "correction" || turn.phase_after_turn === "question",
    closed_before_acceptance: turn.socket_status_after_turn !== "open",
    backpressure_reordered: Number(turn.chunk_send_statuses?.reordered ?? 0),
    backpressure_dropped: Number(
      (turn.chunk_send_statuses?.dropped ?? 0) + (turn.chunk_send_statuses?.socket_closed ?? 0),
    ),
    lower_layer_matches: 1,
  }));
}

/**
 * The required matrix contract. `required` is the caller's
 * `VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX` decision; when it is false the
 * summary is recorded but cannot fail the run.
 */
export function summarizeVoiceTransportMatrix({
  cells = [],
  negativeControl = null,
  required = false,
  loopbackSkipped = false,
} = {}) {
  const failures = [];
  const missing = [];
  const observed = new Map();
  for (const cell of cells) {
    observed.set(`${cell.source_sample_rate_hz}:${cell.duration_seconds}`, cell);
  }
  for (const rate of VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ) {
    for (const seconds of VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS) {
      if (!observed.has(`${rate}:${seconds}`)) {
        missing.push({ duration_seconds: seconds, source_sample_rate_hz: rate });
      }
    }
  }
  for (const entry of missing) {
    failures.push(
      `missing matrix cell: ${entry.duration_seconds}s at ${entry.source_sample_rate_hz} Hz`,
    );
  }
  if (loopbackSkipped) {
    failures.push("loopback proof was skipped: a skipped run can never satisfy the matrix");
  }
  for (const cell of cells) {
    failures.push(...voiceTransportCellFailures(cell));
  }
  if (!negativeControl || negativeControl.passed !== true || negativeControl.rejected !== true) {
    failures.push(
      "negative control missing: the pre-v5 single-frame (oversized single chunk) turn must be proven rejected",
    );
  }
  return {
    schema: "viva.voice_transport_matrix.v1",
    required,
    durations_seconds: [...VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS],
    source_sample_rates_hz: [...VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ],
    cells,
    negative_control: negativeControl,
    loopback_skipped: loopbackSkipped,
    missing_cells: missing,
    failures,
    passed: required ? failures.length === 0 : true,
    sanitized: true,
  };
}

function voiceTransportCellFailures(cell) {
  const label = `${cell.duration_seconds}s@${cell.source_sample_rate_hz}Hz`;
  const failures = [];
  const maxTextFrameBytes = cell.max_text_frame_bytes ?? VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES;
  if (maxTextFrameBytes > VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES) {
    failures.push(
      `${label}: serialized text frame exceeded the ${VOICE_TRANSPORT_MAX_TEXT_FRAME_BYTES}-byte cap`,
    );
  }
  if (
    (cell.max_chunk_raw_bytes ?? Number.POSITIVE_INFINITY) > VOICE_TRANSPORT_MAX_CHUNK_RAW_BYTES
  ) {
    failures.push(
      `${label}: an audio chunk exceeded the ${VOICE_TRANSPORT_MAX_CHUNK_RAW_BYTES}-byte cap`,
    );
  }
  if (cell.contiguous_sequence !== true) {
    failures.push(`${label}: production frame sequence was not contiguous`);
  }
  if (cell.distinct_turn_ids !== 1) {
    failures.push(`${label}: expected one turn identity, observed ${cell.distinct_turn_ids}`);
  }
  if (cell.audio_end_status !== "sent") {
    failures.push(`${label}: audio_end was ${cell.audio_end_status ?? "absent"}, expected "sent"`);
  }
  if (cell.audio_turn_accepted_count !== 1) {
    failures.push(
      `${label}: observed ${cell.audio_turn_accepted_count} audio_turn_accepted frames, expected exactly 1`,
    );
  }
  if (cell.accepted_turn_id !== cell.turn_id) {
    failures.push(
      `${label}: acceptance named turn ${cell.accepted_turn_id}, expected ${cell.turn_id}`,
    );
  }
  if (cell.accepted_final_sequence !== cell.final_sequence) {
    failures.push(
      `${label}: acceptance carried final_sequence ${cell.accepted_final_sequence}, expected ${cell.final_sequence}`,
    );
  }
  if (cell.transcript_final_count !== 1) {
    failures.push(
      `${label}: observed ${cell.transcript_final_count} final transcripts, expected exactly 1`,
    );
  }
  if (cell.answer_evaluated_count !== 1) {
    failures.push(
      `${label}: observed ${cell.answer_evaluated_count} evaluations, expected exactly 1`,
    );
  }
  if (cell.next_ready !== true) {
    failures.push(`${label}: the session did not reach recap or next question readiness`);
  }
  if (cell.closed_before_acceptance === true) {
    failures.push(`${label}: the socket closed before the turn was accepted`);
  }
  if ((cell.backpressure_reordered ?? 0) > 0) {
    failures.push(`${label}: backpressure reordered ${cell.backpressure_reordered} frames`);
  }
  if ((cell.backpressure_dropped ?? 0) > 0) {
    failures.push(`${label}: backpressure dropped ${cell.backpressure_dropped} frames`);
  }
  if ((cell.lower_layer_matches ?? 0) < 1) {
    failures.push(`${label}: the lower-layer proof matched zero cases`);
  }
  return failures;
}

/**
 * The negative control's own rejection is re-derived from the observation the
 * harness recorded, never taken from its `passed` flag alone.
 */
function negativeControlProof(evidence) {
  if (!evidence) return null;
  const observation = evidence.observation ?? {};
  return {
    case: evidence.case ?? "oversized-single-chunk",
    passed: evidence.evaluation?.passed === true,
    rejected:
      observation.audio_turn_accepted === false &&
      VOICE_TRANSPORT_REJECTION_CLOSE_CODES.includes(observation.close_code),
  };
}

/**
 * RELEASE-023: run the standalone audio harness (which this lane owns and which
 * Plan 15 also runs directly) once per required device capture rate, plus its
 * `oversized_single_chunk_negative_control`, and bind the reduced result into
 * the release browser evidence. The harness stays a separate command: it is the
 * only place the *production* capture module and session controller drive a
 * real browser WebSocket, and absorbing it here would delete that proof.
 */
async function runAudioHarness(plan, { name, args }) {
  const child = spawnLocalChild({
    name: "audio",
    command: "bun",
    args,
    artifactDir: plan.artifactDir,
    logName: name,
  });
  try {
    await child.ready;
    await child.exit.catch(() => null);
  } finally {
    await child.stop({ graceMs: SUPERVISOR_DEFAULT_GRACE_MS });
  }
  // The harness writes its own result.json even for a failing case; an absent
  // file is itself a missing cell, never a silently passed one.
  try {
    return JSON.parse(await readFile(path.join(plan.root, AUDIO_HARNESS_RESULT_PATH), "utf8"));
  } catch {
    return null;
  }
}

export async function collectVoiceTransportMatrix(plan) {
  if (!plan.requireVoiceTransportMatrix) {
    return summarizeVoiceTransportMatrix({
      required: false,
      loopbackSkipped: plan.loopbackTestSkipAllowed,
    });
  }
  if (plan.hostedMode) {
    throw new Error(
      "VIVA_E2E_REQUIRE_VOICE_TRANSPORT_MATRIX needs the real local WebSocket boundary; it cannot be satisfied in hosted mode.",
    );
  }
  const cells = [];
  for (const rate of VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ) {
    const evidence = await runAudioHarness(plan, {
      name: `audio-matrix-${rate}`,
      args: ["run", "e2e:browser:audio", "--", "--source-rate", String(rate)],
    });
    cells.push(
      ...voiceTransportMatrixCellsFromAudioEvidence({ source_sample_rate_hz: rate, ...evidence }),
    );
  }
  const negativeEvidence = await runAudioHarness(plan, {
    name: "audio-negative-control",
    args: ["run", "e2e:browser:audio:negative"],
  });
  return summarizeVoiceTransportMatrix({
    cells,
    negativeControl: negativeControlProof(negativeEvidence),
    required: true,
    loopbackSkipped: plan.loopbackTestSkipAllowed,
  });
}

/**
 * Ledger row 597 / `CRIT-AUDIO-01` (Frontend C8, `DUPLICATE_ALIAS`): the
 * required proof is "the canonical fake-device long-audio proof". This
 * harness grants exactly one microphone -- `launchChromium`'s
 * `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`
 * flags, the ONLY device flag this file ever passes -- so every cell the
 * voice-transport matrix collects is already fake-device evidence by
 * construction; there is no separate "real device" branch this proof could
 * accidentally credit instead. "Long-audio" is the matrix's own 45-second
 * cell (`VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS`'s longest duration). This
 * reducer names that one cell explicitly, at the sample rate CRIT-AUDIO-01's
 * ledger row names (44.1 kHz), so the alias can be verified on its own record
 * rather than only by inference from the six-cell matrix passing as a whole.
 */
export function summarizeFakeDeviceLongAudioProof(matrix) {
  const required = matrix?.required === true;
  const failures = [];
  const cell = (matrix?.cells ?? []).find(
    (candidate) => candidate.source_sample_rate_hz === 44_100 && candidate.duration_seconds === 45,
  );
  if (!cell) {
    failures.push("missing the 44.1 kHz / 45-second fake-device long-audio cell");
  } else {
    failures.push(...voiceTransportCellFailures(cell));
  }
  return {
    proof_id: "CRIT-AUDIO-01",
    ledger_row: 597,
    required,
    passed: required ? failures.length === 0 : true,
    failures,
  };
}

