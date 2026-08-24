# Code Review: Release-gate and evidence scripts

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | scripts/release-check.mjs(+test), scripts/production-release-gate.mjs(+test), scripts/release-evidence-imports.mjs(+test), scripts/redaction-control.mjs, scripts/redaction-control-check.mjs, scripts/redaction-control.test.mjs, scripts/rollback-drain-criteria.mjs(+test), scripts/failure-control-harness.mjs(+test), scripts/deployment-runbook.test.mjs, scripts/validate-workflow.test.mjs, scripts/check-generated-artifact-hygiene.sh, scripts/check-agent-domain-purity.sh |
| **Verdict** | sound-with-fixes |
| **Confidence** | High |

This area is the release-evidence pipeline: `release-check.mjs` orchestrates the proof commands and assembles a sanitized evidence bundle, `production-release-gate.mjs` decides whether that bundle certifies a production release (BAC-526 hardening), `release-evidence-imports.mjs` validates externally produced hosted-monitor and observability artifacts, and the redaction/rollback/harness modules plus two shell gates supply the individual proofs. The machinery genuinely gates in the paths it exercises — fail-closed evidence generation, real tamper tests, precisely scoped redaction allowlists — but adversarial verification confirmed four important gaps where a second layer that is supposed to backstop the first attests nothing: shell gates that fail open when ripgrep is missing, a hardcoded-false BAC-528 proof field, live-smoke evidence unbound to the release deploy identity, and a bundle HMAC that no downstream process ever verifies. One first-pass important finding (a claimed spawn hang) was empirically downgraded to a minor cleanup-bypass defect.

## Strengths

- Fail-closed evidence generation: `scripts/release-check.mjs:291-308` deletes the releasable artifact dir on any failure and writes a quarantined `failure.json` marked `unsafe_to_attach`, so a broken run can never ship a partial bundle; validate.yml only uploads on success with `if-no-files-found: error`.
- Real tamper and staleness tests: `scripts/production-release-gate.test.mjs:33-47` mutates a deploy id inside a finalized bundle and asserts integrity failure; staleness, future-dating, live-deploy mismatch, browser-skip, ephemeral-durability, and fixture-cannot-certify cases all exercise the actual gate logic, not mocks.
- Layered redaction defense: `scripts/redaction-control.mjs` combines structural field detection (including camelCase normalization and compound stems), a marker denylist, an env-secret value scan, and a per-PR diff audit whose allowlist (`SOURCE_AUDIT_SAFE_MARKER_OCCURRENCES`, lines 92-329) is scoped to exact file + line-pattern pairs rather than blanket file exemptions; `scripts/redaction-control.test.mjs` covers both allow and reject sides of nearly every allowlist entry.
- Deploy-identity triangulation: `scripts/production-release-gate.mjs:83-135` and `206-243` require evidence, live, and release deploy ids to all be present and mutually consistent, and `scripts/release-evidence-imports.mjs:59-68` re-checks hosted monitor runs against the release deploy ids before they can populate the recovery matrix.
- Fixture/observation separation: the gate distinguishes dashboard fixture queries from executed observations (`scripts/production-release-gate.mjs:351-379`) and `scripts/production-release-gate.test.mjs` proves fixtures cannot certify provider-failure recovery.
- Rollback thresholds are validated data, not prose: `scripts/rollback-drain-criteria.mjs` cross-checks thresholds against the BAC-510 learner-loop contract states, and the boundary fixture test flips decisions at each concrete threshold including minimum-sample guards.

## Findings

### Important

**1. Shell gates fail open when ripgrep (or git in the pipeline) fails**

`scripts/check-generated-artifact-hygiene.sh:40-55`, `scripts/check-agent-domain-purity.sh:9-14`

