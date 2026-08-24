# Code Review: Architecture, contracts, and consistency

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | Entire repo, prioritizing: agent/crates/agent-service/src/protocol.rs vs packages/core/src/agent-contract.ts vs apps/web/lib/viva-agent-client.ts, packages/core/src/learner-loop-contract.{json,ts} vs docs/learner-loop-contract.md, turbo.json, package.json scripts vs .github/workflows/validate.yml, tsconfig.base.json, biome.json, agent/Cargo.toml workspace, README.md and docs/ vs actual code, docs/superpowers/plans+specs vs shipped reality |
| **Verdict** | sound-with-fixes |
| **Confidence** | High for source/configuration consistency findings |

This area covers the three-layer voice protocol (Rust `protocol.rs`, TS mirror in `packages/core`, browser client), the learner-loop contract, build/CI configuration, and the public-facing documentation's claims against what the code actually does. The contract machinery is genuinely strong — shared byte-exact fixtures keep the Rust and TS protocol representations honest, and enum vocabularies match line-for-line across all three layers. Adversarial verification confirmed all three important findings from the first pass: persisted review due dates are hardcoded June-2026 constants that contradict the README's central FSRS claim, the advertised domain-purity gate checks a different property than the one two top-level docs promise, and the authentication-carrying first frame is absent from the module the README names as the protocol's source of truth. All eleven findings survived verification; one minor finding (turbo env hashing) was narrowed because turbo's framework inference covers the `NEXT_PUBLIC_*` variables.

## Strengths

- Cross-language contract enforcement is real, not aspirational: the JSON fixtures in `agent/fixtures/voice-protocol/` are consumed byte-for-byte by both the Rust tests (`agent/crates/agent-service/src/protocol.rs:410-672`, which assert the synthetic and fake_cartesia_gemini runtimes reproduce the fixture frame streams exactly) and the TS mirror tests (`packages/core/src/agent-contract.test.ts:2-11`). Drift between protocol.rs and agent-contract.ts cannot pass CI silently for anything the fixtures cover.
- Enum parity across the three protocol layers is exact where it matters: all 16 `TerminalSessionReason` variants (`agent/crates/agent-domain/src/study.rs:19-36` vs `packages/core/src/agent-contract.ts:42-59`), the 6 session phases, the 7 evaluation labels, and the manuscript-intent tag names all match, verified line-by-line.
- Infrastructure config is under test, which is rare: `scripts/deployment-runbook.test.mjs:273-312` asserts railway.json, Dockerfile.monitor (whose playwright image pin matches the bun.lock-resolved playwright version), and agent/Dockerfile contents; `scripts/validate-workflow.test.mjs` pins the CI workflow's gates and evidence-artifact paths. CI (`.github/workflows/validate.yml`) runs a strict superset of what `package.json` `validate` promises.
- The learner-loop contract is a genuine single source of truth: `packages/core/src/learner-loop-contract.ts:136-217` validates the JSON at import time (duplicate state ids, terminal-reason vocabulary, exhaustive runtime-copy-cause coverage, per-state resolution bounds against the 45s outer bound), and `docs/learner-loop-contract.md:3-6` explicitly defers to it rather than duplicating the state table.
- The server-authoritative boundary is enforced in code on both sides: `sanitize_client_session_config` (`agent/crates/agent-service/src/ws.rs:3077-3103`) strips browser-supplied `source_context`/`active_concepts` and binds identity to the verified token claims; browser `tool_result` frames are rejected by the server (`ws.rs:2963`) and by the TS mirror parser (`packages/core/src/agent-contract.ts:411-412`); the bearer subprotocol format (`bearer.<base64url>`) matches exactly between `apps/web/lib/viva-agent-client.ts:371-374` and `agent-service/src/config.rs:961-970`.
- Repo hygiene for a fresh public release is clean: `scripts/check-generated-artifact-hygiene.sh` enforces that generated paths are gitignored and untracked, and every script in `scripts/` is cross-referenced by a gate, runner, or test.

