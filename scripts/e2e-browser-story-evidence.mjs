// RELEASE-030 E2E extraction, further split (post-review-remediation amend):
// server-frame validation and reduction, terminal and post-answer protocol
// proof, fixture hashing, and the sanitized manifest/result write-and-audit
// cycle. Derived from `e2e-browser-story.mjs`.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  failureControlScenarioMarker,
  isFailureControlSessionTokenScenario,
} from "./failure-control-harness.mjs";
import { delay } from "./e2e-browser-runtime.mjs";
import { withHostedEvidenceAudit } from "./hosted-e2e-matrix.mjs";
import { auditTextArtifacts } from "./redaction-control.mjs";
import {
  isReleaseVoiceTerminalReason,
  validatedVoiceFrameForRelease,
} from "./release-contract-validation.mjs";

/** The typed v5 codes that mean "this session's credential was refused". */
const SESSION_AUTH_ERROR_CODES = new Set([
  "VOICE_AUTH_EXPIRED",
  "VOICE_AUTH_INVALID",
  "VOICE_AUTH_IDENTITY_MISMATCH",
  "VOICE_AUTH_REPLAYED",
]);

/**
 * The sanitized learning-truth projection of one validated server event.
 *
 * Kept separate from the base record so the allowed-field decision is auditable
 * in one place: free text (`question.prompt`, `evaluation.answer_text`,
 * `evaluation.concise_feedback`, `recap.headline`, `recap.summary`,
 * `recap.next_action`, `concepts[].label`) is never copied out.
 */
function learningTruthEventFields(event) {
  switch (event.type) {
    case "question_started":
      return { questionId: event.question?.question_id ?? null, turnId: event.turn_id ?? null };
    case "turn_deferred":
      return {
        canRetrySameQuestion: event.can_retry_same_question === true,
        deferralReason: event.reason ?? null,
        questionId: event.question_id ?? null,
        turnId: event.turn_id ?? null,
      };
    case "answer_evaluated":
      return {
        evaluationLabel: event.evaluation?.label ?? null,
        questionId: event.evaluation?.question_id ?? null,
      };
    case "recap_ready":
      return {
        recapConcepts: (event.recap?.concepts ?? []).map((concept) => ({
          conceptId: concept.concept_id,
          status: concept.status,
        })),
        recapDeferredTurns: event.recap?.deferred_turns ?? null,
        recapPartial: event.partial === true,
        recapSchema: event.recap?.schema ?? null,
        reviewSchedule: (event.recap?.review_schedule ?? []).map((item) => ({
          authority: item.authority,
          conceptId: item.concept_id,
          dueAt: item.due_at,
        })),
      };
    default:
      return {};
  }
}

/**
 * RELEASE-028: nothing is read off a socket frame until the published strict
 * validator has accepted it.
 *
 * This reducer used to branch on a bare `JSON.parse` result — `frame.type`,
 * `frame.event.type`, `frame.event.terminal_reason` — and to read `frame.message`,
 * a member the v5 error frame does not have (the typed error moved under
 * `frame.error`). Both defects are structural: an unparsed or non-conforming
 * payload could set a terminal reason the story then reported as proof, and the
 * v4-shaped read silently produced `null` for every real auth rejection.
 */
export function recordServerFramePayload(payload, events) {
  const text =
    typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : String(payload);
  let frame;
  try {
    frame = validatedVoiceFrameForRelease(JSON.parse(text));
  } catch (error) {
    // One stable sanitized code, never the offending payload.
    events.push({
      type: "invalid_server_frame",
      code: error?.code ?? "voice_server_frame_invalid",
      terminalReason: null,
    });
    return;
  }

  if (frame.type === "error") {
    events.push({
      errorCode: frame.error.code,
      // `error.message` is SERVER-authored free text. It is deliberately not
      // retained: `redactSensitiveDiagnostic` only strips token and bearer
      // shapes, so anything else in that string would reach `failure.json` and
      // the rethrown harness error verbatim. `code` is a closed typed
      // vocabulary and says everything a release diagnostic may say.
      retryable: frame.error.retryable,
      terminalReason: SESSION_AUTH_ERROR_CODES.has(frame.error.code)
        ? "session_auth_rejected"
        : null,
      type: "server_error",
    });
    return;
  }
  if (frame.type !== "event") return;

  const event = frame.event;
  events.push({
    conceptId: event.concept_id ?? event.question?.concept_id ?? null,
    conceptStatus: event.status ?? event.evaluation?.concept_status ?? null,
    responseId: event.response_id ?? null,
    sourceId: event.source?.source_id ?? null,
    terminalReason: isReleaseVoiceTerminalReason(event.terminal_reason)
      ? event.terminal_reason
      : null,
    type: event.type,
    // LEARN-012: the sanitized learning identifiers the truth reduction below
    // indexes. Every one is an identifier, a closed-vocabulary member, a
    // boolean, a count, or an RFC3339 instant -- never a prompt, transcript,
    // answer, feedback line, headline, or summary.
    ...learningTruthEventFields(event),
  });
}

