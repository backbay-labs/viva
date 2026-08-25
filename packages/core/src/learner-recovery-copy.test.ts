import { describe, expect, test } from "bun:test";
import {
  type LearnerLoopState,
  VIVA_LEARNER_LOOP_CONTRACT,
  VIVA_LEARNER_LOOP_EVIDENCE_FIELDS,
} from "./learner-loop-contract";
import {
  learnerRecoveryCopyEntry,
  learnerRecoveryCopyForState,
  VIVA_LEARNER_RECOVERY_COPY_CONTRACT,
} from "./learner-recovery-copy";

const EVIDENCE_COPY_STATE_IDS = Object.freeze([
  "provider_rate_limit",
  "provider_timeout",
  "provider_auth_failure",
  "invalid_expired_replayed_token",
  "mic_unavailable",
  "deploy_drain",
]);

const REFRESH_SESSION_STATE_IDS = Object.freeze([
  "invalid_expired_replayed_token",
  "back_forward_stale_session",
  "refresh",
  "bfcache_restore",
]);

const FORBIDDEN_LEARNER_COPY_PATTERNS = Object.freeze([
  /\bterminal_reason\b/i,
  /\bfailure_class\b/i,
  /\bdeploy_sha\b/i,
  /\blatency_ms\b/i,
  /\bcost_usd\b/i,
  /\btoken_refresh_outcome\b/i,
  /\brecap_success\b/i,
  /\bhttp\s*429\b/i,
  /\bgemini_http_429\b/i,
  /\bquota\b/i,
  /\bprovider response\b/i,
  /\bresponse body\b/i,
  /\braw payload\b/i,
  /\braw answer\b/i,
  /\banswer_text\b/i,
  /\btranscript\b/i,
  /\bsource excerpt\b/i,
  /\bsource_context\b/i,
  /\bprovider_prompt\b/i,
  /\bstack trace\b/i,
  /\btraceback\b/i,
  /\binvalid_signature\b/i,
  /\bidentity_mismatch\b/i,
  /\bsession_token\b/i,
  /\bbearer\b/i,
  /\bviva1\./i,
  /\bCARTESIA_API_KEY\b/i,
  /\bGEMINI_API_KEY\b/i,
  /\bsecret\b/i,
]);

function learnerCopyText(stateId: string): string {
  const entry = learnerRecoveryCopyForState(stateId);
  if (!entry) return "";
  return [
    entry.learner.capsule_label,
    entry.learner.marginalia_title,
    entry.learner.marginalia_text,
    entry.learner.status_label,
    entry.learner.primary_action.label,
    entry.learner.secondary_action.label,
  ].join(" ");
}

