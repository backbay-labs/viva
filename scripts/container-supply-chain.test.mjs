// RELEASE-026: Dockerfile supply-chain policy (immutable, digest-pinned base
// images; verified Bun release bytes; non-root runtimes) plus the sanitized
// release-evidence `container_provenance` record that separates pinned build
// inputs (always knowable locally, from the committed Dockerfiles) from
// deployed-image provenance (knowable only from the selected deployment,
// never inferred from a FROM line).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildContainerProvenanceEvidence } from "./production-release-gate.mjs";

const AGENT_DOCKERFILE_PATH = "agent/Dockerfile";
const MONITOR_DOCKERFILE_PATH = "Dockerfile.monitor";

const REVIEWED_BUILD_INPUTS = Object.freeze({
  base_images: Object.freeze({
    rust_builder:
      "rust:1.94.1-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2",
    debian_runtime:
      "debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241",
    playwright_monitor:
      "mcr.microsoft.com/playwright:v1.61.0-noble@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a",
  }),
  bun_archives: Object.freeze({
    "linux/amd64": Object.freeze({
      name: "bun-linux-x64.zip",
      sha256: "f5c546736f955141459de231167b6fdf7b01418e8be3609f2cde9dfe46a93a3d",
    }),
    "linux/arm64": Object.freeze({
      name: "bun-linux-aarch64.zip",
      sha256: "41b9f4f25256db897c2c135320e4f96c373e20ae6f06d8015187dac83591efc8",
    }),
  }),
  bun_version: "1.3.3",
});

test("every FROM in agent/Dockerfile pins a 64-hex sha256 digest", async () => {
  const dockerfile = await readFile(AGENT_DOCKERFILE_PATH, "utf8");
  const stages = parseFromLines(dockerfile);
  assert.equal(stages.length, 2, "agent/Dockerfile must declare exactly the builder and runtime stages");
  for (const stage of stages) {
    assert.match(
      stage.image,
      /@sha256:[0-9a-f]{64}$/,
      `${stage.raw.trim()} must pin an immutable sha256 digest, not a mutable tag`,
    );
  }
});

test("the FROM in Dockerfile.monitor pins a 64-hex sha256 digest", async () => {
  const dockerfile = await readFile(MONITOR_DOCKERFILE_PATH, "utf8");
  const stages = parseFromLines(dockerfile);
  assert.equal(stages.length, 1, "Dockerfile.monitor must declare exactly one FROM stage");
  assert.match(stages[0].image, /@sha256:[0-9a-f]{64}$/);
});

test("the reviewed base-image digests match the exact indexes pinned in each Dockerfile", async () => {
  const [agentDockerfile, monitorDockerfile] = await Promise.all([
    readFile(AGENT_DOCKERFILE_PATH, "utf8"),
    readFile(MONITOR_DOCKERFILE_PATH, "utf8"),
  ]);
  const { rustBuilder, debianRuntime } = agentBaseImages(agentDockerfile);
  const playwrightMonitor = parseFromLines(monitorDockerfile)[0].image;

  assert.equal(rustBuilder, REVIEWED_BUILD_INPUTS.base_images.rust_builder);
  assert.equal(debianRuntime, REVIEWED_BUILD_INPUTS.base_images.debian_runtime);
  assert.equal(playwrightMonitor, REVIEWED_BUILD_INPUTS.base_images.playwright_monitor);
});

test("the agent runtime image ends non-root as uid/gid 10001:10001, after every root-only apt step", async () => {
  const dockerfile = await readFile(AGENT_DOCKERFILE_PATH, "utf8");
  assert.match(dockerfile, /\nUSER 10001:10001\s*\n/);
  const userIndex = dockerfile.lastIndexOf("USER 10001:10001");
  const cmdIndex = dockerfile.indexOf("CMD ", userIndex);
  assert(userIndex > -1 && cmdIndex > userIndex, "USER 10001:10001 must be the last USER directive, before CMD");
  // Every apt-get step (root-only, image-build-time work) must appear before
  // the USER switch -- a non-root image can still install packages during
  // its own build, it just cannot run as root afterward.
  const lastAptIndex = lastIndexOfAll(dockerfile, "apt-get install");
  assert(lastAptIndex < userIndex, "apt-get install must not run after USER 10001:10001");
});

test("the monitor image ends non-root as Playwright's pwuser and owns /app/evidence", async () => {
  const dockerfile = await readFile(MONITOR_DOCKERFILE_PATH, "utf8");
  assert.match(dockerfile, /\nUSER pwuser\s*\n/);
  assert.match(dockerfile, /chown(?:\s+-R)?\s+pwuser:pwuser\s+\/app\/evidence/);
  const userIndex = dockerfile.lastIndexOf("USER pwuser");
  const cmdIndex = dockerfile.indexOf("CMD ", userIndex);
  assert(userIndex > -1 && cmdIndex > userIndex, "USER pwuser must be the last USER directive, before CMD");
  const lastAptIndex = lastIndexOfAll(dockerfile, "apt-get install");
  assert(lastAptIndex < userIndex, "apt-get install must not run after USER pwuser");
});

