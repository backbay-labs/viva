export const VIVA_VOICE_PROTOCOL_VERSION = 5 as const;
/** v5 is the only accepted and emitted version; v4 input is rejected, never upgraded. */
export const VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS = [VIVA_VOICE_PROTOCOL_VERSION] as const;
export const VIVA_VOICE_SAMPLE_RATE_HZ = 24_000;
export const VIVA_VOICE_CHANNELS = 1 as const;
/** `pcm_s16le` is a signed 16-bit sample, so two bytes. */
export const VIVA_VOICE_BYTES_PER_SAMPLE = 2 as const;
export const VIVA_VOICE_INPUT_ENCODING = "pcm_s16le";
export const VIVA_VOICE_MAX_TEXT_FRAME_BYTES = 64 * 1024;
/** The 45-second bound on one browser turn. */
export const VIVA_VOICE_MAX_TURN_SECONDS = 45 as const;

/** Alias of the existing 24 kHz voice constant; one literal source. */
export const VIVA_AUDIO_SAMPLE_RATE_HZ = VIVA_VOICE_SAMPLE_RATE_HZ;
export const VIVA_AUDIO_MAX_CHUNK_SAMPLES = 4_096 as const;
export const VIVA_AUDIO_MAX_CHUNK_BYTES = 8_192 as const;
/**
 * `VOICE-SIZE-002`: the maximum chunk in canonical RFC 4648 base64 *with* padding.
 * This is a derived ceiling, never a second size authority.
 */
export const VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS = 10_924 as const;
export const VIVA_AUDIO_MAX_TURN_SAMPLES = 1_080_000 as const;
export const VIVA_AUDIO_MAX_TURN_BYTES = 2_160_000 as const;

/** The wire spelling of the signed credential, written once in this module. */
const SESSION_CREDENTIAL_KEY = "session_token";

/**
 * VOICE-DIAGNOSTIC-001: the closed, stable diagnostic vocabulary shared with the Rust
 * contract. A diagnostic carries a code and a JSON path and never the rejected value.
 */
export const VIVA_VOICE_DIAGNOSTIC_CODES = [
  "VOICE_PROTOCOL_UNSUPPORTED_VERSION",
  "VOICE_PROTOCOL_MALFORMED_JSON",
  "VOICE_PROTOCOL_INVALID_ENVELOPE",
  "VOICE_PROTOCOL_UNKNOWN_FRAME",
  "VOICE_PROTOCOL_UNKNOWN_FIELD",
  "VOICE_PROTOCOL_MISSING_FIELD",
  "VOICE_PROTOCOL_INVALID_FIELD",
  "VOICE_PROTOCOL_NONCANONICAL_BASE64URL",
  "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",
  "VOICE_PROTOCOL_FRAME_TOO_LARGE",
  "VOICE_PROTOCOL_AUDIO_SEQUENCE",
  "VOICE_PROTOCOL_TURN_TOO_LARGE",
  "VOICE_PROTOCOL_INVARIANT",
] as const;

export type VivaVoiceDiagnosticCode = (typeof VIVA_VOICE_DIAGNOSTIC_CODES)[number];

export class VivaVoiceProtocolError extends Error {
  readonly code: VivaVoiceDiagnosticCode;
  readonly path: string;

  constructor(code: VivaVoiceDiagnosticCode, path: string, message: string) {
    super(message);
    this.name = "VivaVoiceProtocolError";
    this.code = code;
    this.path = path;
  }
}

export type VivaVoiceProtocolAdvertisement = {
  preferred_version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  supported_versions: readonly [typeof VIVA_VOICE_PROTOCOL_VERSION];
};

export const VIVA_VOICE_PROTOCOL_ADVERTISEMENT: VivaVoiceProtocolAdvertisement = {
  preferred_version: VIVA_VOICE_PROTOCOL_VERSION,
  supported_versions: VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS,
};

/**
 * Negotiation selects the greatest shared version. This release supports only v5, so a
 * peer list without v5 has no overlap and fails closed instead of downgrading to v4.
 */
export function negotiateVivaVoiceProtocolVersion(
  localSupportedVersions: readonly number[],
  peerSupportedVersions: readonly number[],
): typeof VIVA_VOICE_PROTOCOL_VERSION {
  const shared = localSupportedVersions.filter((version) =>
    peerSupportedVersions.includes(version),
  );
  const selected = shared.length === 0 ? undefined : Math.max(...shared);
  if (selected !== VIVA_VOICE_PROTOCOL_VERSION) {
    throw new VivaVoiceProtocolError(
      "VOICE_PROTOCOL_UNSUPPORTED_VERSION",
      "$.protocol.supported_versions",
      "Unsupported Viva voice protocol version",
    );
  }
  return VIVA_VOICE_PROTOCOL_VERSION;
}

/**
 * One oral-exam engine, one mode. `teach` / `mock` / `cram` named engines that were
 * never built, and the merged domain (`agent_domain::StudyMode`, recorded decision
 * `D-03B`) now accepts only `quiz`; a wider wire vocabulary would let a forged or stale
 * value parse into a mode the server cannot honour.
 */
export type AgentStudyMode = "quiz";
export type AgentConceptStatus = "strong" | "shaky" | "missed" | "review";
export type AgentSourceConfidence = "high" | "medium" | "low";

export type AgentSourceContext = {
  source_id: string;
  document_id: string;
  span: string;
  excerpt: string;
  confidence: AgentSourceConfidence;
  retrieval_reason: string;
};

/**
 * The v5 admission session. The client-declared session goal is gone (recorded decision
 * `D-03B`, mirrored by the merged `agent_domain::SessionConfig`): it was free text no
 * policy read. Session scope comes from the bound `study_set_id` and `active_concepts`.
 */
