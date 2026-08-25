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

/**
 * One server-owned question. `concept_id` and `rubric` mirror the merged Plan 06
 * `agent_domain::StudyQuestion` (`LEARN-002`): the concept a question is bound to and
 * the criteria an answer is graded against are server facts carried with the question,
 * never values a provider may choose at evaluation time.
 */
export type AgentEvaluationRubricCriterion = {
  criterion_id: string;
  concept_id: string;
  claim: string;
  source_id: string;
  required: boolean;
};

export type AgentEvaluationRubric = {
  policy_version: string;
  criteria: AgentEvaluationRubricCriterion[];
};

export type AgentStudyQuestion = {
  question_id: string;
  concept_id: string;
  prompt: string;
  expected_terms: string[];
  follow_up: string;
  rubric: AgentEvaluationRubric;
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

/**
 * The recap the learner sees, mirroring the merged Plan 04/06
 * `agent_domain::learning_recap::StudySessionRecap` (`viva.study_session_recap.v2`). It
 * is folded from persisted session evidence, so it carries concept outcomes and a review
 * schedule rather than free-form concept-name lists.
 */
export type AgentReviewScheduleAuthority = "server_persisted_fsrs" | "core_fsrs_read_time";

export type AgentReviewScheduleSummary = {
  concept_id: string;
  due_at: string;
  authority: AgentReviewScheduleAuthority;
};

export type AgentRecapConceptOutcome = {
  concept_id: string;
  label: string;
  status: AgentConceptStatus;
};

export type AgentRecapSourceMoment = {
  response_id: string;
  source_id: string;
};

export type AgentStudySessionRecap = {
  schema: string;
  voice_session_id: string;
  headline: string;
  summary: string;
  concepts: AgentRecapConceptOutcome[];
  review_schedule: AgentReviewScheduleSummary[];
  next_action: string;
  source_moments: AgentRecapSourceMoment[];
  deferred_turns: number;
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

/**
 * `VOICE-TURN-002`: the complete snake_case wire mirror of Plan 04
 * `EvaluationDeferralReason`. Adapter and provider reasons are deliberately absent - only
 * a durably persisted domain outcome reaches the wire.
 */
export const VIVA_VOICE_DEFERRAL_REASONS = [
  "empty_answer",
  "transcript_uncertain",
  "evaluator_unavailable",
  "invalid_evaluator_output",
  "insufficient_semantic_evidence",
  "contradictory_evidence",
] as const;

export type VivaVoiceDeferralReason = (typeof VIVA_VOICE_DEFERRAL_REASONS)[number];

/**
 * `VOICE-TURN-002`: a typed non-mastery fact. It carries no provider message, feedback,
 * confidence, concept status, schedule, mastery, `retryable`, or `terminal_reason`, and
 * it is never intrinsically terminal. `can_retry_same_question` is the authoritative
 * retry affordance; a client must not derive retryability from the reason string.
 */
export type VivaTurnDeferredEvent = {
  type: "turn_deferred";
  turn_id: string;
  response_id: string;
  question_id: string;
  reason: VivaVoiceDeferralReason;
  can_retry_same_question: boolean;
};

/** `VOICE-TURN-001`: a question start is bound to the active wire turn. */
export type VivaQuestionStartedEvent = {
  type: "question_started";
  turn_id: string;
  response_id: string;
  question: AgentStudyQuestion;
};

/**
 * `VOICE-TERMINAL-001`: a discriminated union, not an optional field whose meaning
 * consumers guess. `partial: true` is terminal immediately; `partial: false` must not
 * include `partial_reason`.
 */
export type VivaRecapReadyEvent =
  | {
      type: "recap_ready";
      response_id: string;
      recap: AgentStudySessionRecap;
      partial: false;
    }
  | {
      type: "recap_ready";
      response_id: string;
      recap: AgentStudySessionRecap;
      partial: true;
      partial_reason: AgentTerminalSessionReason;
    };

/** `VOICE-TERMINAL-002`: the closed terminality vocabulary of a structured error. */
export const VIVA_VOICE_STRUCTURED_ERROR_TERMINALITIES = ["recoverable", "terminal"] as const;

export type VivaVoiceStructuredErrorTerminality =
  (typeof VIVA_VOICE_STRUCTURED_ERROR_TERMINALITIES)[number];

/**
 * `VOICE-TERMINAL-002`: a recoverable structured error never changes socket status or
 * submission availability; a terminal one changes terminal state immediately and always
 * states its reason. Provider failures that terminate stay terminal.
 */
export type VivaStructuredErrorEvent =
  | {
      type: "structured_error";
      source: string;
      code: string;
      message: string;
      terminality: "recoverable";
    }
  | {
      type: "structured_error";
      source: string;
      code: string;
      message: string;
      terminality: "terminal";
      terminal_reason: AgentTerminalSessionReason;
    };

export type VivaServerEvent =
  | {
      type: "session_phase";
      phase: AgentStudySessionPhase;
      terminal_reason?: AgentTerminalSessionReason;
    }
  | VivaQuestionStartedEvent
  | { type: "transcript_delta"; response_id: string; text: string }
  | {
      type: "transcript_final";
      response_id: string;
      text: string;
      confidence?: number | null;
    }
  | { type: "answer_evaluated"; response_id: string; evaluation: AgentAnswerEvaluation }
  | VivaTurnDeferredEvent
  | { type: "source_reference"; response_id: string; source: AgentStudySourceReference }
  | {
      type: "concept_status";
      response_id: string;
      concept_id: string;
      status: AgentConceptStatus;
    }
  | { type: "manuscript_intent"; response_id: string; intent: ManuscriptIntent }
  | VivaRecapReadyEvent
  | { type: "audio_delta"; response_id: string; frame: AgentAudioFrame }
  | { type: "cancellation"; response_id?: string | null }
  | VivaStructuredErrorEvent;

/**
 * The single authoritative terminality rule for a v5 server event, shared byte for byte
 * with the Rust contract: a terminal session phase, a partial recap, and a terminal
 * structured error are the only events that end a wire session. A deferred turn never is,
 * and a client must not synthesize a terminal phase from one.
 */
export function vivaServerEventTerminalReason(
  event: VivaServerEvent,
): AgentTerminalSessionReason | null {
  if (event.type === "session_phase") return event.terminal_reason ?? null;
  if (event.type === "recap_ready") return event.partial ? event.partial_reason : null;
  if (event.type === "structured_error") {
    return event.terminality === "terminal" ? event.terminal_reason : null;
  }
  return null;
}

/** `VOICE-ERROR-001`: the closed typed vocabulary a server error frame may carry. */
export const VIVA_VOICE_SERVER_ERROR_CODES = [
  "VOICE_AUTH_EXPIRED",
  "VOICE_AUTH_INVALID",
  "VOICE_AUTH_IDENTITY_MISMATCH",
  "VOICE_AUTH_REPLAYED",
  "VOICE_CLIENT_FRAME_MALFORMED",
  "VOICE_CLIENT_FRAME_TOO_LARGE",
  "VOICE_CLIENT_TURN_TOO_LARGE",
  "VOICE_CLIENT_AUTHORITY_FORBIDDEN",
  "VOICE_INTERNAL_SERIALIZATION",
] as const;

export type VivaVoiceServerErrorCode = (typeof VIVA_VOICE_SERVER_ERROR_CODES)[number];

/**
 * Retryability is a property of the code, not a value the sender may choose. The parser
 * verifies it rather than trusting the frame.
 */
const RETRYABLE_SERVER_ERROR_CODES: readonly VivaVoiceServerErrorCode[] = [
  "VOICE_AUTH_EXPIRED",
  "VOICE_INTERNAL_SERIALIZATION",
];

export type VivaServerError = {
  code: VivaVoiceServerErrorCode;
  message: string;
  retryable: boolean;
};

export type VivaErrorFrame = {
  type: "error";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  error: VivaServerError;
};

export type VivaEventFrame = {
  type: "event";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  event: VivaServerEvent;
};

export type VivaServerFrame =
  | VivaReadyFrame
  | AgentAudioTurnAcceptedFrame
  | VivaEventFrame
  | VivaErrorFrame;

/**
 * `VOICE-ERROR-001`: the owner-provided v5 serialization fallback, byte-identical to the
 * Rust `VOICE_SERIALIZATION_FALLBACK_FRAME`. Plan 08 replaces the hard-coded v1 literal
 * in `ws.rs` with the Rust constant; this is its cross-language pin.
 */
export const VIVA_VOICE_SERIALIZATION_FALLBACK_FRAME =
  '{"type":"error","version":5,"error":{"code":"VOICE_INTERNAL_SERIALIZATION","message":"Server frame serialization failed.","retryable":true}}';

/** The one clean close code a v5 session may end on. */
export const VIVA_VOICE_NORMAL_CLOSE_CODE = 1000;

const VIVA_VOICE_AUTH_ERROR_CODES = [
  "VOICE_AUTH_EXPIRED",
  "VOICE_AUTH_INVALID",
  "VOICE_AUTH_IDENTITY_MISMATCH",
  "VOICE_AUTH_REPLAYED",
] as const;

const VIVA_VOICE_PROTOCOL_ERROR_CODES = [
  "VOICE_CLIENT_FRAME_MALFORMED",
  "VOICE_CLIENT_FRAME_TOO_LARGE",
  "VOICE_CLIENT_TURN_TOO_LARGE",
  "VOICE_CLIENT_AUTHORITY_FORBIDDEN",
] as const;

/**
 * `VOICE-TERMINATION-001`: the typed close classification. The result carries no message
 * and no close-reason text, so nothing a peer wrote can reach a consumer's control flow.
 *
 * Every `terminal` outcome is `retryable: false` because the current wire session and
 * generation are finished; it never triggers same-session automatic reconnect. A
 * learner-facing action may start a new session from the typed reason, but that is not
 * this classifier's retry flag.
 */
export type VivaVoiceTermination =
  | {
      kind: "terminal";
      terminalReason: AgentTerminalSessionReason;
      retryable: false;
      closeCode: number;
    }
  | {
      kind: "auth";
      errorCode: (typeof VIVA_VOICE_AUTH_ERROR_CODES)[number];
      retryable: boolean;
      closeCode: number;
    }
  | {
      kind: "protocol";
      errorCode: (typeof VIVA_VOICE_PROTOCOL_ERROR_CODES)[number];
      retryable: false;
      closeCode: number;
    }
  | {
      kind: "service";
      errorCode: "VOICE_INTERNAL_SERIALIZATION";
      retryable: true;
      closeCode: number;
    }
  | { kind: "normal"; retryable: false; closeCode: 1000 }
  | { kind: "transport"; retryable: true; closeCode: number };

/**
 * Priority is terminal reason, then typed error category, then clean code 1000, then
 * transport. Retryability is derived from the typed code and never read off the wire, and
 * no message or close-reason string is ever inspected. Plan 10 deletes its regex
 * classification over browser/parser messages in favour of this.
 */
export function classifyVivaVoiceTermination(input: {
  error?: VivaServerError;
  terminalReason?: AgentTerminalSessionReason;
  closeCode: number;
  wasClean: boolean;
}): VivaVoiceTermination {
  if (input.terminalReason !== undefined) {
    return {
      kind: "terminal",
      terminalReason: input.terminalReason,
      retryable: false,
      closeCode: input.closeCode,
    };
  }

  const code = input.error?.code;
  if (code !== undefined) {
    if (
      VIVA_VOICE_AUTH_ERROR_CODES.includes(code as (typeof VIVA_VOICE_AUTH_ERROR_CODES)[number])
    ) {
      return {
        kind: "auth",
        errorCode: code as (typeof VIVA_VOICE_AUTH_ERROR_CODES)[number],
        retryable: code === "VOICE_AUTH_EXPIRED",
        closeCode: input.closeCode,
      };
    }
    if (
      VIVA_VOICE_PROTOCOL_ERROR_CODES.includes(
        code as (typeof VIVA_VOICE_PROTOCOL_ERROR_CODES)[number],
      )
    ) {
      return {
        kind: "protocol",
        errorCode: code as (typeof VIVA_VOICE_PROTOCOL_ERROR_CODES)[number],
        retryable: false,
        closeCode: input.closeCode,
      };
    }
    if (code === "VOICE_INTERNAL_SERIALIZATION") {
      return {
        kind: "service",
        errorCode: "VOICE_INTERNAL_SERIALIZATION",
        retryable: true,
        closeCode: input.closeCode,
      };
    }
  }

  if (input.wasClean && input.closeCode === VIVA_VOICE_NORMAL_CLOSE_CODE) {
    return { kind: "normal", retryable: false, closeCode: VIVA_VOICE_NORMAL_CLOSE_CODE };
  }

  return { kind: "transport", retryable: true, closeCode: input.closeCode };
}

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

/** `VOICE-DIAGNOSTIC-001`: the closed server frame vocabulary. */
const VIVA_SERVER_FRAME_TYPES = ["ready", "audio_turn_accepted", "event", "error"] as const;

const VIVA_SERVER_EVENT_TYPES = [
  "session_phase",
  "question_started",
  "transcript_delta",
  "transcript_final",
  "answer_evaluated",
  "turn_deferred",
  "source_reference",
  "concept_status",
  "manuscript_intent",
  "recap_ready",
  "audio_delta",
  "cancellation",
  "structured_error",
] as const;

/**
 * `VOICE-RUNTIME-001`: strict at every nested boundary, reconstructing and returning
 * only allowed fields rather than the caller's object, and throwing only redaction-safe
 * diagnostics. Self-contained pure ESM: no host access of any kind.
 */
export function parseVivaServerFrame(value: unknown): VivaServerFrame {
  const frame = requireWireEnvelope(value);
  requireWireVersion(frame);
  const type = frame.type;
  if (!VIVA_SERVER_FRAME_TYPES.includes(type as (typeof VIVA_SERVER_FRAME_TYPES)[number])) {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_UNKNOWN_FRAME",
      "$.type",
      "Unknown Viva voice server frame",
    );
  }

  if (type === "ready") {
    requireOnlyWireKeys(
      frame,
      ["type", "version", "protocol", "sample_rate_hz", "input_encoding", "brain", "store"],
      "$",
    );
    return {
      type: "ready",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      protocol: parseVivaVoiceProtocolAdvertisement(frame.protocol),
      sample_rate_hz: requireExactWireValue(
        frame.sample_rate_hz,
        VIVA_VOICE_SAMPLE_RATE_HZ,
        "$.sample_rate_hz",
      ),
      input_encoding: requireExactWireValue(
        frame.input_encoding,
        VIVA_VOICE_INPUT_ENCODING,
        "$.input_encoding",
      ),
      brain: parseBrainReadiness(frame.brain),
      store: parseStoreReadiness(frame.store),
    };
  }

  if (type === "audio_turn_accepted") {
    requireOnlyWireKeys(
      frame,
      ["type", "version", "client_generation_id", "turn_id", "final_sequence"],
      "$",
    );
    return {
      type: "audio_turn_accepted",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: requireWireId(
        frame.client_generation_id,
        "$.client_generation_id",
        "client_generation_id",
      ),
      turn_id: requireWireId(frame.turn_id, "$.turn_id", "turn_id"),
      final_sequence: requireSequenceNumberAt(frame.final_sequence, "$.final_sequence"),
    };
  }

  if (type === "event") {
    requireOnlyWireKeys(frame, ["type", "version", "event"], "$");
    return {
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: parseVivaServerEvent(frame.event, "$.event"),
    };
  }

  requireOnlyWireKeys(frame, ["type", "version", "error"], "$");
  return {
    type: "error",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    error: parseVivaServerError(frame.error),
  };
}

function parseVivaServerError(value: unknown): VivaServerError {
  const error = requireRecordAt(value, "$.error");
  requireOnlyWireKeys(error, ["code", "message", "retryable"], "$.error");
  const code = requireStringAt(error.code, "$.error.code");
  if (!VIVA_VOICE_SERVER_ERROR_CODES.includes(code as VivaVoiceServerErrorCode)) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", "$.error.code", "Unknown server error");
  }
  const message = requireNonEmptyStringAt(error.message, "$.error.message");
  const retryable = requireBooleanAt(error.retryable, "$.error.retryable");
  // Retryability is derived from the code, never trusted from the wire.
  if (retryable !== RETRYABLE_SERVER_ERROR_CODES.includes(code as VivaVoiceServerErrorCode)) {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_INVARIANT",
      "$.error.retryable",
      "Server error retryability contradicts its code",
    );
  }
  return { code: code as VivaVoiceServerErrorCode, message, retryable };
}

