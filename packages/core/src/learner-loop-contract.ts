import {
  type AgentTerminalSessionReason,
  VIVA_AGENT_TERMINAL_SESSION_REASONS,
} from "./agent-contract.ts";
import contractData from "./learner-loop-contract.json" with { type: "json" };

export const VIVA_PRE_LOOP_TERMINAL_REASONS = [
  "pre_loop_upload_unavailable",
  "pre_loop_ingestion_unavailable",
  "pre_loop_session_unavailable",
] as const;

export type VivaPreLoopTerminalReason = (typeof VIVA_PRE_LOOP_TERMINAL_REASONS)[number];

export const VIVA_RUNTIME_COPY_CAUSES = [
  "api_missing",
  "agent_offline",
  "auth_failed",
  "cost_budget",
  "drained",
  "fake_provider",
  "ingestion_failed",
  "ingestion_pending",
  "live_provider_gated",
  "live_runtime",
  "mic_denied",
  "partial_stage_success",
  "provider_auth_failed",
  "provider_cancelled",
  "provider_malformed_stream",
  "provider_network_disconnect",
  "provider_rate_limited",
  "provider_timeout",
  "rate_limit",
  "recap_success",
  "rollback",
  "session_cap",
  "session_disconnected",
  "slow_client",
  "store_unavailable",
  "synthetic",
  "tool_executor_failure",
  "turn_cap",
  "unexpected_close",
] as const;

export type RuntimeCopyCause = (typeof VIVA_RUNTIME_COPY_CAUSES)[number];

export const VIVA_LEARNER_LOOP_EVIDENCE_FIELDS = [
  "terminal_reason",
  "failure_class",
  "stage",
  "provider",
  "model",
  "deploy_sha",
  "latency_ms",
  "retry_after_ms",
  "retry_after_source",
  "reset_hint",
  "budget_state",
  "usage",
  "cost_usd",
  "token_refresh_outcome",
  "recap_success",
] as const;

export type LearnerLoopEvidenceField = (typeof VIVA_LEARNER_LOOP_EVIDENCE_FIELDS)[number];

export const VIVA_LEARNER_LOOP_RESOLUTION_KINDS = [
  "success",
  "recoverable",
  "deferred",
  "terminal",
] as const;

export type LearnerLoopResolutionKind = (typeof VIVA_LEARNER_LOOP_RESOLUTION_KINDS)[number];

export const VIVA_LEARNER_LOOP_AUTHORITIES = [
  "agent_event",
  "client_lifecycle_event",
  "durable_store_event",
  "pre_loop_service_event",
  "server_control_event",
  "session_event",
] as const;

export type LearnerLoopAuthority = (typeof VIVA_LEARNER_LOOP_AUTHORITIES)[number];

/**
 * The closed set of learner-facing commands.
 *
 * An intent is a local command the learner surface already knows how to run. It
 * is never provider text, an operator instruction, or a link: copy that could
 * carry a raw error, secret, transcript, or source excerpt has no way to reach
 * a learner through this vocabulary.
 */
export const VIVA_LEARNER_LOOP_ACTION_INTENTS = [
  "disabled",
  "refresh_session",
  "retry_agent",
  "start_session",
  "submit_turn",
] as const;

export type LearnerLoopActionIntent = (typeof VIVA_LEARNER_LOOP_ACTION_INTENTS)[number];

export type LearnerLoopTerminalReason = AgentTerminalSessionReason | VivaPreLoopTerminalReason;

/**
 * Every terminal reason the learner loop may name, composed once.
 *
 * The learner loop is a consumer of two vocabularies, never a third author:
 * `VIVA_AGENT_TERMINAL_SESSION_REASONS` owns the in-session reasons — including
 * `durability_degraded`, which appears here exactly once through that array —
 * and `VIVA_PRE_LOOP_TERMINAL_REASONS` owns the pre-session ones. A literal
 * repeated in this module would be a second declaration able to outlive the arm
 * it duplicates, so `validateLearnerLoopContract` reads only this array.
 */
