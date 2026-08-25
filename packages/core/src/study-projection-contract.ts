/**
 * `AuthenticatedStudyProjectionV1` — the only session/library read model.
 *
 * This is the TypeScript half of a cross-language contract whose Rust mirror is
 * `agent/crates/agent-domain/src/study_projection.rs`; both parse the identical
 * shared fixture `agent/fixtures/learning-core/study-projection-v1.json`.
 *
 * The browser formats this projection and infers nothing from it. The rules the
 * validator enforces are the ones that make that safe:
 *
 * - identity comes from authenticated claims and store rows, never a route
 *   overlay — {@link validateAuthenticatedStudyProjectionV1ForIdentity} is how a
 *   route binds the two together;
 * - `examLabel` is display copy only; review scheduling uses the exact stored
 *   exam timestamp internally and never this string;
 * - `activeQuestion` deliberately excludes expected terms, rubric answers, and
 *   source excerpts — a citation carries identifiers, span, label, confidence;
 * - every review-schedule entry and the active question reference an included
 *   concept, and a concept's `dueAt` equals its schedule entry or is null;
 * - all review items share the one selected D-01 authority;
 * - a set that is not `ready` has no active question and cannot start a session.
 *
 * The closed aliases below are deliberately narrower than the root `@viva/core`
 * ones: this validator never accepts an unknown string merely because an
 * upstream type was broader. Under D-03B the whole mode vocabulary is `quiz` and
 * a session carries no goal.
 */

export const VIVA_STUDY_SET_INGESTION_STATUSES = [
  "pending",
  "processing",
  "ready",
  "failed",
  "retry",
] as const;

export type StudySetIngestionStatus = (typeof VIVA_STUDY_SET_INGESTION_STATUSES)[number];

export const VIVA_CONCEPT_STATUSES = ["strong", "shaky", "missed", "review"] as const;

export type ConceptStatus = (typeof VIVA_CONCEPT_STATUSES)[number];

export const VIVA_STUDY_MODES = ["quiz"] as const;

export type StudyMode = (typeof VIVA_STUDY_MODES)[number];

export const VIVA_SOURCE_CITATION_CONFIDENCES = ["high", "medium", "low"] as const;

export type SourceCitationConfidence = (typeof VIVA_SOURCE_CITATION_CONFIDENCES)[number];

export const VIVA_REVIEW_SCHEDULE_AUTHORITIES = [
  "server_persisted_fsrs",
  "core_fsrs_read_time",
] as const;

export type ReviewScheduleAuthority = (typeof VIVA_REVIEW_SCHEDULE_AUTHORITIES)[number];

export type AuthenticatedStudyProjectionV1 = {
  version: 1;
  studySet: {
    id: string;
    title: string;
    course: string | null;
    examLabel: string | null;
    ingestionStatus: StudySetIngestionStatus;
  };
  session: {
    id: string;
    mode: StudyMode;
    goal: string | null;
  };
  concepts: Array<{
    id: string;
    label: string;
    status: ConceptStatus;
    lastReviewedAt: string | null;
    dueAt: string | null;
  }>;
  activeQuestion: {
    id: string;
    conceptId: string;
    prompt: string;
    sourceCitations: Array<{
      sourceId: string;
      documentId: string;
      span: string;
      label: string;
      confidence: SourceCitationConfidence;
    }>;
  } | null;
  questionProgress: {
    completed: number;
    total: number;
  };
  reviewSchedule: Array<{
    conceptId: string;
    dueAt: string;
    authority: ReviewScheduleAuthority;
  }>;
};

export type AuthenticatedStudyIdentity = {
  studySetId: string;
  sessionId: string;
};

const SUBJECT = "Authenticated study projection";
const UNKNOWN_FIELD_SUBJECT = "authenticated study projection";

const PROJECTION_FIELDS = [
  "version",
  "studySet",
  "session",
  "concepts",
  "activeQuestion",
  "questionProgress",
  "reviewSchedule",
] as const;

