import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderLimiterReleaseEvidence,
  providerLimiterReleaseEvidence,
} from "./provider-limiter-evidence.mjs";

test("provider limiter release evidence is enabled and names admission proofs", () => {
  const evidence = providerLimiterReleaseEvidence({ env: {} });

  assert.equal(evidence.schema, "viva.provider_limiter.v1");
  assert.equal(evidence.enabled_for_release, true);
  assert.equal(evidence.required_event_kind, "provider_admission");
  assert.deepEqual(evidence.required_detail_fields, [
    "admission_decision",
    "queue_depth",
    "queue_delay_ms",
    "budget_state",
    "retry_after_ms",
    "reset_hint",
    "terminal_reason",
  ]);
  assert.equal(
    evidence.proved_by.agent_service_test,
    "websocket_provider_backoff_denies_next_answer_before_brain_input",
  );
  assertProviderLimiterReleaseEvidence(evidence);
});

test("provider limiter release evidence fails closed when disabled or incomplete", () => {
  assert.throws(
    () => providerLimiterReleaseEvidence({ env: { VIVA_PROVIDER_LIMITER_ENABLED: "0" } }),
    /provider limiter disabled/,
  );

  assert.throws(
    () =>
      assertProviderLimiterReleaseEvidence({
        schema: "viva.provider_limiter.v1",
        enabled_for_release: true,
        required_event_kind: "provider_admission",
        required_detail_fields: [],
        proved_by: {},
      }),
    /missing provider limiter evidence fields/,
  );
});
