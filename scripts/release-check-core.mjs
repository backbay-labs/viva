// RELEASE-005/006/009/010/011: the testable orchestration primitives
// extracted out of scripts/release-check.mjs's top-level imperative
// script. release-check.mjs itself stays the top-level script -- it
// decides *which* commands to run, *in what order*, and how to assemble
// the final evidence bundle; this module only decides *how* one named
// command is spawned and finalized, *how* a readiness child's own
// environment is built, *how* evidence is audited for forbidden markers,
// and *how* the release_gate summary's freshness window is computed --
// each independently, behaviorally testable without spawning cargo/bun or
// executing the real release pipeline.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";

import { childEnvironmentFor } from "./child-environment.mjs";
import {
  DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
  GATE_ONLY_EVIDENCE_MARKERS,
  positiveIntegerOrDefault,
} from "./production-release-gate.mjs";
import { assertNoForbiddenEvidenceMarkers } from "./redaction-control.mjs";

/**
 * A registry + executor for named release-check commands.
 *
 * - Command names are checked for uniqueness *before* any log file is
 *   opened or any child is spawned -- a duplicate name is rejected
 *   immediately, rather than a second run silently clobbering the first
 *   run's logs (RELEASE-006/009).
 * - Every command name maps one-to-one to its own `${name}.stdout.log` /
 *   `${name}.stderr.log` pair.
 * - A spawn `error` (e.g. ENOENT) rejects the returned promise, exactly
 *   like a nonzero exit -- it can never hang or escape as an uncaught
 *   exception outside the caller's own cleanup path (RELEASE-005).
 * - Both log streams are fully flushed to disk before the command's
 *   record is pushed and the promise resolves (RELEASE-005).
 * - The spawned child receives only the explicit
 *   `childEnvironmentFor("release-check-command", ...)` environment, built
 *   fresh per call from `parentEnv` plus that command's own `extraEnv` --
 *   never a spread of `parentEnv` itself (RELEASE-029, preserved here, not
 *   copied as a second policy).
 */