const STUDY_SET_FIELDS = ["id", "title", "course", "examLabel", "ingestionStatus"] as const;

const SESSION_FIELDS = ["id", "mode", "goal"] as const;

const CONCEPT_FIELDS = ["id", "label", "status", "lastReviewedAt", "dueAt"] as const;

const ACTIVE_QUESTION_FIELDS = ["id", "conceptId", "prompt", "sourceCitations"] as const;

const SOURCE_CITATION_FIELDS = ["sourceId", "documentId", "span", "label", "confidence"] as const;

const QUESTION_PROGRESS_FIELDS = ["completed", "total"] as const;

const REVIEW_ITEM_FIELDS = ["conceptId", "dueAt", "authority"] as const;

/**
 * An RFC3339 UTC instant with second or millisecond precision.
 *
 * A learner-visible date is a server fact: a local-time string, an offset, or a
 * calendar-impossible value would silently become a different day in the
 * browser's zone, so the shape and the parse must both hold.
 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function invalid(message: string): never {
  throw new Error(message);
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireFields(
  source: Record<string, unknown>,
  fields: readonly string[],
  subject: string,
  unknownLabel: string,
): void {
  for (const field of fields) {
    if (!(field in source)) {
      invalid(`${subject} is missing ${field}`);
    }
  }
  const allowed = new Set<string>(fields);
  for (const field of Object.keys(source)) {
    if (!allowed.has(field)) {
      invalid(`Unknown ${unknownLabel} field ${field}`);
    }
  }
}

function nonEmptyString(source: Record<string, unknown>, field: string, subject: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${subject} ${field} must be a nonempty string`);
  }
  return value;
}

function nullableNonEmptyString(
  source: Record<string, unknown>,
  field: string,
  subject: string,
): string | null {
  return source[field] === null ? null : nonEmptyString(source, field, subject);
}

function utcInstant(source: Record<string, unknown>, field: string, subject: string): string {
  const value = nonEmptyString(source, field, subject);
  if (!UTC_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid(`${subject} ${field} must be an RFC3339 UTC instant, got ${value}`);
  }
  return value;
}

function nullableUtcInstant(
  source: Record<string, unknown>,
  field: string,
  subject: string,
): string | null {
  return source[field] === null ? null : utcInstant(source, field, subject);
}

function nonNegativeInteger(
  source: Record<string, unknown>,
  field: string,
  subject: string,
): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${subject} ${field} must be a nonnegative integer`);
  }
  return value;
}

function array(source: Record<string, unknown>, field: string, subject: string): unknown[] {
  const value = source[field];
  if (!Array.isArray(value)) {
    invalid(`${subject} ${field} must be an array`);
  }
  return value;
}

function member<Allowed extends string>(
  value: string,
  allowed: readonly Allowed[],
  label: string,
): Allowed {
  if (!(allowed as readonly string[]).includes(value)) {
    invalid(`Unknown ${label} ${value}`);
  }
  return value as Allowed;
}

function validateStudySet(value: unknown): AuthenticatedStudyProjectionV1["studySet"] {
  const subject = `${SUBJECT} studySet`;
  const source = record(value, subject);
  requireFields(source, STUDY_SET_FIELDS, subject, `${UNKNOWN_FIELD_SUBJECT} studySet`);

  return {
    id: nonEmptyString(source, "id", subject),
    title: nonEmptyString(source, "title", subject),
    course: nullableNonEmptyString(source, "course", subject),
    examLabel: nullableNonEmptyString(source, "examLabel", subject),
    ingestionStatus: member(
      nonEmptyString(source, "ingestionStatus", subject),
      VIVA_STUDY_SET_INGESTION_STATUSES,
      "study set ingestion status",
    ),
  };
}

function validateSession(value: unknown): AuthenticatedStudyProjectionV1["session"] {
  const subject = `${SUBJECT} session`;
  const source = record(value, subject);
  requireFields(source, SESSION_FIELDS, subject, `${UNKNOWN_FIELD_SUBJECT} session`);

  if (source.goal !== null) {
    invalid(`${subject} goal must be null`);
  }

  return {
    id: nonEmptyString(source, "id", subject),
    mode: member(nonEmptyString(source, "mode", subject), VIVA_STUDY_MODES, "study mode"),
    goal: null,
  };
}

function validateConcepts(value: unknown[]): AuthenticatedStudyProjectionV1["concepts"] {
  const subject = `${SUBJECT} concept`;
  const seen = new Set<string>();

  return value.map((entry) => {
    const source = record(entry, subject);
    requireFields(source, CONCEPT_FIELDS, subject, `${UNKNOWN_FIELD_SUBJECT} concept`);

    const id = nonEmptyString(source, "id", subject);
    if (seen.has(id)) {
      invalid(`Duplicate ${UNKNOWN_FIELD_SUBJECT} concept ${id}`);
    }
    seen.add(id);

    return {
      id,
      label: nonEmptyString(source, "label", subject),
      status: member(
        nonEmptyString(source, "status", subject),
        VIVA_CONCEPT_STATUSES,
        "concept status",
      ),
      lastReviewedAt: nullableUtcInstant(source, "lastReviewedAt", subject),
      dueAt: nullableUtcInstant(source, "dueAt", subject),
    };
  });
}

function validateActiveQuestion(value: unknown): AuthenticatedStudyProjectionV1["activeQuestion"] {
  if (value === null) {
    return null;
  }

  const subject = `${SUBJECT} activeQuestion`;
  const source = record(value, subject);
  requireFields(source, ACTIVE_QUESTION_FIELDS, subject, `${UNKNOWN_FIELD_SUBJECT} activeQuestion`);

  const citationSubject = `${SUBJECT} sourceCitation`;
  const citations = array(source, "sourceCitations", subject).map((entry) => {
    const citation = record(entry, citationSubject);
    requireFields(
      citation,
      SOURCE_CITATION_FIELDS,
      citationSubject,
      `${UNKNOWN_FIELD_SUBJECT} sourceCitation`,
    );

    return {
      sourceId: nonEmptyString(citation, "sourceId", citationSubject),
      documentId: nonEmptyString(citation, "documentId", citationSubject),
      span: nonEmptyString(citation, "span", citationSubject),
      label: nonEmptyString(citation, "label", citationSubject),
      confidence: member(
        nonEmptyString(citation, "confidence", citationSubject),
        VIVA_SOURCE_CITATION_CONFIDENCES,
        "source citation confidence",
      ),
    };
  });

  if (citations.length === 0) {
    invalid(`${SUBJECT} active question must carry at least one source citation`);
  }

  return {
    id: nonEmptyString(source, "id", subject),
    conceptId: nonEmptyString(source, "conceptId", subject),
    prompt: nonEmptyString(source, "prompt", subject),
    sourceCitations: citations,
  };
}

function validateQuestionProgress(
  value: unknown,
): AuthenticatedStudyProjectionV1["questionProgress"] {
  const subject = `${SUBJECT} questionProgress`;
  const source = record(value, subject);
  requireFields(
    source,
    QUESTION_PROGRESS_FIELDS,
    subject,
    `${UNKNOWN_FIELD_SUBJECT} questionProgress`,
  );

  const completed = nonNegativeInteger(source, "completed", subject);
  const total = nonNegativeInteger(source, "total", subject);
  if (completed > total) {
    invalid(`${subject} completed must not exceed total`);
  }

  return { completed, total };
}

function validateReviewSchedule(
  value: unknown[],
  conceptIds: ReadonlySet<string>,
): AuthenticatedStudyProjectionV1["reviewSchedule"] {
  const subject = `${SUBJECT} reviewSchedule`;
  const seen = new Set<string>();
  let authority: ReviewScheduleAuthority | undefined;

  return value.map((entry) => {
    const source = record(entry, subject);
    requireFields(source, REVIEW_ITEM_FIELDS, subject, `${UNKNOWN_FIELD_SUBJECT} reviewSchedule`);

    const conceptId = nonEmptyString(source, "conceptId", subject);
    if (!conceptIds.has(conceptId)) {
      invalid(`${SUBJECT} review schedule references unknown concept ${conceptId}`);
    }
    if (seen.has(conceptId)) {
      invalid(`Duplicate ${UNKNOWN_FIELD_SUBJECT} review schedule entry for ${conceptId}`);
    }
    seen.add(conceptId);

    const itemAuthority = member(
      nonEmptyString(source, "authority", subject),
      VIVA_REVIEW_SCHEDULE_AUTHORITIES,
      "review schedule authority",
    );
    if (authority === undefined) {
      authority = itemAuthority;
    } else if (authority !== itemAuthority) {
      invalid(`${SUBJECT} review schedule mixes scheduling authorities`);
    }

    return {
      conceptId,
      dueAt: utcInstant(source, "dueAt", subject),
      authority: itemAuthority,
    };
  });
}

/**
 * Validate an unknown value as the authenticated study projection.
 *
 * The result is rebuilt from validated parts: nothing is normalized, defaulted,
 * or carried through unchecked, so a caller can never receive a learner fact the
 * server did not state.
 */
