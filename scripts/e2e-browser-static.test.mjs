import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// RELEASE-030 E2E extraction: every structural scan below is re-pointed at the
// new file that now carries the pattern it names. Nothing here was weakened
// or dropped -- each assertion is unchanged in substance, only its source
// path moved with the code.
//
// Post-review-remediation amend: `e2e-browser-story.mjs` split further, into
// a thin barrel plus six derived files (see that file's own header). It no
// longer carries any of the patterns below itself, so every scan that used
// to read `E2E_BROWSER_STORY_PATH` now reads whichever derived file the
// pattern actually lives in, and the "every file the extraction produced"
// completeness loops now cover the full family, not just the barrel.
const E2E_BROWSER_PATH = "scripts/e2e-browser.mjs";
const E2E_BROWSER_PLAN_PATH = "scripts/e2e-browser-plan.mjs";
const E2E_BROWSER_RUNTIME_PATH = "scripts/e2e-browser-runtime.mjs";
const E2E_BROWSER_STORY_PATH = "scripts/e2e-browser-story.mjs";
const E2E_BROWSER_STORY_ACTIONS_PATH = "scripts/e2e-browser-story-actions.mjs";
const E2E_BROWSER_STORY_PREVIEW_PATH = "scripts/e2e-browser-story-preview.mjs";
const E2E_BROWSER_STORY_EVIDENCE_PATH = "scripts/e2e-browser-story-evidence.mjs";
const E2E_BROWSER_STORY_MATRIX_PATH = "scripts/e2e-browser-story-matrix.mjs";
const E2E_BROWSER_STORY_LEARNING_TRUTH_PATH = "scripts/e2e-browser-story-learning-truth.mjs";
const E2E_BROWSER_STORY_RUNNER_PATH = "scripts/e2e-browser-story-runner.mjs";
const E2E_BROWSER_STORY_FAMILY_PATHS = [
  E2E_BROWSER_STORY_PATH,
  E2E_BROWSER_STORY_ACTIONS_PATH,
  E2E_BROWSER_STORY_PREVIEW_PATH,
  E2E_BROWSER_STORY_EVIDENCE_PATH,
  E2E_BROWSER_STORY_MATRIX_PATH,
  E2E_BROWSER_STORY_LEARNING_TRUTH_PATH,
  E2E_BROWSER_STORY_RUNNER_PATH,
];
const ALL_PATHS = [
  E2E_BROWSER_PATH,
  E2E_BROWSER_PLAN_PATH,
  E2E_BROWSER_RUNTIME_PATH,
  ...E2E_BROWSER_STORY_FAMILY_PATHS,
];

async function readAll(paths) {
  return Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")])),
  );
}

test("hosted browser E2E mints sessions through the same-origin bootstrap route", async () => {
  const source = await readFile(E2E_BROWSER_STORY_ACTIONS_PATH, "utf8");

  assert.match(source, /\/api\/viva-library\/study-sets\/library/);
  assert.match(source, /\/api\/viva-session\/start/);
  assert.match(source, /session_bootstrap_token: action\.session_bootstrap_token/);
  assert.match(source, /sessionPayload\.session_token/);
  assert.doesNotMatch(source, /action\.session_token/);
});

test("hosted browser E2E keeps the REST bearer out of browser JavaScript", async () => {
  // Checked across the whole story family (stricter than a single file): the
  // bearer must never reach browser JavaScript no matter which module the
  // hosted session-start action now lives in.
  const sources = await readAll(E2E_BROWSER_STORY_FAMILY_PATHS);

  for (const path of E2E_BROWSER_STORY_FAMILY_PATHS) {
    assert.doesNotMatch(sources[path], /async \(\{ restBearerToken, userId, studySetId \}\) =>/, path);
    assert.doesNotMatch(sources[path], /headers\.authorization = `Bearer \$\{restBearerToken\}`/, path);
    assert.doesNotMatch(sources[path], /\{ \.\.\.identity, restBearerToken: hostedRestBearerToken \}/, path);
  }
});

