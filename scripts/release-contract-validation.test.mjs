// RELEASE-028: every release consumer of a raw learner-loop or voice contract
// goes through one validated singleton. These tests exercise the adapter
// itself; the per-consumer proofs live in each consumer's own test file, and
// the only structural scan retained bans a direct raw-JSON import.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isReleaseVoiceTerminalReason,
  RELEASE_LEARNER_LOOP_CONTRACT,
  RELEASE_LEARNER_LOOP_MAX_TURN_MS,
  RELEASE_VOICE_TERMINAL_REASONS,
  ReleaseContractValidationError,
  releaseProtocolVersionFromServerFrame,
  validatedLearnerLoopForRelease,
  validatedVoiceFrameForRelease,
} from "./release-contract-validation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOSTILE_KEY = "viva_hostile_unknown_key";
const HOSTILE_VALUE = "viva-hostile-sentinel-value-9f2a";

async function rawLearnerLoopContract() {
  return JSON.parse(
    await readFile(path.join(repoRoot, "packages/core/src/learner-loop-contract.json"), "utf8"),
  );
}

function validReadyFrame() {
  return {
    type: "ready",
    version: 5,
    protocol: { preferred_version: 5, supported_versions: [5] },
    sample_rate_hz: 24_000,
    input_encoding: "pcm_s16le",
    brain: { provider: "synthetic", configured: true, selectable: true, live_runtime: false },
    store: {
      backend: "in_memory",
      available: true,
      durable: false,
      nonce_replay_protection: true,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    },
  };
}

function validStructuredErrorFrame() {
  return {
    type: "event",
    version: 5,
    event: {
      type: "structured_error",
      source: "gemini",
      code: "provider_timeout",
      message: "The provider did not answer in time.",
      terminality: "terminal",
      terminal_reason: "provider_timeout",
    },
  };
}

// ---------------------------------------------------------------------------
// Node resolution of the published validator
// ---------------------------------------------------------------------------

test("the root workspace declares @viva/core exactly and Node 24 can import both validators from it", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(manifest.devDependencies["@viva/core"], "workspace:*");

  const lock = await readFile(path.join(repoRoot, "bun.lock"), "utf8");
  assert.match(lock, /"@viva\/core": \["@viva\/core@workspace:packages\/core"/);
  assert.doesNotMatch(
    lock,
    /"@viva\/core": \["@viva\/core@\d/,
    "must resolve to the workspace, not a registry version",
  );

  // A real Node 24 process, from the repository root, with no NODE_PATH, no
  // loader, and no package-manager shim.
  const {
    NODE_PATH: _ignoredNodePath,
    NODE_OPTIONS: _ignoredNodeOptions,
    ...cleanEnv
  } = process.env;
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      'import("@viva/core/runtime-validation").then((m) => { if (typeof m.validateLearnerLoopContract !== "function" || typeof m.parseVivaServerFrame !== "function") process.exit(1); process.stdout.write("both-validators-present"); });',
    ],
    { cwd: repoRoot, env: cleanEnv, encoding: "utf8" },
  );
  assert.equal(output, "both-validators-present");
  assert.match(process.version, /^v2[4-9]\./);
});

