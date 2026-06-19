const MATRIX_SCHEMA = "viva.live_provider_failure_matrix.v1";

function terminalSessionPhase(terminalReason) {
  return Object.freeze({
    type: "session_phase",
    phase: "recap",
    terminal_reason: terminalReason,
  });
}

export const LIVE_PROVIDER_FAILURE_MATRIX = Object.freeze([
  Object.freeze({
    failure_class: "provider_auth_failure",
    stage: "readiness",
    terminal_reason: "provider_auth_failed",
    terminal_session_phase: terminalSessionPhase("provider_auth_failed"),
    evidence_code: "provider_access_denied",
    readiness_failure_kind: "access_denied",
    sanitized_evidence: true,
    user_copy: Object.freeze({
      capsule_label: "Provider auth failed",
      marginalia_title: "Live provider access was denied.",
      marginalia_text:
        "The live provider rejected access before the manuscript could open a trusted turn.",
      next_action_label: "Check provider access",
      primary_action_intent: "retry_agent",
      status_label: "provider auth failed",
    }),
    smoke_terminal_reasons: Object.freeze([
      "bootstrap_failed",
      "configuration_error",
      "readiness_not_live_selectable",
    ]),
  }),
  Object.freeze({
    failure_class: "quota_rate_failure",
    stage: "provider",
    terminal_reason: "provider_rate_limited",
    terminal_session_phase: terminalSessionPhase("provider_rate_limited"),
    evidence_code: "provider_rate_limited",
    readiness_failure_kind: "dependency_unavailable",
    sanitized_evidence: true,
    user_copy: Object.freeze({
      capsule_label: "Provider rate limited",
      marginalia_title: "Live provider quota stopped this turn.",
      marginalia_text:
        "The provider quota or rate limit closed the manuscript before a complete live response.",
      next_action_label: "Retry after quota resets",
      primary_action_intent: "retry_agent",
      status_label: "provider rate limited",
    }),
    smoke_terminal_reasons: Object.freeze([
      "cost_budget",
      "provider_rate_limited",
      "provider_quota_exceeded",
      "quota_rate_failure",
      "rate_limit",
    ]),
  }),
  Object.freeze({
    failure_class: "timeout",
    stage: "websocket",
    terminal_reason: "provider_timeout",
    terminal_session_phase: terminalSessionPhase("provider_timeout"),
    evidence_code: "provider_timeout",
    readiness_failure_kind: "dependency_unavailable",
    sanitized_evidence: true,
    user_copy: Object.freeze({
      capsule_label: "Provider timeout",
      marginalia_title: "Live provider timed out.",
      marginalia_text:
        "The live stream did not reach the next required stage within the configured cap.",
      next_action_label: "Retry agent",
      primary_action_intent: "retry_agent",
      status_label: "provider timeout",
    }),
    smoke_terminal_reasons: Object.freeze([
      "question_event_timeout",
      "ready_frame_timeout",
      "recap_timeout",
      "socket_open_timeout",
    ]),
  }),
  Object.freeze({
    failure_class: "malformed_stream",
    stage: "websocket",
    terminal_reason: "provider_malformed_stream",
    terminal_session_phase: terminalSessionPhase("provider_malformed_stream"),
    evidence_code: "provider_malformed_stream",
    readiness_failure_kind: "dependency_unavailable",
    sanitized_evidence: true,
    user_copy: Object.freeze({
      capsule_label: "Provider stream failed",
      marginalia_title: "Live provider stream was malformed.",
      marginalia_text:
        "The stream produced an invalid or structured error frame, so Viva closed it without retaining provider contents.",
      next_action_label: "Retry agent",
      primary_action_intent: "retry_agent",
      status_label: "provider stream failed",
    }),
    smoke_terminal_reasons: Object.freeze([
      "invalid_server_frame",
      "server_error_frame",
      "structured_error",
      "unknown_event",
    ]),
  }),
  Object.freeze({
    failure_class: "network_disconnect",
    stage: "transport",
    terminal_reason: "provider_network_disconnect",
    terminal_session_phase: terminalSessionPhase("provider_network_disconnect"),
    evidence_code: "provider_network_disconnect",
    readiness_failure_kind: "dependency_unavailable",
    sanitized_evidence: true,
    user_copy: Object.freeze({
      capsule_label: "Provider disconnected",
      marginalia_title: "Live provider connection dropped.",
      marginalia_text:
        "The provider transport disconnected before the manuscript received a complete terminal phase.",
      next_action_label: "Retry agent",
      primary_action_intent: "retry_agent",
      status_label: "provider disconnected",
    }),
    smoke_terminal_reasons: Object.freeze([
      "readiness_unavailable",
      "socket_closed_before_recap",
      "socket_error",
      "websocket_failed",
    ]),
  }),
  Object.freeze({
    failure_class: "slow_client",
    stage: "client",
    terminal_reason: "slow_client",
    terminal_session_phase: terminalSessionPhase("slow_client"),
    evidence_code: "slow_client",
    readiness_failure_kind: "dependency_unavailable",
    sanitized_evidence: true,
    user_copy: Object.freeze({
      capsule_label: "Client too slow",
      marginalia_title: "The client missed the live-turn cap.",
      marginalia_text:
        "The client did not finish the live turn within the configured turn or audio cap.",
      next_action_label: "Start a new session",
      primary_action_intent: "start_session",
      status_label: "client too slow",
    }),
    smoke_terminal_reasons: Object.freeze(["audio_input_unavailable", "turn_cap_exceeded"]),
  }),
  Object.freeze({
    failure_class: "cancellation",
    stage: "provider",
    terminal_reason: "provider_cancelled",
    terminal_session_phase: terminalSessionPhase("provider_cancelled"),
    evidence_code: "provider_cancelled",
    readiness_failure_kind: "dependency_unavailable",
    sanitized_evidence: true,
    user_copy: Object.freeze({
      capsule_label: "Provider cancelled",
      marginalia_title: "Live provider cancelled the turn.",
      marginalia_text:
        "The live response was cancelled before Viva could produce a complete recap.",
      next_action_label: "Start a new session",
      primary_action_intent: "start_session",
      status_label: "provider cancelled",
    }),
    smoke_terminal_reasons: Object.freeze(["cancellation", "client_stop", "provider_cancelled"]),
  }),
  Object.freeze({
    failure_class: "partial_stage_success",
    stage: "websocket",
    terminal_reason: "partial_stage_success",
    terminal_session_phase: terminalSessionPhase("partial_stage_success"),
    evidence_code: "partial_stage_success",
    readiness_failure_kind: "dependency_unavailable",
    sanitized_evidence: true,
    user_copy: Object.freeze({
      capsule_label: "Partial live result",
      marginalia_title: "Live provider reached only part of the turn.",
      marginalia_text:
        "The stream reached a later stage but missed at least one required live-smoke proof event.",
      next_action_label: "Review partial recap",
      primary_action_intent: "start_session",
      status_label: "partial live result",
    }),
    smoke_terminal_reasons: Object.freeze(["recap_observed"]),
  }),
]);

const failuresByTerminalReason = new Map(
  LIVE_PROVIDER_FAILURE_MATRIX.map((entry) => [entry.terminal_reason, entry]),
);

const failuresBySmokeReason = new Map(
  LIVE_PROVIDER_FAILURE_MATRIX.flatMap((entry) =>
    entry.smoke_terminal_reasons.map((reason) => [reason, entry]),
  ),
);

export function liveProviderFailureForTerminalReason(terminalReason) {
  return failuresByTerminalReason.get(terminalReason) ?? null;
}

export function liveProviderFailureForSmokeReason(smokeReason) {
  return (
    failuresBySmokeReason.get(smokeReason) ??
    liveProviderFailureForTerminalReason(smokeReason) ??
    failuresBySmokeReason.get("websocket_failed")
  );
}

export function failureMatrixEvidence() {
  return {
    schema: MATRIX_SCHEMA,
    entries: LIVE_PROVIDER_FAILURE_MATRIX.map(({ smoke_terminal_reasons: _ignored, ...entry }) => ({
      ...entry,
    })),
  };
}
