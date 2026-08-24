# Code Review: Shared TS packages (core, tokens, ui-web) and types

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | packages/core/, packages/tokens/, packages/ui-web/, types/ |
| **Verdict** | sound-with-fixes |
| **Confidence** | High |

This area is the TypeScript side of Viva's cross-language contract layer: the browser mirror of the Rust voice protocol (`agent-contract.ts`), the FSRS-backed review scheduler (`scheduling.ts`), the BAC-510 learner-loop contract and its derived recovery-copy projection, plus a small tokens package and ui-web components. The contract and sanitization machinery is genuinely strong — shared fixtures with the Rust tests, closed enum allowlists, import-time contract validation, forbidden-pattern copy tests. Verification confirmed all eleven first-pass findings against source (including reproducing the FSRS behavior from the vendored ts-fsrs 5.4.1 dist): three important fixes are needed in the scheduler and the learner-loop validator, and eight smaller cleanups follow. Nothing critical.

## Strengths

- Cross-language contract testing is real, not mirrored assumptions: `packages/core/src/agent-contract.test.ts` parses the exact same JSON fixtures (`agent/fixtures/voice-protocol/client-audio.json`, `synthetic-study-session.json`, the fake-provider session, evidence packs) that `agent/crates/agent-service/src/protocol.rs` round-trips in its Rust tests, so TS/Rust drift in frame shapes fails CI on both sides.
- Enum fidelity to the Rust protocol is exact: `VIVA_AGENT_TERMINAL_SESSION_REASONS` (`agent-contract.ts:42-59`) matches `TerminalSessionReason` in `agent/crates/agent-domain/src/study.rs` variant-for-variant, and all parse functions enforce closed allowlists so raw provider strings can never masquerade as terminal reasons.
- Manuscript-intent parsing is a thoughtful server-to-browser security boundary: `requireOnlyKeys` plus a 96-char restricted-charset id check (`agent-contract.ts:540-593`) strictly reconstructs intents, and tests prove render instructions (css/html/coordinates) and oversized or markup ids are rejected.
- The learner-loop contract validates itself at import time (`learner-loop-contract.ts:215-217`) with bidirectional runtime-copy-cause reconciliation, duplicate-resolution-key detection, and sanitization tests that grep the serialized contract for secret/PII terms (`learner-loop-contract.test.ts:178-198`).
- Learner/operator copy separation (`learner-recovery-copy.ts`) is enforced by a rigorous forbidden-pattern test covering operator field names, provider internals, credential terms, and dead-end phrasing.
- Scheduling tests exercise real behavior (ordering, hint/miss demotion, under-24h exam boundary, advisor-due-date authority rejection) rather than mocks, and `humanInterval`'s ms-ratio + `Math.round` approach is DST-safe for day labels.

## Findings

### Important

**1. FSRS memory state is never carried between reviews; `lastReviewedAt` is provably inert in the FSRS computation**

`packages/core/src/scheduling.ts:73-75`

**What**: `scheduleConceptReview` always builds a fresh empty card: `const createdAt = input.lastReviewedAt ?? input.now; const card = createEmptyCard(createdAt); scheduler.next(card, input.now, rating)`. Verified against the vendored ts-fsrs 5.4.1 dist: `createEmptyCard` produces `state: State.New, last_review: undefined`, `AbstractScheduler.init()` sets `elapsed_days = 0` for any New card, and `LongTermScheduler.newState` re-forces `elapsed_days = 0` and computes `due` from the review time — so the `createdAt` argument has zero effect on the scheduled due date. Every review is treated as a first review: a concept rated strong ten sessions in a row gets the identical ~8-day interval (default `w[3] = 8.2956`) every time, and stability/difficulty never accumulate.

