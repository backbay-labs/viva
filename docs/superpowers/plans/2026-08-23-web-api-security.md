# Web API Security Implementation Plan

> **For agentic workers:** use the Superpowers executing-plans workflow, complete one RED/GREEN task at a time, and stop at the D-04 and D-07 decision checkpoints. Do not change Rust protocol/service code, workflows, shared voice-contract files, or Plan 05's fixtures from this lane.

**Goal:** Make Viva's browser-facing BFF a bounded, canonical-origin, least-privilege trust boundary; add the authenticated study projection endpoint; and close the access-token refresh, destructive-capability replay, proxy token-leak, and per-instance admission gaps without changing learner-facing protocol authority in this lane.

**Architecture:** `apps/web/app/api/viva-session/shared.ts` remains the web-owned security kernel. Route handlers call it for strict token verification, canonical-origin checks, scoped service credentials, bounded body reads, trusted client-IP derivation, shared admission state, one-time destructive capabilities, and—only if D-07 Branch A is selected—rotating opaque refresh credentials. Under D-04 Branch B, the same shared store registers and consumes the one-time identity/deletion-bound restore capability returned after a durable soft delete. Public or horizontally scaled deployments use an authenticated shared `SessionSecurityStore` HTTP adapter and fail closed if it is unavailable; an in-memory adapter is legal only under `NODE_ENV=test` or when both web and agent origins are loopback and the deployment explicitly asserts one web instance. The library catch-all never relays agent-originated credential fields. The new projection route accepts a browser session credential, forwards it separately from the scoped service credential, validates `AuthenticatedStudyProjectionV1`, and returns only the validated read model.

**Tech Stack:** Next.js 16 App Router route handlers and Proxy, TypeScript 5.9, Bun test, Node `crypto`, Web Streams, shared types/validators from `@viva/core`.

**Spec:** Source reviews: [`web-api-proxy`](../reviews/2026-08-23-web-api-proxy.md), [`web-ui`](../reviews/2026-08-23-web-ui.md), [`security`](../reviews/2026-08-23-security.md), [`security-review`](../reviews/2026-08-23-security-review.md), [`architecture-consistency`](../reviews/2026-08-23-architecture-consistency.md), [`quality-and-tests-review`](../reviews/2026-08-23-quality-and-tests-review.md), [`comprehensive-review-summary`](../reviews/2026-08-23-comprehensive-review-summary.md), and the [review index](../reviews/index.md), reconciled through the [central finding/decision ledger](./2026-08-23-review-remediation-finding-coverage-ledger.md). Cross-plan contracts: [Plan 04](./2026-08-23-learning-core-authority.md), [Plan 05](./2026-08-23-voice-wire-auth-contract.md), [Plan 08](./2026-08-23-agent-service-runtime.md), [Plan 09](./2026-08-23-persistence-postgres-privacy.md), [Plan 10](./2026-08-23-web-session-audio.md), [Plan 13](./2026-08-23-frontend-accessibility-performance.md), [Plan 14](./2026-08-23-package-build-contracts.md), and [Plan 15](./2026-08-23-integrated-evidence-and-release-readiness.md).

---

## Global Constraints

This plan owns only these implementation surfaces:

- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify or delete, depending on D-07: `apps/web/app/api/viva-session/start/route.ts`
- Modify or delete, depending on D-07: `apps/web/app/api/viva-session/refresh/route.ts`
- Create: `apps/web/app/api/viva-session/projection/route.ts`
- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Create: `apps/web/proxy.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`
- Create: `apps/web/lib/viva-security-headers.test.ts`

Ownership note: `apps/web/proxy.ts` and `apps/web/lib/viva-security-headers.test.ts` are Plan 11-owned surfaces listed in the program's Section 4 exclusive-ownership table and acknowledged in Plan 14's cross-plan handoff matrix.

This plan consumes but never edits:

- `agent/fixtures/session-token/v1/vectors.json`, produced by [Plan 05](./2026-08-23-voice-wire-auth-contract.md).
- `agent/fixtures/voice-protocol/v5/auth-decision.json`, produced by Plan 05 after sponsor selection.
- The recorded D-04 selector in `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`; this lane reads the exact selector and never edits the ledger.
- `packages/core/src/study-projection-contract.ts`, produced by Plan 04. Import its `AuthenticatedStudyProjectionV1` and `validateAuthenticatedStudyProjectionV1` exports; do not duplicate its type or validator.
- Agent projection and scoped-credential behavior from [Plan 08](./2026-08-23-agent-service-runtime.md).
- Plan 09's durable D-04 `SoftDeleteReceiptV1`/`RestoreStudySetOutcomeV1` port and 30-second database-time undo contract. This lane validates and proxies it; it does not implement storage or finalization.

Plan 08's exact handoff is:

- Agent endpoint template: ``GET /v1/study-sets/${encodeURIComponent(studySetId)}/projection?voice_session_id=${encodeURIComponent(voiceSessionId)}``.
- Service credential: ``Authorization: Bearer ${process.env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN}`` after server-only validation.
- Session credential: ``X-Viva-Session-Token: ${verifiedAccessToken}``.
- The agent validates both, derives identity from verified claims, rejects a route/query identity mismatch, and never logs or reflects either header.

Plan 10's browser-session code consumes only:

- Browser endpoint template: ``GET /api/viva-session/projection?study_set_id=${encodeURIComponent(studySetId)}&voice_session_id=${encodeURIComponent(voiceSessionId)}``.
- Browser credential: ``Authorization: Bearer ${accessToken}``; never a URL, cookie, or request-body field.
- Success: the exact validated `AuthenticatedStudyProjectionV1` JSON body, `cache-control: no-store`.

Do not preserve `GET /api/viva-library/study-sets/library` as the final authenticated study/session read contract. It remains a bounded landing/library selection/control-capability surface while Plan 10 moves live session state to the projection endpoint; only D-07 Branch A attaches a session bootstrap capability.

**D-03 constraint:** `D-03 MODE_GOAL_CONTRACT` also touches this lane. Under a recorded D-03 Branch A, Plan 05 amends the session-token vectors to include mode/normalized-goal claims and this lane extends the start-request payload, bootstrap-capability claims, and access-token claim schema to mint/verify them; under Branch B no mode/goal field is added. Do not add either shape before the coordinator records D-03; the Task 2/Task 3 exact-claims enforcement follows whatever Plan 05's published vectors define at execution time, and any D-03-driven change arrives as a Plan 05 vector amendment, not a Node-side edit.

**Merge-order constraint:** this implementation lane consumes merged Plan 05 auth artifacts, Plan 08/09 HTTP/data contracts, and Plan 14 Phase 14A's production `@viva/core` export. Only D-07 Branch B additionally waits for Plan 13 Phase 13A's `apps/web/app/page.tsx` bootstrap cleanup SHA before deleting helpers/routes. Plan 11 must remain mergeable before Plan 10, Plan 13's UI phase, and Plan 14's build-configuration phase. Their browser/build/hosted acceptance is a reverse handoff to Plan 15, not a prerequisite for this lane's owner-local merge. This lane also rebases onto the integration tip containing the merged Plan 03 before its first edit to `apps/web/app/api/viva-library/[[...path]]/route.ts` or `apps/web/lib/viva-library-proxy.test.ts`; under D-01 Branch B, Plan 03 lands a temporary read-projection seam in those files (program Section 4, `apps/web/app/api/viva-*/**` row), and this lane extends, never recreates or reverts, that seam.

## Requirement ledger

| ID | Required outcome | Primary proof |
| --- | --- | --- |
| `WEBAPI-001` | D-07 (`TOKEN_ONLY_REFRESH`) is recorded before branch-specific code starts. | Decision command exits nonzero until exactly one branch is selected. |
| `WEBAPI-002` | Node verification consumes Plan 05's vectors byte-for-byte and matches Rust on padding, unknown claims, signature, expiry, and clock skew. | Table-driven route/verifier test over the read-only fixture. |
| `WEBAPI-003` | Canonical web origin is mandatory; bootstrap/control capabilities never carry `origin: null`. | SSR-style signing plus proxy/start/DELETE mismatch tests. |
| `WEBAPI-004` | Client IP comes only from direct metadata or an explicitly configured trusted proxy hop count. | Spoofed XFF prefix and missing-trust negative controls. |
| `WEBAPI-005` | Projection and, under D-07 Branch A, mint limits are atomic, bounded, shared, and fail closed in public/multi-instance mode. | Two-adapter concurrency tests and missing-store public rejection. |
| `WEBAPI-006` | Agent calls use read/delete scoped credentials plus D-07 Branch A's mint credential; D-07 Branch B removes web mint use. The legacy broad bearer cannot authorize public traffic. | Per-route header assertions, wrong-scope failures, and D-07 Branch B absence scan. |
| `WEBAPI-007` | Session, proxy request, proxy response, security-store response, and projection bodies have byte caps enforced during streaming. | Exact-limit, limit+1, multibyte, missing-length, cancellation, and concurrent hostile-stream tests. |
| `WEBAPI-008` | Every proxied JSON success/error is recursively stripped of agent-originated credentials before delivery. | Paste/file/retry/snapshot/control nested-token matrix. |
| `WEBAPI-009` | Destructive control capabilities are one-time; under D-07 Branch A, session/study-set deletion also revokes refresh authority before upstream deletion. | Replay, upstream-failure, session-delete, and study-set-delete tests. |
| `WEBAPI-010` | The authenticated projection BFF validates v1, binds identity, strips credentials, times out, aborts, limits, and sanitizes failures. | Focused projection malicious-response matrix. |
| `WEBAPI-011` | D-07 Branch A uses separate 256-bit opaque, hashed, rotating, one-time refresh credentials with a six-hour absolute lifetime. | Years-old access, replay, race, absolute-expiry, and deletion-revocation tests. |
| `WEBAPI-012` | D-07 Branch B removes browser token-only mint/refresh routes and requires a trusted service-authenticated replacement deployment. | Both routes absent, no bootstrap/refresh symbols in the built web tree, and the replacement handoff is proven before release. |
| `WEBAPI-013` | Weak/placeholder secrets fail configuration; active+previous verification supports rotation without signing with an old key. | Weak-secret table and old-key/new-key rotation tests. |
| `WEBAPI-014` | Paste/file/retry bodies are reconstructed from their exact accepted fields, and duplicate snapshot filtering/unreachable response branches are removed without changing sanitized semantics. | Exact request-shape matrix, characterization matrix, and source-structure assertion. |
| `WEBAPI-015` | Server-mode pages receive nonce-based CSP and defense headers; API responses receive no-store/nosniff. | Two-request nonce test, production header table, browser console check. |
| `WEBAPI-016` | D-04 executes exactly one recorded branch: confirmation plus permanent delete, or durable soft delete plus a one-time identity/deletion-bound restore capability whose deadline cannot be extended. | Executable ledger checkpoint; Branch A absence proof; Branch B replay/race/cross-user/expiry/upstream-failure matrix. |

## Exact public error semantics

No response or log may include an env name, credential, token hash, nonce, upstream URL, upstream body, upload bytes, user ID, study-set ID, or voice-session ID. Operator-only logs use coarse codes and deployment SHA.