export const VIVA_LEARNER_LOOP_TERMINAL_REASONS: readonly LearnerLoopTerminalReason[] = [
  ...VIVA_AGENT_TERMINAL_SESSION_REASONS,
  ...VIVA_PRE_LOOP_TERMINAL_REASONS,
];

export type LearnerLoopCopy = {
  capsule_label: string;
  marginalia_title: string;
  marginalia_text: string;
  next_action_label: string;
  next_action_intent: LearnerLoopActionIntent;
  primary_action_label: string;
  primary_action_intent: LearnerLoopActionIntent;
  status_label: string;
};

export type LearnerLoopState = {
  id: string;
  label: string;
  stage: string;
  resolution_kind: LearnerLoopResolutionKind;
  submitted_answer_resolution: boolean;
  max_resolution_ms: number;
  learner_safe: true;
  authority: LearnerLoopAuthority;
  failure_class?: string;
  terminal_reason?: LearnerLoopTerminalReason;
  evidence_code?: string;
  readiness_failure_kind?: string;
  sanitized_evidence: true;
  failure_matrix?: true;
  smoke_terminal_reasons?: string[];
  runtime_copy_causes: RuntimeCopyCause[];
  copy: LearnerLoopCopy;
  operator_diagnostics: LearnerLoopEvidenceField[];
};

export type LearnerLoopContract = {
  schema: "viva.learner_loop_contract.v1";
  max_submitted_answer_resolution_ms: number;
  layers: {
    client_session_safety_net: string;
    server_stage_enforcement: string;
    outer_bound_rule: string;
  };
  evidence_incident: {
    observed_at_utc: string[];
    signals: string[];
    sanitized_evidence: true;
  };
  evidence_fields: LearnerLoopEvidenceField[];
  states: LearnerLoopState[];
};

const CONTRACT_FIELDS = [
  "schema",
  "max_submitted_answer_resolution_ms",
  "layers",
  "evidence_incident",
  "evidence_fields",
  "states",
] as const;

const LAYER_FIELDS = [
  "client_session_safety_net",
  "server_stage_enforcement",
  "outer_bound_rule",
] as const;

const EVIDENCE_INCIDENT_FIELDS = ["observed_at_utc", "signals", "sanitized_evidence"] as const;

const REQUIRED_STATE_FIELDS = [
  "id",
  "label",
  "stage",
  "resolution_kind",
  "submitted_answer_resolution",
  "max_resolution_ms",
  "learner_safe",
  "authority",
  "sanitized_evidence",
  "runtime_copy_causes",
  "copy",
  "operator_diagnostics",
] as const;

const OPTIONAL_STATE_FIELDS = [
  "failure_class",
  "terminal_reason",
  "evidence_code",
  "readiness_failure_kind",
  "failure_matrix",
  "smoke_terminal_reasons",
] as const;

const COPY_FIELDS = [
  "capsule_label",
  "marginalia_title",
  "marginalia_text",
  "next_action_label",
  "next_action_intent",
  "primary_action_label",
  "primary_action_intent",
  "status_label",
] as const;

function invalid(message: string): never {
  throw new Error(message);
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireFields(
  source: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  missingSubject: string,
  unknownSubject: string,
): void {
  for (const field of required) {
    if (source[field] === undefined) {
      invalid(`${missingSubject} is missing ${field}`);
    }
  }
  const allowed = new Set<string>([...required, ...optional]);
  for (const field of Object.keys(source)) {
    if (!allowed.has(field)) {
      invalid(`Unknown ${unknownSubject} field ${field}`);
    }
  }
}

function nonEmptyString(source: Record<string, unknown>, field: string, subject: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${subject} ${field} must be a nonempty string`);
  }
  return value;
}

function optionalNonEmptyString(
  source: Record<string, unknown>,
  field: string,
  subject: string,
): string | undefined {
  return source[field] === undefined ? undefined : nonEmptyString(source, field, subject);
}

function literalTrue(source: Record<string, unknown>, field: string, subject: string): true {
  if (source[field] !== true) {
    invalid(`${subject} must declare ${field} true`);
  }
  return true;
}

function boolean(source: Record<string, unknown>, field: string, subject: string): boolean {
  const value = source[field];
  if (typeof value !== "boolean") {
    invalid(`${subject} ${field} must be a boolean`);
  }
  return value;
}

function nonNegativeInteger(
  source: Record<string, unknown>,
  field: string,
  subject: string,
): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${subject} ${field} must be a nonnegative integer`);
  }
  return value;
}

