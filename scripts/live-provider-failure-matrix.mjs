import learnerLoopContract from "../packages/core/src/learner-loop-contract.json" with {
  type: "json",
};

const MATRIX_SCHEMA = "viva.live_provider_failure_matrix.v1";

function terminalSessionPhase(terminalReason) {
  return Object.freeze({
    type: "session_phase",
    phase: "recap",
    terminal_reason: terminalReason,
  });
}

export const LIVE_PROVIDER_FAILURE_MATRIX = Object.freeze(
  learnerLoopContract.states
    .filter((state) => state.failure_matrix === true)
    .map((state) =>
      Object.freeze({
        failure_class: state.failure_class,
        stage: state.stage,
        terminal_reason: state.terminal_reason,
        terminal_session_phase: terminalSessionPhase(state.terminal_reason),
        evidence_code: state.evidence_code,
        readiness_failure_kind: state.readiness_failure_kind,
        sanitized_evidence: state.sanitized_evidence,
        user_copy: Object.freeze({
          capsule_label: state.copy.capsule_label,
          marginalia_title: state.copy.marginalia_title,
          marginalia_text: state.copy.marginalia_text,
          next_action_label: state.copy.next_action_label,
          primary_action_intent: state.copy.primary_action_intent,
          status_label: state.copy.status_label,
        }),
        smoke_terminal_reasons: Object.freeze(state.smoke_terminal_reasons ?? []),
      }),
    ),
);

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