**Why it matters**: `docs/REQUIREMENTS.md:1101-1105` says a concept "can be reviewed later when … concept has been strong across sessions", which is unimplementable with stateless first-review bootstrapping. Worse, the code misleads: `scheduling.ts:121` pushes "session recency included" into the learner-visible explanation whenever `lastReviewedAt` is set, but recency only enters via the hard caps in `recencyCapDays` — the FSRS path ignores it entirely. A future maintainer reading `createEmptyCard(lastReviewedAt)` will reasonably believe elapsed time matters.

**Fix**: Either persist per-concept card state (stability, difficulty, state, last_review) and feed the real card into `scheduler.next` so intervals grow with repetition, or explicitly document first-review-only scheduling: drop the inert `createdAt` plumbing (use `input.now`), and reword or remove the "session recency included" explanation so it refers only to the recency caps.

**2. Exam-near cap window (3 days) is narrower than the first "strong" interval, so reviews are silently scheduled after the exam**

`packages/core/src/scheduling.ts:137-143`

**What**: `applyUrgencyCaps` only applies the exam cap when `msToExam <= 3 * 86_400_000`. With default FSRS weights the first interval for `Rating.Easy` ("strong") is ~8 days and `Rating.Good` ("review") is ~2.3 days. A strong concept with an exam 4-8 days out gets `dueAt` after the exam with no cap, no explanation entry, and priority "later". Only `centrality >= 90` (3-day cap) or `hinted` (2-day cap) accidentally rescue it. This path is live: `apps/web/lib/viva-display.ts:118` derives real exam dates from labels, `examDateFromLabel` (`viva-display.ts:238-249`) turns the seeded "Exam Friday" label (`packages/core/src/index.ts:215`) into a date up to 7 days ahead, and `scheduling.test.ts` only tests exams 1-2 days out.

**Why it matters**: For an exam-prep product, scheduling a concept's next review after the exam it exists for contradicts `docs/REQUIREMENTS.md:1092-1097` ("reviewed sooner when … exam date is near") and produces a visibly wrong plan next to an "Exam Friday" label.

**Fix**: When `examDate` is set and in the future, cap `dueAt` at `examCapDate(now, examDate)` whenever the FSRS due lands past the exam (apply the min unconditionally for future exams, not just within 3 days), and add a test for an exam 5-7 days out with status "strong".

**3. `validateLearnerLoopContract` leaves `authority`, `resolution_kind`, `primary_action_intent`, and literal-true fields unvalidated against JSON drift**

`packages/core/src/learner-loop-contract.ts:136-217`

**What**: The validator checks schema id, evidence fields, resolution bounds, duplicate ids/keys, terminal reasons, and runtime copy causes — but never checks that `state.authority` is one of the six `LearnerLoopAuthority` values, that `resolution_kind` is one of the four kinds, that `copy.primary_action_intent` is a known intent, or that `sanitized_evidence` is literally true. The import does `contractData as LearnerLoopContract` (line 215-217), an unchecked assertion that widens JSON strings past the union types, so an edit like `"authority": "optimistic_ui"` or `"primary_action_intent": "reboot"` in `learner-loop-contract.json` ships silently. Test coverage is partial: `learner-loop-contract.test.ts:77-78` does assert `learner_safe === true` for every state, and checks `authority`/`resolution_kind` for pre-loop and submitted-answer states, but `primary_action_intent` and `sanitized_evidence` are checked nowhere, and none of these checks live in the runtime validator whose stated job is drift rejection.

**Why it matters**: This file's entire purpose is drift rejection for a JSON contract consumed by four release-gate scripts (`scripts/rollback-drain-criteria.mjs`, `live-provider-failure-matrix.mjs`, `hosted-e2e-matrix.mjs`, `provider-failure-observability.mjs` all import the raw JSON directly, bypassing even this validator) and by the web app's recovery UI, which switches on `primary_action_intent` (`apps/web/lib/viva-session-projection.ts:521-533`). An invalid intent value would render a dead recovery button — exactly the class of failure the BAC-510 contract exists to prevent.

**Fix**: Add allowlist checks for `authority`, `resolution_kind`, and `copy.primary_action_intent` inside `validateLearnerLoopContract` (mirroring the existing `knownTerminalReasons` pattern), and assert `learner_safe === true` and `sanitized_evidence === true` per state — or replace the hand-rolled validator with a schema library that also replaces the unchecked cast.