test("scripts/release-contract-validation.mjs is the only file under scripts/ that imports the raw learner-loop JSON", async () => {
  const names = (await readdir(path.join(repoRoot, "scripts"))).filter((name) =>
    name.endsWith(".mjs"),
  );
  const offenders = [];
  for (const name of names) {
    // Exactly one exemption, exactly as the plan words it: the adapter is "the
    // only file under `scripts/` allowed to import `learner-loop-contract.json`
    // directly". Anything else that starts importing it must fail here.
    if (name === "release-contract-validation.mjs") continue;
    const source = await readFile(path.join(repoRoot, "scripts", name), "utf8");
    if (/from\s+"\.\.\/packages\/core\/src\/learner-loop-contract\.json"/.test(source)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// Learner-loop validation
// ---------------------------------------------------------------------------

test("the release learner-loop singleton is the validated, deeply frozen reconstruction of the raw contract", async () => {
  const raw = await rawLearnerLoopContract();

  assert.equal(RELEASE_LEARNER_LOOP_CONTRACT.schema, raw.schema);
  assert.equal(RELEASE_LEARNER_LOOP_CONTRACT.states.length, raw.states.length);
  assert.equal(RELEASE_LEARNER_LOOP_MAX_TURN_MS, raw.max_submitted_answer_resolution_ms);

  assert.equal(Object.isFrozen(RELEASE_LEARNER_LOOP_CONTRACT), true);
  assert.equal(Object.isFrozen(RELEASE_LEARNER_LOOP_CONTRACT.states), true);
  assert.equal(Object.isFrozen(RELEASE_LEARNER_LOOP_CONTRACT.states[0]), true);
  assert.equal(Object.isFrozen(RELEASE_LEARNER_LOOP_CONTRACT.states[0].copy), true);
  assert.throws(() => {
    RELEASE_LEARNER_LOOP_CONTRACT.states[0].copy.status_label = "rewritten";
  }, TypeError);
});

test("every learner-loop mutation the plan enumerates is rejected with the one stable code", async () => {
  const raw = await rawLearnerLoopContract();
  const mutations = {
    "unknown top-level field": (value) => {
      value[HOSTILE_KEY] = HOSTILE_VALUE;
    },
    "unknown nested state field": (value) => {
      value.states[0][HOSTILE_KEY] = HOSTILE_VALUE;
    },
    "unknown nested copy field": (value) => {
      value.states[0].copy[HOSTILE_KEY] = HOSTILE_VALUE;
    },
    "invalid enum": (value) => {
      value.states[0].resolution_kind = HOSTILE_VALUE;
    },
    "duplicate state id": (value) => {
      value.states.push(structuredClone(value.states[0]));
    },
    "malformed evidence-field list": (value) => {
      value.evidence_fields = [HOSTILE_VALUE];
    },
    "unknown terminal reason": (value) => {
      const terminal = value.states.find((state) => state.terminal_reason);
      terminal.terminal_reason = HOSTILE_VALUE;
    },
  };

  for (const [label, mutate] of Object.entries(mutations)) {
    const value = structuredClone(raw);
    mutate(value);
    let thrown;
    try {
      validatedLearnerLoopForRelease(value);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ReleaseContractValidationError, `${label} must be rejected`);
    assert.equal(thrown.code, "learner_loop_contract_invalid");
    assert.equal(thrown.message, "learner_loop_contract_invalid");
    assert.equal(thrown.cause, undefined, `${label}: the parser's own error must not be retained`);
    assert.equal(
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)).includes(HOSTILE_VALUE),
      false,
    );
    assert.equal(`${thrown.stack}`.includes(HOSTILE_VALUE), false);
  }
});

test("mutating the caller's raw object after validation cannot change the validated value", async () => {
  const raw = await rawLearnerLoopContract();
  const validated = validatedLearnerLoopForRelease(raw);
  const originalLabel = validated.states[0].label;

  raw.states[0].label = "rewritten-after-validation";
  raw.states.push({ id: "smuggled" });

  assert.equal(validated.states[0].label, originalLabel);
  assert.equal(
    validated.states.some((state) => state.id === "smuggled"),
    false,
  );
});

// ---------------------------------------------------------------------------
// Voice frame validation
// ---------------------------------------------------------------------------

test("a valid server frame is reconstructed, deeply frozen, and detached from the caller's object", () => {
  const raw = validReadyFrame();
  const validated = validatedVoiceFrameForRelease(raw);

  assert.equal(validated.type, "ready");
  assert.equal(validated.version, 5);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.brain), true);
  assert.notEqual(
    validated.brain,
    raw.brain,
    "must not be a cast reference to the caller's object",
  );

  raw.brain.provider = "cartesia_gemini";
  assert.equal(validated.brain.provider, "synthetic");
});

