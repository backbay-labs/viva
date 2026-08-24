# Web Session Recovery, Projection, and Audio Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan task by task. Apply strict RED/GREEN discipline and make the named commit after each green task.

**Goal:** Make the mounted live-session page a truthful, accessible client of the authenticated study projection and voice protocol, with bounded recovery, loss-aware retained audio, typed learner intents, deterministic cleanup, and correct terminal UI.

**Architecture:** Plans 03, 04, 05, 08, 09, 11, 13, and 14 publish the lower-level transport, shared read model, wire/auth, server projection, browser proxy, accessibility/copy, and build decisions. This plan rebases those contracts first, then keeps browser orchestration in `LiveSessionPage`, WebSocket state and generation safety in `viva-agent-client`, pure UI projection in `viva-session-projection`, and Web Audio resource/scheduling rules in the capture and playback modules. The server-owned `AuthenticatedStudyProjectionV1` is the only study/session read model; route parameters select it but never synthesize it.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, Bun test runner, happy-dom for mounted React tests, WebSocket protocol v5, Web Audio API, Biome, Turbo.

**Spec:** `docs/superpowers/reviews/2026-08-23-web-ui.md`, `docs/superpowers/reviews/2026-08-23-web-session-client.md`, `docs/superpowers/reviews/2026-08-23-frontend-review.md`, `docs/superpowers/reviews/2026-08-23-correctness-review.md`, `docs/superpowers/reviews/2026-08-23-reliability-and-performance-review.md`, `docs/superpowers/reviews/2026-08-23-packages-shared.md`, `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`, and `docs/superpowers/reviews/index.md`.

## Global Constraints

- Execute after Plan 03, `docs/superpowers/plans/2026-08-23-expedited-critical-path.md`, is merged. Rebase this lane onto that commit. Plan 03 owns protocol-v5 audio framing, the controller's retained turn ledger, `VivaAudioSendResult`, `sendAudioChunk`, `endAudioTurn`, `cancelAudioTurn`, `retryPendingAudio`, `audio_turn_accepted`, capture streaming, and rational-phase 44.1/48 kHz resampling. Do not reimplement or rename those seams.
- Execute protocol consumption only after Plan 05, `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md`, is merged. Do not edit `packages/core/src/agent-contract.ts`, `agent/crates/agent-service/src/protocol.rs`, or any protocol/voice fixture owned by Plan 05.
- Execute study rendering only after Plan 04 exports `AuthenticatedStudyProjectionV1` from `packages/core/src/study-projection-contract.ts`, Plan 09 implements its durable projection, Plan 08 exposes the authenticated agent projection, and Plan 11 proxies `GET /api/viva-session/projection?study_set_id=...&voice_session_id=...`. The metadata-only `/api/viva-library/study-sets/library` response is not a fallback.
- Treat `D-02 QUESTION_PROGRESSION`, `D-03 MODE_GOAL_CONTRACT`, `D-06 STATIC_EXPORT`, `D-07 TOKEN_ONLY_REFRESH`, and `D-08 DISCLOSURE_SCOPE` as merge gates. The review request calls disclosure `D-07`; disclosure's canonical program decision is `D-08`, while D-07 is the distinct authentication decision published by Plan 05. D-02 Branch A is adaptive progression and D-02 Branch B is deterministic ordered retry/exhaustion; neither is recommended or defaulted here. Do not select a branch inside this plan.
- Plan 13, `docs/superpowers/plans/2026-08-23-frontend-accessibility-performance.md`, owns global styles, tokens, and landing/general copy. This plan owns behavior and accessibility inside the mounted live-session page only. Do not edit `apps/web/app/globals.css`, `packages/tokens`, or shared token files.
- Plan 13A publishes `apps/web/lib/viva-effects.ts` as an early additive handoff. Task 11 imports its exact `VivaEffectsPolicy`, `VivaEffectsPolicyInput`, `resolveVivaEffectsPolicy`, `readVivaEffectsPreference`, and `VIVA_EFFECTS_CHANGE_EVENT`; it does not redefine effects policy or read the preference key/event string itself. Final Plan 13B follows the completed Plan 10 lane and runs the combined accessibility/performance acceptance on that integrated tree.
- Plan 14A publishes the additive package/runtime-validation exports consumed by this lane. Task 12 reads the selected D-06 branch and, for retain, the named static consumer plus separate server BFF directly from the coordinator decision registry; this plan owns only the `viva-agent-client.ts` side and focused tests. It must not wait on Plan 14B's `next.config`, Turbo/cache, build-artifact, or served Playwright proof; Plan 15 owns combined Plan 10/11/13/14 evidence.
- Plan 12, `docs/superpowers/plans/2026-08-23-release-monitor-ci-supply-chain.md`, is the permanent owner of root/app package manifests and `bun.lock`. Its dependency handoff must add both `happy-dom: "20.11.6"` and `@happy-dom/global-registrator: "20.11.6"` to `apps/web/package.json` devDependencies and regenerate `bun.lock` before Task 2 can turn green. This lane creates the mounted setup/tests but must not edit or stage either manifest or lockfile.
- Plan 04 owns the additive learner-loop `RuntimeCopyCause` value `recap_success`, its JSON mirror, and its contract tests. This lane consumes the published cause through `completion: { recapPersisted: true }`; it must not edit or cast around the learner-loop contract.
- Read `agent/fixtures/voice-protocol/v5/auth-decision.json` before auth work. Under D-07 Branch A (`retain-token-only`), rotate the distinct one-time `viva-refresh1` credential in memory and never use a `viva1` access token as refresh authority. Under Branch B (`require-service-auth`), make no call to deleted `/api/viva-session/start` or `/api/viva-session/refresh`; stop until the program names and freezes the trusted replacement service plus same-origin WebSocket gateway interface required by Plans 08/11.
- Never reconstruct a study set, concepts, goal, mode, question progress, or schedule from route IDs, `seedStudySets`, or the Biology fixture. A missing, invalid, mismatched, or unavailable authenticated projection is a sanitized pre-loop failure and must not open the voice socket.
- Never automatically grade, replay, or duplicate a typed answer after an ambiguous close. Audio replay is allowed only from Plan 03's bounded retained ledger, with the original `turn_id` and sequence numbers, until `audio_turn_accepted` proves admission. A learner may explicitly retry typed content that remains visible in the form.
- Never display parser excerpts, raw frames, close reason text, bearer material, signed session tokens, provider payloads, or arbitrary exception messages. UI classification consumes Plan 05's typed protocol error and `VivaVoiceTermination` only.
- Use fake clocks, fake sockets, and fake Web Audio nodes in focused tests. Tests must assert behavior through public interfaces or a mounted component, not search implementation source text.
- Preserve unrelated dirty work. Stage only files named by the current task. Every commit listed below must pass `git diff --check` before it is made.

## Locked Upstream Interfaces

Plan 03's post-merge audio surface is consumed verbatim:

```ts
export type VivaAudioSendResult =
  | { status: "sent"; acceptedThroughSequence: number }
  | {
      status: "pending";
      acceptedThroughSequence: number | null;
      retainedFromSequence: number;
    }
  | {
      status: "socket_closed";
      acceptedThroughSequence: number | null;
      retainedFromSequence: number;
      retryable: true;
      error: VivaClientSendError;
    };

export type RequiredPlan03AudioControllerMethods = {
  sendAudioChunk(input: {
    turnId: string;
    sequence: number;
    pcm16Bytes: Uint8Array;
  }): VivaAudioSendResult;
  endAudioTurn(input: { turnId: string; finalSequence: number }): VivaAudioSendResult;
  cancelAudioTurn(turnId: string): void;
  retryPendingAudio(): VivaAudioSendResult;
};
```

The post-Plan-03 `VivaAgentSessionController` contains every member of `RequiredPlan03AudioControllerMethods` with these exact signatures. The ledger holds at most 1,080,000 PCM16 samples / 2,160,000 raw bytes for one 45-second turn, frames chunks at at most 4,096 samples / 8,192 raw bytes, and releases only after `audio_turn_accepted`. Plan 10 may orchestrate replay after a new ready generation; it must not create a second queue.

Plan 04's read model is consumed without narrowing or reconstruction:

```ts
export type AuthenticatedStudyProjectionV1 = {
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

The block above records the approved read-only shape for execution review. Production code imports `AuthenticatedStudyProjectionV1` and `validateAuthenticatedStudyProjectionV1` from Plan 04; it does not redeclare either.

Plan 05's termination classifier is the only close classifier:

```ts
export type VivaVoiceTermination =
  | {
      kind: "terminal";
      terminalReason: AgentTerminalSessionReason;
      retryable: false;
      closeCode: number;
    }
  | {
      kind: "auth";
      errorCode:
        | "VOICE_AUTH_EXPIRED"
        | "VOICE_AUTH_INVALID"
        | "VOICE_AUTH_IDENTITY_MISMATCH"
        | "VOICE_AUTH_REPLAYED";
      retryable: boolean;
      closeCode: number;
    }
  | {
      kind: "protocol";
      errorCode:
        | "VOICE_CLIENT_FRAME_MALFORMED"
        | "VOICE_CLIENT_FRAME_TOO_LARGE"
        | "VOICE_CLIENT_TURN_TOO_LARGE"
        | "VOICE_CLIENT_AUTHORITY_FORBIDDEN";
      retryable: false;
      closeCode: number;
    }
  | {
      kind: "service";
      errorCode: "VOICE_INTERNAL_SERIALIZATION";
      retryable: true;
      closeCode: number;
    }
  | { kind: "normal"; retryable: false; closeCode: 1000 }
  | { kind: "transport"; retryable: true; closeCode: number };