### Minor

**1. Cap explanations are pushed even when the cap did not bind the due date**

`packages/core/src/scheduling.ts:141`

**What**: `applyUrgencyCaps` pushes "exam-near cap" whenever the exam is within 3 days, even if `minDate` keeps the earlier FSRS date (e.g. a missed concept already due tomorrow with the exam in 3 days). Likewise `recencyCapDays` (lines 163-171) pushes "session recency cap" before `capDays` takes `Math.min` — if the missed-status 1-day cap wins, the explanation still claims recency capped it.

**Why it matters**: `explanation[]` is the learner/operator-facing reasoning trail; it currently asserts causes that had no effect, undermining trust in the "explainable schedule" the module advertises.

**Fix**: Compute the candidate cap dates first, compare against the current `dueAt`, and only push each explanation when that specific cap actually lowers the due date.

**2. `reviewIntervalForStatus` bypasses all caps, so two learner-visible surfaces can disagree on the same concept's interval**

`packages/core/src/scheduling.ts:66-68`

**What**: `reviewIntervalForStatus`/`dueDateForStatus` compute the raw FSRS interval with no exam, centrality, hint, miss, or recency caps. `apps/web/lib/viva-session-projection.ts:794` uses it for the in-session verdict label ("Strong · review in 8 days") while `apps/web/lib/viva-display.ts` uses `buildReviewSchedule` with full inputs — the schedule view can say "in 3 days" (centrality cap) for the same concept in the same session.

**Why it matters**: Inconsistent intervals across surfaces read as a bug to learners and make the "core is the single scheduling authority" claim only half-true.

**Fix**: Either route the verdict label through `scheduleConceptReview` with whatever inputs the projection has, or rename/document `reviewIntervalForStatus` as an uncapped status-only estimate and keep it out of learner-facing copy.

**3. `@viva/tokens` is an unconsumed second source of truth for the palette; CSS variables are hand-duplicated**

`packages/tokens/src/index.ts:1-32`

**What**: `vivaColors`/`vivaRadii`/`vivaTypography` are imported by nothing except their own tautological test (the only other references are a comment in `apps/web/app/layout.tsx:16`, the dependency entry, and `transpilePackages`). The real styling authority is the hand-written `:root` block in `apps/web/app/globals.css` (`--plum: #7a5ba6` etc., values verified identical), and `@viva/ui-web` references `var(--plum)` strings, not the tokens.

**Why it matters**: A palette change in `globals.css` silently strands the tokens package (or vice versa); the test provides zero drift protection. For a repo just made public, an authoritative-looking tokens package that is actually decorative misleads contributors.

**Fix**: Generate the `:root` custom-property block from `@viva/tokens` at build time, or add a test that parses `globals.css` and asserts each `vivaColors` entry matches its variable; alternatively delete the package until it has a consumer.

**4. Demo fixtures and a fake evaluator are exported from the same entry point as production contracts**

`packages/core/src/index.ts:190-564`

**What**: `@viva/core`'s root export mixes the protocol mirror, FSRS authority, and learner-loop contract with prototype-only material: `seedStudySets` (line 210), `sampleQuestion` (line 190), `evaluateAnswer` (line 460, keyword matching against `sampleQuestion.expectedTerms`), and `buildSessionRecap` hardcoding the persona greeting "Good session, Ananya." (line 520). Nothing in naming or module structure distinguishes trusted contract code from demo scaffolding.

**Why it matters**: Post-public-release, `evaluateAnswer` looks like a real evaluation API — a consumer wiring it into a non-fixture path would produce fabricated grading, precisely what the learner-loop contract's no-invented-feedback rules forbid.

**Fix**: Move seed/demo material to a subpath export (e.g. `@viva/core/fixtures`) or prefix the exports (`demoEvaluateAnswer`), and add doc comments marking them local-preview-only.