export function parseVivaServerEvent(value: unknown, path = "$.event"): VivaServerEvent {
  const event = requireRecordAt(value, path);
  const type = event.type;
  if (!VIVA_SERVER_EVENT_TYPES.includes(type as (typeof VIVA_SERVER_EVENT_TYPES)[number])) {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_UNKNOWN_FRAME",
      `${path}.type`,
      "Unknown Viva voice server event",
    );
  }

  switch (type) {
    case "session_phase": {
      requireOnlyWireKeys(event, ["type", "phase", "terminal_reason"], path);
      const phase = requireStudyPhaseAt(event.phase, `${path}.phase`);
      if (!("terminal_reason" in event)) return { type: "session_phase", phase };
      return {
        type: "session_phase",
        phase,
        terminal_reason: requireTerminalSessionReasonAt(
          event.terminal_reason,
          `${path}.terminal_reason`,
        ),
      };
    }
    case "question_started":
      requireOnlyWireKeys(event, ["type", "turn_id", "response_id", "question"], path);
      return {
        type: "question_started",
        turn_id: requireStrictWireId(event.turn_id, `${path}.turn_id`),
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        question: parseStudyQuestion(event.question, `${path}.question`),
      };
    case "transcript_delta":
      requireOnlyWireKeys(event, ["type", "response_id", "text"], path);
      return {
        type: "transcript_delta",
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        text: requireStringAt(event.text, `${path}.text`),
      };
    case "transcript_final":
      requireOnlyWireKeys(event, ["type", "response_id", "text", "confidence"], path);
      return {
        type: "transcript_final",
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        text: requireStringAt(event.text, `${path}.text`),
        confidence: requireProviderConfidence(event.confidence, `${path}.confidence`),
      };
    case "answer_evaluated":
      requireOnlyWireKeys(event, ["type", "response_id", "evaluation"], path);
      return {
        type: "answer_evaluated",
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        evaluation: parseAnswerEvaluation(event.evaluation, `${path}.evaluation`),
      };
    case "turn_deferred":
      requireOnlyWireKeys(
        event,
        ["type", "turn_id", "response_id", "question_id", "reason", "can_retry_same_question"],
        path,
      );
      return {
        type: "turn_deferred",
        turn_id: requireStrictWireId(event.turn_id, `${path}.turn_id`),
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        question_id: requireStrictWireId(event.question_id, `${path}.question_id`),
        reason: requireWireEnumAt(
          event.reason,
          VIVA_VOICE_DEFERRAL_REASONS,
          `${path}.reason`,
        ) as VivaVoiceDeferralReason,
        can_retry_same_question: requireBooleanAt(
          event.can_retry_same_question,
          `${path}.can_retry_same_question`,
        ),
      };
    case "source_reference":
      requireOnlyWireKeys(event, ["type", "response_id", "source"], path);
      return {
        type: "source_reference",
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        source: parseStudySourceReference(event.source, `${path}.source`),
      };
    case "concept_status":
      requireOnlyWireKeys(event, ["type", "response_id", "concept_id", "status"], path);
      return {
        type: "concept_status",
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        concept_id: requireStrictWireId(event.concept_id, `${path}.concept_id`),
        status: requireConceptStatusAt(event.status, `${path}.status`),
      };
    case "manuscript_intent":
      requireOnlyWireKeys(event, ["type", "response_id", "intent"], path);
      return {
        type: "manuscript_intent",
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        intent: parseManuscriptIntent(event.intent, `${path}.intent`),
      };
    case "recap_ready": {
      requireOnlyWireKeys(
        event,
        ["type", "response_id", "recap", "partial", "partial_reason"],
        path,
      );
      const responseId = requireStrictWireId(event.response_id, `${path}.response_id`);
      const recap = parseStudySessionRecap(event.recap, `${path}.recap`);
      // `VOICE-TERMINAL-001`: `partial` is the discriminant. `true` is terminal and must
      // state why; `false` may not carry a reason at all.
      if (!requireBooleanAt(event.partial, `${path}.partial`)) {
        if ("partial_reason" in event) {
          throw voiceDiagnostic(
            "VOICE_PROTOCOL_INVARIANT",
            `${path}.partial_reason`,
            "A complete recap cannot carry a partial reason",
          );
        }
        return { type: "recap_ready", response_id: responseId, recap, partial: false };
      }
      return {
        type: "recap_ready",
        response_id: responseId,
        recap,
        partial: true,
        partial_reason: requireTerminalSessionReasonAt(
          event.partial_reason,
          `${path}.partial_reason`,
        ),
      };
    }
    case "audio_delta":
      requireOnlyWireKeys(event, ["type", "response_id", "frame"], path);
      return {
        type: "audio_delta",
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
        frame: parseServerAudioFrame(event.frame, `${path}.frame`),
      };
    case "cancellation": {
      requireOnlyWireKeys(event, ["type", "response_id"], path);
      if (!("response_id" in event)) {
        throw voiceDiagnostic(
          "VOICE_PROTOCOL_MISSING_FIELD",
          `${path}.response_id`,
          "Missing response_id",
        );
      }
      if (event.response_id === null) return { type: "cancellation", response_id: null };
      return {
        type: "cancellation",
        response_id: requireStrictWireId(event.response_id, `${path}.response_id`),
      };
    }
    default: {
      requireOnlyWireKeys(
        event,
        ["type", "source", "code", "message", "terminality", "terminal_reason"],
        path,
      );
      const source = requireNonEmptyStringAt(event.source, `${path}.source`);
      const code = requireStrictWireId(event.code, `${path}.code`);
      const message = requireNonEmptyStringAt(event.message, `${path}.message`);
      // `VOICE-TERMINAL-002`: terminality is stated, never inferred from the message.
      const terminality = requireWireEnumAt(
        event.terminality,
        VIVA_VOICE_STRUCTURED_ERROR_TERMINALITIES,
        `${path}.terminality`,
      ) as VivaVoiceStructuredErrorTerminality;
      if (terminality === "recoverable") {
        if ("terminal_reason" in event) {
          throw voiceDiagnostic(
            "VOICE_PROTOCOL_INVARIANT",
            `${path}.terminal_reason`,
            "A recoverable structured error cannot carry a terminal reason",
          );
        }
        return { type: "structured_error", source, code, message, terminality: "recoverable" };
      }
      return {
        type: "structured_error",
        source,
        code,
        message,
        terminality: "terminal",
        terminal_reason: requireTerminalSessionReasonAt(
          event.terminal_reason,
          `${path}.terminal_reason`,
        ),
      };
    }
  }
}

