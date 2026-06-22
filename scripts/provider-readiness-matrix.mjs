export const LIVE_PROVIDER_GATE_COMMAND_NAME = "live_provider_no_network_gate_tests";

export const PROVIDER_READINESS_TARGETS = Object.freeze([
  Object.freeze({
    provider: "synthetic",
    role: "default no-key synthetic brain",
    configuredWithPlaceholderKeys: false,
    dataGovernance: Object.freeze({
      external_provider_zero_retention_required: false,
      cartesia_zero_data_retention_enabled: false,
      gemini_zero_data_retention_approved: false,
      live_selectability_requires_zero_retention: false,
      source_document: "docs/data-governance.md",
    }),
    env: Object.freeze({}),
    expected: Object.freeze({
      health_http_status: 200,
      ready_http_status: 200,
      health_status: "configured",
      ready: true,
      brain: Object.freeze({
        configured: true,
        selectable: true,
        live_runtime: false,
      }),
    }),
  }),
  Object.freeze({
    provider: "fake_cartesia_gemini",
    role: "deterministic fake Cartesia/Gemini provider",
    configuredWithPlaceholderKeys: false,
    dataGovernance: Object.freeze({
      external_provider_zero_retention_required: false,
      cartesia_zero_data_retention_enabled: false,
      gemini_zero_data_retention_approved: false,
      live_selectability_requires_zero_retention: false,
      source_document: "docs/data-governance.md",
    }),
    env: Object.freeze({}),
    expected: Object.freeze({
      health_http_status: 200,
      ready_http_status: 200,
      health_status: "configured",
      ready: true,
      brain: Object.freeze({
        configured: true,
        selectable: true,
        live_runtime: false,
      }),
    }),
  }),
  Object.freeze({
    provider: "cartesia_gemini",
    role: "gated Act 3 live Cartesia/Gemini provider",
    configuredWithPlaceholderKeys: true,
    dataGovernance: Object.freeze({
      external_provider_zero_retention_required: true,
      cartesia_zero_data_retention_enabled: false,
      gemini_zero_data_retention_approved: false,
      live_selectability_requires_zero_retention: true,
      source_document: "docs/data-governance.md",
    }),
    env: Object.freeze({
      CARTESIA_API_KEY: "viva-release-check-cartesia-placeholder-key",
      GEMINI_API_KEY: "viva-release-check-gemini-placeholder-key",
    }),
    expected: Object.freeze({
      health_http_status: 200,
      ready_http_status: 503,
      health_status: "unavailable",
      ready: false,
      brain: Object.freeze({
        configured: true,
        selectable: false,
        live_runtime: false,
      }),
    }),
  }),
]);

const FORBIDDEN_EVIDENCE_MARKERS = Object.freeze([
  "pcm16_base64",
  "answer_text",
  "transcript_final",
  "source_context",
  "pasted_text",
  "session_token",
  "viva1.",
  "session-secret",
  "NADH donates high-energy electrons",
  "received 4 PCM16 bytes",
  "CARTESIA_API_KEY",
  "GEMINI_API_KEY",
  "viva-release-check-cartesia-placeholder-key",
  "viva-release-check-gemini-placeholder-key",
  "Bearer ",
]);

const LIVE_PROVIDER_GATE_PROOF = Object.freeze({
  provider: "cartesia_gemini",
  proved_by_command: LIVE_PROVIDER_GATE_COMMAND_NAME,
  expected_failure_before_network: true,
  provider_network_required: false,
  notes:
    "The gated live brain open path is covered by the adapter test filter `cartesia_gemini_brain`.",
});

export function buildProviderReadinessMatrix(endpointEvidence) {
  const evidenceByProvider = new Map(endpointEvidence.map((entry) => [entry.provider, entry]));
  const providers = PROVIDER_READINESS_TARGETS.map((target) => {
    const entry = evidenceByProvider.get(target.provider);
    if (!entry) {
      throw new Error(`missing provider readiness evidence for ${target.provider}`);
    }
    return buildProviderReadinessRow(target, entry);
  });

  const matrix = {
    schema: "viva.provider_readiness_matrix.v1",
    provider_order: PROVIDER_READINESS_TARGETS.map((target) => target.provider),
    live_open_attempt_before_network: { ...LIVE_PROVIDER_GATE_PROOF },
    providers,
  };
  assertNoForbiddenEvidenceMarkers(matrix);
  return matrix;
}

function buildProviderReadinessRow(target, entry) {
  const health = normalizeEndpointEvidence(entry.health_brain);
  const ready = normalizeEndpointEvidence(entry.ready);
  const observed = observedReadiness(target.provider, health, ready);
  const row = {
    provider: target.provider,
    role: target.role,
    configured_with_placeholder_keys: target.configuredWithPlaceholderKeys,
    key_values_recorded: false,
    data_governance: cloneJson(target.dataGovernance),
    expected: cloneJson(target.expected),
    observed,
    endpoints: {
      health_brain: health,
      ready,
    },
    live_open_attempt_before_network:
      target.provider === "cartesia_gemini" ? { ...LIVE_PROVIDER_GATE_PROOF } : null,
  };

  validateProviderReadinessRow(target, row);
  assertNoForbiddenEvidenceMarkers(row);
  return row;
}

