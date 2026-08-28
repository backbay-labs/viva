// RELEASE-030 E2E extraction, further split (post-review-remediation amend):
// LEARN-012 Step 3's eight required learning-truth checks and the
// ledger-row-598 terminal-copy proof (`WEBSESSION-TERMINAL-01`). Derived
// from `e2e-browser-story.mjs`. Pure reducers; no imports.

// ---------------------------------------------------------------------------
// LEARN-012 Step 3 handoff: the eight learning-truth checks, made required
// visible checks of `bun run e2e:browser`.
//
// Plan 04's LEARN-012 Step 3 is BLOCKED until this lane confirms the harness
// asserts assertions 1-8 on one authenticated study identity. They are reduced
// here -- out of the observed server event stream and the story's own visible
// observations -- rather than asserted from a flag or credited to a screenshot,
// so a story that merely rendered something can never satisfy them.
// ---------------------------------------------------------------------------

export const LEARNING_TRUTH_CHECKS = Object.freeze([
  "projection_question_started",
  "evaluated_turn_persists_one_outcome",
  "deferred_turn_recovers_without_mastery",
  "second_question_advances_under_d02",
  "recap_equals_persisted_outcomes",
  "review_schedule_under_d01_authority",
  "completed_recap_dominates_close",
  "d03_mode_goal_bound_or_removed_ui_absent",
]);

/** D-01 `SERVER_PERSISTED_FSRS`. The rejected branch's authority is not accepted. */
const LEARNING_TRUTH_REVIEW_AUTHORITY = "server_persisted_fsrs";
/** The v2 recap schema the merged turn-outcome authority folds. */
const LEARNING_TRUTH_RECAP_SCHEMA = "viva.study_session_recap.v2";

/**
 * Reduce the eight learning truths.
 *
 * `events` are the sanitized records `recordServerFramePayload` produced;
 * `visible` are the story's own on-screen observations. Both halves are
 * required for every check that has both: an event without its visible
 * counterpart is not a learner-visible truth, and a visible surface without its
 * event is not bound to anything the server actually said.
 */