function nonEmptyStringArray(
  source: Record<string, unknown>,
  field: string,
  subject: string,
): string[] {
  const value = source[field];
  if (!Array.isArray(value) || value.length === 0) {
    invalid(`${subject} ${field} must be a nonempty string array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      invalid(`${subject} ${field}[${index}] must be a nonempty string`);
    }
    return entry;
  });
}

function stringArray(source: Record<string, unknown>, field: string, subject: string): string[] {
  const value = source[field];
  if (!Array.isArray(value)) {
    invalid(`${subject} ${field} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      invalid(`${subject} ${field}[${index}] must be a nonempty string`);
    }
    return entry;
  });
}

function member<Allowed extends string>(
  value: string,
  allowed: readonly Allowed[],
  label: string,
): Allowed {
  if (!(allowed as readonly string[]).includes(value)) {
    invalid(`Unknown ${label} ${value}`);
  }
  return value as Allowed;
}

function deepFreeze<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  return value;
}

function validateCopy(value: unknown, stateId: string): LearnerLoopCopy {
  const source = record(value, `Learner loop state ${stateId} copy`);
  requireFields(source, COPY_FIELDS, [], `Learner loop state ${stateId} copy`, "learner loop copy");
  const subject = `Learner loop state ${stateId} copy`;

  return {
    capsule_label: nonEmptyString(source, "capsule_label", subject),
    marginalia_title: nonEmptyString(source, "marginalia_title", subject),
    marginalia_text: nonEmptyString(source, "marginalia_text", subject),
    next_action_label: nonEmptyString(source, "next_action_label", subject),
    next_action_intent: member(
      nonEmptyString(source, "next_action_intent", subject),
      VIVA_LEARNER_LOOP_ACTION_INTENTS,
      "learner loop next action intent",
    ),
    primary_action_label: nonEmptyString(source, "primary_action_label", subject),
    primary_action_intent: member(
      nonEmptyString(source, "primary_action_intent", subject),
      VIVA_LEARNER_LOOP_ACTION_INTENTS,
      "learner loop primary action intent",
    ),
    status_label: nonEmptyString(source, "status_label", subject),
  };
}

