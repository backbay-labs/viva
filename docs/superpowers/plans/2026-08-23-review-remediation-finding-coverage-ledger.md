# Plan 02 — Viva Review Remediation Finding Coverage Ledger

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to maintain this coordinator-owned ledger and `superpowers:verification-before-completion` before crediting any row. Workers execute the owning plans; they never edit this file.

**Goal:** Preserve complete, mechanically auditable ownership and proof requirements for every verified review finding, synthesis alias, recommendation, acceptance obligation, and external evidence gap without double-counting duplicates.

**Architecture:** The ledger is a normalized many-source-to-one-task registry. The twelve component reviews supply the immutable 128-instance baseline; synthesis/index/recommendation rows retain their source aliases and map to one canonical namespace and one exact Plan 03–15 filename. The coordinator alone records decision selections, PR references, exact-head proof, and final status.

**Tech Stack:** Markdown tables, stable source ordinals, canonical remediation IDs, Git/PR references, test/evidence artifact paths, arithmetic reconciliation.

**Spec:** `docs/superpowers/reviews/index.md`, `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`, and all 21 Markdown documents under `docs/superpowers/reviews/`.

---

**Corpus date:** 2026-08-23
**Reviewed revision:** `4d5d8276f03635ca74c04f4d500d13ce62198dd0`
**Ledger role:** coordinator-owned source of truth for remediation coverage
**Initial state:** no remediation work or proof is credited by this document

## Global Constraints

This ledger distinguishes **finding instances** from **unique canonical remediation tasks**. The twelve component reviews contain exactly 128 verified finding instances. Repeated discoveries and the synthesis documents are retained as aliases to a canonical ID; aliasing never removes a source obligation. A canonical task is complete only when its owning plan satisfies the union of every source row and recommendation mapped to that ID.

For each source-specific component or synthesis table, the immediately enclosing `###` heading is the row's required source-review field and the first cell is its severity/heading or stable ordinal; together they form the immutable source key. Mixed-source obligation and recommendation tables spell the source review directly in the first cell. No row relies on table order alone for identity.

During execution this file is coordinator-only. Workers must not edit it. Workers report branch, commit, and PR references plus exact proof artifacts to the coordinator; only the coordinator changes row status after checking the exact head and evidence. `UNSTARTED` means neither implementation nor proof has been credited. `DECISION_BLOCKED` means the named decision must be recorded before implementation begins. `PROVEN` is the only credited status; the coordinator writes it together with the PR reference, exact verified head, and proof artifact path, and no other status value exists besides `UNSTARTED`, `DECISION_BLOCKED`, and `PROVEN`.

Disposition meanings:

- `TESTED_FIX`: one bounded behavior change with a failing-before/passing-after test or equivalent adversarial control.
- `BATCH_FIX`: one atomic, mechanically checked batch of related cleanup or policy changes.
- `DUPLICATE_ALIAS`: this source instance is satisfied only by the referenced canonical task and its union proof.
- `DECISION_BLOCKED`: the source permits materially different contracts; an explicit decision record is prerequisite.
- `EXTERNAL_EVIDENCE`: completion requires evidence from an environment not established by repository-local tests.
- `DEFERRED`: Minor findings only, never Critical or Important; the coordinator records it only with an explicit approval reference plus the row's retained source alias, risk statement, accountable owner, deferral reason, and target milestone appended to the Required-proof cell.

No row may move to complete from prose, a source grep, a local counter, or a green lower-level test when its required proof names hosted, durable, browser, provider, or exact-deploy evidence.

## Coordinator Operating Tasks

- [ ] Initialize the ledger from the immutable 21-document corpus and verify the 128 component-instance arithmetic before any remediation credit.
- [ ] Record each selected `D-01` through `D-09` value in the program decision artifact, then change only rows blocked by that exact decision.
- [ ] For every worker PR, verify the reported commit and PR reference against the exact reviewed head, run or inspect the row's named proof, and record the reference before changing status.
- [ ] Audit every Minor finding's final disposition so implemented fixes, deliberate batch cleanup, duplicate aliases, and any explicitly approved defer evidence remain distinguishable.
- [ ] Re-run the 128-component, synthesis, index, acceptance-obligation, and recommendation reconciliation after every canonical-ID or alias change.
- [ ] When `D-04` records `SOFT_DELETE_UNDO`, record Plan 09 Task 10's decision-gated migration allocation (`0019_study_set_deletion_undo.sql`, the next free number after `0018`) here when Plan 09 reports it; Plan 09 only reports the allocation and never writes this ledger.
- [ ] Before Plan 15 freezes the candidate, require all repository-owned rows to carry exact-head proof, preserve external-evidence rows as uncredited until their named environment gate passes, and emit the final status from the frozen ledger snapshot.

## Owning plan filenames

| Namespace | Owning plan filename |
| --- | --- |
| `CRIT` | `2026-08-23-expedited-critical-path.md` |
| `LEARN` | `2026-08-23-learning-core-authority.md` |
| `VOICE` | `2026-08-23-voice-wire-auth-contract.md` |
| `DOMAIN` | `2026-08-23-rust-domain-integrity.md` |
| `ADAPTER` | `2026-08-23-live-provider-adapters.md` |
| `SERVICE` | `2026-08-23-agent-service-runtime.md` |
| `DATA` | `2026-08-23-persistence-postgres-privacy.md` |
| `WEBSESSION` | `2026-08-23-web-session-audio.md` |
| `WEBAPI` | `2026-08-23-web-api-security.md` |
| `RELEASE` | `2026-08-23-release-monitor-ci-supply-chain.md` |
| `FRONTEND` | `2026-08-23-frontend-accessibility-performance.md` |
| `PACKAGE` | `2026-08-23-package-build-contracts.md` |
| `INTEGRATION` | `2026-08-23-integrated-evidence-and-release-readiness.md` |

## Coordinator decision registry

Only these nine decisions may block GREEN implementation. `DECISION_REQUIRED` is an executable state: branch-neutral RED tests and interfaces may land, but decision-dependent production code stops until Connor records one allowed branch. No worker may create another decision ID.

| Decision | Scope | Current state | Blocks |
| --- | --- | --- | --- |
| `D-01` | Scheduling and exam authority | `SERVER_PERSISTED_FSRS` | `CRIT-SCHED-01`; `LEARN-D01-03`; Plan 09 Task 6's selected-D-01 persistence conformance; `WEBSESSION-DATA-01`; and their aliases |
| `D-02` | Question progression policy | `D-02B` | `LEARN-D02-04`; `ADAPTER-01`; Plan 09 Task 6's selected-D-02 cursor conformance; `WEBSESSION-PROGRESSION-01`; and their aliases |
| `D-03` | Mode and initial-goal behavior | `D-03B` | `LEARN-D03-05`, `WEBSESSION-MODE-01`, `FRONTEND-003`, and their aliases |
| `D-04` | Destructive delete behavior; allowed values are exactly `CONFIRM_DELETE` and `SOFT_DELETE_UNDO` | `CONFIRM_DELETE` | `DATA-016`, `SERVICE-018`, `WEBAPI-016`, `FRONTEND-004`, and their aliases; also Plan 06's conditional D-04 restore types/ports task (plan-local `DOMAIN-011`, credited through the `DATA-016`/`SERVICE-018`/`WEBAPI-016`/`FRONTEND-004` chain) |
| `D-05` | Learner-data retention, tombstone, and hard-purge semantics | `HARD_PURGE_TEXT` | `DATA-004`, `WEBAPI-009`, `WEBAPI-016`, `INTEGRATION-007`, and their aliases |
| `D-06` | Static-export support versus complete removal | `D-06B DELETE` | `WEBSESSION-STATIC-01`; `WEBAPI-015`; `RELEASE-031`; `FRONTEND-010`; `PACKAGE-05`; `INTEGRATION-004`; `INTEGRATION-007`; and their aliases |
| `D-07` | Token-only admission and refresh credential contract | `retain-token-only` | `VOICE-AUTH-001`; `VOICE-REFRESH-001`; `SERVICE-004`; `SERVICE-007`; `WEBSESSION-AUTH-02`; `WEBAPI-D07-11-12`; `FRONTEND-011`; `INTEGRATION-004`; and their aliases |
| `D-08` | Microphone/typed-answer disclosure scope and persistence | `D-08A` | `WEBSESSION-DISCLOSURE-01`, `FRONTEND-005`, `INTEGRATION-004`, `INTEGRATION-007`, and their aliases |
| `D-09` | Structured-preview evidence: real product frame versus non-certifying artifact | `D-09B` | `RELEASE-019`, `INTEGRATION-004`, `INTEGRATION-007`, and their aliases |

A canonical ID listed in a Blocks cell stops only its decision-dependent production work; ledger rows for that ID keep status `UNSTARTED` unless the row's own source obligation is decision-dependent, in which case the row carries `DECISION_BLOCKED` and names the decision in its Required-proof cell. Rows are flipped on a decision only when their status is `DECISION_BLOCKED` and their proof names that decision.

The state remains `DECISION_REQUIRED` until any branch-specific parameters required by Program Section 3 are present: D-01's exact exam-margin duration plus calendar/time-zone rule, D-06A's named static consumer and separate server BFF, and D-07B's named replacement owner/gateway/authentication boundary. A branch letter without those required values does not unblock GREEN.

The canonical recording act for a decision is replacing the matching registry row's `Current state` cell in place with the exact selected branch selector (for example `CONFIRM_DELETE` or `SOFT_DELETE_UNDO` for `D-04`). An appended Program-Task-2-schema recording row is optional provenance and must repeat the same selector; Plan 06's Task 1A/3A checkpoints and Plan 12's Task 18 parse both forms and hard-stop (exit 64) on zero or conflicting matches, so no second variant may ever be written.

Ledger-local canonical selectors are used only when one source obligation spans mutually exclusive or multiple literal execution-plan IDs:

- `LEARN-D01-03` selects exactly `LEARN-003A` or `LEARN-003B` after `D-01`.
- `LEARN-D02-04` selects exactly `LEARN-004A` or `LEARN-004B` after `D-02`.
- `LEARN-D03-05` selects exactly `LEARN-005A` or `LEARN-005B` after `D-03`.
- `LEARN-PAIR-001-002` requires both literal Plan 04 IDs `LEARN-001` and `LEARN-002`.
- `LEARN-PAIR-006-010` requires both literal Plan 04 IDs `LEARN-006` and `LEARN-010`.
- `DOMAIN-MULTIPLAN-TERMINAL-SCHEDULE-01` requires Plan 06 `DOMAIN-005` for terminal-string authority and Plan 03 `CRIT-SCHED-01` for deletion of both duplicate `storage_due_at_for_status` helpers.
- `DOMAIN-RELEASE-PURITY-SHELL-01` requires Plan 06 `DOMAIN-001` and Plan 12 `RELEASE-001`.
- `ADAPTER-PAIR-04-05` requires both literal Plan 07 IDs `ADAPTER-04` and `ADAPTER-05`.
- `ADAPTER-UNION-001-006-007` requires literal Plan 07 IDs `ADAPTER-01`, `ADAPTER-06`, and `ADAPTER-07`.
- `SERVICE-PAIR-001-002` requires literal Plan 08 IDs `SERVICE-001` and `SERVICE-002`.
- `SERVICE-PAIR-003-004` requires literal Plan 08 IDs `SERVICE-003` and `SERVICE-004`.
- `SERVICE-UNION-001-004` requires every literal Plan 08 ID from `SERVICE-001` through `SERVICE-004`.
- `SERVICE-WEBSESSION-RUNTIME-RECOVERY-01` requires Plan 08 `SERVICE-001` / `SERVICE-002` and Plan 10 `WEBSESSION-RECOVERY-01`.
- `DATA-PAIR-006-007` requires literal Plan 09 IDs `DATA-006` and `DATA-007`.
- `DATA-PAIR-009-013` requires literal Plan 09 IDs `DATA-009` and `DATA-013`.
- `DATA-WEBAPI-EXPIRY-CAPACITY-01` requires Plan 09 `DATA-008` and Plan 11 `WEBAPI-005`.
- `PACKAGE-PAIR-01-02` requires both literal Plan 14 IDs `PACKAGE-01` and `PACKAGE-02`.
- `VOICE-PAIR-TOKEN-AUTH` requires literal Plan 05 IDs `VOICE-TOKEN-001` and `VOICE-AUTH-001`.
- `VOICE-SERVICE-AUTH-READY-01` requires Plan 05 `VOICE-AUTH-001` and Plan 08 `SERVICE-009`.
- `WEBAPI-D07-11-12` selects exactly `WEBAPI-011` or `WEBAPI-012` after `D-07`.
- `WEBAPI-PAIR-007-008` requires literal Plan 11 IDs `WEBAPI-007` and `WEBAPI-008`.
- `WEBSESSION-CLEANUP-PROTOCOL-PLAYBACK` requires literal Plan 10 IDs `WEBSESSION-PROTOCOL-01` and `WEBSESSION-PLAYBACK-01`; the former owns the characterized reducer deletion and the latter owns the characterized empty-queue deletion.
- `WEBSESSION-PAIR-PROTOCOL-RECAP` requires literal Plan 10 IDs `WEBSESSION-PROTOCOL-01` and `WEBSESSION-RECAP-01`.
- `WEBSESSION-PAIR-RECOVERY-AUDIO` requires literal Plan 10 IDs `WEBSESSION-RECOVERY-01` and `WEBSESSION-AUDIO-01`.
- `WEBSESSION-TASK10-LOCAL-DATE-01` identifies the local-date obligation inside Plan 10 Task 10; its literal execution ID is `WEBSESSION-TERMINAL-01`, but local-date proof is distinct from that ID's terminal-recap meaning.
- `CRIT-SERVICE-SEED-SCHEDULE-01` requires Plan 03 `CRIT-SCHED-01` and Plan 08 `SERVICE-013`.
- `RELEASE-PAIR-005-006` requires literal Plan 12 IDs `RELEASE-005` and `RELEASE-006`.
- `RELEASE-UNION-003-007-008` requires literal Plan 12 IDs `RELEASE-003`, `RELEASE-007`, and `RELEASE-008`.
- `RELEASE-UNION-013-014-017` requires literal Plan 12 IDs `RELEASE-013`, `RELEASE-014`, and `RELEASE-017`.
- `RELEASE-MULTIPLAN-GATE-01` requires literal Plan 12 IDs `RELEASE-002`, `RELEASE-003`, and `RELEASE-004`.
- `RELEASE-MULTIPLAN-DEADLINE-DEPLOY-INTEGRITY-01` requires literal Plan 12 IDs `RELEASE-013`, `RELEASE-018`, `RELEASE-003`, and `RELEASE-004`.
- `RELEASE-MULTIPLAN-TOKEN-TERMINAL-01` requires Plan 13 `FRONTEND-001` for token authority and Plan 05 `VOICE-TERMINATION-001` plus Plan 12 `RELEASE-028` for validated smoke terminal vocabulary.