export function classifyVivaVoiceTermination(input: {
  error?: VivaServerError;
  terminalReason?: AgentTerminalSessionReason;
  closeCode: number;
  wasClean: boolean;
}): VivaVoiceTermination;
```

## Finding Coverage

| Acceptance ID | Review obligation | Implemented in |
| --- | --- | --- |
| `WEBSESSION-ROUTE-01` | Render-pure route identity, one post-mount token strip, hydration-safe neutral state | Task 2 |
| `WEBSESSION-AUTH-01` | One authoritative latest credential and bounded renewal | Task 2 |
| `WEBSESSION-AUTH-02` | Selected D-07 credential renewal/gateway path; no obsolete token-only fallback | Tasks 1, 2, and 5 |
| `WEBSESSION-DATA-01` | Authenticated server projection, no Biology/read-model fabrication | Task 3 |
| `WEBSESSION-PROGRESSION-01` | D-02 progression remains server-owned; browser never selects the next question or infers exhaustion | Task 3 |
| `WEBSESSION-MODE-01` | D-03 mode/goal branch is honored without discarded intent | Task 3 |
| `WEBSESSION-PROTOCOL-01` | Sanitized parser diagnostics and typed close/auth classification | Task 4 |
| `WEBSESSION-RECAP-01` | Partial recap and structured-error terminality remain discriminated | Task 4 |
| `WEBSESSION-DEFERRED-01` | Deferred turns stay ungraded/nonterminal and retry only from server boolean | Task 4 |
| `WEBSESSION-RECOVERY-01` | Bounded reconnect after lease grace with cleanup and manual recovery | Task 5 |
| `WEBSESSION-AUDIO-01` | Plan 03 retained audio is replayed idempotently; no reimplementation | Tasks 1 and 5 |
| `WEBSESSION-INTENT-01` | Citation challenge uses typed intent and cannot be graded as answer text | Task 6 |
| `WEBSESSION-DISCLOSURE-01` | D-08 live input gate/copy semantics match the selected branch | Task 6 |
| `WEBSESSION-READY-01` | Readiness polling is timed out, non-overlapping, abortable, and cleaned up | Task 7 |
| `WEBSESSION-CAPTURE-01` | Partial-construction capture cleanup and optional anti-alias quality | Task 8 |
| `WEBSESSION-PLAYBACK-01` | Cancellation removes phantom playback schedule gap | Task 9 |
| `WEBSESSION-TERMINAL-01` | Successful recap is not rendered as disconnect/error; terminal copy is truthful | Task 10 |
| `WEBSESSION-TASK10-LOCAL-DATE-01` | Review due dates render on the runtime-local calendar via `Intl.DateTimeFormat`; invalid timestamps render safe copy (ledger alias of Web UI Minor M4; literal execution under `WEBSESSION-TERMINAL-01`) | Task 10 (Step 6) |
| `WEBSESSION-A11Y-01` | Transcript disclosure is an explicit accessible toggle | Task 10 |
| `WEBSESSION-A11Y-02` | Session has one main landmark and a keyboard skip target | Task 10 |
| `WEBSESSION-CANVAS-01` | VoiceTrace label planning is cached and exposes the shared effects budget | Task 11 |
| `WEBSESSION-STATIC-01` | D-06 selected client routing branch has behavioral proof | Task 12 |
| `WEBSESSION-PASTE-01` | Paste request serializes the exact server-owned key set and carries no ignored identity authority | Task 13 |
| `WEBSESSION-AUTHORITY-01` | Browser outbound types expose no tool authority and reject oversized/forged frames before send | Task 13 |
| `WEBSESSION-MOUNT-01` | StrictMode-mounted component and audio lifecycle tests cover the real page | Task 14 |

---

### Task 1: `WEBSESSION-PREFLIGHT-01` — Rebase and freeze upstream contracts

**Files:**

- Read: `docs/superpowers/plans/2026-08-23-expedited-critical-path.md`
- Read: `docs/superpowers/plans/2026-08-23-voice-wire-auth-contract.md`
- Read: `docs/superpowers/plans/2026-08-23-package-build-contracts.md`
- Read: `packages/core/src/study-projection-contract.ts`
- Read: `apps/web/app/api/viva-session/projection/route.ts`
- Read: `apps/web/lib/viva-agent-client.ts`
- Read: `apps/web/lib/viva-audio-capture.ts`
- Read: `apps/web/components/session/LiveSessionPage.tsx`
- Test: `apps/web/lib/viva-agent-client.test.ts`
- Test: `apps/web/lib/viva-audio-capture.test.ts`
- Read and run only: `packages/core/src/agent-contract.test.ts`

**Step 1: Require the dependency commits**

- [ ] Record the merged commit IDs for Plans 03, 04, 05, 08, 09, and 11 in the execution log. Record the selected D-01, D-02, D-03, D-06, D-07, and D-08 branches before changing source.
- [ ] Parse `agent/fixtures/voice-protocol/v5/auth-decision.json`. Continue Branch A only for `branch:"retain-token-only"`. Continue Branch B only for `branch:"require-service-auth"` after the program has named the trusted replacement service, its authenticated access-token replacement request/response, and its same-origin WebSocket gateway URL/upgrade behavior. A Branch-B decision without that named contract is a hard execution/release block, not permission to call the deleted Next routes or the agent directly.
- [ ] Stop execution if `/api/viva-session/projection` does not validate and return `AuthenticatedStudyProjectionV1`, if Plan 03's four audio controller methods differ from the locked surface above, or if Plan 05 does not export `VivaVoiceProtocolError` and `classifyVivaVoiceTermination`.
- [ ] Rebase onto the first combined commit containing those inputs. Resolve conflicts in this lane's owned files by preserving the upstream protocol/audio code and replaying only later tasks from this plan.

**Step 2: Prove Plan 03 is green before integration**

- [ ] Run:

```bash
bun test apps/web/lib/viva-agent-client.test.ts apps/web/lib/viva-audio-capture.test.ts apps/web/components/session/LiveSessionPage.test.tsx
```

- [ ] Inspect the tests to confirm they assert 4,096-sample chunking, the 45-second cap, contiguous sequences, `audio_end`, `audio_turn_accepted`, all three `VivaAudioSendResult.status` variants, ledger retention through close, and long irregular-block 44.1/48 kHz phase continuity. A green test whose assertion was deleted is not acceptance.
- [ ] Record `WSC-M01` (discriminated `VivaAudioSendResult` retention) as satisfied by the first-merged Plan 03 commit plus the unchanged regression tests above. Record the 44.1/48 kHz phase-continuity result separately as Plan 03 resampler acceptance consumed by Task 8's `WEBSESSION-CAPTURE-01`; do not attach it to the WSC-M01 ledger row. Do not reopen Plan 03's transport, queue, chunking, or rational-phase resampler implementation in this lane.

**Step 3: Prove Plan 05 is green before consumption**

- [ ] Run:

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
```

- [ ] Confirm those tests exercise `agent/fixtures/voice-protocol/v5/client-differential-cases.json`, `server-differential-cases.json`, `terminal-sequences.json`, `audio-turn-lifecycle.json`, and every `transport-outcomes.json` case.
- [ ] Confirm `session_refresh` rejects token/identity fields, new signed credentials open a new WebSocket generation, and `turn_intent` includes `version`, `client_generation_id`, and `turn_id`.

**Step 4: Establish the forbidden-diff guard**

- [ ] Run before and after every later task:

```bash
git diff --name-only -- packages/core/src/agent-contract.ts agent/crates/agent-service/src/protocol.rs agent/fixtures packages/core/fixtures apps/web/app/globals.css packages/tokens
```

- [ ] Expected output: empty. If conflict resolution changes one of these paths, restore the upstream version by applying the dependency commit's patch for that file, not by hand-editing its contract.

**Step 5: Commit only if the rebase required owned-file conflict resolution**

```bash
git add apps/web/components/session/LiveSessionPage.tsx apps/web/lib/viva-agent-client.ts apps/web/lib/viva-audio-capture.ts
git commit -m "chore(web): rebase session lane onto voice v5"
```

No commit is created for a clean, read-only preflight.

---

### Task 2: `WEBSESSION-ROUTE-01` / `WEBSESSION-AUTH-01` / `WEBSESSION-AUTH-02` — Mount safely and make credential renewal bounded

**Files:**

- Create: `apps/web/test/setup-dom.ts`
- Create: `apps/web/components/session/LiveSessionPage.mounted.test.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.test.tsx`
- Modify: `apps/web/lib/use-viva-agent-session.ts`
- Modify: `apps/web/lib/use-viva-agent-session.test.ts`

**Interfaces:**

```ts
export const VIVA_SESSION_ENTRY_REFRESH_TIMEOUT_MS = 6_000;

export type ResolvedBrowserSessionIdentity = Readonly<{
  userId: string;
  studySetId: string;
  sessionId: string;
}>;

export type BrowserSessionCredential =
  | Readonly<{
      mode: "retain-token-only";
      identity: ResolvedBrowserSessionIdentity;
      accessToken: string;
      refreshToken: string | null;
      refreshExpiresAt: number | null;
      sessionAbsoluteExpiresAt: number | null;
      revision: number;
    }>
  | Readonly<{
      mode: "require-service-auth";
      identity: ResolvedBrowserSessionIdentity;
      accessToken: string;
      revision: number;
    }>;

export type RenewBrowserSessionCredentialResult =
  | { status: "renewed"; credential: BrowserSessionCredential }
  | {
      status: "retained";
      credential: BrowserSessionCredential;
      reason: "not_renewable" | "timeout" | "unavailable";
    }
  | { status: "terminal"; reason: "auth_terminal" | "invalid_response" };

export type VivaSessionCredentialRotationResponse = Readonly<{
  failure_class: null;
  refresh_expires_at: number;
  refresh_token: string;
  session: { session_id: string; study_set_id: string; user_id: string };
  session_absolute_expires_at: number;
  session_token: string;
  token_refresh_outcome: "issued" | "refreshed";
}>;

export async function refreshBrowserSessionToken(
  credential: Extract<BrowserSessionCredential, { mode: "retain-token-only" }>,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<RenewBrowserSessionCredentialResult>;

export type RenewBrowserSessionCredential = (input: {
  credential: BrowserSessionCredential;
  reason: "session_entry" | "auth_expired" | "transport_reconnect" | "browser_restore";
  signal: AbortSignal;
}) => Promise<RenewBrowserSessionCredentialResult>;

export function readBrowserSessionCredential(): BrowserSessionCredential | null;
export function replaceBrowserSessionCredential(
  next: BrowserSessionCredential | null,
): void;

export type LiveSessionPageDependencies = Readonly<{
  createAgentController: typeof createVivaAgentSessionController;
  createAudioCaptureSource: typeof createBrowserVivaAudioCaptureSource;
  createAudioPlaybackSink: typeof createVivaAudioPlaybackSink;
  fetchReadiness: typeof fetchVivaAgentReadinessProbe;
  fetchStudyProjection: typeof fetchAuthenticatedStudyProjection;
  readCredential: typeof readBrowserSessionCredential;
  replaceCredential: typeof replaceBrowserSessionCredential;
  renewCredential: RenewBrowserSessionCredential;
  reconnectClock: VivaAgentReconnectClock;
}>;

export type LiveSessionPageProps = {
  dependencies?: Partial<LiveSessionPageDependencies>;
};
```