/**
 * RELEASE-023: reduce the terminal claim out of the observed event stream. The
 * proof is an index into what the socket actually delivered, so a scenario flag
 * or a visible screen alone can never manufacture one.
 */
export function terminalProofFromServerEvents(
  events,
  { failureClass, scenarioId, stage, terminalReason, validationRunId },
) {
  const eventIndex = events.findIndex(
    (event) => event.type === "session_phase" && event.terminalReason === terminalReason,
  );
  if (eventIndex < 0) return null;
  return {
    scenario_id: scenarioId,
    failure_class: failureClass,
    stage,
    terminal_reason: terminalReason,
    event_index: eventIndex,
    validation_run_id: validationRunId,
    sanitized: true,
  };
}

export async function waitForFailureControlTerminal(events, plan, timeoutMs, validationRunId) {
  const expectedTerminalReason = plan.scenario.terminal_reason;
  const scenarioMarker = failureControlScenarioMarker(plan.scenario);
  const tokenScenario = isFailureControlSessionTokenScenario(plan.scenario);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (tokenScenario) {
      const eventIndex = events.findIndex(
        (event) => event.type === "server_error" && event.terminalReason === expectedTerminalReason,
      );
      if (eventIndex >= 0) {
        return {
          scenario_id: plan.scenario.id,
          failure_class: plan.scenario.failure_class,
          stage: plan.scenario.stage,
          terminal_reason: expectedTerminalReason,
          event_index: eventIndex,
          token_recovery_path_verified: true,
          validation_run_id: validationRunId,
          sanitized: true,
        };
      }
    } else {
      const markerIndex = events.findIndex(
        (event) => event.type === "question_started" && event.responseId === scenarioMarker,
      );
      const eventIndex = events.findIndex(
        (event, index) =>
          index > markerIndex &&
          event.type === "session_phase" &&
          event.terminalReason === expectedTerminalReason,
      );
      if (markerIndex >= 0 && eventIndex >= 0) {
        return {
          scenario_id: plan.scenario.id,
          failure_class: plan.scenario.failure_class,
          stage: plan.scenario.stage,
          terminal_reason: expectedTerminalReason,
          event_index: eventIndex,
          scenario_marker_response_id: scenarioMarker,
          scenario_marker_event_index: markerIndex,
          stage_verified: true,
          validation_run_id: validationRunId,
          sanitized: true,
        };
      }
    }
    await delay(100);
  }
  const terminalReasons = events
    .filter((event) => event.type === "session_phase" && event.terminalReason)
    .map((event) => event.terminalReason)
    .join(" -> ");
  // Both halves are closed vocabularies: a sanitized terminal reason or the
  // typed v5 error code. No server-authored string reaches this text.
  const serverErrors = events
    .filter((event) => event.type === "server_error")
    .map((event) => event.terminalReason ?? event.errorCode)
    .join(" -> ");
  throw new Error(
    `Timed out waiting for failure-control ${plan.scenario.id} terminal reason ${expectedTerminalReason}. Saw terminal: ${
      terminalReasons || "none"
    }; server_errors: ${serverErrors || "none"}`,
  );
}

/**
 * RELEASE-023: the post-answer proof is only as good as its binding. Both the
 * source reference and the concept status must name the *same* response id as
 * the evaluation and must arrive after it, so an earlier turn's events can
 * never be credited to this one.
 */