Plan-local execution IDs with no ledger row of their own (for example Plan 08's `SERVICE-011`, `SERVICE-012`, and `SERVICE-014`) are never cited as ledger rows; their work is credited only through the canonical rows that name their tasks or aliases.

## Integration merge record

At Plan 03 merge time the coordinator appends the merge commit below as one literal line in exactly the format `Plan 03 merge SHA: <40-hex>`. Plan 04's LEARN-000 Step 1 parses exactly that format (taking the last such line) and has no fallback; under the coordinator-authorized Plan 03 two-PR split, the line records the PR `03-audio` merge first and a second line in the same format records the PR `03-scheduling` merge.

Plan 03 merge SHA: 6735f91206438320d05eec4c56ac1da08bb8c2ab

## Mechanical corpus reconciliation

### Twenty-one reviewed Markdown documents

| Class | Documents | Count |
| --- | --- | ---: |
| Coordinator/index | `index.md` | 1 |
| Component aggregate | `2026-08-23-comprehensive-review-summary.md` | 1 |
| State record | `2026-08-23-project-state.md` | 1 |
| Synthesis reviews | architecture, correctness, security, reliability/performance, quality/tests, frontend/UX | 6 |
| Component reviews | architecture-consistency, web-ui, web-session-client, web-api-proxy, packages-shared, rust-agent-domain, rust-agent-adapters, rust-agent-service, rust-data-observe, scripts-e2e-monitoring, scripts-release-gates, security | 12 |
| **Total** | **1 + 1 + 1 + 6 + 12** | **21** |

### The 128 verified component finding instances

| Component review | Critical | Important | Minor | Instances |
| --- | ---: | ---: | ---: | ---: |
| Rust agent-domain | 1 | 4 | 6 | 11 |
| Rust agent-adapters | 0 | 6 | 5 | 11 |
| Rust agent-service | 0 | 5 | 4 | 9 |
| Rust data + observe | 0 | 5 | 8 | 13 |
| Web API + proxy | 0 | 2 | 6 | 8 |
| Web session client | 0 | 2 | 8 | 10 |
| Web UI | 1 | 4 | 7 | 12 |
| Shared packages | 0 | 3 | 8 | 11 |
| Release-gate scripts | 0 | 4 | 8 | 12 |
| E2E + monitoring scripts | 0 | 4 | 8 | 12 |
| Cross-cutting security | 0 | 2 | 6 | 8 |
| Architecture + contracts | 0 | 3 | 8 | 11 |
| **Totals** | **2** | **44** | **82** | **128** |

Arithmetic checks: `1+1=2` Critical; `4+6+5+5+2+2+4+3+4+4+2+3=44` Important; `6+5+4+8+6+8+7+8+8+8+6+8=82` Minor; `2+44+82=128` instances. The synthesis and index aliases below are deliberately excluded from 128 because they restate component instances or combine them into cross-cutting findings.

### Mechanical counting command

This is the ledger's mechanical counting command referenced by the program's Step 3. The coordinator runs it from the repository root at initialization and re-runs it after every canonical-ID or alias change; any deviation from the expected results below blocks remediation credit until the ledger and this section are reconciled together.

```bash
LEDGER=docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md

# 1. Source-document count
ls docs/superpowers/reviews/*.md | wc -l

# 2. Data rows per ledger section (header, separator, and bold total rows excluded)
awk '/^#{2,3} /{sec=$0}
     /^\| /{if ($0 ~ /^\| ---/ || $0 ~ /^\| \*\*/ || $0 ~ /^\| (Source|Class|Component review|Ledger population|Namespace|Decision) /) next; c[sec]++}
     END{for (s in c) printf "%4d  %s\n", c[s], s}' "$LEDGER" | sort -k2

# 3. Component-instance severity split
awk '/^## Component finding-instance ledger/{on=1}
     /^### Finding-instance versus canonical-task reconciliation/{on=0}
     on && /^\| (Critical|Important|Minor) /{c[$2]++; t++}
     END{printf "%d component rows: %d Critical, %d Important, %d Minor\n", t, c["Critical"], c["Important"], c["Minor"]}' "$LEDGER"

# 4. Traceability rows and unique canonical IDs
awk '/^## Component finding-instance ledger/{on=1}
     on && /^\| /{split($0,f,"|"); id=f[3]; gsub(/[ `]/,"",id);
       if (id ~ /^[A-Z][A-Z0-9-]+$/){rows++; if (!(id in seen)){seen[id]=1; uniq++}}}
     END{printf "%d traceability rows, %d unique canonical IDs\n", rows, uniq}' "$LEDGER"