| Condition | HTTP | `error` | `failure_class` | Other required fields |
| --- | ---: | --- | --- | --- |
| Malformed/unknown-field session request | 400 | `invalid_session_request` | `session_bootstrap_failed` | `token_refresh_outcome: "invalid"` |
| Noncanonical/missing origin on D-07 Branch A start/refresh | 403 | `cross_origin_session_request` | `access_denied` | `token_refresh_outcome: "blocked"` |
| Missing/weak canonical config or scoped secret | 503 | Route-specific `*_unavailable` | existing pre-loop class | `cache-control: no-store` |
| D-07 Branch A session shared-store unavailable | 503 | `viva_session_security_store_unavailable` | `session_bootstrap_unavailable` | `stage: "pre_loop"`, existing terminal reason |
| Projection shared-store unavailable | 503 | `viva_session_projection_unavailable` | `projection_unavailable` | `stage: "pre_loop"`; no retry hint. |
| Request body exceeds its cap | 413 | `viva_request_body_too_large` | route's pre-loop class | Never contact upstream. |
| Paste/file/retry JSON malformed, duplicated, or containing unknown/ignored identity fields | 400 | `viva_library_request_invalid` | `access_denied` | `stage: "pre_loop"`; never contact upstream or reflect a field/value. |
| Upstream body exceeds its cap | 502 | `viva_upstream_response_too_large` | route's pre-loop class | Cancel upstream stream. |
| Shared admission rejection | 429 | `session_mint_rate_limited` or `session_projection_rate_limited` | `rate_limit` | Integer `retry-after`, no raw bucket key. |
| Missing/wrong origin or invalid/replayed destructive capability | 403 | `viva_library_control_capability_required` | `access_denied` | Same body for malformed, expired, wrong origin/scope, replay. |
| Destructive security-store unavailable/ambiguous | 503 | `viva_library_control_unavailable` | `pre_loop_unavailable` | `stage: "pre_loop"`; never contact upstream. |
| D-04 Branch B soft-delete receipt invalid/oversized | 502 | `viva_library_restore_capability_unavailable` | `pre_loop_unavailable` | `stage: "pre_loop"`; no upstream detail or capability. |
| D-04 Branch B post-delete restore-capability registration unavailable/ambiguous | 503 | `viva_library_restore_capability_unavailable` | `pre_loop_unavailable` | `stage: "pre_loop"`; no raw capability; log only the coarse registration code. |
| D-04 Branch B restore body malformed/duplicated/unknown | 400 | `viva_library_restore_request_invalid` | `access_denied` | `stage: "pre_loop"`; never contact store or upstream. |
| D-04 Branch B restore body over 512 bytes | 413 | `viva_request_body_too_large` | `access_denied` | `stage: "pre_loop"`; never contact store or upstream. |
| D-04 Branch B restore capability malformed/expired/wrong origin/purpose/identity/deletion/replayed | 403 | `viva_library_control_capability_required` | `access_denied` | Identical body for every capability rejection; never contact upstream. |
| D-04 Branch B restore security-store unavailable/ambiguous | 503 | `viva_library_control_unavailable` | `pre_loop_unavailable` | Capability may already be consumed; never retry upstream automatically. |
| D-04 Branch B restore upstream not found | 404 | `viva_library_restore_not_found` | `access_denied` | BFF-authored body only; consumed capability remains revoked. |
| D-04 Branch B restore undo expired/finalized | 409 | `viva_library_restore_expired` | `access_denied` | BFF-authored body only; consumed capability remains revoked. |
| D-04 Branch B restore upstream invalid/oversized/other failure | 502 | `viva_library_restore_unavailable` | `pre_loop_unavailable` | `stage: "pre_loop"`; consumed capability remains revoked. |
| D-04 Branch A restore POST | 403 | `viva_library_control_scope_not_allowed` | `access_denied` | Catch-all rejects before store or upstream; no restore capability is minted. |
| Projection auth invalid/expired/mismatched | 401 | `session_auth_terminal` | `session_auth_failure` | `stage: "session"`, `token_refresh_outcome: "terminal"` |
| Projection query malformed/duplicated/extra | 400 | `viva_session_projection_request_invalid` | `projection_unavailable` | `stage: "pre_loop"` |
| Projection not found for verified identity | 404 | `viva_session_projection_not_found` | `projection_unavailable` | `stage: "pre_loop"` |
| Projection upstream timeout | 504 | `viva_session_projection_timeout` | `projection_unavailable` | `stage: "pre_loop"` |
| Projection invalid/oversized/upstream failure | 502 | `viva_session_projection_unavailable` | `projection_unavailable` | `stage: "pre_loop"` |
| D-07 Branch A refresh expired/replayed/revoked/absolute-expired | 401 | `session_auth_terminal` | `session_auth_failure` | `token_refresh_outcome: "terminal"`; operator code only in sanitized log. |
| D-07 Branch B browser start or refresh request | 404 | Next route not found | N/A | Neither route file exists; no redirect or compatibility response. |

---

### Task 1: Record D-04 and D-07 before branch-specific work (`WEBAPI-001`, `WEBAPI-016`)

**Files:**

- Read: this plan
- Read: `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`
- Read: `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md`
- Read: `docs/superpowers/plans/2026-08-23-agent-service-runtime.md`
- Read: `docs/superpowers/plans/2026-08-23-persistence-postgres-privacy.md`

The canonical D-04 selector comes only from the central ledger. Exactly `CONFIRM_DELETE` or `SOFT_DELETE_UNDO` is executable; `DECISION_REQUIRED`, an absent/duplicate row, or any other value exits 64. This lane does not select D-04.

Coordinator decisions land on the integration branch and Plan 05's fixture merges after `LANE_BASE_SHA`, so a stale lane-local checkout can misreport them as unrecorded. Before Step 1, run `git fetch --all --prune` and rebase this lane onto `review-remediation/integration` (or read the ledger via `git show review-remediation/integration:docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`) so coordinator-recorded decisions and the merged Plan 05 fixture are visible; re-run every checkpoint in this task after each rebase.

- [ ] **Step 1: Run the D-04 hard checkpoint**

```bash
D04_DELETION_UX="$(bun -e '
  const text = await Bun.file("docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md").text();
  const rows = text.split(/\r?\n/).filter((line) => /^\|\s*`D-04`\s*\|/.test(line));
  if (rows.length !== 1) process.exit(64);
  const cells = rows[0].split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", ""));
  const selected = cells[2];
  if (selected !== "CONFIRM_DELETE" && selected !== "SOFT_DELETE_UNDO") process.exit(64);
  console.log(selected);
')" || {
  echo "BLOCKED: D-04 DELETION_UX is not recorded as an executable selector" >&2
  exit 64
}
```

Expected before sponsor selection: exit 64 with the exact `BLOCKED` line. Expected afterward: print exactly one allowed selector.

The canonical decision ID is **D-07 `TOKEN_ONLY_REFRESH`**. It is the same topic the initial assignment called D-06; do not create a second decision row.

Exactly one recorded branch is legal:

- `retain-token-only`: retain token-only public mode, add Plan 08 pre-upgrade signature/expiry verification, retain first-frame atomic nonce consumption, and execute Branch A below.
- `require-service-auth`: remove token-only public mode, delete the browser start and refresh endpoints plus their bootstrap/refresh capability paths, require a trusted shared-bearer service replacement, and execute Branch B below.

- [ ] **Step 2: Run the D-07 hard checkpoint**

```bash
test -f agent/fixtures/voice-protocol/v5/auth-decision.json || {
  echo "BLOCKED: Plan 05 has not published D-07 auth-decision.json" >&2
  exit 64
}
D07_TOKEN_ONLY_REFRESH="$(bun -e '
    const value = await Bun.file("agent/fixtures/voice-protocol/v5/auth-decision.json").json();
    if (value.decision !== "D-07 TOKEN_ONLY_REFRESH") process.exit(64);
    const expected = value.branch === "retain-token-only"
      ? {
          decision: "D-07 TOKEN_ONLY_REFRESH",
          branch: "retain-token-only",
          direct_browser_wss: true,
          preupgrade_auth: "signed_session_access_token",
          first_frame_auth: "same_signed_session_access_token",
          refresh_mode: "rotating_one_time_hashed_credential",
          browser_refresh_absolute_lifetime_required: true,
          in_socket_token_refresh: false,
        }
      : value.branch === "require-service-auth"
        ? {
            decision: "D-07 TOKEN_ONLY_REFRESH",
            branch: "require-service-auth",
            direct_browser_wss: false,
            preupgrade_auth: "shared_service_bearer",
            first_frame_auth: "signed_session_access_token",
            refresh_mode: "service_authenticated_replacement",
            browser_refresh_absolute_lifetime_required: false,
            in_socket_token_refresh: false,
          }
        : null;
    if (!expected) process.exit(64);
    const actualKeys = Object.keys(value).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) process.exit(64);
    if (expectedKeys.some((key) => value[key] !== expected[key])) process.exit(64);
    console.log(value.branch);
  '
)" || exit 64
case "$D07_TOKEN_ONLY_REFRESH" in
  retain-token-only|require-service-auth) ;;
  *) echo "BLOCKED: invalid recorded D-07 branch" >&2; exit 64 ;;
esac
```

Expected before the sponsor selection/Plan 05 publication: exit 64 with a `BLOCKED` line. Consumers read `auth-decision.json`; they never infer or re-decide D-07 from deployment environment.

The ledger's coordinator decision registry also lists `D-05` (learner-data retention/purge semantics) with `WEBAPI-009` and `WEBAPI-016` in its Blocks column. This lane does not select D-05.

- [ ] **Step 2b: Run the D-05 checkpoint for delete-receipt-shaped assertions**

```bash
D05_DATA_RETENTION="$(bun -e '
  const text = await Bun.file("docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md").text();
  const rows = text.split(/\r?\n/).filter((line) => /^\|\s*`D-05`\s*\|/.test(line));
  if (rows.length !== 1) process.exit(64);
  const cells = rows[0].split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", ""));
  const selected = cells[2];
  if (!selected || selected === "DECISION_REQUIRED") process.exit(64);
  console.log(selected);
')" || {
  echo "BLOCKED: D-05 data retention is not recorded as an executable selector" >&2
  exit 64
}
```

Expected before sponsor selection: exit 64 with the exact `BLOCKED` line. This checkpoint gates only D-05-dependent work: Tasks 2–7 may proceed while D-05 is unrecorded, **except** that Task 7's and Task 7A's assertions on the upstream delete-response body shape (the selected D-05 permanent-delete receipt, and the absence of undo fields under D-04 Branch A) are blocked from GREEN until the coordinator records D-05. Never guess or invent the permanent-delete receipt shape.

- [ ] **Step 3: Select the executable task path**

```bash
case "$D04_DELETION_UX:$D07_TOKEN_ONLY_REFRESH" in
  CONFIRM_DELETE:retain-token-only) echo "Execute Tasks 2-7, 7A, 8A, 9, 10, and 11; skip 7B and 8B" ;;
  CONFIRM_DELETE:require-service-auth) echo "Execute Tasks 2-7, 7A, 8B, 9, 10, and 11; skip 7B and 8A" ;;
  SOFT_DELETE_UNDO:retain-token-only) echo "Execute Tasks 2-7, 7B, 8A, 9, 10, and 11; skip 7A and 8B" ;;
  SOFT_DELETE_UNDO:require-service-auth) echo "Execute Tasks 2-7, 7B, 8B, 9, 10, and 11; skip 7A and 8A" ;;
  *) echo "BLOCKED: invalid D-04/D-07 decision matrix" >&2; exit 64 ;;
esac
```

Expected: one branch line only. Never implement or merge both alternatives for either decision.

No commit is created for the checkpoint.

### Task 2: Pin strict Node auth behavior to Plan 05 vectors (`WEBAPI-002`, `WEBAPI-013`)

**Files:**

- Modify: `apps/web/lib/viva-session-api.test.ts`
- Modify: `apps/web/app/api/viva-session/shared.ts`
- Read only: `agent/fixtures/session-token/v1/vectors.json`