export type AgentSessionConfig = {
  session_id: string;
  user_id: string;
  study_set_id: string;
  mode?: AgentStudyMode;
  source_context: AgentSourceContext[];
  active_concepts: string[];
};

/**
 * `VOICE-REFRESH-001`: the only in-socket refresh payload. It is deliberately neutral on
 * Plan 04's D-03 decision — parsing one does not authorize or apply it, and it can never
 * carry a credential or an identity.
 */
export type AgentSessionRefreshContext = {
  mode?: AgentStudyMode;
  initial_goal?: string;
};

export type AgentAudioFrame = {
  pcm16_base64: string;
};

export type AgentStudySessionPhase =
  | "ready"
  | "listening"
  | "thinking"
  | "feedback"
  | "correction"
  | "recap";

export const VIVA_AGENT_TERMINAL_SESSION_REASONS = [
  "drained",
  "session_cap",
  "turn_cap",
  "rate_limit",
  "cost_budget",
  "provider_auth_failed",
  "provider_rate_limited",
  "provider_timeout",
  "provider_malformed_stream",
  "provider_network_disconnect",
  "slow_client",
  "provider_cancelled",
  "partial_stage_success",
  "durability_degraded",
  "tool_executor_failure",
  "rollback",
] as const;

export type AgentTerminalSessionReason = (typeof VIVA_AGENT_TERMINAL_SESSION_REASONS)[number];

export type AgentStudySourceReference = {
  source_id: string;
  document_id: string;
  span: string;
  excerpt: string;
  confidence: AgentSourceConfidence;
  retrieval_reason: string;
};

export type AgentStudyQuestion = {
  question_id: string;
  prompt: string;
  expected_terms: string[];
  follow_up: string;
  source: AgentStudySourceReference;
};

export type AgentAnswerEvaluation = {
  question_id: string;
  answer_text: string;
  label: AgentEvaluationLabel;
  concise_feedback: string;
  retry_prompt: string;
  source: AgentStudySourceReference;
  concept_status: AgentConceptStatus;
  confidence_score: number;
};

export type AgentEvaluationLabel =
  | "strong"
  | "mostly correct"
  | "partially correct"
  | "vague"
  | "wrong"
  | "off-topic"
  | "insufficient evidence";

export type AgentRecapSourceMoment = {
  text: string;
  source: AgentStudySourceReference;
  status: AgentConceptStatus;
};

export type AgentStudySessionRecap = {
  voice_session_id: string;
  headline: string;
  summary: string;
  strong_concepts: string[];
  shaky_concepts: string[];
  missed_concepts: string[];
  review_later: string[];
  next_action: string;
  source_moments: AgentRecapSourceMoment[];
};

export type ManuscriptRegister =
  | "examining"
  | "reflecting"
  | "correcting"
  | "sourcing"
  | "recapping";
export type ManuscriptEmphasis = "quiet" | "measured" | "marked";
export type ManuscriptEntityKind = "concept" | "source" | "marginal_note";

export type ManuscriptIntent =
  | {
      type: "scene_intent";
      register: ManuscriptRegister;
      emphasis: ManuscriptEmphasis;
    }
  | {
      type: "entity_intent";
      entity_id: string;
      entity_kind: ManuscriptEntityKind;
      register: ManuscriptRegister;
      emphasis: ManuscriptEmphasis;
    }
  | {
      type: "marginalia_intent";
      marginalia_id: string;
      anchor_entity_id: string;
      register: ManuscriptRegister;
      emphasis: ManuscriptEmphasis;
    };

export type AgentAudioChunkFrame = {
  type: "audio_chunk";
  version: 5;
  client_generation_id: string;
  turn_id: string;
  sequence: number;
  frame: { pcm16_base64: string };
};

export type AgentAudioEndFrame = {
  type: "audio_end";
  version: 5;
  client_generation_id: string;
  turn_id: string;
  final_sequence: number;
};

export type AgentAudioTurnAcceptedFrame = {
  type: "audio_turn_accepted";
  version: 5;
  client_generation_id: string;
  turn_id: string;
  final_sequence: number;
};

/**
 * `VOICE-AUTH-001`: the canonical first application frame. The signed credential is a
 * required top-level field; a nested one is a forbidden authority.
 */
export type VivaSessionConfigClientFrame = {
  type: "session_config";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  client_generation_id: string;
  session_token: string;
  session: AgentSessionConfig;
};

export type VivaSessionRefreshClientFrame = {
  type: "session_refresh";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  client_generation_id: string;
  context: AgentSessionRefreshContext;
};

/**
 * `VOICE-TURN-001`: there is no v5 plain text frame and no magic citation payload. A
 * citation challenge is not an answer and can never be graded as one.
 */
export type VivaClientTurnIntent =
  | { kind: "answer_text"; text: string }
  | { kind: "citation_challenge"; response_id: string; source_id: string };

export type VivaTurnIntentClientFrame = {
  type: "turn_intent";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  client_generation_id: string;
  turn_id: string;
  intent: VivaClientTurnIntent;
};

/**
 * With `turn_id`, cancel is scoped to that active audio/provider turn; without it, it
 * cancels the current generation's provider response. It can never reach another
 * generation.
 */
export type VivaCancelClientFrame = {
  type: "cancel";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  client_generation_id: string;
  turn_id?: string;
};

export type VivaStopClientFrame = {
  type: "stop";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  client_generation_id: string;
};

