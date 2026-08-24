# Code Review: Rust agent-domain crate

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | agent/crates/agent-domain/ |
| **Verdict** | needs-work |
| **Confidence** | High |

`agent-domain` is the hexagonal core of Viva's voice-study loop: session/tool types, the seven-tool executor, fail-closed validation types, and the ports the adapters implement. The scaffolding is genuinely strong — session-bound tool authorization, fail-closed validation enforced at the persistence boundary, careful sanitization, cross-language contract mirroring. But adversarial verification confirmed that the domain logic at the center of the product is fixture-grade on the live path: review scheduling persists hardcoded June-2026 due dates (all now in the past) through the shared `CartesiaGeminiRunner` into Postgres and the user-facing library; recaps are fabricated from the active question's term list instead of the student's recorded performance; and the substring grader has inflated thresholds and unreachable branches that no test pins. One first-pass finding was refuted and one downgraded during verification; the overall verdict stands at needs-work.

## Strengths

- Strong trust-boundary discipline in the tool executor: every tool call is re-bound to the authorized session and forged `study_set_id`/`voice_session_id` are rejected (`agent/crates/agent-domain/src/tool_executor.rs:294-306`), and model-supplied `due_at` is explicitly refused (`tool_executor.rs:234-239`).
- Fail-closed validation types (`AnswerEvaluation::validate_fail_closed` at `src/study.rs:113-128`, `AnswerAttemptEnvelope::validate_fail_closed` at `src/ports.rs:136-157`) are actually enforced at the persistence boundary by both store adapters (verified at `agent/crates/data/src/postgres.rs:1565-1585` among others), including NaN/out-of-range confidence and the empty-answer-cannot-be-strong invariant.
- Cross-language contract mirroring is real, not aspirational: the crate embeds `packages/core/src/learner-loop-contract.json` with a bounded assertion (`src/lib.rs:43-58`), and a test deserializes the shared TS session-config fixture into the Rust types (`tests/protocol_fixtures.rs:55-63`).
- Injection-conscious sanitization of provider failure fields with character allow-lists and length caps (`src/brain.rs:372-397`), and saturating arithmetic throughout `BrainUsage::add` (`src/brain.rs:410-433`).
- `AudioFrame` encapsulates PCM bytes behind a stable `pcm16_base64` wire contract (encoding cached when constructed from base64), equality defined on decoded bytes, and a custom deserializer that tolerates unknown fields (`src/lib.rs:60-158`); the crate carries `#![forbid(unsafe_code)]` plus workspace-level clippy denies.
- `RealtimeSessionTaskGuard` aborts its spawned tasks on drop (`src/brain.rs:157-173`), so dropping a `RealtimeSession` cannot leak the pump tasks created by the default `RealtimeBrain::open`.

## Findings

### Critical

**1. Review scheduling persists hardcoded June-2026 fixture dates as real due dates**

`agent/crates/agent-domain/src/tool_executor.rs:339-346`

**What:** `storage_due_at_for_status` maps every `ConceptStatus` to a fixed calendar date (2026-06-18 through 2026-06-24). `schedule_review_item` (`tool_executor.rs:229-252`) passes this string to `StudyMemoryStore::schedule_review_item`, and both stores persist it verbatim: postgres binds it straight into `INSERT INTO review_items` (`agent/crates/data/src/postgres.rs:2205-2220`) and the memory store stores it as-is (`agent/crates/data/src/memory.rs:3040-3046`). The web library then displays it verbatim with authority `"server_persisted"` (`apps/web/lib/viva-library.ts:403-428`, rendering e.g. "due Jun 18, 2026"). This is the live production path, verified end to end: `CartesiaGeminiBrain::new` builds `CartesiaGeminiRunner::live` (`agent/crates/agent-adapters/src/cartesia_gemini/mod.rs:246-296`), `open` is generic over transports, and the shared per-turn stage `emit_deterministic_study_tool_events` issues `ToolProposal::schedule_review_item` on every turn (`runner.rs:839-853`, reached from `emit_turn` at `runner.rs:469-484`).