export function validateAuthenticatedStudyProjectionV1(
  value: unknown,
): AuthenticatedStudyProjectionV1 {
  const source = record(value, SUBJECT);
  requireFields(source, PROJECTION_FIELDS, SUBJECT, UNKNOWN_FIELD_SUBJECT);

  if (source.version !== 1) {
    invalid(`${SUBJECT} version must be the number 1`);
  }

  const studySet = validateStudySet(source.studySet);
  const session = validateSession(source.session);
  const concepts = validateConcepts(array(source, "concepts", SUBJECT));
  const activeQuestion = validateActiveQuestion(source.activeQuestion);
  const questionProgress = validateQuestionProgress(source.questionProgress);

  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const reviewSchedule = validateReviewSchedule(
    array(source, "reviewSchedule", SUBJECT),
    conceptIds,
  );

  const scheduledDueAt = new Map(reviewSchedule.map((item) => [item.conceptId, item.dueAt]));
  for (const concept of concepts) {
    const scheduled = scheduledDueAt.get(concept.id) ?? null;
    if (concept.dueAt !== scheduled) {
      invalid(`${SUBJECT} concept ${concept.id} dueAt disagrees with its review schedule`);
    }
  }

  if (activeQuestion !== null) {
    if (studySet.ingestionStatus !== "ready") {
      invalid(`${SUBJECT}: a study set that is not ready cannot carry an active question`);
    }
    if (!conceptIds.has(activeQuestion.conceptId)) {
      invalid(`${SUBJECT} active question references unknown concept ${activeQuestion.conceptId}`);
    }
    if (questionProgress.total === 0) {
      invalid(`${SUBJECT} questionProgress total must be positive while a question is active`);
    }
  }

  return {
    version: 1,
    studySet,
    session,
    concepts,
    activeQuestion,
    questionProgress,
    reviewSchedule,
  };
}

/**
 * Validate a projection and bind it to the caller's authenticated identity.
 *
 * A route knows the study set and session from the session claims it already
 * verified. Comparing them here is what stops a projection for another set or
 * session — or a route-supplied overlay — from being rendered as this learner's
 * own state.
 */
export function validateAuthenticatedStudyProjectionV1ForIdentity(
  value: unknown,
  identity: AuthenticatedStudyIdentity,
): AuthenticatedStudyProjectionV1 {
  const projection = validateAuthenticatedStudyProjectionV1(value);

  if (projection.studySet.id !== identity.studySetId) {
    invalid(`${SUBJECT} study set identity mismatch`);
  }
  if (projection.session.id !== identity.sessionId) {
    invalid(`${SUBJECT} session identity mismatch`);
  }

  return projection;
}