/** `VOICE-AUTHORITY-001`: the exact browser-sendable vocabulary, in wire order. */
export const VIVA_BROWSER_CLIENT_FRAME_TYPES = [
  "session_config",
  "session_refresh",
  "audio_chunk",
  "audio_end",
  "turn_intent",
  "cancel",
  "stop",
] as const;

export type VivaBrowserClientFrameType = (typeof VIVA_BROWSER_CLIENT_FRAME_TYPES)[number];

/**
 * The sole browser-sendable v5 union. A tool result is never a member: the browser has
 * no tool authority, so a forged one is rejected at `$.type` before it can be sent.
 */
export type VivaBrowserClientFrame =
  | VivaSessionConfigClientFrame
  | VivaSessionRefreshClientFrame
  | AgentAudioChunkFrame
  | AgentAudioEndFrame
  | VivaTurnIntentClientFrame
  | VivaCancelClientFrame
  | VivaStopClientFrame;

/** Temporary migration alias for `VivaBrowserClientFrame`, never a wider union. */
export type VivaClientFrame = VivaBrowserClientFrame;

export type VivaReadyFrame = {
  type: "ready";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  protocol: VivaVoiceProtocolAdvertisement;
  sample_rate_hz: typeof VIVA_VOICE_SAMPLE_RATE_HZ;
  input_encoding: typeof VIVA_VOICE_INPUT_ENCODING;
  brain: AgentBrainReadiness;
  store: AgentStoreReadiness;
};

export type AgentBrainReadiness = {
  provider: string;
  configured: boolean;
  selectable: boolean;
  live_runtime: boolean;
};

export type AgentStoreReadiness = {
  backend: string;
  available: boolean;
  durable: boolean;
  nonce_replay_protection: boolean;
  raw_audio_persistence: boolean;
  transcript_persistence: boolean;
  uuid_schema_translation: boolean;
};

export type VivaServerEvent =
  | {
      type: "session_phase";
      phase: AgentStudySessionPhase;
      terminal_reason?: AgentTerminalSessionReason;
    }
  | { type: "question_started"; response_id: string; question: AgentStudyQuestion }
  | { type: "transcript_delta"; response_id: string; text: string }
  | {
      type: "transcript_final";
      response_id: string;
      text: string;
      confidence?: number | null;
    }
  | { type: "answer_evaluated"; response_id: string; evaluation: AgentAnswerEvaluation }
  | { type: "source_reference"; response_id: string; source: AgentStudySourceReference }
  | {
      type: "concept_status";
      response_id: string;
      concept_id: string;
      status: AgentConceptStatus;
    }
  | { type: "manuscript_intent"; response_id: string; intent: ManuscriptIntent }
  | {
      type: "recap_ready";
      response_id: string;
      recap: AgentStudySessionRecap;
      partial_reason?: AgentTerminalSessionReason;
    }
  | { type: "audio_delta"; response_id: string; frame: AgentAudioFrame }
  | { type: "cancellation"; response_id?: string | null }
  | { type: "structured_error"; source: string; message: string };

export type VivaServerFrame =
  | VivaReadyFrame
  | AgentAudioTurnAcceptedFrame
  | { type: "event"; version: typeof VIVA_VOICE_PROTOCOL_VERSION; event: VivaServerEvent }
  | { type: "error"; version: typeof VIVA_VOICE_PROTOCOL_VERSION; message: string };

export function audioChunkClientFrame(
  input: Readonly<{
    clientGenerationId: string;
    turnId: string;
    sequence: number;
    pcm16Base64: string;
  }>,
): AgentAudioChunkFrame {
  return {
    type: "audio_chunk",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    client_generation_id: input.clientGenerationId,
    turn_id: input.turnId,
    sequence: input.sequence,
    frame: { pcm16_base64: input.pcm16Base64 },
  };
}

export function audioEndClientFrame(
  input: Readonly<{ clientGenerationId: string; turnId: string; finalSequence: number }>,
): AgentAudioEndFrame {
  return {
    type: "audio_end",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    client_generation_id: input.clientGenerationId,
    turn_id: input.turnId,
    final_sequence: input.finalSequence,
  };
}

/**
 * Builds the canonical `VOICE-AUTH-001` first frame. The signed credential and the
 * client generation are both required: an unauthenticated or generation-less first
 * frame is not representable.
 */
export function sessionConfigFrame(
  session: AgentSessionConfig,
  signedCredential: string,
  clientGenerationId: string,
): VivaSessionConfigClientFrame {
  return {
    type: "session_config",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    client_generation_id: clientGenerationId,
    session_token: signedCredential,
    session,
  };
}

export function parseVivaServerFrame(value: unknown): VivaServerFrame {
  const frame = requireRecord(value, "server frame");
  const type = frame.type;
  if (frame.version !== VIVA_VOICE_PROTOCOL_VERSION) {
    throw unsupportedVersion();
  }

  if (type === "ready") {
    if (frame.sample_rate_hz !== VIVA_VOICE_SAMPLE_RATE_HZ) {
      throw new Error("Unexpected Viva voice sample rate");
    }
    if (frame.input_encoding !== VIVA_VOICE_INPUT_ENCODING) {
      throw new Error("Unexpected Viva voice input encoding");
    }
    return {
      type: "ready",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      protocol: parseVivaVoiceProtocolAdvertisement(frame.protocol),
      sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
      input_encoding: VIVA_VOICE_INPUT_ENCODING,
      brain: parseBrainReadiness(frame.brain),
      store: parseStoreReadiness(frame.store),
    };
  }

  if (type === "audio_turn_accepted") {
    requireNonEmptyString(frame.client_generation_id, "client_generation_id");
    requireNonEmptyString(frame.turn_id, "turn_id");
    requireSequenceNumber(frame.final_sequence, "final_sequence");
    return frame as VivaServerFrame;
  }

  if (type === "event") {
    return {
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: parseVivaServerEvent(frame.event),
    };
  }

  if (type === "error" && typeof frame.message === "string") {
    return frame as VivaServerFrame;
  }

  throw new Error("Unknown Viva voice server frame");
}

