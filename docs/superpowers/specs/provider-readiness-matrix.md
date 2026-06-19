# Provider Readiness Matrix Evidence

BAC-305 is proved by the sanitized release evidence gate:

```sh
VIVA_RELEASE_CHECK_SKIP_BROWSER=1 bun run release:check
```

The command writes `artifacts/release-check/evidence.json`. The artifact directory is ignored by git and is meant to be attached to release evidence, not committed.

## Expected Matrix

| Provider | Purpose | `/health/brain` | `/ready` | Configured | Selectable | Live runtime |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `synthetic` | Default no-key synthetic brain for the Act 1 manuscript | 200 | 200 | true | true | false |
| `fake_cartesia_gemini` | Deterministic fake provider for replay and browser evidence | 200 | 200 | true | true | false |
| `cartesia_gemini` | Gated Act 3 live provider, configured with placeholder key material during the check | 200 | 503 | true | false | false |

The live provider row must stay unavailable in default release evidence. BAC-305
does not make the live provider selectable, and the placeholder key material
used here must remain non-selectable even if the live runtime gate exists. The
written definition of live provider proof is
`docs/superpowers/specs/live-cartesia-gemini-definition.md`.

## No-Network Gate Proof

`release:check` also runs the `live_provider_no_network_gate_tests` command,
which executes the adapter tests matching `cartesia_gemini_brain`. Those tests
prove that default live open attempts fail at the shared gated runner before
provider network calls are reachable, and that the explicit live runtime gate
requires non-placeholder provider credentials.

## Sanitization Rules

The evidence matrix records HTTP statuses, provider names, capability flags, store capability flags, and the no-network gate command name. It must not record provider key values, raw audio, transcripts, answer text, notes, prompts, bearer tokens, session tokens, or source excerpts.