```

Expected results:

- Command 1 prints `21` reviewed source documents.
- Command 2 prints the twelve component sections at `11+11+9+13+8+10+12+11+12+12+8+11=128`; the six synthesis alias sections at `8+10+12+7+10+11=58`; the index cross-codebase alias ledger at `26`; the two acceptance-obligation sections at `29+21=50`; and the three final-recommendation sections at `29+28+27=84`. The owning-plan (13), decision-registry (9), document-class (5), severity-summary (12), and reconciliation (5) tables are structural and excluded from the 346.
- Command 3 prints `128 component rows: 2 Critical, 44 Important, 82 Minor`.
- Command 4 prints `346 traceability rows, 160 unique canonical IDs`.

## Component finding-instance ledger: 128 rows

### Rust agent-domain: 11 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Critical C1 — fixed June-2026 due dates | `CRIT-SCHED-01` | `2026-08-23-expedited-critical-path.md` | `DECISION_BLOCKED` | Decision `D-01` selects scheduling/exam authority; then injected-clock conformance proves future-relative status-sensitive dates across live/synthetic writers with no fixed literals. | `PROVEN` |
| Important I1 — purity gate checks residue, not I/O | `DOMAIN-001` | `2026-08-23-rust-domain-integrity.md` | `TESTED_FIX` | Gate rejects forbidden domain dependencies/imports and fails when its required inspection tool fails; public claims match the implemented invariant. | `UNSTARTED` |
| Important I2 — recap fabricated from expected terms | `LEARN-001` | `2026-08-23-learning-core-authority.md` | `TESTED_FIX` | Recap is rebuilt from persisted turn outcomes; all-missed, mixed, replay, and reconnect tests prove no expected-position fabrication. | `PROVEN` |
| Important I3 — substring grading and unreachable rubric bands | `LEARN-002` | `2026-08-23-learning-core-authority.md` | `TESTED_FIX` | Typed evaluator/rubric tests prove negation, contradiction, synonym, uncertainty, exact-boundary, and challenge behavior with versioned evidence. | `PROVEN` |
| Important I4 — no direct domain boundary tests | `DOMAIN-002` | `2026-08-23-rust-domain-integrity.md` | `TESTED_FIX` | Exact Plan 06 `DOMAIN-002` table/property/mutation tests pin its integrated learning events, ports, exports, fixtures, validation, sanitizers, and saturation; Plan 04 `LEARN-001`, `LEARN-002`, and the selected `LEARN-D01-03` branch supply the owned recap, grading, binding, and scheduling boundary tests. | `UNSTARTED` |
| Minor M1 — no session-phase transition invariant | `DOMAIN-003` | `2026-08-23-rust-domain-integrity.md` | `TESTED_FIX` | Transition table rejects illegal and post-terminal sequences and is enforced at the emission boundary. | `UNSTARTED` |
| Minor M2 — BrainProviderFailure constructor bypass | `DOMAIN-004` | `2026-08-23-rust-domain-integrity.md` | `TESTED_FIX` | Struct literals/deserialization cannot create unsanitized failure fields; hostile Unicode and marker tests pass. | `PROVEN` |
| Minor M3 — triplicated terminal strings and duplicate schedule-date helpers | `DOMAIN-MULTIPLAN-TERMINAL-SCHEDULE-01` | `2026-08-23-rust-domain-integrity.md` | `BATCH_FIX` | Exact Plan 06 `DOMAIN-005` consumes Plan 04's one terminal-reason declaration, parity-tests serde/`as_str`/`ALL`, and derives close text from the wire string; exact Plan 03 `CRIT-SCHED-01` deletes both duplicate `storage_due_at_for_status` helpers and proves the selected injected-clock schedule path. Both proofs are required. | `PROVEN` |
| Minor M4 — fail-open StudyMemoryStore write defaults | `DOMAIN-006` | `2026-08-23-rust-domain-integrity.md` | `TESTED_FIX` | Mutation/conformance tests prove incomplete stores fail closed for writes and surface every unsupported/dropped operation in capability/count evidence. | `PROVEN` |
| Minor M5 — fixture text constructor in production AudioFrame API | `DOMAIN-007` | `2026-08-23-rust-domain-integrity.md` | `BATCH_FIX` | Fixture-only naming/feature boundary prevents production misuse; odd-length input and repeated serialization behavior are tested. | `PROVEN` |
| Minor M6 — DigestOnly envelope accepts missing digest | `DOMAIN-008` | `2026-08-23-rust-domain-integrity.md` | `TESTED_FIX` | Fail-closed validation requires a correctly shaped digest under DigestOnly and bounds counts/duration; missing/malformed/absurd mutations fail. | `PROVEN` |

### Rust agent-adapters: 11 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — live path writes fabricated strong mastery | `ADAPTER-01` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Live-transport test proves persisted status/schedule derives from the authoritative evaluation and no fixture IDs/default strong status can be written. | `UNSTARTED` |
| Important I2 — biology fallback spoken in live mode | `ADAPTER-01` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Empty/tool-only live response produces a typed sanitized failure or grounded neutral retry; fixture phrase is unreachable outside fake transport. | `UNSTARTED` |
| Important I3 — multi-turn response IDs lack QuestionStarted | `ADAPTER-02` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Every response emits its typed start lifecycle; second-turn live/fake/client integration proves no event is dropped as stale. Plan 07 supplies only the adapter-side half; the client-side staleness-guard half is owned by Plan 10 (`apps/web/lib/viva-agent-client.ts`) and this row closes only with Plan 10's linked test. | `UNSTARTED` |
| Important I4 — Cartesia cancel/timeout drops sockets abruptly | `ADAPTER-03` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Fake socket asserts cancel request and graceful close on barge-in/timeout; live sanitized evidence confirms provider work stops within deadline. | `UNSTARTED` |
| Important I5 — cold connections and full-stage buffering | `ADAPTER-PAIR-04-05` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Exact Plan 07 IDs `ADAPTER-04` and `ADAPTER-05` both pass: reused clients/connections are identity-tested and staged latency proves incremental SSE/TTS to first audio. | `UNSTARTED` |
| Important I6 — live errors emitted as fake and unclassified | `ADAPTER-06` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Live store/protocol failures emit correct source, stage, failure_class, retry eligibility, and terminal reason with no fake labels or raw payload. | `UNSTARTED` |
| Minor M1 — fabricated transcript confidence | `ADAPTER-07` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Provider confidence is parsed when present and remains absent otherwise; no fixed 0.91/1.0 enters live events. | `UNSTARTED` |
| Minor M2 — five unused dependencies | `ADAPTER-08` | `2026-08-23-live-provider-adapters.md` | `BATCH_FIX` | Dependency linter plus cargo build/test proves unused entries removed and any retained tracing dependency has real spans. | `UNSTARTED` |
| Minor M3 — unreachable fallback/budget/source-context code | `ADAPTER-08` | `2026-08-23-live-provider-adapters.md` | `BATCH_FIX` | Dead branches/APIs removed or made reachable with tests; active fallback attribution uses the promoted model. | `UNSTARTED` |
| Minor M4 — Ink query values not encoded/typed | `ADAPTER-07` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | URL tests cover spaces, ampersands, fragments, invalid numerics, and accepted boundary values. | `UNSTARTED` |
| Minor M5 — invalid Gemini key header misclassified retryable | `ADAPTER-06` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Primary and fallback invalid-header paths classify non-retryable provider auth failure without leaking key material. | `UNSTARTED` |

### Rust agent-service: 9 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — no heartbeat/between-turn idle expiry | `SERVICE-001` | `2026-08-23-agent-service-runtime.md` | `TESTED_FIX` | Half-open and sleeping-client tests prove dead peer/idle lease release well below six hours and bounded reconnect succeeds. | `UNSTARTED` |
| Important I2 — outbound writes have no deadline | `SERVICE-002` | `2026-08-23-agent-service-runtime.md` | `TESTED_FIX` | Slow-reader test proves bounded `slow_client` eviction, lease/provider permit release, timer responsiveness, and graceful process drain. | `UNSTARTED` |
| Important I3 — spoofable left-most XFF limiter key | `SERVICE-003` | `2026-08-23-agent-service-runtime.md` | `TESTED_FIX` | Direct peer and explicit trusted-proxy tests cover spoofed chains, rightmost untrusted hop, unknown peers, and configured session caps. | `UNSTARTED` |
| Important I4 — token-only WS preflight unauthenticated | `SERVICE-004` | `2026-08-23-agent-service-runtime.md` | `TESTED_FIX` | Decision `D-07` selects the branch first. Upgrade without/with invalid subprotocol token is rejected before slot/Ready; valid token admission and nonce semantics remain correct. | `UNSTARTED` |
| Important I5 — evidence/usage vectors unbounded | `SERVICE-005` | `2026-08-23-agent-service-runtime.md` | `TESTED_FIX` | Million-event stress proof shows bounded memory/retention and O(1) readiness summary with sanitized export behavior. | `UNSTARTED` |
| Minor M1 — duplicate provider-turn accounting functions | `SERVICE-006` | `2026-08-23-agent-service-runtime.md` | `BATCH_FIX` | One mapping remains or divergence is explicit; exhaustive event table proves submitted-answer and provider-turn counters. | `UNSTARTED` |
| Minor M2 — trusted refresh cannot know rotated session ID | `SERVICE-007` | `2026-08-23-agent-service-runtime.md` | `DECISION_BLOCKED` | Decision `D-07` selects token-only/refresh semantics; typed refresh test then proves identity continuity without weakening signed mode. | `UNSTARTED` |
| Minor M3 — serialization fallback emits protocol v1 | `SERVICE-008` | `2026-08-23-agent-service-runtime.md` | `TESTED_FIX` | Forced serialization-failure test uses the current protocol constant and is parsed by the TS client fixture. | `UNSTARTED` |
| Minor M4 — dead ReadyFrame duplicate | `SERVICE-009` | `2026-08-23-agent-service-runtime.md` | `BATCH_FIX` | Duplicate type/re-export removed or made single wire source; compile/fixture parity proves no drift. The coordinator closes this row against Plan 08's absence-assertion proof (Plan 08 Task 5) plus the linked Plan 05 `VOICE-READY-001` removal-commit SHA; the removal commit itself is Plan 05's. | `UNSTARTED` |

### Rust data + observe: 13 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — durable Postgres suite self-conflicts | `DATA-001` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Required Postgres 16 job uses isolated database/schema state and passes migration/backfill/conformance under deterministic scheduling. | `UNSTARTED` |
| Important I2 — evaluation compat insert is check-then-insert | `DATA-002` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Concurrent envelope/evaluation replay test proves idempotent ON CONFLICT behavior and no duplicate-key surfacing. | `UNSTARTED` |
| Important I3 — Postgres session count increments on replay | `DATA-003` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Replayed open-session start leaves one row and one count; memory/Postgres row/count parity holds. | `UNSTARTED` |
| Important I4 — deletion tombstones sensitive excerpts indefinitely | `DATA-004` | `2026-08-23-persistence-postgres-privacy.md` | `DECISION_BLOCKED` | Decision `D-05` selects retention/purge semantics; row-level restart-safe tests then cover spans, documents, concepts, questions, and metadata. | `UNSTARTED` |
| Important I5 — durable store event authorization is process-local | `DATA-005` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Restart and two-instance replay tests authorize only matching durable digests and keep memory bounded/deduplicated. | `UNSTARTED` |
| Minor M1 — marker reassembled after character filtering | `DATA-006` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Unicode-split forbidden markers are rejected after normalization/filtering; positive safe controls remain accepted. | `UNSTARTED` |
| Minor M2 — VoiceEvidenceEvent constructor bypass | `DATA-007` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Deserialization and all public construction paths enforce per-kind sanitization; hostile round-trip tests pass. | `UNSTARTED` |
| Minor M3 — expired nonce rows never pruned | `DATA-008` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Clocked cleanup test removes expired nonces, retains live replay protection, and bounds memory/Postgres growth. | `UNSTARTED` |
| Minor M4 — superseded recap payload index retained | `DATA-009` | `2026-08-23-persistence-postgres-privacy.md` | `BATCH_FIX` | Forward/replay migration drops only the obsolete index; large valid recap insert succeeds. | `UNSTARTED` |
| Minor M5 — usage insert races session deletion | `DATA-010` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Concurrent delete/usage test proves no post-delete usage row and transaction/FK behavior is deterministic. | `UNSTARTED` |
| Minor M6 — backend study-context shape and recency ordering diverge | `DATA-011` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Typed context conformance fixture and identical created-time ordering pass on memory and Postgres. | `UNSTARTED` |
| Minor M7 — memory session start can reopen closed session | `DATA-012` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Concurrent close/start test proves one-lock state transition and parity with Postgres. | `UNSTARTED` |
| Minor M8 — never-written answer_attempts columns | `DATA-013` | `2026-08-23-persistence-postgres-privacy.md` | `BATCH_FIX` | Remove the unwritten columns by migration unless an approved typed writer already exists; forward/replay/schema-contract tests prove no implied dead persistence surface. | `UNSTARTED` |

### Web API + library proxy: 8 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — create responses relay raw session tokens | `WEBAPI-008` | `2026-08-23-web-api-security.md` | `TESTED_FIX` | Successful paste/file/retry JSON fixtures containing nested tokens reach the browser token-free while server-only bootstrap still works. | `UNSTARTED` |
| Important I2 — request/response bodies buffer without caps | `WEBAPI-007` | `2026-08-23-web-api-security.md` | `TESTED_FIX` | Boundary tests reject encoded, decoded, upstream, decompressed/parser overages with sanitized 413-class outcomes and bounded allocation. | `UNSTARTED` |
| Minor M1 — mint rate-limit buckets never evicted | `WEBAPI-005` | `2026-08-23-web-api-security.md` | `TESTED_FIX` | 100k-key clocked test proves TTL/size bound and correct shared atomic rate behavior. | `UNSTARTED` |
| Minor M2 — off-platform IP key spoofable | `WEBAPI-004` | `2026-08-23-web-api-security.md` | `TESTED_FIX` | Trusted-platform/proxy and direct-mode tests prove caller headers cannot mint fresh IP buckets. | `UNSTARTED` |
| Minor M3 — SSR capabilities omit origin binding | `WEBAPI-003` | `2026-08-23-web-api-security.md` | `TESTED_FIX` | SSR/proxy token fixtures require the same canonical origin and reject cross-origin/destructive replay. | `UNSTARTED` |
| Minor M4 — unreachable snapshot-error branch | `WEBAPI-014` | `2026-08-23-web-api-security.md` | `BATCH_FIX` | One error path remains; all upstream error classes retain sanitized response/terminal mapping. | `UNSTARTED` |
| Minor M5 — ignored duplicate snapshotFilter return | `WEBAPI-014` | `2026-08-23-web-api-security.md` | `BATCH_FIX` | Filter is computed once and adversarial cross-user/allowlist tests remain green. | `UNSTARTED` |
| Minor M6 — mint/verify origin derivation differs | `WEBAPI-003` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical `WEBAPI-003` proof includes forwarded host/proto and `nextUrl` mismatch cases using one helper. | `UNSTARTED` |

### Web live-session client: 10 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — raw parse exception leaks/misclassifies auth | `WEBSESSION-PROTOCOL-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Chromium/Safari/Firefox-style malformed frames produce one fixed diagnostic, no payload fragment, and no false auth recovery action. | `UNSTARTED` |
| Important I2 — no bounded auto-reconnect | `WEBSESSION-RECOVERY-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Fake-clock socket test proves 1–3 jittered retries after lease grace, terminal/recap stop rules, state policy, and manual fallback. | `UNSTARTED` |
| Minor M1 — send boolean loses audio on closed socket | `WEBSESSION-AUDIO-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Discriminated send result preserves one captured turn until confirmed send and distinguishes pending from closed. | `UNSTARTED` |
| Minor M2 — mic/context leak during node construction | `WEBSESSION-CAPTURE-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Throw injection at each post-getUserMedia construction step proves tracks stopped, context closed, listener/module cleanup once. | `UNSTARTED` |
| Minor M3 — close-reason allowlist drifts from server | `WEBSESSION-PROTOCOL-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Close-reason text is never parsed or displayed; user copy derives only from typed `VivaVoiceTermination` codes pinned to `agent/fixtures/voice-protocol/v5/transport-outcomes.json`, so server reason drift cannot produce redaction placeholders (supersedes the earlier displayed-reason proof per Plan 10 Task 4 Step 2 under the Plan 05 typed-termination contract). | `UNSTARTED` |
| Minor M4 — partial recap reason dropped | `WEBSESSION-RECAP-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Missing trailing phase frame still renders degraded recap and correct recovery from stored `partial_reason`. | `UNSTARTED` |
| Minor M5 — structured_error terminality undefined | `WEBSESSION-RECAP-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Protocol v5 encodes terminality explicitly; shared Rust/TS fixture proves transport status remains correct for every structured error. | `UNSTARTED` |
| Minor M6 — playback cancel leaves phantom schedule gap | `WEBSESSION-PLAYBACK-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Interleaved two-response audio test cancels one response without dead air or reordering surviving/new frames. | `UNSTARTED` |
| Minor M7 — fallback resampler aliases high frequencies | `WEBSESSION-CAPTURE-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | 44.1/48 kHz long-signal spectral tests enforce anti-alias attenuation and duration error bounds. | `UNSTARTED` |
| Minor M8 — dead reducer branch and empty queue abstraction | `WEBSESSION-CLEANUP-PROTOCOL-PLAYBACK` | `2026-08-23-web-session-audio.md` | `BATCH_FIX` | Exact Plan 10 IDs `WEBSESSION-PROTOCOL-01` and `WEBSESSION-PLAYBACK-01` characterize the terminal-recap reducer and playback queue respectively, delete only the dead paths, and prove identical public reduction/scheduling behavior before and after. | `UNSTARTED` |

### Web UI: 12 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Critical C1 — normal live audio exceeds 64 KiB frame cap | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `TESTED_FIX` | Production client + real WS tests at 2/10/45 seconds and 44.1/48 kHz prove bounded frames, explicit end-turn, backpressure, cancel, and successful transcript/evaluation/recap. | `PROVEN` |
| Important I1 — challenge citation sent as graded magic text | `WEBSESSION-INTENT-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Typed challenge intent routes to correction and never enters answer evaluation/mastery/schedule; magic-string negative control remains. | `UNSTARTED` |
| Important I2 — route read/URL mutation in render initializer | `WEBSESSION-ROUTE-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | StrictMode SSR/hydration tests with differing route/env identity show zero render side effects, warnings, flicker, or token retention. | `UNSTARTED` |
| Important I3 — destructive study-set/source and session-recap/history actions are one click | `FRONTEND-004` | `2026-08-23-frontend-accessibility-performance.md` | `DECISION_BLOCKED` | Decision `D-04` selects exactly `CONFIRM_DELETE` or `SOFT_DELETE_UNDO`. Exact tasks `DATA-016`, `SERVICE-018`, and `WEBAPI-016` prove the selected study-set permanent-delete absence contract or durable 30-second restore/capability chain. Exact Plan 13 `FRONTEND-004` proof must mount and exercise both action kinds: Branch A confirms study-set/source deletion and session-recap/history deletion independently; Branch B proves study-set undo and still requires a separate confirmation before the non-undoable session-recap/history delete. Every first click and every cancel/Escape path issues zero DELETE requests. | `UNSTARTED` |
| Important I4 — session component/live audio seam unmounted in tests | `WEBSESSION-MOUNT-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Mounted tests cover deferred connect, token refresh, audio submit, barge-in ack, recap teardown, bfcache reconnect, and a pre-fix negative control. | `UNSTARTED` |
| Minor M1 — refreshed token ref diverges from state | `WEBSESSION-AUTH-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Rotation/revocation lifecycle test proves every reconnect refreshes with the newest token. | `UNSTARTED` |
| Minor M2 — entry refresh can hang forever | `WEBSESSION-AUTH-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Never-resolving fetch aborts within configured bound and enters explicit fallback/retry without indefinite connecting. | `UNSTARTED` |
| Minor M3 — error boundary renders raw error | `FRONTEND-012` | `2026-08-23-frontend-accessibility-performance.md` | `TESTED_FIX` | Exact Plan 13 ID `FRONTEND-012` uses a mounted hostile exception to prove generic copy, one validated digest reference, one sanitized two-field report, and no raw exception in DOM, console, or telemetry. | `PROVEN` |
| Minor M4 — due dates forced to UTC calendar | `WEBSESSION-TASK10-LOCAL-DATE-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Plan 10 Task 10 under literal ID `WEBSESSION-TERMINAL-01` must run a timezone matrix around UTC/local day boundaries and prove the displayed calendar date plus interval label preserve the recorded scheduling contract. | `UNSTARTED` |
| Minor M5 — typed answers bypass broad disclosure | `WEBSESSION-DISCLOSURE-01` | `2026-08-23-web-session-audio.md` | `DECISION_BLOCKED` | Decision `D-08` selects disclosure scope; exact Plan 10 ID `WEBSESSION-DISCLOSURE-01` proves typed and microphone behavior, while exact Plan 13 ID `FRONTEND-005` proves copy/gating agreement. | `UNSTARTED` |
| Minor M6 — landing intent discarded | `FRONTEND-003` | `2026-08-23-frontend-accessibility-performance.md` | `DECISION_BLOCKED` | Decision `D-03` selects exact Plan 04 task `LEARN-005A` or `LEARN-005B`; exact Plan 13 ID `FRONTEND-003` then proves route-to-provider behavior or complete affordance removal. | `PROVEN` |
| Minor M7 — label layout recomputed every frame | `WEBSESSION-CANVAS-01` | `2026-08-23-web-session-audio.md` | `TESTED_FIX` | Exact Plan 10 `WEBSESSION-CANVAS-01` instrumented tests recompute labels only on data/size/font changes and consume Plan 13 `FRONTEND-008`'s shared effects/frame budget without overlap or jitter regressions. | `UNSTARTED` |

