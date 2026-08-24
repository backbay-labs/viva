# Viva quality and tests review — 2026-08-23

**Scope:** Local and hosted gates, test selection, release evidence, developer environment isolation, maintainability, and documentation truth.  
**Overall confidence:** High.

## Findings

| ID | Priority | Finding | Confidence |
| --- | --- | --- | --- |
| QLT-01 | P1 | Exact remote `main` is red, while `main` has no protection or ruleset | High |
| QLT-02 | P1 | No browser-to-agent E2E covers a normal live microphone answer | High |
| QLT-03 | P1 | Postgres validation is manual-only and otherwise silently skipped | High |
| QLT-04 | P1 | Dependency vulnerability audits are not gates | High |
| QLT-05 | P2 | Release-check provider children inherit developer/production auth configuration | High |
| QLT-06 | P2 | Hosted monitor deadline test is incompatible with the hosted Node 24 runtime | High |
| QLT-07 | P2 | Loopback WS tests can return as passing after permission-denied skip | High |
| QLT-08 | P2 | Gate/documentation claims do not match scheduling and purity implementations | High |
| QLT-09 | P2 | Oversized modules make review and mutation isolation expensive | High |
| QLT-10 | P3 | No explicit coverage/mutation threshold exists | High |

## What is solid

- The repository has one broad local command covering TS typecheck/lint/test/build, Rust fmt/clippy/test/build, residue hygiene, and artifact hygiene.
- Forced local TS validation passed 16/16 tasks with zero cache use.
- Approximately 978 package/script/Rust tests passed locally, plus real WebSocket replay and Chromium E2E.
- Rust clippy is run with `-D warnings`; workspace forbids unsafe code and denies `todo`/`dbg_macro`.
- Protocol fixtures cover synthetic/fake providers, source authority, replay, terminal reasons, capacity, drain, and malformed frames.
- Redaction tests include positive and negative controls and audit artifacts structurally.
- Browser E2E checks URL token lifecycle, source folio, correction, recap, session cap, console errors, page errors, and forbidden evidence.
- Live provider execution is deliberately hard to enable and can be tested without paid network through deterministic fake/gate paths.

## QLT-01 — P1 — Hosted release state is red and unenforced

GitHub Validate run `31401218406` failed on the exact reviewed `main` SHA. Only checkout/setup/install/redaction completed; WebSocket replay, browser E2E, release evidence, and artifact upload were skipped after the validation step failed.

GitHub's branch-protection endpoint returned 404 “Branch not protected,” and repository rulesets were empty. A direct push can therefore advance `main` with failed or absent checks.

**Remediation:** Fix QLT-06, rerun the full workflow on the exact SHA, then require the validation job through branch protection/rulesets. Protect administrators unless a documented break-glass path exists. Require exact-head evidence for release.

## QLT-02 — P1 — The test graph misses the primary transport

The browser's live path buffers Worklet PCM and sends one complete base64 frame. Tests verify capture chunking, merging four bytes, controller sending a tiny payload, and server rejection of oversized frames separately. No test composes them.

Synthetic browser E2E uses written fallback; the fixture `client-audio.json` is only 87 bytes. This is why 978 passing tests coexist with COR-01.

**Remediation:** Add a production-shaped test with fake media input and a real WebSocket server. Assert serialized frame sizes stay bounded throughout a 45-second answer, end-of-turn is explicit, transcript/evaluation arrives, and cancellation/backpressure work. Include a negative control that the pre-fix single-frame implementation fails.

## QLT-03 — P1 — Durable behavior is not continuously proven

The `durable` GitHub job has `if: github.event_name == 'workflow_dispatch'`. Normal `cargo test` calls optional Postgres tests, but each returns early when `DATABASE_URL` is missing. That means seed-on-boot, migrations, atomic replay guards, deletion, UUID translation, and parity can regress on every PR without a red check.