/**
 * Provider confidence is `null` when the provider supplied none. A number is valid only
 * inside `[0, 1]`; an omitted key is rejected so a fixture default can never become
 * product data.
 */
function requireProviderConfidence(value: unknown, path: string): number | null {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing confidence");
  }
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid confidence");
  }
  return value;
}

function parseServerAudioFrame(value: unknown, path: string): AgentAudioFrame {
  const frame = requireRecordAt(value, path);
  requireOnlyWireKeys(frame, ["pcm16_base64"], path);
  return { pcm16_base64: requireNonEmptyStringAt(frame.pcm16_base64, `${path}.pcm16_base64`) };
}

function parseStudySourceReference(value: unknown, path: string): AgentStudySourceReference {
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

function parseStudyQuestion(value: unknown, path: string): AgentStudyQuestion {
  const question = requireRecordAt(value, path);
  requireOnlyWireKeys(
    question,
    ["question_id", "concept_id", "prompt", "expected_terms", "follow_up", "rubric", "source"],
    path,
  );
  return {
    question_id: requireStrictWireId(question.question_id, `${path}.question_id`),
    concept_id: requireStrictWireId(question.concept_id, `${path}.concept_id`),
    prompt: requireNonEmptyStringAt(question.prompt, `${path}.prompt`),
    expected_terms: requireWireStringArray(question.expected_terms, `${path}.expected_terms`),
    follow_up: requireNonEmptyStringAt(question.follow_up, `${path}.follow_up`),
    rubric: parseEvaluationRubric(question.rubric, `${path}.rubric`),
    source: parseStudySourceReference(question.source, `${path}.source`),
  };
}

function parseEvaluationRubric(value: unknown, path: string): AgentEvaluationRubric {
  const rubric = requireRecordAt(value, path);
  requireOnlyWireKeys(rubric, ["policy_version", "criteria"], path);
  return {
    policy_version: requireNonEmptyStringAt(rubric.policy_version, `${path}.policy_version`),
    criteria: requireArrayAt(rubric.criteria, `${path}.criteria`).map((criterion, index) => {
      const criterionPath = `${path}.criteria[${index}]`;
      const record = requireRecordAt(criterion, criterionPath);
      requireOnlyWireKeys(
        record,
        ["criterion_id", "concept_id", "claim", "source_id", "required"],
        criterionPath,
      );
      return {
        criterion_id: requireStrictWireId(record.criterion_id, `${criterionPath}.criterion_id`),
        concept_id: requireStrictWireId(record.concept_id, `${criterionPath}.concept_id`),
        claim: requireNonEmptyStringAt(record.claim, `${criterionPath}.claim`),
        source_id: requireStrictWireId(record.source_id, `${criterionPath}.source_id`),
        required: requireBooleanAt(record.required, `${criterionPath}.required`),
      };
    }),
  };
}

function parseAnswerEvaluation(value: unknown, path: string): AgentAnswerEvaluation {
  const evaluation = requireRecordAt(value, path);
  requireOnlyWireKeys(
    evaluation,
    [
      "question_id",
      "answer_text",
      "label",
      "concise_feedback",
      "retry_prompt",
      "source",
      "concept_status",
      "confidence_score",
    ],
    path,
  );
  const confidenceScore = evaluation.confidence_score;
  if (confidenceScore === undefined) {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_MISSING_FIELD",
      `${path}.confidence_score`,
      "Missing confidence_score",
    );
  }
  if (
    typeof confidenceScore !== "number" ||
    !Number.isFinite(confidenceScore) ||
    confidenceScore < 0 ||
    confidenceScore > 1
  ) {
    throw voiceDiagnostic(
      "VOICE_PROTOCOL_INVALID_FIELD",
      `${path}.confidence_score`,
      "Invalid confidence_score",
    );
  }
  return {
    question_id: requireStrictWireId(evaluation.question_id, `${path}.question_id`),
    answer_text: requireStringAt(evaluation.answer_text, `${path}.answer_text`),
    label: requireEvaluationLabelAt(evaluation.label, `${path}.label`),
    concise_feedback: requireNonEmptyStringAt(
      evaluation.concise_feedback,
      `${path}.concise_feedback`,
    ),
    retry_prompt: requireNonEmptyStringAt(evaluation.retry_prompt, `${path}.retry_prompt`),
    source: parseStudySourceReference(evaluation.source, `${path}.source`),
    concept_status: requireConceptStatusAt(evaluation.concept_status, `${path}.concept_status`),
    confidence_score: confidenceScore,
  };
}

