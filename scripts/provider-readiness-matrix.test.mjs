import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderReadinessMatrix,
  PROVIDER_READINESS_TARGETS,
} from "./provider-readiness-matrix.mjs";

test("provider readiness targets cover synthetic, fake, and gated live providers", () => {
  assert.deepEqual(
    PROVIDER_READINESS_TARGETS.map((target) => target.provider),
    ["synthetic", "fake_cartesia_gemini", "cartesia_gemini"],
  );
});

test("provider readiness matrix keeps gated live configured but not selectable", () => {
  const matrix = buildProviderReadinessMatrix([
    {
      provider: "synthetic",
      health_brain: {
        http_status: 200,
        body: endpointBody("synthetic", {
          configured: true,
          selectable: true,
          live_runtime: false,
          status: "configured",
        }),
      },
      ready: {
        http_status: 200,
        body: readyBody("synthetic", {
          ready: true,
          configured: true,
          selectable: true,
          live_runtime: false,
        }),
      },
    },
    {
      provider: "fake_cartesia_gemini",
      health_brain: {
        http_status: 200,
        body: endpointBody("fake_cartesia_gemini", {
          configured: true,
          selectable: true,
          live_runtime: false,
          status: "configured",
        }),
      },
      ready: {
        http_status: 200,
        body: readyBody("fake_cartesia_gemini", {
          ready: true,
          configured: true,
          selectable: true,
          live_runtime: false,
        }),
      },
    },
    {
      provider: "cartesia_gemini",
      health_brain: {
        http_status: 200,
        body: endpointBody("cartesia_gemini", {
          configured: true,
          selectable: false,
          live_runtime: false,
          status: "unavailable",
        }),
      },
      ready: {
        http_status: 503,
        body: readyBody("cartesia_gemini", {
          ready: false,
          configured: true,
          selectable: false,
          live_runtime: false,
        }),
      },
    },
  ]);

  assert.equal(matrix.schema, "viva.provider_readiness_matrix.v1");
  assert.equal(matrix.providers.length, 3);

  const live = matrix.providers.find((row) => row.provider === "cartesia_gemini");
  assert.equal(live.configured_with_placeholder_keys, true);
  assert.equal(live.expected.ready_http_status, 503);
  assert.equal(live.observed.ready, false);
  assert.equal(live.observed.configured, true);
  assert.equal(live.observed.selectable, false);
  assert.equal(live.observed.live_runtime, false);
  assert.equal(live.data_governance.external_provider_zero_retention_required, true);
  assert.equal(live.data_governance.cartesia_zero_data_retention_enabled, false);
  assert.equal(live.data_governance.gemini_zero_data_retention_approved, false);
  assert.equal(live.data_governance.live_selectability_requires_zero_retention, true);
  assert.equal(
    live.live_open_attempt_before_network.proved_by_command,
    "live_provider_no_network_gate_tests",
  );
  assert.equal(live.live_open_attempt_before_network.provider_network_required, false);
});

test("provider readiness matrix rejects leaked key material", () => {
  const safeSyntheticEvidence = {
    provider: "synthetic",
    health_brain: {
      http_status: 200,
      body: endpointBody("synthetic", {
        configured: true,
        selectable: true,
        live_runtime: false,
        status: "configured",
      }),
    },
    ready: {
      http_status: 200,
      body: readyBody("synthetic", {
        ready: true,
        configured: true,
        selectable: true,
        live_runtime: false,
      }),
    },
  };

  assert.throws(
    () =>
      buildProviderReadinessMatrix([
        {
          ...safeSyntheticEvidence,
          ready: {
            http_status: 200,
            body: {
              ...safeSyntheticEvidence.ready.body,
              leaked: "CARTESIA_API_KEY=not-evidence",
            },
          },
        },
      ]),
    /forbidden payload marker/,
  );

  assert.throws(
    () =>
      buildProviderReadinessMatrix([
        {
          ...safeSyntheticEvidence,
          ready: {
            http_status: 200,
            body: {
              ...safeSyntheticEvidence.ready.body,
              leaked: "viva-release-check-cartesia-placeholder-key",
            },
          },
        },
      ]),
    /forbidden payload marker/,
  );
});

function endpointBody(provider, { configured, selectable, live_runtime, status }) {
  return {
    provider,
    brain: {
      provider,
      configured,
      selectable,
      live_runtime,
    },
    status,
    store: storeBody(),
    usage: {
      events: 0,
    },
  };
}

function readyBody(provider, { ready, configured, selectable, live_runtime }) {
  return {
    ready,
    brain: {
      provider,
      configured,
      selectable,
      live_runtime,
    },
    store: storeBody(),
  };
}

function storeBody() {
  return {
    backend: "in_memory",
    available: true,
    durable: false,
    raw_audio_persistence: false,
    transcript_persistence: false,
    uuid_schema_translation: false,
    writes: {
      sessions: 0,
      answer_attempts: 0,
      concept_statuses: 0,
      review_items: 0,
      recaps: 0,
    },
  };
}
