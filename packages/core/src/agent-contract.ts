export const VIVA_VOICE_PROTOCOL_VERSION = 1;
export const VIVA_VOICE_SAMPLE_RATE_HZ = 24_000;
export const VIVA_VOICE_INPUT_ENCODING = "pcm_s16le";
export const VIVA_VOICE_MAX_TEXT_FRAME_BYTES = 64 * 1024;
export const VIVA_VOICE_MAX_BINARY_FRAME_BYTES = 256 * 1024;

export type AgentStudyMode = "quiz" | "teach" | "mock" | "cram";
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

export type AgentSessionConfig = {
  session_id: string;
  user_id: string;
  study_set_id: string;
  mode?: AgentStudyMode;
  initial_goal?: string;
  source_context: AgentSourceContext[];
  active_concepts: string[];
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

export type AgentToolProposal = {
  name: string;
  arguments: Record<string, unknown>;
  call_id?: string;
};

export type AgentToolResult = {
  proposal: AgentToolProposal;
  result: unknown;
};

export type ManuscriptRegister = "examining" | "reflecting" | "correcting" | "sourcing" | "recapping";
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

export type VivaClientFrame =
  | {
      type: "session_config";
      version: typeof VIVA_VOICE_PROTOCOL_VERSION;
      session: AgentSessionConfig;
      session_token?: string;
    }
  | { type: "audio"; version: typeof VIVA_VOICE_PROTOCOL_VERSION; frame: AgentAudioFrame }
  | { type: "text"; version: typeof VIVA_VOICE_PROTOCOL_VERSION; text: string }
  | { type: "cancel"; version: typeof VIVA_VOICE_PROTOCOL_VERSION }
  | { type: "stop"; version: typeof VIVA_VOICE_PROTOCOL_VERSION };

export type VivaReadyFrame = {
  type: "ready";
  version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  sample_rate_hz: typeof VIVA_VOICE_SAMPLE_RATE_HZ;
  input_encoding: typeof VIVA_VOICE_INPUT_ENCODING;
};

export type VivaServerEvent =
  | { type: "session_phase"; phase: AgentStudySessionPhase }
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
  | { type: "recap_ready"; response_id: string; recap: AgentStudySessionRecap }
  | { type: "audio_delta"; response_id: string; frame: AgentAudioFrame }
  | { type: "cancellation"; response_id?: string | null }
  | { type: "structured_error"; source: string; message: string };

export type VivaServerFrame =
  | VivaReadyFrame
  | { type: "event"; version: typeof VIVA_VOICE_PROTOCOL_VERSION; event: VivaServerEvent }
  | { type: "error"; version: typeof VIVA_VOICE_PROTOCOL_VERSION; message: string };

export function audioClientFrame(pcm16Base64: string): VivaClientFrame {
  return {
    type: "audio",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    frame: { pcm16_base64: pcm16Base64 },
  };
}

export function sessionConfigFrame(
  session: AgentSessionConfig,
  sessionToken?: string | null,
): VivaClientFrame {
  const frame: VivaClientFrame = {
    type: "session_config",
    version: VIVA_VOICE_PROTOCOL_VERSION,
    session,
  };
  if (sessionToken) {
    frame.session_token = sessionToken;
  }
  return frame;
}

export function parseVivaServerFrame(value: unknown): VivaServerFrame {
  const frame = requireRecord(value, "server frame");
  const type = frame.type;
  if (frame.version !== VIVA_VOICE_PROTOCOL_VERSION) {
    throw new Error("Unsupported Viva voice protocol version");
  }

  if (type === "ready") {
    if (frame.sample_rate_hz !== VIVA_VOICE_SAMPLE_RATE_HZ) {
      throw new Error("Unexpected Viva voice sample rate");
    }
    if (frame.input_encoding !== VIVA_VOICE_INPUT_ENCODING) {
      throw new Error("Unexpected Viva voice input encoding");
    }
    return frame as VivaReadyFrame;
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

export function parseVivaClientFrame(value: unknown): VivaClientFrame {
  const frame = requireRecord(value, "client frame");
  if (frame.version !== VIVA_VOICE_PROTOCOL_VERSION) {
    throw new Error("Unsupported Viva voice protocol version");
  }
  switch (frame.type) {
    case "session_config":
      parseSessionConfig(frame.session);
      if ("session_token" in frame && frame.session_token !== undefined) {
        requireNonEmptyString(frame.session_token, "session_token");
      }
      return frame as VivaClientFrame;
    case "audio":
      {
        parseAudioFrame(frame.frame);
      }
      return frame as VivaClientFrame;
    case "text":
      if (typeof frame.text !== "string") {
        throw new Error("Missing text");
      }
      return frame as VivaClientFrame;
    case "tool_result":
      throw new Error("Browser tool_result frames are not accepted");
    case "cancel":
    case "stop":
      return frame as VivaClientFrame;
    default:
      throw new Error("Unknown Viva voice client frame");
  }
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

function parseSessionConfig(value: unknown): AgentSessionConfig {
  const session = requireRecord(value, "session");
  if ("session_token" in session) {
    throw new Error("session_token must be sent at the session_config frame top level");
  }
  requireNonEmptyString(session.session_id, "session_id");
  requireNonEmptyString(session.user_id, "user_id");
  requireNonEmptyString(session.study_set_id, "study_set_id");
  if ("mode" in session && session.mode !== undefined) {
    requireStudyMode(session.mode);
  }
  if ("initial_goal" in session && session.initial_goal !== undefined) {
    requireString(session.initial_goal, "initial_goal");
  }
  const sourceContext = requireArray(session.source_context, "source_context");
  for (const source of sourceContext) parseStudySourceReference(source);
  requireStringArray(session.active_concepts, "active_concepts");
  return session as unknown as AgentSessionConfig;
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

function requireStudyMode(value: unknown): AgentStudyMode {
  if (value !== "quiz" && value !== "teach" && value !== "mock" && value !== "cram") {
    throw new Error("Invalid study mode");
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

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.trim().length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return text;
}