- [ ] **Step 1: Write the failing vector test**

Load the fixture with `readFileSync(new URL("../../../agent/fixtures/session-token/v1/vectors.json", import.meta.url), "utf8")`. Its exact schema is:

```ts
type SessionTokenVectorsV1 = {
  version: 1;
  fake_secret_base64: string;
  clock_unix_seconds: number;
  cases: Array<{
    id: string;
    token: string;
    claims: Record<string, unknown> | null;
    valid: boolean;
    rejection: string | null;
  }>;
};
```

Require `version === 1` and `fake_secret_base64 === "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="`, then decode it to the exact bytes `0x00..0x1f`. Iterate every case without filtering; do not copy a token or secret into the test file. Pass expected binding `{ user_id: "fixture-user", study_set_id: "fixture-study-set", session_id: "fixture-session" }`, fixture clock, and `clockSkewSeconds: 0`. Assert valid cases deep-equal `claims`; invalid cases return the exact closed rejection. The fixture covers padded claims/signature, noncanonical alphabet, unknown top/nested claims, bad HMAC, malformed/duplicate JSON, `nbf`/`exp`/time ordering, three identity bindings, and empty nonce. Add a mutation control that flips one signature byte and must fail. Report Plan 05 manifest ID `VOICE-TOKEN-V1-VECTORS`; any fixture change returns to Plan 05 rather than being normalized in Node.

The production verifier must expose this result, not throw:

```ts
type FailureControlScenario =
  | "provider_rate_limited"
  | "provider_auth_failed"
  | "provider_timeout"
  | "silent_stall"
  | "provider_malformed_stream"
  | "provider_network_disconnect"
  | "sonic_tts_timeout"
  | "recap_timeout"
  | "invalid_token"
  | "expired_token"
  | "replayed_token"
  | "malformed_token"
  | "slow_stale_socket_close"
  | "double_submit_race"
  | "mic_denied"
  | "typed_fallback";

export type SessionTokenClaims = {
  user_id: string;
  study_set_id: string;
  session_id: string;
  issued_at: number;
  not_before: number;
  expires_at: number;
  nonce: string;
  failure_control?: {
    scenario: FailureControlScenario;
    run_id: string;
    expires_at: number;
    nonce: string;
    signature: string;
  };
};

export type VivaSessionAccessTokenVerification =
  | { ok: true; claims: SessionTokenClaims }
  | {
      ok: false;
      reason:
        | "binding_mismatch"
        | "duplicate_claim"
        | "expired"
        | "invalid_signature"
        | "invalid_time_order"
        | "malformed_json"
        | "missing_claim"
        | "noncanonical_base64url"
        | "not_yet_valid"
        | "unknown_claim";
    };

export function verifyVivaSessionAccessToken(input: {
  token: string;
  secretBytes: Uint8Array;
  now: number;
  expectedBinding: { user_id: string; study_set_id: string; session_id: string };
  clockSkewSeconds: number;
}): VivaSessionAccessTokenVerification;
```

Reject unknown claim keys at the top level and inside `failure_control` exactly as Rust's `deny_unknown_fields` does. Require nonempty identity/nonce/control strings, the closed scenario union, and nonnegative safe-integer timestamps. Require canonical unpadded base64url: decoding and re-encoding must reproduce the original segment byte-for-byte. Production route wrappers load active/previous env secrets and call this pure verifier with `clockSkewSeconds: 0`; Plan 05's contract is `not_before <= now < expires_at`, with no Node-only grace.

The verifier is bounded and ordered: reject a token over 4,096 UTF-8 bytes as `malformed_json`; require exact `viva1.<claims>.<signature>` framing; canonical-decode both segments; verify the 32-byte HMAC in constant time; fatal-decode UTF-8; scan the claims JSON with a small string/escape/nesting-aware tokenizer that records object keys and returns `duplicate_claim` before `JSON.parse`; then enforce exact shapes, time order/window, and binding. Do not use a regex or `JSON.parse` alone for duplicate detection. The exact Plan 05 vector rejection wins at every precedence boundary. Route responses never expose this closed internal reason; they map to the coarse public table.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-session-api.test.ts --test-name-pattern "Plan 05 session-token vectors"
```

Expected: FAIL because the current Node decoder accepts padded base64url/unknown claims and the fixture is not consumed.

- [ ] **Step 3: Implement strict verification and secret validation**

Add one strict claims parser and one constant-time HMAC verifier. Projection always calls it; D-07 Branch A start/refresh also call it. D-07 Branch B removes start/refresh in Task 8B. Tests may not sign expected tokens with the same function they are testing.

Add `validatedSecret(name)` with these exact checks:

- UTF-8 byte length is at least 32.
- Reject case-insensitive exact values `secret`, `password`, `changeme`, `change-me`, `placeholder`, `example`, and `test`.
- Reject angle-bracket placeholders and a value made from one repeated byte.
- Never log the value, a prefix, its length, or the env name in a request failure.

Call it for the active/previous HMAC keys, all three scoped agent bearers, and `VIVA_SESSION_SECURITY_STORE_REST_TOKEN`; do not leave presence-only validation on any web-owned credential. Convert HMAC env strings to UTF-8 bytes exactly once after validation. The scoped bearers and store token remain opaque strings and must also be at most 512 UTF-8 bytes so an operator mistake cannot create unbounded headers.

Use `VIVA_VOICE_SESSION_TOKEN_PREVIOUS_SECRET` as verify-only during rotation; sign nothing with it. Use the same active/previous rule for `VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET` and `VIVA_SESSION_BOOTSTRAP_TOKEN_PREVIOUS_SECRET`.

- [ ] **Step 4: Run GREEN and the negative control**

```bash
bun test apps/web/lib/viva-session-api.test.ts --test-name-pattern "Plan 05 session-token vectors|rejects weak secrets|accepts previous verification key"
```

Expected: PASS. Then temporarily invert the expected valid-vector result; the test must fail. Revert the mutation immediately.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/viva-session/shared.ts apps/web/lib/viva-session-api.test.ts
git commit -m "test(web): pin session auth to shared vectors"
```

### Task 3: Enforce canonical origin and scoped agent credentials (`WEBAPI-003`, `WEBAPI-006`, `WEBAPI-013`)

**Files:**

- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`
- Read only: `apps/web/app/page.tsx` (exclusive Plan 13 ownership)

- [ ] **Step 1: Write failing origin/config tests**

Add these cases:

1. No `VIVA_WEB_CANONICAL_ORIGIN` on a public agent URL: start, snapshot, projection, and DELETE fail before `fetch`.
2. Canonical value with credentials, path, query, fragment, public `http:`, or non-origin text: 503.
3. Capability minted by an SSR-style call with no `origin` argument still contains the configured non-null canonical origin.
4. Same token passes at the canonical origin; an `Origin`, `Host`, `Forwarded`, or `X-Forwarded-Proto` spoof cannot change it.
5. A token minted under `VIVA_SESSION_BOOTSTRAP_TOKEN_PREVIOUS_SECRET` verifies during rotation, while new tokens verify only with the active key.
6. Public snapshot/start/delete fail when their exact scoped bearer is missing, even if `VIVA_AGENT_REST_BEARER_TOKEN` is present.
7. Bootstrap/control tokens with padded segments, duplicate/unknown claims, nullable/missing origin, invalid purpose/scope, or a non-safe-integer expiry all reject with the same coarse route body and no store/agent call.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts --test-name-pattern "canonical origin|scoped service credential|legacy REST bearer"
```

Expected: FAIL because origin is nullable/derived three ways and the broad bearer authorizes multiple scopes.

- [ ] **Step 3: Implement one origin authority**

Add:

```ts
type CanonicalWebOrigin = { origin: string };

function canonicalWebOrigin():
  | { ok: true; value: CanonicalWebOrigin }
  | { ok: false; reason: "missing" | "invalid" | "insecure_public" };
```

`VIVA_WEB_CANONICAL_ORIGIN` must equal `new URL(value).origin`, with no credentials/path/query/hash. Public origins require `https:`; `http:` is legal only for `localhost`, `127.0.0.0/8`, or `[::1]`. Signing helpers always source `claims.origin` from this function and no longer accept nullable origin authority from a caller. Mutating routes require an exact `Origin` match and `Sec-Fetch-Site` absent or `same-origin`. Safe authenticated GET projection requires `Sec-Fetch-Site: same-origin`; non-browser callers must send the exact `Origin`.

Bootstrap/control capabilities keep their existing five-minute TTL but make `origin: string` required. Reuse the bounded canonical segment decoder and duplicate-key scanner from Task 2; enforce exact top-level keys for each capability, the exact purpose/scope, canonical unpadded HMAC, safe-integer expiry, and nonempty identity/nonce strings. Bootstrap `session_id` may be null; control `voice_session_id` is null only for study-set deletion. Verification tries active then previous bootstrap keys, always signs with active, and maps every structural/signature/expiry/origin failure to the same coarse public capability error.

- [ ] **Step 4: Implement exact credential scope selection**

```ts
type AgentCredentialScope = "library_read" | "session_mint" | "library_delete";

const AGENT_SCOPE_ENV = {
  library_read: "VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN",
  session_mint: "VIVA_AGENT_SESSION_MINT_BEARER_TOKEN",
  library_delete: "VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN",
} as const;
```

Apply:

- Browser library snapshot and projection -> `library_read`.
- `/api/viva-session/start` and D-07 Branch A refresh upstream mint -> `session_mint`.
- Signed same-origin DELETE -> `library_delete`.
- Public paste/file/retry remains separately authorized by its ingestion contract; never silently inject read/mint/delete authority.

Task 8B deletes the web `session_mint` selector together with both browser mint routes; D-07 Branch B's separately owned trusted service consumes that scoped credential instead.

`VIVA_AGENT_REST_BEARER_TOKEN` is migration input only. Permit it only when `VIVA_ALLOW_LEGACY_AGENT_REST_BEARER=1` **and** the agent URL is loopback. Reject that escape hatch for a public agent URL. Plan 08 must land its audience/scope enforcement before public deployment of these scoped variables.

- [ ] **Step 5: Run GREEN**

```bash
bun test apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts --test-name-pattern "canonical origin|scoped service credential|legacy REST bearer"
```

Expected: PASS; captured upstream headers contain exactly the expected scoped bearer and canonical `Origin`, never another scope.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/viva-session/shared.ts 'apps/web/app/api/viva-library/[[...path]]/route.ts' apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts
git commit -m "feat(web): enforce canonical scoped API authority"
```

### Task 4: Add shared bounded security state and trusted IP admission (`WEBAPI-004`, `WEBAPI-005`)

**Files:**

- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`

- [ ] **Step 1: Write failing adapter and malicious-IP tests**

Cover:

- Public URL + missing `VIVA_SESSION_SECURITY_STORE_REST_URL` or `VIVA_SESSION_SECURITY_STORE_REST_TOKEN` -> exact route-specific 503 from the error table before agent fetch; cover D-07 Branch A start/refresh, projection, and DELETE.
- Public URL + `VIVA_SESSION_SECURITY_STORE_MODE=memory` -> 503.
- Loopback production memory mode requires `VIVA_WEB_SINGLE_INSTANCE=1`; missing/false/invalid values reject. That assertion never overrides a public origin/agent URL.
- Store timeout, non-2xx, invalid JSON, or >16 KiB response -> 503; never fall back to memory.
- Store URL with credentials/path/query/fragment or insecure public HTTP -> 503 before store/agent fetch.
- Two independently constructed route/store adapters share one atomic mint limit; the N+1 request is 429.
- Concurrent requests against the final slot admit exactly one.
- `VIVA_SESSION_TRUSTED_PROXY_HOPS=1` chooses the right-most XFF entry; rotating attacker-controlled left prefixes cannot create buckets.
- `VIVA_SESSION_TRUSTED_PROXY_HOPS=2` chooses the second entry from the right.
- Unset/invalid/zero hops or too-short XFF fails closed on public traffic; App Router exposes no trusted peer socket address, so public direct-origin mode is unsupported.
- Loopback/test memory mode prunes expired records, refuses active-record eviction at 10,000 entries, and returns unavailable rather than growing.
- Clocked 100k-key capacity test: drive 100,000 unique rate-limit keys through the in-memory adapter under a controlled fake clock, advancing past window expiry in batches; assert expired keys are pruned so the map never exceeds its 10,000-active-record bound, that with 10,000 concurrently active records a new key returns unavailable instead of growing, and that surviving buckets still enforce their atomic limits. Name the test so it satisfies the ledger's `WEBAPI-005` "100k-key clocked test" proof.
- `VIVA_SESSION_MINT_MAX_PER_MINUTE` accepts only an integer 1-120 (default 12); `VIVA_SESSION_PROJECTION_MAX_PER_MINUTE` accepts only an integer 1-600 (default 60). An explicitly present invalid value fails configuration instead of falling back.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts --test-name-pattern "shared security store|trusted proxy|atomic shared rate"
```

Expected: FAIL because the current process-local map and auto-trusted headers bypass these controls.

- [ ] **Step 3: Define the web-owned interface**

D-07 Branch A implements all four methods. D-07 Branch B narrows its runtime dependency to `Pick<SessionSecurityStore, "revokeSession" | "incrementRateLimit">` and must not retain any browser refresh route/caller. The full interface remains the exact web-owned shared-store contract required by D-07 Branch A; do not make its methods optional. `revokeSession` is deliberately the sole destructive-capability transaction primitive: it consumes delete authority while revoking refresh state, and under D-04 Branch B it also registers/consumes restore authority. Do not add a process-local restore map or a fifth store method.

```ts
type SessionIdentity = {
  userId: string;
  studySetId: string;
  sessionId: string;
};

export interface SessionSecurityStore {
  consumeRefresh(input: {
    credentialHash: string;
    identity: SessionIdentity;
    nowSeconds: number;
    reservationTtlSeconds: 10;
  }): Promise<
    | { ok: true; absoluteExpiresAt: number; rotationId: string }
    | { ok: false; reason: "expired" | "identity_mismatch" | "replayed" | "revoked" | "unavailable" }
  >;

  rotateRefresh(input:
    | {
        mode: "issue";
        identity: SessionIdentity;
        credentialHash: string;
        refreshExpiresAt: number;
        absoluteExpiresAt: number;
      }
    | {
        mode: "rotate";
        identity: SessionIdentity;
        rotationId: string;
        credentialHash: string;
        refreshExpiresAt: number;
        absoluteExpiresAt: number;
      }
  ): Promise<{ ok: true } | { ok: false; reason: "conflict" | "unavailable" }>;

  revokeSession(input:
    | {
        operation: "consume_delete_and_revoke";
        capabilityHash: string;
        capabilityExpiresAt: number;
        nowSeconds: number;
        purpose: "session_history_delete" | "study_set_delete";
        scope:
          | { kind: "session"; identity: SessionIdentity }
          | { kind: "study_set"; userId: string; studySetId: string };
      }
    | {
        operation: "register_restore";
        capabilityHash: string;
        capabilityExpiresAt: number;
        nowSeconds: number;
        purpose: "library_restore";
        scope: { kind: "restore"; userId: string; studySetId: string; deletionId: string };
      }
    | {
        operation: "consume_restore";
        capabilityHash: string;
        capabilityExpiresAt: number;
        nowSeconds: number;
        purpose: "library_restore";
        scope: { kind: "restore"; userId: string; studySetId: string; deletionId: string };
      }
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "conflict" | "expired" | "replayed" | "scope_mismatch" | "unavailable" }
  >;

  incrementRateLimit(input: {
    keys: readonly [string, string];
    limit: number;
    nowMs: number;
    windowMs: 60_000;
  }): Promise<
    | { ok: true; remaining: number; resetAtMs: number }
    | { ok: false; reason: "limited" | "unavailable"; resetAtMs?: number }
  >;
}
```

`consumeRefresh` is a 10-second atomic reservation, not a read-then-write check. A concurrent call while reserved rejects as the losing race without canceling the winner's reservation. After rotation, reuse of the consumed tombstone atomically marks every current/future refresh record for that session identity revoked through absolute expiry before returning `replayed`; the replacement credential from the prior success must then fail `revoked`. If agent minting fails before `rotateRefresh`, the store releases the reservation at its TTL so a transport failure does not permanently strand the learner. `rotateRefresh` must compare the reservation ID and retain the old hash as a replay tombstone until absolute expiry.

`revokeSession(operation: "consume_delete_and_revoke")` atomically consumes the destructive capability hash and revokes all matching refresh records before the upstream DELETE. A failed upstream DELETE may leave credentials revoked; that is the safe direction and the next library snapshot can issue a fresh delete capability. Under D-04 Branch B, `register_restore` atomically creates an unconsumed record keyed by SHA-256 capability hash and stores exact purpose, user, study set, deletion ID, expiry, and consumed state; the raw signed token never crosses the adapter boundary. `consume_restore` compares and consumes that entire tuple in one transaction. It returns `expired` at `nowSeconds >= capabilityExpiresAt`, `scope_mismatch` for any tuple mismatch, and `replayed` for an already-consumed hash. `register_restore` rejects an existing hash/tuple as `conflict`. The route maps every non-`unavailable` consume rejection to the same public 403 and every registration failure to the coarse post-delete 503; it never falls back to memory or returns an unregistered token.

Select the in-memory adapter only when `NODE_ENV === "test"`, or when the canonical web origin and agent URL are both loopback **and** `VIVA_WEB_SINGLE_INSTANCE === "1"`. Any public URL or absent single-instance assertion selects the HTTP adapter and fails 503 when its two required env values are absent. The in-memory adapter is never an automatic fallback after HTTP failure.

- [ ] **Step 4: Implement the exact HTTP adapter**

POST to `${VIVA_SESSION_SECURITY_STORE_REST_URL}/v1/session-security` with `Authorization: Bearer ${validatedSecret("VIVA_SESSION_SECURITY_STORE_REST_TOKEN")}`, `Content-Type: application/json`, and `Accept: application/json`. The exact JSON envelope is below. All three destructive sub-operations travel as `operation: "revoke_session"`; the nested `input.operation` discriminator is mandatory and exact.

```ts
type SessionSecurityStoreRequest = {
  schema_version: 1;
  request_id: string; // canonical lowercase UUID v4
} & (
  | {
      operation: "consume_refresh";
      input: Parameters<SessionSecurityStore["consumeRefresh"]>[0];
    }
  | {
      operation: "rotate_refresh";
      input: Parameters<SessionSecurityStore["rotateRefresh"]>[0];
    }
  | {
      operation: "revoke_session";
      input: Parameters<SessionSecurityStore["revokeSession"]>[0];
    }
  | {
      operation: "increment_rate_limit";
      input: Parameters<SessionSecurityStore["incrementRateLimit"]>[0];
    }
);

type SessionSecurityStoreResponse =
  | {
      schema_version: 1;
      request_id: string;
      operation: "consume_refresh";
      result: Awaited<ReturnType<SessionSecurityStore["consumeRefresh"]>>;
    }
  | {
      schema_version: 1;
      request_id: string;
      operation: "rotate_refresh";
      result: Awaited<ReturnType<SessionSecurityStore["rotateRefresh"]>>;
    }
  | {
      schema_version: 1;
      request_id: string;
      operation: "revoke_session";
      result: Awaited<ReturnType<SessionSecurityStore["revokeSession"]>>;
    }
  | {
      schema_version: 1;
      request_id: string;
      operation: "increment_rate_limit";
      result: Awaited<ReturnType<SessionSecurityStore["incrementRateLimit"]>>;
    };
```

Require exact keys recursively, matching operation, and an exact request-ID echo. The configured store value must equal its parsed URL origin: no credentials, path, query, or fragment; public values require `https:`, while `http:` is loopback-only. Set `cache: "no-store"`, `redirect: "error"`, a 2,000 ms abort deadline, a 16 KiB response cap, and strict response-shape validation. Hash credentials with SHA-256 before the adapter sees them. Hash PII-bearing rate keys before sending them. Never automatically retry a state-changing command. A timeout is an ambiguous commit and fails closed: a refresh reservation may be retried only after its 10-second TTL; an ambiguous rotate returns no credentials and requires a fresh start/replacement flow; an ambiguous destructive consume performs no upstream DELETE and requires a newly minted capability.

- [ ] **Step 5: Implement trusted client identity and atomic limiting**

`VIVA_SESSION_TRUSTED_PROXY_HOPS` is a required integer 1-5 in public mode. Split XFF, trim every entry, reject empty/invalid IP literals, require at least N entries, and take `entries.at(-N)`; deployment must prevent direct origin access and overwrite/append XFF according to that declared topology. Because Next App Router does not expose the trusted peer socket address to a route handler, `0` is legal only in test or all-loopback single-instance mode, where all requests use one literal `loopback` bucket and forwarding headers are ignored.

- Never auto-trust `x-real-ip`, `true-client-ip`, Cloudflare, or Vercel headers without the selected topology.

For `mint`, increment both `sha256("mint\0ip\0" + ip)` and `sha256("mint\0identity\0" + user + "\0" + studySet)`. For `projection`, increment both `sha256("projection\0ip\0" + ip)` and `sha256("projection\0session\0" + user + "\0" + studySet + "\0" + session)`. Each pair is atomic: the store increments both or neither and sets expiry to the fixed 60-second window boundary. Mint uses the validated 1-120 value/default 12. Projection uses the validated 1-600 value/default 60. Their counters can never consume or reset each other's capacity.

- [ ] **Step 6: Run GREEN**

```bash
bun test apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts --test-name-pattern "shared security store|trusted proxy|atomic shared rate"
```

Expected: PASS. A deliberate fake-store change from atomic to sequential increment must make the concurrency test fail.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/viva-session/shared.ts apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts
git commit -m "feat(web): share bounded session security state"
```

### Task 5: Bound every route body and normalize error paths (`WEBAPI-007`, `WEBAPI-014`)

**Files:**

- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`

- [ ] **Step 1: Write failing byte-budget tests**

Use streaming bodies, not a prebuilt large string:

- Session request: exactly 16 KiB accepted if valid JSON; 16 KiB + 1 rejected 413.
- Session upstream library/mint response: exactly 1 MiB accepted; +1 cancels and returns 502.
- Library proxy request: exactly 2 MiB accepted; +1 over uneven chunks returns 413 without upstream fetch.
- Library proxy response: exactly 2 MiB accepted; +1 cancels and returns 502.
- D-04 Branch B restore request: exact valid JSON at 512 bytes is accepted; 513 bytes returns 413 without security-store/upstream calls. Soft-delete and restore JSON responses accept at most 16 KiB; +1 cancels and returns the route-specific sanitized 502.
- Paste accepts exactly `{ title, course?, exam_date?, pasted_text }`; file upload accepts exactly `{ title, course?, exam_date?, file_name, content_type?, file_base64 }`; file retry accepts exactly `{ file_name, content_type?, file_base64 }`. Missing required, duplicate, unknown, `user_id`, `study_set_id`, `session_id`, server-status, or server-authority fields return the exact 400 without fetch. Valid input is field-by-field reconstructed before forwarding.
- Projection response: exactly 1 MiB accepted if valid v1 JSON; +1 cancels and returns 502.
- A multibyte UTF-8 body is counted by bytes, not JavaScript string length.
- A lying or missing `content-length` cannot bypass streaming count; an already-too-large content length rejects before reading.
- Timeout and byte-limit cancellation release the reader once and do not retain prior chunks across the next request.
- Four concurrent hostile streams all settle under the route deadline and do not call upstream after a request overflow.
- Every exact-limit success and every failure above carries route-owned no-store/pragma/nosniff headers and no upstream cookie/auth/cache header.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts --test-name-pattern "body byte cap|oversized upstream|multibyte body|concurrent hostile"
```