**Why it matters:** As of 2026-08-23 every scheduled review is due in the past, and the dates never move relative to session time, so the spaced-repetition pillar of the product is functionally broken: all reviews are permanently overdue and identical regardless of performance or when the session happened. It also contradicts the executor's own rejection message at `tool_executor.rs:236` ("@viva/core computes review dates") — the real FSRS scheduler in `packages/core/src/scheduling.ts` (authority `"core_fsrs"`) is only re-exported from the core index and never feeds this persistence path.

**Fix:** Inject time into the domain (a Clock port or a `now: DateTime` parameter on the executor/tool path, keeping the crate I/O-free) and compute `due_at` as now + status-based intervals that mirror the @viva/core FSRS contract (e.g. via constants in `learner-loop-contract.json` so both sides share them); alternatively have the store adapters compute `due_at` at insert time. Delete the hardcoded date table here and its byte-for-byte duplicate in `agent/crates/agent-adapters/src/synthetic.rs:808-813`.

### Important

**1. Purity gate does not enforce what README/CONTRIBUTING promise**

`scripts/check-agent-domain-purity.sh:9-14`

**What:** `README.md:176` claims agent-domain has "no I/O at all, and a purity gate in CI keeps it that way"; `CONTRIBUTING.md:50` says `bun run agent:purity` "asserts agent-domain stays I/O-free" and `CONTRIBUTING.md:59-60` says it "enforces this"; the PR template has a matching checkbox (`.github/pull_request_template.md:22`). The script actually only greps `agent packages apps` for residue strings from a prior product domain ("Chef Luca"/cooking terms: recipe, ingredient, allergen, etc.). It never inspects agent-domain's dependencies or code for I/O, and nothing else in CI does either (`.github/workflows/validate.yml` runs this same script).

**Why it matters:** The advertised architectural invariant is unguarded: adding reqwest, sqlx, or `std::fs` to agent-domain would pass the "purity" gate silently. The crate already depends on the tokio runtime (`Cargo.toml:17`) and spawns tasks in the default `RealtimeBrain::open` (`src/brain.rs:463-484`) — defensible channel plumbing, but exactly the kind of drift the gate claims to catch and cannot. For a repo just prepared for public release with its gates as a selling point, a gate whose name and docs over-promise is a credibility problem.

**Fix:** Extend the script to enforce the documented invariant: fail if `cargo tree -p agent-domain` shows deny-listed crates (reqwest, sqlx, axum, tokio net/fs features), optionally grep `agent-domain/src` for `std::fs`/`std::net`. Or rename the script and soften the README/CONTRIBUTING/PR-template claims to what it actually checks.

**2. build_session_recap fabricates the recap from the question's term list, ignoring actual performance**

`agent/crates/agent-domain/src/tool_executor.rs:165-207`

**What:** The recap marks the active question's first two `expected_terms` as `strong_concepts`, the next two as shaky/review_later, always sets `missed_concepts` to empty, and stamps the single source moment `ConceptStatus::Strong` — without ever reading the session's recorded answer evaluations or concept statuses from the store. This recap is persisted via `record_recap` and emitted as `RecapReady` in the shared live/fake runner path (`agent-adapters/src/cartesia_gemini/runner.rs:903-921`, reached per turn from `emit_turn`).

**Why it matters:** A student who missed every answer still receives (and the store durably records) a recap claiming the first two expected terms are "strong" and that nothing was missed. The library derives the session card's mastery display directly from the recap's graded buckets (`apps/web/lib/viva-library.ts:248-270`, `projectSessionMastery`), so persisted study history misrepresents learning outcomes — the core product claim ("finds out what you actually know") is undermined by its own domain logic.

**Fix:** Derive the recap from evidence: add/use port reads for the session's recorded concept statuses and evaluations (the stores already track these — see `StudySessionDurableCounts`) and bucket concepts into strong/shaky/missed from real data. If this deterministic recap is intentionally fixture-grade, gate it so the live runner cannot reach it.

**3. Answer grading is naive substring counting with skewed thresholds in the live path**

`agent/crates/agent-domain/src/tool_executor.rs:86-133`

