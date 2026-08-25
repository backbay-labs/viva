import { describe, expect, test } from "bun:test";
import fixtureJson from "../../../agent/fixtures/learning-core/study-projection-v1.json" with {
  type: "json",
};
import {
  type ProjectedReviewScheduleItem,
  reviewDueAtFromProjection,
  VIVA_REVIEW_SELECTED_AUTHORITY,
} from "./scheduling";
import {
  type AuthenticatedStudyProjectionV1,
  VIVA_CONCEPT_STATUSES,
  VIVA_REVIEW_SCHEDULE_AUTHORITIES,
  VIVA_STUDY_MODES,
  VIVA_STUDY_SET_INGESTION_STATUSES,
  validateAuthenticatedStudyProjectionV1,
  validateAuthenticatedStudyProjectionV1ForIdentity,
} from "./study-projection-contract";

/**
 * `LEARN-008` — the authenticated study projection is the only read model.
 *
 * Every case here starts from the shared cross-language fixture that
 * `agent/crates/agent-domain/tests/protocol_fixtures.rs` parses into the Rust
 * mirror, so the two validators are answering the same bytes. The mutations are
 * the ways a session or library surface could otherwise be handed a projection
 * it would render as fact: an unknown concept, a second scheduling authority, a
 * question on a set that is not ready, or a leaked rubric.
 */
type JsonRecord = Record<string, unknown>;

const FIXTURE_CASES = Object.freeze([
  "ready_session_with_active_question",
  "ready_session_after_exhaustion",
  "library_entry_without_schedule",
  "non_ready_set_has_no_active_question",
  "failed_ingestion_is_reported_not_hidden",
]);

function fixtureCase(name: string): JsonRecord {
  const projections = (JSON.parse(JSON.stringify(fixtureJson)) as JsonRecord)
    .projections as JsonRecord;
  const projection = projections[name];
  if (projection === undefined) {
    throw new Error(`study projection fixture is missing case ${name}`);
  }
  return projection as JsonRecord;
}

function readyCase(): JsonRecord {
  return fixtureCase("ready_session_with_active_question");
}

function concepts(projection: JsonRecord): JsonRecord[] {
  return projection.concepts as JsonRecord[];
}

function schedule(projection: JsonRecord): JsonRecord[] {
  return projection.reviewSchedule as JsonRecord[];
}

function activeQuestion(projection: JsonRecord): JsonRecord {
  const question = projection.activeQuestion;
  if (question === null || question === undefined) {
    throw new Error("fixture case has no active question");
  }
  return question as JsonRecord;
}

