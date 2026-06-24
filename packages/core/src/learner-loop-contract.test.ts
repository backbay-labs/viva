import { describe, expect, test } from "bun:test";
import {
  VIVA_LEARNER_LOOP_CONTRACT,
  VIVA_LEARNER_LOOP_EVIDENCE_FIELDS,
  VIVA_LEARNER_LOOP_MAX_TURN_MS,
  VIVA_RUNTIME_COPY_CAUSES,
  validateLearnerLoopContract,
} from "./learner-loop-contract";

const REQUIRED_STATE_IDS = Object.freeze([
  "pre_loop_upload",
  "pre_loop_ingestion",
  "pre_loop_session_creation",
  "happy_feedback",
  "retry_prompt",
  "saved_pending_evaluation",
  "deterministic_partial_recap",
  "durability_degraded",
  "provider_auth_failure",
  "provider_rate_limit",
  "provider_timeout",
  "malformed_stream",
  "tool_executor_failure",
  "network_disconnect",
  "invalid_expired_replayed_token",
  "back_forward_stale_session",
  "refresh",
  "bfcache_restore",
  "double_submit",
  "mic_unavailable",
  "typed_fallback",
  "deploy_drain",
  "rollback",
]);

const REQUIRED_EVIDENCE_FIELDS = Object.freeze([
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
]);