**What:** `evaluate_spoken_answer` lowercases the transcript and counts `expected_terms` that appear as substrings; `concept_status_for_terms` (`tool_executor.rs:317-328`) maps counts to status with threshold `matched >= max(expected-1, 1)` for Strong. Verified consequences: (a) with 2 expected terms, mentioning 1 yields Strong; (b) reciting terms verbatim without understanding, or negating them ("it is NOT the electron donor"), counts as matched; (c) `ConceptStatus::Shaky` is unreachable for questions with 3 or fewer expected terms (it requires `matched >= 2` after the Strong branch already claimed `matched >= expected-1`); (d) `label_for_status` (`tool_executor.rs:330-337`) never emits "strong", "wrong", or "off-topic" — a perfect answer is labeled "mostly correct" — so 3 of the 7 rubric labels in `study.rs:131-142` are dead in this evaluator. The live Gemini runner routes the model's `evaluate_spoken_answer` call into exactly this executor and emits the result as `AnswerEvaluated` (`agent-adapters/src/cartesia_gemini/runner.rs:611-670`).

**Why it matters:** This deterministic evaluator is the production grader (a deliberate grounding choice — the LLM cannot invent grades), so its edge behavior is user-facing: inflated Strong statuses feed concept mastery, review scheduling, and recaps. The thresholds and dead branches look accidental rather than tuned, and nothing pins them (see the next finding).

**Fix:** At minimum use word-boundary matching, require `matched == expected` for Strong (or a documented ratio), make Shaky reachable for small term sets, and align `label_for_status` with the full rubric. Add a boundary-table unit test so future tuning is deliberate.

**4. No in-crate unit tests pin domain logic; existing tests mirror the implementation**

`agent/crates/agent-domain/tests/protocol_fixtures.rs:1-84`

**What:** `src/` contains zero `#[cfg(test)]` modules (verified by grep); the crate's only tests are 5 shallow fixture tests, most of which construct a value and assert its own fields back (e.g. `protocol_fixtures.rs:17-31` builds a `ToolProposal` then asserts the arguments it just passed). Unpinned behavior includes: `concept_status_for_terms` boundaries, `confidence_for_terms` clamping, `label_for_status` mapping, `bind_study_set_and_session` rejection, unknown-tool rejection, the `due_at`-argument rejection, `validate_fail_closed` edge cases, `sanitize_stage_token`/`metadata`, and `BrainUsage::add` saturation. No test in `data/` or `agent-adapters` asserts a Shaky or mid-rubric evaluation outcome from this grader either — the `Shaky` assertions that exist (`agent-adapters/src/synthetic.rs:1053`, `agent-service/tests/voice_ws.rs:295`) come from spec-provided fixture statuses, not from `evaluate_spoken_answer`.

**Why it matters:** The crate's whole purpose is to be the deterministic, unit-testable core, and its most consequential logic (grading, scheduling, validation) has no direct tests. The stale-dates critical and the dead Shaky branch are exactly the regressions boundary tests would have caught; integration tests in sibling crates exercise happy paths only.

**Fix:** Add in-crate unit tests: a boundary table for `concept_status_for_terms`/`confidence_for_terms`, rejection tests for `bind_study_set_and_session` and unknown tools, `validate_fail_closed` edge cases (NaN, 1.01, empty ids, digest/policy combinations), sanitizer property checks, and a test that storage-bound due dates are strictly in the future relative to an injected now (after fixing the scheduling critical). The two genuinely valuable existing tests (shared fixture deserialization, AudioFrame base64 round-trip) show the right pattern.

### Minor

**1. Session phase "state machine" has no transition rules in the domain**

`agent/crates/agent-domain/src/study.rs:5-15`

**What:** `StudySessionPhase` is a bare enum (Ready/Listening/Thinking/Feedback/Correction/Recap) with no validation of legal transitions, and `TerminalSessionReason` is likewise pure data. Phase sequences are hand-emitted by adapters (e.g. the runner pushes Feedback then Correction inline, `agent-adapters/src/cartesia_gemini/runner.rs:884-890`), `protocol.rs` forwards them 1:1 (`agent-service/src/protocol.rs:171-178`), and no `transition` function exists anywhere in agent-service. Only example-based service tests pin specific frame sequences.

**Why it matters:** A refactor in any adapter can silently emit nonsense phase sequences to the client protocol (Recap before any question, phases after a terminal reason). Downgraded from important: there is no current misbehavior — today's emitters produce sane sequences and service tests pin them — so this is a missing defensive invariant, not a defect.