export function parseVivaServerEvent(value: unknown): VivaServerEvent {
  const event = requireRecord(value, "server event");
  switch (event.type) {
    case "session_phase":
      requireStudyPhase(event.phase);
      if ("terminal_reason" in event && event.terminal_reason !== undefined) {
        requireTerminalSessionReason(event.terminal_reason);
      }
      return event as VivaServerEvent;
    case "question_started":
      requireString(event.response_id, "response_id");
      parseStudyQuestion(event.question);
      return event as VivaServerEvent;
    case "transcript_delta":
      requireString(event.response_id, "response_id");
      requireString(event.text, "text");
      return event as VivaServerEvent;
    case "transcript_final":
      requireString(event.response_id, "response_id");
      requireString(event.text, "text");
      if (
        "confidence" in event &&
        event.confidence !== null &&
        typeof event.confidence !== "number"
      ) {
        throw new Error("Invalid confidence");
      }
      return event as VivaServerEvent;
    case "answer_evaluated":
      requireString(event.response_id, "response_id");
      parseAnswerEvaluation(event.evaluation);
      return event as VivaServerEvent;
    case "source_reference":
      requireString(event.response_id, "response_id");
      parseStudySourceReference(event.source);
      return event as VivaServerEvent;
    case "concept_status":
      requireString(event.response_id, "response_id");
      requireString(event.concept_id, "concept_id");
      requireConceptStatus(event.status);
      return event as VivaServerEvent;
    case "manuscript_intent":
      return {
        type: "manuscript_intent",
        response_id: requireString(event.response_id, "response_id"),
        intent: parseManuscriptIntent(event.intent),
      };
    case "recap_ready":
      requireString(event.response_id, "response_id");
      if ("partial_reason" in event && event.partial_reason !== undefined) {
        requireTerminalSessionReason(event.partial_reason);
      }
      parseStudySessionRecap(event.recap);
      return event as VivaServerEvent;
    case "audio_delta":
      requireString(event.response_id, "response_id");
      parseAudioFrame(event.frame);
      return event as VivaServerEvent;
    case "cancellation":
      if (
        "response_id" in event &&
        event.response_id !== null &&
        typeof event.response_id !== "string"
      ) {
        throw new Error("Invalid response_id");
      }
      return event as VivaServerEvent;
    case "structured_error":
      requireString(event.source, "source");
      requireString(event.message, "message");
      return event as VivaServerEvent;
    default:
      throw new Error("Unknown Viva voice server event");
  }
}

/**
 * `VOICE-AUTHORITY-001`: returns only the browser-sendable union, never a wider
 * authority union. Every accepted frame is generation-bound and reconstructed field by
 * field, and every rejection is a code/path-only diagnostic that never echoes the input.
 */
export function parseVivaClientFrame(value: unknown): VivaBrowserClientFrame {
  const frame = requireRecord(value, "client frame");
  if (frame.version !== VIVA_VOICE_PROTOCOL_VERSION) {
    throw unsupportedVersion();
  }
  // A browser has no tool authority, so a forged tool result is forbidden rather than
  // merely unknown. The v4 plain text frame is simply not a v5 frame.
  if (frame.type === "tool_result") {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",
      "$.type",
      "Browser tool_result frames carry no authority",
    );
  }
  if (!isBrowserClientFrameType(frame.type)) {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_UNKNOWN_FRAME",
      "$.type",
      "Unknown Viva voice client frame",
    );
  }
  const clientGenerationId = requireWireId(
    frame.client_generation_id,
    "$.client_generation_id",
    "client_generation_id",
  );

  switch (frame.type) {
    case "session_config":
      return {
        type: "session_config",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        session_token: requireWireCredential(frame[SESSION_CREDENTIAL_KEY]),
        session: parseSessionConfig(frame.session),
      };
    case "session_refresh":
      return {
        type: "session_refresh",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        context: parseSessionRefreshContext(frame.context),
      };
    case "audio_chunk":
      return {
        type: "audio_chunk",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        turn_id: requireWireId(frame.turn_id, "$.turn_id", "turn_id"),
        sequence: requireSequenceNumber(frame.sequence, "sequence"),
        frame: parseAudioChunkPayload(frame.frame),
      };
    case "audio_end":
      return {
        type: "audio_end",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        turn_id: requireWireId(frame.turn_id, "$.turn_id", "turn_id"),
        final_sequence: requireSequenceNumber(frame.final_sequence, "final_sequence"),
      };
    case "turn_intent":
      return {
        type: "turn_intent",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        turn_id: requireWireId(frame.turn_id, "$.turn_id", "turn_id"),
        intent: parseClientTurnIntent(frame.intent),
      };
    case "cancel": {
      const cancel: VivaCancelClientFrame = {
        type: "cancel",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
      };
      if ("turn_id" in frame) {
        cancel.turn_id = requireWireId(frame.turn_id, "$.turn_id", "turn_id");
      }
      return cancel;
    }
    default:
      return {
        type: "stop",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
      };
  }
}

function isBrowserClientFrameType(value: unknown): value is VivaBrowserClientFrameType {
  return VIVA_BROWSER_CLIENT_FRAME_TYPES.includes(value as VivaBrowserClientFrameType);
}