**What:** Both hygiene checks capture matches via command substitution with `|| true`: `git ls-files | rg "$pattern" || true` (lines 40-42, 50-55) and the purity gate does the same. If `rg` is not installed (exit 127) or errors for any reason other than no-match, the `|| true` swallows it, the variable is empty, and the gate prints success. `set -eu` cannot help because the failure is explicitly discarded, and in the `git ls-files | rg` pipeline (POSIX sh, no pipefail) a git failure is also masked. Verified: `release:hygiene` runs `sh scripts/check-generated-artifact-hygiene.sh` inside both `bun run validate` and release-check (release-check.mjs:86), and `agent:purity` runs inside `validate:agent` (package.json:19,21,32-33).

**Why it matters:** These are release gates. A missing tool on a dev machine or a slimmed CI image silently converts the gate into a no-op pass — exactly the fail-open mode this area is supposed to prevent. GitHub's ubuntu-latest currently ships rg, so the hole is latent, not active.

**Fix:** Add `command -v rg >/dev/null || { echo "rg is required" >&2; exit 1; }` at the top of both scripts, and replace `|| true` with exit-code discrimination: `rc=0; matches=$(...) || rc=$?; [ "$rc" -le 1 ] || exit "$rc"` so only exit code 1 (no matches) is treated as clean.

**2. BAC-528 gate proof is vacuous: enabled_for_release is hardcoded false**

`scripts/failure-control-harness.mjs:260`

**What:** `failureControlHarnessEvidence()` returns `enabled_for_release: false` unconditionally, even when the passed plan has `enabled: true` (plan state is only used for `selected_scenario` and `per_identity_cap`). The production gate's issue proof `bac_528_harness_disabled` (scripts/production-release-gate.mjs:468) checks `evidence.failure_control_harness?.enabled_for_release === false`, which therefore can never fail. `scripts/failure-control-harness.test.mjs:113-117` even asserts `enabled_for_release` is false for an enabled plan, codifying the vacuousness.

**Why it matters:** The only real protection is the single throw in scripts/release-check.mjs:83-85 (verified present). If that line is refactored away, or any other producer assembles a bundle while the harness is enabled, the gate check labeled `bac528_harness_disabled` passes while attesting nothing. A gate field that self-attests to the safe value is a silently-passing gate.

**Fix:** Set `enabled_for_release: plan?.enabled !== true` (i.e. reflect the actual plan state) in `failureControlHarnessEvidence`, update the test to assert it flips for an enabled plan, and keep the release-check throw as the second layer.

**3. Live-smoke evidence is not bound to the release deploy identity**

`scripts/production-release-gate.mjs:267-322`

**What:** `summarizeLiveSmoke` validates schema, status, provider, budget caps, and 24h freshness, but never reads the `deploy_sha` that live-provider-smoke.mjs writes into its evidence (verified: `scripts/live-provider-smoke.mjs:775,789,851` all emit a top-level `deploy_sha`), and no run-id binding is applied. release-check imports the file via `readOptionalJson` from an operator-overridable path (scripts/release-check.mjs:211,364-371) with no validation at import time.

**Why it matters:** Hosted browser evidence and monitor runs are deploy-id-bound (the core of the BAC-526 hardening), but the artifact that certifies budget caps and durable-store state for production (`budget_capped_live_smoke`, and `postgres_durability` via `live_smoke.readiness.store.durable` at line 436) can come from any environment's smoke run generated in the last 24h — e.g. a staging smoke against different deploys satisfies the production gate.

**Fix:** In `summarizeLiveSmoke` (or a new import validator in release-evidence-imports.mjs), compare `live_smoke.deploy_sha` against the release deploy identity when `production_requested`, and fold the result into `passed_budget_capped`; optionally also enforce `VIVA_RELEASE_RUN_ID` on the smoke evidence.

**4. Bundle signature has no downstream verifier, and verification accepts an unsigned-downgrade when the secret is absent**

`scripts/production-release-gate.mjs:168-204`