export function createCommandRunner({
  artifactDir,
  root,
  parentEnv = process.env,
  spawnImpl = spawn,
}) {
  const commands = [];
  const seenNames = new Set();

  async function run(name, command, args, extraEnv = {}) {
    if (seenNames.has(name)) {
      throw new Error(`duplicate release command name: ${name}`);
    }
    seenNames.add(name);

    const started = Date.now();
    const stdoutPath = path.join(artifactDir, `${name}.stdout.log`);
    const stderrPath = path.join(artifactDir, `${name}.stderr.log`);
    const stdout = createWriteStream(stdoutPath);
    const stderr = createWriteStream(stderrPath);
    const env = childEnvironmentFor("release-check-command", { parentEnv, explicit: extraEnv });
    const child = spawnImpl(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);

    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        // "close" (not "exit") is deliberate: the child process's "exit"
        // event can fire before its own stdio streams have finished
        // draining into the pipes above, while "close" is documented to
        // fire only once those streams have closed -- avoiding a race
        // where the command record is finalized while output is still in
        // flight.
        child.once("close", resolve);
      });
    } catch (error) {
      await Promise.all([finishWritable(stdout), finishWritable(stderr)]);
      throw new Error(
        `${name} failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await Promise.all([finishWritable(stdout), finishWritable(stderr)]);

    const record = {
      name,
      command: [command, ...args].join(" "),
      exit_code: code,
      duration_ms: Date.now() - started,
      stdout_log: path.relative(root, stdoutPath),
      stderr_log: path.relative(root, stderrPath),
    };
    commands.push(record);
    if (code !== 0) {
      throw new Error(`${name} failed with exit code ${code}`);
    }
    return record;
  }

  return { run, commands };
}

// `child.stdout.pipe(stdout)` above already ends `stdout` on its own once
// the child's own stream ends -- calling `.end()` a second time throws
// `ERR_STREAM_ALREADY_FINISHED`. Ending it here too (guarded by
// `writableEnded`) is required only for a spawn error, where the child
// never truly started and its stdio streams never naturally end on their
// own. Either way, `finished()` resolves once the stream has actually
// reached "finish" -- whichever path ended it -- so a caller reading the
// log file immediately afterward always sees the complete content.
async function finishWritable(stream) {
  if (!stream.writableEnded) {
    stream.end();
  }
  await finished(stream);
}

/**
 * The explicit environment for the locally-spawned agent-service readiness
 * child: the fixed operational allowlist plus this target's own
 * constructed (never ambient-copied) provider configuration. Extracted so
 * it is directly, behaviorally testable against a hostile parent
 * environment without spawning the real (cargo-built) binary.
 */
export function providerReadinessChildEnv({ target, port, parentEnv = process.env }) {
  return childEnvironmentFor("release-check-provider-readiness", {
    parentEnv,
    explicit: {
      ...target.env,
      VIVA_AGENT_BIND_ADDR: `127.0.0.1:${port}`,
      VIVA_AGENT_PROVIDER: target.provider,
    },
  });
}

/**
 * The log pair for one provider-readiness bind attempt.
 *
 * `spawnManaged` opens these with `createWriteStream`, which truncates, so a
 * bounded bind-conflict retry that reused one pair would destroy the first
 * attempt's EADDRINUSE diagnostic -- the very evidence that justified the
 * retry. Attempt 1 keeps the stable, runbook-documented name; each later
 * attempt gets its own suffixed pair.
 */
export function providerReadinessLogPaths({ artifactDir, provider, attempt = 1 }) {
  const suffix = attempt > 1 ? `.attempt-${attempt}` : "";
  return {
    stdoutPath: path.join(artifactDir, `readiness-agent-${provider}${suffix}.stdout.log`),
    stderrPath: path.join(artifactDir, `readiness-agent-${provider}${suffix}.stderr.log`),
  };
}

/**
 * The single canonical evidence-redaction audit: scripts/redaction-
 * control.mjs's own implementation, plus the small set of markers
 * meaningful only in gate/release-evidence context
 * (RELEASE-002/020's raw_prompt/provider_prompt, from
 * production-release-gate.mjs's GATE_ONLY_EVIDENCE_MARKERS). This is a
 * genuinely data-driven check over real evidence -- it throws on forbidden
 * content regardless of what any caller's source text says elsewhere. The
 * caller's own injected `env` -- never `process.env` read internally --
 * controls secret-value scanning.
 */
export function auditReleaseEvidence(
  evidence,
  { context = "release evidence", env = process.env } = {},
) {
  assertNoForbiddenEvidenceMarkers(evidence, { context, env });
  const serialized = JSON.stringify(evidence);
  for (const marker of GATE_ONLY_EVIDENCE_MARKERS) {
    if (serialized.includes(marker)) {
      throw new Error(`${context} includes forbidden payload marker: ${marker}`);
    }
  }
}

/**
 * The release_gate summary block. `max_age_seconds` is parsed from
 * `VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS` using the exact same
 * `positiveIntegerOrDefault`/`DEFAULT_MAX_EVIDENCE_AGE_SECONDS` the
 * production gate's own summary uses (previously a hardcoded literal
 * `86_400` here, silently able to drift from an operator's override of
 * that shared variable).
 */
export function buildReleaseGateEvidence({
  browserResult,
  browserSkipShortcut,
  env = process.env,
  generatedAt,
}) {
  const browserSkipShortcutObserved = browserSkipShortcut || browserResult?.skipped === true;
  return {
    browser_skip_shortcut: browserSkipShortcutObserved,
    deploy_sha: releaseDeploySha(env),
    failure_class: browserSkipShortcutObserved ? "release_gate_stale_evidence" : null,
    generated_at: generatedAt.toISOString(),
    max_age_seconds: positiveIntegerOrDefault(
      env.VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS,
      DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
    ),
    sanitized: true,
    stage: "release_gate",
  };
}

export function releaseDeploySha(env = process.env) {
  for (const name of [
    "RAILWAY_GIT_COMMIT_SHA",
    "VERCEL_GIT_COMMIT_SHA",
    "GITHUB_SHA",
    "SOURCE_VERSION",
  ]) {
    const value = env[name]?.trim();
    if (value) return value.slice(0, 64);
  }
  return null;
}