describe("BAC-510 learner loop contract", () => {
  test("defines the complete failure taxonomy and learner-safe state table", () => {
    expect(VIVA_LEARNER_LOOP_CONTRACT.schema).toBe("viva.learner_loop_contract.v1");
    expect(VIVA_LEARNER_LOOP_MAX_TURN_MS).toBe(45_000);
    expect(VIVA_LEARNER_LOOP_CONTRACT.max_submitted_answer_resolution_ms).toBe(
      VIVA_LEARNER_LOOP_MAX_TURN_MS,
    );

    const statesById = new Map(VIVA_LEARNER_LOOP_CONTRACT.states.map((state) => [state.id, state]));
    for (const stateId of REQUIRED_STATE_IDS) {
      expect(statesById.has(stateId)).toBe(true);
    }

    const durabilityDegraded = statesById.get("durability_degraded");
    expect(durabilityDegraded?.submitted_answer_resolution).toBe(true);
    expect(durabilityDegraded?.resolution_kind).toBe("terminal");
    expect(durabilityDegraded?.authority).toBe("durable_store_event");
    expect(durabilityDegraded?.failure_class).toBe("durability_degraded");
    expect(durabilityDegraded?.terminal_reason).toBe("durability_degraded");
    expect(durabilityDegraded?.failure_matrix).toBe(true);
    expect(durabilityDegraded?.smoke_terminal_reasons).toContain("readiness_store_unavailable");
    expect(durabilityDegraded?.learner_safe).toBe(true);

    for (const state of VIVA_LEARNER_LOOP_CONTRACT.states) {
      expect(state.learner_safe).toBe(true);
      expect(state.copy.capsule_label.length).toBeGreaterThan(0);
      expect(state.copy.primary_action_label.length).toBeGreaterThan(0);
      expect(state.operator_diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("bounds every submitted answer to exactly one authoritative resolution", () => {
    const submittedAnswerStates = VIVA_LEARNER_LOOP_CONTRACT.states.filter(
      (state) => state.submitted_answer_resolution,
    );
    expect(submittedAnswerStates.length).toBeGreaterThan(0);
    const resolutionKeys = new Set<string>();

    for (const state of submittedAnswerStates) {
      expect(state.max_resolution_ms).toBeLessThanOrEqual(VIVA_LEARNER_LOOP_MAX_TURN_MS);
      expect(state.authority).not.toBe("optimistic_ui");
      expect(state.authority).not.toBe("stale_header");
      expect(/^(success|recoverable|deferred|terminal)$/.test(state.resolution_kind)).toBe(true);
      const resolutionKey = state.terminal_reason ?? state.failure_class ?? state.id;
      expect(resolutionKey.length).toBeGreaterThan(0);
      expect(resolutionKeys.has(resolutionKey)).toBe(false);
      resolutionKeys.add(resolutionKey);
    }
  });

  test("keeps input-mode states distinct from submitted-answer resolutions", () => {
    const typedFallback = VIVA_LEARNER_LOOP_CONTRACT.states.find(
      (contractState) => contractState.id === "typed_fallback",
    );
    const authBootstrap = VIVA_LEARNER_LOOP_CONTRACT.states.find(
      (contractState) => contractState.id === "invalid_expired_replayed_token",
    );

    expect(typedFallback?.submitted_answer_resolution).toBe(false);
    expect(typedFallback?.max_resolution_ms).toBe(0);
    expect(authBootstrap?.submitted_answer_resolution).toBe(false);
    expect(authBootstrap?.max_resolution_ms).toBe(0);
  });

  test("bounds pre-loop service states with sanitized terminal reasons", () => {
    const preLoopStates = VIVA_LEARNER_LOOP_CONTRACT.states.filter(
      (state) => state.stage === "pre_loop",
    );

    expect(preLoopStates.map((state) => state.id).sort()).toEqual([
      "pre_loop_ingestion",
      "pre_loop_session_creation",
      "pre_loop_upload",
    ]);
    for (const state of preLoopStates) {
      expect(state.submitted_answer_resolution).toBe(false);
      expect(state.max_resolution_ms).toBeGreaterThan(0);
      expect(state.max_resolution_ms).toBeLessThanOrEqual(VIVA_LEARNER_LOOP_MAX_TURN_MS);
      expect(state.authority).toBe("pre_loop_service_event");
      expect(/^pre_loop_/.test(state.terminal_reason ?? "")).toBe(true);
      expect(state.operator_diagnostics).toContain("terminal_reason");
      expect(state.operator_diagnostics).toContain("failure_class");
      expect(state.operator_diagnostics).toContain("stage");
    }
  });

  test("every terminal learner state has a protocol terminal reason", () => {
    const terminalStates = VIVA_LEARNER_LOOP_CONTRACT.states.filter(
      (state) => state.resolution_kind === "terminal",
    );

    for (const state of terminalStates) {
      expect(state.terminal_reason?.length ?? 0).toBeGreaterThan(0);
    }
    expect(terminalStates.some((state) => state.terminal_reason === "rollback")).toBe(true);
  });

  test("runtime validation rejects contract drift", () => {
    expect(() =>
      validateLearnerLoopContract({
        ...VIVA_LEARNER_LOOP_CONTRACT,
        states: [...VIVA_LEARNER_LOOP_CONTRACT.states, { ...VIVA_LEARNER_LOOP_CONTRACT.states[0] }],
      }),
    ).toThrow("Duplicate learner loop state id");

    expect(() =>
      validateLearnerLoopContract({
        ...VIVA_LEARNER_LOOP_CONTRACT,
        states: VIVA_LEARNER_LOOP_CONTRACT.states.map((state) =>
          state.id === "rollback" ? { ...state, terminal_reason: undefined } : state,
        ),
      }),
    ).toThrow("Terminal learner loop state rollback is missing terminal_reason");

    expect(() =>
      validateLearnerLoopContract({
        ...VIVA_LEARNER_LOOP_CONTRACT,
        states: VIVA_LEARNER_LOOP_CONTRACT.states.map((state) =>
          state.id === "rollback" ? { ...state, terminal_reason: "roll_back" as never } : state,
        ),
      }),
    ).toThrow("Unknown learner loop terminal reason roll_back");
  });

  test("names required evidence fields without forbidden raw payload fields", () => {
    expect(VIVA_LEARNER_LOOP_EVIDENCE_FIELDS).toEqual([...REQUIRED_EVIDENCE_FIELDS]);

    const serialized = JSON.stringify(VIVA_LEARNER_LOOP_CONTRACT);
    for (const forbidden of [
      "pcm16_base64",
      "answer_text",
      "transcript",
      "raw_prompt",
      "provider_prompt",
      "source_excerpt",
      "source_context",
      "session_token",
      "bearer",
      "CARTESIA_API_KEY",
      "GEMINI_API_KEY",
      "secret",
    ]) {
      expect(new RegExp(forbidden, "i").test(serialized)).toBe(false);
    }
  });

  test("keeps provider rate limit learner copy retry-timed without provider internals", () => {
    const providerRateLimit = VIVA_LEARNER_LOOP_CONTRACT.states.find(
      (state) => state.id === "provider_rate_limit",
    );
    expect(providerRateLimit?.terminal_reason).toBe("provider_rate_limited");

    const copyText = Object.values(providerRateLimit?.copy ?? {}).join(" ");
    expect(/retry/i.test(copyText)).toBe(true);
    expect(/wait window/i.test(copyText)).toBe(true);
    expect(/\b(provider|quota|429|gemini|cartesia)\b/i.test(copyText)).toBe(false);
  });

  test("reconciles every runtime copy cause with a learner-loop state", () => {
    const contractCauses = new Set(
      VIVA_LEARNER_LOOP_CONTRACT.states.flatMap((state) => state.runtime_copy_causes),
    );

    for (const cause of VIVA_RUNTIME_COPY_CAUSES) {
      expect(contractCauses.has(cause)).toBe(true);
    }
  });
});