### Shared TypeScript packages: 11 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — FSRS state reset on every review | `LEARN-D01-03` | `2026-08-23-learning-core-authority.md` | `DECISION_BLOCKED` | Selected exact Plan 04 task `LEARN-003A` or `LEARN-003B` after Decision `D-01`; Decision `D-01` selects scheduling/exam authority; repeated-review clock/conformance tests then prove documented interval behavior. | `PROVEN` |
| Important I2 — 4–8 day exam gap schedules after exam | `LEARN-D01-03` | `2026-08-23-learning-core-authority.md` | `DECISION_BLOCKED` | Selected exact Plan 04 task `LEARN-003A` or `LEARN-003B` after Decision `D-01`; Decision `D-01` selects scheduling/exam authority; exams 1–8 days out then never receive an impermissible post-exam due date. | `PROVEN` |
| Important I3 — learner-loop validator omits closed fields | `LEARN-006` | `2026-08-23-learning-core-authority.md` | `TESTED_FIX` | Mutation tests reject every invalid authority, resolution kind, action intent, false literal, unknown key, and raw-script import. | `PROVEN` |
| Minor M1 — cap explanations claim non-binding causes | `LEARN-D01-03` | `2026-08-23-learning-core-authority.md` | `TESTED_FIX` | Consume recorded Decision `D-01` as a prerequisite, then execute the selected exact Plan 04 task `LEARN-003A` or `LEARN-003B`; its table test emits an explanation only when that candidate actually lowers `dueAt`. | `PROVEN` |
| Minor M2 — uncapped interval conflicts across surfaces | `LEARN-D01-03` | `2026-08-23-learning-core-authority.md` | `TESTED_FIX` | Consume recorded Decision `D-01` as a prerequisite, then execute the selected exact Plan 04 task `LEARN-003A` or `LEARN-003B`; one concept/input fixture must render one due interval in verdict, recap, and schedule surfaces. The in-session-verdict half is Plan 10's: the verdict interval renders only the projection `dueAt` and no `reviewIntervalForStatus` call remains (Plan 04 LEARN-011's Plan 10 row). | `UNSTARTED` |
| Minor M3 — token package is decorative duplicate | `FRONTEND-001` | `2026-08-23-frontend-accessibility-performance.md` | `BATCH_FIX` | Make package tokens the generated/runtime CSS authority with automated drift mutation; remove any remaining decorative duplicate. | `PROVEN` |
| Minor M4 — demo evaluator/fixtures in production root export | `PACKAGE-PAIR-01-02` | `2026-08-23-package-build-contracts.md` | `BATCH_FIX` | Exact Plan 14 IDs `PACKAGE-01` and `PACKAGE-02` both pass: production root exports contain no demo grader/recap/seed and the fixture subpath/import boundary is enforced. | `UNSTARTED` |
| Minor M5 — secondary action reuses intent; shallow freeze | `LEARN-PAIR-006-010` | `2026-08-23-learning-core-authority.md` | `TESTED_FIX` | Exact Plan 04 IDs `LEARN-006` and `LEARN-010` both pass: schema expresses each action intent and exported contracts reject post-validation mutation recursively. | `PROVEN` |
| Minor M6 — redundant durability union/validator member | `LEARN-006A` | `2026-08-23-learning-core-authority.md` | `BATCH_FIX` | Exact Plan 04 ID `LEARN-006A` removes the duplicate union and validator insertion, composes the one authoritative terminal-reason array, and proves exact type/runtime membership; Plan 14 only wires the behavior-free runtime-validation export. | `UNSTARTED` |
| Minor M7 — frame limits unused and tool types misleading | `WEBSESSION-AUTHORITY-01` | `2026-08-23-web-session-audio.md` | `BATCH_FIX` | Plan 05 `VOICE-SIZE-002` and `VOICE-AUTHORITY-001` publish strict limits/types and remove dead tool exports; exact Plan 10 ID `WEBSESSION-AUTHORITY-01` rejects an oversized or forged tool frame before `WebSocket.send` with typed learner-safe diagnostics. | `UNSTARTED` |
| Minor M8 — malformed/unknown event fields pass misleadingly | `VOICE-DIAGNOSTIC-001` | `2026-08-23-voice-wire-auth-contract.md` | `TESTED_FIX` | Per-event strict reconstruction rejects/strips unknown fields and identifies invalid error-message shape precisely without raw payload. | `UNSTARTED` |

### Release-gate scripts: 12 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — shell gates fail open on tool/pipeline errors | `RELEASE-001` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | PATH-injected missing/failing rg and git make both gates fail; no-match exit 1 remains clean. | `UNSTARTED` |
| Important I2 — BAC-528 evidence hardcodes safe false | `RELEASE-002` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | `enabled_for_release` reflects `plan.enabled === true`; enabled/disabled mutation flips evidence and production rejection while the independent release-check throw remains tested. | `UNSTARTED` |
| Important I3 — live smoke unbound to deploy | `RELEASE-003` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Staging/mismatched SHA/run evidence is rejected; exact release deploy/run and freshness pass. | `UNSTARTED` |
| Important I4 — HMAC has no downstream strict verifier | `RELEASE-004` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Separate stored-bundle verifier requires HMAC secret/algorithm/key-present in production and rejects tamper, keyless downgrade, wrong key, and stale exact-head evidence. | `UNSTARTED` |
| Minor M1 — child spawn error bypasses quarantine cleanup | `RELEASE-005` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | ENOENT child failure writes sanitized quarantine record and removes releasable partial artifacts. | `UNSTARTED` |
| Minor M2 — duplicate provider gate clobbers logs | `RELEASE-006` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | Command names are unique, invocation occurs once, and each evidence row resolves to immutable distinct logs. | `UNSTARTED` |
| Minor M3 — missing sanitized flag passes manifest import | `RELEASE-007` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Missing/false/non-boolean sanitized fields fail every imported artifact level. | `UNSTARTED` |
| Minor M4 — production run ID binding optional | `RELEASE-008` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Production without exact run ID fails; non-production latest fallback is deterministic and explicitly non-certifying. | `UNSTARTED` |
| Minor M5 — forbidden-marker implementations drift | `RELEASE-009` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | One shared structural/marker/env-secret scanner is mutation-tested from all producers and consumers. | `UNSTARTED` |
| Minor M6 — release-check tests assert source strings | `RELEASE-010` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Behavioral tests prove disabled/dead-branch redaction and import calls fail, including hostile evidence objects. | `UNSTARTED` |
| Minor M7 — bundle max age hardcoded inconsistently | `RELEASE-011` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Non-default age override is identical in bundle, gate, verifier, and rejection boundary. | `UNSTARTED` |
| Minor M8 — dead docs exclusion in purity gate | `RELEASE-001` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical shell-gate proof includes exact intended roots/globs and rejects accidental scope change. The dead-docs-exclusion behavior itself is implemented by Plan 06 `DOMAIN-001`'s purity redesign; do not mark this alias complete from the `RELEASE-001` handoff alone — require the linked Plan 06 `DOMAIN-001` proof as well. | `UNSTARTED` |

