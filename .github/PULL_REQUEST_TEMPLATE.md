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

## Checklist

- [ ] The default path still requires **no** provider key, paid network call, or local Postgres
- [ ] `agent-domain` stays I/O-free (`bun run agent:purity`)
- [ ] Learner-facing copy carries no raw provider failure or internal payload data
- [ ] No secrets, real tokens, or student course material in the diff or the test fixtures

## Related

<!-- Issue or ticket, if there is one. -->