export function summarizeLearningTruth({ required, events = [], visible = {} }) {
  const failures = [];
  const checks = [];
  const record = (id, passed, detail) => {
    checks.push({ id, passed, detail });
    if (!passed) failures.push(`${id}: ${detail}`);
  };

  const questionStarts = events.filter((event) => event.type === "question_started");
  const evaluations = events.filter((event) => event.type === "answer_evaluated");
  const deferrals = events.filter((event) => event.type === "turn_deferred");
  const conceptStatuses = events.filter((event) => event.type === "concept_status");
  const recapIndex = events.findIndex((event) => event.type === "recap_ready");
  const recap = recapIndex < 0 ? null : events[recapIndex];

  // 1. A question from AuthenticatedStudyProjectionV1 starts.
  //
  // The socket that delivered it is itself the projection binding: `/session`
  // opens no socket until an AuthenticatedStudyProjectionV1 has been fetched,
  // identity-verified against the route identity, and reported `canConnect`.
  // What is asserted here is the other half -- that the started question is a
  // real, identified question of the authenticated entry, and that the learner
  // can see its prompt.
  const firstStart = questionStarts[0];
  record(
    "projection_question_started",
    Boolean(
      firstStart?.questionId &&
        firstStart.conceptId &&
        visible.authenticatedEntry === true &&
        visible.questionPromptVisible === true,
    ),
    firstStart
      ? `question_started question_id=${firstStart.questionId ?? "missing"} concept_id=${
          firstStart.conceptId ?? "missing"
        } authenticated_entry=${visible.authenticatedEntry === true} prompt_visible=${
          visible.questionPromptVisible === true
        }`
      : "no question_started event was observed on the authenticated session",
  );

  // 2. An evaluated turn persists exactly one TurnOutcome.
  const evaluatedResponseIds = evaluations.map((event) => event.responseId);
  const duplicateEvaluation = new Set(evaluatedResponseIds).size !== evaluatedResponseIds.length;
  const firstEvaluation = evaluations[0];
  const persistedStatus = firstEvaluation
    ? conceptStatuses.find((event) => event.responseId === firstEvaluation.responseId)
    : undefined;
  record(
    "evaluated_turn_persists_one_outcome",
    Boolean(
      firstEvaluation?.responseId &&
        !duplicateEvaluation &&
        persistedStatus?.conceptId &&
        persistedStatus.conceptStatus &&
        visible.evaluatedTurnVisible === true,
    ),
    firstEvaluation
      ? `evaluations=${evaluations.length} duplicate_response_id=${duplicateEvaluation} persisted_concept_status=${
          persistedStatus?.conceptStatus ?? "none"
        } visible=${visible.evaluatedTurnVisible === true}`
      : "no answer_evaluated event was observed",
  );

  // 3. A deferred turn renders recovery without mastery.
  const deferral = deferrals[0];
  const deferralWroteMastery = deferral
    ? events.some(
        (event) =>
          (event.type === "concept_status" || event.type === "answer_evaluated") &&
          event.responseId === deferral.responseId,
      )
    : false;
  record(
    "deferred_turn_recovers_without_mastery",
    Boolean(
      deferral?.deferralReason &&
        !deferralWroteMastery &&
        visible.deferredRecoveryVisible === true &&
        visible.deferredMasteryVisible === false,
    ),
    deferral
      ? `deferral_reason=${deferral.deferralReason ?? "missing"} can_retry=${
          deferral.canRetrySameQuestion === true
        } wrote_mastery=${deferralWroteMastery} recovery_visible=${
          visible.deferredRecoveryVisible === true
        } mastery_visible=${visible.deferredMasteryVisible === true}`
      : "no turn_deferred event was observed",
  );

  // 4. A second question advances under the selected D-02 (ordered progression).
  const startedQuestionIds = questionStarts.map((event) => event.questionId);
  const repeatedQuestion = new Set(startedQuestionIds).size !== startedQuestionIds.length;
  record(
    "second_question_advances_under_d02",
    Boolean(
      questionStarts.length >= 2 &&
        !repeatedQuestion &&
        startedQuestionIds.every(Boolean) &&
        visible.secondQuestionPromptVisible === true,
    ),
    `question_starts=${questionStarts.length} repeated_question_id=${repeatedQuestion} second_prompt_visible=${
      visible.secondQuestionPromptVisible === true
    }`,
  );

  // 5. The recap equals the persisted outcomes.
  const persistedByConcept = new Map();
  for (const event of conceptStatuses) {
    if (event.conceptId) persistedByConcept.set(event.conceptId, event.conceptStatus);
  }
  const recapByConcept = new Map(
    (recap?.recapConcepts ?? []).map((concept) => [concept.conceptId, concept.status]),
  );
  const recapMatchesPersisted =
    Boolean(recap) &&
    persistedByConcept.size > 0 &&
    persistedByConcept.size === recapByConcept.size &&
    [...persistedByConcept].every(
      ([conceptId, status]) => recapByConcept.get(conceptId) === status,
    );
  record(
    "recap_equals_persisted_outcomes",
    Boolean(
      recapMatchesPersisted &&
        recap?.recapSchema === LEARNING_TRUTH_RECAP_SCHEMA &&
        visible.recapVisible === true,
    ),
    recap
      ? `recap_schema=${recap.recapSchema ?? "missing"} persisted=${describeConceptMap(
          persistedByConcept,
        )} recap=${describeConceptMap(recapByConcept)} visible=${visible.recapVisible === true}`
      : "no recap_ready event was observed",
  );

  // 6. The review schedule uses the selected D-01 authority and obeys exam policy.
  const schedule = recap?.reviewSchedule ?? [];
  const wrongAuthority = schedule.filter(
    (item) => item.authority !== LEARNING_TRUTH_REVIEW_AUTHORITY,
  );
  const unparseableDueAt = schedule.filter((item) => !Number.isFinite(Date.parse(item.dueAt)));
  const examAtMs = Number.isFinite(Date.parse(visible.examAt ?? ""))
    ? Date.parse(visible.examAt)
    : null;
  const pastExam =
    examAtMs === null ? [] : schedule.filter((item) => Date.parse(item.dueAt) > examAtMs);
  record(
    "review_schedule_under_d01_authority",
    Boolean(
      schedule.length > 0 &&
        wrongAuthority.length === 0 &&
        unparseableDueAt.length === 0 &&
        pastExam.length === 0 &&
        visible.reviewAuthorityVisible === true,
    ),
    `schedule_entries=${schedule.length} wrong_authority=${wrongAuthority.length} unparseable_due_at=${
      unparseableDueAt.length
    } past_exam=${pastExam.length} exam_bound=${
      examAtMs === null ? "unknown" : visible.examAt
    } authority_visible=${visible.reviewAuthorityVisible === true}`,
  );

  // 7. The completed recap copy dominates socket close/disconnection.
  const afterRecap = recapIndex < 0 ? [] : events.slice(recapIndex + 1);
  const contradicting = afterRecap.filter(
    (event) => event.type === "server_error" || event.type === "invalid_server_frame",
  );
  record(
    "completed_recap_dominates_close",
    Boolean(
      recap &&
        recap.recapPartial === false &&
        contradicting.length === 0 &&
        visible.recapVisibleAfterClose === true &&
        visible.disconnectionCopyVisible === false,
    ),
    recap
      ? `partial=${recap.recapPartial} contradicting_events_after_recap=${
          contradicting.length
        } recap_after_close_visible=${
          visible.recapVisibleAfterClose === true
        } disconnection_copy_visible=${visible.disconnectionCopyVisible === true}`
      : "no recap_ready event was observed",
  );

  // 8. The selected D-03 branch. D-03 Branch B is quiz-only: Viva signs no
  //    mode/goal contract, so the proof is that the removed UI is absent and the
  //    one honest affordance is present.
  record(
    "d03_mode_goal_bound_or_removed_ui_absent",
    visible.honestBeginActionVisible === true &&
      visible.modeGoalCommandVisible === false &&
      visible.modeSuggestionChipsVisible === false,
    `honest_begin_visible=${visible.honestBeginActionVisible === true} mode_goal_command_visible=${
      visible.modeGoalCommandVisible === true
    } mode_suggestion_chips_visible=${visible.modeSuggestionChipsVisible === true}`,
  );

  return {
    required: required === true,
    passed: required === true ? failures.length === 0 : true,
    checks,
    failures,
    sanitized: true,
  };
}

