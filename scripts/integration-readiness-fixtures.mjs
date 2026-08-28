// INTEGRATION-010 — the one canonical deploy/run binding fixture, as data.
//
// It lives in a sibling module rather than inside either suite because both
// `integration-readiness.test.mjs` (the Task 1 contract, which needs one valid binding for
// its RELEASE_READY document) and `integration-readiness-reconcile.test.mjs` (Task 10's own
// exhaustive typed rules) need the *same* valid document, and both files sit at the Plan-12
// unbudgeted 1,200-line ceiling that A-39.3 held this namespace to with no policy edit. Two
// copies of a shape this precise would drift; one copy cannot. Nothing here asserts or
// validates anything — it is the plan's Task 10 Step 3 structure and the seeds that build it.
import { createHash } from "node:crypto";

export const FIXTURE_FROZEN_SHA = "0123456789abcdef0123456789abcdef01234567";
export const FIXTURE_RUN_ID = "20260823T180000Z-0123456789ab";
/** A hosted GitHub run ID is a numeric string: a different type from the run ID above. */
export const FIXTURE_HOSTED_RUN_ID = "31401218406";
export const FIXTURE_MONITOR_STATE_KEY = "viva-hosted-monitor/state/live-monitor-state.v1.json";

export const fixtureHex = (length, seed) =>
  createHash("sha256").update(seed).digest("hex").slice(0, length);
export const fixtureDigest = (seed) => `sha256:${fixtureHex(64, seed)}`;
export const fixtureDeploymentId = (name) => `viva-${name}-deployment-01`;

const deployed = (name, extra) => ({
  deployment_id: fixtureDeploymentId(name),
  output_image_digest: fixtureDigest(`output-${name}`),
  deploy_sha: FIXTURE_FROZEN_SHA,
  ...extra,
});

/** The exact Task 10 Step 3 production structure, valid in every typed field. */
export const deployBindingFixture = () => ({
  git: { frozen_sha: FIXTURE_FROZEN_SHA, main_sha: FIXTURE_FROZEN_SHA },
  github: {
    run_id: FIXTURE_HOSTED_RUN_ID,
    run_attempt: 1,
    head_sha: FIXTURE_FROZEN_SHA,
  },
  release: {
    run_id: FIXTURE_RUN_ID,
    bundle_sha256: fixtureHex(64, "bundle"),
    verified_at: "2026-08-23T18:40:00.000Z",
  },
  build_inputs: {
    agent_base_image_digest: fixtureDigest("agent-base"),
    monitor_base_image_digest: fixtureDigest("monitor-base"),
    monitor_bun_archive_sha256: fixtureHex(64, "bun-archive"),
  },
  web: deployed("web", { origin: "https://web.example.invalid" }),
  agent: deployed("agent", { origin: "https://agent.example.invalid" }),
  monitor: deployed("monitor", {
    run_id: FIXTURE_RUN_ID,
    object_prefix: `viva-hosted-monitor/runs/${FIXTURE_RUN_ID}`,
    state_object_key: FIXTURE_MONITOR_STATE_KEY,
    state_etag: 'W/"live-monitor-state-2"',
  }),
  hosted_browser: {
    run_id: FIXTURE_RUN_ID,
    web_deployment_id: fixtureDeploymentId("web"),
    agent_deployment_id: fixtureDeploymentId("agent"),
    deploy_sha: FIXTURE_FROZEN_SHA,
  },
  live_smoke: {
    run_id: FIXTURE_RUN_ID,
    agent_deployment_id: fixtureDeploymentId("agent"),
    deploy_sha: FIXTURE_FROZEN_SHA,
    environment: "production",
  },
  all_bindings_match: true,
});