**Remediation:** Make a Postgres 16 job required on `main` and on changes to data/service/migrations; run a broader nightly matrix if PR latency matters. A skipped required environment must report “skipped/not proven,” never green.

## QLT-04 — P1 — Audits are outside the acceptance loop

Both `bun audit` and `cargo audit` fail on the reviewed lockfiles, while `bun run validate` passes. See SEC-02.

**Remediation:** Add audit commands and lockfile-policy tests to CI. Prune unused SQLx database drivers before waiving the unpatched RSA advisory.

## QLT-05 — P2 — Release harness is environment-sensitive

`dev-agent.mjs` clears inherited session/WS secrets for the no-key path. `release-check.mjs` spawns provider-readiness agents with `{ ...process.env, ...target.env }`. In a normal developer environment containing signed-session configuration, the synthetic child rejects its in-memory store and exits. The default release check reproduced this failure twice; a sanitized no-secret environment passed.

This is more than inconvenience: evidence generation depends on ambient state the command claims not to need.

**Remediation:** Build an explicit allowlisted environment for every child, clearing auth, database, provider, failure-control, and deployment variables unless the target specifies them. Add a test that seeds hostile inherited values and proves isolation.

## QLT-06 — P2 — An unref'ed deadline broke hosted Node 24

`putS3Object` creates the abort deadline timer and calls `timeout.unref?.()` (`scripts/hosted-monitor-runner.mjs:1002-1004`). The hosted test replaces fetch with a promise that only rejects when aborted. With no referenced handle, Node 24 ends the test event loop before the deadline fires, canceling tests 82–84. Local Node 25.5 behaves differently.

**Remediation:** Do not unref a correctness-critical publication deadline. Pin and test the supported Node version locally/CI; add a matrix only if multiple versions are intentional.

## QLT-07 — P2 — A skipped network test looks passed

Root `agent:test` always sets `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1`. In `voice_ws.rs`, `spawn_server` returns `None` on `PermissionDenied`, and callers return from the test. The harness reports an ordinary pass, not ignored/skipped. CI has a separate replay gate, but the latest hosted run failed before reaching it.

**Remediation:** Emit explicit skip accounting or split network tests into a required job whose environment supports loopback. Never let environmental inability count as executed proof.

## QLT-08 — P2 — Controls are described more strongly than implemented

Examples:

| Claim | Actual control |
| --- | --- |
| `agent:purity` keeps domain I/O-free | Greps for legacy cooking/Luca vocabulary |
| `@viva/core` is shared scheduling authority | Rust persists fixed June timestamps; browser computes separate FSRS |
| PDF upload produces a source-grounded set | Lossy UTF-8 conversion of PDF bytes |
| Four study modes | Mounted session always sends quiz |

**Remediation:** Treat docs as executable contracts: add tests around critical claims or weaken the claim. Stamp vision/requirements documents separately from shipped behavior.

## QLT-09 — P2 — Test density does not neutralize module concentration

Large service/provider/store/CSS files make narrow review difficult and cause unrelated behavior to share mutable context. The 11k-line integration test file is evidence-rich but hard to map to invariants.

**Remediation:** Extract modules around authority boundaries and build shared store conformance suites. Do not perform a mechanical split without characterization tests.

## QLT-10 — P3 — No quantitative fault-injection threshold

There is no coverage or mutation threshold. A repo-wide line-coverage percentage would be low-value given scripts/fixtures; a focused mutation/differential gate would be useful for token verification, frame sizing, store replay, scheduler authority, and redaction.

**Remediation:** Add targeted mutation tests or property tests for critical pure boundaries. Require at least one adversarial negative control for every release claim.

## Evidence hierarchy

Use this order when making release claims:

1. Exact hosted SHA with required protected checks.
2. Production-shaped browser-to-service flow.
3. Durable Postgres proof on the combined tree.
4. Live provider proof with bounded sanitized evidence.
5. Local full validation.
6. Unit/fixture proof.

Lower levels cannot substitute for a missing higher acceptance gate.