test("neither Dockerfile pipes a remote script into a shell", async () => {
  const [agentDockerfile, monitorDockerfile] = await Promise.all([
    readFile(AGENT_DOCKERFILE_PATH, "utf8"),
    readFile(MONITOR_DOCKERFILE_PATH, "utf8"),
  ]);
  assert.doesNotMatch(agentDockerfile, /curl[^\n]*\|\s*(ba)?sh\b/);
  assert.doesNotMatch(monitorDockerfile, /curl[^\n]*\|\s*(ba)?sh\b/);
  assert.doesNotMatch(monitorDockerfile, /\bbash\s+-s\b/);
});

test("Dockerfile.monitor verifies Bun 1.3.3 release archives by sha256 for both supported architectures, then removes the archive and its extraction directory", async () => {
  const dockerfile = await readFile(MONITOR_DOCKERFILE_PATH, "utf8");
  const checksums = parseBunArchiveChecksums(dockerfile);

  assert.deepEqual(checksums, {
    amd64: REVIEWED_BUILD_INPUTS.bun_archives["linux/amd64"],
    arm64: REVIEWED_BUILD_INPUTS.bun_archives["linux/arm64"],
  });
  assert.match(dockerfile, /bun-v1\.3\.3\//, "must download from the exact Bun 1.3.3 release tag");
  assert.match(dockerfile, /sha256sum -c/, "must verify the downloaded archive against its checksum");
  assert.match(dockerfile, /ARG TARGETARCH/, "must select the archive from the build platform, not hardcode one");
  assert.match(dockerfile, /unsupported TARGETARCH/i, "an unknown architecture must be rejected, not silently ignored");
  // The download, verification, extraction, install, and cleanup of the
  // temporary archive/extraction directory happen inside one RUN
  // instruction, so the cleanup actually reclaims the layer's own space
  // rather than only hiding the files in a later, separate layer.
  const bunRun = dockerfile
    .split(/\nRUN /)
    .find((block) => block.includes("bun_sha256"));
  assert(bunRun, "expected one RUN instruction performing the Bun install");
  assert.match(bunRun, /sha256sum -c/);
  assert.match(bunRun, /rm -rf "\$tmp"/, "the same RUN instruction must delete its own temporary directory");
});

test("Dockerfile.monitor's Playwright base-image tag matches Bun's own resolved playwright package version", async () => {
  const [dockerfile, bunLock] = await Promise.all([
    readFile(MONITOR_DOCKERFILE_PATH, "utf8"),
    readFile("bun.lock", "utf8"),
  ]);
  const dockerfileVersion = dockerfile.match(
    /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble/,
  )?.[1];
  const resolvedVersion = bunLock.match(/"playwright@(\d+\.\d+\.\d+)"/)?.[1];

  assert(dockerfileVersion, "Dockerfile.monitor must pin a Playwright image version");
  assert(resolvedVersion, "bun.lock must resolve a playwright version");
  assert.equal(dockerfileVersion, resolvedVersion);
});

test("release evidence build_inputs record the three reviewed base-image digests and Bun archive checksums parsed from the real Dockerfiles", async () => {
  const [agentDockerfile, monitorDockerfile] = await Promise.all([
    readFile(AGENT_DOCKERFILE_PATH, "utf8"),
    readFile(MONITOR_DOCKERFILE_PATH, "utf8"),
  ]);
  const buildInputs = {
    base_images: {
      ...agentBaseImages(agentDockerfile),
      playwright_monitor: parseFromLines(monitorDockerfile)[0].image,
    },
    bun_archives: bunArchivesByPlatform(parseBunArchiveChecksums(monitorDockerfile)),
    bun_version: "1.3.3",
  };
  buildInputs.base_images = {
    rust_builder: buildInputs.base_images.rustBuilder,
    debian_runtime: buildInputs.base_images.debianRuntime,
    playwright_monitor: buildInputs.base_images.playwright_monitor,
  };

  const evidence = buildContainerProvenanceEvidence({ buildInputs, env: {} });

  assert.deepEqual(evidence.build_inputs, REVIEWED_BUILD_INPUTS);
});

test("non-production evidence never infers deployment_outputs from a FROM line: it truthfully records not_proven", () => {
  const evidence = buildContainerProvenanceEvidence({
    buildInputs: REVIEWED_BUILD_INPUTS,
    env: {},
  });

  assert.equal(evidence.schema, "viva.container_provenance.v1");
  assert.equal(evidence.deployment_outputs.status, "not_proven");
  assert.equal(evidence.deployment_outputs.agent_image_digest, null);
  assert.equal(evidence.deployment_outputs.monitor_image_digest, null);
});

test("production deployment_outputs require exact sha256: agent and monitor output-image digests supplied by the selected deployment", () => {
  const agentDigest = `sha256:${"a".repeat(64)}`;
  const monitorDigest = `sha256:${"b".repeat(64)}`;
  const evidence = buildContainerProvenanceEvidence({
    buildInputs: REVIEWED_BUILD_INPUTS,
    env: {
      VIVA_RELEASE_AGENT_IMAGE_DIGEST: agentDigest,
      VIVA_RELEASE_MONITOR_IMAGE_DIGEST: monitorDigest,
    },
  });

  assert.equal(evidence.deployment_outputs.status, "proven");
  assert.equal(evidence.deployment_outputs.agent_image_digest, agentDigest);
  assert.equal(evidence.deployment_outputs.monitor_image_digest, monitorDigest);
});

test("a missing, tag-only, or malformed output-image digest never produces proven deployment_outputs", () => {
  const validMonitorDigest = `sha256:${"b".repeat(64)}`;
  const badAgentDigestValues = [
    undefined,
    "",
    "latest",
    "v1.2.3",
    "viva-agent:latest",
    "sha256:not-hex",
    `sha256:${"a".repeat(63)}`, // one character short
    `sha256:${"a".repeat(65)}`, // one character too long
    `SHA256:${"a".repeat(64)}`, // wrong case algorithm prefix
    "a".repeat(64), // missing the sha256: prefix entirely
  ];

  for (const badValue of badAgentDigestValues) {
    const evidence = buildContainerProvenanceEvidence({
      buildInputs: REVIEWED_BUILD_INPUTS,
      env: {
        VIVA_RELEASE_AGENT_IMAGE_DIGEST: badValue,
        VIVA_RELEASE_MONITOR_IMAGE_DIGEST: validMonitorDigest,
      },
    });
    assert.equal(
      evidence.deployment_outputs.status,
      "not_proven",
      `expected not_proven for agent digest ${JSON.stringify(badValue)}`,
    );
    assert.equal(evidence.deployment_outputs.agent_image_digest, null);
  }
});

test("a base-image build-input digest can never masquerade as a deployed output-image digest", () => {
  // Fully pinned build_inputs, but the operator supplied no deployment
  // output digests at all. If the implementation ever fell back to a
  // build-input digest (e.g. re-using the debian_runtime base image's own
  // digest as a stand-in "agent image digest"), this would wrongly become
  // "proven". It must not.
  const evidence = buildContainerProvenanceEvidence({
    buildInputs: REVIEWED_BUILD_INPUTS,
    env: {},
  });

  const baseImageDigests = Object.values(REVIEWED_BUILD_INPUTS.base_images);
  assert.equal(evidence.deployment_outputs.status, "not_proven");
  assert.equal(evidence.deployment_outputs.agent_image_digest, null);
  assert.equal(evidence.deployment_outputs.monitor_image_digest, null);
  for (const baseImageRef of baseImageDigests) {
    assert.notEqual(evidence.deployment_outputs.agent_image_digest, baseImageRef);
    assert.notEqual(evidence.deployment_outputs.monitor_image_digest, baseImageRef);
  }
});

function agentBaseImages(agentDockerfile) {
  const stages = parseFromLines(agentDockerfile);
  const rustBuilder = stages.find((stage) => stage.name === "builder")?.image;
  const debianRuntime = stages.find((stage) => stage.name === "runtime")?.image;
  assert(rustBuilder, "agent/Dockerfile must declare `FROM ... AS builder`");
  assert(debianRuntime, "agent/Dockerfile must declare `FROM ... AS runtime`");
  return { rustBuilder, debianRuntime };
}

function bunArchivesByPlatform(checksumsByArch) {
  assert(checksumsByArch.amd64, "Dockerfile.monitor must checksum the amd64 Bun archive");
  assert(checksumsByArch.arm64, "Dockerfile.monitor must checksum the arm64 Bun archive");
  return {
    "linux/amd64": checksumsByArch.amd64,
    "linux/arm64": checksumsByArch.arm64,
  };
}

function parseFromLines(dockerfile) {
  const stages = [];
  for (const line of dockerfile.split("\n")) {
    const match = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i);
    if (match) {
      stages.push({ raw: line, image: match[1], name: match[2] ?? null });
    }
  }
  return stages;
}

function parseBunArchiveChecksums(dockerfile) {
  const result = {};
  const pattern = /(amd64|arm64)\)\s*bun_archive="([^"]+)";\s*bun_sha256="([0-9a-f]{64})"/g;
  for (const match of dockerfile.matchAll(pattern)) {
    result[match[1]] = { name: match[2], sha256: match[3] };
  }
  return result;
}

function lastIndexOfAll(text, needle) {
  let last = -1;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    last = index;
    from = index + needle.length;
  }
  return last;
}