### E2E, smoke, and monitoring scripts: 12 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — consecutive-failure threshold unreachable | `RELEASE-013` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Fresh run-scoped hosted state reaches count two in canonical smoke/manifest schema and activates the BAC-527 rollback query. | `UNSTARTED` |
| Important I2 — runner kills smoke before inner timeout evidence | `RELEASE-014` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | One monotonic deadline feeds remaining stage budgets; runner adds flush grace and stalled stages publish sanitized classified partial evidence. | `UNSTARTED` |
| Important I3 — teardown orphans cargo/Next grandchildren | `RELEASE-015` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Managed process-group test proves wrapper and grandchild exit on normal/error/SIGINT/SIGTERM with bounded SIGKILL escalation and logs closed after exit. | `UNSTARTED` |
| Important I4 — monitor receives unused production secrets | `RELEASE-016` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Mode matrix proves unused provider/HMAC secrets are neither required nor passed; live mode uses run/deploy/identity-bound short-lived capability or explicit non-secret attestation. | `UNSTARTED` |
| Minor M1 — cost-cap failure evidence shape incomplete | `RELEASE-017` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Cost-cap rejection conforms to the same validated failure_class and monitor schema and advances canonical failure state. | `UNSTARTED` |
| Minor M2 — S3 publication has no retry/classification | `RELEASE-018` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Retryable/nonretryable/deadline tests prove bounded jittered retry and `publish_failed`; manifest is written last as commit marker. | `UNSTARTED` |
| Minor M3 — required preview frame is harness HTML | `RELEASE-019` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DECISION_BLOCKED` | Decision `D-09` selects real product state or non-certifying structured preview; release assertion enforces the selected truthful class. | `UNSTARTED` |
| Minor M4 — limiter proof name is unchecked string | `RELEASE-020` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Rename/delete mutation of named Rust test turns evidence test red and executing the proof remains in release commands. | `UNSTARTED` |
| Minor M5 — live token minted too early | `RELEASE-021` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Slow synthetic leg proves live token minted immediately before use with full TTL, single-use nonce, run/deploy/mode/identity binding. | `UNSTARTED` |
| Minor M6 — transport errors counted as structured server errors | `RELEASE-022` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Transport error, malformed frame, and valid server error produce three distinct counters/classifications consumed downstream. | `UNSTARTED` |
| Minor M7 — free-port close/rebind race | `RELEASE-023` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Injected first-bind collision receives one bounded bind-specific retry without masking other startup failures. | `UNSTARTED` |
| Minor M8 — E2E static tests verify strings | `RELEASE-010` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical behavioral/mutation proof covers extracted E2E helpers; source grep remains only for structural bans. | `UNSTARTED` |

### Cross-cutting security: 8 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — both runtime containers run as root | `RELEASE-026` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Built agent/monitor images run as fixed non-root UID, write only declared paths, and pass runtime/read-only-root smoke. | `UNSTARTED` |
| Important I2 — spoofable left-most XFF | `SERVICE-003` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical trusted-peer/proxy proof covers pre-auth admission and runbook configuration. | `UNSTARTED` |
| Minor M1 — workflow lacks explicit permissions | `RELEASE-027` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | Workflow-policy test requires least-privilege contents read and no broader permission absent explicit proof. | `UNSTARTED` |
| Minor M2 — base images use mutable tags/install script | `RELEASE-026` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | Docker FROMs use reviewed digests and Bun artifact/installer is versioned and checksum-verified; build provenance records digests. | `UNSTARTED` |
| Minor M3 — Actions use floating tags | `RELEASE-027` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical workflow policy requires full action SHAs and controlled update automation. | `UNSTARTED` |
| Minor M4 — nonce rows never pruned | `DATA-008` | `2026-08-23-persistence-postgres-privacy.md` | `DUPLICATE_ALIAS` | Canonical expiry cleanup proves security and capacity semantics. | `UNSTARTED` |
| Minor M5 — mint limiter accumulates stale keys | `WEBAPI-005` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical bounded shared-limiter proof covers long-running deployment. | `UNSTARTED` |
| Minor M6 — dotenv variants not ignored | `RELEASE-027` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | Exact Plan 12 ID `RELEASE-027` owns `.gitignore`; its behavioral ignore-policy test covers root/nested `.env`, environment, local, and `.envrc` variants, preserves example templates, and rejects a tracked non-template dotenv file. | `UNSTARTED` |

### Architecture, contracts, and consistency: 11 instances

| Source severity / stable ordinal and heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Important I1 — persisted due dates contradict FSRS claim | `CRIT-SCHED-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Decision `D-01` plus canonical scheduling/docs proof removes the duplicate synthetic table. | `UNSTARTED` |
| Important I2 — advertised purity gate checks residue | `DOMAIN-001` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | Canonical domain-boundary proof includes renamed residue hygiene and corrected README/CONTRIBUTING/PR template. | `UNSTARTED` |
| Important I3 — auth first-frame absent from protocol module | `VOICE-AUTH-001` | `2026-08-23-voice-wire-auth-contract.md` | `TESTED_FIX` | One typed initial frame includes token/generation semantics and a fake signed Rust/TS fixture round-trips without private parallel structs. | `UNSTARTED` |
| Minor M1 — dead ReadyFrame duplicate | `SERVICE-009` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical single-ready-shape proof closes this alias. | `UNSTARTED` |
| Minor M2 — TS/Rust token format lacks shared vector | `VOICE-TOKEN-001` | `2026-08-23-voice-wire-auth-contract.md` | `TESTED_FIX` | Shared fake secret/token vectors cover valid, expired, padded, unknown-field, malformed signature, and cross-runtime mint/verify. | `UNSTARTED` |
| Minor M3 — docs use invalid statuses/missing evidence fields | `INTEGRATION-007` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `TESTED_FIX` | Plan 15's `scripts/public-contract.test.mjs` (Task 7, `INTEGRATION-007`) supplies the failing/executable contract test against exported status/evidence constants; exact Plan 15 `INTEGRATION-007` corrects owner documentation and reruns that test so prose names only shipped statuses and the complete evidence field set. Plan 14 `PACKAGE-08` ships only the prose handoff, not a test. | `UNSTARTED` |
| Minor M4 — Turbo outputs/env hash incomplete | `PACKAGE-04` | `2026-08-23-package-build-contracts.md` | `TESTED_FIX` | Cache differential normal/static builds restore correct `.next`/`out` and differing `VIVA_STATIC_EXPORT` hashes. The differing-flag-hash clause is satisfiable only under D-06 Branch A; under Branch B complete flag deletion satisfies this row (Plan 14 Task 4 Step 3). | `UNSTARTED` |
| Minor M5 — crate metadata says UNLICENSED | `PACKAGE-06` | `2026-08-23-package-build-contracts.md` | `BATCH_FIX` | Cargo metadata reports SPDX `Apache-2.0` for all workspace crates and public license files remain consistent. | `UNSTARTED` |
| Minor M6 — client ignores exported frame limits | `WEBSESSION-AUTHORITY-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Plan 05 `VOICE-SIZE-001` / `VOICE-SIZE-002` publish the exact encoded limits and strict diagnostics; exact Plan 10 `WEBSESSION-AUTHORITY-01` enforces the text-frame bound before `WebSocket.send`, while `CRIT-AUDIO-01` owns bounded audio streaming. | `UNSTARTED` |
| Minor M7 — TS path mapping permits forbidden deep imports | `PACKAGE-03` | `2026-08-23-package-build-contracts.md` | `BATCH_FIX` | Typecheck and runtime exports agree; allowed/forbidden import fixtures resolve identically. | `UNSTARTED` |
| Minor M8 — static export has no consumer/gate/docs | `PACKAGE-05` | `2026-08-23-package-build-contracts.md` | `DECISION_BLOCKED` | Decision `D-06` selects retain-with-named-consumer/BFF or complete removal. Exact `WEBSESSION-STATIC-01`, `WEBAPI-015`, `RELEASE-031`, `FRONTEND-010`, `PACKAGE-05`, and Plan 15 `INTEGRATION-004` / `INTEGRATION-007` must then agree on routing, server API availability, build/cache inputs, served browser proof, and public claims. | `UNSTARTED` |

Component row-count check: `11+11+9+13+8+10+12+11+12+12+8+11=128`. Source severity labels in this section reconcile to the 2/44/82 table above; no synthesis row below changes those totals.

### Finding-instance versus canonical-task reconciliation

| Ledger population | Source rows | Unique canonical IDs | Arithmetic |
| --- | ---: | ---: | --- |
| Component baseline only | 128 | 103 | 128 immutable finding instances collapse through duplicate ownership to 103 canonical IDs |
| Synthesis aliases | 58 | — | `8+10+12+7+10+11=58`; excluded from the 128 baseline |
| Index aliases | 26 | — | `1+18+7=26`; excluded from the 128 baseline |
| Other document-level obligations | 50 | — | `(1+10+6)+7+5+(4+7+1+9)=50` index/summary/project-state/synthesis acceptance and browser/control obligations |
| Component final recommendations | 84 | — | `7+7+7+8+6+6+8+8+7+7+6+7=84` |
| **All source rows** | **346** | **160** | **`128+58+26+50+84=346`; 346 source obligations map to 160 canonical IDs** |

The unique-ID counts are set cardinalities, not work-completion claims. A canonical ID appearing in several populations is counted once in the 160 total. Ledger-local selectors above are explicit unions over exact execution-plan IDs; they neither create unowned work nor permit partial proof to close a combined obligation.

## Synthesis alias ledger: ARC / COR / SEC / REL / QLT / FE

These 58 rows preserve every numbered synthesis alias. They are not additional component finding instances. A synthesis alias may combine several component findings; its proof is the union gate that prevents individually green subfixes from closing the cross-cutting defect.

### Architecture synthesis aliases: ARC-01 through ARC-08

| Source review and severity / heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Architecture `ARC-01` P1 — split scheduling/mastery authority | `LEARN-009` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | One persisted TurnOutcome/recap/schedule writer drives library, session, and browser projections with cross-surface identity tests. | `PROVEN` |
| Architecture `ARC-02` P1 — no single server study-set projection | `LEARN-008` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Authenticated read model owns metadata, concepts, ingestion, question count, mode/goal, and schedule for landing and session. | `PROVEN` |
| Architecture `ARC-03` P1 — fixture behavior shares production paths | `LEARN-010` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Exact Plan 04 `LEARN-010` confines TS fixture helpers and freezes validated contracts; exact Plan 08 `SERVICE-013` proves zero production fixture mutation at startup; exact Plan 03 `CRIT-SCHED-01` removes the fixture-calendar literals; exact Plan 04 `LEARN-009` removes independent live fixture-derived mastery/recap writes. All four proofs are required before this alias closes. | `UNSTARTED` |
| Architecture `ARC-04` P2 — purity control is not purity | `DOMAIN-001` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | See canonical forbidden-dependency/import and fail-closed-tool proof. | `UNSTARTED` |
| Architecture `ARC-05` P2 — oversized modules concentrate risk | `RELEASE-030` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | Exact Plan 12 ID `RELEASE-030` freezes executable baseline/ratchets and extracts E2E responsibilities; exact owner tasks `ADAPTER-11`, `SERVICE-017`, `DATA-015`, and `FRONTEND-001` characterize then extract provider, service, store, and CSS boundaries. Plan 15 `INTEGRATION-008` independently verifies the combined tree and routes regressions back to those owners. | `UNSTARTED` |
| Architecture `ARC-06` P2 — TS/Rust protocol drift risk | `VOICE-DIFFERENTIAL-001` | `2026-08-23-voice-wire-auth-contract.md` | `DUPLICATE_ALIAS` | Schema generation or exhaustive differential/property tests cover every enum, terminal reason, unknown field, generation ID, lifecycle, and size budget. | `UNSTARTED` |
| Architecture `ARC-07` P3 — nominal UI package boundary | `PACKAGE-07` | `2026-08-23-package-build-contracts.md` | `DUPLICATE_ALIAS` | Exact Plan 14 ID `PACKAGE-07` proves the deliberately small UI boundary, consumer-owned React peer, and tested stylesheet ownership. | `UNSTARTED` |
| Architecture `ARC-08` P3 — fixture graders beside live contracts | `PACKAGE-PAIR-01-02` | `2026-08-23-package-build-contracts.md` | `DUPLICATE_ALIAS` | Exact Plan 14 IDs `PACKAGE-01` and `PACKAGE-02` both pass the production-root and fixture-subpath boundary proof. | `UNSTARTED` |

### Correctness synthesis aliases: COR-01 through COR-10

| Source review and severity / heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Correctness `COR-01` P0 — normal microphone answer exceeds frame cap | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | See 2/10/45-second production browser-to-server streaming proof; raising the cap alone cannot satisfy it. | `PROVEN` |
| Correctness `COR-02` P1 — fixed past review dates | `CRIT-SCHED-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Decision `D-01` selects authority; see future-relative scheduler proof. | `PROVEN` |
| Correctness `COR-03` P1 — startup seed resurrects deleted fixture | `SERVICE-013` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Normal production startup performs zero fixture mutation; Postgres restart cannot alter or undelete any existing fixture-known row. | `UNSTARTED` |
| Correctness `COR-04` P1 — lossy UTF-8 is presented as PDF ingestion | `DATA-014` | `2026-08-23-persistence-postgres-privacy.md` | `TESTED_FIX` | Exact Plan 09 ID `DATA-014` rejects real text/compressed/scanned/encrypted/malformed and magic-header PDF fixtures before lossy decoding or persistence; Plan 08 `SERVICE-016` proves sanitized HTTP mapping and unchanged store state; Plan 15 `INTEGRATION-007` makes public claims match the fail-closed behavior. | `UNSTARTED` |
| Correctness `COR-05` P1 — route identity painted onto biology fixture | `LEARN-008` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Server projection controls all displayed identity/readiness/recap concepts; route parameters select only identity. | `PROVEN` |
| Correctness `COR-06` P1 — semantic grading/recap absent | `LEARN-PAIR-001-002` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Exact Plan 04 IDs `LEARN-001` and `LEARN-002` both pass typed evaluation and persisted-evidence recap tests. | `PROVEN` |
| Correctness `COR-07` P1 — successful recap rendered as disconnect | `WEBSESSION-TERMINAL-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Visible-copy E2E proves successful/controlled recap dominates closed transport and no Retry-agent failure action appears. | `UNSTARTED` |
| Correctness `COR-08` P2 — resampler loses fractional phase | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Exact Plan 03 ID `CRIT-AUDIO-01` proves stateful 44.1/48 kHz 45-second phase, boundary-sample, duration, and frequency bounds. | `PROVEN` |
| Correctness `COR-09` P2 — mode/intent collapses to quiz | `LEARN-D03-05` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Selected exact Plan 04 task `LEARN-005A` or `LEARN-005B` after Decision `D-03`; Decision `D-03` selects signed mode/goal behavior or affordance removal; E2E proves it. | `PROVEN` |
| Correctness `COR-10` P2 — active question is not progression | `LEARN-D02-04` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Selected exact Plan 04 task `LEARN-004A` or `LEARN-004B` after Decision `D-02`; Decision `D-02` selects progression semantics; versioned invariants cover advance, retry, adaptation, exhaustion, reconnect, and concurrency. | `PROVEN` |

### Security synthesis aliases: SEC-01 through SEC-12

| Source review and severity / heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Security synthesis `SEC-01` P1 — expired access token refreshes indefinitely | `WEBAPI-D07-11-12` | `2026-08-23-web-api-security.md` | `DECISION_BLOCKED` | Decision `D-07` selects exact Plan 11 task `WEBAPI-011` or `WEBAPI-012`; years-old, reuse, deletion, race, and cross-tenant tests then fail closed. | `UNSTARTED` |
| Security synthesis `SEC-02` P1 — Bun/Cargo audits fail outside gates | `RELEASE-024` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Lockfiles pass policy or time-bounded reachability exceptions; required exact-head CI runs Bun/Cargo audits and SQLx unused drivers are pruned. | `UNSTARTED` |
| Security synthesis `SEC-03` P1 — restart undeletes fixture | `SERVICE-013` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Same restart/no-production-seed proof as COR-03. | `UNSTARTED` |
| Security synthesis `SEC-04` P2 — process-local unswept mint limiter | `WEBAPI-005` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Same shared atomic bounded limiter proof as component API M1. | `UNSTARTED` |
| Security synthesis `SEC-05` P2 — readiness/usage details may be unauthenticated | `SERVICE-010` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Public endpoint exposes minimal liveness only; non-loopback operational provider/store/usage details require operator auth. | `UNSTARTED` |
| Security synthesis `SEC-06` P2 — one REST bearer has broad authority | `WEBAPI-006` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Audience/scope/identity tests separate read, mint, delete, and operator health and reject cross-tenant use. | `UNSTARTED` |
| Security synthesis `SEC-07` P2 — browser hardening headers incomplete | `WEBAPI-015` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Decision `D-06` selects the branch first. Hosted response tests enforce CSP, frame-ancestors, object/base restrictions, HSTS, nosniff, and deliberate microphone permissions policy. | `UNSTARTED` |
| Security synthesis `SEC-08` P2 — weak secrets accepted | `WEBAPI-013` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Configuration rejects short/common/placeholders, supports key IDs/rotation, and never logs secret/prefix. | `UNSTARTED` |
| Security synthesis `SEC-09` P2 — whole-body upload allocation | `WEBAPI-007` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical dual-tier encoded/decoded/parser budget proof. | `UNSTARTED` |
| Security synthesis `SEC-10` P3 — destructive control capabilities replayable | `WEBAPI-009` | `2026-08-23-web-api-security.md` | `TESTED_FIX` | Decision `D-05` selects the branch first. Consume destructive capability nonces atomically; concurrent reuse and cross-scope/identity tests fail closed. | `UNSTARTED` |
| Security synthesis `SEC-11` P3 — floating Actions/no update automation | `RELEASE-027` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Exact-SHA and least-privilege workflow policy plus controlled dependency update proof. | `UNSTARTED` |
| Security synthesis `SEC-12` P3 — Google Fonts metadata disclosure | `FRONTEND-007` | `2026-08-23-frontend-accessibility-performance.md` | `DUPLICATE_ALIAS` | Browser network test shows no third-party font request and subset/self-host cache/weight budget holds. | `PROVEN` |

### Reliability/performance synthesis aliases: REL-01 through REL-07

| Source review and severity / heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Reliability `REL-01` P2 — readiness polling overlaps/hangs | `WEBSESSION-READY-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Never-resolving fetch leaves at most one request, aborts before next poll, aborts on unmount, and surfaces bounded consecutive failure. | `UNSTARTED` |
| Reliability `REL-02` P2 — process-lifetime event vectors | `SERVICE-005` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Same million-event bounded-memory/O(1)-summary proof. | `UNSTARTED` |
| Reliability `REL-03` P2 — limiter state unbounded/unshared | `WEBAPI-005` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Same 100k-key shared atomic limiter proof. | `UNSTARTED` |
| Reliability `REL-04` P2 — callback resampling discontinuity | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Exact Plan 03 ID `CRIT-AUDIO-01` supplies the long-signal stateful phase/boundary proof. | `PROVEN` |
| Reliability `REL-05` P2 — release tooling ambient/runtime-sensitive | `RELEASE-029` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Exact Plan 12 ID `RELEASE-029` proves the hostile inherited-environment check on pinned Node while keeping failure logs sanitized and quarantined. | `UNSTARTED` |
| Reliability `REL-06` P2 — visual effects lack performance budget | `FRONTEND-008` | `2026-08-23-frontend-accessibility-performance.md` | `DUPLICATE_ALIAS` | Low-end mobile 60-second trace enforces frame/long-task/memory budget and validates background pause plus reduced effects/transparency. | `UNSTARTED` |
| Reliability `REL-07` P3 — concentration raises change cost | `RELEASE-030` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | The same `RELEASE-030` executable ratchet plus owner tasks `ADAPTER-11`, `SERVICE-017`, `DATA-015`, and `FRONTEND-001` provide characterization-first extraction proof; Plan 15 `INTEGRATION-008` checks the frozen combined tree. | `UNSTARTED` |

### Quality/test synthesis aliases: QLT-01 through QLT-10

| Source review and severity / heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Quality `QLT-01` P1 — exact main red and unprotected | `INTEGRATION-001` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Exact release head completes all required hosted checks green; protected branch/ruleset requires them for admins with documented break-glass. | `UNSTARTED` |
| Quality `QLT-02` P1 — no real browser microphone E2E | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Same production-shaped 2/10/45-second browser-to-service proof with pre-fix negative control. | `PROVEN` |
| Quality `QLT-03` P1 — Postgres validation manual/skipped | `INTEGRATION-006` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Required PR/main Postgres 16 job proves isolated migrations, restart, deletion, replay, UUID/parity; absent environment reports not proven, never pass. | `UNSTARTED` |
| Quality `QLT-04` P1 — audits outside acceptance | `RELEASE-024` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Same audit remediation/policy/exact-head hosted proof as SEC-02. | `UNSTARTED` |
| Quality `QLT-05` P2 — release child inherits hostile auth env | `RELEASE-029` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Exact Plan 12 ID `RELEASE-029` proves an explicit child allowlist clears auth/database/provider/failure/deploy values unless the target opts in. | `UNSTARTED` |
| Quality `QLT-06` P2 — Node 24 unref deadline cancels tests | `RELEASE-018` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Supported Node runtime is pinned; correctness-critical deadline stays referenced and hosted reproduction passes. | `UNSTARTED` |
| Quality `QLT-07` P2 — loopback inability reported as pass | `RELEASE-027` | `2026-08-23-release-monitor-ci-supply-chain.md` | `TESTED_FIX` | Exact Plan 12 ID `RELEASE-027` makes the required network job fail on PermissionDenied and requires executed replay for exact-head release. | `UNSTARTED` |
| Quality `QLT-08` P2 — gate/docs claims exceed behavior | `INTEGRATION-007` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `BATCH_FIX` | Executable docs-contract tests cover purity, schedule, PDF, and modes; vision is labeled separately from shipped behavior. | `UNSTARTED` |
| Quality `QLT-09` P2 — modules make isolation expensive | `RELEASE-030` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | The same `RELEASE-030` ratchet and `ADAPTER-11` / `SERVICE-017` / `DATA-015` / `FRONTEND-001` owner proofs preserve behavior and store conformance across extracted boundaries; Plan 15 `INTEGRATION-008` independently reviews them. | `UNSTARTED` |
| Quality `QLT-10` P3 — no mutation/differential threshold | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `TESTED_FIX` | Exact Plan 15 ID `INTEGRATION-004` enforces targeted mutation/property gates over token verification, frame sizing, replay, scheduling authority, redaction, and a negative control for every release claim. | `UNSTARTED` |