## Findings

### Important

**1. Persisted review due dates are hardcoded June-2026 constants, contradicting the documented FSRS architecture**

`agent/crates/agent-domain/src/tool_executor.rs:339-346`

**What**: `storage_due_at_for_status()` returns fixed literals (`"2026-06-18T09:00:00Z"` … `"2026-06-24T09:00:00Z"`) regardless of when the session runs; a second copy of the same table lives in `agent/crates/agent-adapters/src/synthetic.rs:808`. `schedule_review_item` (tool_executor.rs:229-252) rejects a client-supplied `due_at` with the message "@viva/core computes review dates" and then persists these constants verbatim through both stores (`agent/crates/data/src/postgres.rs:2192-2225` binds the string into `review_items.due_at`), and the web library renders them with authority `"server_persisted"` (`apps/web/lib/viva-library.ts:403-428` → "due Jun 18, 2026"). README.md:114 claims "`schedule_review_item` sets the return date with FSRS via `ts-fsrs`. Scheduling authority lives in `packages/core`: one implementation, shared by client and agent" — but the agent never touches the FSRS implementation; `packages/core/src/scheduling.ts` is only consumed client-side for display.

**Why it matters**: The live `cartesia_gemini` runner routes its `schedule_review_item` proposals through this same executor (`agent/crates/agent-adapters/src/cartesia_gemini/runner.rs:842`), so every review item written by any provider gets a due date that is already in the past as of today. The durable store and library "next review" surface show stale dates, and the "missed Tuesday, asked again Thursday" product promise (README.md:66-68) is not implemented on the persisted path. There are effectively two scheduling authorities (client FSRS vs server fixture constants) where the docs promise one.

**Fix**: Give the tool executor a clock/scheduling port (keeping agent-domain pure) and compute `due_at` from the concept status at execution time — either a Rust mirror of the core day-offset policy with a shared fixture test, or persist only (status, graded_at) and derive due dates in one place at read time. Update README.md:114 to describe what actually ships.

**2. The advertised "domain purity (no I/O)" gate actually checks something else entirely**

`scripts/check-agent-domain-purity.sh:9-15`

**What**: README.md:175-176 ("The domain crate holds no I/O at all, and a purity gate in CI keeps it that way") and CONTRIBUTING.md:50,60 ("`bun run agent:purity` — asserts agent-domain stays I/O-free … enforces this") describe an I/O-purity gate. The script only greps agent/packages/apps for Chef-Luca vocabulary residue (`LUCA_`, recipe, ingredient, allergen, pantry, fridge, cook…) left over from the repo's prior life. Nothing enforces the no-I/O property: agent-domain's Cargo.toml pulls in the full workspace tokio (`macros`, `rt-multi-thread`, `signal`, `sync`, `time` per `agent/Cargo.toml:38`), so an I/O call added to agent-domain would pass every gate. The `-g '!docs/superpowers/plans/**'` exclusion is also dead since docs/ is not among the searched paths.

**Why it matters**: A public repo's two top-level docs make a specific architectural guarantee ("a gate keeps it that way") that no gate implements. Outside contributors who trip the gate get a baffling "Luca domain residue" error for words like "recipe" or "cook"; contributors who add I/O to the domain crate get no error at all.