function describeConceptMap(map) {
  return (
    [...map]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([conceptId, status]) => `${conceptId}=${status}`)
      .join(",") || "none"
  );
}

/**
 * Ledger row 598 / `WEBSESSION-TERMINAL-01` (Frontend C9, `DUPLICATE_ALIAS`):
 * "Successful recap is not rendered as disconnect/error; terminal copy is
 * truthful", required proof "exact success copy contains no disconnect/retry
 * contradiction". LEARN-012 check 7 (`completed_recap_dominates_close` above)
 * already proves the disconnect half at the exact right moment -- the recap
 * visible AFTER the socket has closed, never displaced by disconnection copy.
 * This is its retry-labeled sibling, observed at the identical point, so both
 * halves of "no disconnect/retry contradiction" are proven together rather
 * than only the disconnect half.
 */
export function summarizeTerminalCopyProof({
  disconnectionCopyVisible,
  recapVisible,
  required,
  retryContradictionVisible,
} = {}) {
  const failures = [];
  if (recapVisible !== true) {
    failures.push("the successful recap was not visible");
  }
  if (disconnectionCopyVisible === true) {
    failures.push("disconnect copy rendered beside a successful recap");
  }
  if (retryContradictionVisible === true) {
    failures.push("retry copy rendered beside a successful recap");
  }
  return {
    proof_id: "WEBSESSION-TERMINAL-01",
    ledger_row: 598,
    required: required === true,
    passed: required === true ? failures.length === 0 : true,
    failures,
  };
}