Expected: FAIL because `request.json`, string concatenation, `response.json`, and `arrayBuffer` are unbounded.

- [ ] **Step 3: Implement one bounded reader**

```ts
export const WEB_API_BODY_LIMITS = {
  libraryRequest: 2 * 1024 * 1024,
  libraryResponse: 2 * 1024 * 1024,
  projectionResponse: 1 * 1024 * 1024,
  restoreRequest: 512,
  restoreUpstreamResponse: 16 * 1024,
  securityStoreResponse: 16 * 1024,
  sessionRequest: 16 * 1024,
  sessionUpstreamResponse: 1 * 1024 * 1024,
} as const;

export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  options: { contentLength: string | null; limit: number; signal: AbortSignal },
): Promise<Uint8Array>;
```

Reject an invalid/negative content length, reject a declared length over limit before acquiring the reader, track `Uint8Array.byteLength`, cancel on limit/abort, and concatenate once after EOF. Parse JSON from one fatal `TextDecoder("utf-8", { fatal: true })`. Never include decoder/parser messages in responses.

- [ ] **Step 4: Collapse duplicate/dead response control flow**

In the library proxy:

- Fatal-decode and duplicate-key-aware parse paste/file/retry JSON, validate the exact route-specific keys/types, and serialize only a field-by-field reconstructed object. Never forward ignored browser identity/authority fields merely because the agent currently ignores them.
- Thread the single `snapshotFilter` returned by authorization; delete `browserLibrarySnapshotFilter` recomputation.
- Remove the unreachable post-terminal snapshot error branch.
- Route every upstream response through one bounded response builder.
- Preserve upstream 400/422 only after bounded parsing and credential stripping; sanitize other pre-loop failures exactly as the error table states.
- Keep timeout active until bounded body reading, filtering, and serialization finish.

Every web-owned API response builder—success or error—sets `cache-control: no-store`, `pragma: no-cache`, and `x-content-type-options: nosniff`. It constructs headers from a route-owned allowlist and never clones upstream cache/cookie/auth headers.

- [ ] **Step 5: Run GREEN**

```bash
bun test apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts
```

Expected: PASS. Also run:

```bash
test "$(rg -n "browserLibrarySnapshotFilter|isBrowserLibrarySnapshotRequest\(request.method, path\) && !response.ok" 'apps/web/app/api/viva-library/[[...path]]/route.ts' | wc -l | tr -d ' ')" = 0
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/viva-session/shared.ts 'apps/web/app/api/viva-library/[[...path]]/route.ts' apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts
git commit -m "fix(web): bound API bodies and unify proxy failures"
```

### Task 6: Strip credentials from every proxied JSON response (`WEBAPI-008`)

**Files:**

- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`

- [ ] **Step 1: Write the failing response matrix**

For 200/201/400/401/403/409/422/500 JSON responses on snapshot, paste, files, file retry, and DELETE routes, inject direct and deeply nested:

```json
{
  "session_token": "viva1.raw",
  "control_token": "raw-control",
  "refresh_token": "viva-refresh1.raw",
  "authorization": "Bearer raw",
  "nested": [
    { "Access_Token": "viva1.raw-nested" },
    { "message": "upstream reflected Bearer raw-in-text" }
  ],
  "safe": "preserved"
}
```

Assert every credential key/value is absent and `safe` survives whenever the route intentionally preserves upstream JSON. Inject upstream `authorization`, `set-cookie`, `www-authenticate`, and `x-api-key` response headers and assert none is copied; the rebuilt browser response allowlists only content type plus route-owned cache/security/rate headers. Separately assert BFF-minted `same_origin_control_token` remains in the allowed filtered library snapshot; `session_bootstrap_token` remains only under D-07 Branch A and Task 8B proves its complete removal. Under D-04 Branch B, an upstream-injected `restore_control_token` is removed and only the later BFF-minted value may appear. Non-JSON response bytes/content type remain byte-identical and bounded.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-library-proxy.test.ts --test-name-pattern "strips agent credentials from every proxied JSON response"
```

Expected: FAIL on successful create responses and preserved validation errors.

- [ ] **Step 3: Implement order-sensitive filtering**

For every JSON content type, bounded-read and parse first, then recursively sanitize before any allowlist/capability work. Compare keys case-insensitively: remove `api_key`, `authorization`, `credential`, `password`, `private_key`, `secret`, `token`, and every key ending in `_token` (including any upstream `session_bootstrap_token`, `same_origin_control_token`, or `restore_control_token`). Replace any string containing a `Bearer ` credential or the prefixes `viva1.`, `viva-bootstrap1.`, `viva-control1.`, or `viva-refresh1.` with `"[redacted]"`; never run token-shaped regexes over serialized JSON. Then apply snapshot allowlist filtering, then mint the BFF control capability and, only under D-07 Branch A, the bootstrap capability. Under D-04 Branch B, validate a stripped soft-delete receipt, mint/register the restore capability, and attach `restore_control_token` only after stripping and store success. Never run the strip pass after a BFF capability attachment, because those newly minted outputs are intended browser-safe capabilities. JSON-expected routes with a non-JSON upstream content type return sanitized 502 rather than relaying ambiguous bytes; explicitly binary/export routes retain bounded byte pass-through.

`/api/viva-session/start` and D-07 Branch A refresh deliberately return BFF-issued access/refresh credentials and are not library-proxy responses; do not apply this stripping helper to their success bodies.

- [ ] **Step 4: Run GREEN**

```bash
bun test apps/web/lib/viva-library-proxy.test.ts
```

Expected: PASS. Mutate the key predicate so `_token` suffixes are allowed; the matrix must fail on `session_token`/`Access_Token`. Revert immediately.

- [ ] **Step 5: Commit**

```bash
git add 'apps/web/app/api/viva-library/[[...path]]/route.ts' apps/web/lib/viva-library-proxy.test.ts
git commit -m "fix(web): strip credentials from all proxy JSON"
```

### Task 7: Consume destructive capabilities once and revoke sessions (`WEBAPI-009`)

**Files:**

- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`

- [ ] **Step 1: Write failing destructive tests**

Add:

1. The same valid study-set control token used twice: first reaches upstream, second returns the same 403 as any invalid capability and makes no fetch.
2. Two concurrent DELETEs with one token: exactly one reaches upstream.
3. Under D-07 Branch A, session delete revokes only the matching session refresh record.
4. Under D-07 Branch A, study-set delete revokes every refresh record under the verified user/study-set.
5. Under D-07 Branch A, revocation occurs before upstream DELETE; an upstream 500 leaves refresh rejected. Under D-07 Branch B, the same store command atomically consumes the destructive capability with no refresh-record side effect.
6. Security-store failure returns 503 and never performs upstream DELETE.
7. A missing/wrong canonical Origin fails before token verification/store/fetch.
8. The browser capability and custom session header are never forwarded to the agent or logged.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-library-proxy.test.ts apps/web/lib/viva-session-api.test.ts --test-name-pattern "one-time delete|deletion revokes|concurrent DELETE"
```

Expected: FAIL because control tokens are stateless/replayable and deletion does not touch refresh authority.

- [ ] **Step 3: Implement fail-closed ordering**

The DELETE sequence is exact:

1. Canonical-origin guard.
2. Route/query allowlist guard.
3. Constant-time HMAC verification of purpose/scope/identity/origin/expiry.
4. Call `revokeSession` with `operation: "consume_delete_and_revoke"`, `capabilityHash: sha256(token)`, `capabilityExpiresAt: verifiedClaims.expires_at`, `nowSeconds`, the verified delete `purpose`, and the exact verified session or study-set scope; map expired/replay/scope mismatch to the same public 403 as invalid.
5. Select `VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN`.
6. Forward DELETE with canonical origin and scoped bearer; do not forward the browser capability.
7. Bounded-read, strip, and return the upstream response.

The store retains the capability replay tombstone until token expiry. Do not attempt distributed rollback after upstream failure.

- [ ] **Step 4: Run GREEN**

```bash
bun test apps/web/lib/viva-library-proxy.test.ts apps/web/lib/viva-session-api.test.ts --test-name-pattern "one-time delete|deletion revokes|concurrent DELETE"
```

Expected: PASS. A fake-store mutation that checks then inserts in two operations must fail the concurrent test.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/viva-session/shared.ts 'apps/web/app/api/viva-library/[[...path]]/route.ts' apps/web/lib/viva-library-proxy.test.ts apps/web/lib/viva-session-api.test.ts
git commit -m "feat(web): consume destructive capabilities once"
```

### Task 7A: D-04 Branch A — retain confirmation plus permanent delete (`WEBAPI-016`)

Execute this task only when the central ledger records `CONFIRM_DELETE`. Plan 13 owns the named accessible confirmation UI; this lane owns only the API absence/behavior proof.

**Files:**

- Modify: `apps/web/lib/viva-library-proxy.test.ts`
- Read only: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Read only: `docs/superpowers/plans/2026-08-23-persistence-postgres-privacy.md`

- [ ] **Step 1: Write the Branch A contract test**

Prove a confirmed study-set DELETE follows Task 7, returns Plan 09's selected D-05 permanent-delete receipt only after bounded stripping, and contains no `undo_expires_at`, `deletion_id`, or `restore_control_token`. Then call `POST /api/viva-library/biology-midterm/restore` with a syntactically valid body and `X-Viva-Control-Token`; assert exact 403 `viva_library_control_scope_not_allowed`, `failure_class: "access_denied"`, `stage: "pre_loop"`, zero security-store calls, and zero agent calls. Source-scan the selected route implementation for `restore_control_token`, `register_restore`, and `consume_restore` and require zero matches. The route may match the restore path shape (e.g. a trailing `restore` segment check) in order to return the existing `viva_library_control_scope_not_allowed` rejection; only restore-capability minting/consuming code must be absent. The common store interface may retain its typed union so both deployments speak one adapter protocol, but Branch A has no runtime caller.

- [ ] **Step 2: Run RED/GREEN branch proof**

```bash
bun test apps/web/lib/viva-library-proxy.test.ts --test-name-pattern "D-04 confirmation delete has no restore surface"
```

Expected on the unbranched reviewed tree: FAIL until the catch-all allowlist explicitly rejects the restore shape and the selected D-05 delete response is bounded/stripped. Expected after common Tasks 5–7: PASS. Temporarily admit POST `/{study_set_id}/restore`; the absence test must fail before any upstream assertion. Revert immediately.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/viva-library-proxy.test.ts
git commit -m "test(web): lock confirmed permanent delete branch"
```

### Task 7B: D-04 Branch B — issue and consume bounded restore capability (`WEBAPI-016`)

Execute this task only when the central ledger records `SOFT_DELETE_UNDO`. Plan 09 owns durable soft-delete/restore/finalization truth; Plan 08 owns the agent HTTP handler; Plan 13 consumes the browser contract below. This lane does not implement or simulate restoration.