export function postAnswerProtocolProofFromEvents(
  events,
  answerResolutionStartedAt = null,
  nowMs = Date.now(),
) {
  for (let answerIndex = events.length - 1; answerIndex >= 0; answerIndex -= 1) {
    const answerEvent = events[answerIndex];
    if (answerEvent.type !== "answer_evaluated" || !answerEvent.responseId) continue;

    const afterAnswer = events.slice(answerIndex + 1);
    const sourceEvent = afterAnswer.find(
      (event) =>
        event.type === "source_reference" &&
        event.responseId === answerEvent.responseId &&
        Boolean(event.sourceId),
    );
    const conceptEvent = afterAnswer.find(
      (event) =>
        event.type === "concept_status" &&
        event.responseId === answerEvent.responseId &&
        typeof event.conceptStatus === "string",
    );
    return {
      conceptId: conceptEvent?.conceptId ?? null,
      conceptStatus: conceptEvent?.conceptStatus ?? null,
      conceptStatusEventSeen: Boolean(conceptEvent),
      latencyMs:
        Number.isFinite(answerResolutionStartedAt) && answerResolutionStartedAt > 0
          ? Math.max(0, nowMs - answerResolutionStartedAt)
          : null,
      responseId: answerEvent.responseId,
      sourceReferenceEventSeen: Boolean(sourceEvent),
    };
  }
  return {
    conceptId: null,
    conceptStatus: null,
    conceptStatusEventSeen: false,
    latencyMs: null,
    responseId: null,
    sourceReferenceEventSeen: false,
  };
}

export async function waitForPostAnswerProtocolProof(events, timeoutMs, answerResolutionStartedAt = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const proof = postAnswerProtocolProofFromEvents(events, answerResolutionStartedAt);
    if (proof.sourceReferenceEventSeen && proof.conceptStatusEventSeen) return proof;
    await delay(100);
  }
  const eventTypes = events.map((event) => event.type).join(" -> ");
  throw new Error(
    `Timed out waiting for post-answer source_reference and concept_status events. Saw: ${eventTypes}`,
  );
}

export async function hashFixtureFiles(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const hashes = {};
  for (const name of names) {
    const bytes = await readFile(path.join(dir, name));
    hashes[name] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return hashes;
}

export function summarizeStore(store) {
  return {
    available: store?.available === true,
    backend: typeof store?.backend === "string" ? store.backend : null,
    durable: store?.durable === true,
    nonce_replay_protection: store?.nonce_replay_protection === true,
  };
}

async function auditBrowserStoryArtifacts(dir, plan) {
  return auditTextArtifacts([dir], {
    context: "Browser story artifact",
    rootDir: plan.root,
    zipMessage: (relative) => `Browser story artifact includes retained trace archive: ${relative}`,
  });
}

function skippedLocalTraceArtifactAudit() {
  return {
    forbidden_hits: 0,
    scanned_files: 0,
    skipped: "local_trace_retained",
  };
}

export async function buildBrowserStoryManifest({ traceRetained }, plan, storyFrames) {
  return {
    schema: "viva.browser_story.v1",
    generated_at: new Date().toISOString(),
    validation_run_id: plan.validationRunId,
    artifact_dir: path.relative(plan.root, plan.artifactDir),
    agent_provider: plan.agentProvider,
    command_summary: {
      command: "bun run e2e:browser",
      provider: plan.agentProvider,
      validation_run_id: plan.validationRunId,
      artifact_dir: path.relative(plan.root, plan.artifactDir),
      browser: "playwright-chromium",
      capture_mode: plan.hostedMode ? "hosted" : "loopback-local",
      post_answer_source_folio_required: plan.requirePostAnswerSourceFolio,
      stop_to_recap: plan.stopToRecap,
    },
    fixture_hashes: await hashFixtureFiles(path.join(plan.root, "agent/fixtures/voice-protocol")),
    frames: storyFrames,
    sanitized: true,
    trace_retained: traceRetained,
  };
}

export async function writeAuditedBrowserStoryResult(baseResult, plan) {
  const storyPath = path.join(plan.artifactDir, "browser-story.json");
  const resultPath = path.join(plan.artifactDir, "result.json");
  let result = baseResult;
  for (let pass = 0; pass < 2; pass += 1) {
    await writeFile(storyPath, `${JSON.stringify(result.browser_story, null, 2)}\n`);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    const artifactAudit =
      result.browser_story.trace_retained && !plan.hostedMode
        ? skippedLocalTraceArtifactAudit()
        : await auditBrowserStoryArtifacts(plan.artifactDir, plan);
    result = withHostedEvidenceAudit(
      {
        ...result,
        browser_story: {
          ...result.browser_story,
          artifact_audit: artifactAudit,
        },
      },
      artifactAudit,
    );
  }
  await writeFile(storyPath, `${JSON.stringify(result.browser_story, null, 2)}\n`);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