describe("BAC-523 learner recovery copy contract", () => {
  test("maps every BAC-510 state into one learner/operator recovery entry", () => {
    expect(VIVA_LEARNER_RECOVERY_COPY_CONTRACT.schema).toBe("viva.learner_recovery_copy.v1");
    expect(VIVA_LEARNER_RECOVERY_COPY_CONTRACT.source_schema).toBe(
      VIVA_LEARNER_LOOP_CONTRACT.schema,
    );

    const contractStateIds = VIVA_LEARNER_LOOP_CONTRACT.states.map((state) => state.id);
    const recoveryStateIds = VIVA_LEARNER_RECOVERY_COPY_CONTRACT.states.map(
      (state) => state.state_id,
    );

    expect(recoveryStateIds).toEqual(contractStateIds);
    expect(new Set(recoveryStateIds).size).toBe(recoveryStateIds.length);
  });

  test("defines learner copy, primary action, secondary action, and operator diagnostics separately", () => {
    const knownEvidenceFields = new Set(VIVA_LEARNER_LOOP_EVIDENCE_FIELDS);

    for (const entry of VIVA_LEARNER_RECOVERY_COPY_CONTRACT.states) {
      expect(entry.learner.capsule_label.length).toBeGreaterThan(0);
      expect(entry.learner.marginalia_title.length).toBeGreaterThan(0);
      expect(entry.learner.marginalia_text.length).toBeGreaterThan(0);
      expect(entry.learner.status_label.length).toBeGreaterThan(0);
      expect(entry.learner.primary_action.label.length).toBeGreaterThan(0);
      expect(entry.learner.secondary_action.label.length).toBeGreaterThan(0);
      expect(entry.learner.primary_action.intent.length).toBeGreaterThan(0);
      expect(entry.learner.secondary_action.intent.length).toBeGreaterThan(0);
      expect("diagnostic_fields" in entry.learner).toBe(false);
      expect("capsule_label" in entry.operator).toBe(false);
      expect(entry.operator.stage.length).toBeGreaterThan(0);
      expect(entry.operator.diagnostic_fields.length).toBeGreaterThan(0);
      for (const field of entry.operator.diagnostic_fields) {
        expect(knownEvidenceFields.has(field)).toBe(true);
      }
    }
  });

  test("keeps operator-only and raw payload terms out of learner-visible copy", () => {
    for (const entry of VIVA_LEARNER_RECOVERY_COPY_CONTRACT.states) {
      const text = learnerCopyText(entry.state_id);
      for (const forbidden of FORBIDDEN_LEARNER_COPY_PATTERNS) {
        expect(forbidden.test(text)).toBe(false);
      }
    }
  });

  test("covers the required evidence screenshot classes with learner copy and diagnostics", () => {
    for (const stateId of EVIDENCE_COPY_STATE_IDS) {
      const entry = learnerRecoveryCopyForState(stateId);
      expect(entry).not.toBeUndefined();
      expect(learnerCopyText(stateId).length).toBeGreaterThan(0);
      expect(entry?.operator.diagnostic_fields.length ?? 0).toBeGreaterThan(0);
    }

    expect(
      learnerRecoveryCopyForState("provider_rate_limit")?.operator.diagnostic_fields,
    ).toContain("usage");
    expect(
      learnerRecoveryCopyForState("invalid_expired_replayed_token")?.operator.diagnostic_fields,
    ).toContain("token_refresh_outcome");
    expect(learnerRecoveryCopyForState("deploy_drain")?.operator.terminal_reason).toBe("drained");
  });

  test("saved pending evaluation has a concrete non-dead-end next action", () => {
    const entry = learnerRecoveryCopyForState("saved_pending_evaluation");
    expect(entry?.learner.primary_action.intent).toBe("start_session");
    expect(entry?.learner.secondary_action.intent).toBe("start_session");
    expect(entry?.learner.primary_action.label).toBe("Start a fresh question");
    expect(entry?.learner.secondary_action.label).toBe("Start a fresh question");
    expect(
      /check later|come back later|wait until later/i.test(
        learnerCopyText("saved_pending_evaluation"),
      ),
    ).toBe(false);
  });

  test("session credential recovery states preserve refresh-session intent", () => {
    for (const stateId of REFRESH_SESSION_STATE_IDS) {
      const entry = learnerRecoveryCopyForState(stateId);
      expect(entry?.learner.primary_action.label).toBe("Refresh session");
      expect(entry?.learner.primary_action.intent).toBe("refresh_session");
      expect(entry?.learner.secondary_action.label).toBe("Refresh session");
      expect(entry?.learner.secondary_action.intent).toBe("refresh_session");
    }
  });
});

/**
 * `LEARN-006` — the secondary action carries the state's own next-action intent.
 *
 * Reusing `primary_action_intent` for both buttons silently rewrites what the
 * second button does. The synthetic entry below is the only honest way to see
 * that: it is the one state whose two intents differ, so a validator that reads
 * the wrong field cannot pass by coincidence.
 */