**Files:**

- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`
- Read only: `docs/superpowers/plans/2026-08-23-persistence-postgres-privacy.md`
- Read only: `docs/superpowers/plans/2026-08-23-agent-service-runtime.md`

- [ ] **Step 1: Freeze the exact cross-plan receipts and browser contract**

Plans 09 and 08 must publish/serialize these recursive exact-key contracts; Plan 11 validates unknown, missing, duplicate, noncanonical, and wrong-type fields instead of casting:

```ts
type SoftDeleteReceiptV1 = {
  schema: "viva.soft_delete_receipt.v1";
  deletion_id: string; // canonical lowercase hyphenated UUID
  study_set_id: string;
  deleted_at: string; // canonical RFC3339 UTC from one database clock capture
  undo_expires_at: string; // canonical RFC3339 UTC; exactly deleted_at + 30 seconds
  policy: "soft_delete_undo";
};

type RestoreStudySetOutcomeV1 = {
  schema: "viva.restore_study_set_outcome.v1";
  deletion_id: string;
  study_set_id: string;
  restored_at: string; // canonical RFC3339 UTC
  outcome: "restored" | "already_restored";
};

type BrowserSoftDeleteReceiptV1 = SoftDeleteReceiptV1 & {
  restore_control_token: string;
};
```

The existing browser DELETE remains the selected study-set delete endpoint and returns `BrowserSoftDeleteReceiptV1`. The only browser restore endpoint is:

```http
POST /api/viva-library/{study_set_id}/restore
Origin: {canonical web origin}
Content-Type: application/json
X-Viva-Control-Token: {restore_control_token}

{"deletion_id":"018f6e2c-3b8a-4a17-9c2d-6e7f8091a2b3"}
```

The body has exactly one key. The UUID must parse and reserialize as the same canonical lowercase hyphenated UUID; mixed case, braced, noncanonical, duplicate `deletion_id`, and unknown keys are invalid. No query parameter carries user or deletion identity. Both first restore (`outcome: "restored"`) and an agent-authorized idempotent replay (`outcome: "already_restored"`, with the originally persisted `restored_at`) are exact validated `RestoreStudySetOutcomeV1` 200 responses; the one-time BFF token means a browser cannot produce that replay itself. Every response has no-store/pragma/nosniff.

- [ ] **Step 2: Write the malicious RED matrix**

Add named cases that prove:

1. A valid soft-delete receipt is capped at 16 KiB, recursively stripped before validation, matches the path study-set ID, has exact schema/policy, canonical UUID/RFC3339 fields with `undo_expires_at === deleted_at + 30 seconds`, and yields exactly one BFF `restore_control_token`; an upstream token/secret is absent, while a noncredential unknown key makes the receipt invalid 502. An idempotent repeated pending delete must return the same deletion ID/deadline before the BFF issues a newly registered browser capability.
2. The signed token is `viva-control1.<canonical-payload>.<signature>` with exact claims `{ version: 1, purpose: "library_restore", user_id, study_set_id, deletion_id, origin, nonce, issued_at, expires_at }`; `nonce` is 32 random bytes encoded as 43 unpadded base64url characters, and no unknown/null claim is accepted.
3. Parse the canonical `undo_expires_at` to epoch seconds and require `expires_at === min(parsedUndoExpiresAt, nowSeconds + 30)`. A receipt already expired at BFF observation yields no token and sanitized 502; client time cannot lengthen it.
4. The BFF calls `revokeSession(operation: "register_restore")` with SHA-256(token), purpose, exact subject tuple, and expiry before returning the raw token. Store conflict/unavailability returns sanitized 503 with no capability; the already completed soft delete is never disguised as restored.
5. Missing/multiple/wrong custom header, body/path mismatch, wrong user/study/deletion/purpose/origin, expired token, invalid signature, prior consume, and tuple mismatch all produce the identical 403 and zero agent calls. Use a validly signed cross-user token, not only a corrupt signature.
6. Sequential and concurrent use of one token reaches agent exactly once. The loser is the same 403 as malformed input.
7. `consume_restore` completes before fetch. An upstream 500/timeout/invalid receipt leaves the capability consumed; retry with it is 403 and performs no second fetch.
8. Missing/unavailable/ambiguous shared-store consume returns exact 503 and never fetches. The HTTP adapter never retries `register_restore` or `consume_restore`.
9. Restore forwards exactly `Authorization: Bearer <VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN>`, canonical `Origin`, `Content-Type: application/json`, `Accept: application/json`, and a fresh `X-Viva-Verified-User-Id` built only from verified restore-capability claims; it sends body exactly `{ "deletion_id": value }` to `POST /v1/study-sets/{encodeURIComponent(studySetId)}/restore`. A forged inbound `X-Viva-Verified-User-Id` is discarded and overwritten, and cross-user claims fail before fetch. It never forwards `X-Viva-Control-Token`, cookies, browser authorization, capability hash, or any other browser header.
10. Exact agent 404 maps to the sanitized not-found body, exact 409 maps to sanitized expired, and valid 200 must be a capped/stripped/exact `RestoreStudySetOutcomeV1` matching both path and request deletion ID. Verify canonical `restored_at` and only `restored|already_restored`; any credential field/value, extra field, mismatched ID/outcome, malformed UTF-8/JSON, >16 KiB, or other status becomes sanitized 502.
11. Logs, thrown errors, and all non-success bodies contain none of the raw restore token, signature, nonce, hash, store token, scoped agent bearer, origin URL, user/study/deletion identifiers, or upstream text. Successful restore returns no new capability; the consumed record remains a replay tombstone until expiry.

- [ ] **Step 3: Run RED**

```bash
bun test apps/web/lib/viva-library-proxy.test.ts apps/web/lib/viva-session-api.test.ts --test-name-pattern "soft delete restore receipt|one-time restore|restore cross-user|restore replay race|restore expiry|restore upstream failure"
```

Expected: FAIL because the reviewed route has no D-04 branch, receipt validator, registered restore capability, or restore rewrite.

- [ ] **Step 4: Implement soft-delete response issuance in fail-closed order**

After Task 7 has consumed the delete capability and Plan 08 returns 2xx:

1. Read at most `restoreUpstreamResponse` bytes; fatal-decode and duplicate-key-aware parse.
2. Apply Task 6's recursive credential detector/stripper before any receipt field is used.
3. Validate exact `SoftDeleteReceiptV1`, canonical UUIDs/RFC3339 UTC strings, path `study_set_id`, exact schema/policy, exact 30-second timestamp delta, and parsed `undo_expires_at > nowSeconds`.
4. Compute `expiresAt = Math.min(parsedUndoExpiresAt, nowSeconds + 30)` from one captured clock read.
5. Generate a 32-byte random nonce and sign the exact canonical claims with the active validated control-capability HMAC key. Previous keys verify during rotation but never sign.
6. Hash the complete token with SHA-256 and call `revokeSession(operation: "register_restore")` with purpose and exact subject tuple.
7. Only on store success, return exact `BrowserSoftDeleteReceiptV1` by attaching `restore_control_token` to the reconstructed receipt.

Never accept an agent-originated restore token. Never return an unregistered token. A post-delete store failure is a truthful 503 and emits only coarse operator code `restore_capability_registration_unavailable`; it does not fabricate undo success, roll durable state forward, or automatically call restore.

- [ ] **Step 5: Implement restore in fail-closed order**

For exactly `POST /api/viva-library/{study_set_id}/restore`:

1. Require canonical same-origin request and exact content type/fetch context; reject query parameters.
2. Bounded-read 512 bytes and duplicate-key-aware parse exact `{ deletion_id }`; validate canonical path/body IDs.
3. Parse exactly one `X-Viva-Control-Token` value. Strictly verify canonical HMAC claims/signature/time with active+previous control keys, then require purpose, origin, study set, and deletion ID match. Derive `user_id` only from verified claims.
4. Call shared `revokeSession(operation: "consume_restore")` with SHA-256(token), exact claims tuple, claim expiry, and current server time. Any ambiguous/unavailable result is 503; any expired/replay/scope rejection is the common 403.
5. Resolve the existing `VIVA_AGENT_LIBRARY_DELETE_BEARER_TOKEN`; do not introduce a broad or restore-specific bearer. Delete any inbound `X-Viva-Verified-User-Id` and construct one fresh from `verifiedClaims.user_id`; validate it as a nonempty 1–128 byte UTF-8 identity with no C0/C1 controls, whitespace, comma, CR, or LF before setting the header.
6. POST the exact body to Plan 08's `/v1/study-sets/{id}/restore` endpoint with the route-owned header allowlist and an abort deadline of 8,000 ms.
7. Read at most 16 KiB, fatal-decode, duplicate-key-aware parse, recursively reject/strip credentials, and validate exact matching `RestoreStudySetOutcomeV1` before returning it.

The capability is consumed before upstream even when upstream restore fails. Do not roll back, reissue, or extend it. Plan 09 alone decides restore truth with `database_now < undo_expires_at`; equality is expired, a later deletion ID cannot be restored with an earlier capability, and D-05 finalization is never delayed by a browser retry.

- [ ] **Step 6: Run GREEN and mutation controls**

```bash
bun test apps/web/lib/viva-library-proxy.test.ts apps/web/lib/viva-session-api.test.ts --test-name-pattern "soft delete restore receipt|one-time restore|restore cross-user|restore replay race|restore expiry|restore upstream failure"
bun --cwd apps/web run typecheck
```

Expected: PASS. Separately mutate consume-after-fetch, remove `deletion_id` from the store tuple, use the delete token header name, accept `now === expires_at`, forward `X-Viva-Control-Token`, and attach the token before store success. Each matching test must fail; revert each mutation immediately.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/viva-session/shared.ts 'apps/web/app/api/viva-library/[[...path]]/route.ts' apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts
git commit -m "feat(web): add one-time soft-delete restore capability"
```

**Blocking handoffs:** Plan 09 implements the exact durable receipts/outcomes above, canonical UUID/RFC3339 serialization, original-time idempotent replays, deletion-ID generation, half-open 30-second database deadline, restore generation binding, expiry finalization, restart/two-instance races, and selected D-05 finalization. Its internal `RestoreStudySetInputV1` includes `{ user_id, study_set_id, deletion_id }`; the browser never supplies that user ID. Plan 08 accepts the server-built `X-Viva-Verified-User-Id` only when the exact delete-scoped bearer authenticates the caller, rejects missing/duplicate/noncanonical/oversized values, combines it with the canonical path/body IDs to derive the internal tuple, exposes the exact agent route, maps both `Restored` and `AlreadyRestored` to the exact 200 outcome, and redacts the header from logs/errors. Plan 13 sends only the browser control header/body, displays the authoritative RFC3339 `undo_expires_at`, and reinserts nothing until exact restore success.

### Task 8A: D-07 Branch A — rotate separate one-time refresh credentials (`WEBAPI-011`)

Execute this task only when recorded D-07 is `retain-token-only`.

**Files:**

- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify: `apps/web/app/api/viva-session/refresh/route.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`

- [ ] **Step 1: Replace access-token refresh tests with RED refresh-credential tests**

The success shape is exact:

```ts
type VivaSessionRouteOutcome = {
  failure_class: null;
  refresh_expires_at: number;
  refresh_token: string;
  session: { session_id: string; study_set_id: string; user_id: string };
  session_absolute_expires_at: number;
  session_token: string;
  token_refresh_outcome: "issued" | "refreshed";
};
```

Add tests that prove:

- Start returns `"viva-refresh1." + base64url(randomBytes(32))`; the encoded suffix is exactly 43 canonical unpadded characters and the stored value is SHA-256 only.
- Refresh accepts only exact fields `refresh_token`, `session_id`, `study_set_id`, `user_id`. A `session_token`-only request—including a correctly signed years-old access token—returns 400 and makes no store/agent call.
- A successful refresh returns a different refresh credential and access token; replaying the consumed old credential returns coarse 401 and atomically revokes the replacement refresh credential, which also returns the identical coarse 401 on use.
- Two concurrent uses of one refresh credential yield exactly one 200 and one 401.
- Refresh credential expiry is `min(now + 900, absolute_expires_at)`.
- Initial absolute expiry is `now + 21_600`; every rotation preserves it exactly and the first request at/after it returns coarse 401.
- Identity mismatch, revoked, malformed, expired, and replayed outcomes have identical public bodies and distinct sanitized operator codes.
- Agent mint failure releases the reservation only after its 10-second TTL; no credential is returned on failure.
- An access token returned by the agent is not exposed unless strict Plan 05 verification succeeds and claims exactly match the requested identity/session.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-session-api.test.ts --test-name-pattern "rotating refresh credential|absolute session lifetime|years-old access token|refresh race"
```

Expected: FAIL because refresh currently accepts access tokens indefinitely and has no store record.

- [ ] **Step 3: Implement issue/rotate flow**

Constants are not operator-extensible in this patch:

```ts
const REFRESH_CREDENTIAL_BYTES = 32;
const REFRESH_CREDENTIAL_TTL_SECONDS = 15 * 60;
const SESSION_ABSOLUTE_LIFETIME_SECONDS = 6 * 60 * 60;
const REFRESH_RESERVATION_TTL_SECONDS = 10;
```

Start flow:

1. Complete canonical guards, shared rate limit, and agent mint.
2. Strictly verify the returned access token and identity.
3. Generate refresh credential/hash.
4. Call `rotateRefresh` in `mode: "issue"` with the verified identity, new credential hash, `refreshExpiresAt`, and `absoluteExpiresAt`; if it fails, discard both credentials and return 503.
5. Return both credentials only after store success.

Refresh flow:

1. Complete canonical guards, exact payload parse, allowlist, and shared rate limit.
2. Validate prefix/canonical base64url length; hash credential.
3. `consumeRefresh` reservation.
4. Mint and strictly verify the next access token.
5. Generate/hash next refresh token.
6. Call `rotateRefresh` in `mode: "rotate"` with the verified identity, reservation `rotationId`, next credential hash, `refreshExpiresAt`, and the unchanged `absoluteExpiresAt` returned by `consumeRefresh`.
7. Return credentials only after rotation succeeds.

Never inspect, store, log, or send the refresh credential to the Rust agent. Never use an access token as refresh authority.

- [ ] **Step 4: Run GREEN**

```bash
bun test apps/web/lib/viva-session-api.test.ts
```

Expected: PASS. Change `SESSION_ABSOLUTE_LIFETIME_SECONDS` to extend on rotation; the absolute-lifetime test must fail. Revert immediately.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/viva-session/shared.ts apps/web/app/api/viva-session/refresh/route.ts apps/web/lib/viva-session-api.test.ts
git commit -m "feat(web): rotate one-time session refresh credentials"
```

**Cross-plan acceptance:** Plan 10 must keep the refresh token in memory only, replace it atomically with every response, never put it in URL/history/storage/logs, and stop falling back to an expired access token. This web API lane does not edit Plan 10's files.

### Task 8B: D-07 Branch B — remove browser token-only mint/refresh paths (`WEBAPI-012`)

Execute this task only when recorded D-07 is `require-service-auth`.

**Files:**

- Delete: `apps/web/app/api/viva-session/start/route.ts`
- Delete: `apps/web/app/api/viva-session/refresh/route.ts`
- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`
- Read only: `apps/web/app/page.tsx` (exclusive Plan 13 ownership)

- [ ] **Step 1: Write the branch characterization**

Retain Plan 05 strict verification for the projection credential delivered by the trusted replacement service. Add RED coverage proving a browser library snapshot no longer contains `session_bootstrap_token`, an expired/malformed projection access token is terminal 401 without a mint attempt, and no API response contains `refresh_token`. Record the pre-delete route-presence RED control:

```bash
set -e
test ! -e apps/web/app/api/viva-session/start/route.ts
test ! -e apps/web/app/api/viva-session/refresh/route.ts
```

Expected: FAIL on the first command in the reviewed tree.

Delete start/refresh handler tests rather than rewriting them to accept a compatibility response. Keep projection, destructive capability, shared-rate, and Plan 05 vector tests.

- [ ] **Step 2: Implement removal**

First require the Plan 13 commit that removes the `attachVivaSessionBootstrapTokensToLibrarySnapshot` import/call and every browser bootstrap-token path from `apps/web/app/page.tsx`; rebase this lane onto it. Plan 11 must not edit that file. Then delete both route files plus `handleVivaSessionStart` and `handleVivaSessionRefresh`. Remove browser session-bootstrap mint/sign/verify code and the now-unreferenced shared export, bootstrap attachment from the API library snapshot, access-token minting, refresh-only payload fields, the web-side `session_mint` credential selector, logs, and dead helpers. Keep strict access verification for projection and the shared limiter/destructive-consumption state required by common tasks. Do not redirect the deleted routes, return a migration body, or accept an access token as replacement authority.

This deletion is code-complete but not release-complete. The trusted D-07 Branch B service, outside this lane, must satisfy one exact handoff before merge to a deployable tree:

1. It alone holds `VIVA_AGENT_SESSION_MINT_BEARER_TOKEN` and the WebSocket shared service bearer; neither reaches browser code, HTML, JSON, URL, logs, or Next public env.
2. It derives user/study-set/session identity from its authenticated server-side session, calls the agent's session-mint path with the scoped bearer, validates the returned Plan 05 access token, and returns only that short-lived access token to the authenticated browser. It returns no reusable refresh credential.
3. Its same-origin WebSocket gateway injects the shared service bearer during agent upgrade while preserving the signed first-frame access token for identity/nonce binding. Direct browser-to-agent WSS is disabled.
4. Plan 10 reconnects through that named gateway/replacement interface and has no call to either deleted Next route. Plan 08 rejects direct token-only upgrade before allocating a slot.

The program must name the owning service and freeze its endpoint/request/session-auth contract before D-07 Branch B release; until then the deletion branch remains deliberately fail-closed rather than inventing an unauthenticated replacement route here.

- [ ] **Step 3: Verify absence and behavior**

```bash
set -e
test ! -e apps/web/app/api/viva-session/start/route.ts
test ! -e apps/web/app/api/viva-session/refresh/route.ts
! rg -n "handleVivaSessionStart|handleVivaSessionRefresh|session_bootstrap_token|VIVA_AGENT_SESSION_MINT_BEARER_TOKEN|expired_refreshed|viva-refresh1" apps/web/app/api/viva-session apps/web/app/api/viva-library apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts
! rg -n "attachVivaSessionBootstrapTokensToLibrarySnapshot|session_bootstrap_token" apps/web/app/page.tsx
bun test apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts
bun --cwd apps/web run typecheck
```

Expected: all commands exit 0; projection still accepts a valid trusted-service-issued access token, but the web BFF cannot mint or refresh one. Plan 14/15 own the later server-artifact build proof.

- [ ] **Step 4: Commit**

```bash
git add -- apps/web/app/api/viva-session 'apps/web/app/api/viva-library/[[...path]]/route.ts' apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts
git commit -m "refactor(web): remove browser token-only mint routes"
```

### Task 9: Add authenticated study projection BFF (`WEBAPI-010`)

**Files:**

- Create: `apps/web/app/api/viva-session/projection/route.ts`
- Modify: `apps/web/app/api/viva-session/shared.ts`
- Modify: `apps/web/lib/viva-session-api.test.ts`
- Read only: `packages/core/src/study-projection-contract.ts`

- [ ] **Step 1: Write the failing endpoint contract tests**

Import Plan 04's production validator/type from the production root after Plan 14 Phase 14A preserves this export:

```ts
import {
  type AuthenticatedStudyProjectionV1,
  validateAuthenticatedStudyProjectionV1,
} from "@viva/core";
```

Program Section 6 records a solid `L14A --> L11` edge, so Phase 14A's root re-export is on integration before this lane is admitted and the root import form is the default. If this lane is nevertheless otherwise ready first, import from the direct module `@viva/core/src/study-projection-contract` (or the package's published module path) and switch to the root import in a follow-up commit after 14A lands; record the import form used in the Task 11 handoff.

Its exact success type is:

```ts
type AuthenticatedStudyProjectionV1 = {
  version: 1;
  studySet: {
    id: string;
    title: string;
    course: string | null;
    examLabel: string | null;
    ingestionStatus: StudySetIngestionStatus;
  };
  session: { id: string; mode: StudyMode; goal: string | null };
  concepts: Array<{
    id: string;
    label: string;
    status: ConceptStatus;
    lastReviewedAt: string | null;
    dueAt: string | null;
  }>;
  activeQuestion: {
    id: string;
    conceptId: string;
    prompt: string;
    sourceCitations: Array<{
      sourceId: string;
      documentId: string;
      span: string;
      label: string;
      confidence: "high" | "medium" | "low";
    }>;
  } | null;
  questionProgress: { completed: number; total: number };
  reviewSchedule: Array<{
    conceptId: string;
    dueAt: string;
    authority: "server_persisted_fsrs" | "core_fsrs_read_time";
  }>;
};
```

`validateAuthenticatedStudyProjectionV1(value: unknown)` returns a field-by-field reconstructed, deep-frozen value. It throws an internal field-specific `Error` for missing/extra/unknown/invalid fields, bad cross-references, or identity inconsistency; the BFF catches it and returns only sanitized 502. Use its smallest valid v1 fixture plus malicious mutations. Assert:

- Valid request: `GET /api/viva-session/projection?study_set_id=biology-midterm&voice_session_id=server-session`, ``Authorization: Bearer ${validFixtureAccessToken}``, `Sec-Fetch-Site: same-origin`.
- Upstream URL is exactly `/v1/study-sets/biology-midterm/projection?voice_session_id=server-session`.
- Upstream headers contain scoped read bearer in `Authorization`, access token in `X-Viva-Session-Token`, and canonical `Origin`; neither token is in URL/body.
- Missing/malformed bearer, expired token, query/claim mismatch, unknown query parameter, missing same-origin fetch context, and disallowed identity all fail before upstream.
- Timeout is exactly 8,000 ms and remains active through bounded body read and v1 validation.
- A >1 MiB, malformed UTF-8/JSON, wrong schema version, unknown field, duplicate identity, or parser-rejected response yields sanitized 502.
- Any case-variant credential key (`api_key`, `authorization`, `credential`, `password`, `private_key`, `secret`, `token`, or any `_token` suffix) or string containing a `Bearer ` / `viva1.` / BFF capability prefix is an upstream-contract violation; no raw key/value reaches response/log.
- Local shared projection rate is 60/minute over atomic IP+session keys; N+1 returns 429 with `retry-after`.
- Missing/unavailable shared store in a public deployment returns the exact projection 503 body, contacts no agent, and supplies no `retry-after`; Plan 10 treats it as sanitized unavailable without its 502/504 retry.
- Agent 401/403 becomes coarse 401; 404 becomes the exact projection-not-found body; 429 becomes the same `session_projection_rate_limited` body as a local rejection and preserves only a decimal delta-seconds `retry-after` in 1-60. Missing, non-decimal, date-form, zero, or >60 upstream retry values are an invalid upstream contract and become 502. All other status/body detail becomes 502.
- Client abort cancels upstream and returns no late body.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-session-api.test.ts --test-name-pattern "authenticated study projection"
```

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the route in this exact order**