### Frontend/UX synthesis aliases: FE-01 through FE-11

| Source review and severity / heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Frontend `FE-01` P1 — wrong study identity/mastery | `LEARN-008` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Server projection loading/error states replace fixture fallback and recap is rendered unchanged. | `PROVEN` |
| Frontend `FE-02` P1 — one-second answer ceiling | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Streaming UI exposes capture/backpressure/end/submitted/recoverable failure without generic frame-close collapse. | `PROVEN` |
| Frontend `FE-03` P1 — completed and disconnected conflict | `WEBSESSION-TERMINAL-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Same exact visible-copy completion E2E as COR-07. | `UNSTARTED` |
| Frontend `FE-04` P2 — session missing main/skip target | `FRONTEND-002` | `2026-08-23-frontend-accessibility-performance.md` | `TESTED_FIX` | Accessibility tree has one main and keyboard skip link lands on active question/answer region. | `UNSTARTED` |
| Frontend `FE-05` P2 — product 44 px target contract missed | `FRONTEND-002` | `2026-08-23-frontend-accessibility-performance.md` | `BATCH_FIX` | Geometry tests at mobile/touch widths show all actionable controls at least 44 px while focus/visual hierarchy remains intact. | `UNSTARTED` |
| Frontend `FE-06` P2 — ochre text contrast about 2.85:1 | `FRONTEND-002` | `2026-08-23-frontend-accessibility-performance.md` | `TESTED_FIX` | Automated semantic-token contrast test enforces 4.5:1 for meaningful normal text; decorative use stays explicitly non-text. | `PROVEN` |
| Frontend `FE-07` P2 — command/modes discard intent | `LEARN-D03-05` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Selected exact Plan 04 task `LEARN-005A` or `LEARN-005B` after Decision `D-03`; Decision `D-03` selects signed behavior or affordance removal; exact E2E proves it. | `PROVEN` |
| Frontend `FE-08` P2 — transcript disclosure AT semantics unknown | `FRONTEND-006` | `2026-08-23-frontend-accessibility-performance.md` | `EXTERNAL_EVIDENCE` | VoiceOver/Safari and NVDA/Chrome keyboard/screen-reader evidence verifies name, expanded state, focus, and content; fallback button contract if inconsistent. | `UNSTARTED` |
| Frontend `FE-09` P2 — global CSS/token duplication | `FRONTEND-001` | `2026-08-23-frontend-accessibility-performance.md` | `BATCH_FIX` | Surface split and semantic token consolidation retain visual screenshots/contrast while dead-style and raw-color checks improve. | `PROVEN` |
| Frontend `FE-10` P3 — acknowledgment tab/session-local/input-asymmetric | `FRONTEND-005` | `2026-08-23-frontend-accessibility-performance.md` | `DECISION_BLOCKED` | Decision `D-08` selects disclosure scope/persistence; refresh and input-mode tests then prove it. | `UNSTARTED` |
| Frontend `FE-11` P3 — external fonts/large fallback weight | `FRONTEND-007` | `2026-08-23-frontend-accessibility-performance.md` | `DUPLICATE_ALIAS` | Self-host/subset network proof plus WebP/PNG fallback and transfer-cache budget. | `PROVEN` |

Synthesis alias count check: `8 ARC + 10 COR + 12 SEC + 7 REL + 10 QLT + 11 FE = 58` aliases. These 58 map to canonical work but do not inflate the 128 component-instance baseline.

## Index cross-codebase alias ledger

The index uses a second alias vocabulary for release prioritization. All 26 entries are retained here, including `CORE`, `ADP`, `SVC`, `MON`, `GATE`, and `API` aliases absent from the six synthesis namespaces.

| Source review and priority / heading | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Index `COR-01` P0 — one-second audio limit | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Canonical production browser-to-server streaming proof. | `PROVEN` |
| Index `QLT-01` P1 — red/unprotected main | `INTEGRATION-001` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Canonical exact-head protected hosted-check proof. | `UNSTARTED` |
| Index `COR-02` P1 — fixed due dates | `CRIT-SCHED-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Decision `D-01` plus canonical future-relative schedule proof. | `PROVEN` |
| Index `COR-03` P1 — startup resurrection | `SERVICE-013` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical no-production-seed restart proof. | `UNSTARTED` |
| Index `COR-04` P1 — fake PDF parsing | `DATA-014` | `2026-08-23-persistence-postgres-privacy.md` | `DUPLICATE_ALIAS` | Exact Plan 09 `DATA-014` and Plan 08 `SERVICE-016` close the same real-PDF fail-closed store/HTTP behavior; Plan 15 `INTEGRATION-007` corrects the public contract. | `UNSTARTED` |
| Index `COR-05` P1 — session fixture overlay | `LEARN-008` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Canonical server projection proof. | `PROVEN` |
| Index `COR-06` P1 — substring grading/fabricated recap | `LEARN-PAIR-001-002` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Exact Plan 04 IDs `LEARN-001` and `LEARN-002` both pass typed evaluation and outcome-derived recap proof. | `PROVEN` |
| Index `COR-07` P1 — recap appears disconnected | `WEBSESSION-TERMINAL-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical visible-copy E2E. | `UNSTARTED` |
| Index `CORE-01` P1 — FSRS resets card state | `LEARN-D01-03` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Selected exact Plan 04 task `LEARN-003A` or `LEARN-003B` after Decision `D-01`; Decision `D-01` plus canonical scheduler-memory proof. | `PROVEN` |
| Index `ADP-01` P1 — live fixture mastery/fallback | `ADAPTER-01` | `2026-08-23-live-provider-adapters.md` | `DUPLICATE_ALIAS` | `ADAPTER-01` passes both live cases; proof contains neither fabricated mastery nor the biology fallback. | `UNSTARTED` |
| Index `SVC-01` P1 — zombie lease | `SERVICE-001` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical heartbeat/idle/reconnect proof. | `UNSTARTED` |
| Index `SVC-02` P1 — outbound write wedge | `SERVICE-002` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical slow-reader/drain proof. | `UNSTARTED` |
| Index `SVC-03` P1 — spoofable IP and pre-auth slots | `SERVICE-PAIR-003-004` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | `SERVICE-003` and `SERVICE-004` admission tests both pass. | `UNSTARTED` |
| Index `SEC-01` P1 — unbounded access-token refresh | `WEBAPI-D07-11-12` | `2026-08-23-web-api-security.md` | `DECISION_BLOCKED` | Decision `D-07` selects exact Plan 11 task `WEBAPI-011` or `WEBAPI-012`; canonical refresh proof then passes. | `UNSTARTED` |
| Index `SEC-02` P1 — dependency audits fail | `RELEASE-024` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical policy and exact-head audit proof. | `UNSTARTED` |
| Index `QLT-02` P1 — E2E misses real mic path | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Canonical production-shaped browser audio proof. | `PROVEN` |
| Index `QLT-03` P1 — durable job manual/conflicting | `INTEGRATION-006` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Canonical required isolated Postgres proof. | `UNSTARTED` |
| Index `MON-01` P1 — hosted failure count not propagated | `RELEASE-013` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical count-two rollback proof. | `UNSTARTED` |
| Index `GATE-01` P1 — deploy/HMAC/harness evidence gaps | `RELEASE-MULTIPLAN-GATE-01` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | `RELEASE-002`, `RELEASE-003`, and `RELEASE-004` all pass independently and together on stored evidence. | `UNSTARTED` |
| Index `COR-08` P2 — resampler phase reset | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Exact Plan 03 ID `CRIT-AUDIO-01` supplies canonical long-signal stateful resampler proof. | `PROVEN` |
| Index `REL-01` P2 — polling accumulates | `WEBSESSION-READY-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical aborting self-scheduled poll proof. | `UNSTARTED` |
| Index `REL-02` P2 — recorder vectors unbounded | `SERVICE-005` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical bounded-memory recorder proof. | `UNSTARTED` |
| Index `SEC-03` P2 — mint limiter process-local/unbounded | `WEBAPI-005` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical shared bounded limiter proof. | `UNSTARTED` |
| Index `API-01` P2 — proxy buffers and token stripping incomplete | `WEBAPI-PAIR-007-008` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | `WEBAPI-008` and `WEBAPI-007` both pass. | `UNSTARTED` |
| Index `SEC-04` P2 — root containers/mutable pins | `RELEASE-026` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | `RELEASE-026` built-image policy and runtime proofs pass. | `UNSTARTED` |
| Index `FE-01` P2 — landmarks/targets/contrast | `FRONTEND-002` | `2026-08-23-frontend-accessibility-performance.md` | `DUPLICATE_ALIAS` | `FRONTEND-002` landmark, touch-target, contrast, and zoom proofs all pass. | `UNSTARTED` |

Index cross-alias count check: 1 P0 + 18 P1 + 7 P2 = 26.

## Acceptance-obligation and reviewer-recommendation ledger

Every per-finding `Fix`, `Remediation`, or `Recommendation` paragraph is incorporated into the corresponding component or synthesis row above. This section records the remaining document-level acceptance gates, ordered repair recommendations, final recommendation-list entries, positive controls that must be preserved, and explicitly unverified environments. Stable ordinals are local to the named source document.

### Index, comprehensive summary, and project state

| Source review and stable obligation / recommendation | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Index A1 — release remains blocked until named gates close | `INTEGRATION-001` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Exact-head green protected CI, real browser audio, audit policy, restart-safe deletion, exact-deploy stored-bundle verification. | `UNSTARTED` |
| Index R1 — bounded audio stream and 2/10/45-second tests | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Canonical streaming/E2E proof. | `PROVEN` |
| Index R2 — stop production seed; one clock/scheduler | `CRIT-SERVICE-SEED-SCHEDULE-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Decision `D-01`, `CRIT-SCHED-01`, and `SERVICE-013` proof. | `UNSTARTED` |
| Index R3 — real PDF extraction or fail closed | `DATA-014` | `2026-08-23-persistence-postgres-privacy.md` | `DUPLICATE_ALIAS` | Exact Plan 09 `DATA-014` proves fail-closed rejection with real generated PDF fixtures, Plan 08 `SERVICE-016` proves sanitized HTTP behavior, and Plan 15 `INTEGRATION-007` records that truthful disposition. | `UNSTARTED` |
| Index R4 — server projection; no fixture/client recap rewrite | `LEARN-008` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Canonical projection/outcome proof. | `PROVEN` |
| Index R5 — preflight, trusted IP, heartbeat, write deadline | `SERVICE-UNION-001-004` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | `SERVICE-001` through `SERVICE-004` all pass in one real-socket suite. | `UNSTARTED` |
| Index R6 — Node deadline, failure propagation, deploy/integrity | `RELEASE-MULTIPLAN-DEADLINE-DEPLOY-INTEGRITY-01` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | `RELEASE-018`, `RELEASE-013`, `RELEASE-003`, and `RELEASE-004` all pass. | `UNSTARTED` |
| Index R7 — isolated continuous Postgres restart/deletion/replay | `INTEGRATION-006` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Canonical required Postgres proof. | `UNSTARTED` |
| Index R8 — dependency upgrades and audit gates | `RELEASE-024` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical audit policy proof. | `UNSTARTED` |
| Index R9 — bounded rotating refresh credential | `WEBAPI-D07-11-12` | `2026-08-23-web-api-security.md` | `DECISION_BLOCKED` | Decision `D-07` selects exact Plan 11 task `WEBAPI-011` or `WEBAPI-012`; canonical refresh proof then passes. | `UNSTARTED` |
| Index R10 — protect main after exact-head hosted green | `INTEGRATION-001` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Canonical branch/ruleset proof. | `UNSTARTED` |
| Index P1 — preserve fail-closed public bind configuration | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `TESTED_FIX` | Mutation tests still reject public bind without auth/origin after all refactors. | `UNSTARTED` |
| Index P2 — preserve identity/nonce admission binding | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `TESTED_FIX` | Cross-tenant, replay, expiry, nonce race, and first-frame mutations remain rejected. | `UNSTARTED` |
| Index P3 — preserve rejection of browser source/tool authority | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `TESTED_FIX` | Forged source/tool frames remain rejected across new protocol lifecycle. | `UNSTARTED` |
| Index P4 — preserve live-provider/ZDR gates | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `TESTED_FIX` | Every missing/placeholder runtime/key/ZDR combination remains unselectable. | `UNSTARTED` |
| Index P5 — preserve learner/operator separation and sanitized evidence | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `TESTED_FIX` | Forbidden marker/field/content mutations fail learner copy, diagnostics, logs, and artifacts. | `UNSTARTED` |
| Index P6 — preserve bounded/paused/reduced-motion canvas behavior | `FRONTEND-008` | `2026-08-23-frontend-accessibility-performance.md` | `DUPLICATE_ALIAS` | DPR/FPS/visibility/reduced-motion invariants remain under performance refactor. | `UNSTARTED` |
| Summary R1 — stream bounded audio with identity/backpressure/cancel/end | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Canonical streaming proof. | `PROVEN` |
| Summary R2 — real scheduler in live path | `CRIT-SCHED-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Decision `D-01` plus canonical schedule proof. | `PROVEN` |
| Summary R3 — multi-turn QuestionStarted or explicit single-turn | `ADAPTER-02` | `2026-08-23-live-provider-adapters.md` | `DUPLICATE_ALIAS` | Canonical typed per-response lifecycle and second-turn proof. | `UNSTARTED` |
| Summary R4 — shell gates fail closed and purity becomes truthful | `DOMAIN-RELEASE-PURITY-SHELL-01` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | `DOMAIN-001` plus `RELEASE-001`. | `UNSTARTED` |
| Summary R5 — heartbeat/write deadline/idle/reconnect | `SERVICE-WEBSESSION-RUNTIME-RECOVERY-01` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | `SERVICE-001`, `SERVICE-002`, and `WEBSESSION-RECOVERY-01`. | `UNSTARTED` |
| Summary R6 — XFF/token stripping/body caps/non-root batch | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `BATCH_FIX` | `SERVICE-003`, `WEBAPI-008`, `WEBAPI-007`, and `RELEASE-026` all pass. | `UNSTARTED` |
| Summary R7 — purge learner excerpts or truthful retention | `DATA-004` | `2026-08-23-persistence-postgres-privacy.md` | `DECISION_BLOCKED` | Decision `D-05` plus canonical retention/purge proof. | `UNSTARTED` |
| Project U1 — real Cartesia/Gemini behavior unverified | `INTEGRATION-009` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Cost-bounded ZDR live run on exact deploy produces sanitized STT/evaluation/TTS/persistence/recap proof. | `UNSTARTED` |
| Project U2 — current Railway deployment/traffic/log/cron unverified | `INTEGRATION-009` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Exact deployment inventory, health, monitor cadence, recent sanitized logs, and rollback state are captured and bound. | `UNSTARTED` |
| Project U3 — Postgres migration/replay/privacy unverified live | `INTEGRATION-006` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Required durable job and environment-bound restart/deletion/replay proof. | `UNSTARTED` |
| Project U4 — non-Chromium microphone behavior unverified | `INTEGRATION-009` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Safari/Firefox/Chromium device matrix covers permission, 44.1/48 kHz, capture cleanup, streaming, reconnect. | `UNSTARTED` |
| Project U5 — VoiceOver/NVDA/JAWS behavior unverified | `FRONTEND-009` | `2026-08-23-frontend-accessibility-performance.md` | `EXTERNAL_EVIDENCE` | Exact Plan 13 ID `FRONTEND-009` supplies the mounted screen-reader matrix for landmarks, live regions, transcript, focus, controls, recap, and recovery. | `UNSTARTED` |

