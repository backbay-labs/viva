/**
 * Browser entry for the streamed-audio end-to-end proof.
 *
 * Everything in this file runs inside a real Chromium page, talks to the real
 * local Rust `agent-service` over a browser-native `WebSocket`, and is bundled
 * by `scripts/e2e-browser-audio.mjs` immediately before the run.
 *
 * The only handwritten protocol frame in this file is the oversized
 * single-chunk negative control: it exists to prove that a whole microphone
 * turn packed into one otherwise well-shaped v5 `audio_chunk` is still rejected
 * by the unchanged 64 KiB text-frame cap. The positive path never builds a
 * frame by hand — chunk bytes come from the production capture module
 * (`createBrowserVivaAudioCaptureSource` + `startVivaPcm16StreamingCapture`)
 * and every frame, queue decision, and send result comes from the production
 * session controller (`createVivaAgentSessionController`). What is written here
 * is only the orchestration a session page would otherwise perform: open a
 * turn, count captured samples, and submit at the target.
 */
import {
  agentProtocolVersion,
  createVivaAgentSessionController,
  isVivaAudioSendRejectedError,
  type VivaAudioSendResult,
} from "../../apps/web/lib/viva-agent-client";
import {
  createBrowserVivaAudioCaptureSource,
  pcm16LeBytesToBase64,
  startVivaPcm16StreamingCapture,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
} from "../../apps/web/lib/viva-audio-capture";

type HarnessSessionConfig = Parameters<typeof createVivaAgentSessionController>[0]["session"];

type HarnessConfig = {
  case: string;
  wsUrl: string;
  session: HarnessSessionConfig;
  negativeControlSeconds: number;
  streamedTurnSeconds: number[];
  stepTimeoutMs: number;
};

type HarnessOutcome =
  | { status: "pending" }
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; error: string };

type ServerFrameRecord = {
  type: string;
  message?: string;
};

type OversizedNegativeControlResult = {
  case: "oversized_single_chunk";
  chunk_seconds: number;
  chunk_sample_rate_hz: number;
  chunk_raw_bytes: number;
  chunk_frame_json_bytes: number;
  protocol_version: number;
  server_frame_types: string[];
  server_error_message: string | null;
  server_error_echoes_payload: boolean;
  audio_turn_accepted: boolean;
  close_code: number | null;
  close_reason: string;
  close_was_clean: boolean;
  socket_error_observed: boolean;
  timed_out: boolean;
};

type StreamedTurnResult = {
  seconds: number;
  turn_id: string;
  target_samples: number;
  expected_raw_bytes: number;
  chunks_sent: number;
  final_sequence: number;
  min_chunk_raw_bytes: number;
  max_chunk_raw_bytes: number;
  chunk_send_statuses: Record<string, number>;
  end_result_status: string | null;
  acceptances: number;
  accepted_turn_id: string | null;
  accepted_final_sequence: number | null;
  transcripts: string[];
  evaluations: number;
  question_starts: number;
  phase_after_turn: string;
  pending_submission_after_turn: boolean;
  socket_status_after_turn: string;
  capture_active_after_turn: boolean;
};

type StreamedTurnsResult = {
  case: "streamed_turns";
  protocol_version: number;
  capture_target_sample_rate_hz: number;
  capture_source_sample_rate_hz: number;
  turns: StreamedTurnResult[];
  socket_status_after_all: string;
  socket_open_after_all: boolean;
  capture_active_after_all: boolean;
  controller_errors: string[];
  stale_events: number;
  distinct_turn_ids: number;
};

type ActiveHarnessTurn = {
  turnId: string;
  targetSamples: number;
  nextSequence: number;
  capturedSamples: number;
  minChunkBytes: number;
  maxChunkBytes: number;
  statuses: Record<string, number>;
  ended: boolean;
  endResult: VivaAudioSendResult | null;
  error: string | null;
};

declare global {
  interface Window {
    __vivaAudioHarnessConfig?: HarnessConfig;
    __vivaAudioHarnessOutcome?: HarnessOutcome;
  }
}

const PCM16_BYTES_PER_SAMPLE = 2;
const POLL_INTERVAL_MS = 25;

