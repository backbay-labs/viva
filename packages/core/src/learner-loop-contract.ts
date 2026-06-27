import {
  type AgentTerminalSessionReason,
  VIVA_AGENT_TERMINAL_SESSION_REASONS,
} from "./agent-contract";
import contractData from "./learner-loop-contract.json";

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
  "usage",
  "cost_usd",
  "token_refresh_outcome",
  "recap_success",
] as const;

export type LearnerLoopEvidenceField = (typeof VIVA_LEARNER_LOOP_EVIDENCE_FIELDS)[number];

export type LearnerLoopResolutionKind = "success" | "recoverable" | "deferred" | "terminal";

export type LearnerLoopAuthority =
  | "agent_event"
  | "client_lifecycle_event"
  | "durable_store_event"
  | "pre_loop_service_event"
  | "server_control_event"
  | "session_event";

export type LearnerLoopTerminalReason = AgentTerminalSessionReason | "durability_degraded";

export type LearnerLoopCopy = {
  capsule_label: string;
  marginalia_title: string;
  marginalia_text: string;
  next_action_label: string;
  primary_action_label: string;
  primary_action_intent: "disabled" | "retry_agent" | "start_session" | "submit_turn";
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

export function validateLearnerLoopContract(contract: LearnerLoopContract): LearnerLoopContract {
  if (contract.schema !== "viva.learner_loop_contract.v1") {
    throw new Error("Invalid learner loop contract schema");
  }
  if (
    JSON.stringify(contract.evidence_fields) !== JSON.stringify(VIVA_LEARNER_LOOP_EVIDENCE_FIELDS)
  ) {
    throw new Error("Invalid learner loop evidence fields");
  }
  if (
    !Number.isInteger(contract.max_submitted_answer_resolution_ms) ||
    contract.max_submitted_answer_resolution_ms <= 0 ||
    contract.max_submitted_answer_resolution_ms > 45_000
  ) {
    throw new Error("Invalid learner loop max submitted-answer resolution");
  }

  const stateIds = new Set<string>();
  const resolutionKeys = new Set<string>();
  const mappedRuntimeCauses = new Set<string>();
  const knownRuntimeCauses = new Set<string>(VIVA_RUNTIME_COPY_CAUSES);
  const knownEvidenceFields = new Set<string>(VIVA_LEARNER_LOOP_EVIDENCE_FIELDS);
  const knownTerminalReasons = new Set<string>(VIVA_AGENT_TERMINAL_SESSION_REASONS);

  for (const state of contract.states) {
    if (stateIds.has(state.id)) {
      throw new Error(`Duplicate learner loop state id ${state.id}`);
    }
    stateIds.add(state.id);

    if (state.resolution_kind === "terminal" && !state.terminal_reason) {
      throw new Error(`Terminal learner loop state ${state.id} is missing terminal_reason`);
    }
    if (state.terminal_reason && !knownTerminalReasons.has(state.terminal_reason)) {
      throw new Error(`Unknown learner loop terminal reason ${state.terminal_reason}`);
    }

    if (state.submitted_answer_resolution) {
      if (
        !Number.isInteger(state.max_resolution_ms) ||
        state.max_resolution_ms <= 0 ||
        state.max_resolution_ms > contract.max_submitted_answer_resolution_ms
      ) {
        throw new Error(`Invalid submitted-answer bound for ${state.id}`);
      }
      const resolutionKey = state.terminal_reason ?? state.failure_class ?? state.id;
      if (resolutionKeys.has(resolutionKey)) {
        throw new Error(`Duplicate submitted-answer resolution key ${resolutionKey}`);
      }
      resolutionKeys.add(resolutionKey);
    }

    for (const cause of state.runtime_copy_causes) {
      if (!knownRuntimeCauses.has(cause)) {
        throw new Error(`Unknown runtime copy cause ${cause}`);
      }
      mappedRuntimeCauses.add(cause);
    }

    for (const field of state.operator_diagnostics) {
      if (!knownEvidenceFields.has(field)) {
        throw new Error(`Unknown learner loop evidence field ${field}`);
      }
    }
  }

  for (const cause of VIVA_RUNTIME_COPY_CAUSES) {
    if (!mappedRuntimeCauses.has(cause)) {
      throw new Error(`Unmapped runtime copy cause ${cause}`);
    }
  }

  return contract;
}

export const VIVA_LEARNER_LOOP_CONTRACT = validateLearnerLoopContract(
  contractData as LearnerLoopContract,
);

export const VIVA_LEARNER_LOOP_MAX_TURN_MS =
  VIVA_LEARNER_LOOP_CONTRACT.max_submitted_answer_resolution_ms;