/** The wire keys a `session_refresh` context may carry, and the ones it may never. */
const SESSION_REFRESH_CONTEXT_KEYS = ["mode", "initial_goal"] as const;
const SESSION_REFRESH_FORBIDDEN_KEYS = [
  SESSION_CREDENTIAL_KEY,
  "user_id",
  "study_set_id",
  "session_id",
  "source_context",
  "active_concepts",
] as const;
const MAX_INITIAL_GOAL_CODE_POINTS = 512;

/**
 * Token renewal never happens inside an open socket, so a refresh context can only move
 * non-authoritative study context. This parser stays neutral on Plan 04's D-03 branch:
 * accepting the shape is not accepting the change.
 */
function parseSessionRefreshContext(value: unknown): AgentSessionRefreshContext {
  const context = requireRecordAt(value, "$.context");
  for (const key of Object.keys(context)) {
    if (
      SESSION_REFRESH_FORBIDDEN_KEYS.includes(
        key as (typeof SESSION_REFRESH_FORBIDDEN_KEYS)[number],
      )
    ) {
      throw voiceDiagnostic(
        "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",
        `$.context.${key}`,
        "Session refresh carries no credential or identity",
      );
    }
    if (
      !SESSION_REFRESH_CONTEXT_KEYS.includes(key as (typeof SESSION_REFRESH_CONTEXT_KEYS)[number])
    ) {
      throw voiceDiagnostic(
        "VOICE_PROTOCOL_UNKNOWN_FIELD",
        `$.context.${key}`,
        "Unknown session refresh context field",
      );
    }
  }

  const refresh: AgentSessionRefreshContext = {};
  if ("mode" in context) {
    refresh.mode = requireStudyModeAt(context.mode, "$.context.mode");
  }
  if ("initial_goal" in context) {
    const goal = requireStringAt(context.initial_goal, "$.context.initial_goal");
    const trimmed = goal.trim();
    if (trimmed.length === 0 || [...goal].length > MAX_INITIAL_GOAL_CODE_POINTS) {
      throw voiceDiagnostic(
        "VOICE_PROTOCOL_INVALID_FIELD",
        "$.context.initial_goal",
        "Invalid session refresh goal",
      );
    }
    refresh.initial_goal = trimmed;
  }
  if (Object.keys(refresh).length === 0) {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_MISSING_FIELD",
      "$.context",
      "Session refresh requires at least one context field",
    );
  }
  return refresh;
}

function parseClientTurnIntent(value: unknown): VivaClientTurnIntent {
  const intent = requireRecordAt(value, "$.intent");
  if (intent.kind === "answer_text") {
    requireOnlyWireKeys(intent, ["kind", "text"], "$.intent");
    return { kind: "answer_text", text: requireStringAt(intent.text, "$.intent.text") };
  }
  if (intent.kind === "citation_challenge") {
    requireOnlyWireKeys(intent, ["kind", "response_id", "source_id"], "$.intent");
    return {
      kind: "citation_challenge",
      response_id: requireStrictWireId(intent.response_id, "$.intent.response_id"),
      source_id: requireStrictWireId(intent.source_id, "$.intent.source_id"),
    };
  }
  throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", "$.intent.kind", "Unknown turn intent");
}

/**
 * `VOICE-SIZE-002`: the wire envelope is measured in UTF-8 bytes and rejected above the
 * unchanged 64 KiB text-frame cap *before* any nested parsing, so an oversized payload
 * is never allocated into a document tree.
 */
export function parseVivaClientFrameJson(json: string): VivaClientFrame {
  return parseVivaClientFrame(parseVivaVoiceWireJson(json));
}

export function parseVivaServerFrameJson(json: string): VivaServerFrame {
  return parseVivaServerFrame(parseVivaVoiceWireJson(json));
}

function parseVivaVoiceWireJson(json: string): unknown {
  if (new TextEncoder().encode(json).length > VIVA_VOICE_MAX_TEXT_FRAME_BYTES) {
    throw new VivaVoiceProtocolError(
      "VOICE_PROTOCOL_FRAME_TOO_LARGE",
      "$",
      "Viva voice frame exceeds the maximum text frame size",
    );
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new VivaVoiceProtocolError(
      "VOICE_PROTOCOL_MALFORMED_JSON",
      "$",
      "Malformed Viva voice frame JSON",
    );
  }
}

/**
 * Sequence numbers start at 0, are contiguous, and cannot be reused. Fractional,
 * negative, and unsafe integers fail closed before any allocation.
 */
function requireSequenceNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

/** The one JSON path a rejected audio payload is ever reported at. */
const PCM16_BASE64_PATH = "$.frame.pcm16_base64";

/**
 * Decodes `frame.pcm16_base64` only long enough to enforce canonical padded base64 and
 * the raw byte bounds. The decoded bytes are dropped here; they are never stored,
 * logged, or copied into a diagnostic. The aggregate turn bound stays in Plan 03's
 * stateful assembler, which consumes the same constants.
 */
function parseAudioChunkPayload(value: unknown): AgentAudioFrame {
  const frame = requireRecord(value, "audio chunk");
  if (!("pcm16_base64" in frame)) {
    throw new VivaVoiceProtocolError(
      "VOICE_PROTOCOL_MISSING_FIELD",
      PCM16_BASE64_PATH,
      "Missing pcm16_base64",
    );
  }
  const invalidPayload = () =>
    new VivaVoiceProtocolError(
      "VOICE_PROTOCOL_INVALID_FIELD",
      PCM16_BASE64_PATH,
      "Invalid pcm16_base64",
    );
  const encoded = frame.pcm16_base64;
  if (typeof encoded !== "string") throw invalidPayload();
  const decoded = decodeCanonicalPaddedBase64(encoded);
  if (decoded === null) throw invalidPayload();
  if (decoded.length > VIVA_AUDIO_MAX_CHUNK_BYTES) {
    throw new VivaVoiceProtocolError(
      "VOICE_PROTOCOL_FRAME_TOO_LARGE",
      PCM16_BASE64_PATH,
      "Audio chunk exceeds maximum size",
    );
  }
  if (decoded.length === 0 || decoded.length % VIVA_VOICE_BYTES_PER_SAMPLE !== 0) {
    throw invalidPayload();
  }
  return { pcm16_base64: encoded };
}