**Fix**: Add a real purity check (e.g. assert agent-domain's dependency list contains no I/O-capable crates/features — a small script over `cargo metadata`, or restrict its tokio features to sync only) and rename the residue grep to what it is; fix the CONTRIBUTING/README wording to match.

**3. The authenticated first-frame shape (session_token) is absent from the canonical protocol module**

`agent/crates/agent-service/src/ws.rs:3211-3221`

**What**: `session_token` exists only in the private `InitialClientFrame` struct in ws.rs and in the TS mirror (`packages/core/src/agent-contract.ts:163-169`, `sessionConfigFrame` at :259-274). `protocol.rs` — which the README presents as the voice protocol's source of truth — defines `ClientFrame::SessionConfig` (protocol.rs:17-23) without `session_token`. Consequently a mid-session `session_config` refresh carrying `session_token` is silently accepted with the token discarded (serde ignores unknown fields on the internally-tagged enum, ws.rs:2911-2925). Similarly, the shipped client attaches `client_generation_id` to every outgoing frame including cancel/stop (`apps/web/lib/viva-agent-client.ts:806-817` — `sendFrame` wraps all frames in `withClientGeneration`), which the Rust `Cancel`/`Stop` variants (protocol.rs:40-45) silently drop, so protocol.rs cannot round-trip what the shipped client actually sends.

**Why it matters**: The repo's stated source of truth for the wire contract is incomplete on the one field that carries authentication. A client author reading protocol.rs would build a client that cannot connect to a production (signed-token) deployment, and the real initial-frame contract lives in a private struct with no fixture coverage.

**Fix**: Add `session_token: Option<String>` (skip_serializing_if) to `ClientFrame::SessionConfig` in protocol.rs, make `initial_session_config_from_message` use the typed frame instead of a parallel struct, add `client_generation_id` to Cancel/Stop for round-trip fidelity, and extend the voice-protocol fixtures with a signed session_config example.

### Minor

**1. Dead ReadyFrame struct duplicates ServerFrame::Ready and can drift silently**

`agent/crates/agent-service/src/protocol.rs:61-89`

**What**: `ReadyFrame` (with its `new()`/`Default` impls) is defined here and re-exported from lib.rs:17, but nothing in the workspace uses it — every ready emission goes through `ServerFrame::ready()`/`ready_with_capabilities()`. It duplicates the ready payload field-for-field and is not covered by the fixture-equality tests.

**Why it matters**: A second, unexercised representation of the handshake frame is exactly the kind of mirror this codebase otherwise works hard to eliminate; if the ready payload changes, ReadyFrame drifts without any test failing.

**Fix**: Delete ReadyFrame and its lib.rs re-export, or repoint it as the single struct that `ServerFrame::Ready` wraps.

**2. Session-token format implemented twice (TS and Rust) with no shared cross-language test vector**

`apps/web/app/api/viva-session/shared.ts:747-801`

**What**: `verifySessionTokenClaims` re-implements the `viva1.<claims>.<sig>` HMAC-SHA256/base64url format that `agent-service/src/config.rs:808-852` (`SessionTokenClaims::verify_at`) defines, and `signVivaSessionBootstrapToken` (shared.ts:276-297) mints tokens in the same shape. Each side's tests mint tokens with its own implementation; unlike the voice protocol, there is no shared fixture under `agent/fixtures/` that both suites must parse (only `voice-protocol/` exists).

**Why it matters**: This is the security-critical boundary between web and agent, and the implementations already differ at the margins — Rust has `#[serde(deny_unknown_fields)]` on claims (config.rs:783) while TS ignores extras, and Rust's `URL_SAFE_NO_PAD` rejects padded base64url while Node's `Buffer` tolerates it. A format change on either side keeps both CI suites green while breaking session refresh in production, fail-closed but user-visible.

**Fix**: Add a session-token fixture (secret + token + expected claims, clearly-fake values) consumed by both the Rust config.rs tests and the TS shared.ts tests, mirroring the voice-protocol fixture pattern.

**3. README and contract-index docs use enum vocabularies that don't exist in the contract**

`README.md:113`

**What**: README.md:113 and :206 say `mark_concept_status` records "known, shaky, or missed"; the actual contract is `strong | shaky | missed | review` (`packages/core/src/agent-contract.ts:8`; `agent/crates/agent-domain/src/brain.rs`) — "known" is not a value and "review"/"strong" are omitted. Separately, `docs/learner-loop-contract.md:29-41` lists 11 evidence fields while the JSON/TS contract has 15 (`retry_after_ms`, `retry_after_source`, `reset_hint`, `budget_state` missing from the doc; `packages/core/src/learner-loop-contract.ts:48-64`).

**Why it matters**: These are the exact vocabularies the repo elsewhere treats as fail-closed contracts; a public reader or integrator copying "known" from the README writes a value every validator rejects.

**Fix**: Correct README lines 113/206 to strong/shaky/missed(/review) and refresh the evidence-field list in docs/learner-loop-contract.md (or replace it with a pointer plus count so it can't drift again).

**4. turbo build task declares no outputs, and the unprefixed static-export flag is outside the hash**

`turbo.json:55-57`

**What**: The build task is only `{"dependsOn": ["^build"]}`: no `outputs`, so a cache hit skips `next build` without restoring `.next`/`out`. Of the env vars that alter the built artifact, the `NEXT_PUBLIC_*` ones (`NEXT_PUBLIC_VIVA_STATIC_EXPORT`, `NEXT_PUBLIC_VIVA_AGENT_HTTP_URL`) are covered by turbo 2.x framework inference for Next.js tasks, but the unprefixed `VIVA_STATIC_EXPORT` — read in `apps/web/next.config.ts:6-7` to flip `output:"export"` — is hashed nowhere (`turbo.json:4-46` lists ~40 other vars).

**Why it matters**: Locally, `VIVA_STATIC_EXPORT=1 bun run build` after a normal build can hash to the same key and replay the cached (non-export) result, i.e. do nothing. CI is unaffected (fresh runners), but the cache is unsound for exactly the switch the code supports.

**Fix**: Declare outputs for the web build (`[".next/**", "!.next/cache/**", "out/**"]`) and add `VIVA_STATIC_EXPORT` to `globalEnv` (or a per-task `env` for the web build).

**5. Workspace crate metadata says UNLICENSED in an Apache-2.0 public repo**

`agent/Cargo.toml:13`

**What**: `[workspace.package] license = "UNLICENSED"` is inherited by all five crates, while the repo ships an Apache-2.0 LICENSE, an Apache badge (README.md:9), and CONTRIBUTING.md stating contributions are Apache-2.0.

**Why it matters**: Anyone vendoring or auditing the crates sees contradictory licensing metadata; "UNLICENSED" is also not an SPDX identifier cargo recognizes without warning.

**Fix**: Set `license = "Apache-2.0"` in `[workspace.package]` (`publish = false` can stay).

**6. Client never enforces the frame-size limits the contract exports**

`apps/web/lib/viva-agent-client.ts:806-817`

**What**: `VIVA_VOICE_MAX_TEXT_FRAME_BYTES` / `VIVA_VOICE_MAX_BINARY_FRAME_BYTES` (`packages/core/src/agent-contract.ts:4-5`) are consumed nowhere in apps/web: `sendFrame` serializes and sends unconditionally, while the server hard-closes the socket on oversize (`ws.rs:2907-2910`, 2975-2977).

**Why it matters**: A pathological but possible input (a very long pasted text answer) terminates the whole session with a close frame instead of a client-side validation error, even though the constants exist in the shared contract precisely to prevent that.

**Fix**: Check the serialized frame length against the shared constants before sending and surface a learner-safe error (or chunk audio) instead.

**7. Wildcard path mapping permits deep imports the package exports map forbids**

`tsconfig.base.json:18`

**What**: `"@viva/core/*": ["packages/core/src/*.ts"]` lets `import ... from "@viva/core/scheduling"` typecheck, but `packages/core/package.json` exports only `"."`, so such an import fails at runtime resolution. No current code deep-imports (verified by grep), so this is a latent trap only.

**Why it matters**: The first contributor who follows the compiler's acceptance of a deep import gets a runtime-only failure — the sort of typecheck/runtime split the strict config otherwise avoids.

**Fix**: Drop the `"/*"` mapping, or add matching subpath exports to the package.

**8. Static-export mode is a shipped branching code path with no consumer, gate, or documentation**

`apps/web/next.config.ts:6-7`

**What**: `VIVA_STATIC_EXPORT` / `NEXT_PUBLIC_VIVA_STATIC_EXPORT` flip `output:"export"`, asset prefixing, header behavior, and the library proxy base-url selection (`apps/web/lib/viva-agent-client.ts:546-564`). Grep across scripts/, .github/, and docs/ finds nothing that sets these flags; the deployment runbook describes only the server topology. Only unit tests touch the flag.

**Why it matters**: An undocumented, un-gated build mode that changes routing and API-base resolution will rot: app/api routes coexisting with `output:"export"` is exactly the kind of combination that breaks silently on a Next upgrade with nothing in CI to notice.

**Fix**: Either document the static-export deployment path in docs/deployment-runbook.md and add a CI/e2e leg that builds with the flag, or delete the mode.

## Verification notes

No findings were refuted. All three important findings were confirmed by direct code inspection, including the load-bearing details: F1's hardcoded dates flow through the live `cartesia_gemini` runner (runner.rs:842) into postgres and out to the library UI as `server_persisted`; F2's script contains only the Luca-vocabulary grep while agent-domain's Cargo.toml pulls full-featured tokio; F3's `sendFrame` was confirmed to wrap every frame — including cancel/stop — in `client_generation_id` (viva-agent-client.ts:817, corrected from the first pass's citation of :951-953, which is the `withClientGeneration` helper itself). One minor was narrowed: the first pass claimed three env vars were missing from turbo's hash inputs, but turbo 2.x framework inference auto-includes `NEXT_PUBLIC_*` variables for Next.js tasks, so only the unprefixed `VIVA_STATIC_EXPORT` (and the missing `outputs`) survive. Minors 1, 2, 3, 5, 6, 7, 8 were spot-checked and held (ReadyFrame genuinely unused; only voice-protocol fixtures exist; `deny_unknown_fields` present on the Rust claims; frame-size constants unreferenced in apps/web; exports map is `"."` only; static-export flags set nowhere).

## Recommendations

- Extend the shared-fixture pattern (`agent/fixtures/voice-protocol`) to the two remaining cross-language surfaces: the signed session token (Minor 2) and a signed session_config initial frame (Important 3) — it is the repo's proven mechanism for making drift impossible.
- Unify client-frame parsing in the agent on the typed protocol.rs enum by folding `session_token` into `ClientFrame::SessionConfig`, retiring the parallel `InitialClientFrame` struct, and deleting the dead `ReadyFrame` mirror.
- Resolve the scheduling-authority split: either implement real due-date computation behind a domain port and make the persisted date authoritative, or stop persisting placeholder dates and derive due dates exclusively in packages/core at read time — then make README's FSRS claim match.
- Replace or supplement the Luca-residue grep with a machine-checked no-I/O assertion on agent-domain (dependency allow-list over `cargo metadata`), since two top-level docs promise that gate exists.
- Add a small docs-vs-contract consistency test (like validate-workflow.test.mjs) that asserts README/docs enum vocabularies (concept statuses, evidence fields) against the exported constants, so public-facing prose can't drift from the typed contract.
- Tighten turbo.json for local correctness: declare build outputs and add `VIVA_STATIC_EXPORT` to the hash inputs; consider moving the e2e-only vars from globalEnv into task-scoped env to reduce needless cache invalidation.
- Fix the crate license metadata to Apache-2.0 before the crates are read as part of the public release.

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first pass — verification confirmed every finding rather than weakening the case). The contract machinery at the heart of this area is exceptional: three protocol representations kept honest by shared byte-exact fixtures, exact enum parity, infra config under test, and a fail-closed learner-loop contract validated at import time. The confirmed important findings are drift at the edges rather than structural failure, but all three touch public promises — the README's FSRS scheduling claim, the advertised purity gate, and the protocol module's completeness on the authentication field — and all are contained fixes that the existing fixture-test patterns make straightforward.