`LiveSessionPageDependencies` is a production dependency seam, not a test-only global. Defaults are fixed module imports. The credential vault is module memory only: never URL, history state, `sessionStorage`, `localStorage`, cookie, DOM, log, or serialized error. The vault module is `apps/web/lib/use-viva-agent-session.ts` (add it to this task's exports). Plan 13 Task 6 (FRONTEND-011) currently hands off only `session_token` in the navigation fragment; before implementing the in-memory-credential precedence in Steps 2 and 4, file a coordinator handoff requiring Plan 13 Branch A to call `replaceBrowserSessionCredential` with the complete start response (`session_token`, `refresh_token`, `refresh_expires_at`, `session_absolute_expires_at`, identity, `mode:"retain-token-only"`) before client navigation, and record the coordinator's acceptance in the execution log. Until that handoff is recorded, treat fragment-only entries as nonrenewable Branch-A direct entries and keep the rotation tests scoped to vault-seeded entries; a full reload may require a fresh authenticated start. The `/api/viva-session/start` caller lives in Plan 13's landing surface; record a coordinator handoff requiring Plan 13 Task 6 to bound that fetch with the same 6,000 ms abort/timeout policy (`VIVA_SESSION_ENTRY_REFRESH_TIMEOUT_MS`), and note in the execution log that the Web UI R6 ledger alias' start-deadline proof is supplied by that Plan 13 commit. `useVivaAgentSession` receives `controllerFactory?: typeof createVivaAgentSessionController` and stores the latest factory in a ref so StrictMode does not create parallel controllers.

**Step 1: Add the mounted-test runtime**

- [ ] Require Plan 12's merged dependency handoff that adds `happy-dom: "20.11.6"` and `@happy-dom/global-registrator: "20.11.6"` to `@viva/web` devDependencies and regenerates `bun.lock`. Verify `bun pm ls happy-dom` and `bun pm ls @happy-dom/global-registrator` each resolve exactly `20.11.6`. Do not change `apps/web/package.json` or `bun.lock` in this lane.
- [ ] Import `../../test/setup-dom` as the first dependency of `LiveSessionPage.mounted.test.tsx`, so both root-invoked `bun test apps/web/...` and workspace-invoked tests install the same DOM without relying on Bun's current working directory.
- [ ] In setup, register one DOM with `@happy-dom/global-registrator`, set `IS_REACT_ACT_ENVIRONMENT = true`, and reset DOM/history/sessionStorage after each test. Do not install a second assertion or component framework.
- [ ] Add a smoke test that uses React 19 `act`, `hydrateRoot`, and `createRoot` to mount and unmount a trivial component. Run it through the existing `components/**/*.test.tsx` glob.

**Step 2: Write the route/hydration RED tests**

- [ ] Server-render the page's neutral shell, set the happy-dom location to a URL with distinct `user_id`, `study_set_id`, `session_id`, and fragment `session_token`, then hydrate under `<StrictMode>`.
- [ ] Spy on `history.replaceState`, `console.error`, the controller factory, and controller `connect`.
- [ ] Assert zero URL mutation during render, zero hydration mismatch warning, exactly one token-stripping replacement after the committed mount, and exactly one deferred connect only after credential refresh and projection validation complete.
- [ ] Under D-07A, an identity-matched in-memory credential outranks the legacy URL access token; without an in-memory credential the URL access token is nonrenewable. Under D-07B, strip and ignore any URL token and acquire only through the named service adapter.
- [ ] Expected RED: `useState(readBrowserSessionRouteIdentity)` reads and canonicalizes browser state in the render initializer, producing an impure first render and mismatched server/client markup.

**Step 3: Write the stale-credential and timeout RED tests**

- [ ] Under D-07A, start with access token A and refresh credential R1; return access token B and rotating refresh credential R2 from `/api/viva-session/refresh`; fire `pageshow`, `popstate`, and manual retry paths. Assert every subsequent renewal submits R2, every socket/config/projection uses B, and no path reads A or R1.
- [ ] Under D-07A, assert the refresh POST contains exactly `{refresh_token:R1,session_id,study_set_id,user_id}`. It must not send `session_token`, use the access token as renewal authority, or put either credential in URL/history/storage.
- [ ] Supply a fetch promise that never settles. Advance fake time to 5,999 ms and assert no fallback; advance to 6,000 ms and assert the request signal is aborted and the result is `{status:"retained",credential:A/R1,reason:"timeout"}`. Before any socket has consumed A, initial entry may try A once rather than hang. After any opened generation, transport loss, browser restore, or typed `VOICE_AUTH_EXPIRED`, retained A is not eligible for a new generation; the page remains fail-closed with explicit recovery copy and keeps any Plan 03 audio ledger.
- [ ] Under D-07B, assert bootstrap/renewal calls only the named service replacement adapter and WebSocket connects only through its same-origin gateway. Assert zero requests to `/api/viva-session/start`, `/api/viva-session/refresh`, or direct agent WSS. If the named adapter contract was not frozen at preflight, these tests and implementation do not start.
- [ ] Unmount before the deadline and assert the abort fires, the timeout clears, and neither state nor connection is updated.
- [ ] Expected RED: the current helper owns no AbortController/deadline and `sessionTokenRef` retains the pre-refresh token.

**Step 4: Make the first client render neutral and move URL work to an effect**

- [ ] Initialize route state to an all-null `SessionRouteIdentity`. The first server and browser renders must expose the same loading shell and must not read `window`.
- [ ] In a mount effect, read the browser identity without mutating history, merge only an identity-matched in-memory credential (or the legacy access token for a nonrenewable Branch-A direct entry), synchronously commit it to one `BrowserSessionCredential` ref/state pair, then canonicalize the URL once. Guard the committed mount by attempt number so the throwaway StrictMode mount cannot connect or win a renewal race.
- [ ] Replace independent token state/ref writes with one `commitCredential(next)` callback that updates the authoritative ref before scheduling React state. All browser lifecycle callbacks read that ref.
- [ ] Canonicalization removes token parameters from query and fragment while preserving unrelated query/hash values.

**Step 5: Implement only the recorded D-07 renewal path, bound it, and defer connection**

- [ ] Implement the 6,000 ms timeout with a child `AbortController`; forward an outer abort to it; clear the timer and outer listener in `finally`.
- [ ] **D-07A `retain-token-only`:** reconstruct the exact `VivaSessionCredentialRotationResponse`, rejecting missing/extra/wrong-type fields and identity mismatch. Atomically replace access token, rotating refresh token, `refresh_expires_at`, and `session_absolute_expires_at` in the ref/vault before rendering state; terminal 401 clears the vault. A malformed/partial response clears the vault and returns `invalid_response` rather than retaining one half of a credential pair.
- [ ] **D-07B `require-service-auth`:** use only the preflight-named authenticated replacement adapter and same-origin gateway. The credential has no refresh token. Delete obsolete refresh calls/tests from this page/client; absence of the adapter is a hard pre-loop failure.
- [ ] Return the discriminated sanitized result above. Do not throw arbitrary fetch or JSON errors into UI state.
- [ ] Connection becomes eligible only when route resolution, selected-branch renewal/acquisition, and Task 3 projection validation are all complete for the same attempt. The zero-delay StrictMode deferral remains, but it is not the correctness mechanism.

**Step 6: Run focused tests**

```bash
bun test apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/lib/use-viva-agent-session.test.ts
```

Expected: all pass; console hydration spy has no calls; pending timers count is zero after every test.

**Step 7: Commit**

```bash
git add apps/web/test/setup-dom.ts apps/web/components/session/LiveSessionPage.tsx apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/lib/use-viva-agent-session.ts apps/web/lib/use-viva-agent-session.test.ts
git commit -m "fix(web): make session bootstrap hydration safe"
```

---

### Task 3: `WEBSESSION-DATA-01` / `WEBSESSION-PROGRESSION-01` / `WEBSESSION-MODE-01` — Render the authenticated projection, never a fixture overlay

**Files:**

- Modify: `apps/web/lib/viva-agent-client.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/lib/use-viva-agent-session.ts`
- Modify: `apps/web/lib/use-viva-agent-session.test.ts`
- Modify: `apps/web/components/session/LiveSessionPage.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.test.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.mounted.test.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.test.tsx`
- Modify: `apps/web/components/session/MarginaliaPanel.tsx`
- Modify: `apps/web/lib/viva-display.ts`
- Modify: `apps/web/lib/viva-display.test.ts`

**Interfaces:**

```ts
export type AuthenticatedStudyProjectionRequest = Readonly<{
  studySetId: string;
  voiceSessionId: string;
  accessToken: string;
  signal: AbortSignal;
}>;

export type AuthenticatedStudyProjectionResult =
  | { status: "ready"; projection: AuthenticatedStudyProjectionV1 }
  | {
      status: "failed";
      cause:
        | "invalid_request"
        | "unauthorized"
        | "not_found"
        | "rate_limited"
        | "timeout"
        | "invalid_projection"
        | "unavailable";
      retryAfterSeconds?: number;
    };

export const VIVA_STUDY_PROJECTION_TIMEOUT_MS = 8_000;

export async function fetchAuthenticatedStudyProjection(
  input: AuthenticatedStudyProjectionRequest,
  fetchImpl?: typeof fetch,
): Promise<AuthenticatedStudyProjectionResult>;

export function studyProjectionToAgentSessionConfig(
  projection: AuthenticatedStudyProjectionV1,
  userId: string,
): AgentSessionConfig;
```

The browser request is:

```ts
fetch(
  `/api/viva-session/projection?${new URLSearchParams({
    study_set_id: input.studySetId,
    voice_session_id: input.voiceSessionId,
  })}`,
  {
    cache: "no-store",
    headers: { authorization: `Bearer ${input.accessToken}` },
    method: "GET",
    signal: input.signal,
  },
);
```

The browser supplies normal same-origin fetch metadata; JavaScript does not attempt to set the forbidden `Sec-Fetch-Site` header. Plan 11 requires `Sec-Fetch-Site: same-origin`, forwards the signed access token plus its server-held scoped bearer, reconstructs/validates the response with Plan 04, applies an exact 8,000 ms BFF deadline, and returns `cache-control: no-store` without credentials. Its locked error bodies are:

```ts
type ProjectionProxyError =
  | {
      error: "viva_session_projection_request_invalid";
      failure_class: "projection_unavailable";
      stage: "pre_loop";
    }
  | {
      error: "session_auth_terminal";
      failure_class: "session_auth_failure";
      stage: "session";
      token_refresh_outcome: "terminal";
    }
  | {
      error: "viva_session_projection_not_found";
      failure_class: "projection_unavailable";
      stage: "pre_loop";
    }
  | { error: "session_projection_rate_limited"; failure_class: "rate_limit" }
  | {
      error: "viva_session_projection_unavailable" | "viva_session_projection_timeout";
      failure_class: "projection_unavailable";
      stage: "pre_loop";
    };
```

The browser helper independently owns an 8,000 ms AbortController for each attempt. It retries once only after 502 or 504, using a fresh 8,000 ms attempt and the same current credential/identity; it never retries 400, 401, 404, 429, or the 503 emitted when the required shared `SessionSecurityStore` is unavailable. It maps status/body into the discriminated result and never falls through to library metadata.

**Step 1: Write the projection-client RED tests**

- [ ] Assert the exact path/query/method/cache/header/signal above, with URL-encoded IDs and no credential in URL, response object, thrown text, or diagnostic.
- [ ] For locked 400, 401, 404, 429 plus integer `Retry-After`, shared-store 503, 502, 504/AbortError, invalid 200 schema, and non-JSON responses, assert the exact sanitized `cause`. Assert the response containing a sentinel token or malformed title is not returned in an error.
- [ ] With fake time, assert one retry after 502 and one retry after 504, with an independent 8,000 ms deadline per attempt. Assert a second 502/504 terminates as `unavailable`/`timeout`; 400/401/404/429/503 make exactly one request, and 503 makes no agent fallback call.
- [ ] Assert a valid response is parsed by Plan 04's shared validator and returned byte-for-byte as the `projection` object.
- [ ] Expected RED: no authenticated projection client exists.
- [ ] GREEN implementation creates and clears one child AbortController/timer per attempt, forwards the caller abort to the active attempt, retries only 502/504 once, validates a 200 through `validateAuthenticatedStudyProjectionV1`, and returns only the reconstructed frozen value or the sanitized result union.

**Step 2: Write a non-Biology mounted RED test**

- [ ] Return a projection with title `Thermodynamic State Functions`, course `CHEM-401`, exam label `Oral final`, concept labels `Enthalpy` and `Gibbs free energy`, session mode/goal distinct from quiz/Biology under D-03A, nonzero progress, an active question, and the recorded D-01 branch's review authority (`server_persisted_fsrs` under D-01A, `core_fsrs_read_time` under D-01B).
- [ ] Assert the mounted page renders those values and does not contain `Biology`, `biology-midterm`, or any seed concept. Assert socket creation is delayed until this response validates.
- [ ] Return a projection whose study-set/session IDs do not equal the route. Assert a sanitized pre-loop failure, zero WebSockets, and zero synthesized fallback.
- [ ] Expected RED: `seedStudySets[0]` is overlaid with route identifiers and marked server-owned/ready.

**Step 3: Map the projection directly into the signed session config**

- [ ] Delete `STUDY_SET`, the `seedStudySets` import, and `activeStudySet` overlay from the page.
- [ ] Migrate remaining test-only fixture imports per Plan 14A: in `apps/web/lib/viva-display.test.ts` and `apps/web/lib/use-viva-agent-session.test.ts`, import `seedStudySets` from `@viva/core/fixtures` instead of `@viva/core` (Plan 14A must be merged first; production code keeps zero `seedStudySets` imports). Verify with `rg -n "seedStudySets" apps/web --glob "!*.test.*"` returning no matches and Plan 14's import-split grep returning no `@viva/core` root fixture imports in `apps/web`.
- [ ] `studyProjectionToAgentSessionConfig` returns exactly:

```ts
{
  active_concepts: projection.concepts.map(({ id }) => id),
  initial_goal: projection.session.goal ?? undefined,
  mode: projection.session.mode,
  session_id: projection.session.id,
  source_context: [],
  study_set_id: projection.studySet.id,
  user_id: userId,
}
```

- [ ] Change `UseVivaAgentSessionOptions` to accept `{session: AgentSessionConfig; sessionToken}` rather than `{studySet,mode,...}`. Delete `studySetToAgentSessionConfig` and the client-side `agentStudySetReadiness` derivation. Readiness comes from the authenticated projection plus the readiness probe, not a `StudySet` fixture.
- [ ] Render study title/course/exam label, concept labels/status, active question/progress, and review schedule from the projection. Route identity is used only to request and verify that projection.
- [ ] Under the recorded D-02 branch, render `activeQuestion` and `questionProgress` exactly as the server projection/events advance them. D-02A adaptive progression and D-02B deterministic ordered retry/exhaustion are executable alternatives, but the browser must never choose the next question, reorder retries, infer exhaustion, or label either policy as recommended/default. Add a differential test proving two successive server projections drive the displayed question/progress without a client-generated question transition.

**Step 4: Preserve server recap and review authority**

- [ ] Stop passing server recap events through `recapPlanFromSessionEvents`; render the validated recap payload as emitted. Delete the helper if no other production caller remains; otherwise remove only the session call and retain tests for remaining callers.
- [ ] Do not recompute FSRS due dates in the browser. Render `reviewSchedule[].dueAt` and `authority`; resolve labels by `conceptId` from the same projection. An unknown referenced concept is a sanitized invalid-projection state, not a guessed label.
- [ ] Delete hard-coded `core FSRS` display copy.

**Step 5: Implement only the recorded D-03 branch; the executable alternatives are specified below**

- [ ] **D-03 Branch A — signed mode + optional goal:** retain selected mode/goal affordances owned upstream; prove the projection returns them; pass them exactly to `AgentSessionConfig`; assert no route/query/local-storage value can override the signed projection.
- [ ] **D-03 Branch B — one honest oral exam:** remove free-text/four-mode session affordances from this page; consume the single server projection mode/goal without displaying a false selector; assert no ignored goal is read from the route and no default `quiz` is injected.
- [ ] Under either branch, add a differential test with two projections whose only differences are `mode` and `goal`; the serialized first `session_config` must differ exactly in those fields and never take values from a Biology seed.

**Step 6: Fail closed on projection failure**

- [ ] While unresolved, render a neutral `Preparing your session` state with microphone/text/connection controls disabled.
- [ ] For a failed result, render one cause-specific sanitized pre-loop state and an explicit retry that reruns refresh plus projection for the latest route attempt. Never call `connect` and never call the library snapshot endpoint.
- [ ] A valid projection with `ingestionStatus:"pending"|"processing"|"retry"` renders the server status and does not connect until an explicit/settled projection refetch returns `ready`; `failed` renders a sanitized ingestion failure action. Never overwrite these states with local `ready`.
- [ ] Abort the projection request on route change, browser lifecycle replacement, retry supersession, and unmount.

**Step 7: Run focused tests**

```bash
bun test apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/lib/viva-display.test.ts apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/components/session/LiveSessionShell.test.tsx
```

**Step 8: Commit**

```bash
git add apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/lib/viva-display.ts apps/web/lib/viva-display.test.ts apps/web/components/session/LiveSessionPage.tsx apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/components/session/LiveSessionShell.tsx apps/web/components/session/LiveSessionShell.test.tsx apps/web/components/session/MarginaliaPanel.tsx
git commit -m "fix(web): render authenticated session projection"
```

---

### Task 4: `WEBSESSION-PROTOCOL-01` / `WEBSESSION-RECAP-01` / `WEBSESSION-DEFERRED-01` — Consume typed errors, deferred turns, close outcomes, and terminal recap semantics

**Files:**

- Modify: `apps/web/lib/viva-agent-client.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/lib/use-viva-agent-session.ts`
- Modify: `apps/web/lib/use-viva-agent-session.test.ts`
- Modify: `apps/web/lib/viva-session-projection.ts`
- Modify: `apps/web/lib/viva-session-projection.test.ts`

**Interfaces:**

```ts
export type VivaAgentDiagnostic = Readonly<{
  code: VivaVoiceDiagnosticCode | VivaVoiceServerErrorCode | "WEB_VOICE_INTERNAL";
  path: string | null;
}>;

export type VivaAgentStructuredError =
  | Readonly<{ terminality: "recoverable" }>
  | Readonly<{
      terminality: "terminal";
      terminalReason: AgentTerminalSessionReason;
    }>;

export type VivaAgentRecapState =
  | { kind: "complete"; recap: AgentStudySessionRecap }
  | {
      kind: "partial";
      recap: AgentStudySessionRecap;
      partialReason: AgentTerminalSessionReason;
    };

export type VivaAgentDeferredTurn = Readonly<{
  turnId: string;
  responseId: string;
  questionId: string;
  reason:
    | "empty_answer"
    | "transcript_uncertain"
    | "evaluator_unavailable"
    | "invalid_evaluator_output"
    | "insufficient_semantic_evidence"
    | "contradictory_evidence";
  canRetrySameQuestion: boolean;
}>;

export type VivaAgentProtocolStateFields = {
  diagnostics: VivaAgentDiagnostic[];
  structuredErrors: VivaAgentStructuredError[];
  deferredTurn?: VivaAgentDeferredTurn;
  recap?: VivaAgentRecapState;
  lastServerError?: Pick<VivaServerError, "code" | "retryable">;
  termination?: VivaVoiceTermination;
};
```

Replace the current free-form error/recap/termination members of `VivaAgentSessionState` with every exact member of `VivaAgentProtocolStateFields`; its question/transcript/evaluation/audio/generation fields remain the post-Plan-03 definitions. Do not preserve a parallel `errors: string[]` that can carry arbitrary payload text. If user-safe copy needs detail, it maps from the typed code in `viva-session-projection.ts`.

**Step 1: Write malformed-frame RED tests**

- [ ] Deliver malformed JSON containing a unique transcript, URL, signed-token sentinel, and the English words `auth` and `token`. Assert none appears in client state, DOM copy, console, or thrown test output.
- [ ] Assert state records `{code:"VOICE_PROTOCOL_MALFORMED_JSON",path:"$"}` and runtime projection chooses a protocol failure, never an auth failure.
- [ ] Load Plan 05's v5 differential/terminal fixture manifest and account for every named invalid family: non-object envelope; unknown frame/event; unsupported v4 and future version; deletion of every required key; every wrong scalar type; empty or malformed generation/turn/response/question/source ID; an unknown key at every nested object boundary; forbidden authority; non-string `error.message`; noncanonical base64url; audio sequence duplicate, gap, reorder, and end mismatch; decoded chunk above 8,192 bytes; decoded turn above 2,160,000 bytes; unknown deferral reason; deferred event carrying forbidden `retryable`, `terminal_reason`, grading, mastery, or schedule fields; inconsistent partial-recap reason; and inconsistent structured-error terminality.
- [ ] For every server-differential/terminal case in that manifest, feed the raw fixture JSON through the imported Plan 05 parser and assert its exact `VivaVoiceProtocolError.code` and JSON `path`, with no raw value retained. Keep client-only signed-config/token authority, outbound audio assembly, and browser `tool_result` cases under the Task 1 Plan 05 regression plus Task 13's outbound-boundary tests. Do not invent a second web parser or duplicate fixture expectations by hand.
- [ ] Expected RED: the `catch` stores `error.message`, and runtime copy regexes arbitrary diagnostic text for auth keywords.

**Step 2: Write typed close RED tests**

- [ ] Table-test every Plan 05 `VivaVoiceTermination.kind`. Assert terminal reason wins over typed error; typed error wins over normal close; clean code 1000 becomes normal; unclean/other close becomes transport.
- [ ] Deliver a valid typed server error whose `message` contains a token/transcript sentinel. Assert classification uses its typed `code`, while client state, DOM, console, and close copy contain no sentinel or server message.
- [ ] Assert only `VOICE_AUTH_EXPIRED` schedules credential refresh; invalid, identity mismatch, and replayed auth do not. Assert protocol is never retried; service and transport are retryable.
- [ ] Assert close event `reason`, including the server phrases previously maintained in a drifting allowlist, is never used for classification or displayed. The Plan 05 fixture is authoritative; do not copy it into a web-only array. This supersedes the display half of ledger row "Web live-session client Minor M3": under the Plan 05 typed-termination contract no close-reason text is ever displayed, so submit a coordinator request (this lane may not edit the ledger) to update that row's required proof to: "Close-reason text is never parsed or displayed; user copy derives only from typed `VivaVoiceTermination` codes pinned to `agent/fixtures/voice-protocol/v5/transport-outcomes.json`, so server reason drift cannot produce redaction placeholders." Record the coordinator's acknowledgment in the execution log before marking `WEBSESSION-PROTOCOL-01` complete.

**Step 3: Write recap/error RED tests**

- [ ] Fold `{partial:false}` recap: state becomes `kind:"complete"`; the socket may receive its trailing terminal phase, but UI is already terminal-success and cannot submit.
- [ ] Fold `{partial:true,partial_reason:"turn_cap"}` without a trailing phase: state immediately becomes `kind:"partial"`, terminal reason becomes `turn_cap`, pending input clears, and no reconnect is scheduled.
- [ ] If a trailing terminal phase disagrees with the partial reason, assert Plan 05 parsing rejects it with a sanitized invariant diagnostic.
- [ ] Fold a recoverable `structured_error`: the typed terminality is retained, socket status remains `open`, pending state follows the frame's response/turn semantics, and the next legal submit remains possible. Its free-form `source`, `code`, and `message` are not copied into user/client diagnostic state.
- [ ] Fold a terminal `structured_error`: terminal reason and termination are set immediately, input closes, capture/playback cleanup is requested, and no reconnect is scheduled.

- [ ] Table-test all six canonical `turn_deferred.reason` values with both `can_retry_same_question` booleans. Preserve exact turn/response/question identity; keep the socket open and phase nonterminal; emit no evaluation, concept/mastery change, recap success, or review-schedule mutation.
- [ ] When `can_retry_same_question:true`, project one neutral `Retry this question` action bound to the same question ID. When false, render neutral deferred copy with no retry-current action. Never infer retryability from `reason`, and never expect obsolete `retryable` or `terminal_reason` fields.
- [ ] A later valid question/answer progression clears the matching deferred state. A stale deferred event from a prior generation/turn increments stale-event accounting and cannot replace the current question.

**Step 4: Consume Plan 05 types without recoding them**

- [ ] Catch only `VivaVoiceProtocolError` fields `{code,path}`; map any non-protocol local exception to one fixed internal browser diagnostic, without calling `String(error)`.
- [ ] Store only `{code,retryable}` from the last parsed typed server error and discard its free-form message. On `close`, call `classifyVivaVoiceTermination` with that typed pair plus `message:""`, the terminal reason, close code, and `wasClean`; persist only the returned union.
- [ ] Delete close-reason safe-string allowlists and the regex-based `/auth|token|claim|unauthori[sz]ed/i` classifier at `apps/web/lib/viva-session-projection.ts:220`.
- [ ] Preserve the Plan 05 structured-error and partial-recap discriminants exactly. Do not infer terminality from message, socket status, or source, and do not retain free-form structured-error fields in learner-visible state.
- [ ] Consume Plan 04/05's exact `turn_deferred` event into `VivaAgentDeferredTurn`; do not convert it to a structured error, terminal reason, grading result, or reconnect trigger.

**Step 5: Project typed user copy**

- [ ] Add a total switch over `VivaVoiceTermination.kind`, protocol diagnostic code, deferred turn, complete recap, and partial recap. Every branch returns a safe capsule/status/action; TypeScript's `never` check must fail when a new kind is added.
- [ ] A recoverable structured error is visible but does not replace the live connection capsule. A terminal structured error uses its terminal reason's existing contract copy.
- [ ] A complete recap is success. A partial recap says the session ended with a usable partial recap and names only the approved terminal-reason copy, never the server message.

**Step 6: Remove now-dead branches after characterization**

- [ ] Keep a characterization test for terminal recap reduction, then delete the redundant `viva-agent-client.ts` reducer branch identified by WSC-M08. The same event sequence must produce an identical public state before and after deletion.

**Step 7: Run focused tests**

```bash
bun test apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/lib/viva-session-projection.test.ts
```

**Step 8: Commit**

```bash
git add apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/lib/viva-session-projection.ts apps/web/lib/viva-session-projection.test.ts
git commit -m "fix(web): consume typed voice termination semantics"
```

---

### Task 5: `WEBSESSION-RECOVERY-01` / `WEBSESSION-AUDIO-01` — Add bounded recovery and idempotent retained-audio replay

**Files:**

- Modify: `apps/web/lib/viva-agent-client.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/lib/use-viva-agent-session.ts`
- Modify: `apps/web/lib/use-viva-agent-session.test.ts`
- Modify: `apps/web/components/session/LiveSessionPage.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.test.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.mounted.test.tsx`
- Modify: `apps/web/lib/viva-session-projection.ts`
- Modify: `apps/web/lib/viva-session-projection.test.ts`

**Interfaces:**

```ts
export const VIVA_AGENT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000] as const;
export const VIVA_AGENT_RECONNECT_JITTER_MS = 100;

export type VivaAgentReconnectState =
  | { kind: "idle"; attempts: 0 }
  | { kind: "scheduled"; attempt: 1 | 2 | 3; delayMs: number }
  | { kind: "refreshing_credential"; attempt: 1 | 2 | 3 }
  | { kind: "connecting"; attempt: 1 | 2 | 3 }
  | { kind: "exhausted"; attempts: 3 };

export type VivaAgentReconnectClock = Readonly<{
  random: () => number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}>;

export function reconnectDelayMs(attempt: 1 | 2 | 3, random: number): number {
  return VIVA_AGENT_RECONNECT_DELAYS_MS[attempt - 1]
    + Math.floor(Math.min(0.999_999, Math.max(0, random)) * VIVA_AGENT_RECONNECT_JITTER_MS);
}
```

Every first retry is 500–599 ms, beyond the server's 250 ms lease grace. There is exactly one scheduled timer and one refresh AbortController per mounted page attempt.

**Step 1: Write generation-safety and page-recovery RED tests**

- [ ] Close generation 1 with unclean 1006; schedule attempt 1 at deterministic 550 ms; assert no socket before 549 ms and one new generation at 550 ms.
- [ ] Fire stale `message`, `error`, and `close` callbacks from generation 1 after generation 2 opens. Assert no state, retry counter, retained ledger, or transcript changes.
- [ ] Fail three generations and assert delays 500/1,000/2,000 ms under random 0, then `kind:"exhausted"` with no fourth timer. A manual retry remains enabled.
- [ ] Reach `ready` on a replacement generation and assert attempts reset to idle.
- [ ] Expected RED: no automatic bounded reconnect state exists.

**Step 2: Write stop-condition RED tests**

- [ ] Assert no retry after complete or partial recap, terminal reason, terminal structured error, protocol/auth nonretryable termination, clean 1000, explicit `close`, explicit `stop`, controller replacement, or component unmount.
- [ ] For `VOICE_AUTH_EXPIRED` under D-07A, assert the page performs one bounded `/api/viva-session/refresh` with the current rotating refresh credential, atomically commits both returned credentials, then opens a new WebSocket generation. Under D-07B, assert it invokes the named service replacement once and opens only the same-origin gateway with the returned access token. Neither branch sends a token-bearing in-socket `session_refresh`.
- [ ] For transport/service retry, use the selected D-07 renewal path before opening the new generation so a consumed/replay-protected access token is never reused. If renewal times out/fails, consume one bounded attempt, show sanitized recovery copy, and retain the ledger for manual recovery without opening a socket.
- [ ] After successful credential renewal/replacement, refetch and identity-validate `/api/viva-session/projection` with the new access token before opening the replacement socket. Feed any changed question/progress/concept/schedule/session config into the page; projection failure leaves the socket closed and ledger retained.

**Step 3: Write retained-audio RED tests against the Plan 03 seam**

- [ ] Stream an irregular multi-chunk turn from the mounted page. Close between a `pending` chunk and `audio_end`. Assert the page does not clear/cancel the turn and Plan 03's ledger reports the original `turnId`, sequences, and `retainedFromSequence`.
- [ ] After refreshed credential and replacement `ready`, assert exactly one `retryPendingAudio()` call. Assert replay uses the original `turn_id` and original sequence bytes, then releases only on `audio_turn_accepted`.
- [ ] Repeat close after `audio_end` but before ACK. Assert the entire turn is retried idempotently and only one server admission/evaluation is represented after ACK.
- [ ] Exhaust reconnect. Assert the UI says the spoken answer is retained for retry, and explicit retry calls `retryPendingAudio()` once after the next ready generation.
- [ ] Cancel, session cap, terminal recap, or user discard calls `cancelAudioTurn(turnId)` and releases the retained UI turn. A mere `pending` or `socket_closed` result never calls it.
- [ ] Expected RED after Plan 03: retention exists, but cross-generation recovery/UX does not.

**Step 4: Implement one recovery owner**

- [ ] Keep socket open/close/generation state in the controller. Keep async browser credential refresh and component cleanup in `LiveSessionPage` using the typed `termination` and injected clock.
- [ ] Register no timer until a close is classified. Cancel the timer before opening a replacement and on every stop condition. Attempt tokens prevent a late refresh from opening a stale generation.
- [ ] The recovery order is fixed: lease-grace delay → selected D-07 credential renewal → authenticated projection refetch → create new generation → receive matching `ready` → call `retryPendingAudio` once. No later step runs if an earlier attempt is aborted, stale, or failed.
- [ ] `useVivaAgentSession` exposes Plan 03's audio methods unchanged and never creates a retry timer. `LiveSessionPage` owns the single `VivaAgentReconnectState`, passes it into runtime projection, and exposes one explicit manual recovery action after exhaustion.
- [ ] Preserve current transcript/question/projection while reconnecting; label it stale/recovering. Reset only generation-local pending response state. Never wipe the authenticated study projection when `openSocket` resets transport state.

**Step 5: Make typed submission ambiguity explicit**

- [ ] Keep learner-entered text visible until the server advances the turn. On ambiguous close, do not auto-resend it; render `Reconnect and retry answer` after ready.
- [ ] Keep citation challenge enabled for an explicit retry only if the target response/source IDs are still current. Never transform it into answer text.

**Step 6: Project recovery copy**

- [ ] Scheduled/refreshing/connecting copy says `Reconnecting…` and disables duplicate retry controls.
- [ ] Exhausted copy says `Connection lost` and exposes one manual retry. If audio remains retained, say `Your spoken answer is retained on this device for retry`; do not claim the server received it before ACK.
- [ ] Terminal and recap copy always outrank recovery copy.

**Step 7: Run focused tests**

```bash
bun test apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/lib/viva-session-projection.test.ts apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx
```

**Step 8: Commit**

```bash
git add apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/lib/viva-session-projection.ts apps/web/lib/viva-session-projection.test.ts apps/web/components/session/LiveSessionPage.tsx apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx
git commit -m "fix(web): recover retained voice turns safely"
```

---

### Task 6: `WEBSESSION-INTENT-01` / `WEBSESSION-DISCLOSURE-01` — Send typed challenge intent and enforce the selected disclosure scope

**Files:**

- Modify: `apps/web/lib/viva-agent-client.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/lib/use-viva-agent-session.ts`
- Modify: `apps/web/lib/use-viva-agent-session.test.ts`
- Modify: `apps/web/components/session/LiveSessionPage.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.test.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.mounted.test.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.test.tsx`

**Interfaces:**

```ts
export type VivaClientTurnIntent =
  | { kind: "answer_text"; text: string }
  | { kind: "citation_challenge"; response_id: string; source_id: string };

export type VivaTurnIntentSendResult =
  | { status: "sent"; turnId: string }
  | { status: "pending"; turnId: string }
  | {
      status: "rejected";
      turnId: string;
      diagnostic: Readonly<{ code: VivaVoiceDiagnosticCode; path: string }>;
    }
  | {
      status: "socket_closed";
      turnId: string;
      retryable: true;
      error: VivaClientSendError;
    };

export type VivaAgentSessionControllerTurnIntentAddition = {
  sendTurnIntent(input: {
    turnId: string;
    intent: VivaClientTurnIntent;
  }): VivaTurnIntentSendResult;
};

export type DisclosureScope = "all_live_provider_content" | "microphone_audio_only";

export function providerInputAllowed(input: {
  acknowledged: boolean;
  input: "microphone_audio" | "typed_answer" | "citation_challenge";
  liveProvider: boolean;
  scope: DisclosureScope;
}): boolean;
```

The controller serializes Plan 05's exact frame:

```ts
{
  type: "turn_intent",
  version: 5,
  client_generation_id: generationId,
  turn_id: turnId,
  intent,
}
```

**Step 1: Write the challenge RED tests**

- [ ] Mount a current response/source, click `Challenge citation`, and assert one `turn_intent` with `kind:"citation_challenge"`, exact response/source IDs, stable `turn_id`, v5, and current generation ID.
- [ ] Assert no frame contains `(challenge citation)`, no `answer_text` frame is emitted, pending answer state is not reused, and the client does not synthesize an answer evaluation/mastery update.
- [ ] Change the current response before click and assert the stale challenge is disabled rather than targeting a different response.
- [ ] Expected RED: the page sends the literal string through `sendText`.

**Step 2: Implement the typed controller method**

- [ ] Add `VivaAgentSessionControllerTurnIntentAddition.sendTurnIntent` to the post-Plan-03 `VivaAgentSessionController`, using the current generation and Plan 05 frame type. Return the discriminated result above so the page can distinguish an occupied pending slot from a closed socket.
- [ ] Keep typed content visible on `pending`/`rejected`/`socket_closed`. Project a rejected frame only from its typed diagnostic; do not display content or a parser message. Do not put typed content into the audio ledger and do not auto-replay it.
- [ ] Remove the page's magic string and all tests accepting it.

**Step 3: Implement only the recorded D-08 branch; the executable alternatives are specified below**

- [ ] **D-08 Branch A — all live typed and voice content:** `providerInputAllowed` returns false before acknowledgment for microphone audio, typed answer, and citation challenge when the selected provider is live. The page labels the gate as covering typed and spoken content; after acknowledgment all three become eligible. Synthetic/local paths retain their explicitly labeled non-live behavior.
- [ ] **D-08 Branch B — microphone audio only:** `providerInputAllowed` gates only microphone audio. Typed answer and citation challenge remain available before acknowledgment. Session-page copy says exactly that microphone audio is sent for processing and does not imply typed content is gated.
- [ ] Plan 13 owns matching landing/general copy. This task changes only session behavior and `LiveSessionShell` session text.
- [ ] Under either branch, microphone capture creation is impossible before its required acknowledgment. A disabled button or hidden panel alone is insufficient; assert the capture factory has zero calls.

**Step 4: Scope acknowledgment persistence**

- [ ] Persist only a boolean in `sessionStorage` under `viva:disclosure:v1:<scope>:<studySetId>:<voiceSessionId>`. Never store content, token, user ID, transcript, or audio.
- [ ] Hydrate the boolean after the route/projection is resolved. A different session, study set, or D-08 scope must require a new acknowledgment. Same-tab refresh for the same scope/identity restores it.
- [ ] Clear in-memory consent on route identity change before starting another capture.

**Step 5: Run focused tests**

```bash
bun test apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/components/session/LiveSessionShell.test.tsx
```

**Step 6: Commit**

```bash
git add apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/components/session/LiveSessionPage.tsx apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/components/session/LiveSessionShell.tsx apps/web/components/session/LiveSessionShell.test.tsx
git commit -m "fix(web): send typed learner turn intents"
```

---

### Task 7: `WEBSESSION-READY-01` — Bound readiness work and eliminate overlapping polls

**Files:**

- Modify: `apps/web/lib/viva-agent-client.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/components/session/LiveSessionPage.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.test.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.mounted.test.tsx`

**Interfaces:**

```ts
export const VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS = 4_000;
export const VIVA_AGENT_READINESS_POLL_INTERVAL_MS = 5_000;

export async function fetchVivaAgentReadinessProbe(input?: {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<VivaAgentReadinessProbe>;
```

**Step 1: Write RED tests for a stalled and slow probe**

- [ ] Make one health endpoint never settle; advance to 4,000 ms; assert all readiness requests abort and return the existing sanitized unavailable facts.
- [ ] Make a request take 4,500 ms; assert no second poll begins at the five-second wall-clock boundary while the previous lifecycle is still settling.
- [ ] Unmount or replace route identity during a poll; assert every request signal aborts, no state update occurs, and no timer remains.
- [ ] Expected RED: `Promise.all` has no signal/deadline and `setInterval` can overlap slow work.

**Step 2: Add request-level abort consumption**

- [ ] Pass the same signal into every readiness fetch. Keep the result total and sanitized; distinguish availability in structured probe facts, not exception strings.
- [ ] Do not add retries inside one poll. Repetition belongs to the page poll lifecycle.

**Step 3: Replace interval with settle-then-schedule**

- [ ] Start a poll, await settlement, then schedule the next start 5,000 ms later. Keep one AbortController and one timeout handle.
- [ ] Abort and clear on unmount, projection failure, terminal recap, and superseding route attempt. Reconnect does not create a second readiness loop.
- [ ] Track consecutive failed/aborted polls in the single poll owner; after 3 consecutive failures, surface the existing sanitized readiness-unavailable copy with a `data-consecutive-failures` count on the readiness status element while continuing the same 5,000 ms cadence; a success resets the counter. Add a RED test driving three consecutive never-settling polls with fake time and asserting the surfaced bounded-failure state and its reset on the next success.

**Step 4: Run focused tests**

```bash
bun test apps/web/lib/viva-agent-client.test.ts apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx
```

**Step 5: Commit**

```bash
git add apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts apps/web/components/session/LiveSessionPage.tsx apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx
git commit -m "fix(web): bound session readiness polling"
```

---

### Task 8: `WEBSESSION-CAPTURE-01` — Close every partial capture construction and, if needed, add anti-alias filtering

**Files:**

- Modify: `apps/web/lib/viva-audio-capture.ts`
- Modify: `apps/web/lib/viva-audio-capture.test.ts`
- Read-only regression: `apps/web/components/session/LiveSessionPage.tsx`
- Read-only regression: `apps/web/components/session/LiveSessionPage.mounted.test.tsx`

**Step 1: Preserve Plan 03's resampler before making changes**

- [ ] Run the long irregular-block 44.1 kHz and 48 kHz tests and record sample counts/hash assertions. Do not replace the rational-phase resampler or reset its phase per callback.

**Step 2: Write partial-construction RED tests**

- [ ] Make `createMediaStreamSource` throw after `getUserMedia` and context creation. Assert every stream track stops once, context closes once, no worklet listener remains, and any created object URL is revoked once.
- [ ] Make `AudioWorkletNode` construction throw after source creation and module loading. Assert source disconnects, all tracks stop, context closes, module/object URL cleanup occurs exactly once, and no callback can emit a later frame.
- [ ] Make `source.connect`, `worklet.connect`, and start/resume fail independently. Assert the same idempotent cleanup.
- [ ] Call returned `stop()` twice after successful construction and assert each underlying resource is released once.
- [ ] Expected RED: node creation sits outside a complete cleanup boundary.

**Step 3: Put construction inside one cleanup boundary**

- [ ] Register each resource immediately after creation in reverse-order cleanup. On any throw, run that idempotent cleanup before rethrowing the existing typed availability error.
- [ ] Remove message listeners before disconnecting/closing. Stop tracks even when context close rejects. Use `Promise.allSettled` or isolated cleanup branches so one failure cannot suppress later releases.
- [ ] Do not log raw browser exception messages or media labels.

**Step 4: Add the WSC-M07 anti-alias RED tests**

- [ ] Downsample deterministic 48 kHz tones at 1 kHz, 10 kHz, 14 kHz, 18 kHz, and 22 kHz through irregular block boundaries. Measure RMS in the 24 kHz output.
- [ ] Assert 1 kHz amplitude stays within 5% of the native-path reference; 10 kHz stays within 10%; each input above the 12 kHz output Nyquist is attenuated by at least 20 dB relative to the 1 kHz reference; output contains no NaN/clipped samples.
- [ ] Repeat 44.1 kHz with a 16 kHz tone and assert the same 20 dB rejection plus Plan 03's exact long-run output sample count.

**Step 5: Implement only the quality layer if Plan 03 does not already pass it**

- [ ] If the new tests are already green, retain them and make no resampler source change.
- [ ] If red, add a stateful low-pass stage ahead of Plan 03's rational-phase converter. Coefficients/state persist across callbacks, native 24 kHz bypass remains byte-identical, and reset occurs only when a capture instance ends.
- [ ] Do not add a dependency without measuring bundle impact and obtaining Plan 13's performance-owner agreement. A small deterministic in-module filter is preferred.

**Step 6: Run focused tests**

```bash
bun test apps/web/lib/viva-audio-capture.test.ts apps/web/components/session/LiveSessionPage.mounted.test.tsx
```

**Step 7: Commit**

```bash
git add apps/web/lib/viva-audio-capture.ts apps/web/lib/viva-audio-capture.test.ts
git commit -m "fix(web): harden browser audio capture cleanup"
```

If only tests were added because Plan 03 already met the anti-alias gate, use `test(web): prove browser audio filter quality`.

---

### Task 9: `WEBSESSION-PLAYBACK-01` — Recompute playback schedule from surviving nodes

**Files:**

- Modify: `apps/web/lib/viva-audio-playback.ts`
- Modify: `apps/web/lib/viva-audio-playback.test.ts`

**Interfaces:**

```ts
type ScheduledPlaybackFrame = Readonly<{
  responseId: string;
  source: AudioBufferSourceNode;
  buffer: AudioBuffer;
  sequence: number;
  startTime: number;
  endTime: number;
}>;
```

**Step 1: Write the phantom-gap RED test**

- [ ] At context time 10, enqueue response A for 2 seconds and response B for 3 seconds. Advance current time to 10.5, cancel A while future-scheduled B survives, then enqueue C for 1 second.
- [ ] Assert A stops; B's old one-shot source stops and is recreated from its retained `AudioBuffer` at 10.5; C starts at B's new 13.5 `endTime`. Include the inverse cancellation—cancel future B while active A survives, so C starts at A's end—and empty-queue cancellation, where the next frame starts at `currentTime`.
- [ ] Assert cancellation invokes every discarded/replaced node's `stop` and `disconnect` once, never restarts a survivor that has already begun, and publishes one coherent scheduled count/state after rescheduling.
- [ ] Expected RED: cancellation resets `nextStartTime` only when the whole queue empties.

**Step 2: Track intervals and recompute**

- [ ] Store buffer, sequence, `startTime`, and `endTime` for each scheduled node. After cancellation, retain an already-started survivor at its current interval; clear `onended`, stop, and recreate each future survivor in sequence order contiguously from `max(context.currentTime, activeSurvivorEndTimes)`. Then set `nextStartTime = max(context.currentTime, ...survivingEndTimes)`; when no frames survive it becomes `context.currentTime`.
- [ ] Keep response-specific cancellation behavior and state notifications unchanged.

**Step 3: Characterize then delete the dead queue variable**

- [ ] Add a characterization test proving all queued frames are scheduled/drained. Delete the always-empty `remainingQueue` variable identified by WSC-M08; assert the public schedule and callbacks remain identical.

**Step 4: Run focused tests**

```bash
bun test apps/web/lib/viva-audio-playback.test.ts
```

**Step 5: Commit**

```bash
git add apps/web/lib/viva-audio-playback.ts apps/web/lib/viva-audio-playback.test.ts
git commit -m "fix(web): close cancelled playback schedule gaps"
```

---

### Task 10: `WEBSESSION-TERMINAL-01` / `WEBSESSION-A11Y-01` / `WEBSESSION-A11Y-02` — Render recap success, session landmarks, local dates, and an explicit transcript toggle

**Files:**

- Modify: `apps/web/lib/viva-session-projection.ts`
- Modify: `apps/web/lib/viva-session-projection.test.ts`
- Modify: `apps/web/components/session/LiveSessionPage.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.test.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.mounted.test.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.test.tsx`
- Modify: `apps/web/components/session/SessionBottomControls.tsx`
- Modify: `apps/web/components/session/SessionBottomControls.test.tsx`
- Modify: `apps/web/components/session/MarginaliaPanel.tsx`

**Interfaces:**

```ts
export type RuntimeCompletionProjectionInputs = {
  recap?: VivaAgentRecapState;
  completion?: { recapPersisted: true };
  termination?: VivaVoiceTermination;
  reconnectState: VivaAgentReconnectState;
};

export type TranscriptDisclosureProps = {
  transcriptId: string;
  transcriptOpen: boolean;
  onTranscriptOpenChange(open: boolean): void;
};
```

Add every `RuntimeCompletionProjectionInputs` field to `RuntimeProjectionContext`, and every `TranscriptDisclosureProps` field to `SessionBottomControlsProps`; do not create parallel optional controls with different names.

**Step 1: Write terminal precedence RED tests**

- [ ] Project `status:"closed"` plus `completion:{recapPersisted:true}` from a complete authorized recap. Assert capsule `Session complete`, marginalia title `Session recap ready.`, marginalia text `Viva saved the evidence-backed recap and review plan.`, status `session complete`, next/primary action `Start a new session`, no `Session not connected`, and no `Retry agent`.
- [ ] Project a partial recap plus a later transport close. Assert partial terminal copy wins and no reconnect/disconnection copy replaces it.
- [ ] Project an unexpected close without recap. Assert bounded recovery/exhausted copy from Task 5 remains.
- [ ] Expected RED: generic closed state currently wins after recap.

**Step 2: Make successful recap a first-class projection input**

- [ ] Check `recap` before closed/disconnected state in `projectRuntimeCopy`; check terminal recap before reconnect state; check reconnect before generic disconnected state.
- [ ] Pass `completion: { recapPersisted: true }` into the runtime projection only after an authorized complete `recap_ready` has been parsed and retained. Consume Plan 04's canonical `recap_success` cause/state `session_completed`; do not edit the learner-loop TS/JSON contract and do not cast the cause.
- [ ] Complete recap disables answer/microphone controls and offers only the approved next-session/navigation action. Partial recap does the same with partial reason copy.
- [ ] Page terminal effect stops capture, cancels playback, aborts readiness/reconnect work, and leaves the recap visible.

**Step 3: Write transcript accessibility RED tests**

- [ ] Mount the controls with a nonempty transcript. Query a button named `Show transcript`; assert `aria-expanded="false"`, `aria-controls` targets one transcript region, and the region is hidden.
- [ ] Activate by click and Enter/Space; assert label becomes `Hide transcript`, `aria-expanded="true"`, the same region is visible, and text is available to assistive technology.
- [ ] Toggle closed and assert focus remains on the button. When transcript becomes empty, assert the button is disabled/absent according to the existing visual contract and no unlabeled details landmark exists.
- [ ] Expected RED: native `<details>` supplies an ambiguous disclosure without the required explicit state/relationship contract.

**Step 4: Add the session landmark and skip target with RED/GREEN proof**

- [ ] Write a mounted test expecting exactly one `main` and one link named `Skip to current question and answer`. Run it RED and confirm the failure reports zero of each in the reviewed component.
- [ ] Change `LiveSessionShell`'s root from `section.live-session` to `main.live-session` with stable `id="live-session-main"`. Render the skip link as the first focusable child and target `id="live-session-turn"` on the question/answer stage wrapper with `tabIndex={-1}`. The skip link is visually hidden until keyboard-focused and visible on focus, using only existing Plan-13-owned utility/focus-visible classes (Plan 13 Task 3 requires visible-on-focus); add a mounted assertion that the link is not visible before focus and visible after programmatic focus.
- [ ] Tab to and activate the skip link. Assert focus becomes the exact `#live-session-turn` element; opening Source Folio and text-answer mode retains their existing more-specific focus transfer. Assert the route has exactly one `main` before and after recap.
- [ ] Use the existing Plan-13-owned focus-visible class/style contract; do not edit globals or tokens.

**Step 5: Replace the transcript disclosure**

- [ ] Own `transcriptOpen` in the page so recap, route change, and unmount can close it deterministically. Render a semantic `<button type="button">` with `aria-expanded` and `aria-controls`; render transcript in a stable-ID region using `hidden`.
- [ ] Preserve visible styling using existing component classes only. Do not edit globals/tokens.

**Step 6: Fix local review dates and authority display**

- [ ] Under `TZ=America/Los_Angeles`, render `2026-08-24T01:00:00Z` and assert the local calendar label is August 23. Under `TZ=UTC`, assert August 24.
- [ ] Replace UTC-field extraction with `Intl.DateTimeFormat` using the runtime locale/time zone. Invalid timestamps render a safe `Review date unavailable`, not `Invalid Date` or the raw value.
- [ ] Render the server projection's schedule authority instead of hard-coded `core FSRS`.

**Step 7: Run focused tests**

```bash
TZ=America/Los_Angeles bun test apps/web/lib/viva-session-projection.test.ts apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/components/session/LiveSessionShell.test.tsx apps/web/components/session/SessionBottomControls.test.tsx
TZ=UTC bun test apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionShell.test.tsx
```

**Step 8: Commit**

```bash
git add apps/web/lib/viva-session-projection.ts apps/web/lib/viva-session-projection.test.ts apps/web/components/session/LiveSessionPage.tsx apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/components/session/LiveSessionShell.tsx apps/web/components/session/LiveSessionShell.test.tsx apps/web/components/session/SessionBottomControls.tsx apps/web/components/session/SessionBottomControls.test.tsx apps/web/components/session/MarginaliaPanel.tsx
git commit -m "fix(web): render terminal recap and transcript state"
```

---

### Task 11: `WEBSESSION-CANVAS-01` — Cache VoiceTrace label planning and consume the shared effects budget

**Files:**

- Modify: `apps/web/components/session/VoiceTraceCanvas.tsx`
- Create: `apps/web/components/session/VoiceTraceCanvas.test.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.test.tsx`
- Read only: `apps/web/lib/viva-effects.ts`

**Upstream interfaces imported from early Plan 13A:**

```ts
export type VivaEffectsPolicyInput = {
  canvasRole: "landing_muse" | "session_muse" | "voice_trace";
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  hardwareConcurrency: number | null;
  prefersReducedMotion: boolean;
  prefersReducedTransparency: boolean;
  saveData: boolean;
  explicitPreference: "reduced" | null;
};

export type VivaEffectsPolicy = {
  mode: "full" | "reduced" | "static";
  dprCap: number;
  fps: number;
  glyphCountScale: number;
};

export function resolveVivaEffectsPolicy(input: VivaEffectsPolicyInput): VivaEffectsPolicy;

export function readVivaEffectsPreference(
  storage: Pick<Storage, "getItem">,
): "reduced" | null;

export const VIVA_EFFECTS_CHANGE_EVENT = "viva-effects-change" as const;
```

Locked outputs are full `{mode:"full",dprCap:2,fps:32,glyphCountScale:1}`, reduced `{mode:"reduced",dprCap:1.5,fps:24,glyphCountScale:0.5}`, and static `{mode:"static",dprCap:1.5,fps:0,glyphCountScale:0.5}`. This task passes `canvasRole:"voice_trace"`, consumes `mode`, `dprCap`, and `fps`, and may ignore `glyphCountScale`.

**Plan-10 cache interface:**

```ts
export type VoiceTraceLabelPlanCacheInput = Readonly<{
  conceptGeneration: number;
  canvasHeight: number;
  canvasWidth: number;
  fontScale: number;
  items: Parameters<typeof planVoiceTraceConceptLabels>[0]["items"];
}>;

export type VoiceTraceLabelPlanCache = Readonly<{
  plan(input: VoiceTraceLabelPlanCacheInput): ReturnType<typeof planVoiceTraceConceptLabels>;
  reset(): void;
}>;

export function createVoiceTraceLabelPlanCache(
  planner?: typeof planVoiceTraceConceptLabels,
): VoiceTraceLabelPlanCache;
```

**Step 1: Require the early Plan 13A effects-policy handoff**

- [ ] Stop unless `apps/web/lib/viva-effects.ts` exports the exact input/result/resolver/preference reader/event constant above and its tests prove full/reduced/static outcomes plus fail-closed preference parsing. Run:

```bash
bun test apps/web/lib/viva-effects.test.ts
```

**Step 2: Write label-cache RED tests**

- [ ] Inject a counting planner into `createVoiceTraceLabelPlanCache`. Call `plan` for 120 simulated animation frames with the same concept generation, dimensions, and font scale; assert one planner call and referentially identical planned output.
- [ ] Change width, height, font scale, and concept generation one at a time; assert exactly one additional planner call for each generation. `reset()` forces exactly one recomputation.
- [ ] Generate two frame times with different wobble offsets. Assert lane/row assignments and stable label anchors come from the same cached plan; only the final node/leader/label drawing offsets change.
- [ ] Expected RED: `planVoiceTraceConceptLabels` currently runs inside every `draw()` using already-wobbled points.

**Step 3: Write policy/budget RED tests**

- [ ] Mount with deterministic viewport/media/navigator inputs for full, reduced, and static policies. Assert the resolver receives `canvasRole:"voice_trace"` and every exact input field.
- [ ] Full mode sets `data-viva-effects="full"`, `data-render-mode="animated"`, `data-fps-budget="32"`, `data-dpr-cap="2"`; reduced sets `reduced`, `animated`, `24`, `1.5`; static sets `static`, `static`, `0`, `1.5`.
- [ ] Under full mode, drive 64 `requestAnimationFrame` timestamps over two seconds and assert drawing is capped at approximately 32 fps. Under reduced mode assert approximately 24 fps. Under static mode assert one synchronous readable frame after mount/resize/data change and no continuous rAF.
- [ ] Assert resize/media-policy/concept changes rebuild once; dispatch imported `VIVA_EFFECTS_CHANGE_EVENT` and assert one policy recomputation. Unmount removes `matchMedia`, visibility, ResizeObserver, and exactly one effects-change listener and cancels rAF/timeouts.

**Step 4: Move planning outside rAF and apply wobble after planning**

- [ ] Increment `conceptGeneration` only when the semantic concept-node set changes. Build stable points from `nodePos * canvas size`, call the cache outside the per-frame draw body, and retain the returned lane plan until generation/size/font-scale changes.
- [ ] In each draw, calculate the node's small wobble delta and add that same delta to its cached node/leader/label geometry. Do not feed wobble back into the planner.
- [ ] Preserve all concept labels, highlighting, status color, and leader-line behavior. Dense concepts remain visible; no lane flips occur from animation alone.

**Step 5: Resolve and expose the exact shared policy**

- [ ] After mount, gather viewport width/height, device pixel ratio, `navigator.hardwareConcurrency ?? null`, reduced-motion and reduced-transparency media matches, `navigator.connection?.saveData === true`, and `readVivaEffectsPreference(window.localStorage)`. Call `resolveVivaEffectsPolicy` with all fields and `canvasRole:"voice_trace"`. Register one listener using imported `VIVA_EFFECTS_CHANGE_EVENT`; on it, reread the preference and rebuild through the same policy path.
- [ ] Replace hard-coded DPR 2 and 32 fps with `policy.dprCap` and `policy.fps`; publish the exact data attributes above on `.voice-trace`. A policy change rebuilds without creating a second animation loop.
- [ ] Do not implement a second effects preference, local-storage key, or policy table in this file. Plan 13A remains the only effects-policy authority.

**Step 6: Run focused Plan 13A frontend tests**

```bash
bun test apps/web/components/session/VoiceTraceCanvas.test.tsx apps/web/components/session/LiveSessionShell.test.tsx apps/web/lib/viva-effects.test.ts
node --test scripts/frontend-quality.test.mjs
```

The `--policy-only` run of `scripts/frontend-performance.mjs` is a Plan 13B Task 10 deliverable that merges after this lane; Plan 10 must not run or wait for it — Plan 13B and Plan 15 run it on the combined tree.

**Step 7: Mutation controls**

- [ ] Temporarily call the planner inside `draw`; the 120-frame call-count test must fail. Restore it.
- [ ] Temporarily hard-code DPR 2 or 32 fps; reduced/static policy tests must fail. Restore it.
- [ ] Temporarily include wobble in cache input; the lane-stability test must fail. Restore it.

**Step 8: Commit**

```bash
git add apps/web/components/session/VoiceTraceCanvas.tsx apps/web/components/session/VoiceTraceCanvas.test.tsx apps/web/components/session/LiveSessionShell.test.tsx
git commit -m "perf(web): cache voice trace label planning"
```

- [ ] Do not hand this partial-lane commit to Plan 13B or claim its final combined accessibility/performance acceptance. Plan 13B consumes the final Plan 10 HEAD only after Task 14 completes.

---

### Task 12: `WEBSESSION-STATIC-01` — Apply the selected D-06 client-routing disposition

**Files:**

- Modify: `apps/web/lib/viva-agent-client.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Read: `docs/superpowers/plans/2026-08-23-package-build-contracts.md`

**Step 1: Execute only the recorded D-06 branch**

- [ ] **D-06 Branch B — no named static-export consumer:** add the exact RED test `D-06 STATIC_EXPORT deleted leaves no browser static routing`, showing `VIVA_STATIC_EXPORT=1` currently changes browser URL routing. Remove `vivaStaticExportEnabled`, bundled static-export variables, and static-only routing branches from `viva-agent-client.ts`. All browser projection/readiness calls use the same-origin Next routes and all server-side direct-agent calls use their explicit server base. Assert static env flags no longer change behavior.
- [ ] **D-06 Branch A — named static-export consumer:** stop unless the coordinator's recorded D-06 decision names both the actual static deployment consumer and its separate server BFF. Add the exact RED test `D-06 STATIC_EXPORT retained routes static and Next clients distinctly`. Retain the helper and prove direct-agent routing for the named static consumer plus same-origin routing for the BFF-served mode: static projection/readiness resolves against the configured public agent/API base and never a nonexistent Next API path; Next mode uses same-origin `/api/viva-session/projection`. Downstream Plan 14B owns deterministic Turbo outputs, environment hashing, cache restoration, real static build/artifact/browser proof; Plan 15 owns its combined evidence with Plans 10/11/13.
- [ ] Under either branch, never put the signed session credential in query parameters or static output.

**Step 2: Run the Plan 10 owner-local gate against the recorded D-06 contract**

```bash
bun test apps/web/lib/viva-agent-client.test.ts
bun --filter @viva/web typecheck
```

- [ ] For recorded D-06 Branch A, assert the focused test matrix covers both direct configured and same-origin routes, then run:

```bash
bun test --test-name-pattern='D-06 STATIC_EXPORT.*retained' apps/web/lib/viva-agent-client.test.ts
```

- [ ] For recorded D-06 Branch B, run the owner-local deletion guard only:

```bash
if rg -n 'VIVA_STATIC_EXPORT|NEXT_PUBLIC_VIVA_STATIC_EXPORT|vivaStaticExportEnabled|staticExport' apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts; then exit 1; fi
bun test --test-name-pattern='D-06 STATIC_EXPORT.*deleted' apps/web/lib/viva-agent-client.test.ts
```

- [ ] Record the consumed coordinator D-06 decision, including the named consumer/BFF when retained, beside these results. Record Plan 14A separately as the package-export prerequisite for the full lane. Do not run or wait for Plan 14B's package/build/static-artifact commands here. Hand `build:static`/`e2e:static`/cache evidence for Branch A, or repository-wide deletion/build evidence for Branch B, to Plan 15 after Plan 14B lands.

**Step 3: Commit**

```bash
git add apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts
git commit -m "fix(web): align session routing with build contract"
```

---

### Task 13: `WEBSESSION-PASTE-01` / `WEBSESSION-AUTHORITY-01` — Remove ignored paste authority and close the browser frame/type boundary

**Files:**

- Modify: `apps/web/lib/viva-agent-client.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Read and run only: `packages/core/src/agent-contract.ts`
- Read and run only: `packages/core/src/agent-contract.test.ts`
- Read only: `apps/web/app/api/viva-library/[[...path]]/route.ts`

**Interfaces:**

After Plan 05 lands, import its browser-only v5 union and parser rather than defining a local tool-capable frame type:

```ts
import {
  parseVivaClientFrameJson,
  VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
  type VivaBrowserClientFrame,
  type VivaVoiceDiagnosticCode,
} from "@viva/core";

export type VivaPasteStudySetInput = {
  title: string;
  course?: string;
  examDate?: string;
  pastedText: string;
};

type VivaPasteStudySetRequestBody = Readonly<{
  title: string;
  course?: string;
  exam_date?: string;
  pasted_text: string;
}>;

export type VivaBrowserFrameSerializationResult =
  | Readonly<{ status: "serialized"; payload: string }>
  | Readonly<{
      status: "rejected";
      diagnostic: Readonly<{ code: VivaVoiceDiagnosticCode; path: string }>;
    }>;

export function serializeVivaBrowserClientFrame(
  frame: VivaBrowserClientFrame,
): VivaBrowserFrameSerializationResult;
```

The controller's private sender is `sendFrame(frame: VivaBrowserClientFrame)`. `VivaClientFrame` remains only Plan 05's migration alias; new browser code uses the authority-specific type. There is no generic record overload and no `sendToolResult` controller member.

**Step 1: Write the ignored-paste-authority RED tests**

- [ ] Call `pasteStudySetToVivaApi` once without optional `course`/`examDate` and once with both. Parse the captured JSON and assert sorted keys are exactly `pasted_text,title` and `course,exam_date,pasted_text,title`, respectively; assert the values are preserved exactly.
- [ ] Pass a runtime object containing forged `userId`, `user_id`, `sessionId`, and `session_id` through an explicit hostile cast. Assert none is serialized. Add `@ts-expect-error` compile assertions proving `userId` and `sessionId` are not members of `VivaPasteStudySetInput`.
- [ ] Expected RED: the current exported input requires `userId`, permits `sessionId`, and serializes `user_id` plus optional `session_id`, although Rust `PasteStudySetRequest` ignores both.

**Step 2: GREEN the paste request as an exact reconstruction**

- [ ] Remove `userId` and `sessionId` from `VivaPasteStudySetInput`. Construct a fresh `VivaPasteStudySetRequestBody` from only `title`, optional `course`, optional `exam_date`, and `pasted_text`; never spread the input object.
- [ ] Preserve the endpoint, bearer, origin, and proxy behavior frozen by Plans 08/11. File upload and file-retry request keys are an explicit Plans 08/11 handoff: do not add, change, or invent a browser file/retry body builder in this task.

**Step 3: Write browser tool/size authority RED tests**

- [ ] Add a compile assertion that `{type:"tool_result"}` is not assignable to `VivaBrowserClientFrame`, and that `"sendToolResult"` is not a key of `VivaAgentSessionController`.
- [ ] Pass a runtime-forged `tool_result` record through `serializeVivaBrowserClientFrame`. Assert `{status:"rejected",diagnostic:{code:"VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",path:"$.type"}}`, zero `socket.send` calls, no raw proposal/result in state/log/DOM, and no public controller route that can transmit it.
- [ ] Build a valid `answer_text` turn intent whose serialized UTF-8 envelope is one byte over `VIVA_VOICE_MAX_TEXT_FRAME_BYTES`. Assert `{status:"rejected",diagnostic:{code:"VOICE_PROTOCOL_FRAME_TOO_LARGE",path:"$"}}`, zero `socket.send` calls, no pending submission, and the learner's typed text remains available. Test the exact-boundary fixture from Plan 05 still sends.
- [ ] Expected RED after Plan 05: the shared parser/type rejects these inputs, but the current private browser sender serializes and sends without consuming that validated boundary or client-side size constant.

**Step 4: GREEN the private sender without reopening Plan 03 audio transport**

- [ ] `serializeVivaBrowserClientFrame` JSON-serializes once, counts `new TextEncoder().encode(payload).byteLength`, rejects anything above `VIVA_VOICE_MAX_TEXT_FRAME_BYTES`, and then calls `parseVivaClientFrameJson(payload)` before returning the payload. Catch only `VivaVoiceProtocolError` and retain only `{code,path}`; unexpected local failures become the fixed internal browser diagnostic from Task 4.
- [ ] Type the controller's private `sendFrame` parameter as imported `VivaBrowserClientFrame`; it sends only a `serialized` payload. Map `rejected` into Task 6's discriminated result and safe UI copy. Delete casts/generic records that could restore a tool-capable browser path.
- [ ] Rebase this change over Plan 03's sender. Preserve its audio chunk/end validation, queue, retained ledger, backpressure, ACK, and result union byte-for-byte; do not introduce a second audio size check or queue.
- [ ] Do not edit `packages/core/src/agent-contract.ts` or its tests. Plan 05 owns the shared size constants, browser-frame union/parser, diagnostic taxonomy, removal of dead `AgentToolProposal`/`AgentToolResult` browser exports, and cross-language fixtures.

**Step 5: Run RED/GREEN and regression tests**

```bash
bun test apps/web/lib/viva-agent-client.test.ts
bun test packages/core/src/agent-contract.test.ts
bun --filter @viva/web typecheck
git diff --check
```

- [ ] Mutation control: temporarily bypass `parseVivaClientFrameJson`; forged `tool_result` must reach the fake socket and fail the test. Restore it.
- [ ] Mutation control: change `>` to `>=`; the exact-boundary frame test must fail. Restore it.
- [ ] Ownership guard: `git diff --name-only -- packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts` is empty.

**Step 6: Commit**

```bash
git add apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts
git commit -m "fix(web): remove browser ingestion authority"
```

---

### Task 14: `WEBSESSION-MOUNT-01` — Close the mounted session behavior matrix and run the combined gate

**Files:**

- Modify: `apps/web/components/session/LiveSessionPage.mounted.test.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.test.tsx`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/lib/viva-audio-capture.test.ts`
- Modify: `apps/web/lib/viva-audio-playback.test.ts`
- Modify only if the product frame requires a stable selector: `apps/web/components/session/LiveSessionShell.tsx`

**Step 1: Add the complete mounted behavior matrix**

- [ ] **Bootstrap:** StrictMode hydrate; no render-phase URL work; token stripped once; refresh/projection/connect ordered once; stale attempts cannot win.
- [ ] **Projection:** unique non-Biology study/course/concepts/mode/goal/question/progress/schedule render; invalid/mismatched projection never connects.
- [ ] **Typed input:** answer text and citation challenge produce exact v5 typed intents; D-08 selected gate is behaviorally enforced; no magic challenge string.
- [ ] **Deferred turn:** every canonical reason renders neutral/ungraded copy, socket stays open, and retry-current appears only from `can_retry_same_question:true`.
- [ ] **Audio:** irregular capture frames stream through Plan 03; `sent`, `pending`, and `socket_closed` UI paths preserve the ledger; `audio_turn_accepted` releases it; cap/cancel releases it deliberately.
- [ ] **Recovery:** unclean close waits beyond lease grace; renews through the recorded D-07 path; opens one generation; calls `retryPendingAudio` once; stops after three; manual recovery works; no retry after recap/terminal/unmount.
- [ ] **Cancellation:** cancellation stops the matching playback response, shows interrupt acknowledgment, and `acknowledgeAudio` removes only the exact consumed frame objects.
- [ ] **Recap:** complete and partial recap stop capture, cancel scheduled playback, disable input, keep the server recap/schedule, and show success/partial copy rather than disconnected retry copy.
- [ ] **Browser lifecycle:** `pageshow`/`popstate` use the latest access credential and projection identity; changed identity aborts old work and starts one new bootstrap; same identity never duplicates a socket.
- [ ] **Accessibility:** transcript button relationship/state, terminal status announcement, control labels, keyboard activation, and focus preservation are asserted on the mounted page.
- [ ] **Canvas budget:** 120 stable animation frames perform one VoiceTrace label plan; resize/concept/font changes invalidate once; full/reduced/static policy attributes and frame budgets match Plan 13A; unmount removes the effects-change listener.

**Step 2: Add cleanup assertions to every mounted test**

- [ ] After unmount, assert zero WebSocket listeners, zero live retry/readiness/refresh timers, all AbortControllers aborted, capture tracks stopped, AudioContexts closed, playback nodes stopped/disconnected, and no late React update warning.
- [ ] Assert StrictMode's throwaway mount does not consume a one-use credential, start media, or leave any resource behind.

**Step 3: Run mutation-style reversions locally**

- [ ] Temporarily invert each of these conditions one at a time and prove the named test fails, then restore the implementation: retry stop after recap; typed challenge kind; retained ledger release only on ACK; projection identity match; URL effect timing; playback `endTime` recomputation; transcript `aria-expanded`.
- [ ] Record the failing test name in the execution log. Do not commit the mutations.

**Step 4: Run the focused lane gate**

```bash
bun test apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/lib/viva-session-projection.test.ts apps/web/lib/viva-audio-capture.test.ts apps/web/lib/viva-audio-playback.test.ts apps/web/components/session/LiveSessionPage.test.tsx apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/components/session/LiveSessionShell.test.tsx apps/web/components/session/SessionBottomControls.test.tsx apps/web/components/session/VoiceTraceCanvas.test.tsx
bun --filter @viva/web typecheck
bun --filter @viva/web lint
bun --filter @viva/web build
git diff --check
```

**Step 5: Run upstream regression gates**

- [ ] Re-run Plan 03's full browser/Rust long-turn audio command and Plan 05's TS/Rust fixture/differential command. The mounted test does not replace cross-language protocol proof.
- [ ] Re-run Plan 11's authenticated projection proxy tests with unauthorized, token-stripping, invalid-body, timeout, and identity-mismatch cases.
- [ ] Re-run Plan 13A's published `viva-effects` focused tests, confirm the exact Plan 14A package-export commit, and confirm Task 12 consumed the coordinator's exact D-06 decision record. Do not run, wait for, substitute, or preclaim downstream Plan 13B/14B acceptance.

**Step 6: Run the owner-local repository gate on the Plan 10 integration tree**

```bash
bun run validate:ts
```

- [ ] If another lane has merged agent changes required by Plans 03/05/08/09, run its exact Rust focused commands and then `bun run validate`. Local web green is not final integrated protocol/projection/release acceptance.
- [ ] Do not run or claim the combined `bun run e2e:browser` evidence here. Plan 15 adds/runs the real browser long-spoken-turn and typed citation-challenge scenario across final Plans 10/11/13/14; this lane supplies stable accessible names/selectors through owned components.

**Step 7: Audit the final diff**

```bash
git diff --name-only "$(git merge-base HEAD origin/main)"..HEAD
git diff --check
rg -n 'seedStudySets|biology-midterm|\(challenge citation\)|core FSRS|String\(error\)|error\.message|unauthori\[sz\]ed' apps/web/components/session apps/web/lib/viva-agent-client.ts apps/web/lib/viva-session-projection.ts
git diff --name-only "$(git merge-base HEAD origin/main)"..HEAD -- packages/core/src/agent-contract.ts agent/crates/agent-service/src/protocol.rs agent/fixtures packages/core/fixtures apps/web/app/globals.css packages/tokens
```

- [ ] The first scan has no prohibited production fallback/magic-string/raw-error matches; legitimate test sentinels must be reviewed individually.
- [ ] The forbidden-path diff is empty.

**Step 8: Commit final test closure**

```bash
git add apps/web/components/session/LiveSessionPage.mounted.test.tsx apps/web/components/session/LiveSessionPage.test.tsx apps/web/lib/viva-agent-client.test.ts apps/web/lib/viva-audio-capture.test.ts apps/web/lib/viva-audio-playback.test.ts apps/web/components/session/LiveSessionShell.tsx
git commit -m "test(web): prove mounted live session recovery"
```

- [ ] Record the resulting final Plan 10 commit ID and hand that exact HEAD to downstream Plans 13B, 14B, and 15. Plan 10 remains mergeable without waiting for any of those downstream gates.

## Exit Criteria

- [ ] Every `WEBSESSION-*` ID in the coverage table has a RED test that was observed failing for the intended reason and a GREEN behavior test on the final tree.
- [ ] The page never opens a socket without a validated, identity-matched `AuthenticatedStudyProjectionV1` and current bounded-refresh credential.
- [ ] Plan 03's audio frames, bounds, result union, retained ledger, and ACK semantics remain unchanged; Plan 10 adds only cross-generation orchestration and learner-visible recovery.
- [ ] Malformed or hostile input cannot leak raw payloads or influence auth classification through text matching.
- [ ] Complete/partial recap, deferred turns, structured errors, typed termination, recovery, and disconnected states have total, mutually exclusive UI precedence.
- [ ] D-02, D-03, D-06, D-07, and D-08 behavior matches the recorded branch and has branch-specific tests; an unnamed D-07B replacement remains explicitly blocked.
- [ ] Mounted StrictMode tests prove connection, lifecycle restoration, capture, playback, challenge, recovery, recap, landmark/skip behavior, transcript accessibility, and VoiceTrace budgeting with zero leaked resources.
- [ ] Focused web checks, required upstream Plan 03/05/11/13A regressions, the consumed Plan 14A decision contract, and the owner-local repository gate pass. Hand final Plan 10 HEAD to Plans 13B/14B/15; Plan 15 owns combined 10/11/13/14 evidence. Plan 10 does not wait for or preclaim those downstream, hosted, or release results.
