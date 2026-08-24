# Viva architecture review — 2026-08-23

**Scope:** Workspace boundaries, browser/BFF/agent topology, authority, store abstractions, provider adapters, and change concentration.  
**Overall confidence:** High.

## Architectural verdict

The intended ports-and-adapters structure is visible and valuable, but the runtime has multiple competing authorities for the same learner facts. Browser, executor, adapter fixture, and store each decide portions of readiness, grading, recap, or schedule. The security boundary is much cleaner than the pedagogical/data boundary.

## Findings

| ID | Priority | Finding | Confidence |
| --- | --- | --- | --- |
| ARC-01 | P1 | Scheduling/mastery authority is split between TypeScript FSRS, Rust literals, executor grading, and browser recap rewriting | High |
| ARC-02 | P1 | Library/session do not consume one server-owned study-set projection | High |
| ARC-03 | P1 | Production behavior and deterministic fixture behavior share the same executor/store startup paths | High |
| ARC-04 | P2 | The advertised domain-purity gate does not check I/O dependencies | High |
| ARC-05 | P2 | Service, provider, data, CSS, and E2E responsibilities are concentrated in oversized modules | High |
| ARC-06 | P2 | Shared protocol types are duplicated across TypeScript/Rust without generation or exhaustive differential proof | Moderate |
| ARC-07 | P3 | `packages/ui-web` is not a meaningful design-system boundary | High |
| ARC-08 | P3 | `packages/core` still exports fixture-specific graders/recap helpers beside live contracts | High |

## What is solid

- The Rust workspace is organized around domain, adapters, data, service, and observe crates.
- `RealtimeBrain` makes synthetic/fake/live providers replaceable without forking the WebSocket edge.
- The browser cannot assert source context or tool results as authority.
- Store capabilities explicitly report durability, nonce replay protection, UUID translation, and raw-payload persistence.
- Signed-session preflight refuses an ephemeral store outside the bounded local failure-control exception.
- Protocol version and fixtures are shared conceptually across Rust and TypeScript; both reject unknown/untrusted paths aggressively.
- BFF routes keep agent REST credentials server-side and narrow browser identities through allowlists/capabilities.

## ARC-01 — P1 — One learner fact has multiple writers

The README claims scheduling authority lives in `packages/core`. Actual flow:

1. Rust `evaluate_spoken_answer` grades expected-term substring counts.
2. Rust `mark_concept_status` persists status.
3. Rust `schedule_review_item` persists one of four June 2026 timestamps.
4. Rust `build_session_recap` synthesizes buckets from expected-term positions.
5. Browser `recapPlanFromSessionEvents` overwrites those buckets from event status and the local study set.
6. TypeScript `ts-fsrs` computes a separate learner-visible next review.
7. Library history displays persisted server due dates.

This is not redundancy; it is contradictory authority. It explains the fixed-date defect, biology remapping, and recap/library disagreement.

**Recommendation:** Define a single canonical `TurnOutcome` and `StudySessionRecap` written from persisted turn evidence, then a single schedule writer. Browser projections may format but must not replace facts. Synthetic fixtures should implement the same interfaces while remaining unmistakably test-only.

## ARC-02 — P1 — Bootstrap and live loop project different sets

Landing/library obtains server snapshots. `/session` starts from compiled `seedStudySets[0]` and overlays route identity. There is no dedicated server-owned study-set/session projection consumed by both surfaces.

**Recommendation:** Add one authenticated read model for study metadata, concept IDs/labels, ingestion state, active question count, session mode/goal, and persisted schedule. Make both landing and session consume it. Route parameters select identity; they do not constitute data.

## ARC-03 — P1 — Fixture behavior leaks into production code paths

Three examples:

- Normal Postgres startup seeds and updates the biology fixture.
- Domain scheduling uses fixture-calendar literals.
- The deterministic evaluator/recap builder is invoked under the live provider path.

This is the root pattern behind several correctness findings: test determinism was achieved by putting fixture semantics in production behavior.

**Recommendation:** Move fixtures into explicit constructors/commands and inject clock, evaluator, scheduler, and seed strategy as ports. Production construction must have no implicit fixture mutation.

## ARC-04 — P2 — `agent:purity` does not enforce purity

CONTRIBUTING says the command keeps `agent-domain` I/O-free. `scripts/check-agent-domain-purity.sh` searches for residual Luca/cooking vocabulary; it does not reject `std::fs`, sockets, SQLx, reqwest, or other infrastructure dependencies.

**Recommendation:** Rename the current check to residue hygiene, then add a real crate-boundary policy. Options include manifest allowlists, `cargo deny` dependency bans for the domain crate, or an architecture test that fails on forbidden imports/features.

## ARC-05 — P2 — Change risk is concentrated

Largest modules:

- `agent-service/tests/voice_ws.rs`: 11,421 lines.
- `agent-service/src/ws.rs`: 5,467 lines.
- `data/src/memory.rs`: 5,145 lines.
- `apps/web/app/globals.css`: 4,864 lines.
- live provider runner/LLM: 3,175/3,028 lines.
- `data/src/postgres.rs`: 2,480 lines; `agent-service/src/app.rs`: 2,395.

`ws.rs` spans preflight, admission, turn deadlines, provider forwarding, tool execution, drain, terminal evidence, and protocol errors. `app.rs` spans health, CORS, library, ingestion, rate limiting, and usage. The memory/Postgres stores duplicate wide behavior. Tests are extensive but reviewability is poor.

**Recommendation:** Split by invariants, not file size alone: `ws/preflight`, `ws/admission`, `ws/turn`, `ws/provider`, `ws/terminal`; `http/health`, `http/library`, `http/ingestion`; store conformance tests shared between memory/Postgres. Freeze behavior with characterization tests before moving code.

## ARC-06 — P2 — Cross-language contracts can drift

Protocol constants and shapes exist in TypeScript and Rust with JSON fixture tests. That is better than informal duplication, but fixtures cover examples, not every enum/constraint/size relationship. COR-01 exists because the shared cap was not combined with the client buffering behavior.

**Recommendation:** Generate one side from a schema or run property/differential tests across serialized frames. Include size budgets, all terminal reasons, unknown fields, generation IDs, and audio lifecycle semantics.

## ARC-07 — P3 — UI package boundary is mostly nominal

`packages/ui-web` contains a small icon/ring surface; the product system lives in application components and a 4,864-line global stylesheet. This is not inherently wrong for one app, but it should not be described as a reusable UI architecture.

**Recommendation:** Keep it small and honest, or extract stable semantic primitives only when a second consumer exists. Do not manufacture a component library as a cleanup exercise.

## ARC-08 — P3 — Core exports fixture-specific product helpers

`packages/core` combines live contracts/FSRS with biology-specific `evaluateAnswer` and `buildSessionRecap` helpers. These can be imported into production accidentally and blur test/product semantics.

**Recommendation:** Move them to fixture/test modules with explicit names or delete them when no longer used.

## Target authority model

```text
Upload/parser -> canonical page spans -> server study-set projection
                                      -> question/rubric

Browser audio stream -> provider transcript -> authoritative evaluator
                                           -> persisted TurnOutcome
                                           -> persisted concept status
                                           -> recap from outcomes
                                           -> one schedule writer

Browser <- read model only; formats facts and manages local interaction state
```

The architecture should make it impossible for a route parameter, fixture object, or browser projection to invent ready state, mastery, or schedule.
