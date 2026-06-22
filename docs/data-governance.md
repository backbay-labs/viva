# Viva User-Study Data Governance

Verified: 2026-06-22.

This document covers the Viva user-study path for microphone study sessions,
the BAC-521 answer-attempt envelope, local or durable study-library storage, and
live Cartesia/Gemini provider mode.

## In-Product Consent

The `/session` UI must show a recording disclosure before the first microphone
capture attempt. The tester must acknowledge that Viva may collect microphone
audio, derived transcripts, answers, source-linked study events, answer-attempt
envelopes, nonce rows, and session metadata.

Synthetic mode stays within the configured Viva agent. Live `cartesia_gemini`
mode sends microphone audio to Cartesia Ink STT, sends the derived answer and
source-grounded tutoring turn to Google Gemini, and sends generated tutor speech
text to Cartesia Sonic TTS.

Consent records and governance artifacts must never include raw audio,
transcript text, answer text, bearer values, signed session values, provider
keys, or unrestricted source excerpts.

## Data Handling And Retention

Browser microphone audio is captured only after the tester acknowledges the
recording disclosure. Viva uses that audio for the active turn. The configured
study store does not persist raw microphone audio or raw transcript text.

The BAC-521 answer-attempt envelope stores the server-owned audit envelope for a
graded answer attempt: identifiers, capture mode, status, source tuple, concept
status, confidence, timing, and pre-provider state. It must not store raw answer
text.

The durable Postgres store may retain study-set rows, source summaries, session
status rows, recaps, review items, usage rows, answer-attempt envelopes, and
nonce rows until a tester deletion action runs. The in-memory store retains the
same categories only for the lifetime of the process.

Exports must remain sanitized. They must not include raw provider responses,
raw audio, transcript text, answer text, provider keys, bearer values, signed
session values, or unrestricted source excerpts.

## Delete This Tester's Session Data

Use the Library privacy controls for the tester's configured `user_id`:

1. Delete recap for each session that should be removed.
2. Delete source for a whole study set removal.
3. Export data after deletion and confirm the removed session or set no longer
   appears in the active library view.

The server-side deletion contract is:

1. `DELETE /study-sets/{study_set_id}/sessions/{voice_session_id}` marks the
   session deleted and removes session recaps, review items, usage rows,
   answer-attempt envelopes, and nonce rows for that session.
2. `DELETE /study-sets/{study_set_id}` tombstones documents and source spans,
   disables questions, marks the set's sessions deleted, and removes the same
   session artifacts for the set.

Runnable proof:

```sh
cargo test --manifest-path agent/Cargo.toml -p data deletion_removes_session_nonces_and_answer_envelopes
DATABASE_URL=postgres://localhost/viva_agent cargo test --manifest-path agent/Cargo.toml -p data optional_postgres_privacy_deletes_purge_usage_and_preserve_deleted_sessions_when_database_url_is_set
```

The Postgres proof is opt-in because default gates must not require a local
database. The default in-memory proof runs without external services.

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

## Release Evidence

`bun run release:check` writes sanitized release evidence under
`artifacts/release-check/evidence.json`. The BAC-526 release bundle includes:

1. in-product consent disclosure present,
2. this data-handling statement path,
3. deletion proof test names,
4. provider ZDR confirmation flags,
5. negative checks that raw payloads, signed values, provider keys, and source
   excerpts are absent from generated evidence.

## Continuous Redaction Control

Viva treats structural allowlist serialization as the primary defense. Runtime
agent evidence details flow through `SanitizedEvidenceDetail`; web-visible log
payloads flow through `redactForVivaLog`; Node evidence scripts call the shared
`scripts/redaction-control.mjs` audit before writing or promoting evidence.

The forbidden-marker denylist in `scripts/redaction-control.mjs` is a backstop,
not the main control. It exists to fail generated artifacts and changed
logging/evidence code when a raw audio, transcript, answer, prompt, source,
signed-token, bearer, provider-key, or secret marker escapes the structural
boundary. `bun run redaction:check` runs on every PR and scans added lines in
changed logging/evidence code while exempting tests, fixtures, docs, and the
central denylist module itself.
