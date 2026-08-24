import { describe, expect, test } from "bun:test";
import { parseVivaServerFrame as ownerParseVivaServerFrame } from "./agent-contract";
import * as fixtures from "./fixtures";
import * as publicCore from "./index";
import { validateLearnerLoopContract as ownerValidateLearnerLoopContract } from "./learner-loop-contract";
import * as runtimeValidation from "./runtime-validation";
import * as fakeEvaluator from "./testing/fake-evaluator";

const fixtureOnlyExports = ["sampleQuestion", "seedStudySets", "sourceConflictExample"] as const;
const fakeEvaluatorOnlyExports = ["buildSessionRecap", "evaluateAnswer"] as const;
const runtimeValidationValueExports = [
  "VIVA_LEARNER_LOOP_CONTRACT",
  "VIVA_LEARNER_LOOP_EVIDENCE_FIELDS",
  "VIVA_LEARNER_LOOP_MAX_TURN_MS",
  "VIVA_LEARNER_LOOP_TERMINAL_REASONS",
  "VIVA_PRE_LOOP_TERMINAL_REASONS",
  "VIVA_RUNTIME_COPY_CAUSES",
  "parseVivaServerFrame",
  "validateLearnerLoopContract",
] as const;

describe("@viva/core package surfaces", () => {
  test("keeps fixture and fake-evaluator values out of the production root", () => {
    for (const exportName of [...fixtureOnlyExports, ...fakeEvaluatorOnlyExports]) {
      expect(publicCore).not.toHaveProperty(exportName);
    }
    expect(typeof publicCore.validateAuthenticatedStudyProjectionV1).toBe("function");
  });

  test("exposes only deterministic data from the fixture entry", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...fixtureOnlyExports].sort());
    expect(fixtures.seedStudySets[0]?.id).toBe("biology-midterm");
  });

  test("exposes the deterministic evaluator only from the testing entry", () => {
    expect(Object.keys(fakeEvaluator).sort()).toEqual([...fakeEvaluatorOnlyExports].sort());
    expect(fakeEvaluator.evaluateAnswer("36 ATP").correctionKind).toBe(
      "course-specific discrepancy",
    );
  });

  test("aggregates owner validators without wrappers or extra runtime values", () => {
    expect(Object.keys(runtimeValidation).sort()).toEqual(
      [...runtimeValidationValueExports].sort(),
    );
    expect(runtimeValidation.parseVivaServerFrame).toBe(ownerParseVivaServerFrame);
    expect(runtimeValidation.validateLearnerLoopContract).toBe(ownerValidateLearnerLoopContract);
  });
});
