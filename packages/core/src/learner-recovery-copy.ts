import {
  deepFreeze,
  type LearnerLoopActionIntent,
  type LearnerLoopEvidenceField,
  type LearnerLoopResolutionKind,
  type LearnerLoopState,
  type LearnerLoopTerminalReason,
  type RuntimeCopyCause,
  VIVA_LEARNER_LOOP_CONTRACT,
} from "./learner-loop-contract";

export const VIVA_LEARNER_RECOVERY_COPY_SCHEMA = "viva.learner_recovery_copy.v1" as const;

export type LearnerRecoveryAction = {
  label: string;
  intent: LearnerLoopActionIntent;
};

export type LearnerRecoveryCopyEntry = {
  state_id: string;
  state_label: string;
  resolution_kind: LearnerLoopResolutionKind;
  submitted_answer_resolution: boolean;
  runtime_copy_causes: RuntimeCopyCause[];
  learner: {
    capsule_label: string;
    marginalia_title: string;
    marginalia_text: string;
    status_label: string;
    primary_action: LearnerRecoveryAction;
    secondary_action: LearnerRecoveryAction;
  };
  operator: {
    diagnostic_fields: LearnerLoopEvidenceField[];
    evidence_code?: string;
    failure_class?: string;
    readiness_failure_kind?: string;
    stage: string;
    terminal_reason?: LearnerLoopTerminalReason;
  };
};

export type LearnerRecoveryCopyContract = {
  schema: typeof VIVA_LEARNER_RECOVERY_COPY_SCHEMA;
  source_schema: typeof VIVA_LEARNER_LOOP_CONTRACT.schema;
  source_max_submitted_answer_resolution_ms: number;
  states: LearnerRecoveryCopyEntry[];
};

function learnerAction(label: string, intent: LearnerLoopActionIntent): LearnerRecoveryAction {
  return { label, intent };
}

/**
 * Project one validated learner-loop state into its recovery-copy entry.
 *
 * The secondary action reads `next_action_intent`, never
 * `primary_action_intent`: the two buttons are separate commands, and reusing
 * the primary intent silently rewrites what the second button does — a state
 * that offers `retry_agent` first and a deliberately `disabled` follow-up would
 * otherwise ship two retry buttons.
 *
 * The entry is deep-frozen for the same reason the source contract is: it is
 * derived copy, and a consumer that edits it in place changes what every other
 * consumer of the same entry renders.
 *
 * The two array fields are copied rather than aliased. Every other field is
 * rebuilt from a scalar, so passing the argument's arrays straight through was
 * the one path by which the freeze reached data the caller still owns —
 * `deepFreeze` is documented as never doing that. The copies also make the
 * entry a snapshot: appending to the caller's array afterwards cannot change
 * what an already-projected entry reports.
 */
export function learnerRecoveryCopyEntry(state: LearnerLoopState): LearnerRecoveryCopyEntry {
  return deepFreeze({
    state_id: state.id,
    state_label: state.label,
    resolution_kind: state.resolution_kind,
    submitted_answer_resolution: state.submitted_answer_resolution,
    runtime_copy_causes: [...state.runtime_copy_causes],
    learner: {
      capsule_label: state.copy.capsule_label,
      marginalia_title: state.copy.marginalia_title,
      marginalia_text: state.copy.marginalia_text,
      status_label: state.copy.status_label,
      primary_action: learnerAction(
        state.copy.primary_action_label,
        state.copy.primary_action_intent,
      ),
      secondary_action: learnerAction(state.copy.next_action_label, state.copy.next_action_intent),
    },
    operator: {
      diagnostic_fields: [...state.operator_diagnostics],
      evidence_code: state.evidence_code,
      failure_class: state.failure_class,
      readiness_failure_kind: state.readiness_failure_kind,
      stage: state.stage,
      terminal_reason: state.terminal_reason,
    },
  } satisfies LearnerRecoveryCopyEntry);
}

export const VIVA_LEARNER_RECOVERY_COPY_CONTRACT: Readonly<LearnerRecoveryCopyContract> =
  deepFreeze({
    schema: VIVA_LEARNER_RECOVERY_COPY_SCHEMA,
    source_schema: VIVA_LEARNER_LOOP_CONTRACT.schema,
    source_max_submitted_answer_resolution_ms:
      VIVA_LEARNER_LOOP_CONTRACT.max_submitted_answer_resolution_ms,
    states: VIVA_LEARNER_LOOP_CONTRACT.states.map(learnerRecoveryCopyEntry),
  } satisfies LearnerRecoveryCopyContract);

export function learnerRecoveryCopyForState(stateId: string): LearnerRecoveryCopyEntry | undefined {
  return VIVA_LEARNER_RECOVERY_COPY_CONTRACT.states.find((state) => state.state_id === stateId);
}