function validateState(
  value: unknown,
  index: number,
  maxSubmittedAnswerResolutionMs: number,
  knownTerminalReasons: ReadonlySet<string>,
): LearnerLoopState {
  const source = record(value, `Learner loop state ${index}`);
  const id = nonEmptyString(source, "id", `Learner loop state ${index}`);
  requireFields(
    source,
    REQUIRED_STATE_FIELDS,
    OPTIONAL_STATE_FIELDS,
    `Learner loop state ${id}`,
    "learner loop state",
  );
  const subject = `Learner loop state ${id}`;

  const submittedAnswerResolution = boolean(source, "submitted_answer_resolution", subject);
  const maxResolutionMs = nonNegativeInteger(source, "max_resolution_ms", subject);
  if (submittedAnswerResolution) {
    if (maxResolutionMs <= 0 || maxResolutionMs > maxSubmittedAnswerResolutionMs) {
      invalid(`Invalid submitted-answer bound for ${id}`);
    }
  } else if (maxResolutionMs > maxSubmittedAnswerResolutionMs) {
    invalid(`Invalid learner loop max_resolution_ms for ${id}`);
  }

  const resolutionKind = member(
    nonEmptyString(source, "resolution_kind", subject),
    VIVA_LEARNER_LOOP_RESOLUTION_KINDS,
    "learner loop resolution kind",
  );

  const terminalReasonValue = optionalNonEmptyString(source, "terminal_reason", subject);
  if (resolutionKind === "terminal" && terminalReasonValue === undefined) {
    invalid(`Terminal learner loop state ${id} is missing terminal_reason`);
  }
  if (terminalReasonValue !== undefined && !knownTerminalReasons.has(terminalReasonValue)) {
    invalid(`Unknown learner loop terminal reason ${terminalReasonValue}`);
  }

  const seenCauses = new Set<string>();
  const runtimeCopyCauses = stringArray(source, "runtime_copy_causes", subject).map((cause) => {
    const known = member(cause, VIVA_RUNTIME_COPY_CAUSES, "runtime copy cause");
    if (seenCauses.has(known)) {
      invalid(`Duplicate runtime copy cause ${known} in state ${id}`);
    }
    seenCauses.add(known);
    return known;
  });

  const seenDiagnostics = new Set<string>();
  const operatorDiagnostics = nonEmptyStringArray(source, "operator_diagnostics", subject).map(
    (field) => {
      const known = member(field, VIVA_LEARNER_LOOP_EVIDENCE_FIELDS, "learner loop evidence field");
      if (seenDiagnostics.has(known)) {
        invalid(`Duplicate learner loop evidence field ${known} in state ${id}`);
      }
      seenDiagnostics.add(known);
      return known;
    },
  );

  const state: LearnerLoopState = {
    id,
    label: nonEmptyString(source, "label", subject),
    stage: nonEmptyString(source, "stage", subject),
    resolution_kind: resolutionKind,
    submitted_answer_resolution: submittedAnswerResolution,
    max_resolution_ms: maxResolutionMs,
    learner_safe: literalTrue(source, "learner_safe", subject),
    authority: member(
      nonEmptyString(source, "authority", subject),
      VIVA_LEARNER_LOOP_AUTHORITIES,
      "learner loop authority",
    ),
    sanitized_evidence: literalTrue(source, "sanitized_evidence", subject),
    runtime_copy_causes: runtimeCopyCauses,
    copy: validateCopy(source.copy, id),
    operator_diagnostics: operatorDiagnostics,
  };

  const failureClass = optionalNonEmptyString(source, "failure_class", subject);
  if (failureClass !== undefined) {
    state.failure_class = failureClass;
  }
  if (terminalReasonValue !== undefined) {
    state.terminal_reason = terminalReasonValue as LearnerLoopTerminalReason;
  }
  const evidenceCode = optionalNonEmptyString(source, "evidence_code", subject);
  if (evidenceCode !== undefined) {
    state.evidence_code = evidenceCode;
  }
  const readinessFailureKind = optionalNonEmptyString(source, "readiness_failure_kind", subject);
  if (readinessFailureKind !== undefined) {
    state.readiness_failure_kind = readinessFailureKind;
  }
  if (source.failure_matrix !== undefined) {
    state.failure_matrix = literalTrue(source, "failure_matrix", subject);
  }
  if (source.smoke_terminal_reasons !== undefined) {
    state.smoke_terminal_reasons = nonEmptyStringArray(source, "smoke_terminal_reasons", subject);
  }

  return state;
}

/**
 * Validate an unknown value as the learner-loop contract.
 *
 * The learner-loop JSON is data, not a trusted TypeScript literal: it is edited
 * by hand, read by release scripts, and rendered to learners. Every field is
 * therefore checked against a closed allowlist and the result is rebuilt from
 * validated parts, so an unchecked cast can never hand a caller a state whose
 * authority, intent, terminal reason, or learner-safety flag was never proved.
 */
