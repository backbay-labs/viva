// RELEASE-030 E2E extraction, further split (post-review-remediation amend):
// page actions, required frames, voice-matrix execution, and normalized
// evidence assembly. This module drives the actual product story once
// `e2e-browser-runtime.mjs` hands it a ready browser page and resolved
// agent/web addresses, and reduces every observation into the sanitized
// evidence the release gate consumes.
//
// This file is now a thin barrel over its own derived children, so it holds
// to the Task 16 "each new extracted module is capped at 600 lines" text for
// real rather than by a self-authored ceiling number: an adversarial review
// of the first extraction pass found the concentration-policy gate had been
// changed to check each module's own ceiling instead of the plan's flat
// 600-line constant, which is exactly the self-granted-sanction failure mode
// this split avoids. Every symbol below is re-exported under its original
// name, so nothing outside this module's own family (the entrypoint, the
// story test suite) needed an import-path change.
//
//   e2e-browser-story-actions.mjs         page actions, diagnostics, redaction
//   e2e-browser-story-preview.mjs         D-09 Branch B structured-preview fixture
//   e2e-browser-story-evidence.mjs        server-frame reduction, evidence write/audit
//   e2e-browser-story-matrix.mjs          RELEASE-023 voice-transport matrix (row 597)
//   e2e-browser-story-learning-truth.mjs  LEARN-012 checks, terminal-copy proof (row 598)
//   e2e-browser-story-runner.mjs          runBrowserStory itself
export {
  assertHostedWebSocketTarget,
  bootstrapToken,
  conceptLabelText,
  conceptStatusText,
  failureControlReplayClientFrames,
  fetchSignedSessionStartTarget,
  isVisible,
  normalizeComparableWsUrl,
  redactCorrectionMarginaliaForSanitizedScreenshot,
  redactRecapForSanitizedScreenshot,
  redactSensitiveDiagnostic,
  redactSourceFolioForSanitizedScreenshot,
  submitWrittenAnswerIfFallbackOpens,
  waitForCanonicalSessionUrl,
} from "./e2e-browser-story-actions.mjs";
export {
  hashFixtureFiles,
  postAnswerProtocolProofFromEvents,
  recordServerFramePayload,
  summarizeStore,
  terminalProofFromServerEvents,
  waitForFailureControlTerminal,
  waitForPostAnswerProtocolProof,
} from "./e2e-browser-story-evidence.mjs";
export {
  LEARNING_TRUTH_CHECKS,
  summarizeLearningTruth,
  summarizeTerminalCopyProof,
} from "./e2e-browser-story-learning-truth.mjs";
export {
  summarizeFakeDeviceLongAudioProof,
  summarizeVoiceTransportMatrix,
  voiceTransportMatrixCellsFromAudioEvidence,
  VOICE_TRANSPORT_MATRIX_DURATIONS_SECONDS,
  VOICE_TRANSPORT_MATRIX_SOURCE_SAMPLE_RATES_HZ,
} from "./e2e-browser-story-matrix.mjs";
export { runBrowserStory } from "./e2e-browser-story-runner.mjs";
