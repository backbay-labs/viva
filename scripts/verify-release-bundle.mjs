#!/usr/bin/env node
// RELEASE-004: signing a release bundle at generation time only proves it
// was self-consistent for whatever algorithm and environment produced it --
// it is not proof a *later* reader, in a *different* environment, should
// trust it. This is the separate downstream command: it re-verifies an
// already-stored evidence.json from a fresh environment, requiring a real
// HMAC (never an env-driven downgrade to a self-hash) and requiring the
// bundle's own bound run/deploy identity to match the verifier's own
// expected release identity, not merely whatever identity the bundle
// happened to record when it was generated.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertFreshProductionEvidence,
  assertProductionReleaseGate,
  assertReleaseBundleIntegrity,
} from "./production-release-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RELEASE_BUNDLE_VERIFICATION_SCHEMA = "viva.release_bundle_verification.v1";

// The same names RELEASE-003/007/008 (Task 10) bind at evidence-generation
// time -- re-supplied fresh by whatever is running this downstream command,
// which may be a different process, in a different environment, run well
// after generation.
const EXPECTED_IDENTITY_FIELDS = Object.freeze([
  {
    envKey: "VIVA_RELEASE_RUN_ID",
    label: "run_id",
    boundValue: (gate) => gate?.live_smoke?.run_id,
  },
  {
    envKey: "VIVA_RELEASE_DEPLOY_SHA",
    label: "deploy_sha",
    boundValue: (gate) => gate?.live_smoke?.deploy_sha,
  },
  {
    envKey: "VIVA_RELEASE_WEB_DEPLOY_ID",
    label: "web_deploy_id",
    boundValue: (gate) => gate?.deploy_identity?.release_deploy_ids?.web,
  },
  {
    envKey: "VIVA_RELEASE_AGENT_DEPLOY_ID",
    label: "agent_deploy_id",
    boundValue: (gate) => gate?.deploy_identity?.release_deploy_ids?.agent,
  },
]);

/**
 * Strictly verify a stored release evidence bundle from a fresh caller
 * environment. Throws on any failure; never mutates `evidence`.
 */
export function verifyReleaseBundleEvidence(evidence, { env = process.env, now = new Date() } = {}) {
  const gate = evidence?.production_release_gate ?? null;
  const productionRequested = gate?.production_requested === true;

  assertReleaseBundleIntegrity(evidence, { env, requireHmac: productionRequested });
  assertProductionReleaseGate(evidence, { env });

  if (productionRequested) {
    // ROW 341/RELEASE-011: re-verify age against *this* verification's own
    // now, independent of the stored (generation-time) `gate.allowed` --
    // see assertFreshProductionEvidence's own comment.
    assertFreshProductionEvidence(evidence, { env, now });
    for (const field of EXPECTED_IDENTITY_FIELDS) {
      assertIdentityFieldMatches(field, gate, env);
    }
  }

  return {
    schema: RELEASE_BUNDLE_VERIFICATION_SCHEMA,
    verified: true,
    production_requested: productionRequested,
    run_id: stringOrNull(gate?.live_smoke?.run_id),
    deploy_sha: stringOrNull(gate?.live_smoke?.deploy_sha),
    web_deploy_id: stringOrNull(gate?.deploy_identity?.release_deploy_ids?.web),
    agent_deploy_id: stringOrNull(gate?.deploy_identity?.release_deploy_ids?.agent),
    payload_sha256: stringOrNull(evidence?.release_bundle?.integrity?.payload_sha256),
  };
}

function assertIdentityFieldMatches({ envKey, label, boundValue }, gate, env) {
  const expected = stringOrNull(env[envKey]);
  if (expected === null) {
    // A missing expected-identity value is a verification failure, not a
    // silently skipped check -- exactly like a real mismatch.
    throw new Error(
      `release bundle verification requires ${envKey} in the verifying environment`,
    );
  }
  const actual = stringOrNull(boundValue(gate));
  if (actual !== expected) {
    throw new Error(
      `release bundle verification failed: bundle ${label} does not match the verifier's expected release identity (${envKey})`,
    );
  }
}

function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function main() {
  const evidenceArg = process.argv[2];
  if (!evidenceArg) {
    console.error("usage: node scripts/verify-release-bundle.mjs <evidence-path>");
    process.exitCode = 1;
    return;
  }
  const evidencePath = path.resolve(root, evidenceArg);
  let evidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    console.error(
      `release bundle verification failed: unable to read or parse ${evidenceArg}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    const summary = verifyReleaseBundleEvidence(evidence, { env: process.env });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(
      `release bundle verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