const REJECTED_MUTATIONS: ReadonlyArray<{
  readonly name: string;
  readonly mutate: (projection: JsonRecord) => void;
  readonly message: string;
}> = Object.freeze([
  {
    name: "a string version",
    mutate: (projection) => {
      projection.version = "1";
    },
    message: "Authenticated study projection version must be the number 1",
  },
  {
    name: "a later version",
    mutate: (projection) => {
      projection.version = 2;
    },
    message: "Authenticated study projection version must be the number 1",
  },
  {
    name: "an unknown top-level field",
    mutate: (projection) => {
      projection.debugOverlay = true;
    },
    message: "Unknown authenticated study projection field debugOverlay",
  },
  {
    name: "a missing top-level field",
    mutate: (projection) => {
      delete projection.questionProgress;
    },
    message: "Authenticated study projection is missing questionProgress",
  },
  {
    name: "an unknown study set field",
    mutate: (projection) => {
      (projection.studySet as JsonRecord).seedIndex = 0;
    },
    message: "Unknown authenticated study projection studySet field seedIndex",
  },
  {
    name: "an unknown ingestion status",
    mutate: (projection) => {
      (projection.studySet as JsonRecord).ingestionStatus = "indexing";
    },
    message: "Unknown study set ingestion status indexing",
  },
  {
    name: "a non-quiz study mode",
    mutate: (projection) => {
      (projection.session as JsonRecord).mode = "teach";
    },
    message: "Unknown study mode teach",
  },
  {
    name: "a session goal",
    mutate: (projection) => {
      (projection.session as JsonRecord).goal = "pass the midterm";
    },
    message: "Authenticated study projection session goal must be null",
  },
  {
    name: "a duplicate concept",
    mutate: (projection) => {
      const list = concepts(projection);
      list.push(JSON.parse(JSON.stringify(list[0])) as JsonRecord);
    },
    message: "Duplicate authenticated study projection concept concept-electron-transport-chain",
  },
  {
    name: "an unknown concept status",
    mutate: (projection) => {
      concepts(projection)[0].status = "mastered";
    },
    message: "Unknown concept status mastered",
  },
  {
    name: "an invalid concept date",
    mutate: (projection) => {
      concepts(projection)[0].lastReviewedAt = "2026-13-45T99:00:00.000Z";
    },
    message: "must be an RFC3339 UTC instant",
  },
  {
    name: "a local-time schedule date",
    mutate: (projection) => {
      schedule(projection)[0].dueAt = "2026-08-29T09:00:00";
    },
    message: "must be an RFC3339 UTC instant",
  },
  {
    name: "a schedule entry for an excluded concept",
    mutate: (projection) => {
      schedule(projection)[0].conceptId = "concept-glycolysis";
    },
    message: "review schedule references unknown concept concept-glycolysis",
  },
  {
    name: "a duplicate schedule entry",
    mutate: (projection) => {
      const list = schedule(projection);
      list.push(JSON.parse(JSON.stringify(list[0])) as JsonRecord);
    },
    message:
      "Duplicate authenticated study projection review schedule entry for concept-electron-transport-chain",
  },
  {
    // Mixed authorities cannot survive a validator that pins every entry to the
    // one selected D-01 authority: whichever entry is not it is refused by name.
    name: "mixed scheduling authorities",
    mutate: (projection) => {
      schedule(projection)[1].authority = "core_fsrs_read_time";
    },
    message:
      "Authenticated study projection review schedule entry for concept-proton-gradient " +
      "carries authority core_fsrs_read_time, not the selected D-01 authority server_persisted_fsrs",
  },
  {
    // The gap a schedule-internal agreement check leaves open: every entry
    // uniformly carrying the REJECTED D-01 Branch B authority. Agreement is not
    // authority, so this must fail closed at the boundary rather than reach the
    // browser and throw mid-render inside `reviewIntervalFromProjection`.
    name: "a uniformly rejected-branch authority",
    mutate: (projection) => {
      for (const item of schedule(projection)) {
        item.authority = "core_fsrs_read_time";
      }
    },
    message:
      "Authenticated study projection review schedule entry for concept-electron-transport-chain " +
      "carries authority core_fsrs_read_time, not the selected D-01 authority server_persisted_fsrs",
  },
  {
    name: "a single rejected-branch authority on the first entry",
    mutate: (projection) => {
      schedule(projection)[0].authority = "core_fsrs_read_time";
    },
    message: "not the selected D-01 authority server_persisted_fsrs",
  },
  {
    name: "an unknown scheduling authority",
    mutate: (projection) => {
      schedule(projection)[0].authority = "browser_estimate";
    },
    message: "Unknown review schedule authority browser_estimate",
  },
  {
    name: "a concept dueAt that disagrees with its schedule",
    mutate: (projection) => {
      concepts(projection)[0].dueAt = "2026-09-30T09:00:00.000Z";
    },
    message: "concept concept-electron-transport-chain dueAt disagrees with its review schedule",
  },
  {
    name: "a concept dueAt with no schedule entry",
    mutate: (projection) => {
      concepts(projection)[2].dueAt = "2026-09-30T09:00:00.000Z";
    },
    message: "concept concept-atp-synthesis dueAt disagrees with its review schedule",
  },
  {
    name: "an active question on an excluded concept",
    mutate: (projection) => {
      activeQuestion(projection).conceptId = "concept-glycolysis";
    },
    message: "active question references unknown concept concept-glycolysis",
  },
  {
    name: "an active question with no citations",
    mutate: (projection) => {
      activeQuestion(projection).sourceCitations = [];
    },
    message: "active question must carry at least one source citation",
  },
  {
    name: "an unknown citation confidence",
    mutate: (projection) => {
      (activeQuestion(projection).sourceCitations as JsonRecord[])[0].confidence = "certain";
    },
    message: "Unknown source citation confidence certain",
  },
  {
    name: "completed greater than total",
    mutate: (projection) => {
      (projection.questionProgress as JsonRecord).completed = 4;
    },
    message: "questionProgress completed must not exceed total",
  },
  {
    name: "a fractional progress count",
    mutate: (projection) => {
      (projection.questionProgress as JsonRecord).completed = 1.5;
    },
    message: "questionProgress completed must be a nonnegative integer",
  },
  {
    name: "zero total with an active question",
    mutate: (projection) => {
      const progress = projection.questionProgress as JsonRecord;
      progress.completed = 0;
      progress.total = 0;
    },
    message: "questionProgress total must be positive while a question is active",
  },
  {
    name: "a non-ready set with an active question",
    mutate: (projection) => {
      (projection.studySet as JsonRecord).ingestionStatus = "processing";
    },
    message: "a study set that is not ready cannot carry an active question",
  },
  {
    name: "leaked expected terms",
    mutate: (projection) => {
      activeQuestion(projection).expectedTerms = ["chemiosmosis"];
    },
    message: "Unknown authenticated study projection activeQuestion field expectedTerms",
  },
  {
    name: "a leaked rubric",
    mutate: (projection) => {
      activeQuestion(projection).rubric = { policy_version: "viva.semantic-rubric.v1" };
    },
    message: "Unknown authenticated study projection activeQuestion field rubric",
  },
  {
    name: "a leaked source excerpt",
    mutate: (projection) => {
      (activeQuestion(projection).sourceCitations as JsonRecord[])[0].excerpt =
        "The proton gradient drives ATP synthase.";
    },
    message: "Unknown authenticated study projection sourceCitation field excerpt",
  },
  {
    name: "a leaked session token",
    mutate: (projection) => {
      (projection.session as JsonRecord).token = "viva1.abc";
    },
    message: "Unknown authenticated study projection session field token",
  },
]);