function parseStudySessionRecap(value: unknown, path: string): AgentStudySessionRecap {
  const recap = requireRecordAt(value, path);
  requireOnlyWireKeys(
    recap,
    [
      "schema",
      "voice_session_id",
      "headline",
      "summary",
      "concepts",
      "review_schedule",
      "next_action",
      "source_moments",
      "deferred_turns",
    ],
    path,
  );
  return {
    schema: requireNonEmptyStringAt(recap.schema, `${path}.schema`),
    voice_session_id: requireStrictWireId(recap.voice_session_id, `${path}.voice_session_id`),
    headline: requireNonEmptyStringAt(recap.headline, `${path}.headline`),
    summary: requireNonEmptyStringAt(recap.summary, `${path}.summary`),
    concepts: requireArrayAt(recap.concepts, `${path}.concepts`).map((concept, index) => {
      const conceptPath = `${path}.concepts[${index}]`;
      const record = requireRecordAt(concept, conceptPath);
      requireOnlyWireKeys(record, ["concept_id", "label", "status"], conceptPath);
      return {
        concept_id: requireStrictWireId(record.concept_id, `${conceptPath}.concept_id`),
        label: requireNonEmptyStringAt(record.label, `${conceptPath}.label`),
        status: requireConceptStatusAt(record.status, `${conceptPath}.status`),
      };
    }),
    review_schedule: requireArrayAt(recap.review_schedule, `${path}.review_schedule`).map(
      (entry, index) => {
        const entryPath = `${path}.review_schedule[${index}]`;
        const record = requireRecordAt(entry, entryPath);
        requireOnlyWireKeys(record, ["concept_id", "due_at", "authority"], entryPath);
        return {
          concept_id: requireStrictWireId(record.concept_id, `${entryPath}.concept_id`),
          due_at: requireNonEmptyStringAt(record.due_at, `${entryPath}.due_at`),
          authority: requireReviewScheduleAuthorityAt(record.authority, `${entryPath}.authority`),
        };
      },
    ),
    next_action: requireNonEmptyStringAt(recap.next_action, `${path}.next_action`),
    source_moments: requireArrayAt(recap.source_moments, `${path}.source_moments`).map(
      (moment, index) => {
        const momentPath = `${path}.source_moments[${index}]`;
        const record = requireRecordAt(moment, momentPath);
        requireOnlyWireKeys(record, ["response_id", "source_id"], momentPath);
        return {
          response_id: requireStrictWireId(record.response_id, `${momentPath}.response_id`),
          source_id: requireStrictWireId(record.source_id, `${momentPath}.source_id`),
        };
      },
    ),
    deferred_turns: requireSequenceNumberAt(recap.deferred_turns, `${path}.deferred_turns`),
  };
}

