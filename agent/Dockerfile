# syntax=docker/dockerfile:1

# RELEASE-026: immutable, digest-pinned base images -- a mutable tag can be
# repointed by its publisher at any time, silently changing what a rebuild
# produces. Reviewed and resolved on 2026-08-23; see
# docs/deployment-runbook.md#container-supply-chain-release-026.
FROM rust:1.94.1-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2 AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates clang cmake pkg-config \
  && rm -rf /var/lib/apt/lists/*

# ROW 365/529/685 LIVE DEFECT (fixed here): agent-domain's lib.rs reaches
# four directories up via include_str! to read
# packages/core/src/learner-loop-contract.json -- a sibling of agent/, not
# reachable from a build context scoped to agent/ alone (Docker refuses a
# COPY that steps outside its context). The build context is the repository
# root now (see the build command in docs/deployment-runbook.md and
# scripts/container-runtime-smoke.mjs); every source COPY below is prefixed
# accordingly, and packages/core is copied to the exact absolute path that
# same four-levels-up traversal resolves to from /app/crates/agent-domain/src.
COPY agent/Cargo.toml agent/Cargo.lock agent/rust-toolchain.toml ./
COPY agent/crates ./crates
COPY agent/fixtures ./fixtures
COPY agent/migrations ./migrations
COPY packages/core /packages/core

RUN cargo build --manifest-path Cargo.toml --release -p agent-service

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# RELEASE-026: run as a fixed non-root uid/gid. `USER <uid>:<gid>` with a
# numeric id needs no /etc/passwd entry, and Docker's `--chown` resolves the
# same numeric id identically.
COPY --from=builder --chown=10001:10001 /app/target/release/agent-service /usr/local/bin/viva-agent

ENV RUST_LOG=info
EXPOSE 4318
USER 10001:10001

CMD ["sh", "-c", "VIVA_AGENT_BIND_ADDR=${VIVA_AGENT_BIND_ADDR:-0.0.0.0:${PORT:-4318}} exec viva-agent"]