**What:** `assertReleaseBundleIntegrity` is only ever called inside `finalizeReleaseEvidenceBundle` (the same process that just built the bundle, line 64) and in tests — verified by grep: no deploy-time script, workflow step, or runbook command re-verifies a stored evidence.json (docs/deployment-runbook.md's only post-hoc check, around line 705, inspects `artifact_audit.forbidden_hits`). Additionally, verification recomputes the expected integrity from the verifier's env: if the verifying env lacks `VIVA_RELEASE_BUNDLE_SIGNING_SECRET`, a tampered bundle re-signed with the keyless `sha256-self` algorithm passes, because lines 193-197 compare algorithms for equality rather than requiring `hmac-sha256`, and `signature_key_present` is never checked. The existing test only exercises verification with the secret present.

**Why it matters:** BAC-526's HMAC only provides tamper resistance if someone verifies a stored bundle with the secret. Today the signature is generated and checked in one process, so it proves nothing beyond self-consistency; and the first naive future verifier that forgets to inject the secret is silently downgradable.

**Fix:** Ship a verifier entry point (e.g. `node scripts/production-release-gate.mjs --verify artifacts/release-check/evidence.json`) that requires the secret, asserts `signature_algorithm === "hmac-sha256"` and `signature_key_present === true` whenever `production_requested`, and reference it from the deployment runbook; add a test that a self-signed bundle is rejected by a production-mode verify.

### Minor

**1. run() has no child 'error' handler, so spawn failures bypass the fail-closed cleanup path**

`scripts/release-check.mjs:390-397`

**What:** `run()` awaits only the `exit` event. When spawn fails (e.g. cargo/bun missing → ENOENT), Node emits `error` and never emits `exit`; with no `error` listener, the EventEmitter throws an unhandled-'error' exception at the event-loop level (verified empirically on Node 25: the process crashes immediately with `Error: spawn ... ENOENT`, exit code 1 — it does not hang, contrary to the first-pass claim). Because the throw happens outside the top-level try/catch, the catch block at lines 291-308 never runs: no quarantined `failure.json` is written and `artifacts/release-check` is left on disk with partial command logs.

**Why it matters:** The gate still fails loudly with a diagnosable message, and the leftover dir contains no `evidence.json`, so nothing can pass the gate — but the fail-closed contract (quarantine record + artifact-dir deletion on every failure) is silently skipped for this failure class. The adjacent `collectProviderReadinessTarget` (lines 440-445) handles the `error` event, showing the pattern is known in this file.

**Fix:** Reject the same promise on `child.once("error", reject)` so the existing catch path records the failure and purges the artifact dir.

**2. provider_gate_tests cargo run is duplicated and clobbers its own logs**

`scripts/release-check.mjs:117-126,137-146`

**What:** The identical `run("provider_gate_tests", "cargo", [..."fake_provider"...])` invocation appears twice. Both write to `artifacts/release-check/provider_gate_tests.{stdout,stderr}.log`, so the second run overwrites the first run's logs while the evidence `commands` array records two entries pointing at one log pair.

**Why it matters:** It wastes a full cargo test cycle on every release check, and it produces misleading evidence (two command records whose cited logs are only the second execution). rollback-drain-criteria.test.mjs explicitly guards against this exact clobbering pattern for the drain proofs, but nothing guards the provider gate commands.

**Fix:** Delete the second block (lines 137-146). Optionally assert that command names in release-check are unique, or make `run()` throw on duplicate names.

**3. Hosted monitor manifest sanitized check is fail-open for a missing flag**

`scripts/release-evidence-imports.mjs:196-198`

**What:** `validateHostedMonitorManifest` throws only `if (manifest.sanitized === false)`, so a manifest that omits the field entirely passes, whereas the observations importer in the same file is strict (`if (evidence.sanitized !== true) throw`, lines 122-124).

**Why it matters:** The gate outcome is currently saved by the per-run filter (`run.sanitized === true`, line 54), but the manifest-level backstop is inconsistent: one imported artifact treats absence as sanitized, the other treats absence as unsanitized. Fail-closed should be uniform for imported evidence.

**Fix:** Change the condition to `if (manifest.sanitized !== true)` and add a test with the field absent.

**4. Production monitor-evidence selection can silently fall back to an unbound "latest" run**

`scripts/release-evidence-imports.mjs:149-181`

**What:** When `VIVA_RELEASE_RUN_ID` is unset, `resolveHostedMonitorEvidencePath` picks the lexicographically last directory under `artifacts/hosted-monitor/<mode>` (`.sort()` then `.at(-1)`, lines 178-180), and `validateRunId` (lines 216-221) becomes a no-op because it only checks when the env var is set. Nothing in `missingProductionEvidence` requires `VIVA_RELEASE_RUN_ID` for production.

**Why it matters:** Run-id binding — one of the tamper/staleness protections — is effectively opt-in. A production gate run without the env var accepts any sub-24h pr-mode manifest whose deploy ids happen to match, and lexicographic sort is not chronological for arbitrary run-id formats, so "latest" may not even be the newest run.

**Fix:** When `productionRequested`, require `VIVA_RELEASE_RUN_ID` (throw if absent) so the manifest path and run_id are always pinned; keep the latest-fallback for non-production convenience only.

**5. Forbidden-marker list and assert function are triplicated with drift**

`scripts/production-release-gate.mjs:32-46,523-536`

**What:** `FORBIDDEN_EVIDENCE_MARKERS` exists in both production-release-gate.mjs (includes `raw_prompt`/`provider_prompt`) and redaction-control.mjs (lines 9-28; includes fixture-content strings and `bearer.` that the gate copy lacks), and the gate has a private `assertNoForbiddenEvidenceMarkers` that omits structural-field detection and reads `process.env` directly even though `finalizeReleaseEvidenceBundle` has an injected `env` it could thread through. release-check.mjs:549-573 layers a third merged scan to compensate — the union does cover both lists in the primary release-check path, but only there.

**Why it matters:** Three near-copies of the release's core denylist invite drift: a marker added to one list is silently missing from the other scans (already observable: the gate copy will not catch `bearer.` and the redaction copy will not catch `raw_prompt`). The gate's private assert also ignores injectable env, making its env-secret detection untestable deterministically.

**Fix:** Have production-release-gate.mjs import the assert and marker list from redaction-control.mjs (extending with gate-specific markers via concatenation), and thread the caller's env through instead of `process.env`.

**6. release-check tests are source-grep assertions that cannot detect disabled logic**

`scripts/release-check.test.mjs:5-24`

**What:** All three tests read release-check.mjs as text and `assert.match` regexes (e.g. `/assertNoForbiddenEvidenceMarkers\(evidence/`). A commented-out call, a call moved behind a dead branch, or a swallowed error would still satisfy every regex.

**Why it matters:** For the top-level gate orchestrator this is the only direct test coverage; a refactor that accidentally stops invoking the redaction assert or the hosted-monitor import would pass this suite.

**Fix:** Keep the greps as cheap guards but add at least one behavioral test that imports extracted pieces (e.g. move `auditSanitizedEvidence` and `buildReleaseGateEvidence` into an importable module and test that a marker-bearing evidence object throws).

**7. release_gate section hardcodes max_age_seconds, ignoring the env override honored by the production gate**

`scripts/release-check.mjs:600`

**What:** `buildReleaseGateEvidence` emits `max_age_seconds: 86_400` as a literal, while production-release-gate.mjs:77-80 derives the effective limit from `VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS`.

**Why it matters:** When an operator overrides the age limit, the bundle carries two contradictory max_age values (`release_gate.max_age_seconds` vs `production_release_gate.max_age_seconds`) — exactly the kind of evidence inconsistency an auditor would flag.

**Fix:** Reuse `positiveIntegerOrDefault(env.VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS, DEFAULT_MAX_EVIDENCE_AGE_SECONDS)` (export it from production-release-gate.mjs) in `buildReleaseGateEvidence`.

**8. Dead ripgrep exclusion glob in the purity gate**

`scripts/check-agent-domain-purity.sh:10-13`

**What:** The rg invocation searches only `agent packages apps` but passes `-g '!docs/superpowers/plans/**'`; the docs tree is never in scope, so the glob is dead code.

**Why it matters:** Dead exclusions in a security-ish gate are misleading — a future reader may assume docs are scanned-but-exempted, or widen the roots without realizing the exemption then silently activates.

**Fix:** Drop the `-g '!docs/superpowers/plans/**'` flag, or if docs were meant to be scanned, add `docs` to the search roots deliberately.

## Verification notes

Every critical/important finding was re-verified against the source; all minors were spot-checked and held up.

- F5 (run() spawn hang) — **downgraded** from important to minor. The claim "hangs forever" was refuted empirically: with no `error` listener, Node's EventEmitter throws the unhandled 'error' event and the process exits non-zero immediately with a clear `spawn ... ENOENT` message (reproduced on Node 25 with an isolated probe). The real, smaller defect is that the crash happens outside the try/catch, skipping the failure.json quarantine and artifact-dir purge.
- F1–F4 — confirmed as written after checking package.json wiring (release:hygiene/agent:purity are on the validate and release-check paths), the harness test that codifies the hardcoded false, live-provider-smoke.mjs's emitted `deploy_sha` that the gate never reads, and a repo-wide grep showing `assertReleaseBundleIntegrity` is called only by `finalizeReleaseEvidenceBundle` and tests, with the runbook's only stored-bundle check being `artifact_audit.forbidden_hits`.
- F6–F12 — all confirmed at the cited lines (duplicate cargo block, `=== false` manifest check, lexicographic latest-fallback plus no-op `validateRunId`, marker-list drift including `bearer.` vs `raw_prompt`, grep-only tests, hardcoded 86_400, dead docs glob).
- No findings were fully refuted or withdrawn.

## Recommendations

- Ship and document a deploy-time bundle verifier (`assertReleaseBundleIntegrity` + `assertProductionReleaseGate` over a stored evidence.json) that requires the HMAC secret and rejects self-signed bundles in production mode; today the signature is only ever checked by the process that created it.
- Unify the forbidden-marker denylist and assert helpers in redaction-control.mjs and import them everywhere (production-release-gate.mjs, release-check.mjs) so a marker added once protects every scan.
- Make imported-evidence validation uniformly strict: `sanitized` must be `=== true` everywhere, run-id binding mandatory for production (require `VIVA_RELEASE_RUN_ID`), and bind live-smoke evidence to the release deploy identity like monitor runs already are.
- Harden the two shell gates against missing tools: check for rg up front and distinguish rg exit code 1 (no match) from real failures instead of `|| true`.
- Fix release-check's `run()` to reject on the child `error` event (restoring the fail-closed cleanup path for spawn failures) and remove the duplicated provider_gate_tests invocation; consider asserting unique command names so log clobbering cannot recur.
- Make `failure_control_harness.enabled_for_release` reflect the actual plan state so the BAC-528 gate check attests something real, keeping the release-check throw as defense in depth.
- Add one behavioral (non-grep) test for release-check's evidence assembly by extracting `auditSanitizedEvidence`/`buildReleaseGateEvidence` into an importable module.

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first pass; verification tightened one finding rather than shifting the overall picture). The gates genuinely gate in the paths they exercise — production evidence is fail-closed on missing/stale/future-dated/mismatched inputs, the tests mutate real bundles rather than mocks, and the redaction system is unusually thorough with precisely scoped allowlists. The four confirmed important findings share one shape: a second defense layer that currently attests nothing (fail-open shell gates behind a present rg, a hardcoded-false harness flag behind a release-check throw, an unbound live-smoke artifact behind deploy-bound browser evidence, an HMAC nobody re-verifies) — latent weaknesses behind currently-working first layers, all straightforward to fix, and nothing rising to a broken gate today.