describe("LEARN-006 recovery actions keep distinct intents", () => {
  test("derives every secondary action from next_action_label and next_action_intent", () => {
    for (const state of VIVA_LEARNER_LOOP_CONTRACT.states) {
      const entry = learnerRecoveryCopyForState(state.id);
      expect(entry?.learner.primary_action.label).toBe(state.copy.primary_action_label);
      expect(entry?.learner.primary_action.intent).toBe(state.copy.primary_action_intent);
      expect(entry?.learner.secondary_action.label).toBe(state.copy.next_action_label);
      expect(entry?.learner.secondary_action.intent).toBe(state.copy.next_action_intent);
    }
  });

  test("keeps a retry_agent primary and a disabled next action distinct", () => {
    const source = VIVA_LEARNER_LOOP_CONTRACT.states.find(
      (state) => state.id === "provider_timeout",
    );
    expect(source).not.toBeUndefined();
    if (!source) return;

    const entry = learnerRecoveryCopyEntry({
      ...source,
      copy: {
        ...source.copy,
        next_action_label: "Wait for result",
        next_action_intent: "disabled",
        primary_action_label: "Retry agent",
        primary_action_intent: "retry_agent",
      },
    });

    expect(entry.learner.primary_action).toEqual({ label: "Retry agent", intent: "retry_agent" });
    expect(entry.learner.secondary_action).toEqual({
      label: "Wait for result",
      intent: "disabled",
    });
    expect(entry.learner.secondary_action.intent).not.toBe(entry.learner.primary_action.intent);
  });
});

/**
 * `LEARN-007` — completion copy is a success, not a recovery from a disconnect.
 */
describe("LEARN-007 session completion recovery copy", () => {
  test("offers a new session and never reads as a failure", () => {
    const entry = learnerRecoveryCopyForState("session_completed");

    expect(entry).not.toBeUndefined();
    expect(entry?.resolution_kind).toBe("success");
    expect(entry?.submitted_answer_resolution).toBe(true);
    expect(entry?.runtime_copy_causes).toEqual(["recap_success"]);
    expect(entry?.learner.capsule_label).toBe("Session complete");
    expect(entry?.learner.marginalia_title).toBe("Session recap ready.");
    expect(entry?.learner.status_label).toBe("session complete");
    expect(entry?.learner.primary_action).toEqual({
      label: "Start a new session",
      intent: "start_session",
    });
    expect(entry?.learner.secondary_action).toEqual({
      label: "Start a new session",
      intent: "start_session",
    });
    expect(entry?.operator.stage).toBe("recap");
    expect(entry?.operator.diagnostic_fields).toEqual(["stage", "deploy_sha", "recap_success"]);
    expect(entry?.operator.terminal_reason).toBeUndefined();
    expect(entry?.operator.failure_class).toBeUndefined();

    const text = learnerCopyText("session_completed");
    expect(text.length).toBeGreaterThan(0);
    expect(/disconnect|lost|failed|error|try again/i.test(text)).toBe(false);
    for (const forbidden of FORBIDDEN_LEARNER_COPY_PATTERNS) {
      expect(forbidden.test(text)).toBe(false);
    }
  });
});

/**
 * Assert that a write to deep-frozen data fails instead of silently succeeding.
 *
 * ES modules are always strict mode, so assigning to a frozen property — or
 * extending a frozen array — throws a `TypeError`. The engine's message differs
 * between assignment and extension, so the assertion is on the error type.
 */
function expectFrozenWrite(mutate: () => void): void {
  let thrown: unknown;
  try {
    mutate();
  } catch (error) {
    thrown = error;
  }
  expect(thrown instanceof TypeError ? "TypeError" : String(thrown)).toBe("TypeError");
}

/**
 * `LEARN-010` — the recovery copy contract is derived, validated data.
 *
 * `Object.freeze` on the contract object alone left `states`, each entry, and
 * each learner action writable, so a consumer could rewrite the button label or
 * intent that every other consumer then renders. The copy is generated once from
 * the validated learner-loop contract; nothing downstream may edit it in place.
 */