**Fix:** Add a transition function (`fn can_transition_to(self, next: StudySessionPhase) -> bool`, plus terminal-phase absorption) or a small typed session-state struct in agent-domain, use it in agent-service when emitting `SessionPhase` frames, and table-test it.

**2. BrainProviderFailure sanitization is constructor-only and bypassable**

`agent/crates/agent-domain/src/brain.rs:335-360`

**What:** The `sanitize_stage_token`/`metadata` invariants are applied only in `BrainProviderFailure::new`, but the struct has all-pub fields and derives `Deserialize`, so struct-literal construction or deserialization yields unsanitized values. Today all production construction goes through `new()` and `Deserialize` is only exercised by fixtures, so this is latent.

**Why it matters:** The sanitizers exist to keep provider-controlled strings out of logs/metrics/close-reasons unfiltered; an invariant any caller can skip by writing a struct literal will eventually be skipped.

**Fix:** Make the fields private with accessors (or `#[serde(deserialize_with)]` routing through the sanitizers), keeping `BrainProviderFailureParts` as the only public construction surface — it is currently an identical field-for-field twin of the struct, which also invites confusion.

**3. Triplicated string mappings invite drift**

`agent/crates/agent-domain/src/study.rs:38-79`

**What:** `TerminalSessionReason` has three parallel representations that must stay in sync: serde `rename_all` snake_case, `as_str()` (16-arm match), and `close_reason()` (an identical match differing only by underscore-vs-space). Separately, `storage_due_at_for_status` exists twice byte-for-byte (`agent-domain/src/tool_executor.rs:339-346` and `agent-adapters/src/synthetic.rs:808-813`).

**Why it matters:** Adding a variant or changing a date requires touching multiple copies with no compiler or test forcing agreement; the duplicated date table means the scheduling fix can be applied in one place and silently missed in the other.

**Fix:** Derive `close_reason` from `as_str().replace('_', " ")`, add a test asserting `as_str` matches serde serialization, and have synthetic.rs import the (fixed) scheduling helper from agent-domain instead of carrying a copy.

**4. Fail-open write defaults on StudyMemoryStore contradict the fail-closed posture**

`agent/crates/agent-domain/src/ports.rs:396-398`

**What:** `record_voice_session` (`ports.rs:396-398`) and `record_voice_usage` (`ports.rs:667-669`) default to `Ok(())`, and `answer_attempt_was_recorded`/`pending_answer_attempts_for_session` default to `Ok(false)`/`Ok(0)`, while the `authorize_*`/`record_*` mutations default to `Err(Unavailable)`. Verified: the in-memory store does not override `record_voice_usage` (only `postgres.rs:2322` does), so usage records are silently discarded on that backend.

**Why it matters:** A new or partial store implementation compiles while silently dropping cost/usage telemetry — the exact data the release-evidence gates and cost-budget limits depend on. The asymmetry is undocumented, so it reads as accident rather than policy.

**Fix:** Make the usage/session write defaults fail closed like the other mutations, or document per-method why fail-open is safe (e.g. in-memory is explicitly non-durable via `StudyStoreCapabilities`) and have `write_counts` expose dropped-usage so tests can see it.

**5. AudioFrame text-as-PCM fixture helper lives in the production API**

`agent/crates/agent-domain/src/lib.rs:74-76`

**What:** `AudioFrame::from_pcm16_text` encodes arbitrary UTF-8 text bytes as if they were PCM16 samples. It exists for fixtures (used in tests and the fake transports) but is exported unguarded; a reader can plausibly mistake it for text-to-speech synthesis, and odd-length text produces invalid 16-bit sample streams. Relatedly, `pcm16_base64()` (`lib.rs:97-102`) re-encodes the full frame on every call when the frame was not built from base64.

**Why it matters:** API affordances shape misuse; a fixture constructor on the core audio type is a small trap, and repeated base64 encoding of the same frame is redundant work if any path serializes a frame more than once.

**Fix:** Rename to something honest (`from_fixture_text`) and/or gate behind a fixtures feature; consider caching the encoding if profiling shows repeat serialization.

**6. AnswerAttemptEnvelope validation misses the digest-present converse**

`agent/crates/agent-domain/src/ports.rs:136-157`