/** Canonical RFC 4648 base64 with padding; the unpadded alphabet is rejected. */
const CANONICAL_PADDED_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * `pcm16_base64` is standard RFC 4648 base64 with padding. Re-encoding the decoded
 * bytes must reproduce the payload exactly, which rejects missing padding and non-zero
 * unused bits in the final group. Unpadded base64url is a `viva1` session-token
 * encoding and is never accepted here.
 */
function decodeCanonicalPaddedBase64(encoded: string): Uint8Array | null {
  if (!CANONICAL_PADDED_BASE64.test(encoded)) return null;
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return btoa(binary) === encoded ? bytes : null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function parseAudioFrame(value: unknown): AgentAudioFrame {
  const frame = requireRecord(value, "audio frame");
  requireString(frame.pcm16_base64, "pcm16_base64");
  return frame as AgentAudioFrame;
}

function parseStudySourceReference(value: unknown): AgentStudySourceReference {
  const source = requireRecord(value, "source reference");
  requireNonEmptyString(source.source_id, "source_id");
  requireNonEmptyString(source.document_id, "document_id");
  requireNonEmptyString(source.span, "span");
  requireNonEmptyString(source.excerpt, "excerpt");
  requireSourceConfidence(source.confidence);
  requireNonEmptyString(source.retrieval_reason, "retrieval_reason");
  return source as AgentStudySourceReference;
}

function parseStudyQuestion(value: unknown): AgentStudyQuestion {
  const question = requireRecord(value, "study question");
  requireNonEmptyString(question.question_id, "question_id");
  requireNonEmptyString(question.prompt, "prompt");
  requireStringArray(question.expected_terms, "expected_terms");
  requireNonEmptyString(question.follow_up, "follow_up");
  parseStudySourceReference(question.source);
  return question as AgentStudyQuestion;
}

function parseAnswerEvaluation(value: unknown): AgentAnswerEvaluation {
  const evaluation = requireRecord(value, "answer evaluation");
  requireNonEmptyString(evaluation.question_id, "question_id");
  requireString(evaluation.answer_text, "answer_text");
  requireEvaluationLabel(evaluation.label);
  requireNonEmptyString(evaluation.concise_feedback, "concise_feedback");
  requireNonEmptyString(evaluation.retry_prompt, "retry_prompt");
  parseStudySourceReference(evaluation.source);
  requireConceptStatus(evaluation.concept_status);
  if (
    typeof evaluation.confidence_score !== "number" ||
    !Number.isFinite(evaluation.confidence_score) ||
    evaluation.confidence_score < 0 ||
    evaluation.confidence_score > 1
  ) {
    throw new Error("Invalid confidence_score");
  }
  return evaluation as AgentAnswerEvaluation;
}

function parseStudySessionRecap(value: unknown): AgentStudySessionRecap {
  const recap = requireRecord(value, "session recap");
  requireString(recap.voice_session_id, "voice_session_id");
  requireString(recap.headline, "headline");
  requireString(recap.summary, "summary");
  requireStringArray(recap.strong_concepts, "strong_concepts");
  requireStringArray(recap.shaky_concepts, "shaky_concepts");
  requireStringArray(recap.missed_concepts, "missed_concepts");
  requireStringArray(recap.review_later, "review_later");
  requireString(recap.next_action, "next_action");
  const moments = requireArray(recap.source_moments, "source_moments");
  for (const moment of moments) {
    const record = requireRecord(moment, "source moment");
    requireNonEmptyString(record.text, "source moment text");
    parseStudySourceReference(record.source);
    requireConceptStatus(record.status);
  }
  return recap as AgentStudySessionRecap;
}

const SESSION_CONFIG_KEYS = [
  "session_id",
  "user_id",
  "study_set_id",
  "mode",
  "source_context",
  "active_concepts",
] as const;

function parseSessionConfig(value: unknown): AgentSessionConfig {
  const session = requireRecordAt(value, "$.session");
  if (SESSION_CREDENTIAL_KEY in session) {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",
      `$.session.${SESSION_CREDENTIAL_KEY}`,
      "The signed credential belongs at the session_config frame top level",
    );
  }
  requireOnlyWireKeys(session, [...SESSION_CONFIG_KEYS], "$.session");

  const config: AgentSessionConfig = {
    session_id: requireStrictWireId(session.session_id, "$.session.session_id"),
    user_id: requireStrictWireId(session.user_id, "$.session.user_id"),
    study_set_id: requireStrictWireId(session.study_set_id, "$.session.study_set_id"),
    source_context: requireArrayAt(session.source_context, "$.session.source_context").map(
      (source, index) => parseSourceContext(source, `$.session.source_context[${index}]`),
    ),
    active_concepts: requireArrayAt(session.active_concepts, "$.session.active_concepts").map(
      (concept, index) => requireStrictWireId(concept, `$.session.active_concepts[${index}]`),
    ),
  };
  if ("mode" in session) {
    config.mode = requireStudyModeAt(session.mode, "$.session.mode");
  }
  return orderedSessionConfig(config);
}