describe("LEARN-010 the recovery copy contract is deeply immutable", () => {
  test("states, learner actions, and operator diagnostics cannot be rewritten", () => {
    const contract = VIVA_LEARNER_RECOVERY_COPY_CONTRACT;
    const before = JSON.stringify(contract);
    const first = contract.states[0];

    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.states)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expectFrozenWrite(() => {
      contract.states.push(first);
    });
    expectFrozenWrite(() => {
      first.learner.capsule_label = "rewritten";
    });
    expectFrozenWrite(() => {
      first.learner.primary_action.label = "rewritten";
    });
    expectFrozenWrite(() => {
      first.learner.secondary_action.intent = "disabled";
    });
    expectFrozenWrite(() => {
      first.operator.diagnostic_fields.push("stage");
    });
    expectFrozenWrite(() => {
      first.runtime_copy_causes.push("recap_success");
    });

    expect(JSON.stringify(contract)).toBe(before);
  });

  test("a freshly projected entry is frozen the same way", () => {
    const entry = learnerRecoveryCopyEntry(VIVA_LEARNER_LOOP_CONTRACT.states[0]);
    const before = JSON.stringify(entry);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.learner)).toBe(true);
    expect(Object.isFrozen(entry.operator)).toBe(true);
    expectFrozenWrite(() => {
      entry.state_label = "rewritten";
    });
    expectFrozenWrite(() => {
      entry.learner.primary_action.intent = "disabled";
    });

    expect(JSON.stringify(entry)).toBe(before);
  });

  test("the looked-up entry is the frozen contract entry, not a mutable copy", () => {
    const entry = learnerRecoveryCopyForState("durability_degraded");

    expect(entry).not.toBeUndefined();
    expect(Object.isFrozen(entry)).toBe(true);
  });

  /**
   * `LEARN-010` — the deep freeze is applied to reconstructed data only.
   *
   * `deepFreeze` documents that it "is never applied to caller-owned input",
   * and Step 3 scopes it to "only reconstructed validated data". Every other
   * field of the projected entry is rebuilt from scalars, but
   * `runtime_copy_causes` and `diagnostic_fields` were handed straight through
   * from the argument, so projecting a caller's state froze two arrays the
   * caller still owned. That is invisible while every in-repo caller passes an
   * already-frozen contract state, and a surprise the first time a caller
   * builds its own state and then cannot append to it.
   */
  test("projecting a caller-owned state does not freeze the caller's arrays", () => {
    const callerCauses: LearnerLoopState["runtime_copy_causes"] = ["live_runtime"];
    const callerDiagnostics: LearnerLoopState["operator_diagnostics"] = ["stage"];
    const callerState: LearnerLoopState = {
      id: "caller_owned_state",
      label: "Caller owned state",
      stage: "session_active",
      resolution_kind: "recoverable",
      submitted_answer_resolution: false,
      max_resolution_ms: 1_000,
      learner_safe: true,
      authority: "session_event",
      sanitized_evidence: true,
      runtime_copy_causes: callerCauses,
      copy: {
        capsule_label: "Caller capsule",
        marginalia_title: "Caller title",
        marginalia_text: "Caller text",
        next_action_label: "Caller next",
        next_action_intent: "disabled",
        primary_action_label: "Caller primary",
        primary_action_intent: "retry_agent",
        status_label: "Caller status",
      },
      operator_diagnostics: callerDiagnostics,
    };

    const entry = learnerRecoveryCopyEntry(callerState);

    expect(Object.isFrozen(callerCauses)).toBe(false);
    expect(Object.isFrozen(callerDiagnostics)).toBe(false);
    expect(entry.runtime_copy_causes).not.toBe(callerCauses);
    expect(entry.operator.diagnostic_fields).not.toBe(callerDiagnostics);
    expect(Object.isFrozen(entry.runtime_copy_causes)).toBe(true);
    expect(Object.isFrozen(entry.operator.diagnostic_fields)).toBe(true);
    expect([...entry.runtime_copy_causes]).toEqual(["live_runtime"]);
    expect([...entry.operator.diagnostic_fields]).toEqual(["stage"]);

    callerCauses.push("agent_offline");
    callerDiagnostics.push("provider");

    expect([...entry.runtime_copy_causes]).toEqual(["live_runtime"]);
    expect([...entry.operator.diagnostic_fields]).toEqual(["stage"]);
  });
});