**What:** `validate_fail_closed` rejects a digest under content policy `None` (`ports.rs:153-155`), but accepts `DigestOnly` with `answer_digest_hmac: None`, and never sanity-checks `byte_count`/`char_count`/`duration_ms` (0 or absurd values pass).

**Why it matters:** If `DigestOnly` is meant to guarantee a digest exists (the data-governance story treats the digest as the only durable trace of answer content), a missing digest under that policy silently records an attempt with no evidence at all; if legitimately optional, that is worth a comment, since the current asymmetry looks like an oversight.

**Fix:** Either require `Some(digest)` under `DigestOnly` (with a shape check on the HMAC hex) or document why absence is valid; optionally bound the count/duration fields.

## Verification notes

- **F7 refuted** (contract bound "panics at runtime instead of failing CI"): agent-service unit tests call `bac_510_max_turn_duration()` directly (`agent-service/src/config.rs:1108-1118`), so a malformed or field-renamed contract JSON fails `cargo test` in CI, not just at runtime; the "per turn" claim is also wrong — the runtime call site (`ws.rs:496` via `record_turn_cap_config`) runs once per session open. What remains (re-parsing a small embedded JSON per call; a LazyLock would be tidier) is taste, not a finding.
- **F6 downgraded important → minor** (no phase transition rules): the gap is real — no transition validation exists anywhere, and `protocol.rs` forwards phases 1:1 — but there is no current misbehavior, today's emitters produce sane sequences pinned by service example tests, and no repo doc promises a domain-enforced state machine. Missing hardening, not a defect.
- All other critical/important findings were confirmed end to end, including the live-path reachability of the fixture-grade scheduling, recap, and grading logic: `CartesiaGeminiBrain` (live transports) shares `emit_turn`/`emit_deterministic_study_tool_events` with the fake runner (`runner.rs:78-108, 361-485, 752-936`).

## Recommendations

1. Fix review scheduling first: inject time into the domain (Clock port or explicit now parameter), compute `due_at` from status-based intervals shared with @viva/core via `learner-loop-contract.json`, and delete both hardcoded June-2026 date tables (`agent-domain/src/tool_executor.rs` and `agent-adapters/src/synthetic.rs`).
2. Make `scripts/check-agent-domain-purity.sh` enforce the documented invariant (deny-list I/O crates via `cargo tree -p agent-domain`, grep for `std::fs`/`std::net`) or reword README/CONTRIBUTING/PR-template so the public repo's claims match the gate.
3. Rebuild `build_session_recap` from recorded session evidence (concept statuses and answer evaluations read through ports) instead of the active question's expected terms.
4. Add an in-crate unit-test layer: grading boundary tables, tool-binding and unknown-tool rejections, `validate_fail_closed` edges, sanitizer checks, and a future-dated-due-at property test; retire the constructor-mirror assertions in `protocol_fixtures.rs` or extend them into real contract checks.
5. Revisit grading thresholds deliberately: word-boundary term matching, a documented Strong threshold, a reachable Shaky band for small term sets, and full use of the seven-label rubric.
6. Introduce a `StudySessionPhase` transition function (or typestate) in agent-domain and use it wherever agent-service/adapters emit `SessionPhase` frames.
7. Decide and document the fail-open vs fail-closed policy for each `StudyMemoryStore` default; make usage/session writes fail closed or surface drops via `write_counts`.

## Assessment

**Verdict: needs-work** (unchanged from the first pass; verification refuted one minor-grade finding and downgraded one, but every load-bearing finding survived).

The crate's scaffolding is genuinely good — clean hexagonal ports, session-bound tool authorization, fail-closed validation enforced at the persistence boundary, careful sanitization, and cross-language contract mirroring. But the domain logic at the center of the product is fixture-grade in the confirmed live path: review scheduling persists static June-2026 dates (already in the past) into Postgres and the user-facing library, recaps are fabricated from the question's term list rather than the student's actual performance, and the grading heuristic has unreachable branches and inflated thresholds that nothing pins. A focused correctness pass — time injection for scheduling, evidence-derived recaps, deliberate grading thresholds, an in-crate test layer, and an honest purity gate — is required before the crate's core promises hold in production; a rewrite is not.