function normalizeEndpointEvidence(endpoint) {
  if (!endpoint || typeof endpoint !== "object") {
    throw new Error("provider readiness endpoint evidence must be an object");
  }
  if (!Number.isInteger(endpoint.http_status)) {
    throw new Error("provider readiness endpoint evidence missing integer http_status");
  }
  if (!endpoint.body || typeof endpoint.body !== "object") {
    throw new Error("provider readiness endpoint evidence missing JSON body");
  }
  return {
    http_status: endpoint.http_status,
    body: cloneJson(endpoint.body),
  };
}

function observedReadiness(provider, health, ready) {
  const healthBrain = health.body.brain ?? {};
  const readyBrain = ready.body.brain ?? {};
  return {
    provider: healthBrain.provider ?? readyBrain.provider ?? null,
    health_provider: health.body.provider ?? null,
    health_status: health.body.status ?? null,
    ready: ready.body.ready === true,
    configured: healthBrain.configured === true && readyBrain.configured === true,
    selectable: healthBrain.selectable === true && readyBrain.selectable === true,
    live_runtime: healthBrain.live_runtime === true || readyBrain.live_runtime === true,
    store_available: health.body.store?.available === true && ready.body.store?.available === true,
    endpoint_flags_match:
      healthBrain.provider === provider &&
      readyBrain.provider === provider &&
      healthBrain.configured === readyBrain.configured &&
      healthBrain.selectable === readyBrain.selectable &&
      healthBrain.live_runtime === readyBrain.live_runtime,
  };
}

function validateProviderReadinessRow(target, row) {
  const health = row.endpoints.health_brain;
  const ready = row.endpoints.ready;
  const healthBrain = health.body.brain ?? {};
  const readyBrain = ready.body.brain ?? {};
  const expectedBrain = target.expected.brain;
  const errors = [];

  expectEqual(errors, "health http status", health.http_status, target.expected.health_http_status);
  expectEqual(errors, "ready http status", ready.http_status, target.expected.ready_http_status);
  expectEqual(errors, "health provider", health.body.provider, target.provider);
  expectEqual(errors, "health brain provider", healthBrain.provider, target.provider);
  expectEqual(errors, "ready brain provider", readyBrain.provider, target.provider);
  expectEqual(errors, "health status", health.body.status, target.expected.health_status);
  expectEqual(errors, "ready body flag", ready.body.ready, target.expected.ready);

  for (const flag of ["configured", "selectable", "live_runtime"]) {
    expectEqual(errors, `health brain ${flag}`, healthBrain[flag], expectedBrain[flag]);
    expectEqual(errors, `ready brain ${flag}`, readyBrain[flag], expectedBrain[flag]);
  }

  expectEqual(errors, "health store available", health.body.store?.available, true);
  expectEqual(errors, "ready store available", ready.body.store?.available, true);
  expectEqual(errors, "endpoint flags match", row.observed.endpoint_flags_match, true);

  if (target.configuredWithPlaceholderKeys) {
    expectEqual(errors, "placeholder keys configured", row.observed.configured, true);
    expectEqual(errors, "placeholder keys not selectable", row.observed.selectable, false);
    expectEqual(errors, "placeholder keys not live runtime", row.observed.live_runtime, false);
    expectEqual(
      errors,
      "live provider gate command",
      row.live_open_attempt_before_network?.proved_by_command,
      LIVE_PROVIDER_GATE_COMMAND_NAME,
    );
    expectEqual(
      errors,
      "live provider network requirement",
      row.live_open_attempt_before_network?.provider_network_required,
      false,
    );
    expectEqual(
      errors,
      "live provider zero retention required",
      row.data_governance.external_provider_zero_retention_required,
      true,
    );
    expectEqual(
      errors,
      "live provider Cartesia ZDR not asserted by placeholder evidence",
      row.data_governance.cartesia_zero_data_retention_enabled,
      false,
    );
    expectEqual(
      errors,
      "live provider Gemini ZDR not asserted by placeholder evidence",
      row.data_governance.gemini_zero_data_retention_approved,
      false,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `provider readiness evidence mismatch for ${target.provider}: ${errors.join("; ")}`,
    );
  }
}

function expectEqual(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

function assertNoForbiddenEvidenceMarkers(value) {
  const serialized = JSON.stringify(value);
  for (const needle of FORBIDDEN_EVIDENCE_MARKERS) {
    if (serialized.includes(needle)) {
      throw new Error(`provider readiness evidence includes forbidden payload marker: ${needle}`);
    }
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
