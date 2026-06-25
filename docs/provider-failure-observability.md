# Provider Failure Observability

Source of truth: `scripts/provider-failure-observability.mjs`.

This dashboard contract is intentionally data-shaped, not vendor-specific UI
configuration. The release bundle includes a sanitized
`provider_failure_observability` section with reusable Railway queries,
dashboard grouping dimensions, alert thresholds, coverage for every BAC-510
failure class, and redaction assertions.

The alert thresholds for provider 429s, provider timeouts, provider auth
failures, stuck checking, recap failures, token refresh failures, and live
monitor failures are imported from `scripts/rollback-drain-criteria.mjs`. Do not
copy those numbers into a second dashboard table.

Dashboard rows group by:

- `failure_class`
- `stage`
- `provider`
- `model`
- `deploy_sha`
- `latency_bucket`
- `usage_bucket`
- `cost_bucket`
- `terminal_reason`

The required artifact links are the hosted release evidence bundle, the hosted
browser story, and the rollback criteria embedded in release evidence. Indexed
rows may contain operational facts and sanitized event codes such as
`gemini_http_429`; they must not index raw audio, transcript text, learner
answers, prompts, unrestricted source excerpts, bearer/session tokens, provider
keys, or secrets.
