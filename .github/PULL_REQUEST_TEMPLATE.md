# Summary

<!-- What was wrong, and why is this the right fix? Lead with the reasoning, not the diff. -->

## Changes

<!-- The notable changes, briefly. -->

-

## Verification

<!-- Say what you actually ran, and paste the outcome if it is interesting. -->

- [ ] `bun run validate` passes
- [ ] Added or updated a test that fails before this change and passes after it
- [ ] Docs updated in this PR if behavior changed (`agent/README.md` if agent config changed)
- [ ] `node scripts/public-contract.mjs --check` passes; if a public contract value moved,
      `--write` was rerun and the affected documents and diagrams updated in this PR

## Checklist

- [ ] The default path still requires **no** provider key, paid network call, or local Postgres
- [ ] `bun run agent:purity` passes — it checks the `agent-domain` direct normal-dependency
      allowlist and the module paths that crate imports. It does **not** prove adapter purity,
      runtime behavior, or live provider behavior
- [ ] `bun run agent:residue` passes — a separate vocabulary scan of `agent`, `packages`, and
      `apps` for the removed Chef Luca cooking terms. It proves nothing about purity or behavior
- [ ] Learner-facing copy carries no raw provider failure or internal payload data
- [ ] No secrets, real credentials, or student course material in the diff or the test fixtures

<!--
CI runs three required jobs behind the stable `Required validation` context: `Quality and audit`,
`Loopback and browser proofs`, and `Durable Postgres proof`. A green local gate is necessary, not
sufficient.
-->

## Related

<!-- Issue or ticket, if there is one. -->