1. Validate canonical safe-read origin/fetch context.
2. Parse an exact query allowlist: `study_set_id`, `voice_session_id`; both nonempty, no duplicates/extra keys.
3. Parse the exact `Authorization: Bearer ${accessToken}` grammar; reject any other scheme, blank token, comma-joined value, or multiple header value.
4. Strictly verify Plan 05 token; bind `study_set_id` and `session_id` to query, `user_id` to configured allowlist.
5. Atomically increment shared projection IP/session buckets.
6. Resolve `VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN`.
7. Fetch Plan 08 endpoint with the exact two auth headers, canonical `Origin`, no redirects/cache, and 8-second abort.
8. Bounded-read at 1 MiB and strict-decode/parse.
9. Apply Task 6's recursive credential-key/value detector before validation. If it finds anything, classify/log only `projection_upstream_credential_violation`, sanitize the in-memory candidate, and fail 502; never return a partially sanitized projection or log the rejected value.
10. Call `validateAuthenticatedStudyProjectionV1`; do not cast. Return the validated value only.

Projection responses always set `cache-control: no-store`, `pragma: no-cache`, and `x-content-type-options: nosniff`. Never enable CORS.

- [ ] **Step 4: Run GREEN**

```bash
bun test apps/web/lib/viva-session-api.test.ts --test-name-pattern "authenticated study projection"
bun --cwd apps/web run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/viva-session/shared.ts apps/web/app/api/viva-session/projection/route.ts apps/web/lib/viva-session-api.test.ts
git commit -m "feat(web): proxy authenticated study projection"
```

**Cross-plan acceptance:** Plan 10 imports Plan 04's type for client state and fetches only this BFF endpoint. It must use an 8-second abort, treat 401 as terminal auth recovery, make one bounded retry only for 502/504, and never fall back to the biology seed or library snapshot projection.

### Task 10: Add nonce CSP and defense headers (`WEBAPI-015`)

**Files:**

- Create: `apps/web/proxy.ts`
- Create: `apps/web/lib/viva-security-headers.test.ts`
- Read only: `apps/web/next.config.ts` (exclusive Plan 14 ownership)
- Read only: `docs/superpowers/plans/2026-08-23-package-build-contracts.md`
- Read only: `agent/fixtures/voice-protocol/v5/auth-decision.json`

- [ ] **Step 1: Write failing header tests**

Call `proxy` twice with production-like `NextRequest`s. Assert:

- Distinct nonces of at least 128 bits appear in request and response CSP.
- `script-src` contains `'self'`, the exact nonce extracted from that response's CSP, and `'strict-dynamic'`; production has neither `'unsafe-inline'` nor `'unsafe-eval'` for script.
- `style-src-attr 'unsafe-inline'` is explicit because mounted UI uses React style attributes; stylesheet/font hosts are limited to Google Fonts until the asset lane self-hosts them.
- Under D-07 Branch A, `connect-src` contains only `'self'` plus validated origins derived from `NEXT_PUBLIC_VIVA_AGENT_HTTP_URL` and `NEXT_PUBLIC_VIVA_AGENT_WS_URL`; under D-07 Branch B it is exactly `'self'` because direct browser-agent transport is removed.
- `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, and `worker-src 'self' blob:` are present.
- Production HTTPS adds HSTS; HTTP loopback does not.
- All server routes get `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy: microphone=(self), camera=(), geolocation=()`, `Cross-Origin-Opener-Policy: same-origin`, and `Cross-Origin-Resource-Policy: same-origin`.
- Proxy matcher excludes `/api`, `/_next/static`, `/_next/image`, and metadata assets; API handlers retain their own no-store/nosniff headers.

- [ ] **Step 2: Run RED**

```bash
bun test apps/web/lib/viva-security-headers.test.ts
```

Expected: FAIL because only `/session` referrer policy exists.

- [ ] **Step 3: Implement server-mode nonce CSP**

Use Next 16's `proxy.ts` convention. Generate a fresh nonce with `randomBytes(16).toString("base64")` (128 random bits), place the CSP in both forwarded request headers and response headers, and set `x-nonce` on the forwarded request so Next can nonce its framework/inline scripts. Allow `'unsafe-eval'` only when `NODE_ENV=development`. Normalize the CSP to one line and reject invalid configured agent origins rather than emitting them. Import the read-only Plan 05 auth-decision JSON at build time: D-07 Branch A admits the two validated direct-agent origins; D-07 Branch B ignores/rejects those public envs and emits `connect-src 'self'` only.

For D-07 Branch A CSP parsing, the HTTP value must be an exact credential-free origin using `https:` publicly or `http:` on loopback; the WS value must be an exact credential-free origin using `wss:` publicly or `ws:` on loopback. Reject a path, query, fragment, userinfo, unsupported scheme, or insecure public value. Deduplicate identical origins before joining the directive, and never reflect the invalid source in an error/log.

Export the route matcher from `apps/web/proxy.ts`; no `next.config.ts` edit is needed or permitted. `output: "export"` cannot provide request nonces or these API routes. Do not claim `WEBAPI-015` for a static export artifact; server-mode build/browser evidence is required.

**Plan 14/15 reverse handoff:** Plan 14 exclusively owns `apps/web/next.config.ts` and the build/configuration side of D-06. Its selected configuration must produce a server-mode artifact for this BFF: `output` is not `"export"`, static-only `assetPrefix`/public routing flags are absent, and the production build includes the web-owned API routes plus `proxy.ts`. Plan 15, on the frozen combined tree, runs the exact Task 10 test, `bun --cwd apps/web run build`, and `bun run e2e:browser`; the browser gate fetches a real rendered page twice, proves distinct nonce CSP headers and all fixed defense headers, and proves `/api/viva-session/projection` remains a server route. This downstream artifact proof does not block the Plan 11 implementation merge. Branch-A static export cannot satisfy the release gate and therefore blocks release until a separately named server BFF owns these routes.

- [ ] **Step 4: Run GREEN and browser control**

```bash
bun test apps/web/lib/viva-security-headers.test.ts
bun --cwd apps/web run typecheck
```

Expected: owner-local tests/typecheck pass. Plan 15's downstream browser evidence must contain no CSP violation, external-script load, framing allowance, or microphone-policy failure and must inspect actual response headers, not source strings.

- [ ] **Step 5: Commit**

```bash
git add apps/web/proxy.ts apps/web/lib/viva-security-headers.test.ts
git commit -m "feat(web): enforce nonce CSP and defense headers"
```

### Task 11: Owner-local verification and Plan 15 handoff

**Files:**

- Verify all files listed in this plan
- Do not edit Plan 04, 05, 08, 09, or 10 files from this lane

- [ ] **Step 1: Run focused route suites without cache**

```bash
bun test apps/web/lib/viva-session-api.test.ts apps/web/lib/viva-library-proxy.test.ts apps/web/lib/viva-security-headers.test.ts
bun --cwd apps/web run typecheck
bun --cwd apps/web run lint
```

Expected: all pass.

- [ ] **Step 2: Run adversarial negative controls**

Temporarily and one at a time: allow `_token` suffixes through the proxy sanitizer; make limiter increments sequential; allow legacy public bearer; accept nullable capability origin; change the body comparison from `>` to `>=`; skip projection parser; under D-04 Branch B consume restore after fetch or omit deletion ID from the store tuple; extend absolute lifetime on D-07 Branch A rotation; or reuse the CSP nonce. Each associated test must fail. Revert every mutation and rerun the focused suite.

- [ ] **Step 3: Run owner-local repository gates**

```bash
git diff --check
git status --short
```

Expected: `git diff --check` is silent and status contains only intended Plan 11 paths. This owner-local green run permits the implementation merge; it is not combined, browser, hosted, or release proof. Plan 15 owns `bun run validate`, the server build, browser E2E, and hosted evidence after downstream consumers land.

- [ ] **Step 4: Verify branch-specific absence/presence**

D-04 Branch A:

```bash
! rg -n "restore_control_token|register_restore|consume_restore" 'apps/web/app/api/viva-library/[[...path]]/route.ts'
```

D-04 Branch B:

```bash
rg -n "library_restore|restore_control_token|register_restore|consume_restore" apps/web/app/api/viva-session/shared.ts 'apps/web/app/api/viva-library/[[...path]]/route.ts'
bun test apps/web/lib/viva-library-proxy.test.ts apps/web/lib/viva-session-api.test.ts --test-name-pattern "soft delete restore receipt|one-time restore|restore cross-user|restore replay race|restore expiry|restore upstream failure"
```

Expected: run only the selected D-04 block; every command exits 0.

D-07 Branch A:

```bash
test -e apps/web/app/api/viva-session/refresh/route.ts
rg -n "viva-refresh1|SESSION_ABSOLUTE_LIFETIME_SECONDS|consumeRefresh|rotateRefresh" apps/web/app/api/viva-session/shared.ts
```

D-07 Branch B:

```bash
set -e
test ! -e apps/web/app/api/viva-session/start/route.ts
test ! -e apps/web/app/api/viva-session/refresh/route.ts
! rg -n "handleVivaSessionStart|handleVivaSessionRefresh|session_bootstrap_token|VIVA_AGENT_SESSION_MINT_BEARER_TOKEN|expired_refreshed|viva-refresh1" apps/web/app/api/viva-session apps/web/app/api/viva-library apps/web/lib
! rg -n "attachVivaSessionBootstrapTokensToLibrarySnapshot|session_bootstrap_token" apps/web/app/page.tsx
```

Expected: the selected branch commands exit 0; do not run or claim the other branch.

- [ ] **Step 5: Integration handoff**

Report:

- Recorded D-07 branch.
- Exact commit SHAs from Tasks 2-10, including the selected 7A/7B and 8A/8B branch commits.
- Recorded D-04 selector and selected absence/restore proof.
- Plan 05 vector filename and vector count consumed without modification.
- Plan 08 scoped-header conformance and projection endpoint result.
- Plan 09 D-04 receipt/outcome schema conformance, plus the exact Plan 13/15 confirmation or server-undo browser acceptance still outstanding.
- Plan 04 projection parser version accepted, the `@viva/core` import form used (root re-export or direct module), and — if the direct module form was used — the note that program Section 6's `L14A --> L11` edge makes Plan 14 Phase 14A a merge prerequisite, so the root-import follow-up commit lands after 14A.
- Shared store production configuration proof and concurrency result.
- Exact RED-before/GREEN-after tests for body overflow, token stripping, limiter race, destructive replay, projection contract violation, and D-07 Branch A refresh replay or D-07 Branch B route absence.
- Owner-local response-header/CSP unit evidence plus the exact unresolved Plan 15 browser gate.
- The Plan 14 server-mode build/configuration requirement handed to Plan 15; do not claim its combined proof from this lane.
- Under D-07 Branch B, the named trusted replacement service/gateway contract and hosted proof that direct browser WSS cannot bypass its shared bearer.

Mark the Plan 11 implementation lane complete when its selected D-04/D-07 owner-local RED/GREEN tasks pass, Plan 08/09 upstream contracts conform, Plan 14 Phase 14A exports the Plan 04 validator, and—only for D-07 Branch B—the Plan 13 Phase 13A cleanup SHA has been consumed. Plan 10, Plan 13 UI, Plan 14 build configuration, the selected D-07 replacement/refresh deployment, and the frozen combined-tree/browser/hosted gates remain explicit Plan 15 acceptance work. Do not infer their correctness from this route unit suite.