/** Reconstructed in wire order so a parsed frame reserializes byte for byte. */
function orderedSessionConfig(config: AgentSessionConfig): AgentSessionConfig {
  const ordered: AgentSessionConfig = {
    session_id: config.session_id,
    user_id: config.user_id,
    study_set_id: config.study_set_id,
    source_context: config.source_context,
    active_concepts: config.active_concepts,
  };
  if (config.mode === undefined) return ordered;
  return {
    session_id: config.session_id,
    user_id: config.user_id,
    study_set_id: config.study_set_id,
    mode: config.mode,
    source_context: config.source_context,
    active_concepts: config.active_concepts,
  };
}

function parseSourceContext(value: unknown, path: string): AgentSourceContext {
  const source = requireRecordAt(value, path);
  requireOnlyWireKeys(
    source,
    ["source_id", "document_id", "span", "excerpt", "confidence", "retrieval_reason"],
    path,
  );
  return {
    source_id: requireNonEmptyStringAt(source.source_id, `${path}.source_id`),
    document_id: requireNonEmptyStringAt(source.document_id, `${path}.document_id`),
    span: requireNonEmptyStringAt(source.span, `${path}.span`),
    excerpt: requireNonEmptyStringAt(source.excerpt, `${path}.excerpt`),
    confidence: requireSourceConfidenceAt(source.confidence, `${path}.confidence`),
    retrieval_reason: requireNonEmptyStringAt(source.retrieval_reason, `${path}.retrieval_reason`),
  };
}

function voiceDiagnostic(
  code: VivaVoiceDiagnosticCode,
  path: string,
  message: string,
): VivaVoiceProtocolError {
  return new VivaVoiceProtocolError(code, path, message);
}

function requireRecordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (value === undefined) {
      throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing object");
    }
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid object");
  }
  return value as Record<string, unknown>;
}

function requireArrayAt(value: unknown, path: string): unknown[] {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing array");
  }
  if (!Array.isArray(value)) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid array");
  }
  return value;
}

function requireStringAt(value: unknown, path: string): string {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing string");
  }
  if (typeof value !== "string") {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid string");
  }
  return value;
}

function requireNonEmptyStringAt(value: unknown, path: string): string {
  const text = requireStringAt(value, path);
  if (text.trim().length === 0) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Empty string");
  }
  return text;
}

/** Wire identity: present, non-blank, and bounded. */
const MAX_WIRE_ID_LENGTH = 128;

function requireWireId(value: unknown, path: string, label: string): string {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, `Missing ${label}`);
  }
  const text = requireStringAt(value, path);
  if (text.trim().length === 0 || text.length > MAX_WIRE_ID_LENGTH) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, `Invalid ${label}`);
  }
  return text;
}

/** `VOICE-TURN-001`'s id vocabulary, also used for bound session identity. */
const STRICT_WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function requireStrictWireId(value: unknown, path: string): string {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing id");
  }
  const text = requireStringAt(value, path);
  if (text.length === 0 || text.length > MAX_WIRE_ID_LENGTH || !STRICT_WIRE_ID.test(text)) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid id");
  }
  return text;
}

/**
 * The signed credential is validated for shape only. This module never verifies an HMAC
 * and never copies the value into a diagnostic; Plan 08 owns verification.
 */
function requireWireCredential(value: unknown): string {
  const path = `$.${SESSION_CREDENTIAL_KEY}`;
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing signed credential");
  }
  const text = requireStringAt(value, path);
  if (text.trim().length === 0) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid signed credential");
  }
  return text;
}

function requireOnlyWireKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw voiceDiagnostic(
        "VOICE_PROTOCOL_UNKNOWN_FIELD",
        `${path}.${key}`,
        "Unknown Viva voice field",
      );
    }
  }
}

function requireStudyModeAt(value: unknown, path: string): AgentStudyMode {
  if (value !== "quiz") {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid study mode");
  }
  return value;
}

function requireSourceConfidenceAt(value: unknown, path: string): AgentSourceConfidence {
  if (value !== "high" && value !== "medium" && value !== "low") {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid source confidence");
  }
  return value;
}

function unsupportedVersion(): VivaVoiceProtocolError {
  return new VivaVoiceProtocolError(
    "VOICE_PROTOCOL_UNSUPPORTED_VERSION",
    "$.version",
    "Unsupported Viva voice protocol version",
  );
}

/**
 * The frozen unversioned v4-era fixtures predate the advertisement and are retired once
 * every consumer migrates to `fixtures/voice-protocol/v5/` (Plan 05 Task 9 Step 6).
 * Until then they still parse through this single ready representation and receive the
 * canonical v5 advertisement; a present-but-non-v5 advertisement always fails closed.
 */
function parseVivaVoiceProtocolAdvertisement(value: unknown): VivaVoiceProtocolAdvertisement {
  if (value === undefined) {
    return {
      preferred_version: VIVA_VOICE_PROTOCOL_VERSION,
      supported_versions: VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS,
    };
  }
  const advertisement = requireRecord(value, "protocol advertisement");
  const supportedVersions = requireArray(
    advertisement.supported_versions,
    "supported_versions",
  ).map((version) => {
    if (typeof version !== "number" || !Number.isSafeInteger(version)) {
      throw new VivaVoiceProtocolError(
        "VOICE_PROTOCOL_INVALID_FIELD",
        "$.protocol.supported_versions",
        "Invalid Viva voice supported versions",
      );
    }
    return version;
  });
  const negotiated = negotiateVivaVoiceProtocolVersion(
    VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS,
    supportedVersions,
  );
  if (advertisement.preferred_version !== negotiated) {
    throw new VivaVoiceProtocolError(
      "VOICE_PROTOCOL_UNSUPPORTED_VERSION",
      "$.protocol.preferred_version",
      "Unsupported Viva voice protocol version",
    );
  }
  return {
    preferred_version: VIVA_VOICE_PROTOCOL_VERSION,
    supported_versions: VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS,
  };
}

