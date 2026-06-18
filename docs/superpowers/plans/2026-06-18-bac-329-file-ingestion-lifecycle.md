# BAC-329 File Ingestion Lifecycle Plan

> For agentic workers: this is a server-owned PDF ingestion lifecycle hardening task. Do not treat client metadata validation or optimistic previews as trusted ingestion, and do not claim page/bbox provenance before Docling-backed exact-region evidence exists.

**Goal:** Add a server-owned file ingestion path with honest pending/processing/ready/failed/retry states, block trusted sessions until a file study set is ready, and keep source citations bounded to document-level spans.

**Scope:** Implement the local durable lifecycle for uploaded files across the domain port, in-memory store, Postgres adapter, service routes, web proxy, and library projection. This does not implement live Docling parsing, exact page/bbox locators, live provider transport proof, or full-document persistence in release evidence.

## Task 1: Model retry and trusted-session gating

Files:
- Modify: `agent/crates/agent-domain/src/ports.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.test.ts`
- Modify: `apps/web/lib/viva-library.ts`
- Modify: `apps/web/lib/viva-library.test.ts`

- [x] Add `retry` as a first-class ingestion status across the domain and core projection.
- [x] Gate connected agent readiness for `pending`, `processing`, `failed`, and `retry` server-owned study sets.
- [x] Project retry rows as actionable library states without exposing trusted start/resume.

## Task 2: Persist server-owned file ingestion artifacts

Files:
- Modify: `agent/crates/data/src/memory.rs`
- Modify: `agent/crates/data/src/postgres.rs`

- [x] Add `create_file_study_set` and `retry_file_study_set` to the study store contract and adapters.
- [x] Generate ready file study sets with server-owned documents, bounded source spans, concepts, and questions.
- [x] Return `failed` for unusable first uploads and `retry` for unusable replacement attempts.
- [x] Clear stale source spans, concepts, questions, and event authorizations before retry artifacts replace an existing study set.
- [x] Keep file citations document-level only: `document:chars:start-end`, no page or bbox locator claims.

## Task 3: Expose file ingestion and retry routes

Files:
- Modify: `agent/crates/agent-service/src/app.rs`
- Modify: `agent/crates/agent-service/tests/voice_ws.rs`
- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`

- [x] Add `POST /study-sets/files` for server-owned file ingestion.
- [x] Add `POST /study-sets/{study_set_id}/files/retry` for retrying failed or retry-needed file sets.
- [x] Mint session tokens only for ready file-ingested study sets.
- [x] Proxy file-ingestion POST bodies without injecting the private server bearer.
- [x] Prove failed/retry states cannot start trusted sessions and ready retries can.

## Task 4: Verification, review, PR

Files:
- All touched files.

- [x] Run focused data tests:
  - `cargo test --manifest-path agent/Cargo.toml -p data file_ingestion -- --nocapture`
  - `cargo test --manifest-path agent/Cargo.toml -p data file_ingested_study_set_flows_through_authorized_tools -- --nocapture`
- [x] Run broad Rust tests:
  - `cargo test --manifest-path agent/Cargo.toml -p data`
  - `cargo test --manifest-path agent/Cargo.toml -p agent-service`
  - `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1 cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws`
- [x] Run focused web/core tests:
  - `bun test packages/core/src/index.test.ts apps/web/lib/viva-library.test.ts apps/web/lib/viva-library-proxy.test.ts`
- [x] Run `bun run validate`.
- [x] Run `git diff --check`.
- [x] Run privacy/stop-rule scan for raw source persistence, raw audio/transcript persistence, page/bbox claims, and live-provider overclaiming.
- [ ] Commit, push, open PR, resolve every review thread, merge, and mark BAC-329 Done in Linear with evidence.