test("hosted browser E2E authenticates the Node-side agent readiness probe", async () => {
  const sources = await readAll(ALL_PATHS);

  // The entrypoint composes the probe from the plan's hosted rest bearer and
  // calls the runtime's readiness waiter with it.
  assert.match(
    sources[E2E_BROWSER_PATH],
    /authenticatedHostedFetchOptions\(plan\.hostedRestBearerToken\)/,
  );
  assert.match(
    sources[E2E_BROWSER_PATH],
    /waitForHttpJson\(\s*`\$\{agentUrl\}\/ready`,[\s\S]*hostedAgentReadinessFetchOptions/,
  );
  // The runtime module owns the header construction itself.
  assert.match(
    sources[E2E_BROWSER_RUNTIME_PATH],
    /headers\.set\("Authorization", \["Bearer", bearerToken\]\.join\(" "\)\)/,
  );
});

test("hosted browser E2E records only actually verified websocket and session-cap proof", async () => {
  const source = await readFile(E2E_BROWSER_STORY_RUNNER_PATH, "utf8");

  assert.match(source, /let hostedWebSocketVerified = false/);
  assert.match(source, /hostedWebSocketVerified = true/);
  assert.match(source, /hosted_websocket_verified: hostedWebSocketVerified/);
  assert.match(source, /const secondTabTarget = hostedMode/);
  assert.match(source, /await fetchSignedSessionStartTarget\(\s*page,\s*hostedSecondTabIdentity/);
  assert.match(
    source,
    /secondTabSessionCap = await auditSecondTabSessionCap\(context, secondTabTarget\)/,
  );
  assert.match(source, /\.\.\.\(secondTabSessionCap \? \["second-tab-session-cap\.png"\] : \[\]\)/);
  assert.doesNotMatch(source, /secondTabSessionCapProof/);
});

test("hosted browser E2E does not infer partial recap evidence from visible recap alone", async () => {
  const source = await readFile(E2E_BROWSER_STORY_RUNNER_PATH, "utf8");

  assert.match(source, /terminalProofFromServerEvents\(serverEvents/);
  assert.match(
    source,
    /deterministicPartialRecapScenario \? null : recapPayloadVisible \? "completed" : null/,
  );
  assert.match(
    source,
    /Deterministic partial recap scenario did not observe partial_stage_success terminal proof/,
  );
  assert.doesNotMatch(
    source,
    /deterministicPartialRecapScenario && recapPayloadVisible\s*\?\s*"partial_stage_success"/,
  );
});

test("RELEASE-028: the browser harness holds no protocol-version literal of its own", async () => {
  // A-03 recorded a `const VIVA_VOICE_PROTOCOL_VERSION = 4` going stale
  // against the shared contract, caught only by comparing two source texts.
  // Task 13 removed the literal: the version is now read out of the server's
  // own validated `ready` frame, which is the behavioral proof in
  // e2e-browser-story.test.mjs. The scan that remains only bans the literal
  // coming back, in every file the extraction produced.
  const sources = await readAll(ALL_PATHS);

  for (const path of ALL_PATHS) {
    assert.doesNotMatch(sources[path], /const VIVA_VOICE_PROTOCOL_VERSION = \d+/, path);
  }
  assert.match(sources[E2E_BROWSER_STORY_ACTIONS_PATH], /releaseProtocolVersionFromServerFrame/);
  assert.match(sources[E2E_BROWSER_STORY_ACTIONS_PATH], /validatedVoiceFrameForRelease/);
});

test("RELEASE-028: the in-page WebSocket validates through one exposed binding, never a second browser schema", async () => {
  const source = await readFile(E2E_BROWSER_STORY_RUNNER_PATH, "utf8");

  assert.match(source, /exposeFunction\(bindingName/);
  assert.match(source, /const validate = window\[bindingName\]/);
  assert.match(source, /void validate\(decoded\)\.then/);
  // The page receives a validated reconstruction or a stable code -- never the
  // validator's own source and never its own allowed-key list.
  assert.doesNotMatch(source, /validateLearnerLoopContract\.toString\(\)/);
  assert.doesNotMatch(source, /parseVivaServerFrame\.toString\(\)/);
});

test("the Next.js readiness probe runs for hosted mode too, not only after a local web spawn", async () => {
  // Regression guard: the first extraction pass (931d2a6 -> the RELEASE-030
  // commit) nested `await waitForHttp(webUrl, ...)` inside the same
  // `if (!plan.hostedMode)` block that spawns the local web child, so a
  // hosted run skipped the bounded, typed readiness wait entirely and went
  // straight into Chromium. Pre-extraction this probe ran unconditionally
  // right after the (possibly no-op) web spawn; this asserts that shape is
  // restored by requiring the local-web-spawn block's own closing brace to
  // appear before the readiness call, i.e. the call is not nested inside it.
  const source = await readFile(E2E_BROWSER_PATH, "utf8");

  assert.match(
    source,
    /if \(!plan\.hostedMode\) \{\s*web = await spawnLocalWeb\([^)]*\);\s*\}[\s\S]{0,400}?await waitForHttp\(webUrl, 120_000, "Next\.js app"\);/,
    "waitForHttp(webUrl, ...) must run after the local-web-spawn block closes, not nested inside it",
  );
});

test("hosted browser E2E does not infer partial recap mode from stop-to-recap", async () => {
  const source = await readFile(E2E_BROWSER_PLAN_PATH, "utf8");

  assert.match(
    source,
    /const deterministicPartialRecapScenario = hostedScenarioId === "deterministic_partial_recap"/,
  );
  assert.doesNotMatch(source, /if \(stopToRecap\) return "deterministic_partial_recap"/);
});

test("e2e-browser spawns every local child through the shared explicit child-environment constructor", async () => {
  const source = await readFile(E2E_BROWSER_RUNTIME_PATH, "utf8");

  assert.match(source, /import \{ childEnvironmentFor \} from "\.\/child-environment\.mjs";/);
  assert.match(source, /agent: "local-browser-agent"/);
  assert.match(source, /web: "local-browser-web"/);
  assert.match(
    source,
    /env: childEnvironmentFor\(role, \{ parentEnv: process\.env, explicit: extraEnv \}\)/,
  );
  assert.doesNotMatch(source, /env: \{ \.\.\.process\.env, \.\.\.extraEnv \}/);
});

test("W07-PROD-WEB: the local web child is production-shaped -- `next build` completes before `next start` runs, never `next dev`", async () => {
  const source = await readFile(E2E_BROWSER_RUNTIME_PATH, "utf8");

  // A-44.2 / Level 2's own "production-shaped" mandate: the browser story
  // must measure the shipped CSP surface, never next dev's nonce-less
  // devtools styles (A-44.2's own style-src ruling: the shipping
  // configuration serves zero CSP violations of any directive).
  const buildArgsMatch = source.match(
    /args:\s*\[\s*"run",\s*"--cwd",\s*"apps\/web",\s*"build",?\s*\]/,
  );
  assert.ok(buildArgsMatch, "spawnLocalWeb must build the app's production bundle via its own build script");

  const startArgsMatch = source.match(
    /args:\s*\[\s*"run",\s*"--cwd",\s*"apps\/web",\s*"start",\s*"--",\s*"--hostname",\s*"127\.0\.0\.1",\s*"--port",\s*String\(webPort\),?\s*\]/,
  );
  assert.ok(startArgsMatch, "spawnLocalWeb must start the built production server on the allocated port");

  assert.doesNotMatch(
    source,
    /"apps\/web",\s*"dev",/,
    "no `next dev` invocation may remain in the runtime module",
  );

  // Adversarial review (W07-PROD-WEB amendment): the check this replaced
  // compared bare `"build"`/`"start"` string-literal positions, which could
  // match anywhere in the file (a comment, for instance), not the real
  // invocations. Comparing the two matches captured above by their own
  // `.index` ties the ordering claim to the args arrays this test just
  // proved exist. Source-text order is not control-flow order in general, so
  // the regex below -- the actual execution-order proof (`await
  // buildLocalWeb(...)` strictly precedes `return spawnLocalChild(...)`) --
  // still does the real work; this corroborates it against the two concrete
  // argv literals.
  assert.ok(
    buildArgsMatch.index < startArgsMatch.index,
    "the build step's args array must be defined before the start step's",
  );
  assert.match(
    source,
    /await buildLocalWeb\(env,\s*plan\.artifactDir\);\s*\n\s*return spawnLocalChild/,
    "spawnLocalWeb must await the build to completion before spawning the started server",
  );
});

test("W07-PROD-WEB: the local web build is bounded by an explicit, finite deadline, with a single code path and no dev-mode escape hatch", async () => {
  const source = await readFile(E2E_BROWSER_RUNTIME_PATH, "utf8");

  assert.match(source, /export const LOCAL_WEB_BUILD_TIMEOUT_MS = \d+/);
  assert.match(source, /timeoutMs: LOCAL_WEB_BUILD_TIMEOUT_MS/);
  // Single code path: nothing in this module may branch the local web child
  // back to dev shape, silently or otherwise -- every matrix leg and every
  // CI job must always exercise the shipped configuration. Targeted at real
  // code shapes (an identifier or env var naming a dev toggle), not prose --
  // this file's own doc comments legitimately discuss the absence of one.
  assert.doesNotMatch(source, /\bdevMode\b/i);
  assert.doesNotMatch(source, /VIVA_E2E_\w*DEV\w*/);
});

test("hosted browser E2E records answer-resolution latency evidence", async () => {
  const source = await readFile(E2E_BROWSER_STORY_RUNNER_PATH, "utf8");

  assert.match(source, /const answerResolutionStartedAt = Date\.now\(\)/);
  assert.match(
    source,
    /waitForPostAnswerProtocolProof\(\s*serverEvents,\s*HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS,\s*answerResolutionStartedAt/s,
  );
  assert.match(source, /HOSTED_MAX_SUBMITTED_ANSWER_RESOLUTION_MS/);
  assert.match(source, /latencyMs: postAnswerProtocolProof\.latencyMs/);
  assert.match(source, /latencyMs:\s*null/);
});

test("D-09 Branch B: the harness-authored pending-preview frame is source-marked as non-product evidence", async () => {
  const source = await readFile(E2E_BROWSER_STORY_RUNNER_PATH, "utf8");

  assert.match(source, /id: "pending_local_preview"/);
  assert.match(source, /kind: "structured_preview"/);
  assert.match(source, /must never satisfy required product-frame or release-proof checks/);
});

test("RELEASE-015: the browser harness supervises its local children as process groups", async () => {
  const sources = await readAll(ALL_PATHS);

  assert.match(
    sources[E2E_BROWSER_RUNTIME_PATH],
    /import \{[^}]*spawnManaged[^}]*\} from "\.\/process-supervisor\.mjs";/s,
  );
  assert.match(
    sources[E2E_BROWSER_RUNTIME_PATH],
    /import \{[^}]*spawnWithPortRetry[^}]*\} from "\.\/process-supervisor\.mjs";/s,
  );
  assert.match(sources[E2E_BROWSER_PATH], /installSignalCleanup\(/);
  // The retired local primitives: a bare spawn(), a private freePort(), and
  // the stop() that ended log streams before the child had exited. Checked
  // across every file the extraction produced, not only the runtime module.
  for (const path of ALL_PATHS) {
    assert.doesNotMatch(sources[path], /import \{ spawn \} from "node:child_process";/, path);
    assert.doesNotMatch(sources[path], /function freePort\(\)/, path);
    assert.doesNotMatch(sources[path], /if \(!exited\) child\.kill\("SIGTERM"\)/, path);
  }
});

test("RELEASE-023 / RELEASE-030: the browser entrypoint is import-safe, and its story and plan modules export no side-effecting top-level code", async () => {
  const sources = await readAll(ALL_PATHS);

  // The story runs only when the entrypoint is the process's own argv[1];
  // importing it must not delete an artifact directory or spawn
  // cargo/bun/Chromium.
  assert.match(sources[E2E_BROWSER_PATH], /async function main\(\)/);
  assert.match(sources[E2E_BROWSER_PATH], /if \(isDirectRun\(\)\) \{\s*await main\(\);/);
  // The extracted plan/runtime/story modules must expose their reducers
  // through named exports (a real import-safety proof: this file's own
  // sibling suites import and run every one of these), never a default
  // export bundling side effects.
  for (const path of [
    E2E_BROWSER_PLAN_PATH,
    E2E_BROWSER_RUNTIME_PATH,
    ...E2E_BROWSER_STORY_FAMILY_PATHS,
  ]) {
    assert.doesNotMatch(sources[path], /^export default/m, path);
  }
});
