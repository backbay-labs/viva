# syntax=docker/dockerfile:1

FROM rust:1.94.1-slim-bookworm AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates clang cmake pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY fixtures ./fixtures
COPY migrations ./migrations

RUN cargo build --manifest-path Cargo.toml --release -p agent-service

FROM debian:bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/agent-service /usr/local/bin/viva-agent

ENV RUST_LOG=info
EXPOSE 4318

CMD ["sh", "-c", "VIVA_AGENT_BIND_ADDR=${VIVA_AGENT_BIND_ADDR:-0.0.0.0:${PORT:-4318}} exec viva-agent"]