function describeError(error: unknown): string {
  if (isVivaAudioSendRejectedError(error)) {
    return `${error.error.code}: ${error.error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function deterministicPcm16(sampleCount: number): Uint8Array {
  const bytes = new Uint8Array(sampleCount * PCM16_BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    // A deterministic non-silent ramp: a run of zero bytes would compress into a
    // base64 payload whose rejection proves nothing about real captured audio.
    const value = ((index % 512) - 256) * 64;
    view.setInt16(index * PCM16_BYTES_PER_SAMPLE, value, true);
  }
  return bytes;
}

/**
 * Negative control: one whole 2-second turn inside a single well-shaped v5
 * `audio_chunk` JSON frame. The frame is valid in every way except size, so the
 * only thing that can reject it is the unchanged text-frame/chunk cap. The
 * control passes only when that rejection is positively observed — a timeout or
 * a generic connection failure fails it.
 */
function runOversizedSingleChunkNegativeControl(
  config: HarnessConfig,
): Promise<OversizedNegativeControlResult> {
  const protocolVersion = agentProtocolVersion();
  const sampleCount = config.negativeControlSeconds * VIVA_AUDIO_SAMPLE_RATE_HZ;
  const pcm16Bytes = deterministicPcm16(sampleCount);
  const pcm16Base64 = pcm16LeBytesToBase64(pcm16Bytes);
  const oversizedChunkFrame = {
    client_generation_id: "oversized-single-chunk-control",
    frame: { pcm16_base64: pcm16Base64 },
    sequence: 0,
    turn_id: "turn-oversized-single-chunk-control",
    type: "audio_chunk",
    version: protocolVersion,
  };
  const oversizedChunkJson = JSON.stringify(oversizedChunkFrame);
  const payloadFingerprint = pcm16Base64.slice(0, 16);

  return new Promise<OversizedNegativeControlResult>((resolve, reject) => {
    const socket = new WebSocket(config.wsUrl, ["viva-voice"]);
    const serverFrames: ServerFrameRecord[] = [];
    let serverErrorMessage: string | null = null;
    let audioTurnAccepted = false;
    let socketErrorObserved = false;
    let sentSessionConfig = false;
    let sentOversizedChunk = false;
    let settled = false;

    const timeout = window.setTimeout(() => {
      finish({ closeCode: null, closeReason: "", closeWasClean: false, timedOut: true });
      try {
        socket.close();
      } catch {
        // The socket is already gone; the timed-out result is what matters.
      }
    }, config.stepTimeoutMs);

    function finish(input: {
      timedOut: boolean;
      closeCode: number | null;
      closeReason: string;
      closeWasClean: boolean;
    }) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve({
        audio_turn_accepted: audioTurnAccepted,
        case: "oversized_single_chunk",
        chunk_frame_json_bytes: new TextEncoder().encode(oversizedChunkJson).byteLength,
        chunk_raw_bytes: pcm16Bytes.byteLength,
        chunk_sample_rate_hz: VIVA_AUDIO_SAMPLE_RATE_HZ,
        chunk_seconds: config.negativeControlSeconds,
        close_code: input.closeCode,
        close_reason: input.closeReason,
        close_was_clean: input.closeWasClean,
        protocol_version: protocolVersion,
        server_error_echoes_payload:
          serverErrorMessage !== null &&
          (serverErrorMessage.includes(payloadFingerprint) || serverErrorMessage.includes("pcm16")),
        server_error_message: serverErrorMessage,
        server_frame_types: serverFrames.map((frame) => frame.type),
        socket_error_observed: socketErrorObserved,
        timed_out: input.timedOut,
      });
    }

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let frame: { type?: unknown; message?: unknown; event?: { type?: unknown } };
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const type = typeof frame.type === "string" ? frame.type : "unknown";
      serverFrames.push({
        message: typeof frame.message === "string" ? frame.message : undefined,
        type,
      });
      if (type === "error" && typeof frame.message === "string") {
        serverErrorMessage = frame.message;
      }
      if (type === "audio_turn_accepted") {
        audioTurnAccepted = true;
      }
      if (type === "ready" && !sentSessionConfig) {
        sentSessionConfig = true;
        socket.send(
          JSON.stringify({
            session: config.session,
            type: "session_config",
            version: protocolVersion,
          }),
        );
        return;
      }
      const eventType =
        type === "event" && frame.event && typeof frame.event.type === "string"
          ? frame.event.type
          : null;
      if (eventType === "question_started" && !sentOversizedChunk) {
        sentOversizedChunk = true;
        socket.send(oversizedChunkJson);
      }
    });

    socket.addEventListener("error", () => {
      socketErrorObserved = true;
    });

    socket.addEventListener("close", (event) => {
      finish({
        closeCode: event.code,
        closeReason: event.reason,
        closeWasClean: event.wasClean,
        timedOut: false,
      });
    });

    socket.addEventListener("open", () => {
      // The server greets with `ready` first; if it ever stops doing so the
      // timeout above fails the control rather than silently passing.
      if (socket.readyState !== WebSocket.OPEN) reject(new Error("socket did not open"));
    });
  });
}

/**
 * Positive proof: three production-shaped microphone turns over one real
 * browser WebSocket. The microphone is opened once for the whole run — a turn
 * boundary is not a capture-lifecycle boundary — and each turn ends with exactly
 * one `audio_end` at its target sample count.
 */
async function runStreamedTurns(config: HarnessConfig): Promise<StreamedTurnsResult> {
  const controller = createVivaAgentSessionController({
    session: config.session,
    sessionToken: null,
    url: config.wsUrl,
  });

  const acceptances: { turn_id: string; final_sequence: number }[] = [];
  const finalTranscripts: string[] = [];
  const controllerErrors: string[] = [];
  let evaluations = 0;
  let questionStarts = 0;
  let state = controller.getState();

  controller.subscribe((next) => {
    const previous = state;
    state = next;
    if (next.acceptedAudioTurn && next.acceptedAudioTurn !== previous.acceptedAudioTurn) {
      acceptances.push({
        final_sequence: next.acceptedAudioTurn.finalSequence,
        turn_id: next.acceptedAudioTurn.turnId,
      });
    }
    if (next.finalTranscript && next.finalTranscript !== previous.finalTranscript) {
      finalTranscripts.push(next.finalTranscript);
    }
    if (next.evaluation && next.evaluation !== previous.evaluation) evaluations += 1;
    if (next.activeResponseId && next.activeResponseId !== previous.activeResponseId) {
      questionStarts += 1;
    }
    if (next.errors.length > previous.errors.length) {
      controllerErrors.push(...next.errors.slice(previous.errors.length));
    }
  });

  /**
   * A protocol rejection must surface as a protocol rejection. The controller
   * keeps a rejected turn retained and retryable, so without this guard a server
   * close would only show up as a wait timeout minutes later and would read like
   * a flaky harness instead of the contract violation it is.
   */
  function assertSessionHealthy(context: string) {
    if (controllerErrors.length > 0) {
      throw new Error(`${context}: session reported ${controllerErrors.join(" | ")}`);
    }
    if (state.status !== "open") {
      const close = state.close ? ` (close ${state.close.code} ${state.close.reason})` : "";
      throw new Error(`${context}: session status became ${state.status}${close}`);
    }
  }

  controller.connect();
  await waitUntil(
    () => state.status === "open" && Boolean(state.question),
    config.stepTimeoutMs,
    "an open session with a started question",
  );

  let activeTurn: ActiveHarnessTurn | null = null;
  let captureError: string | null = null;
  let captureEndReason: string | null = null;

  function onCaptureFrame(frame: { pcm16Bytes: Uint8Array }) {
    const turn = activeTurn;
    // Between turns the page is awaiting acceptance, so a capture callback is
    // dropped rather than opening a second input turn.
    if (!turn || turn.ended || turn.error !== null) return;
    const byteLength = frame.pcm16Bytes.byteLength;
    if (byteLength === 0 || byteLength % 2 !== 0) return;
    const samples = byteLength / PCM16_BYTES_PER_SAMPLE;
    if (turn.capturedSamples + samples > turn.targetSamples) {
      turn.error = `capture callback of ${samples} samples overshot the ${turn.targetSamples}-sample target`;
      return;
    }
    let result: VivaAudioSendResult;
    try {
      result = controller.sendAudioChunk({
        pcm16Bytes: frame.pcm16Bytes,
        sequence: turn.nextSequence,
        turnId: turn.turnId,
      });
    } catch (error) {
      turn.error = describeError(error);
      return;
    }
    turn.statuses[result.status] = (turn.statuses[result.status] ?? 0) + 1;
    turn.minChunkBytes = Math.min(turn.minChunkBytes, byteLength);
    turn.maxChunkBytes = Math.max(turn.maxChunkBytes, byteLength);
    turn.nextSequence += 1;
    turn.capturedSamples += samples;
    if (turn.capturedSamples !== turn.targetSamples) return;
    turn.ended = true;
    try {
      turn.endResult = controller.endAudioTurn({
        finalSequence: turn.nextSequence - 1,
        turnId: turn.turnId,
      });
    } catch (error) {
      turn.error = describeError(error);
    }
  }

  const source = await createBrowserVivaAudioCaptureSource({
    AudioContextCtor: AudioContext,
    mediaDevices: navigator.mediaDevices,
  });
  const capture = startVivaPcm16StreamingCapture({
    onEnded: (reason) => {
      captureEndReason = reason;
    },
    onError: (error) => {
      captureError = describeError(error);
    },
    onFrame: onCaptureFrame,
    source,
  });

  function drainRetainedAudio() {
    try {
      controller.retryPendingAudio();
    } catch {
      // The ledger was already released by a matching `audio_turn_accepted`.
    }
  }

  const turns: StreamedTurnResult[] = [];
  try {
    for (const seconds of config.streamedTurnSeconds) {
      const targetSamples = seconds * VIVA_AUDIO_SAMPLE_RATE_HZ;
      const turn: ActiveHarnessTurn = {
        capturedSamples: 0,
        endResult: null,
        ended: false,
        error: null,
        maxChunkBytes: 0,
        minChunkBytes: Number.POSITIVE_INFINITY,
        nextSequence: 0,
        statuses: {},
        targetSamples,
        turnId: `viva-e2e-audio-turn-${seconds}s`,
      };
      const acceptanceMark = acceptances.length;
      const transcriptMark = finalTranscripts.length;
      const evaluationMark = evaluations;
      const questionMark = questionStarts;

      activeTurn = turn;
      await waitUntil(
        () => {
          assertSessionHealthy(`streaming ${turn.turnId}`);
          return turn.ended || turn.error !== null || captureError !== null;
        },
        config.stepTimeoutMs,
        `${seconds}s of captured microphone audio`,
      );
      if (captureError) throw new Error(`capture failed: ${captureError}`);
      if (turn.error) throw new Error(`turn ${turn.turnId} failed: ${turn.error}`);

      await waitUntil(
        () => {
          assertSessionHealthy(`awaiting acceptance of ${turn.turnId}`);
          drainRetainedAudio();
          return acceptances.length > acceptanceMark;
        },
        config.stepTimeoutMs,
        `audio_turn_accepted for ${turn.turnId}`,
      );
      await waitUntil(
        () => {
          assertSessionHealthy(`resolving ${turn.turnId}`);
          return (
            finalTranscripts.length > transcriptMark &&
            evaluations > evaluationMark &&
            state.phase === "correction" &&
            !state.pendingSubmission
          );
        },
        config.stepTimeoutMs,
        `transcript, evaluation, and next-question readiness for ${turn.turnId}`,
      );

      const accepted = acceptances.at(-1) ?? null;
      turns.push({
        accepted_final_sequence: accepted?.final_sequence ?? null,
        accepted_turn_id: accepted?.turn_id ?? null,
        acceptances: acceptances.length - acceptanceMark,
        capture_active_after_turn: capture.isActive(),
        chunk_send_statuses: turn.statuses,
        chunks_sent: turn.nextSequence,
        end_result_status: turn.endResult?.status ?? null,
        evaluations: evaluations - evaluationMark,
        expected_raw_bytes: targetSamples * PCM16_BYTES_PER_SAMPLE,
        final_sequence: turn.nextSequence - 1,
        max_chunk_raw_bytes: turn.maxChunkBytes,
        min_chunk_raw_bytes: turn.minChunkBytes,
        pending_submission_after_turn: Boolean(state.pendingSubmission),
        phase_after_turn: state.phase,
        question_starts: questionStarts - questionMark,
        seconds,
        socket_status_after_turn: state.status,
        target_samples: targetSamples,
        transcripts: finalTranscripts.slice(transcriptMark),
        turn_id: turn.turnId,
      });
      activeTurn = null;
    }
  } finally {
    activeTurn = null;
  }

  const result: StreamedTurnsResult = {
    capture_active_after_all: capture.isActive(),
    capture_source_sample_rate_hz: source.sampleRateHz,
    capture_target_sample_rate_hz: VIVA_AUDIO_SAMPLE_RATE_HZ,
    case: "streamed_turns",
    controller_errors: controllerErrors,
    distinct_turn_ids: new Set(turns.map((turn) => turn.turn_id)).size,
    protocol_version: agentProtocolVersion(),
    socket_open_after_all: state.status === "open",
    socket_status_after_all: state.status,
    stale_events: state.staleEvents,
    turns,
  };
  capture.stop();
  controller.close();
  if (captureEndReason !== null && captureEndReason !== "stopped") {
    throw new Error(`capture ended early: ${captureEndReason}`);
  }
  return result;
}

async function runHarnessCase(config: HarnessConfig): Promise<unknown> {
  if (config.case === "oversized-single-chunk") {
    return runOversizedSingleChunkNegativeControl(config);
  }
  if (config.case === "streamed-turns") {
    return runStreamedTurns(config);
  }
  throw new Error(`unimplemented browser audio harness case: ${config.case}`);
}

function startHarness() {
  const config = window.__vivaAudioHarnessConfig;
  if (!config) {
    window.__vivaAudioHarnessOutcome = {
      error: "browser audio harness config was not installed",
      status: "rejected",
    };
    return;
  }
  window.__vivaAudioHarnessOutcome = { status: "pending" };
  runHarnessCase(config)
    .then((value) => {
      window.__vivaAudioHarnessOutcome = { status: "fulfilled", value };
    })
    .catch((error: unknown) => {
      window.__vivaAudioHarnessOutcome = { error: describeError(error), status: "rejected" };
    });
}

document.getElementById("run")?.addEventListener("click", startHarness);