describe("LEARN-008 authenticated study projection contract", () => {
  test("publishes the closed aliases the validator enforces", () => {
    expect([...VIVA_STUDY_SET_INGESTION_STATUSES]).toEqual([
      "pending",
      "processing",
      "ready",
      "failed",
      "retry",
    ]);
    expect([...VIVA_CONCEPT_STATUSES]).toEqual(["strong", "shaky", "missed", "review"]);
    // D-03B: one honest oral-exam engine, so `quiz` is the whole mode vocabulary
    // and a projection may not carry a goal.
    expect([...VIVA_STUDY_MODES]).toEqual(["quiz"]);
    // D-01A: server-persisted FSRS is the one selected scheduling authority, so
    // the allowlist holds exactly it. `core_fsrs_read_time` is Branch B's
    // read-time replay, which the recorded decision rejected.
    expect([...VIVA_REVIEW_SCHEDULE_AUTHORITIES]).toEqual(["server_persisted_fsrs"]);
  });

  test("pins the projection authority to the same constant the browser reader enforces", () => {
    // Two modules must not be able to drift into disagreeing about which D-01
    // branch shipped: what this validator admits is exactly what
    // `reviewIntervalFromProjection` will render instead of throwing.
    expect(VIVA_REVIEW_SCHEDULE_AUTHORITIES).toHaveLength(1);
    expect(VIVA_REVIEW_SCHEDULE_AUTHORITIES[0]).toBe(VIVA_REVIEW_SELECTED_AUTHORITY);
  });

  test("hands the fail-closed browser reader a schedule it accepts", () => {
    for (const name of FIXTURE_CASES) {
      const projection = validateAuthenticatedStudyProjectionV1(fixtureCase(name) as unknown);
      // The validated entries are the browser reader's input type, not a
      // widened cast: an accepted projection is a renderable projection.
      const schedule: readonly ProjectedReviewScheduleItem[] = projection.reviewSchedule;

      for (const concept of projection.concepts) {
        const dueAt = reviewDueAtFromProjection(schedule, concept.id);
        expect(dueAt === null ? null : dueAt.toISOString()).toBe(concept.dueAt);
      }
    }
  });

  test("accepts every shared fixture case handed in as unknown", () => {
    for (const name of FIXTURE_CASES) {
      const projection: AuthenticatedStudyProjectionV1 = validateAuthenticatedStudyProjectionV1(
        fixtureCase(name) as unknown,
      );

      expect(projection.version).toBe(1);
      expect(projection.session.mode).toBe("quiz");
      expect(projection.session.goal).toBe(null);
      expect(projection.studySet.id.length).toBeGreaterThan(0);
    }
  });

  test("reads the same facts the Rust mirror parses", () => {
    const projection = validateAuthenticatedStudyProjectionV1(readyCase() as unknown);

    expect(projection.studySet).toEqual({
      id: "set-cellular-respiration",
      title: "Cellular respiration",
      course: "BIO 201",
      examLabel: "Midterm 2",
      ingestionStatus: "ready",
    });
    expect(projection.concepts.map((concept) => concept.id)).toEqual([
      "concept-electron-transport-chain",
      "concept-proton-gradient",
      "concept-atp-synthesis",
    ]);
    expect(projection.concepts[2]?.dueAt).toBe(null);
    expect(projection.activeQuestion?.id).toBe("q-atp-synthase-coupling");
    expect(projection.activeQuestion?.sourceCitations).toEqual([
      {
        sourceId: "src-lec5-slide-20",
        documentId: "lec-5",
        span: "slide:20",
        label: "Lecture 5, slide 20",
        confidence: "medium",
      },
    ]);
    expect(projection.questionProgress).toEqual({ completed: 2, total: 3 });
    expect(projection.reviewSchedule.map((item) => item.authority)).toEqual([
      "server_persisted_fsrs",
      "server_persisted_fsrs",
    ]);
  });

  test("returns a reconstruction, not the caller's object", () => {
    const source = readyCase();
    const projection = validateAuthenticatedStudyProjectionV1(source as unknown);

    expect(projection as unknown).not.toBe(source);
    expect(projection.concepts as unknown).not.toBe(source.concepts);
  });

  test("rejects values that are not a projection object at all", () => {
    for (const value of [null, undefined, 1, "projection", true, []]) {
      expect(() => validateAuthenticatedStudyProjectionV1(value)).toThrow(
        "Authenticated study projection must be an object",
      );
    }
  });

  for (const mutation of REJECTED_MUTATIONS) {
    test(`rejects ${mutation.name}`, () => {
      const projection = readyCase();
      mutation.mutate(projection);

      expect(() => validateAuthenticatedStudyProjectionV1(projection)).toThrow(mutation.message);
    });
  }

  test("keeps a non-ready set free of an active question", () => {
    const projection = validateAuthenticatedStudyProjectionV1(
      fixtureCase("non_ready_set_has_no_active_question") as unknown,
    );

    expect(projection.studySet.ingestionStatus).toBe("processing");
    expect(projection.activeQuestion).toBe(null);
    expect(projection.questionProgress).toEqual({ completed: 0, total: 0 });
    expect(projection.reviewSchedule).toEqual([]);
  });

  test("reports a failed ingestion instead of hiding it", () => {
    const projection = validateAuthenticatedStudyProjectionV1(
      fixtureCase("failed_ingestion_is_reported_not_hidden") as unknown,
    );

    expect(projection.studySet.ingestionStatus).toBe("failed");
    expect(projection.studySet.examLabel).toBe("Final");
    expect(projection.activeQuestion).toBe(null);
  });

  test("binds the projection to the authenticated identity, never a route overlay", () => {
    const identity = { studySetId: "set-cellular-respiration", sessionId: "vs-1001" };

    const projection = validateAuthenticatedStudyProjectionV1ForIdentity(
      readyCase() as unknown,
      identity,
    );
    expect(projection.studySet.id).toBe(identity.studySetId);
    expect(projection.session.id).toBe(identity.sessionId);

    expect(() =>
      validateAuthenticatedStudyProjectionV1ForIdentity(readyCase() as unknown, {
        ...identity,
        studySetId: "set-membrane-transport",
      }),
    ).toThrow("Authenticated study projection study set identity mismatch");

    expect(() =>
      validateAuthenticatedStudyProjectionV1ForIdentity(readyCase() as unknown, {
        ...identity,
        sessionId: "vs-9999",
      }),
    ).toThrow("Authenticated study projection session identity mismatch");
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
 * `LEARN-010` — the validated projection is the only read model, so it is
 * handed to every session and library surface at once.
 *
 * The validator already rebuilds the projection from validated parts; freezing
 * that result is what stops a surface from editing the shared object after the
 * fact — writing a concept status the server never sent, appending a citation,
 * or moving a persisted `dueAt` the browser is only allowed to format.
 */
describe("LEARN-010 the validated projection is deeply immutable", () => {
  test("concepts, citations, and schedule entries cannot be rewritten after validation", () => {
    const projection = validateAuthenticatedStudyProjectionV1(readyCase() as unknown);
    const before = JSON.stringify(projection);
    const question = projection.activeQuestion;
    if (question === null) {
      throw new Error("fixture case has no active question");
    }

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.concepts)).toBe(true);
    expect(Object.isFrozen(projection.reviewSchedule)).toBe(true);
    expect(Object.isFrozen(question.sourceCitations)).toBe(true);

    expectFrozenWrite(() => {
      (projection as { version: number }).version = 2;
    });
    expectFrozenWrite(() => {
      projection.studySet.ingestionStatus = "failed";
    });
    expectFrozenWrite(() => {
      projection.concepts[0].status = "strong";
    });
    expectFrozenWrite(() => {
      projection.concepts.push(projection.concepts[0]);
    });
    expectFrozenWrite(() => {
      question.sourceCitations[0].label = "rewritten";
    });
    expectFrozenWrite(() => {
      question.sourceCitations.push(question.sourceCitations[0]);
    });
    expectFrozenWrite(() => {
      projection.reviewSchedule[0].dueAt = "2099-01-01T00:00:00.000Z";
    });
    expectFrozenWrite(() => {
      projection.questionProgress.completed = 99;
    });

    expect(JSON.stringify(projection)).toBe(before);
  });

  test("the identity-bound validator returns the same frozen projection", () => {
    const projection = validateAuthenticatedStudyProjectionV1ForIdentity(readyCase() as unknown, {
      studySetId: "set-cellular-respiration",
      sessionId: "vs-1001",
    });

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.session)).toBe(true);
    expectFrozenWrite(() => {
      projection.session.goal = "cram";
    });
  });
});
