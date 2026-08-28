// RELEASE-028: one sanitized adapter between the release/monitor scripts and
// the contract validators `@viva/core` publishes.
//
// Two raw inputs used to be trusted here. The learner-loop JSON was imported
// directly by four release modules and read as if it were a typed literal, so a
// hand edit that added a state, misspelled an enum, or duplicated an id reached
// the rollback gate, the hosted matrix, the failure matrix, and the operator
// dashboards unchecked. And decoded voice frames were branched on by `type`,
// `event`, terminality and failure class before anything proved they were
// frames at all — a provider- or attacker-shaped payload could reach an
// evidence field or an operator's screen.
//
// Both now go through the published strict validators, which reject unknown
// keys at every nested level and *reconstruct* an allowed value rather than
// casting the caller's object. This module adds only three things on top:
// a `structuredClone` on the way in (so a later mutation of the caller's object
// cannot reach the validated value), a deep freeze on the way out, and one
// stable sanitized code per failure. It owns no allowed-key list of its own;
// duplicating the schema here is exactly the drift RELEASE-028 exists to stop.
import {
  parseVivaServerFrame,
  VIVA_LEARNER_LOOP_MAX_TURN_MS,
  VIVA_LEARNER_LOOP_TERMINAL_REASONS,
  validateLearnerLoopContract,
} from "@viva/core/runtime-validation";

import rawLearnerLoopContract from "../packages/core/src/learner-loop-contract.json" with {
  type: "json",
};

export const RELEASE_LEARNER_LOOP_CONTRACT_INVALID = "learner_loop_contract_invalid";
export const RELEASE_VOICE_SERVER_FRAME_INVALID = "voice_server_frame_invalid";

/**
 * A validation failure carrying its stable code and nothing else.
 *
 * The parser's own message names the offending path and, for a malformed
 * frame, can quote the offending value — which is precisely the transcript,
 * answer, token or raw provider text this lane may never let into a thrown
 * message, a log line, an evidence field, or a browser result. `cause` is not
 * set, the input is not retained, and the message *is* the code.
 */
export class ReleaseContractValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseContractValidationError";
    this.code = code;
  }
}

export function validatedLearnerLoopForRelease(value) {
  try {
    return deepFreeze(validateLearnerLoopContract(structuredClone(value)));
  } catch {
    throw new ReleaseContractValidationError(RELEASE_LEARNER_LOOP_CONTRACT_INVALID);
  }
}

export function validatedVoiceFrameForRelease(value) {
  try {
    return deepFreeze(parseVivaServerFrame(structuredClone(value)));
  } catch {
    throw new ReleaseContractValidationError(RELEASE_VOICE_SERVER_FRAME_INVALID);
  }
}

/** The one validated learner-loop value every release consumer reads. */
export const RELEASE_LEARNER_LOOP_CONTRACT = validatedLearnerLoopForRelease(rawLearnerLoopContract);

export const RELEASE_LEARNER_LOOP_MAX_TURN_MS = VIVA_LEARNER_LOOP_MAX_TURN_MS;

/**
 * The published closed terminal vocabulary (`VOICE-TERMINATION-001` plus the
 * pre-session reasons), consumed rather than re-declared. A release script that
 * kept its own list would keep passing while the contract moved underneath it.
 */
export const RELEASE_VOICE_TERMINAL_REASONS = Object.freeze([
  ...VIVA_LEARNER_LOOP_TERMINAL_REASONS,
]);

const RELEASE_VOICE_TERMINAL_REASON_SET = new Set(RELEASE_VOICE_TERMINAL_REASONS);

export function isReleaseVoiceTerminalReason(value) {
  return typeof value === "string" && RELEASE_VOICE_TERMINAL_REASON_SET.has(value);
}

/**
 * The protocol version a *validated* server frame carries.
 *
 * A release script must never name the wire version in a local literal: that is
 * the A-03 defect, where two scripts held `4` while the contract moved to `5`
 * and only a source-text comparison noticed. Reading it back out of a frame the
 * shared validator accepted makes the constant unforgeable — a frame at the
 * wrong version is rejected before its version can be read.
 */
export function releaseProtocolVersionFromServerFrame(value) {
  return validatedVoiceFrameForRelease(value).version;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return value;
}
