# Public Repository README Design

**Date:** 2026-08-10
**Status:** Approved
**Scope:** Rewrite `README.md` for public release, add the open-source file set, author `docs/assets/` diagrams.

## Goal

`backbay-labs/viva` is going public. The current README is a 71-line internal note: workspace
list, command list, and two sections of contributor-only environment detail. It does not say
what Viva is, why it exists, or what the architecture looks like. A visitor landing on the repo
learns nothing that would make them clone it.

The target is the register `backbay-labs/chio` uses: a README that opens with a product thesis,
carries hand-authored diagrams, documents the real architecture, and closes with roadmap,
contribution gate, and license.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Visual treatment | Hand-authored SVG in `docs/assets/` | The diagrams are what make chio's README land. Screenshots would read as a landing page, not a systems README. |
| Scope | README + full OSS file set | A public repo with no LICENSE is legally unusable by anyone who finds it. |
| License | Apache-2.0 | Matches chio and the `backbay-labs` org. Patent grant plus NOTICE. |
| Register | Vision-forward | Lead on the product thesis, not the prototype caveats. One honest line on credential-gated live providers so a cloner is not surprised. |

## Visual identity

The SVGs use Viva's own tokens from `packages/tokens/src/index.ts`, not chio's palette:

- Ground: `bg #f4efe6`, `paper #faf7f1`, `paperRaised #fdfbf6`
- Ink: `ink #2c2536`, `inkSecondary #5d5670`, `inkTertiary #938aa4`
- Accent: `plum #7a5ba6`, `plumDeep #553b78`, `plumSoft #a98fce`, `plumWash #efe7f6`
- Support: `sage #7f9277`, `gold #bd9a55`, `amber #c1864a`, `lavender #c3b2dd`
- Type: Cormorant serif for display, Hanken Grotesk for labels

Chio's dark systems look would fight Viva's warm-paper manuscript aesthetic. What carries over
is structure and confidence, not the palette.

Each SVG paints its own opaque warm-paper ground, so a single file reads correctly in both
GitHub light and dark themes without `prefers-color-scheme` variants. Each diagram ships a
`-mobile` variant selected through `<picture>` at `max-width: 500px`, matching chio's pattern.

## Assets

| File | Content |
| --- | --- |
| `hero.svg` | Cormorant "Viva" wordmark, plum voice orb, tagline |
| `loop.svg` | The learner loop as a closed ring: Upload, Extract, Recall, Correct, Master, Return |
| `lifecycle.svg` | One study turn crossing the WebSocket boundary |
| `architecture.svg` | Next web, WS edge, the four Rust crates, the three provider runtimes |

Plus a `-mobile` variant of each.

## README structure

1. Hero image, badge row, tagline, nav links
2. One-line quickstart above the fold
3. **What is Viva**: recognition is not retrieval; Viva is the oral exam room
4. **The loop**: `loop.svg` and three pillar tables: Recall, Grounding, Mastery
5. **Quickstart**: install, synthetic agent, open `/session`, signed path
6. **Architecture**: `architecture.svg`; life of a study turn (`lifecycle.svg` plus an
   8-step table over the real `ClientFrame`/`VivaServerEvent` protocol); the codebase table
7. **Study modes**: Quiz, Teach, Mock, Cram
8. **Privacy and trust**: redaction gate, zero-data-retention flags, learner-safe copy
   separation, fail-closed non-loopback binds, no raw audio or answer persistence
9. **Roadmap**
10. **Contributing** and **License**

## Ground truth the README must match

Verified against the source, not assumed:

- Voice protocol version is `4` (`VIVA_VOICE_PROTOCOL_VERSION`)
- Audio is 24 kHz `pcm_s16le`; 64 KiB max text frame, 256 KiB max binary frame
- Seven brain tools: `select_next_question`, `evaluate_spoken_answer`,
  `retrieve_source_reference`, `mark_concept_status`, `challenge_correction`,
  `schedule_review_item`, `build_session_recap`
- Four study modes: `quiz`, `teach`, `mock`, `cram`
- Crates: `agent-service`, `agent-domain`, `agent-adapters`, `data`, `observe`
- Packages: `@viva/web`, `packages/core`, `packages/ui-web`, `packages/tokens`
- Providers: `synthetic` (default), `fake_cartesia_gemini`, `cartesia_gemini` (gated on real
  credentials plus `VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1`, `CARTESIA_ZERO_DATA_RETENTION_ENABLED=1`,
  `GEMINI_ZERO_DATA_RETENTION_APPROVED=1`)
- Scheduling authority is FSRS via `ts-fsrs` in `packages/core/src/scheduling.ts`
- Toolchains: Bun 1.3.3, Rust 1.94.1
- Default store is in-memory; Postgres is opt-in via `DATABASE_URL` or `VIVA_AGENT_DATABASE_URL`

## Open-source file set

`LICENSE` (Apache-2.0), `NOTICE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor
Covenant 2.1), `SECURITY.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`,
`.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/ISSUE_TEMPLATE/config.yml`,
`.github/PULL_REQUEST_TEMPLATE.md`.

## Content migration

The current README's "Test Environment" and "Agent Modes" sections are contributor material.
They move to `CONTRIBUTING.md` rather than being deleted. `agent/README.md` already carries the
authoritative agent-mode detail and stays as-is; `CONTRIBUTING.md` links to it instead of
restating it.

## Non-goals

- No changes to application code, tests, or CI
- No new documentation pages beyond the OSS set
- No rewrite of `agent/README.md` or the existing `docs/` guides
- No screenshots; the design-reference PNGs stay internal

## Verification

- `bun run typecheck && bun run lint` must stay green (no source touched, but confirm)
- Every relative link in the README resolves to a file that exists
- Every SVG parses as valid XML and references no external fonts or images
- Command blocks match real scripts in `package.json`