test("every hostile voice frame the plan enumerates yields only the stable sanitized code", () => {
  const cases = {
    "unknown top-level field": () => ({ ...validReadyFrame(), [HOSTILE_KEY]: HOSTILE_VALUE }),
    "unknown nested frame field": () => {
      const frame = validReadyFrame();
      frame.brain[HOSTILE_KEY] = HOSTILE_VALUE;
      return frame;
    },
    "unknown nested event field": () => {
      const frame = validStructuredErrorFrame();
      frame.event[HOSTILE_KEY] = HOSTILE_VALUE;
      return frame;
    },
    "wrong version": () => ({ ...validReadyFrame(), version: 4 }),
    "unknown frame type": () => ({ type: HOSTILE_VALUE, version: 5 }),
    "invalid event shape": () => ({ type: "event", version: 5, event: { type: "session_phase" } }),
    "transcript payload smuggled into an unknown key": () => {
      const frame = validStructuredErrorFrame();
      frame.event.transcript = HOSTILE_VALUE;
      return frame;
    },
    "non-object": () => HOSTILE_VALUE,
  };

  for (const [label, build] of Object.entries(cases)) {
    let thrown;
    try {
      validatedVoiceFrameForRelease(build());
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ReleaseContractValidationError, `${label} must be rejected`);
    assert.equal(thrown.code, "voice_server_frame_invalid");
    assert.equal(thrown.message, "voice_server_frame_invalid");
    assert.equal(thrown.cause, undefined);
    assert.equal(
      `${thrown.stack}`.includes(HOSTILE_VALUE),
      false,
      `${label} leaked the hostile value`,
    );
  }
});

test("a valid structured server error stays distinct from a malformed protocol frame (RELEASE-022)", () => {
  const validated = validatedVoiceFrameForRelease(validStructuredErrorFrame());

  assert.equal(validated.type, "event");
  assert.equal(validated.event.type, "structured_error");
  assert.equal(validated.event.terminality, "terminal");
  assert.equal(validated.event.terminal_reason, "provider_timeout");

  // The same socket delivering unparsed bytes is a different failure entirely.
  assert.throws(
    () => validatedVoiceFrameForRelease("{not-json"),
    (error) => error.code === "voice_server_frame_invalid",
  );
});

test("the protocol version is read out of a validated server frame, never from a local literal", () => {
  assert.equal(releaseProtocolVersionFromServerFrame(validReadyFrame()), 5);
  assert.throws(
    () => releaseProtocolVersionFromServerFrame({ ...validReadyFrame(), version: 4 }),
    (error) => error.code === "voice_server_frame_invalid",
  );
});

test("the release terminal vocabulary is the shared published one, not a local copy", () => {
  assert.ok(RELEASE_VOICE_TERMINAL_REASONS.length > 0);
  assert.equal(Object.isFrozen(RELEASE_VOICE_TERMINAL_REASONS), true);
  for (const reason of ["provider_timeout", "session_cap", "pre_loop_session_unavailable"]) {
    assert.equal(isReleaseVoiceTerminalReason(reason), true, `${reason} must be known`);
  }
  assert.equal(isReleaseVoiceTerminalReason(HOSTILE_VALUE), false);
  assert.equal(isReleaseVoiceTerminalReason(undefined), false);

  // Every terminal reason the learner-loop contract names is in the shared
  // vocabulary: one source, checked, rather than two lists that can drift.
  for (const state of RELEASE_LEARNER_LOOP_CONTRACT.states) {
    if (!state.terminal_reason) continue;
    assert.equal(
      isReleaseVoiceTerminalReason(state.terminal_reason),
      true,
      `${state.id} names ${state.terminal_reason}, which is outside the shared vocabulary`,
    );
  }
});