**5. Secondary action silently reuses the primary action's intent, and the derived contract is only shallowly frozen**

`packages/core/src/learner-recovery-copy.ts:68-71`

**What**: `recoveryCopyEntry` builds `secondary_action` from `state.copy.next_action_label` paired with `state.copy.primary_action_intent` — the source contract has no secondary intent field, so both actions get the same intent by construction. `Object.freeze` at line 84 is shallow (`states` entries remain mutable), and `VIVA_LEARNER_LOOP_CONTRACT` itself (`learner-loop-contract.ts:215`) is not frozen at all, so a consumer can mutate the validated-once contract after import.

**Why it matters**: The schema cannot express a secondary action with a different intent, so any future state needing one will be silently mis-wired; post-validation mutation of the shared contract object would bypass the import-time validation guarantees.

**Fix**: Add an explicit secondary intent field to `LearnerLoopCopy` in JSON+TS, and deep-freeze both exported contract objects.

**6. Redundant `durability_degraded` union arm and validator entry indicate a stale sync assumption**

`packages/core/src/learner-loop-contract.ts:78-81`

**What**: `LearnerLoopTerminalReason` is `AgentTerminalSessionReason | VivaPreLoopTerminalReason | "durability_degraded"`, and `knownTerminalReasons` (lines 158-162) re-adds `"durability_degraded"` — but it is already a member of `VIVA_AGENT_TERMINAL_SESSION_REASONS` (`agent-contract.ts:56`). Both additions are dead.

**Why it matters**: Harmless today, but it suggests the two files were synced at different times; the redundant arm masks whether `durability_degraded` was intended as a learner-loop-only reason, which matters the next time the agent enum changes.

**Fix**: Delete the extra union member and the duplicate set entry.

**7. Frame-size limit constants are mirrored but never enforced client-side; tool types are dead exports**

`packages/core/src/agent-contract.ts:4-5`

**What**: `VIVA_VOICE_MAX_TEXT_FRAME_BYTES` / `VIVA_VOICE_MAX_BINARY_FRAME_BYTES` mirror `protocol.rs` but no TS code consumes them — `apps/web/lib/viva-agent-client.ts:806-817` sends frames via `socket.send(JSON.stringify(...))` with no size pre-check, so an oversized frame is discovered only as a server-side close. `AgentToolProposal`/`AgentToolResult` (lines 118-127) are likewise exported but unused, since `tool_result` client frames are deliberately rejected (line 411-412).

**Why it matters**: An oversized typed answer or audio frame turns into an opaque websocket disconnect instead of a graceful client-side error; unused tool types imply a browser tool channel the contract explicitly forbids, confusing readers about the trust boundary.

**Fix**: Enforce the byte limits in the client send helpers with a typed error, and either delete the tool types or comment them as server-internal mirror documentation.

**8. Malformed error frames and passthrough of unknown event fields produce misleading diagnostics**

`packages/core/src/agent-contract.ts:303-307`

**What**: For type `error` with a non-string `message`, `parseVivaServerFrame` falls through to the generic "Unknown Viva voice server frame" error instead of naming the bad field. Separately, most `parseVivaServerEvent` branches validate a subset of fields and then return `event as VivaServerEvent`, passing any extra server-sent keys through to the browser unfiltered — only `manuscript_intent` is strictly reconstructed with `requireOnlyKeys`.

**Why it matters**: The misleading error message costs debugging time on the most failure-prone frame type; the passthrough asymmetry means the no-raw-provider-payload guarantee rests entirely on the Rust serializer never adding fields, not on the TS boundary that claims to enforce it.

**Fix**: Give the error-frame branch its own "Invalid error frame message" throw, and consider reconstructing the other event types field-by-field (as `manuscript_intent` already does) or stripping unknown keys.

## Verification notes

No findings were refuted or downgraded; all eleven were confirmed against source. Notes from verification:

- F1 was confirmed at the library level, not just by reading the call site: ts-fsrs 5.4.1's `createEmptyCard` yields `state: New, last_review: undefined`, `AbstractScheduler.init()` sets `elapsed_days = 0` for New cards, and `LongTermScheduler.newState` re-zeros elapsed days and derives `due` from the review time — so `createdAt` cannot affect the schedule.
- F2's live-path claim was verified end-to-end: seeded label "Exam Friday" (`packages/core/src/index.ts:215`) → `examDateFromLabel` (`apps/web/lib/viva-display.ts:238`) can yield exams up to 7 days out, outside the 3-day cap window and inside the ~8-day strong interval.
- F3 was kept as written with one correction: `learner-loop-contract.test.ts:77-78` does assert `learner_safe === true` for every state, so that specific sub-claim is test-covered (though still absent from the runtime validator); `primary_action_intent` and `sanitized_evidence` are genuinely unchecked anywhere.
- F6 briefly looked contradicted by a `@viva/tokens` grep hit in `apps/web/app/layout.tsx`, but the reference is a comment only; the finding stands.
- The recommendation about `docs/learner-loop-contract.md` staleness was verified: its evidence-field list jumps from `latency_ms` to `usage`, omitting `retry_after_ms`, `retry_after_source`, `reset_hint`, and `budget_state`, which the JSON contract and `VIVA_LEARNER_LOOP_EVIDENCE_FIELDS` require.

## Recommendations

1. Persist per-concept FSRS card state (stability/difficulty/last_review) in the durable store and thread it into `scheduleConceptReview` so intervals grow across sessions; until then, document first-review-only scheduling in the module docstring so the limitation is a stated design choice rather than a surprise (Important 1).
2. Extend the exam cap to any future exam whose date precedes the FSRS due date, and add scheduling tests for exams 4-8 days out (Important 2).
3. Close the validator gaps in `validateLearnerLoopContract` (authority, resolution_kind, primary_action_intent, literal-true fields) — or replace the hand-rolled validator with a zod/valibot schema that also replaces the unchecked `as LearnerLoopContract` cast (Important 3).
4. Update `docs/learner-loop-contract.md`: its evidence-field list omits `retry_after_ms`, `retry_after_source`, `reset_hint`, and `budget_state`, which the JSON contract and `VIVA_LEARNER_LOOP_EVIDENCE_FIELDS` now require.
5. Have the release-gate scripts (`scripts/rollback-drain-criteria.mjs`, `live-provider-failure-matrix.mjs`, `hosted-e2e-matrix.mjs`, `provider-failure-observability.mjs`) validate the JSON they import — e.g. run `validateLearnerLoopContract` via a small bun entry — instead of trusting the raw file.
6. Wire `@viva/tokens` into `globals.css` (generation or parity test) or remove it; also consider validating `smoke_terminal_reasons` values in the contract against the strings the failure-matrix scripts expect (Minor 3, Important 3).
7. Split demo fixtures out of `@viva/core`'s root export into a `/fixtures` subpath so the public package surface only advertises production contracts (Minor 4).
8. In `@viva/ui-web`, move `react` to `peerDependencies` (it is currently a regular dependency pinned to 19.2.3) and either co-locate the component CSS with the package or document that `apps/web/app/globals.css` is a required companion stylesheet.

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first-pass review; verification confirmed every finding without refutation or downgrade).

This is a carefully engineered contract layer with genuinely strong cross-language drift protection: the TS protocol mirror is fixture-tested against the same JSON the Rust service round-trips, terminal reasons match `protocol.rs` exactly, and the learner-loop/recovery-copy contracts are import-time validated with rigorous sanitization tests. The three important fixes are real but bounded — the FSRS scheduler quietly discards memory state between reviews and carries an inert `lastReviewedAt` parameter, the 3-day exam cap leaves a live 4-8-day gap where a strong concept's review lands after its exam, and the learner-loop validator leaves several enum fields covered by neither runtime validation nor the unchecked JSON cast. The remaining minors are maintainability polish appropriate to address after the public-release milestone.