function parseBrainReadiness(value: unknown): AgentBrainReadiness {
  const brain = requireRecord(value, "brain readiness");
  return {
    provider: requireNonEmptyString(brain.provider, "provider"),
    configured: requireBoolean(brain.configured, "configured"),
    selectable: requireBoolean(brain.selectable, "selectable"),
    live_runtime: requireBoolean(brain.live_runtime, "live_runtime"),
  };
}

function parseStoreReadiness(value: unknown): AgentStoreReadiness {
  const store = requireRecord(value, "store readiness");
  return {
    backend: requireNonEmptyString(store.backend, "store backend"),
    available: requireBoolean(store.available, "store available"),
    durable: requireBoolean(store.durable, "store durable"),
    nonce_replay_protection: requireBoolean(
      store.nonce_replay_protection,
      "store nonce replay protection",
    ),
    raw_audio_persistence: requireBoolean(store.raw_audio_persistence, "raw audio persistence"),
    transcript_persistence: requireBoolean(store.transcript_persistence, "transcript persistence"),
    uuid_schema_translation: requireBoolean(
      store.uuid_schema_translation,
      "uuid schema translation",
    ),
  };
}

function parseManuscriptIntent(value: unknown): ManuscriptIntent {
  const intent = requireRecord(value, "manuscript intent");
  switch (intent.type) {
    case "scene_intent": {
      requireOnlyKeys(intent, ["type", "register", "emphasis"]);
      return {
        type: "scene_intent",
        register: requireManuscriptRegister(intent.register),
        emphasis: requireManuscriptEmphasis(intent.emphasis),
      };
    }
    case "entity_intent": {
      requireOnlyKeys(intent, ["type", "entity_id", "entity_kind", "register", "emphasis"]);
      return {
        type: "entity_intent",
        entity_id: requireManuscriptId(intent.entity_id, "entity_id"),
        entity_kind: requireManuscriptEntityKind(intent.entity_kind),
        register: requireManuscriptRegister(intent.register),
        emphasis: requireManuscriptEmphasis(intent.emphasis),
      };
    }
    case "marginalia_intent": {
      requireOnlyKeys(intent, [
        "type",
        "marginalia_id",
        "anchor_entity_id",
        "register",
        "emphasis",
      ]);
      return {
        type: "marginalia_intent",
        marginalia_id: requireManuscriptId(intent.marginalia_id, "marginalia_id"),
        anchor_entity_id: requireManuscriptId(intent.anchor_entity_id, "anchor_entity_id"),
        register: requireManuscriptRegister(intent.register),
        emphasis: requireManuscriptEmphasis(intent.emphasis),
      };
    }
    default:
      throw new Error("Invalid manuscript intent");
  }
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error("Invalid manuscript intent");
    }
  }
}

function requireManuscriptId(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label);
  if (text.length > 96 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(text)) {
    throw new Error(`Invalid manuscript ${label}`);
  }
  return text;
}

function requireManuscriptRegister(value: unknown): ManuscriptRegister {
  if (
    value !== "examining" &&
    value !== "reflecting" &&
    value !== "correcting" &&
    value !== "sourcing" &&
    value !== "recapping"
  ) {
    throw new Error("Invalid manuscript register");
  }
  return value;
}

function requireManuscriptEmphasis(value: unknown): ManuscriptEmphasis {
  if (value !== "quiet" && value !== "measured" && value !== "marked") {
    throw new Error("Invalid manuscript emphasis");
  }
  return value;
}

function requireManuscriptEntityKind(value: unknown): ManuscriptEntityKind {
  if (value !== "concept" && value !== "source" && value !== "marginal_note") {
    throw new Error("Invalid manuscript entity kind");
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  const array = requireArray(value, label);
  for (const item of array) {
    requireString(item, label);
  }
  return array as string[];
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requireStudyPhase(value: unknown): AgentStudySessionPhase {
  if (
    value !== "ready" &&
    value !== "listening" &&
    value !== "thinking" &&
    value !== "feedback" &&
    value !== "correction" &&
    value !== "recap"
  ) {
    throw new Error("Invalid session phase");
  }
  return value;
}

function requireTerminalSessionReason(value: unknown): AgentTerminalSessionReason {
  if (!VIVA_AGENT_TERMINAL_SESSION_REASONS.includes(value as AgentTerminalSessionReason)) {
    throw new Error("Invalid terminal session reason");
  }
  return value as AgentTerminalSessionReason;
}

function requireSourceConfidence(value: unknown): AgentSourceConfidence {
  if (value !== "high" && value !== "medium" && value !== "low") {
    throw new Error("Invalid source confidence");
  }
  return value;
}

function requireConceptStatus(value: unknown): AgentConceptStatus {
  if (value !== "strong" && value !== "shaky" && value !== "missed" && value !== "review") {
    throw new Error("Invalid concept status");
  }
  return value;
}

function requireEvaluationLabel(value: unknown): AgentEvaluationLabel {
  if (
    value !== "strong" &&
    value !== "mostly correct" &&
    value !== "partially correct" &&
    value !== "vague" &&
    value !== "wrong" &&
    value !== "off-topic" &&
    value !== "insufficient evidence"
  ) {
    throw new Error("Invalid evaluation label");
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.trim().length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return text;
}