export function validateLearnerLoopContract(value: unknown): LearnerLoopContract {
  const source = record(value, "Learner loop contract");
  requireFields(source, CONTRACT_FIELDS, [], "Learner loop contract", "learner loop contract");

  if (source.schema !== "viva.learner_loop_contract.v1") {
    invalid("Invalid learner loop contract schema");
  }

  const maxSubmittedAnswerResolutionMs = source.max_submitted_answer_resolution_ms;
  if (
    typeof maxSubmittedAnswerResolutionMs !== "number" ||
    !Number.isInteger(maxSubmittedAnswerResolutionMs) ||
    maxSubmittedAnswerResolutionMs <= 0 ||
    maxSubmittedAnswerResolutionMs > 45_000
  ) {
    invalid("Invalid learner loop max submitted-answer resolution");
  }

  const layerSource = record(source.layers, "Learner loop layers");
  requireFields(layerSource, LAYER_FIELDS, [], "Learner loop layers", "learner loop layers");
  const layers = {
    client_session_safety_net: nonEmptyString(
      layerSource,
      "client_session_safety_net",
      "Learner loop layers",
    ),
    server_stage_enforcement: nonEmptyString(
      layerSource,
      "server_stage_enforcement",
      "Learner loop layers",
    ),
    outer_bound_rule: nonEmptyString(layerSource, "outer_bound_rule", "Learner loop layers"),
  };

  const incidentSource = record(source.evidence_incident, "Learner loop evidence_incident");
  requireFields(
    incidentSource,
    EVIDENCE_INCIDENT_FIELDS,
    [],
    "Learner loop evidence_incident",
    "learner loop evidence_incident",
  );
  const evidenceIncident = {
    observed_at_utc: nonEmptyStringArray(
      incidentSource,
      "observed_at_utc",
      "Learner loop evidence_incident",
    ),
    signals: nonEmptyStringArray(incidentSource, "signals", "Learner loop evidence_incident"),
    sanitized_evidence: literalTrue(
      incidentSource,
      "sanitized_evidence",
      "Learner loop evidence_incident",
    ),
  };

  const evidenceFields = stringArray(source, "evidence_fields", "Learner loop contract");
  if (JSON.stringify(evidenceFields) !== JSON.stringify(VIVA_LEARNER_LOOP_EVIDENCE_FIELDS)) {
    invalid("Invalid learner loop evidence fields");
  }

  const rawStates = source.states;
  if (!Array.isArray(rawStates) || rawStates.length === 0) {
    invalid("Learner loop states must be a nonempty array");
  }

  const knownTerminalReasons = new Set<string>(VIVA_LEARNER_LOOP_TERMINAL_REASONS);

  const stateIds = new Set<string>();
  const resolutionKeys = new Set<string>();
  const mappedRuntimeCauses = new Set<string>();
  let successStates = 0;

  const states = rawStates.map((rawState, index) => {
    const state = validateState(
      rawState,
      index,
      maxSubmittedAnswerResolutionMs,
      knownTerminalReasons,
    );

    if (stateIds.has(state.id)) {
      invalid(`Duplicate learner loop state id ${state.id}`);
    }
    stateIds.add(state.id);

    if (state.resolution_kind === "success") {
      successStates += 1;
    }

    if (state.submitted_answer_resolution) {
      const resolutionKey = state.terminal_reason ?? state.failure_class ?? state.id;
      if (resolutionKeys.has(resolutionKey)) {
        invalid(`Duplicate submitted-answer resolution key ${resolutionKey}`);
      }
      resolutionKeys.add(resolutionKey);
    }

    for (const cause of state.runtime_copy_causes) {
      mappedRuntimeCauses.add(cause);
    }

    return state;
  });

  for (const cause of VIVA_RUNTIME_COPY_CAUSES) {
    if (!mappedRuntimeCauses.has(cause)) {
      invalid(`Unmapped runtime copy cause ${cause}`);
    }
  }

  if (successStates === 0) {
    invalid("Learner loop contract has no success resolution state");
  }

  return deepFreeze({
    schema: "viva.learner_loop_contract.v1",
    max_submitted_answer_resolution_ms: maxSubmittedAnswerResolutionMs,
    layers,
    evidence_incident: evidenceIncident,
    evidence_fields: evidenceFields as LearnerLoopEvidenceField[],
    states,
  });
}

export const VIVA_LEARNER_LOOP_CONTRACT = validateLearnerLoopContract(contractData);

export const VIVA_LEARNER_LOOP_MAX_TURN_MS =
  VIVA_LEARNER_LOOP_CONTRACT.max_submitted_answer_resolution_ms;