Index positive-findings mapping: source bullets 1–4 are `P1`–`P4`; bullets 5 and 6 are jointly `P5` (the redaction structure/artifact controls are part of P5's forbidden-marker proof); bullet 7 is `P6`; bullet 8 (the parchment visual direction) is a design observation with no preservable control and is deliberately excluded from the obligation count.

### Synthesis document acceptance obligations

| Source review and stable obligation / recommendation | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Architecture A1 — target authority model from parse to schedule | `LEARN-009` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | One persisted evidence/outcome/read-model flow makes route/fixture/browser invention impossible. | `PROVEN` |
| Correctness A1 — primary loop browser acceptance gate | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | One real multi-second browser capture reaches production controller/server, transcript/evaluation/persistence/accurate recap, same set/schedule identity. | `UNSTARTED` |
| Security A1 — derived educational data obeys deletion/retention | `DATA-004` | `2026-08-23-persistence-postgres-privacy.md` | `DECISION_BLOCKED` | Decision `D-05` selects policy covering mastery, recap, review, usage, source-derived fields, and restart. | `UNSTARTED` |
| Reliability A1 — hosted SIGTERM during each live stage | `RELEASE-015` | `2026-08-23-release-monitor-ci-supply-chain.md` | `EXTERNAL_EVIDENCE` | Hosted termination during STT/evaluation/TTS/persistence/recap cancels tasks and exits before SIGKILL. | `UNSTARTED` |
| Reliability T1 — never-resolving readiness fetch | `WEBSESSION-READY-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical bounded poll proof. | `UNSTARTED` |
| Reliability T2 — 100k unique limiter keys | `WEBAPI-005` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical limiter proof. | `UNSTARTED` |
| Reliability T3 — million evidence/usage events | `SERVICE-005` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical bounded recorder proof. | `UNSTARTED` |
| Reliability T4 — 45-second 44.1/48 kHz signals | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Exact Plan 03 ID `CRIT-AUDIO-01` supplies canonical stateful resampler proof. | `PROVEN` |
| Reliability T5 — SIGTERM at five pipeline stages | `RELEASE-015` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Same hosted termination proof. | `UNSTARTED` |
| Reliability T6 — low-end two-canvas 60-second trace | `FRONTEND-008` | `2026-08-23-frontend-accessibility-performance.md` | `DUPLICATE_ALIAS` | Canonical visual performance proof. | `UNSTARTED` |
| Reliability T7 — hostile-env release check on pinned Node | `RELEASE-029` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Exact Plan 12 ID `RELEASE-029` supplies canonical hermetic release proof. | `UNSTARTED` |
| Quality A1 — evidence hierarchy must remain ordered | `INTEGRATION-001` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `BATCH_FIX` | Release claims require hosted exact SHA, production-shaped browser, durable Postgres, live provider, then local/unit evidence; lower tiers cannot substitute. | `UNSTARTED` |
| Frontend C1 — run real agent/web/browser check | `INTEGRATION-004` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `TESTED_FIX` | Documented commands start exact real stack and produce sanitized browser proof with zero console/page errors. | `UNSTARTED` |
| Frontend C2 — automated 375×667 story | `FRONTEND-009` | `2026-08-23-frontend-accessibility-performance.md` | `TESTED_FIX` | Screenshot/geometry/a11y assertions pass at 375×667. | `UNSTARTED` |
| Frontend C3 — automated 320 px story | `FRONTEND-009` | `2026-08-23-frontend-accessibility-performance.md` | `DUPLICATE_ALIAS` | Same responsive story matrix includes 320 px without overflow/clipping. | `UNSTARTED` |
| Frontend C4 — keyboard-only traversal | `FRONTEND-009` | `2026-08-23-frontend-accessibility-performance.md` | `TESTED_FIX` | Ordered visible focus reaches every action/dialog/disclosure and returns predictably. | `UNSTARTED` |
| Frontend C5 — forced-colors story | `FRONTEND-009` | `2026-08-23-frontend-accessibility-performance.md` | `TESTED_FIX` | Forced-colors screenshot/DOM checks retain visible focus, controls, and meaningful states. | `UNSTARTED` |
| Frontend C6 — reduced-motion story | `FRONTEND-008` | `2026-08-23-frontend-accessibility-performance.md` | `DUPLICATE_ALIAS` | Static-frame/no-loop assertions hold across canvases/transitions. | `UNSTARTED` |
| Frontend C7 — text zoom 200% | `FRONTEND-002` | `2026-08-23-frontend-accessibility-performance.md` | `TESTED_FIX` | 200% zoom reflows without loss/overlap and all actions remain reachable. | `UNSTARTED` |
| Frontend C8 — 44.1 kHz fake microphone | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Exact Plan 03 ID `CRIT-AUDIO-01` supplies canonical fake-device long-audio proof. | `UNSTARTED` |
| Frontend C9 — visible successful terminal copy | `WEBSESSION-TERMINAL-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Exact success copy contains no disconnect/retry contradiction. | `UNSTARTED` |

### Component-review final recommendations: Rust crates and persistence

| Source review and stable recommendation | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Agent-domain R1 — inject clock/share policy/remove both date tables | `CRIT-SCHED-01` | `2026-08-23-expedited-critical-path.md` | `DECISION_BLOCKED` | Decision `D-01` plus cross-language future-relative scheduling conformance. | `PROVEN` |
| Agent-domain R2 — real purity gate or truthful docs | `DOMAIN-001` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | Canonical fail-closed boundary and docs proof. | `UNSTARTED` |
| Agent-domain R3 — recap from recorded session evidence | `LEARN-001` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Canonical persisted-outcome recap proof. | `PROVEN` |
| Agent-domain R4 — direct boundary/validation/sanitizer/schedule tests | `DOMAIN-002` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | Canonical direct negative-control suite. | `UNSTARTED` |
| Agent-domain R5 — deliberate grading thresholds/full rubric | `LEARN-002` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Canonical typed semantic evaluation tests. | `PROVEN` |
| Agent-domain R6 — typed phase transitions | `DOMAIN-003` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | Canonical transition proof. | `UNSTARTED` |
| Agent-domain R7 — fail-closed store defaults/drop visibility | `DOMAIN-006` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | Canonical store conformance mutation proof. | `PROVEN` |
| Agent-adapters R1 — remove all fixture-era live scaffolding | `ADAPTER-UNION-001-006-007` | `2026-08-23-live-provider-adapters.md` | `BATCH_FIX` | `ADAPTER-01`, `ADAPTER-06`, and `ADAPTER-07` all pass in one live-path suite covering both fabricated-mastery and biology-fallback cases. | `UNSTARTED` |
| Agent-adapters R2 — typed multi-turn start lifecycle | `ADAPTER-02` | `2026-08-23-live-provider-adapters.md` | `DUPLICATE_ALIAS` | Canonical second-turn proof. | `UNSTARTED` |
| Agent-adapters R3 — persistent client and incremental streams | `ADAPTER-PAIR-04-05` | `2026-08-23-live-provider-adapters.md` | `DUPLICATE_ALIAS` | Exact Plan 07 IDs `ADAPTER-04` and `ADAPTER-05` both pass reuse and first-audio proof. | `UNSTARTED` |
| Agent-adapters R4 — provider protocol cancel/close | `ADAPTER-03` | `2026-08-23-live-provider-adapters.md` | `DUPLICATE_ALIAS` | Canonical cooperative cancel/timeout proof. | `UNSTARTED` |
| Agent-adapters R5 — live error-emission store-failure test | `ADAPTER-06` | `2026-08-23-live-provider-adapters.md` | `DUPLICATE_ALIAS` | Canonical durability-degraded classification proof. | `UNSTARTED` |
| Agent-adapters R6 — dependency linter and intentional tracing | `ADAPTER-08` | `2026-08-23-live-provider-adapters.md` | `DUPLICATE_ALIAS` | Canonical unused-dependency proof. | `UNSTARTED` |
| Agent-adapters R7 — surface bounded Cartesia error detail | `ADAPTER-06` | `2026-08-23-live-provider-adapters.md` | `TESTED_FIX` | Coarse allowlisted Ink/Sonic error codes enter metadata without body/content leakage and remain taxonomy-queryable. | `UNSTARTED` |
| Agent-service R1 — heartbeat plus outbound deadline | `SERVICE-PAIR-001-002` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | `SERVICE-001` and `SERVICE-002` real-socket proofs both pass. | `UNSTARTED` |
| Agent-service R2 — authenticate token-only preflight before Ready | `SERVICE-004` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical pre-slot/pre-capability authentication proof. | `UNSTARTED` |
| Agent-service R3 — bound evidence/usage recorders | `SERVICE-005` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical million-event proof. | `UNSTARTED` |
| Agent-service R4 — peer IP plus explicit trusted proxy | `SERVICE-003` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical direct/proxy chain proof and runbook update; the `docs/deployment-runbook.md` edit lands via Plan 12's linked commit (Plan 08 supplies the exact guidance), and this row closes only with that Plan 12 commit reference. | `UNSTARTED` |
| Agent-service R5 — align paste/file ignored-field contract | `WEBSESSION-PASTE-01` | `2026-08-23-web-session-audio.md` | `BATCH_FIX` | Exact Plan 10 ID `WEBSESSION-PASTE-01` reconstructs paste bodies from only `title`, `course`, optional `exam_date`, and `pasted_text`; exact Plan 11 `WEBAPI-007` validates and field-by-field reconstructs the paste/file/retry forwarding keys; exact Plan 08 `SERVICE-015` uses `deny_unknown_fields` and proves forged identity/unknown members fail before a store call. | `UNSTARTED` |
| Agent-service R6 — between-turn idle below session cap | `SERVICE-001` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical idle/lease release proof. | `UNSTARTED` |
| Agent-service R7 — replace brittle message classifiers with typed failures | `DOMAIN-009` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | Exact Plan 06 ID `DOMAIN-009` plus its Plan 07/08 handoff proves typed failure coverage and string-fallback mutations cannot misclassify live failures. | `UNSTARTED` |
| Data/observe R1 — isolate and continuously run durable proof | `DATA-001` | `2026-08-23-persistence-postgres-privacy.md` | `DUPLICATE_ALIAS` | Canonical isolated Postgres job proof. | `UNSTARTED` |
| Data/observe R2 — atomic compat evaluation replay guard | `DATA-002` | `2026-08-23-persistence-postgres-privacy.md` | `DUPLICATE_ALIAS` | Canonical concurrent replay proof. | `UNSTARTED` |
| Data/observe R3 — count only true session inserts | `DATA-003` | `2026-08-23-persistence-postgres-privacy.md` | `DUPLICATE_ALIAS` | Canonical row/count parity proof. | `UNSTARTED` |
| Data/observe R4 — decide and enforce hard purge semantics | `DATA-004` | `2026-08-23-persistence-postgres-privacy.md` | `DECISION_BLOCKED` | Decision `D-05` plus canonical row-level retention proof. | `UNSTARTED` |
| Data/observe R5 — durable event authorization digests | `DATA-005` | `2026-08-23-persistence-postgres-privacy.md` | `DUPLICATE_ALIAS` | Canonical restart/two-instance proof. | `UNSTARTED` |
| Data/observe R6 — expired nonce sweep | `DATA-008` | `2026-08-23-persistence-postgres-privacy.md` | `DUPLICATE_ALIAS` | Canonical clocked cleanup proof. | `UNSTARTED` |
| Data/observe R7 — cleanup migration for obsolete index/dead columns | `DATA-PAIR-009-013` | `2026-08-23-persistence-postgres-privacy.md` | `BATCH_FIX` | `DATA-009` passes and unwritten columns are removed unless an approved typed writer exists. | `UNSTARTED` |
| Data/observe R8 — harden evidence sanitization construction | `DATA-PAIR-006-007` | `2026-08-23-persistence-postgres-privacy.md` | `BATCH_FIX` | `DATA-006` and `DATA-007` hostile round-trip tests pass. | `UNSTARTED` |

### Component-review final recommendations: Web surfaces and shared packages

| Source review and stable recommendation | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Web API R1 — strip credentials from every proxied JSON path | `WEBAPI-008` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical create/snapshot hostile-response proof. | `UNSTARTED` |
| Web API R2 — cap request and upstream response bytes | `WEBAPI-007` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical exact-boundary/overage proof. | `UNSTARTED` |
| Web API R3 — sweep/bound limiter map | `WEBAPI-005` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical 100k-key proof. | `UNSTARTED` |
| Web API R4 — mandatory uniform origin binding | `WEBAPI-003` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical SSR/proxy origin proof. | `UNSTARTED` |
| Web API R5 — remove dead error/filter duplication | `WEBAPI-014` | `2026-08-23-web-api-security.md` | `BATCH_FIX` | `WEBAPI-014` characterization tests cover both dead-error and duplicate-filter removals. | `UNSTARTED` |
| Web API R6 — enforce documented trusted proxy IP model | `WEBAPI-004` | `2026-08-23-web-api-security.md` | `DUPLICATE_ALIAS` | Canonical direct/platform/proxy proof. | `UNSTARTED` |
| Web session R1 — sanitize every error ingress | `WEBSESSION-PROTOCOL-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical multi-engine malformed-frame proof. | `UNSTARTED` |
| Web session R2 — structured auth causes, not regex | `WEBSESSION-PROTOCOL-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Auth recovery derives only from typed causes/allowlisted reason fixture. | `UNSTARTED` |
| Web session R3 — bounded reconnect preserving one turn | `WEBSESSION-PAIR-RECOVERY-AUDIO` | `2026-08-23-web-session-audio.md` | `BATCH_FIX` | `WEBSESSION-RECOVERY-01` and `WEBSESSION-AUDIO-01` reconnect/payload proof. | `UNSTARTED` |
| Web session R4 — shared fixtures for close/partial/error semantics | `WEBSESSION-PAIR-PROTOCOL-RECAP` | `2026-08-23-web-session-audio.md` | `BATCH_FIX` | `WEBSESSION-PROTOCOL-01` and `WEBSESSION-RECAP-01` Rust/TS fixtures cover close, partial-recap, and structured-error semantics. | `UNSTARTED` |
| Web session R5 — capture cleanup after getUserMedia | `WEBSESSION-CAPTURE-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical injected-throw cleanup proof. | `UNSTARTED` |
| Web session R6 — interleaved playback cancel integration | `WEBSESSION-PLAYBACK-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical no-dead-air proof. | `UNSTARTED` |
| Web UI R1 — bounded audio under shared protocol cap | `CRIT-AUDIO-01` | `2026-08-23-expedited-critical-path.md` | `DUPLICATE_ALIAS` | Canonical critical proof. | `PROVEN` |
| Web UI R2 — typed citation challenge | `WEBSESSION-INTENT-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical zero-grade challenge proof. | `UNSTARTED` |
| Web UI R3 — route identity/canonicalization after mount | `WEBSESSION-ROUTE-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical StrictMode hydration proof. | `UNSTARTED` |
| Web UI R4 — mounted orchestration tests | `WEBSESSION-MOUNT-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical mounted seam suite. | `UNSTARTED` |
| Web UI R5 — confirmation/undo for destructive actions | `FRONTEND-004` | `2026-08-23-frontend-accessibility-performance.md` | `DECISION_BLOCKED` | Decision `D-04` selects exactly `CONFIRM_DELETE` or `SOFT_DELETE_UNDO`; exact `DATA-016`, `SERVICE-018`, and `WEBAPI-016` prove the study-set durable/absence chain, while `FRONTEND-004` must separately prove study-set/source and session-recap/history controls. Branch B gives undo only to the study set and keeps confirmation for the non-undoable recap/history delete; keyboard, pointer, cancel, and zero-request-before-confirm controls are required for both. | `UNSTARTED` |
| Web UI R6 — bounded session-entry fetches | `WEBSESSION-AUTH-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Canonical never-resolving refresh proof; start request receives the same deadline policy. | `UNSTARTED` |
| Web UI R7 — disclosure copy matches gate | `FRONTEND-005` | `2026-08-23-frontend-accessibility-performance.md` | `DECISION_BLOCKED` | Decision `D-08` plus exact copy/behavior proof. | `UNSTARTED` |
| Web UI R8 — cache voice-label plans | `WEBSESSION-CANVAS-01` | `2026-08-23-web-session-audio.md` | `DUPLICATE_ALIAS` | Exact Plan 10 `WEBSESSION-CANVAS-01` provides the instrumented label-cache proof and consumes Plan 13 `FRONTEND-008`'s shared effects/frame budget. | `UNSTARTED` |
| Shared packages R1 — persist FSRS state or truthful selected policy | `LEARN-D01-03` | `2026-08-23-learning-core-authority.md` | `DECISION_BLOCKED` | Selected exact Plan 04 task `LEARN-003A` or `LEARN-003B` after Decision `D-01`; Decision `D-01` plus repeated-review conformance. | `PROVEN` |
| Shared packages R2 — cap before any future exam | `LEARN-D01-03` | `2026-08-23-learning-core-authority.md` | `DECISION_BLOCKED` | Selected exact Plan 04 task `LEARN-003A` or `LEARN-003B` after Decision `D-01`; Decision `D-01` plus 1–8-day exam tests. | `PROVEN` |
| Shared packages R3 — close learner-loop validator | `LEARN-006` | `2026-08-23-learning-core-authority.md` | `DUPLICATE_ALIAS` | Canonical contract mutation proof. | `PROVEN` |
| Shared packages R4 — update evidence-field docs | `INTEGRATION-007` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `DUPLICATE_ALIAS` | Exact Plan 15 `INTEGRATION-007` updates the owner documentation; Plan 15's `scripts/public-contract.test.mjs` proves the result names every exported evidence field and no invalid status. Plan 14 `PACKAGE-08` ships only the prose handoff. | `UNSTARTED` |
| Shared packages R5 — validate raw JSON in release scripts | `RELEASE-028` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Exact Plan 12 ID `RELEASE-028` makes every release-script import call the published runtime validator and makes each consumer reject an invalid fixture. | `UNSTARTED` |
| Shared packages R6 — token authority/parity and terminal values | `RELEASE-MULTIPLAN-TOKEN-TERMINAL-01` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | Exact Plan 13 `FRONTEND-001` establishes generated/runtime token authority with a drift mutation; Plan 05 `VOICE-TERMINATION-001` publishes the closed terminal vocabulary and exact Plan 12 `RELEASE-028` makes smoke/failure-matrix consumers validate it before branching. | `UNSTARTED` |
| Shared packages R7 — fixtures subpath only | `PACKAGE-02` | `2026-08-23-package-build-contracts.md` | `DUPLICATE_ALIAS` | Canonical export-boundary proof. | `UNSTARTED` |
| Shared packages R8 — ui-web React peer/style ownership | `PACKAGE-07` | `2026-08-23-package-build-contracts.md` | `BATCH_FIX` | Package manifest exposes React peer range and exported primitives resolve their required styles in isolated consumer build. | `UNSTARTED` |

### Component-review final recommendations: Release, security, and architecture

| Source review and stable recommendation | Canonical ID | Owning plan filename | Disposition | Required proof | Status |
| --- | --- | --- | --- | --- | --- |
| Release gates R1 — strict downstream stored-bundle verifier | `RELEASE-004` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical independent production verifier proof. | `UNSTARTED` |
| Release gates R2 — unify forbidden evidence scanner | `RELEASE-009` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical all-consumer mutation proof. | `UNSTARTED` |
| Release gates R3 — strict sanitized/run/deploy imports | `RELEASE-UNION-003-007-008` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | `RELEASE-003`, `RELEASE-007`, and `RELEASE-008` pass. | `UNSTARTED` |
| Release gates R4 — missing-tool shell gates fail closed | `RELEASE-001` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical PATH/exit-code proof. | `UNSTARTED` |
| Release gates R5 — spawn cleanup and unique commands | `RELEASE-PAIR-005-006` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | `RELEASE-005` and `RELEASE-006` pass. | `UNSTARTED` |
| Release gates R6 — BAC-528 evidence reflects plan | `RELEASE-002` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical `enabled_for_release === plan.enabled` mutation proof. | `UNSTARTED` |
| Release gates R7 — behavioral release-check evidence tests | `RELEASE-010` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical mutation proof. | `UNSTARTED` |
| E2E/monitor R1 — failure count plus timeout deadline contract | `RELEASE-UNION-013-014-017` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | `RELEASE-013`, `RELEASE-014`, and `RELEASE-017` pass on the canonical monitor schema. | `UNSTARTED` |
| E2E/monitor R2 — shared managed process helper | `RELEASE-015` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical wrapper/grandchild/signal proof covers E2E, dev-agent, monitor adoption. | `UNSTARTED` |
| E2E/monitor R3 — minimum-secret monitor environment | `RELEASE-016` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical mode matrix/capability proof. | `UNSTARTED` |
| E2E/monitor R4 — retry S3 and classify publish failures | `RELEASE-018` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical publication commit-marker proof. | `UNSTARTED` |
| E2E/monitor R5 — hosted screenshot references truthful | `RELEASE-025` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | Manifest marks local-only frames or durable publisher uploads referenced images; no dead PNG content-type path remains. | `UNSTARTED` |
| E2E/monitor R6 — pin limiter proof to real Rust test | `RELEASE-020` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical proof-name mutation control. | `UNSTARTED` |
| E2E/monitor R7 — publish partial sanitized evidence on termination | `RELEASE-014` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical graceful timeout/SIGTERM partial-evidence proof. | `UNSTARTED` |
| Security component R1 — non-root/digest-pinned runtime images | `RELEASE-026` | `2026-08-23-release-monitor-ci-supply-chain.md` | `BATCH_FIX` | `RELEASE-026` built-image and provenance proof passes. | `UNSTARTED` |
| Security component R2 — trusted peer IP model | `SERVICE-003` | `2026-08-23-agent-service-runtime.md` | `DUPLICATE_ALIAS` | Canonical admission/runbook proof; the runbook half closes only with Plan 12's linked `docs/deployment-runbook.md` commit (Plan 08 supplies the exact guidance). | `UNSTARTED` |
| Security component R3 — least-privilege workflow | `RELEASE-027` | `2026-08-23-release-monitor-ci-supply-chain.md` | `DUPLICATE_ALIAS` | Canonical permissions/action-SHA policy proof. | `UNSTARTED` |
| Security component R4 — expiry/bounded limiter cleanup | `DATA-WEBAPI-EXPIRY-CAPACITY-01` | `2026-08-23-persistence-postgres-privacy.md` | `BATCH_FIX` | `DATA-008` and `WEBAPI-005` capacity/security proofs pass. | `UNSTARTED` |
| Security component R5 — document production REST+session secret requirement | `INTEGRATION-007` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `BATCH_FIX` | Configuration matrix and runbook prove delete/export availability and fail-closed missing-secret behavior. | `UNSTARTED` |
| Security component R6 — protect redaction/pull-request CI controls | `INTEGRATION-001` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `EXTERNAL_EVIDENCE` | Ruleset requires exact redaction/validate checks and prevents unreviewed workflow removal. | `UNSTARTED` |
| Architecture component R1 — shared token/initial-frame fixtures | `VOICE-PAIR-TOKEN-AUTH` | `2026-08-23-voice-wire-auth-contract.md` | `BATCH_FIX` | `VOICE-TOKEN-001` and `VOICE-AUTH-001` Rust/TS vectors pass. | `UNSTARTED` |
| Architecture component R2 — one typed first-frame parser, no Ready mirror | `VOICE-SERVICE-AUTH-READY-01` | `2026-08-23-voice-wire-auth-contract.md` | `BATCH_FIX` | Typed protocol consumes signed initial frame and `SERVICE-009` removes duplicate ready shape. | `UNSTARTED` |
| Architecture component R3 — one scheduling authority/truthful README | `CRIT-SCHED-01` | `2026-08-23-expedited-critical-path.md` | `DECISION_BLOCKED` | Decision `D-01` plus canonical scheduler/docs proof. | `UNSTARTED` |
| Architecture component R4 — real no-I/O gate | `DOMAIN-001` | `2026-08-23-rust-domain-integrity.md` | `DUPLICATE_ALIAS` | Canonical boundary proof. | `UNSTARTED` |
| Architecture component R5 — docs-contract consistency test | `INTEGRATION-007` | `2026-08-23-integrated-evidence-and-release-readiness.md` | `DUPLICATE_ALIAS` | Plan 15's `scripts/public-contract.test.mjs` (Task 7, `INTEGRATION-007`) supplies the executable status/evidence vocabulary test; exact Plan 15 `INTEGRATION-007` owns the documentation correction and reruns the test on the frozen tree. Plan 14 `PACKAGE-08` ships only the prose handoff. | `UNSTARTED` |
| Architecture component R6 — Turbo outputs/env hash correctness | `PACKAGE-04` | `2026-08-23-package-build-contracts.md` | `DUPLICATE_ALIAS` | Canonical cache differential proof. | `UNSTARTED` |
| Architecture component R7 — Apache crate metadata | `PACKAGE-06` | `2026-08-23-package-build-contracts.md` | `DUPLICATE_ALIAS` | Canonical cargo metadata proof. | `UNSTARTED` |

Final recommendation-list count check: agent-domain 7 + adapters 7 + service 7 + data 8 + Web API 6 + Web session 6 + Web UI 8 + packages 8 + release gates 7 + E2E/monitor 7 + security 6 + architecture 7 = 84 rows.
