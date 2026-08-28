# Viva Learner Loop Contract

Source of truth: `packages/core/src/learner-loop-contract.json`
(schema `viva.learner_loop_contract.v1`, 32 states).

This document is only an index for humans. Do not add a second state table here; update the
JSON contract and its tests instead. `node scripts/public-contract.mjs --check` compares the field
list below against the canonical JSON, so an omission here is a gate failure rather than a
documentation nit.

BAC-523 exposes the checked-in learner/operator copy surface through
`packages/core/src/learner-recovery-copy.ts`. That projection is derived from the JSON contract
so every BAC-510 state keeps one learner copy/action mapping and one separate operator diagnostic
mapping.

## BAC-510 rules

- A submitted answer must resolve to exactly one learner-safe state within
  `max_submitted_answer_resolution_ms`, which is 45000 ms.
- BAC-512 owns the client/session safety net: the UI must exit checking/thinking by the
  outer bound even if a finer server stage failure is absent.
- BAC-517 owns server stage enforcement: provider, tool, audio, and recap stages should fail
  earlier when possible.
- State transitions must come from authoritative agent, session, durable-store, server-control,
  pre-loop service, or client lifecycle events. Stale headers and optimistic UI phases are not
  authorities.
- Learner copy and operator diagnostics are separate fields. Learner copy must not show raw
  provider failures or internal payload data.

## Evidence fields

The contract requires these diagnostic field names whenever evidence is available. This list is
exactly `evidence_fields` in the canonical JSON, in the canonical order:

- `terminal_reason`
- `failure_class`
- `stage`
- `provider`
- `model`
- `deploy_sha`
- `latency_ms`
- `retry_after_ms`
- `retry_after_source`
- `reset_hint`
- `budget_state`
- `usage`
- `cost_usd`
- `token_refresh_outcome`
- `recap_success`

The four rate-limit fields — `retry_after_ms`, `retry_after_source`, `reset_hint`, and
`budget_state` — carry the operator-facing shape of a throttled provider turn. They are diagnostic
only: none of them is ever rendered as learner copy.

## Incident seed

BAC-510 is seeded by sanitized production evidence from 2026-06-22T02:36:00Z and
2026-06-22T02:37:00Z: the hosted readiness path stayed green while the live provider path emitted
`cartesia_gemini_provider_turn_failed`, `provider rate limited`, and `gemini_http_429`.

The contract and tests intentionally exclude raw audio, learner answer content, provider payload
content, source material, session or bearer credentials, provider keys, and secrets.