function requireReviewScheduleAuthorityAt(
  value: unknown,
  path: string,
): AgentReviewScheduleAuthority {
  if (value !== "server_persisted_fsrs" && value !== "core_fsrs_read_time") {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid review authority");
  }
  return value;
}

/**
 * `VOICE-AUTHORITY-001`: returns only the browser-sendable union, never a wider
 * authority union. Every accepted frame is generation-bound and reconstructed field by
 * field, and every rejection is a code/path-only diagnostic that never echoes the input.
 */
export function parseVivaClientFrame(value: unknown): VivaBrowserClientFrame {
  const frame = requireWireEnvelope(value);
  requireWireVersion(frame);
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
      requireOnlyWireKeys(
        frame,
        ["type", "version", "client_generation_id", SESSION_CREDENTIAL_KEY, "session"],
        "$",
      );
      return {
        type: "session_config",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        session_token: requireWireCredential(frame[SESSION_CREDENTIAL_KEY]),
        session: parseSessionConfig(frame.session),
      };
    case "session_refresh":
      requireOnlyWireKeys(frame, ["type", "version", "client_generation_id", "context"], "$");
      return {
        type: "session_refresh",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        context: parseSessionRefreshContext(frame.context),
      };
    case "audio_chunk":
      requireOnlyWireKeys(
        frame,
        ["type", "version", "client_generation_id", "turn_id", "sequence", "frame"],
        "$",
      );
      return {
        type: "audio_chunk",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        turn_id: requireWireId(frame.turn_id, "$.turn_id", "turn_id"),
        sequence: requireSequenceNumberAt(frame.sequence, "$.sequence"),
        frame: parseAudioChunkPayload(frame.frame),
      };
    case "audio_end":
      requireOnlyWireKeys(
        frame,
        ["type", "version", "client_generation_id", "turn_id", "final_sequence"],
        "$",
      );
      return {
        type: "audio_end",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        turn_id: requireWireId(frame.turn_id, "$.turn_id", "turn_id"),
        final_sequence: requireSequenceNumberAt(frame.final_sequence, "$.final_sequence"),
      };
    case "turn_intent":
      requireOnlyWireKeys(
        frame,
        ["type", "version", "client_generation_id", "turn_id", "intent"],
        "$",
      );
      return {
        type: "turn_intent",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: clientGenerationId,
        turn_id: requireWireId(frame.turn_id, "$.turn_id", "turn_id"),
        intent: parseClientTurnIntent(frame.intent),
      };
    case "cancel": {
      requireOnlyWireKeys(frame, ["type", "version", "client_generation_id", "turn_id"], "$");
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
      requireOnlyWireKeys(frame, ["type", "version", "client_generation_id"], "$");
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
 * is never allocated into a parsed tree.
 */
export function parseVivaClientFrameJson(json: string): VivaBrowserClientFrame {
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

/** The one JSON path a rejected audio payload is ever reported at. */
const PCM16_BASE64_PATH = "$.frame.pcm16_base64";

/**
 * Decodes `frame.pcm16_base64` only long enough to enforce canonical padded base64 and
 * the raw byte bounds. The decoded bytes are dropped here; they are never stored,
 * logged, or copied into a diagnostic. The aggregate turn bound stays in Plan 03's
 * stateful assembler, which consumes the same constants.
 */
function parseAudioChunkPayload(value: unknown): AgentAudioFrame {
  const frame = requireRecordAt(value, "$.frame");
  requireOnlyWireKeys(frame, ["pcm16_base64"], "$.frame");
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
  const segments = text.split(".");
  if (segments.length !== 3 || segments[0] !== VIVA_SESSION_CREDENTIAL_PREFIX) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid signed credential");
  }
  // Shape only: the claims and signature segments must be canonical unpadded
  // base64url. Signature verification is Plan 08's, never this module's.
  for (const segment of segments.slice(1)) {
    if (!isCanonicalUnpaddedBase64Url(segment)) {
      throw voiceDiagnostic(
        "VOICE_PROTOCOL_NONCANONICAL_BASE64URL",
        path,
        "Non-canonical signed credential segment",
      );
    }
  }
  return text;
}

/** The wire prefix every `viva1` session credential carries. */
const VIVA_SESSION_CREDENTIAL_PREFIX = "viva1";

const CANONICAL_UNPADDED_BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Canonical unpadded base64url: no padding, no standard-alphabet characters, and no
 * non-zero unused bits in the final group. This is the only place the contract uses the
 * url alphabet; audio payloads are padded standard base64.
 */
function isCanonicalUnpaddedBase64Url(segment: string): boolean {
  if (!CANONICAL_UNPADDED_BASE64URL.test(segment) || segment.length % 4 === 1) return false;
  const standard = `${segment.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
    (4 - (segment.length % 4)) % 4,
  )}`;
  let binary: string;
  try {
    binary = atob(standard);
  } catch {
    return false;
  }
  const reencoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return reencoded === segment;
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
 * `VOICE-READY-001`: the advertisement is a required ready field, strictly validated and
 * reconstructed. A frame without one, or with one that names another version, is not v5
 * and fails closed rather than being silently upgraded.
 */
function parseVivaVoiceProtocolAdvertisement(value: unknown): VivaVoiceProtocolAdvertisement {
  const advertisement = requireRecordAt(value, "$.protocol");
  requireOnlyWireKeys(advertisement, ["preferred_version", "supported_versions"], "$.protocol");
  const supportedVersions = requireArrayAt(
    advertisement.supported_versions,
    "$.protocol.supported_versions",
  ).map((version) => {
    if (typeof version !== "number" || !Number.isSafeInteger(version)) {
      throw voiceDiagnostic(
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
    throw voiceDiagnostic(
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
  const brain = requireRecordAt(value, "$.brain");
  requireOnlyWireKeys(brain, ["provider", "configured", "selectable", "live_runtime"], "$.brain");
  return {
    provider: requireNonEmptyStringAt(brain.provider, "$.brain.provider"),
    configured: requireBooleanAt(brain.configured, "$.brain.configured"),
    selectable: requireBooleanAt(brain.selectable, "$.brain.selectable"),
    live_runtime: requireBooleanAt(brain.live_runtime, "$.brain.live_runtime"),
  };
}

function parseStoreReadiness(value: unknown): AgentStoreReadiness {
  const store = requireRecordAt(value, "$.store");
  requireOnlyWireKeys(
    store,
    [
      "backend",
      "available",
      "durable",
      "nonce_replay_protection",
      "raw_audio_persistence",
      "transcript_persistence",
      "uuid_schema_translation",
    ],
    "$.store",
  );
  return {
    backend: requireNonEmptyStringAt(store.backend, "$.store.backend"),
    available: requireBooleanAt(store.available, "$.store.available"),
    durable: requireBooleanAt(store.durable, "$.store.durable"),
    nonce_replay_protection: requireBooleanAt(
      store.nonce_replay_protection,
      "$.store.nonce_replay_protection",
    ),
    raw_audio_persistence: requireBooleanAt(
      store.raw_audio_persistence,
      "$.store.raw_audio_persistence",
    ),
    transcript_persistence: requireBooleanAt(
      store.transcript_persistence,
      "$.store.transcript_persistence",
    ),
    uuid_schema_translation: requireBooleanAt(
      store.uuid_schema_translation,
      "$.store.uuid_schema_translation",
    ),
  };
}

function parseManuscriptIntent(value: unknown, path: string): ManuscriptIntent {
  const intent = requireRecordAt(value, path);
  switch (intent.type) {
    case "scene_intent":
      requireOnlyWireKeys(intent, ["type", "register", "emphasis"], path);
      return {
        type: "scene_intent",
        register: requireManuscriptRegister(intent.register, `${path}.register`),
        emphasis: requireManuscriptEmphasis(intent.emphasis, `${path}.emphasis`),
      };
    case "entity_intent":
      requireOnlyWireKeys(
        intent,
        ["type", "entity_id", "entity_kind", "register", "emphasis"],
        path,
      );
      return {
        type: "entity_intent",
        entity_id: requireManuscriptId(intent.entity_id, `${path}.entity_id`),
        entity_kind: requireManuscriptEntityKind(intent.entity_kind, `${path}.entity_kind`),
        register: requireManuscriptRegister(intent.register, `${path}.register`),
        emphasis: requireManuscriptEmphasis(intent.emphasis, `${path}.emphasis`),
      };
    case "marginalia_intent":
      requireOnlyWireKeys(
        intent,
        ["type", "marginalia_id", "anchor_entity_id", "register", "emphasis"],
        path,
      );
      return {
        type: "marginalia_intent",
        marginalia_id: requireManuscriptId(intent.marginalia_id, `${path}.marginalia_id`),
        anchor_entity_id: requireManuscriptId(intent.anchor_entity_id, `${path}.anchor_entity_id`),
        register: requireManuscriptRegister(intent.register, `${path}.register`),
        emphasis: requireManuscriptEmphasis(intent.emphasis, `${path}.emphasis`),
      };
    default:
      throw voiceDiagnostic(
        "VOICE_PROTOCOL_INVALID_FIELD",
        `${path}.type`,
        "Invalid manuscript intent",
      );
  }
}

/** Manuscript ids are render anchors, never learner text; they share the id vocabulary. */
const MAX_MANUSCRIPT_ID_LENGTH = 96;

function requireManuscriptId(value: unknown, path: string): string {
  const text = requireStrictWireId(value, path);
  if (text.length > MAX_MANUSCRIPT_ID_LENGTH) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid manuscript id");
  }
  return text;
}

function requireManuscriptRegister(value: unknown, path: string): ManuscriptRegister {
  if (
    value !== "examining" &&
    value !== "reflecting" &&
    value !== "correcting" &&
    value !== "sourcing" &&
    value !== "recapping"
  ) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid manuscript register");
  }
  return value;
}

function requireManuscriptEmphasis(value: unknown, path: string): ManuscriptEmphasis {
  if (value !== "quiet" && value !== "measured" && value !== "marked") {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid manuscript emphasis");
  }
  return value;
}

function requireManuscriptEntityKind(value: unknown, path: string): ManuscriptEntityKind {
  if (value !== "concept" && value !== "source" && value !== "marginal_note") {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid manuscript entity kind");
  }
  return value;
}

function requireWireStringArray(value: unknown, path: string): string[] {
  return requireArrayAt(value, path).map((item, index) =>
    requireStringAt(item, `${path}[${index}]`),
  );
}

function requireStudyPhaseAt(value: unknown, path: string): AgentStudySessionPhase {
  if (
    value !== "ready" &&
    value !== "listening" &&
    value !== "thinking" &&
    value !== "feedback" &&
    value !== "correction" &&
    value !== "recap"
  ) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid session phase");
  }
  return value;
}

/** A closed value vocabulary. A missing key and a value outside it report distinctly. */
function requireWireEnumAt(value: unknown, allowed: readonly string[], path: string): string {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing enumerated value");
  }
  const text = requireStringAt(value, path);
  if (!allowed.includes(text)) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid enumerated value");
  }
  return text;
}

function requireTerminalSessionReasonAt(value: unknown, path: string): AgentTerminalSessionReason {
  return requireWireEnumAt(
    value,
    VIVA_AGENT_TERMINAL_SESSION_REASONS,
    path,
  ) as AgentTerminalSessionReason;
}

function requireConceptStatusAt(value: unknown, path: string): AgentConceptStatus {
  if (value !== "strong" && value !== "shaky" && value !== "missed" && value !== "review") {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid concept status");
  }
  return value;
}

function requireEvaluationLabelAt(value: unknown, path: string): AgentEvaluationLabel {
  if (
    value !== "strong" &&
    value !== "mostly correct" &&
    value !== "partially correct" &&
    value !== "vague" &&
    value !== "wrong" &&
    value !== "off-topic" &&
    value !== "insufficient evidence"
  ) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid evaluation label");
  }
  return value;
}

function requireBooleanAt(value: unknown, path: string): boolean {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing boolean");
  }
  if (typeof value !== "boolean") {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid boolean");
  }
  return value;
}

function requireExactWireValue<T>(value: unknown, expected: T, path: string): T {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing pinned value");
  }
  if (value !== expected) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Unexpected pinned value");
  }
  return expected;
}

/** The root of a wire frame must be a JSON object, never an array or a scalar. */
function requireWireEnvelope(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_ENVELOPE", "$", "Invalid Viva voice envelope");
  }
  return value as Record<string, unknown>;
}

/** v5 is the only accepted version; a missing or other version is never upgraded. */
function requireWireVersion(frame: Record<string, unknown>): void {
  if (frame.version !== VIVA_VOICE_PROTOCOL_VERSION) {
    throw unsupportedVersion();
  }
}

function requireSequenceNumberAt(value: unknown, path: string): number {
  if (value === undefined) {
    throw voiceDiagnostic("VOICE_PROTOCOL_MISSING_FIELD", path, "Missing sequence");
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw voiceDiagnostic("VOICE_PROTOCOL_INVALID_FIELD", path, "Invalid sequence");
  }
  return value;
}
