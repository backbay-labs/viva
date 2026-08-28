# Viva User-Study Data Governance

Reconciled against shipped behavior at the integration candidate. The
machine-checked companion is `docs/public-contract.json`; where prose and that
file disagree, the file is right.

This document covers the Viva user-study path for microphone study sessions,
the BAC-521 answer-attempt envelope, local or durable study-library storage, and
live Cartesia/Gemini provider mode.

## In-Product Consent

The recorded program decision is `D-08` Branch A: the acknowledgment scope is
`all_live_provider_content`, not microphone audio alone. Branch B
(`microphone_audio_only`) is the unselected alternative; it remains executable in
`providerInputAllowed` so the rejected branch stays testable, and it is selected
nowhere.

What that means in the mounted `/session` surface:

- Microphone capture is gated under both branches. `canStartMicrophoneCapture`
  refuses before the capture source can even be constructed, so a disabled button
  is never the control.
- Under the selected branch a **live** provider additionally gates typed answers
  and citation challenges, because under that branch typed content reaches the
  same provider as the spoken turn.
- A non-live path keeps its explicitly labelled behavior for typed content.
- The acknowledgment is one boolean, keyed by
  `viva:disclosure:v1:<scope>:<study_set_id>:<voice_session_id>`. A different
  scope, study set, or session is a different key, so no acknowledgment is
  inherited across any of them, and nothing but the boolean is stored.

The tester must acknowledge that Viva may collect microphone audio, derived
transcripts, typed answers, source-linked study events, answer-attempt
envelopes, nonce rows, and session metadata.

Synthetic mode stays within the configured Viva agent. Live `cartesia_gemini`
mode sends microphone audio to Cartesia Ink STT, sends the derived answer and
source-grounded tutoring turn to Google Gemini, and sends generated tutor speech
text to Cartesia Sonic TTS.

Consent records and governance artifacts must never include raw audio,
transcript text, answer text, bearer values, signed session values, provider
keys, or unrestricted source excerpts.

## Ingestion Surface

| Input | Status |
| --- | --- |
| `POST /study-sets/paste` | Accepted. The primary study-material path. |
| `POST /study-sets/files` with UTF-8 text | Accepted. Invalid UTF-8 is refused with `invalid_utf8_file` rather than repaired. |
| Any PDF shape | Refused, fail-closed, with `invalid input` / `unsupported_pdf`. The classifier runs on file name, declared media type, and the `%PDF` magic *before* any decoding, so a rejected upload leaves the store byte-identical. |

There is no PDF parser, no OCR, and no page-aware extraction in the shipped
tree. A refused upload persists nothing.

## Data Handling And Retention

Browser microphone audio is captured only after the tester acknowledges the
recording disclosure. Viva uses that audio for the active turn. The configured
study store does not persist raw microphone audio or raw transcript text.

The BAC-521 answer-attempt envelope stores the server-owned audit envelope for a
graded answer attempt: identifiers, capture mode, status, source tuple, concept
status, confidence, timing, and pre-provider state. It must not store raw answer
text.

The durable Postgres store may retain study-set rows, source summaries, session
status rows, recaps, review items, review-schedule decisions, usage rows,
answer-attempt envelopes, and nonce rows until a tester deletion action runs. The
in-memory store retains the same categories only for the lifetime of the process.

Exports must remain sanitized. They must not include raw provider responses,
raw audio, transcript text, answer text, provider keys, bearer values, signed
session values, or unrestricted source excerpts.

## Deletion: The Recorded `D-05` Branch

The selected retention branch is `hard_purge_text`, reported verbatim as the
`policy` field of every deletion receipt so a caller never has to infer which
branch ran. The complementary UX decision is `D-04 CONFIRM_DELETE`: destructive
library actions take a named confirmation and are then permanent. No restore
route is registered anywhere in the service.

What `hard_purge_text` means precisely:

- **Learner-authored and learner-derived text is removed, not deactivated.** On
  study-set deletion the questions, concepts, source spans, documents, and exam
  date for that set are dropped outright. Tombstoning a document and merely
  deactivating a question would have left the excerpt, the display name, the
  concept label, and the question text in storage forever, which is exactly what
  this branch forbids.
- **What survives is a content-free tombstone**, by enumeration: the set's own
  identifier, the deletion timestamp, and three constants — the scrubbed title
  `[deleted]`, the row constant `deleted`, and the policy name. Course, ingestion
  error, concept ids, and question ids are cleared.
- **The tombstone exists for exactly two reasons**: so a repeated delete stays
  idempotent and returns a byte-identical receipt without re-reading anything it
  just purged, and so a fixture seed cannot recreate the material behind it.
- **Session artifacts go with it.** Recaps, review items, review-schedule
  decisions, concept statuses, answer-attempt envelopes, usage rows, and event
  authorizations for the affected sessions are removed; the session rows keep
  their identity and nothing else. Nonce rows are removed by
  `(user_id, study_set_id)`, not by session, because a nonce is legitimately
  claimable before its session row exists.
- **A malformed tombstone is a durability error**, not a licence to re-scrub.

### Delete this tester's session data

Use the Library privacy controls for the tester's configured `user_id`:

1. Delete the session history for each session that should be removed.
2. Delete the study set for a whole-set removal.
3. Export data after deletion and confirm the removed session or set no longer
   appears in the active library view.

The server-side deletion contract is:

1. `DELETE /study-sets/{study_set_id}/sessions/{voice_session_id}` marks the
   session deleted and removes that session's recaps, review items,
   review-schedule decisions, concept statuses, usage rows, answer-attempt
   envelopes, and event authorizations. It returns
   `{voice_session_id, study_set_id, status, policy}` and nothing else.
2. `DELETE /study-sets/{study_set_id}` purges the set's learner text as described
   above, marks the set's sessions deleted, removes the same session artifacts,
   drops the set's nonce rows, and returns
   `{study_set_id, status, policy, deleted_at}`.

Runnable proof:

```sh
cargo test --manifest-path agent/Cargo.toml -p data deletion_removes_session_nonces_and_answer_envelopes
DATABASE_URL=postgres://localhost/viva_agent cargo test --manifest-path agent/Cargo.toml -p data optional_postgres_privacy_deletes_purge_usage_and_preserve_deleted_sessions_when_database_url_is_set
```

The second command is opt-in locally because default gates must not require a
database on a developer laptop. It is not opt-in in CI: the required
`Durable Postgres proof` job runs the durable privacy suite against a real
PostgreSQL 16 service on every pull request. A developer's own database run is
never accepted as release evidence on its own.

## Provider Retention And Zero-Retention

Cartesia documents Zero Data Retention as an Enterprise setting for Text-to-
Speech and Speech-to-Text APIs. Cartesia says ZDR covers TTS text input, TTS
audio output, STT audio input, and STT transcript output, while retaining
operational metadata such as request identifiers, usage totals, account
information, and service health data. Cartesia also says organization admins
enable ZDR once for eligible API requests. Source:
https://docs.cartesia.ai/enterprise/zero-data-retention.

Set `CARTESIA_ZERO_DATA_RETENTION_ENABLED=1` only after the Cartesia Enterprise
organization has ZDR enabled for the account used by Viva live mode.

Google documents that Gemini API Paid Services are not used to improve Google
products. Google also says Paid Services log prompts and responses for a limited
period for abuse monitoring, and that approved Gemini Developer API ZDR clears
user content and identifiable metadata before logging. Source:
https://ai.google.dev/gemini-api/docs/zdr and
https://ai.google.dev/gemini-api/terms.

Set `GEMINI_ZERO_DATA_RETENTION_APPROVED=1` only after the Gemini Developer API
project has ZDR approval. For Viva live mode, do not enable Google Search or
Maps grounding, Interactions state storage, Live API session resumption, File API
storage, or explicit context caching unless a later governance document updates
this rule with a new retention proof.

The live provider is selectable only when all are true:

1. `VIVA_AGENT_PROVIDER=cartesia_gemini`.
2. Real non-placeholder Cartesia and Gemini credentials are configured.
3. `VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1`.
4. `CARTESIA_ZERO_DATA_RETENTION_ENABLED=1`.
5. `GEMINI_ZERO_DATA_RETENTION_APPROVED=1`.

Provider-side ZDR is an attestation about a third party, so it is external
evidence: it is recorded under `OPS-04` and never inferred from a local gate. See
`docs/release-readiness.md`.

## Release Evidence

`bun run release:check` writes sanitized release evidence under
`artifacts/release-check/evidence.json`. The BAC-526 release bundle includes:

1. in-product consent disclosure present,
2. this data-handling statement path,
3. deletion proof test names,
4. provider ZDR confirmation flags,
5. negative checks that raw payloads, signed values, provider keys, and source
   excerpts are absent from generated evidence.

## Dependency Posture

`bun run audit` runs `bun audit` plus `cargo audit --deny warnings`. Exactly one
advisory is scoped out, in `.cargo/audit.toml`, and only with two proofs
load-bearing (recorded as amendment `A-33`):

- **RUSTSEC-2023-0071** — `rsa` 0.9.10, the "Marvin Attack" timing side channel,
  with no fixed upgrade published. The only path to `rsa` in this workspace is
  the MySQL driver in SQLx's feature-agnostic dependency graph. Viva declares
  SQLx Postgres-only and never enables, builds, or ships MySQL support.
- **Build-graph absence proof.** `cargo tree -i` prints nothing for `rsa`,
  `sqlx-mysql`, `sqlx-sqlite`, or `flume` on any target. `Cargo.lock` still names
  them because a lockfile records every optional dependency of every resolved
  package regardless of feature activation, so no manifest edit can prune them
  from the lock; the compiled graph, which is what ships, is empty.
- **A gate that keeps that honest.** `scripts/dependency-policy.test.mjs` re-runs
  that exact `cargo tree -i` proof on every run and fails *before* the ignore
  could hide anything, the moment the RSA path becomes compilable. A second test
  pins the ignore list to exactly one entry, so another advisory cannot be added
  silently.

A permanently red audit gate was rejected because it normalizes red. A future
workspace SQLx 0.9 upgrade drops `rsa` entirely and removes the file.

## Continuous Redaction Control

Viva treats structural allowlist serialization as the primary defense. Runtime
agent evidence details flow through `SanitizedEvidenceDetail`; web-visible log
payloads flow through `redactForVivaLog`; Node evidence scripts call the shared
`scripts/redaction-control.mjs` audit before writing or promoting evidence.

The forbidden-marker denylist in `scripts/redaction-control.mjs` is a backstop,
not the main control. It exists to fail generated artifacts and changed
logging/evidence code when a raw audio, transcript, answer, source, signed-value,
bearer, provider-key, or secret marker escapes the structural boundary.
`bun run redaction:check` runs on every PR and scans added lines in changed
logging/evidence code while exempting tests, fixtures, docs, and the central
denylist module itself.
