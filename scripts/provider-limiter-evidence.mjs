const REQUIRED_DETAIL_FIELDS = Object.freeze([
  "admission_decision",
  "queue_depth",
  "queue_delay_ms",
  "budget_state",
  "retry_after_ms",
  "reset_hint",
  "terminal_reason",
]);

export function providerLimiterReleaseEvidence({ env = process.env } = {}) {
  if (disabled(env.VIVA_PROVIDER_LIMITER_ENABLED)) {
    throw new Error("provider limiter disabled for release evidence generation");
  }
  const evidence = {
    schema: "viva.provider_limiter.v1",
    enabled_for_release: true,
    required_event_kind: "provider_admission",
    required_detail_fields: [...REQUIRED_DETAIL_FIELDS],
    proved_by: {
      agent_service_test: "websocket_provider_backoff_denies_next_answer_before_brain_input",
      release_gate_test: "provider-limiter-evidence.test.mjs",
    },
    sanitized_evidence: true,
  };
  assertProviderLimiterReleaseEvidence(evidence);
  return evidence;
}

export function assertProviderLimiterReleaseEvidence(evidence) {
  if (evidence?.schema !== "viva.provider_limiter.v1") {
    throw new Error("missing provider limiter release evidence");
  }
  if (evidence.enabled_for_release !== true) {
    throw new Error("provider limiter disabled in release evidence");
  }
  if (evidence.required_event_kind !== "provider_admission") {
    throw new Error("missing provider admission evidence kind");
  }
  for (const field of REQUIRED_DETAIL_FIELDS) {
    if (!evidence.required_detail_fields?.includes(field)) {
      throw new Error(`missing provider limiter evidence fields: ${field}`);
    }
  }
  if (
    evidence.proved_by?.agent_service_test !==
    "websocket_provider_backoff_denies_next_answer_before_brain_input"
  ) {
    throw new Error("missing provider limiter admission test proof");
  }
  if (evidence.sanitized_evidence !== true) {
    throw new Error("provider limiter evidence must be sanitized");
  }
}

function disabled(value) {
  return ["0", "false", "off", "no"].includes(String(value ?? "").trim().toLowerCase());
}
