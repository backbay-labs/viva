# Viva Release Readiness

This document defines what "ready" is allowed to mean, what evidence each level of that claim
requires, and who owns the parts no repository gate can prove. It is a definitions document. It
does not report the state of any particular candidate.

**No terminal status has been emitted.** Emitting one is the last step of the integration phase and
happens only against a frozen SHA whose mandatory evidence has already passed. Nothing in this
repository's tracked documentation may assert a release outcome ahead of that.

## The three legal terminal statuses

Exactly three values may ever be emitted, and only into the generated evidence document. A run whose
mandatory evidence is incomplete emits **none** of them.

| Status | Exact meaning |
| --- | --- |
| `CODE_REMEDIATION_COMPLETE` | Mandatory local, combined-tree, and durable evidence, the public-documentation contract, the coverage ledger, and independent review all pass on one frozen SHA — but the required external set qualifies for neither a release claim nor a clean pending state, normally because at least one external gate ran and failed. Code remediation is complete; external acceptance is not, and the remediation loop stays open. **This is not a release claim.** |
| `CODE_COMPLETE_EXTERNAL_GATES_PENDING` | The same mandatory evidence passes; no required external gate has failed; and at least one required external gate is `BLOCKED_EXTERNAL` with a complete, recorded reason. **This is not a release claim.** |
| `RELEASE_READY` | The same frozen SHA passes every mandatory level *and* every one of `OPS-01` through `OPS-06`, the stored production bundle is independently verified from a separate environment, the deployed web/agent/monitor identities bind to that SHA and run ID, and the named release owner has recorded `proceed`. |

Three rules constrain those values:

1. If any mandatory gate is absent, still running, blocked, or failing, no status is emitted at all.
2. An external failure outranks an external block: one failed gate plus one blocked gate derives
   `CODE_REMEDIATION_COMPLETE`, never the pending status.
3. A required external gate that simply did not run is materialized as a **failure**, not silently
   coerced into `BLOCKED_EXTERNAL`. Pending status has to be earned by recording a reason.

## The evidence ladder

| Level | What it must prove | Skip policy |
| --- | --- | --- |
| **Level 1 — lane and ledger proof** | The exact input commit for every remediation lane, red/green/adversarial evidence for every canonical finding, full finding-instance reconciliation, and every recorded decision resolved in code and docs. | No skip. Missing evidence fails. |
| **Level 2 — frozen combined-tree proof** | A clean worktree; a forced TypeScript graph; the script suite; Rust fmt/clippy/workspace tests/build; a direct real-loopback WebSocket replay; production-shaped voice transport; synthetic and fake-provider browser stories; release evidence generation *and* separate stored-bundle verification; redaction; dependency audits; and the shell/identity/signature/timeout/orphan/mutation controls. | No skip. A cache-only result or an early return on a permission error fails. |
| **Level 3 — disposable durable proof** | A fresh PostgreSQL 16; migrations from an empty database; migration replay; the required durable suite run twice in two fresh databases; application restart; two store/service instances; atomic replay and concurrency; deletion and non-resurrection; row and schema privacy canaries. | No skip. Missing Docker, Postgres, or client tooling fails. |
| **External — `OPS-01`…`OPS-06`** | Hosted exact-SHA checks, enforced branch rules, exact-deploy proof, live provider and zero-retention proof, real device/browser/screen-reader proof, and a release-owner decision. | Unavailable prerequisites are `BLOCKED_EXTERNAL` with a complete reason object. Never inferred as passing. |

Levels 1–3 are what this repository can prove about itself. Nothing in them, in any combination,
promotes an external gate.

## The external register

Each gate below has a named accountable human. None of them can be satisfied by a local run, a
green workflow, or a passing test.

| ID | Accountable role | Required action and evidence |
| --- | --- | --- |
| `OPS-01` | GitHub billing/account owner | Clear Actions billing or minutes restrictions, authorize the exact-SHA validation run, and capture the successful run and artifact identities. |
| `OPS-02` | GitHub repository administrator | Enable and verify protected-branch/ruleset enforcement for the stable `Required validation` context, including administrators or an audited break-glass path. |
| `OPS-03` | Deployment project owner/operator | Provision or access the project, deploy web, agent, and monitor from the exact SHA, and capture deployment IDs, output-image digests distinct from pinned build inputs, origins, in-band SHAs, restart/drain/rollback behavior, and durable object identity. |
| `OPS-04` | Provider security/billing owner | Attest provider credentials at their consuming services, zero-data-retention status, quota, model identity, and cost authorization; run one sanitized exact-deploy live proof. |
| `OPS-05` | Device/accessibility operator | Execute and record the real microphone, cross-browser, VoiceOver/NVDA, keyboard, zoom, forced-colors, and reduced-motion matrix. |
| `OPS-06` | Named release owner | Review the exact post-merge bundle and record the final `proceed` decision, or remain blocked. |

### External conditions never inherit PASS from local proof

This is the rule the whole document exists to protect. A green `bun run validate`, a green
`Required validation` check, a green durable Postgres job, and a fully sanitized release bundle
together say nothing about whether a real deployment exists, whether a real provider answered,
whether a real microphone was used, or whether a human approved the release. Those are separate
observations with separate owners.

Concretely, none of the following is ever accepted as evidence for an external gate:

- a local or CI run of `bun run e2e:browser`, for `OPS-05`;
- a `fake_cartesia_gemini` run, for `OPS-04`;
- readiness output from a locally started agent, for `OPS-03`;
- a green workflow run on a different SHA, for `OPS-01`;
- the absence of a rule violation, for `OPS-02`;
- silence, for `OPS-06`.

### What `BLOCKED_EXTERNAL` requires

`BLOCKED_EXTERNAL` is legal only for `OPS-01` through `OPS-06`, and only with a complete reason
recorded: a reason code, the accountable owner, the UTC instant it was blocked, the exact command or
URL attempted, the last externally observed state, the required action, the required evidence, the
next check time, and the frozen SHA the block applies to. A missing executable, an absent database,
a skipped test, a cache-only result, or a local test failure is a **failure**, never an external
block.

## Evidence that is deliberately non-certifying

Some artifacts are useful diagnostically and are still not proof of the product. They are reported
separately so that no one mistakes them for coverage:

- **The harness-authored structured preview.** The browser story may carry a frame marked
  `structured_preview`. It is rendered by the harness, not by the mounted product, and it is
  excluded from the required-product-frame set and from the product screenshot count. It can never
  satisfy a missing product frame. This follows the recorded `D-09` decision: the preview is
  reported as non-product evidence rather than being asked to certify anything.
- **The in-memory fixture store.** Useful for the whole no-key loop; not a durability claim.
- **`fake_cartesia_gemini`.** Provider-shaped, deterministic, and offline; not a live-provider claim.

## How the documentation contract fits in

`docs/public-contract.json` is generated from the code by `node scripts/public-contract.mjs --write`
and gated by `--check`. Regenerating it is a mandatory step of the same frozen run: a public
document that overstates shipped behavior fails the documentation gate exactly like a failing test,
and a tracked regeneration after the final check supersedes the run. The related operational
procedures — exact deploy binding, stored-bundle verification, rollback, and drain — live in
[deployment-runbook.md](deployment-runbook.md).
