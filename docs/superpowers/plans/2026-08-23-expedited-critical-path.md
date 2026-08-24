# Expedited Critical Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before closeout. Execute this plan in one dedicated worktree, keep every task checkbox current, and preserve RED and GREEN command output in the PR.

**Goal:** Remove the two verified release-blocking failures before any broad remediation work: stream a bounded microphone turn through the production browser/WebSocket path without crossing the 64 KiB text-frame limit, and replace the fixed June 2026 review dates with the exact scheduling authority selected at Decision D-01.

**Architecture:** Publish one strict protocol-v5 audio lifecycle across the shared TypeScript contract, browser controller/capture/UI, and Rust WebSocket assembler; retain a bounded browser ledger until server turn acceptance and admit one assembled provider input only at explicit end. For scheduling, inject time at the authorized outcome boundary and execute exactly one D-01 authority, with Rust and TypeScript checked against the same independently derived literal conformance fixture.

**Tech Stack:** TypeScript 5, React/Next.js, Bun tests, browser AudioWorklet/WebSocket APIs, Playwright/Chromium, Rust/Axum/Tokio, Serde, Chrono, SQLx/PostgreSQL, `ts-fsrs`, and the D-01-selected pinned Rust FSRS implementation when Branch A is selected.

**Spec:** The acceptance contract is `CRIT-AUDIO-01` and `CRIT-SCHED-01` as verified in `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md` and `docs/superpowers/reviews/index.md`, refined by the cited web UI/session, Rust domain, correctness, project-state, shared-package, and architecture-consistency reviews. Protocol-v5 constants and D-01 branch wording in this plan are locked inputs, not implementation suggestions.

**First-merge rule:** This is the expedited lane and must be the first remediation merge. Plans 04, 05, 06, 07, 08, 09, 10, 11, 12, and 13 may inspect these files but must not merge overlapping changes until this plan lands; each then rebases its remediation lane at the recorded critical merge SHA from `review-remediation/integration` and reruns the handoff commands in the final task before continuing. If D-01 remains unrecorded while the audio critical is fully green, the integration coordinator may split this lane's first merge into two consecutive integration PRs from this same worktree — PR `03-audio`, then PR `03-scheduling` — as specified in Task 0; audio seams transfer at the PR `03-audio` merge SHA, and every scheduling hotspot remains frozen for all lanes until PR `03-scheduling` merges.

**Verified criticals in scope:**

| ID | Existing failure | Required closure |
| --- | --- | --- |
| `CRIT-AUDIO-01` | `LiveSessionPage` concatenates a whole microphone turn into one base64 JSON frame while the Rust WebSocket retains a 64 KiB text-frame cap. At mono PCM16 24 kHz, representative audio crosses the cap at roughly 1.022 seconds. | Protocol v5 bounded `audio_chunk`/`audio_end`; strict sequence and identity validation; a 45-second raw-sample cap; one provider turn only after explicit end; bounded browser backpressure and retention; cancellation; phase-continuous 44.1/48 kHz resampling; 2/10/45-second real-WebSocket proof plus an oversized single-chunk negative control. |
| `CRIT-SCHED-01` | `agent-domain/src/tool_executor.rs` and the synthetic executor write literal June 2026 timestamps, so a live successful tool result can persist an already-expired review. | Decide D-01, inject time, execute the selected authoritative relative-scheduling branch, and prove Rust/TypeScript conformance from one literal fixture that was derived independently from the selected policy. Do not broaden into grading or recap repair. |

**Evidence read before planning:**

- `docs/superpowers/reviews/2026-08-23-web-ui.md`
- `docs/superpowers/reviews/2026-08-23-web-session-client.md`
- `docs/superpowers/reviews/2026-08-23-rust-agent-domain.md`
- `docs/superpowers/reviews/2026-08-23-correctness-review.md`
- `docs/superpowers/reviews/2026-08-23-project-state.md`
- `docs/superpowers/reviews/2026-08-23-packages-shared.md`
- `docs/superpowers/reviews/2026-08-23-architecture-consistency.md`
- `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`
- `docs/superpowers/reviews/index.md`
- Live contracts and behavior in `packages/core/src/agent-contract.ts:1-5,30-32,163-181,247-257,386-432`, `agent/crates/agent-service/src/protocol.rs:9-46,393-520`, `agent/crates/agent-service/src/ws.rs:571-720,2902-2988,3233-3420,4681-4890`, `agent/crates/agent-domain/src/brain.rs:131-149`, `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs:86-143,209-250,487-503,939-980`, `agent/crates/agent-adapters/src/synthetic.rs:152-205,630-710,808-815`, `apps/web/lib/viva-audio-capture.ts:1-133,237-386`, `apps/web/lib/viva-agent-client.ts:189-205,806-832,917-918`, `apps/web/lib/use-viva-agent-session.ts:112-130`, `apps/web/components/session/LiveSessionPage.tsx:128,363-515,1021-1061,1113-1123`, `packages/core/src/scheduling.ts:1-145`, and `agent/crates/agent-domain/src/tool_executor.rs:32-41,229-252,339-346`.

## Global Constraints

- Do not raise `VIVA_VOICE_MAX_TEXT_FRAME_BYTES`; it remains exactly `64 * 1024` in TypeScript and Rust.
- Do not replace bounded JSON chunks with one larger binary frame. Protocol v5 uses the JSON contracts below.
- Do not accept odd-byte PCM, empty chunks, chunks above 8,192 raw bytes, turns above 2,160,000 raw bytes, sequence gaps/duplicates/reordering, or mixed generation/turn identities.
- Do not start a provider turn on `audio_chunk`. Admit exactly one assembled `BrainInput` only after valid `audio_end`.
- Do not silently drop a chunk because `WebSocket.bufferedAmount` is high or the socket closes. Retain the bounded turn ledger and return the discriminated result defined below.
- Do not implement automatic reconnect, cross-generation replay, anti-alias filtering, or broader WebSession UX here. Plan 10 owns those after rebase; this plan supplies and tests its transport seam.
- Do not change the provider runner to create one provider turn per chunk. The assembled frame is the existing single-turn runner input.
- Do not substitute a fixed 1/2/3/8-day table for FSRS. A relative-looking lookup table is still the same bug.
- Do not implement grading semantics, recap correctness, or the remaining scheduling contract. Plan 04 owns those after this critical removes fixed dates.
- Do not select an exam cap or safety margin implicitly. That value is a D-01 sub-decision and is recorded before scheduling production code changes.
- Do not keep both D-01 branches active. The implementation PR selects exactly one branch, deletes/reverts the other branch's RED-only edits, and records why.

---

## Locked architecture and interfaces

### Audio protocol v5

Publish protocol version `5` in the shared TypeScript contract, Rust protocol, and every canonical voice fixture. Retain `VIVA_VOICE_MAX_TEXT_FRAME_BYTES = 64 * 1024`.

```ts
export const VIVA_VOICE_PROTOCOL_VERSION = 5 as const;
export const VIVA_AUDIO_SAMPLE_RATE_HZ = VIVA_VOICE_SAMPLE_RATE_HZ; // alias of the existing 24 kHz voice constant; one literal source
export const VIVA_AUDIO_MAX_CHUNK_SAMPLES = 4_096 as const;
export const VIVA_AUDIO_MAX_CHUNK_BYTES = 8_192 as const;
export const VIVA_AUDIO_MAX_TURN_SAMPLES = 1_080_000 as const;
export const VIVA_AUDIO_MAX_TURN_BYTES = 2_160_000 as const;

export type AgentAudioChunkFrame = {
  type: "audio_chunk";
  version: 5;
  client_generation_id: string;
  turn_id: string;
  sequence: number;
  frame: { pcm16_base64: string };
};

export type AgentAudioEndFrame = {
  type: "audio_end";
  version: 5;
  client_generation_id: string;
  turn_id: string;
  final_sequence: number;
};

export type AgentAudioTurnAcceptedFrame = {
  type: "audio_turn_accepted";
  version: 5;
  client_generation_id: string;
  turn_id: string;
  final_sequence: number;
};
```

PCM is mono `pcm_s16le` at 24,000 Hz. Sequence numbers start at `0`, are contiguous, and cannot be reused. `audio_end.final_sequence` equals the last accepted chunk sequence. The UI does not send an empty audio turn. A valid 45-second turn contains at most 1,080,000 samples/2,160,000 raw bytes even when every JSON frame remains individually below 64 KiB. Do not infer a 264-chunk cap from the 8,192-byte maximum: production 20 ms chunks are 960 bytes, so a valid 45-second turn has 2,250 chunks and `final_sequence = 2_249`; total decoded bytes, not a maximum-payload division, enforce the turn cap. `audio_turn_accepted` is emitted only after the server has validated the complete turn and admitted its single assembled `BrainInput`; it is not a provider-success acknowledgment.

The existing `cancel` client frame gains optional `client_generation_id` and `turn_id`. With both present it discards a matching in-progress audio assembly without creating a provider turn. Without them it preserves current provider-response cancellation behavior. A mismatched cancellation is a protocol error, not permission to cancel another turn.

### Browser send and retention seam

Replace boolean audio submission with this exact controller surface:

```ts
export type VivaClientSendError = Readonly<{
  code: "socket_closed" | "audio_turn_limit" | "audio_queue_limit";
  message: string;
}>;

export type VivaAudioSendResult =
  | Readonly<{
      status: "sent";
      acceptedThroughSequence: number;
    }>
  | Readonly<{
      status: "pending";
      acceptedThroughSequence: number | null;
      retainedFromSequence: number;
    }>
  | Readonly<{
      status: "socket_closed";
      acceptedThroughSequence: number | null;
      retainedFromSequence: number;
      retryable: true;
      error: VivaClientSendError;
    }>;

export type VivaAudioChunkInput = Readonly<{
  turnId: string;
  sequence: number;
  pcm16Bytes: Uint8Array;
}>;

sendAudioChunk(input: VivaAudioChunkInput): VivaAudioSendResult;
endAudioTurn(input: Readonly<{ turnId: string; finalSequence: number }>): VivaAudioSendResult;
cancelAudioTurn(turnId: string): void;
retryPendingAudio(): VivaAudioSendResult;
```

`acceptedThroughSequence` means synchronously serialized into the current browser WebSocket, not acknowledged by the server. The controller retains the entire raw turn, including already serialized chunks, until matching `audio_turn_accepted`; that closes the browser API's missing-ack window while staying bounded by 2,160,000 bytes. `pending` means at least one chunk is retained locally because `socket.bufferedAmount` is at or above `VIVA_AUDIO_SEND_BUFFER_HIGH_WATER_BYTES = VIVA_VOICE_MAX_TEXT_FRAME_BYTES`. `socket_closed` retains the ledger and exposes a retryable result; Plan 03 does not automatically open a new generation or replay it. The queue pump sends in order and never passes `audio_end` ahead of retained chunks.

The controller allows one active audio input turn. Adding a different `turnId` before acceptance or cancellation returns `audio_turn_limit`. Raw bytes, base64 payloads, and transcript contents never enter error messages or telemetry.

### Server assembly boundary

Add a connection-local state machine in `ws.rs`:

```rust
struct IncomingAudioTurn {
    client_generation_id: String,
    turn_id: String,
    next_sequence: u32,
    pcm16: Vec<u8>,
}

enum AudioAssemblyAction {
    Pending,
    Complete {
        client_generation_id: String,
        turn_id: String,
        final_sequence: u32,
        frame: AudioFrame,
    },
    Cancelled,
}
```

The first chunk must be sequence `0`; every next chunk must equal `next_sequence`. Decode base64 before mutation, require a non-empty even byte count no greater than 8,192, and use checked addition before extending `pcm16`. Rejecting a frame clears the invalid assembly and closes through the existing sanitized protocol-error path. On valid end, move the completed bytes once into `BrainInput::AudioWithMetadata`, arm the existing provider-turn admission/45-second post-submit cap once, then send `audio_turn_accepted`. If the bounded brain channel is not ready, await/send through the existing backpressure path; do not drop the completed turn or read an unbounded number of subsequent turns.

The Cartesia/Gemini and synthetic runners continue to receive one `AudioFrame` per completed browser turn. Runner tests prove one transcript/provider invocation for thousands of chunks; runner production code changes are unnecessary unless a failing test demonstrates otherwise.

### Stateful browser resampler

Replace callback-local resampling with one instance per capture lifecycle:

```ts
export type StreamingFloat32Resampler = {
  push(input: Float32Array): Float32Array;
  reset(): void;
};

export function createStreamingFloat32Resampler(
  sourceRate: number,
  targetRate: number,
): StreamingFloat32Resampler;
```

Track total source samples and the next target index as integers. For target sample index `j`, derive the source position from the rational numerator `j * sourceRate`, use `Math.floor(numerator / targetRate)` and its exact remainder for interpolation, and retain the boundary source sample required by the next callback. After `N` source samples, emitted target count is `floor(N * targetRate / sourceRate)`; cumulative duration error stays below one 24 kHz sample. `reset()` is called only for a new capture generation or disposal. This plan proves phase continuity and duration at 44.1/48 kHz; Plan 10 may add a higher-quality anti-alias filter without changing counts or the public interface.

### D-01 scheduling authority

No scheduling implementation begins until the product/architecture owner records exactly one of these enum values and an exam-margin sub-decision in `docs/decisions/2026-08-23-d-01-review-scheduling-authority.md`:

```text
SERVER_PERSISTED_FSRS
EVENTS_PLUS_READ_TIME_PROJECTION
```

The decision record includes: selected enum, FSRS parameter/policy version, status-to-rating mapping, timezone/UTC rule, selected exam margin, treatment of an exam timestamp already in the past, schema/version ownership, rollback behavior, and the reference oracle — name, release version, and artifact-digest source — used for the independent conformance fixture; when Branch A is selected it also records the exact Rust FSRS crate name and pinned version. The selected exam rule must ensure that once a margin is chosen no future-exam review is displayed after the exam. A missing field is a hard stop, not a default.

**Branch A — `SERVER_PERSISTED_FSRS`:** inject `Clock`; persist `PersistedFsrsCardV1` and `ReviewScheduleDecisionV1`; compute authoritative `due_at` at outcome persistence; prove parity against literal shared fixtures derived independently from the selected FSRS policy. A fixed interval lookup, including 1/2/3/8 days, is forbidden.

**Branch B — `EVENTS_PLUS_READ_TIME_PROJECTION`:** persist `ReviewHistoryEventV1` with `graded_at`, status/rating, hints/misses, and exam metadata, with no placeholder due date; compute `ReadTimeReviewProjectionV1` exclusively in `packages/core` while building the authenticated read model. Writing a synthetic `due_at` merely to satisfy the current `review_items.due_at NOT NULL` column is forbidden.

Plan 03 implements only the selected branch's minimum end-to-end path required to eliminate fixed dates. After the Critical merge, Plan 04 owns scheduling behavior/contracts, grading semantics, and recap/read-model expansion; Plan 09 is the sole post-Critical migration-number allocator and migration owner.

---

## Worktree, ownership, and commit discipline

**Dedicated lane:** Use the coordinator-created worktree on branch `review-remediation/03-critical-path` from `LANE_BASE_SHA`. Record `BASE_SHA=$(git rev-parse HEAD)` in the PR before the first edit. Do not create a second lane or mix the untracked review/planning files from the source worktree into this branch.

**Temporary ownership:** Until this lane merges, it owns only the critical slices in:

- `packages/core/src/agent-contract.ts` and `packages/core/src/agent-contract.test.ts`
- `agent/crates/agent-service/src/protocol.rs` and `agent/crates/agent-service/src/ws.rs`
- `agent/crates/agent-service/tests/voice_ws.rs`
- `agent/fixtures/voice-protocol/*.json` only where protocol version or audio frames change
- `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs` tests only where needed to prove one completed turn; `agent/crates/agent-adapters/src/synthetic.rs` for the fixed-date Critical plus `#[cfg(test)]`-only additions proving one completed turn — production `synthetic.rs` audio code is not edited by this lane, and if the runner-cardinality test fails against production synthetic audio code, escalate to the coordinator for a Plan 07 pre-handoff
- `apps/web/lib/viva-audio-capture.ts` and `.test.ts`
- `apps/web/lib/viva-agent-client.ts` and `.test.ts`
- `apps/web/lib/use-viva-agent-session.ts` and `.test.ts`
- `apps/web/components/session/LiveSessionPage.tsx` and `.test.tsx`
- `scripts/e2e-browser-audio.mjs` and the two root `package.json` entries that invoke it (`e2e:browser:audio`, `e2e:browser:audio:negative`)
- `agent/crates/agent-domain/src/tool_executor.rs`, its focused tests, and `packages/core/src/scheduling.ts`/`.test.ts`
- The selected D-01 branch's explicitly enumerated conditional files in Task 8A or 8B; touching them expands temporary ownership only for this critical and ends at merge.

**Handoff:** The complete file-by-file transfer is locked in Task 10. Plans 04/05/06/07/08/09/10/11/12/13 each receive the exact behavior, contract, domain-export, adapter, service, persistence/migration, session UI, BFF, root-script/lock, or library/UI seam listed there only after rebasing at `CRITICAL_PATH_MERGE_SHA`. No downstream plan may rename the locked frames or browser seam while this lane is open.

**Commits:** Each behavior slice is committed only after its GREEN task. RED specification Tasks 1/2, 4, and 7 remain uncommitted and are included in the immediately following GREEN commit. Do not commit a knowingly red tree. Preserve failing command/output in the PR evidence immediately before implementing GREEN.

---

### Task 0: Freeze the base and verify Connor's recorded Decision D-01

**Files:**

- Read only: `docs/decisions/2026-08-23-d-01-review-scheduling-authority.md`
- Read only: `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md`
- No production files yet.

- [ ] **Step 1: Verify the coordinator-created isolated lane and record the base**

```bash
test "$(git branch --show-current)" = "review-remediation/03-critical-path"
git status --short
BASE_SHA="$(git rev-parse HEAD)"
: "${LANE_BASE_SHA:?set the coordinator-recorded planning-only lane base}"
if test "${BASE_SHA}" != "${LANE_BASE_SHA}"; then
  git merge-base --is-ancestor "${LANE_BASE_SHA}" "${BASE_SHA}"
  test -z "$(git diff --name-only "${LANE_BASE_SHA}" "${BASE_SHA}" | awk '!/^(\.gitignore|docs\/decisions\/|docs\/superpowers\/)/')"
fi
```

Obtain `LANE_BASE_SHA` from the coordinator's ledger entry for lane creation, or derive it inside this worktree as the coordinator decision-registry commit: `LANE_BASE_SHA="$(git log --format=%H --fixed-strings --grep='docs: initialize remediation decisions and coverage' -n 1)"`. Both sources must agree.

Expected: a clean dedicated worktree created by Program Task 3 at the coordinator-recorded planning-only lane base, or at a later coordinator planning-only commit on `review-remediation/integration`. Record `BASE_SHA` in the PR description.

- [ ] **Step 2: Verify the hard D-01 decision was recorded by the coordinator**

Read the coordinator-owned decision document and matching ledger row. Require exactly one selected enum, every required sub-decision listed above, and a rejected-branch section so reviewers can verify that the alternative was considered, not partly implemented. If the file or any value is absent, return to the coordinator/Connor; do not invent or edit it from this lane.

- [ ] **Step 3: Acquire a late-recorded D-01 decision document without violating the first-merge rule**

If `docs/decisions/2026-08-23-d-01-review-scheduling-authority.md` is absent from this worktree but the coordinator reports D-01 as recorded, run:

```bash
git fetch origin review-remediation/integration
test -z "$(git diff --name-only HEAD origin/review-remediation/integration | awk '!/^(\.gitignore|docs\/decisions\/|docs\/superpowers\/)/')"
git rebase origin/review-remediation/integration
BASE_SHA="$(git rev-parse HEAD)"
```

The decision-registry commit is coordinator-owned planning-only content, so this rebase does not violate the first-merge rule; the path check proves nothing but planning content moved. Re-record `BASE_SHA` in the PR and re-run Steps 2 and 4 against the now-present file. If D-01 is still unrecorded, skip this step and continue under the D-01-absent rule in Step 4.

- [ ] **Step 4: Verify the checkpoint mechanically**

```bash
test "$(rg -c '^Selected authority: `(SERVER_PERSISTED_FSRS|EVENTS_PLUS_READ_TIME_PROJECTION)`$' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md)" -eq 1
for label in 'FSRS policy version:' 'Status-to-rating mapping:' 'UTC rule:' 'Exam margin:' 'Past-exam rule:' 'Schema owner:' 'Rollback:' 'Reference oracle:'; do
  rg -q "^${label}" docs/decisions/2026-08-23-d-01-review-scheduling-authority.md || { echo "missing: ${label}"; exit 1; }
done
if rg -q '^Selected authority: `SERVER_PERSISTED_FSRS`$' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md; then
  rg -q '^Rust FSRS crate:' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md || { echo 'missing: Rust FSRS crate:'; exit 1; }
fi
```

Expected: one selected-authority line and all eight concrete decision lines, plus the `Rust FSRS crate:` line when Branch A is selected; the per-label loop fails closed on any missing line. If any line is absent, stop. Do not start Task 7, Task 8A, or Task 8B.

An absent or incomplete D-01 record blocks only Tasks 7, 8A, and 8B, Task 9 Step 2, the scheduling portions of Task 9 Steps 3-6, and the scheduling file handoffs in Task 10 Step 4. Tasks 1-6 and the audio portions of Tasks 9-10 proceed immediately. If the audio matrix (Task 9 Step 1, the audio scans in Step 3, and Steps 4-5) is green while D-01 remains unrecorded, escalate to the integration coordinator, who may split this lane's first merge into two consecutive integration PRs from this same worktree using the program's two-PR single-lane pattern (Program Section 4, final paragraph): PR `03-audio` merges first and transfers only the protocol-v5 contract, browser, service-assembly, and E2E seams in Task 10; PR `03-scheduling` merges immediately after D-01 is recorded and Tasks 7-8 complete, and before any scheduling hotspot (`tool_executor.rs`, `scheduling.ts`, `review_schedule.rs`/`review_history.rs`, the data crate, migrations) transfers to Plans 04/06/09. Scheduling hotspots remain frozen for all lanes until PR `03-scheduling` merges.

- [ ] **Step 5: Confirm the preflight created no lane commit**

```bash
git status --short
test "$(git rev-parse HEAD)" = "${BASE_SHA}"
```

Expected: clean lane at `BASE_SHA`; the decision document is part of the coordinator-owned planning history this lane is based on and remains coordinator-owned.

---

### Task 1: Specify protocol v5 and its shared fixtures

**Files:**

- Modify: `packages/core/src/agent-contract.ts:1-5,163-181,247-257,386-432`
- Modify: `packages/core/src/agent-contract.test.ts`
- Modify: `agent/crates/agent-service/src/protocol.rs:9-46,393-520`
- Modify: `agent/fixtures/voice-protocol/client-audio.json`
- Modify: every v4 canonical fixture found by `rg -l '"version": 4' agent/fixtures`

- [ ] **Step 1: Write the failing TypeScript contract tests**

Add tests that parse an exact `audio_chunk`, `audio_end`, and `audio_turn_accepted`; reject a legacy `type: "audio"`; reject negative/fractional sequences; reject missing generation/turn identity; and assert all locked constants. Assert the encoded 8,192-byte chunk is below the unchanged 64 KiB text cap.

```ts
expect(parseVivaClientFrame({
  type: "audio_chunk",
  version: 5,
  client_generation_id: "generation-7",
  turn_id: "turn-01",
  sequence: 0,
  frame: { pcm16_base64: bytesToBase64(new Uint8Array(8_192)) },
})).toEqual(/* same discriminated frame */);
expect(VIVA_VOICE_MAX_TEXT_FRAME_BYTES).toBe(64 * 1024);
expect(VIVA_AUDIO_MAX_TURN_BYTES).toBe(2_160_000);
```

- [ ] **Step 2: Write the failing Rust parser/serializer tests**

Mirror the TypeScript examples in `protocol.rs`. Load `client-audio.json` in both languages. Add a serialization test for `ServerFrame::AudioTurnAccepted`.

- [ ] **Step 3: Verify RED**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
```

Expected: FAIL because v4 has no `AudioChunk`, `AudioEnd`, or `AudioTurnAccepted`, and the canonical fixture still contains `type: "audio"`.

- [ ] **Step 4: Preserve RED without committing**

Paste both failing summaries under `CRIT-AUDIO-01 / contract RED`. Keep the tests and fixture edits uncommitted and continue directly to Task 2; adding Rust enum variants without the assembler would make `ws.rs` non-exhaustive and is not a valid intermediate commit.

---

### Task 2: Specify the connection-local audio assembler

**Files:**

- Modify: `agent/crates/agent-service/src/ws.rs:2902-2988,3233-3420,4681-4890`
- Modify: `agent/crates/agent-service/tests/voice_ws.rs:9020-9300`

- [ ] **Step 1: Add RED state-machine unit tests**

Add table-driven tests that exercise `IncomingAudioTurn` without a network:

```rust
#[test]
fn audio_assembler_requires_zero_based_contiguous_sequences() { /* 0,1,2 passes */ }
#[test]
fn audio_assembler_rejects_duplicate_gap_and_out_of_order_sequences() { /* 0,0; 0,2; 1 */ }
#[test]
fn audio_assembler_rejects_mismatched_generation_or_turn() { /* exact identities */ }
#[test]
fn audio_assembler_rejects_empty_odd_or_oversized_chunks() { /* 0, 1, 8193 bytes */ }
#[test]
fn audio_assembler_accepts_exact_45_second_limit_and_rejects_one_more_sample() { /* 2_160_000 + 2 */ }
#[test]
fn audio_end_requires_last_sequence_and_emits_one_complete_frame() { /* no early turn */ }
#[test]
fn matching_cancel_discards_without_emitting_brain_input() { /* no phantom turn */ }
```

Use 8,192-byte chunks plus a bounded tail to reach exact limits. Assert rejected protocol errors contain no base64 or PCM data.

- [ ] **Step 2: Add RED real-WebSocket tests**

Using the existing `spawn_server`, `send_client_frame`, and `read_server_frame` helpers, send 20 ms/960-byte production chunks for 2, 10, and 45 seconds. For each duration assert:

1. the socket remains open;
2. no transcript/provider output occurs before `audio_end`;
3. exactly one `audio_turn_accepted` has the same generation, turn, and final sequence;
4. synthetic transcript reports exactly `duration * 48_000` PCM bytes;
5. exactly one evaluation/next-question progression occurs.

Add real-WS cases for duplicate, gap, out-of-order, mismatched turn, over-limit tail, cancellation halfway through 45 seconds, and a second turn attempted while the first is active. The cancellation test sends 22.5 seconds, cancels, waits under a deterministic timeout, and asserts no transcript/evaluation.

- [ ] **Step 3: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-service audio_assembler -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws streamed_audio_turns -- --nocapture
```

Expected: FAIL because the v5 variants and `IncomingAudioTurn` do not exist and the old path maps one whole audio frame directly to one `BrainInput`.

- [ ] **Step 4: Do not commit RED; preserve output in the PR**

Paste both failing summaries under `CRIT-AUDIO-01 / RED` before beginning Task 3.

---

### Task 3: Implement bounded server assembly, cancellation, and admission

**Files:**

- Modify: `packages/core/src/agent-contract.ts:1-5,163-181,247-257,386-432`
- Modify: `agent/crates/agent-service/src/protocol.rs:9-46,393-520`
- Modify: `agent/fixtures/voice-protocol/*.json` only where protocol version or audio frames change
- Modify: `agent/crates/agent-service/src/ws.rs:571-720,2902-2988,3233-3420`
- Modify only if its test fails: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs:86-143,209-250,487-503`
- Modify (`#[cfg(test)]` additions only): `agent/crates/agent-adapters/src/synthetic.rs:152-205`; if the cardinality test fails against production synthetic audio code, stop and escalate to the coordinator for a Plan 07 pre-handoff instead of editing production code here

- [ ] **Step 1: Implement the locked shared contract**

Add the constants, TypeScript/Rust discriminated frame variants, strict safe-integer/non-empty-identity parsing, and serializers. Change every canonical fixture to version 5; replace fixture audio input with contiguous chunks plus one end frame. Do not loosen generic text parsing or the 64 KiB cap.

- [ ] **Step 2: Add `IncomingAudioTurn` and checked mutations**

Keep one `Option<IncomingAudioTurn>` in the connection task. Decode and validate before extending. Use `checked_add` for byte/sample totals. Clear state on terminal protocol violation and on matching cancel. Never log payloads.

- [ ] **Step 3: Admit exactly once at explicit end**

On valid `audio_end`, move the buffer into one `AudioFrame`, send one `BrainInput::AudioWithMetadata`, arm the existing turn timeout/admission state once, and emit `audio_turn_accepted` only after that bounded-channel admission succeeds. Do not arm provider timeouts on chunks.

- [ ] **Step 4: Prove runner cardinality**

Add/retain a focused adapter assertion that a completed 45-second assembled frame causes one `transcribe_audio` call and one provider turn. If it passes without production changes, leave runner production code untouched.

- [ ] **Step 5: Verify GREEN**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service audio_assembler -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws streamed_audio_turns -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_gemini::runner -- --nocapture
```

Expected: PASS. The exact-limit turn succeeds; one additional sample fails closed; cancellation creates no provider work.

- [ ] **Step 6: Commit the contract and server lifecycle**

```bash
git add packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/crates/agent-service/src/protocol.rs agent/crates/agent-service/src/ws.rs agent/crates/agent-service/tests/voice_ws.rs agent/fixtures/voice-protocol agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/src/synthetic.rs
git commit -m "fix(voice): publish and assemble bounded v5 turns"
```

---

### Task 4: Specify stateful resampling and the retained-send controller

**Files:**

- Modify: `apps/web/lib/viva-audio-capture.test.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/lib/use-viva-agent-session.test.ts`

- [ ] **Step 1: Add RED stateful resampler tests**

Generate deterministic 440 Hz input at 44,100 and 48,000 Hz. Push it once as one block and again through the irregular callback pattern `[1, 127, 128, 511, 7, 2048, 333]` until exhausted. For 2, 10, and 45 seconds assert identical output length, boundary-continuous output, and exact counts `duration * 24_000`. Assert resetting between capture generations reproduces the same initial output; no reset between callbacks is allowed.

```ts
for (const sourceRate of [44_100, 48_000]) {
  for (const seconds of [2, 10, 45]) {
    expect(streamInIrregularBlocks(sourceRate, seconds).length).toBe(seconds * 24_000);
  }
}
```

- [ ] **Step 2: Add RED controller/backpressure tests**

Extend `FakeWebSocket` with mutable `bufferedAmount`, `OPEN`, close, and message delivery. Test the exact `VivaAudioSendResult` union and these cases:

- 960-byte chunks serialize in sequence as protocol v5 frames.
- At the 64 KiB high-water mark, the result is `pending`, the chunk remains in the bounded ledger, and `audio_end` does not overtake it.
- When `bufferedAmount` falls, `retryPendingAudio()` drains in order and returns the correct accepted sequence.
- A closed socket returns `socket_closed`, `retryable: true`, and retains from the first unacknowledged sequence.
- A matching `audio_turn_accepted` releases the ledger; a mismatched generation/turn/final sequence does not.
- A second `turnId`, a chunk above 8,192 bytes, a noncontiguous sequence, or a total above 2,160,000 bytes fails closed without growing the ledger.
- `cancelAudioTurn` sends the scoped cancel when possible and always clears local bytes.
- Repeated pending/retry/cancel cycles never exceed the raw turn cap.

- [ ] **Step 3: Add RED hook-surface tests**

Assert through the hook module's exported pure session-command surface — the same non-mounted style the existing `use-viva-agent-session.test.ts` already uses — that the four exact audio methods delegate to the controller seam and return the discriminated result unchanged. Do not mount components or require a DOM: `bun:test` has no DOM environment at this base, and this lane's ownership does not include adding a test-DOM dependency (that arrives with Plan 12's `12a` node). Remove boolean-result expectations for audio only; preserve existing text behavior unless the shared implementation makes the same result type necessary.

- [ ] **Step 4: Verify RED**

```bash
bun test apps/web/lib/viva-audio-capture.test.ts
bun test apps/web/lib/viva-agent-client.test.ts
bun test apps/web/lib/use-viva-agent-session.test.ts
```

Expected: FAIL because resampling resets phase per callback, audio submission is one boolean-returning frame, `FakeWebSocket` has no backpressure behavior, and the hook exposes only `sendAudio(base64)`.

- [ ] **Step 5: Preserve RED output without committing**

Add the three failing summaries to `CRIT-AUDIO-01 / browser RED` in the PR.

---

### Task 5: Implement stateful capture, bounded client backpressure, and UI lifecycle

**Files:**

- Modify: `apps/web/lib/viva-audio-capture.ts:1-133,237-386`
- Modify: `apps/web/lib/viva-agent-client.ts:189-205,806-832,917-918`
- Modify: `apps/web/lib/use-viva-agent-session.ts:112-130`
- Modify: `apps/web/components/session/LiveSessionPage.tsx:128,363-515,1021-1061,1113-1123`
- Modify: `apps/web/components/session/LiveSessionPage.test.tsx`

- [ ] **Step 1: Implement one resampler per capture lifecycle**

Construct `createStreamingFloat32Resampler(sourceRate, 24_000)` when capture starts. Reuse it across every AudioWorklet callback, and reset/discard it on stop, source replacement, or component disposal. Keep the existing 20 ms/960-byte production chunk target; the 8,192-byte protocol limit is a ceiling, not the preferred chunk size. Make `apps/web/lib/viva-audio-capture.ts` consume the core constant instead of re-declaring its own `VIVA_AUDIO_SAMPLE_RATE_HZ` binding, or re-export the core value verbatim; exactly one 24 kHz literal remains, in `packages/core`.

- [ ] **Step 2: Implement the bounded turn ledger and queue pump**

Add the exact `VivaAudioSendResult` API. Store raw `Uint8Array` copies plus sequence metadata in one current-generation ledger capped at 2,160,000 bytes. Serialize no chunk above 8,192 raw bytes. If `socket.bufferedAmount >= 64 * 1024`, retain the next chunk and return `pending`; schedule a cancellable short queue-pump timer, but also expose deterministic `retryPendingAudio()` for tests and Plan 10. Cancel the timer on close, generation replacement, acceptance, cancellation, and disposal.

Keep already serialized chunks until matching `audio_turn_accepted`. The ledger state distinguishes `lastSerializedSequence`, `retainedFromSequence`, `endRequested`, and `accepted`. A close never clears it. A generation replacement leaves it available to Plan 10 but does not replay it in Plan 03. Enforce one active input turn and exact sequence continuity before allocating/copying.

- [ ] **Step 3: Replace whole-turn UI buffering with the lifecycle controller**

Replace `capturedTurnPcm16Ref` and `pcm16ChunksToBase64` with:

```ts
type ActiveAudioTurn = {
  turnId: string;
  nextSequence: number;
  capturedSamples: number;
};
```

At first non-empty capture callback, create an opaque turn ID and call `sendAudioChunk`. For each callback, increment `capturedSamples` with checked arithmetic and stop capture before it can exceed 1,080,000 samples. At learner submit/explicit stop, flush the capture source, call `endAudioTurn` with `nextSequence - 1`, and keep the UI in pending state until `audio_turn_accepted` or an error. Do not clear the controller ledger merely because submit was clicked.

On switch to text, session close, recap transition, device error, retry, component unmount, or explicit cancel, call `cancelAudioTurn` before clearing UI state. A `socket_closed` result displays the existing recoverable transport failure surface and preserves retry metadata; it does not pretend the answer was sent. Do not create automatic reconnect UX here.

- [ ] **Step 4: Add component lifecycle tests at the extracted controller seam**

Extract `LiveSessionPage`'s audio lifecycle wiring into pure, controller-driven helpers testable without a DOM, matching the existing pure-helper style of `LiveSessionPage.test.tsx`. Mock the controller, emit several capture callbacks, and assert contiguous chunk calls followed by one end call. Cover `pending`, `socket_closed`, exact 45-second auto-stop/end, and `audio_turn_accepted` release, and assert that the switch-to-text, device-error, disposal/unmount, and explicit-cancel paths each invoke `cancelAudioTurn` exactly once through the extracted helpers. Assert no call contains a merged whole-turn base64 payload and no raw payload appears in rendered error copy. Do not mount components under `bun:test`: no DOM environment exists at this base and this lane's ownership does not include adding one. Real mounted-lifecycle behavior is exercised by the browser E2E proofs (Task 6 and the existing `bun run e2e:browser` flow); Plan 10 may add mounted DOM tests after Plan 12's `12a` `happy-dom` dependency merges.

- [ ] **Step 5: Verify GREEN**

```bash
bun test apps/web/lib/viva-audio-capture.test.ts
bun test apps/web/lib/viva-agent-client.test.ts
bun test apps/web/lib/use-viva-agent-session.test.ts
bun test apps/web/components/session/LiveSessionPage.test.tsx
```

Expected: PASS at 44.1/48 kHz and 2/10/45 seconds; pending chunks remain bounded and ordered; every abort path cancels.

- [ ] **Step 6: Commit the browser lifecycle**

```bash
git add apps/web/lib/viva-audio-capture.ts apps/web/lib/viva-audio-capture.test.ts apps/web/lib/viva-agent-client.ts apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/components/session/LiveSessionPage.tsx apps/web/components/session/LiveSessionPage.test.tsx
git commit -m "fix(web): stream bounded microphone turns with backpressure"
```

---

### Task 6: Add a production-shaped browser-to-real-WebSocket proof and negative control

**Files:**

- Create: `scripts/e2e-browser-audio.mjs`
- Create: `scripts/fixtures/e2e-browser-audio-entry.ts`
- Modify: `package.json:14-27`
- Reuse without changing unless required: `agent/crates/agent-service/tests/voice_ws.rs:9020-9300`

- [ ] **Step 1: Write the oversized single-chunk negative control first**

The script starts the real local `agent-service` with the same deterministic in-memory synthetic setup as `scripts/e2e-browser.mjs`, bundles `scripts/fixtures/e2e-browser-audio-entry.ts` for the browser, opens a real Playwright page, and uses a browser-native `WebSocket`. Add `oversized_single_chunk_negative_control`: put 2 seconds of 24 kHz PCM16 into one otherwise well-shaped v5 `audio_chunk` JSON frame and assert the real server rejects it under the unchanged 64 KiB text cap/8,192-byte chunk cap. Require the expected oversized/protocol close; a timeout, generic connection failure, or accepted turn is not a passing negative control.

Run before implementing the positive v5 path:

```bash
node scripts/e2e-browser-audio.mjs --case oversized-single-chunk
```

Expected negative-control evidence: one 2-second chunk cannot complete a browser turn. Preserve the exact close/protocol result in the PR. The script exits zero only when that rejection is positively observed. This prevents a false green caused by raising or bypassing the text/chunk cap.

- [ ] **Step 2: Add the positive production-shaped stream**

The browser entry imports the production `createVivaAgentSessionController`, `createBrowserVivaAudioCaptureSource`, and `startVivaPcm16StreamingCapture` modules; Chromium runs with the existing fake-media-device flags and microphone permission. Do not reimplement the positive controller, frame builders, queue, or capture chunking in the script. Stop each capture after exactly 2, 10, and 45 seconds of target samples, submit through `endAudioTurn`, and use distinct turn IDs. For each, wait for matching `audio_turn_accepted`, exact synthetic transcript byte count, evaluation, and next-question readiness. Assert one transcript/evaluation per turn and an open socket after all three.

```js
for (const seconds of [2, 10, 45]) {
  const targetSamples = seconds * 24_000;
  await runCapturedTurnWithProductionModules({ targetSamples });
  await expectAcceptedAndTranscribed({ rawBytes: targetSamples * 2 });
}
```

The small loop above is orchestration inside the browser entry; chunk bytes and send results come from the production capture/controller. The only handwritten oversized frame is the negative control. Bundle with Bun into a temporary directory created by `mktemp`/the platform temp API and remove it in `finally`. The browser-native WebSocket and real Rust listener are mandatory; a fake socket or Node-only client is not an adequate substitute.

- [ ] **Step 3: Register exact commands**

Add:

```json
"e2e:browser:audio": "node scripts/e2e-browser-audio.mjs",
"e2e:browser:audio:negative": "node scripts/e2e-browser-audio.mjs --case oversized-single-chunk"
```

- [ ] **Step 4: Verify GREEN and false-positive controls**

```bash
bun run e2e:browser:audio:negative
bun run e2e:browser:audio
```

Expected: the negative command proves an oversized single-chunk turn is rejected; the positive command completes 2/10/45 seconds over the same real boundary. Then intentionally change the positive harness's second sequence from `1` to `2`; expected FAIL with a protocol error. Revert that mutation and rerun GREEN. Record both results.

- [ ] **Step 5: Commit the end-to-end proof**

```bash
git add scripts/e2e-browser-audio.mjs scripts/fixtures/e2e-browser-audio-entry.ts package.json
git commit -m "test(e2e): prove streamed browser audio over real websocket"
```

---

## Scheduling execution after D-01

The following common task runs for either branch. Then execute exactly one of Task 8A or Task 8B. Both branches are deliberately concrete because D-01 is a real architecture decision; neither permits the implementer to quietly fall back to current fixed dates.

### Task 7: Pin the selected scheduling policy with an independent conformance fixture

**Files:**

- Create: `packages/core/src/review-scheduling-conformance-v1.json`
- Create: `packages/core/src/review-scheduling-conformance.test.ts`
- Modify: `packages/core/src/scheduling.ts:1-145`
- Modify: `packages/core/src/scheduling.test.ts`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Create: `agent/crates/agent-domain/tests/review_scheduling_conformance.rs`
- Modify: `agent/crates/agent-domain/Cargo.toml`
- Modify: `agent/Cargo.lock`

- [ ] **Step 1: Generate, inspect, and literalize the fixture independently**

Using the FSRS policy/version and mapping recorded in D-01, derive expected cases with an independent oracle that is neither the production `ts-fsrs` path nor the selected Rust implementation. Use the official reference algorithm/release named in D-01 with the exact recorded parameters in an isolated, disposable environment; record its version and artifact digest in PR evidence. A second reviewer manually checks every literal against the published equations and event timeline. Check in only the literal JSON; no fixture-generation script runs in production or tests.

The fixture contains exactly these coverage rows at non-June dates:

- New cards for all four statuses/ratings at `2031-04-05T12:00:00Z`.
- One existing/reviewed card for every FSRS state exercised by the chosen policy.
- Hints unknown, zero, and positive; misses unknown, zero, one, and multiple, without treating unknown as zero.
- No exam, an exam outside the cap window, an exam inside it, an exam closer than the selected margin, and an already-past exam.
- UTC timestamps on both sides of midnight and a leap-day case.
- At least one case whose expected interval is not 1, 2, 3, or 8 days, proving the fixture is not a disguised fixed lookup.

Every row contains versioned input, literal `graded_at`, prior card/history, status/rating, hint/miss provenance, exam metadata, and literal expected decision/projection including ISO `due_at`. Branch A rows also contain literal `PersistedFsrsCardV1`; Branch B rows contain literal `ReviewHistoryEventV1` and `ReadTimeReviewProjectionV1`.

- [ ] **Step 2: Add RED TypeScript conformance tests**

Parse the fixture fail closed. Use an injected `Date` value, never `Date.now()`. Assert exact milliseconds, rating, cap reason, policy/version, and exam invariant. Assert a fixture with an unknown schema version is rejected.

- [ ] **Step 3: Add RED Rust conformance tests**

Load the exact same JSON with `include_str!("../../../../packages/core/src/review-scheduling-conformance-v1.json")`. Assert the selected Rust persistence path consumes the same clock/input and produces byte-for-semantic-byte equivalent versioned values. Do not copy expected timestamps into Rust test code.

- [ ] **Step 4: Verify RED**

```bash
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test review_scheduling_conformance -- --nocapture
```

Expected: FAIL because TypeScript currently creates a fresh empty card, Rust has no injected clock/selected scheduling model, and live Rust still emits June 2026 literals.

- [ ] **Step 5: Validate fixture independence before implementation**

Have a reviewer compare the checked-in literals against the D-01 policy source without invoking either production scheduler. Record reviewer, source/version, and discrepancies in the PR. A fixture produced and approved only by the production function is circular and blocks Task 8.

---

### Task 8A: Execute `SERVER_PERSISTED_FSRS` if and only if D-01 selects Branch A

**Conditional temporary ownership/files:**

- Create: `agent/crates/agent-domain/src/review_schedule.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Modify: `agent/crates/agent-domain/src/ports.rs:300-325,639-662`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs:1-45,229-252,339-346`
- Modify: `agent/crates/agent-domain/Cargo.toml`
- Modify: `agent/Cargo.lock`
- Modify: `agent/crates/agent-adapters/src/synthetic.rs:630-710,808-815`
- Modify: `agent/crates/data/src/lib.rs`
- Modify: `agent/crates/data/src/memory.rs:292-305,2329-2368,3029-3055`
- Modify: `agent/crates/data/src/postgres.rs:1160-1210,2198-2227`
- Modify: `agent/crates/agent-service/tests/voice_ws.rs` — only the library-snapshot seeding/assertion regions at lines 295-320, 1150-1175, and 1305-1320
- Create: `agent/migrations/0015_review_schedule_decisions_v1.sql`
- Modify: `agent/crates/data/src/migrations.rs:1-70,300-360`
- Modify: focused memory/Postgres tests in `agent/crates/data/src/memory.rs` and `agent/crates/data/src/migrations.rs`
- Modify: `packages/core/src/scheduling.ts` and `.test.ts`

- [ ] **Step 1: Define the versioned scheduling types and injected clock**

Add domain-owned serialized types with fail-closed validation:

```rust
pub trait Clock: Send + Sync {
    fn now(&self) -> chrono::DateTime<chrono::Utc>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedFsrsCardV1 {
    pub schema_version: u8, // exactly 1
    pub due_at: DateTime<Utc>,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: u32,
    pub scheduled_days: u32,
    pub reps: u32,
    pub lapses: u32,
    pub state: FsrsCardStateV1,
    pub last_review_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReviewScheduleDecisionV1 {
    pub schema_version: u8, // exactly 1
    pub policy_id: String,
    pub generated_at: DateTime<Utc>,
    pub status: ConceptStatus,
    pub rating: u8,
    pub hint_count: Option<u32>,
    pub miss_count: Option<u32>,
    pub exam_at: Option<DateTime<Utc>>,
    pub exam_margin_seconds: u64,
    pub uncapped_due_at: DateTime<Utc>,
    pub due_at: DateTime<Utc>,
    pub cap_reason: Option<ReviewScheduleCapReasonV1>,
    pub card: PersistedFsrsCardV1,
}
```

`SystemClock` is the production default. `FixedClock` exists only under tests. `VivaToolExecutor::new` preserves call-site compatibility by constructing `SystemClock`; `VivaToolExecutor::with_clock` is the test/composition path. Read `clock.now()` exactly once per scheduling outcome.

Unknown hint/miss provenance remains `None`; do not convert absence to zero. The selected policy must define how `None` affects scheduling. `policy_id`, rating mapping, and `exam_margin_seconds` are exact values from D-01, not defaults in a second file.

- [ ] **Step 2: Add RED domain tests against live execution paths**

With `FixedClock(2031-04-05T12:00:00Z)`, execute `schedule_review_item` through `VivaToolExecutor`, then run the same outcome through `SyntheticBrain`. Assert both persist the exact fixture decision/card/due date, not any June 2026 string. Add prior-card cases so the second review differs from a fresh card. Add exam cases at, inside, and beyond the selected margin; assert no scheduled `due_at` is after `exam_at`.

Add a test that a model-provided `due_at` remains rejected. Time and exam metadata come only from `Clock` and the authoritative store context.

- [ ] **Step 3: Add RED store and migration tests**

Change `StudyMemoryStore` to load an authoritative scheduling context and atomically persist the schedule:

```rust
async fn review_scheduling_context(
    &self,
    user_id: &str,
    study_set_id: &str,
    concept_id: &str,
) -> Result<ReviewSchedulingContextV1, PortError>;

async fn persist_review_schedule_decision(
    &self,
    user_id: &str,
    study_set_id: &str,
    voice_session_id: &str,
    concept_id: &str,
    decision: ReviewScheduleDecisionV1,
) -> Result<Value, PortError>;
```

The context supplies the study set's persisted exam timestamp and the latest `PersistedFsrsCardV1`; it never accepts those from tool arguments. Memory and Postgres tests assert decision/card round-trip, idempotent replay, concurrent replay, user/study/concept scoping, and transaction rollback on a partial write.

Migration `0015_review_schedule_decisions_v1.sql` follows the existing `0014_session_recaps_one_row_per_session.sql` migration and adds JSONB card/decision columns plus explicit schema-version checks/indexes to the persisted review record. It also marks rows at the four known buggy literals (`2026-06-18T09:00:00Z`, `2026-06-19T09:00:00Z`, `2026-06-20T09:00:00Z`, `2026-06-24T09:00:00Z`) as `superseded`; it does not invent replacement dates without history. The authenticated library query selects only valid v1 decisions and never falls back to a superseded row.

- [ ] **Step 4: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain review_schedule -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters synthetic_review_schedule -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_schedule_decision -- --nocapture
```

Expected: FAIL because the executor/synthetic adapter still call `storage_due_at_for_status`, no prior card or clock is loaded, and the stores persist only a due string.

- [ ] **Step 5: Implement the selected FSRS policy once in Rust**

Pin the exact Rust FSRS implementation/version selected by D-01 in the workspace lockfile. If the crate cannot reproduce the independent fixture exactly, stop and amend D-01; do not tune expected literals to the implementation. Put status-to-rating, prior-card conversion, scheduling, and exam cap in `review_schedule.rs`. Both live tool execution and synthetic execution call this one function. Delete both `storage_due_at_for_status` functions.

Use checked UTC parsing and finite/range validation for every card value. Compute the uncapped FSRS result, then apply only the recorded D-01 exam-margin rule. For an already-past exam, return the recorded D-01 fail-closed outcome; never create a review after the exam.

- [ ] **Step 6: Make `packages/core` consume the same versioned card semantics**

Update `scheduleConceptReview` so a supplied prior `PersistedFsrsCardV1` is converted to the pinned `ts-fsrs` card rather than replaced with `createEmptyCard`. Make `now` required and injected. Align status/rating and exam-cap behavior with the literal conformance fixture. Preserve UI-only label/explanation projection outside the authoritative calculation.

- [ ] **Step 7: Persist atomically at outcome time**

In both executor paths, read `now` once, load scoped context, compute the decision, and pass the whole decision to the store transaction. The returned tool result exposes `due_at`, `policy_id`, and `schema_version` but not raw FSRS difficulty/stability. Storage writes the due date and v1 JSON together or neither. Do not continue on a scheduling store rejection; the old synthetic best-effort comment is removed because a silently missing/incorrect authoritative schedule is a critical failure.

- [ ] **Step 8: Update the voice_ws library-snapshot tests to the Branch A persistence seam**

The existing library tests seed legacy review items with `store.schedule_review_item(..., "2026-06-19T09:00:00Z")` (`voice_ws.rs:300-306,1155-1162`) and assert `next_review.persisted_due_at == "2026-06-19T09:00:00Z"` with source `persisted_review_item` (`voice_ws.rs:1314-1319`); Branch A's valid-v1-only library query breaks both. Re-seed through `persist_review_schedule_decision` with a literal fixture decision, update the `next_review` expectations to Branch A's authoritative value, and remove the legacy `2026-06-19T09:00:00Z` seeding.

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws library -- --nocapture
```

- [ ] **Step 9: Verify GREEN and mutation controls**

```bash
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test review_scheduling_conformance -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain review_schedule -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters synthetic_review_schedule -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_schedule_decision -- --nocapture
```

Expected: PASS. Then mutate one Rust status-to-rating mapping and one exam-margin comparison; each mutation must make the shared conformance test fail. Revert and rerun GREEN.

- [ ] **Step 10: Commit Branch A**

```bash
git add agent/Cargo.lock agent/crates/agent-domain/Cargo.toml agent/crates/agent-domain/src/review_schedule.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/src/ports.rs agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/review_scheduling_conformance.rs agent/crates/agent-adapters/src/synthetic.rs agent/crates/agent-service/tests/voice_ws.rs agent/crates/data/src/lib.rs agent/crates/data/src/memory.rs agent/crates/data/src/postgres.rs agent/crates/data/src/migrations.rs agent/migrations/0015_review_schedule_decisions_v1.sql packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts packages/core/src/review-scheduling-conformance-v1.json packages/core/src/review-scheduling-conformance.test.ts
git commit -m "fix(schedule): persist authoritative FSRS decisions"
```

- [ ] **Step 11: Skip Task 8B and prove only Branch A exists**

```bash
rg -n 'SERVER_PERSISTED_FSRS' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md
test ! -e agent/migrations/0015_review_history_events_v1.sql
```

Expected: selected Branch A marker and no Branch B migration.

---

### Task 8B: Execute `EVENTS_PLUS_READ_TIME_PROJECTION` if and only if D-01 selects Branch B

**Conditional temporary ownership/files:**

- Create: `agent/crates/agent-domain/src/review_history.rs`
- Modify: `agent/crates/agent-domain/src/lib.rs`
- Modify: `agent/crates/agent-domain/src/ports.rs:300-325,639-662`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs:1-45,229-252,339-346`
- Modify: `agent/crates/agent-domain/Cargo.toml`
- Modify: `agent/Cargo.lock`
- Modify: `agent/crates/agent-adapters/src/synthetic.rs:630-710,808-815`
- Modify: `agent/crates/data/src/lib.rs`
- Modify: `agent/crates/data/src/memory.rs:292-305,2329-2368,3029-3055`
- Modify: `agent/crates/data/src/postgres.rs:1120-1210,2198-2227`
- Modify: `agent/crates/agent-service/tests/voice_ws.rs` — only the library-snapshot seeding/assertion regions at lines 295-320, 1150-1175, and 1305-1320
- Create: `agent/migrations/0015_review_history_events_v1.sql`
- Modify: `agent/crates/data/src/migrations.rs:1-70,300-360`
- Modify: `agent/crates/agent-service/src/app.rs:1470-1530`
- Modify: `apps/web/app/api/viva-library/[[...path]]/route.ts:1-115`
- Modify: `apps/web/lib/viva-library.ts:1-75,390-425` and `.test.ts`
- Modify: `apps/web/lib/viva-library-proxy.test.ts`
- Modify: `packages/core/src/scheduling.ts` and `.test.ts`

- [ ] **Step 1: Define the immutable event and read-time projection**

Add the exact versioned persistence envelope:

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReviewHistoryEventV1 {
    pub schema_version: u8, // exactly 1
    pub event_id: String,
    pub graded_at: DateTime<Utc>,
    pub status: ConceptStatus,
    pub rating: u8,
    pub hint_count: Option<u32>,
    pub miss_count: Option<u32>,
    pub exam_at: Option<DateTime<Utc>>,
    pub exam_margin_seconds: u64,
    pub policy_id: String,
}
```

`event_id` is deterministically derived from the authorized response/session/concept identity for idempotent replay. Time comes from injected `Clock`; exam metadata comes from the persisted study set; rating mapping and margin come from D-01. Unknown hint/miss provenance is stored as `null`, never zero. There is no `due_at` field or placeholder in this event or its table.

In `packages/core`, define:

```ts
export type ReadTimeReviewProjectionV1 = Readonly<{
  schemaVersion: 1;
  conceptId: string;
  projectedAt: string;
  dueAt: string;
  policyId: string;
  sourceEventIds: readonly string[];
  capReason: "exam_margin" | "past_exam" | null;
}>;

export function projectReviewHistoryAtReadTime(input: Readonly<{
  conceptId: string;
  events: readonly ReviewHistoryEventV1[];
  now: Date;
}>): ReadTimeReviewProjectionV1 | null;
```

Only this `packages/core` function calculates `dueAt` in Branch B. Rust stores and transports events; it never projects dates.

- [ ] **Step 2: Add RED immutable-store tests**

Add `StudyMemoryStore::record_review_history_event` and include scoped events in the authenticated library persistence payload. Tests assert immutable append, deterministic replay deduplication, concurrent replay, chronological ordering, cross-user/study isolation, and no due-date column/value. Add a schema test that scans the migration SQL and fails if the event table contains `due_at`.

Migration `0015_review_history_events_v1.sql` follows the existing `0014_session_recaps_one_row_per_session.sql` migration and creates an append-only event table with unique `(user_id, study_set_id, voice_session_id, concept_id, event_id)` identity and JSON/schema checks. Do not relax or populate `review_items.due_at`; new Branch B execution simply stops writing `review_items`. Legacy `review_items` remain for audit/export but are excluded from the Branch B authenticated read model.

- [ ] **Step 3: Add RED executor and synthetic tests**

With `FixedClock(2031-04-05T12:00:00Z)`, execute the live scheduling tool and synthetic outcome. Assert one exact event each, no review item write, no June literal, and no due date in the tool result. Assert model-provided `due_at` remains rejected. Add no-exam, future-exam, close-exam, and past-exam rows with exact D-01 metadata.

- [ ] **Step 4: Add RED authenticated read-model tests**

The Rust library endpoint returns scoped `ReviewHistoryEventV1` data after its existing bearer/user authorization. In the same-origin authenticated Next proxy, parse that payload, capture one `projectedAt = new Date()` per response, and call `projectReviewHistoryAtReadTime` before returning the browser-safe `VivaLibrarySnapshot`. Export a pure helper taking `now` so tests use a fixed clock.

Assert the response's `next_review` comes only from the v1 projection, ignores a conflicting legacy fixed `review_items` row, includes source event IDs for audit, and never displays after a future exam. For a past exam, assert the exact D-01 outcome. Reject unknown event schemas instead of falling back to legacy `persisted_due_at`.

- [ ] **Step 5: Verify RED**

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-domain review_history -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters synthetic_review_history -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_history_event -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service library_snapshot_review_history -- --nocapture
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
bun test apps/web/lib/viva-library.test.ts apps/web/lib/viva-library-proxy.test.ts
```

Expected: FAIL because current paths write a fixed due date, the store requires `review_items.due_at`, the library query reads that legacy row, and no core read-time projection exists.

- [ ] **Step 6: Implement event persistence without a placeholder due date**

Inject `Clock` exactly as in Branch A, read it once per outcome, obtain authoritative exam metadata from the scoped study set, construct the immutable event, and append it transactionally. Both `VivaToolExecutor` and `SyntheticBrain` use `review_history.rs`; delete both `storage_due_at_for_status` functions and all new-path calls to `schedule_review_item`.

Do not synthesize hints/misses. Persist their explicit known counts when the existing authorized outcome provides them and `null` otherwise. Plan 04 may expand grading provenance, but it may not reinterpret an old `null` as zero.

- [ ] **Step 7: Implement the core-only authenticated read projection**

Use the pinned policy and literal fixture in `packages/core/src/scheduling.ts`. Sort events by `(graded_at, event_id)`, reconstruct the card/history deterministically, project at the single injected read time, and apply the exact exam-margin sub-decision. The proxy returns the existing browser-facing `next_review` shape plus projection provenance; it never forwards raw history for another client-side calculation. `apps/web/lib/viva-library.ts` only validates/maps the already projected value and does not run FSRS.

- [ ] **Step 8: Update the voice_ws library-snapshot tests to the Branch B read model**

The existing library tests seed legacy review items with `store.schedule_review_item(..., "2026-06-19T09:00:00Z")` (`voice_ws.rs:300-306,1155-1162`) and assert `next_review.persisted_due_at == "2026-06-19T09:00:00Z"` with source `persisted_review_item` (`voice_ws.rs:1314-1319`); Branch B excludes legacy `review_items` from the authenticated read model, breaking both. Re-seed through `record_review_history_event`, update the library-snapshot expectations to Branch B's authenticated read model — scoped `ReviewHistoryEventV1` data in place of the legacy `persisted_review_item` `next_review` — and remove the legacy `2026-06-19T09:00:00Z` seeding.

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws library -- --nocapture
```

- [ ] **Step 9: Verify GREEN and negative controls**

Run all commands from Step 5, plus the voice_ws library command from Step 8. Then intentionally insert `due_at TIMESTAMPTZ NOT NULL` into a copy of the event migration and assert the schema test fails; revert. Change the core event order and exam comparison independently and assert the conformance/proxy tests fail; revert and rerun GREEN.

- [ ] **Step 10: Commit Branch B**

```bash
git add agent/Cargo.lock agent/crates/agent-domain/Cargo.toml agent/crates/agent-domain/src/review_history.rs agent/crates/agent-domain/src/lib.rs agent/crates/agent-domain/src/ports.rs agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-domain/tests/review_scheduling_conformance.rs agent/crates/agent-adapters/src/synthetic.rs agent/crates/agent-service/tests/voice_ws.rs agent/crates/data/src/lib.rs agent/crates/data/src/memory.rs agent/crates/data/src/postgres.rs agent/crates/data/src/migrations.rs agent/crates/agent-service/src/app.rs agent/migrations/0015_review_history_events_v1.sql packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts packages/core/src/review-scheduling-conformance-v1.json packages/core/src/review-scheduling-conformance.test.ts apps/web/app/api/viva-library/\[\[...path\]\]/route.ts apps/web/lib/viva-library.ts apps/web/lib/viva-library.test.ts apps/web/lib/viva-library-proxy.test.ts
git commit -m "fix(schedule): project review dates from immutable events"
```

- [ ] **Step 11: Skip Task 8A and prove only Branch B exists**

```bash
rg -n 'EVENTS_PLUS_READ_TIME_PROJECTION' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md
test ! -e agent/migrations/0015_review_schedule_decisions_v1.sql
```

Expected: selected Branch B marker and no Branch A migration.

---

### Task 9: Prove both criticals on the combined expedited tree

**Files:**

- All files touched by Tasks 0-8.
- Do not add unrelated fixes while closing this task.

- [ ] **Step 1: Run the complete focused audio matrix**

```bash
bun test packages/core/src/agent-contract.test.ts
bun test apps/web/lib/viva-audio-capture.test.ts apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/components/session/LiveSessionPage.test.tsx
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service audio_assembler -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws streamed_audio_turns -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters cartesia_gemini::runner -- --nocapture
bun run e2e:browser:audio:negative
bun run e2e:browser:audio
```

Expected: all unit/integration tests pass; negative control observes oversized single-chunk rejection; positive real-browser path completes 2/10/45 seconds.

- [ ] **Step 2: Run the selected scheduling matrix**

For Branch A:

```bash
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test review_scheduling_conformance -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain review_schedule -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters synthetic_review_schedule -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_schedule_decision -- --nocapture
```

For Branch B:

```bash
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
bun test apps/web/lib/viva-library.test.ts apps/web/lib/viva-library-proxy.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test review_scheduling_conformance -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-domain review_history -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-adapters synthetic_review_history -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p data review_history_event -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service library_snapshot_review_history -- --nocapture
```

Expected: run only the selected branch block and record it under D-01 evidence. Running the other branch is an error because its files must not exist.

- [ ] **Step 3: Run invariant scans**

```bash
test "$(rg -n 'VIVA_VOICE_MAX_TEXT_FRAME_BYTES[^\n]*64 \* 1024|VIVA_VOICE_MAX_TEXT_FRAME_BYTES[^\n]*64\*1024' packages/core/src/agent-contract.ts agent/crates/agent-service/src/protocol.rs | wc -l | tr -d ' ')" -ge 2
! rg -n '2026-06-(18|19|20|24)T09:00:00Z|fn storage_due_at_for_status' agent/crates/agent-domain/src agent/crates/agent-adapters/src packages/core/src/scheduling.ts
test "$(rg -n 'VIVA_AUDIO_MAX_CHUNK_BYTES[^\n]*= 8_?192' packages/core/src/agent-contract.ts agent/crates/agent-service/src/protocol.rs | wc -l | tr -d ' ')" -ge 2
test "$(rg -n 'VIVA_AUDIO_MAX_TURN_BYTES[^\n]*= 2_?160_?000' packages/core/src/agent-contract.ts agent/crates/agent-service/src/protocol.rs | wc -l | tr -d ' ')" -ge 2
rg -n 'audio_chunk|audio_end|audio_turn_accepted' packages/core/src/agent-contract.ts agent/crates/agent-service/src/protocol.rs agent/fixtures
git diff --check
```

Expected: the text cap remains 64 KiB in both contracts; no production fixed-date helper/literal remains; audio constants are not raised; all canonical fixtures expose v5 lifecycle frames; diff check is clean. Migration references to the four buggy literals are allowed only in Branch A's explicit supersession statement/test.

- [ ] **Step 4: Replay canonical protocol fixtures**

```bash
bun run agent:replay:ws
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test protocol_fixtures -- --nocapture
```

Expected: protocol v5 fixtures pass through the real replay boundary and shared scheduling fixture parser.

- [ ] **Step 5: Run repository validation and existing browser proof**

```bash
bun run validate
bun run e2e:browser
```

Expected: repository validation and the pre-existing end-to-end browser flow pass on the same commit. A focused green run does not waive these gates.

- [ ] **Step 6: Run an independent critical-only review**

The reviewer checks the diff against both critical IDs and the locked interfaces, then answers all of these with file/test evidence:

1. Can any 2/10/45-second valid turn produce a text frame above 64 KiB?
2. Can any duplicate/gap/out-of-order/mismatched chunk mutate the accepted buffer?
3. Can backpressure, close, cancellation, or component disposal drop bytes or create a phantom provider turn?
4. Can any capture callback reset 44.1/48 kHz resampler phase?
5. Can either live or synthetic scheduling persist/display a June 2026 literal or calculate from a fixed status table?
6. Is the selected D-01 authority the only active writer/calculator, and is its exam rule exactly the recorded one?
7. Did the shared fixture come from an independent oracle rather than the implementation under test?

Any unanswered or negative item reopens its owning task. Criticals cannot be deferred to a downstream plan.

- [ ] **Step 7: Commit only validation-driven corrections**

If review required changes, rerun Steps 1-5 and commit a focused correction. If no files changed, do not create an empty commit.

---

### Task 10: Enforce first merge, then hand every temporary seam to Plans 04-13

**Files:**

- PR metadata and validation evidence only.
- No new production changes.

- [ ] **Step 1: Prove no remediation plan merged ahead of this lane**

```bash
git fetch origin review-remediation/integration
INTEGRATION_TIP=$(git rev-parse origin/review-remediation/integration)
LANE_BASE_SHA=$(git merge-base HEAD origin/review-remediation/integration)
git log --oneline --decorate "$LANE_BASE_SHA".."$INTEGRATION_TIP"
git diff --name-only "$LANE_BASE_SHA".."$INTEGRATION_TIP" -- \
  packages/core/src/agent-contract.ts \
  packages/core/src/agent-contract.test.ts \
  packages/core/src/scheduling.ts \
  packages/core/src/scheduling.test.ts \
  packages/core/src/review-scheduling-conformance-v1.json \
  packages/core/src/review-scheduling-conformance.test.ts \
  agent/crates/agent-domain/Cargo.toml \
  agent/crates/agent-domain/src/lib.rs \
  agent/crates/agent-domain/src/ports.rs \
  agent/crates/agent-domain/src/tool_executor.rs \
  agent/crates/agent-domain/src/review_schedule.rs \
  agent/crates/agent-domain/src/review_history.rs \
  agent/crates/agent-domain/tests/review_scheduling_conformance.rs \
  agent/crates/agent-service/src/protocol.rs \
  agent/crates/agent-service/src/ws.rs \
  agent/crates/agent-service/src/app.rs \
  agent/crates/agent-service/tests/voice_ws.rs \
  agent/crates/agent-adapters/src/cartesia_gemini/runner.rs \
  agent/crates/agent-adapters/src/synthetic.rs \
  agent/crates/data/src/lib.rs \
  agent/crates/data/src/memory.rs \
  agent/crates/data/src/postgres.rs \
  agent/crates/data/src/migrations.rs \
  agent/migrations \
  agent/fixtures/voice-protocol \
  apps/web/lib/viva-audio-capture.ts \
  apps/web/lib/viva-audio-capture.test.ts \
  apps/web/lib/viva-agent-client.ts \
  apps/web/lib/viva-agent-client.test.ts \
  apps/web/lib/use-viva-agent-session.ts \
  apps/web/lib/use-viva-agent-session.test.ts \
  apps/web/components/session/LiveSessionPage.tsx \
  apps/web/components/session/LiveSessionPage.test.tsx \
  apps/web/app/api/viva-library/\[\[...path\]\]/route.ts \
  apps/web/lib/viva-library.ts \
  apps/web/lib/viva-library.test.ts \
  apps/web/lib/viva-library-proxy.test.ts \
  scripts/e2e-browser-audio.mjs \
  scripts/fixtures/e2e-browser-audio-entry.ts \
  package.json \
  bun.lock \
  agent/Cargo.lock
```

Expected before merge: the log contains only coordinator-owned planning/decision-ledger commits, and the hotspot diff is empty. If product remediation appears, stop: the required first-remediation-merge ordering was violated and ownership must be reconciled explicitly before proceeding. Live `main` drift is incorporated only by the integration coordinator under Plan 15; this lane never rebases onto or targets `main` directly.

- [ ] **Step 2: Rebase once at the merge gate and rerun the frozen-tree checks**

```bash
git rebase origin/review-remediation/integration
git status --short
git diff --check origin/review-remediation/integration...HEAD
bun run validate
bun run e2e:browser:audio
```

Expected: clean worktree and all checks pass at the exact PR head. Record `git rev-parse HEAD` as `CRITICAL_PATH_HEAD_SHA` in the PR evidence.

- [ ] **Step 3: Merge this PR first**

Open the lane PR with base `review-remediation/integration`. Merge only after required CI, independent review, and Task 9 evidence are green on `CRITICAL_PATH_HEAD_SHA`. Immediately fetch the integration branch and record the merge commit:

```bash
gh pr view --json baseRefName,headRefOid,url --jq '{baseRefName,headRefOid,url}'
git fetch origin review-remediation/integration
CRITICAL_PATH_MERGE_SHA=$(git rev-parse origin/review-remediation/integration)
git show --no-patch --format='%H %s' "$CRITICAL_PATH_MERGE_SHA"
```

Expected: `baseRefName` is `review-remediation/integration`, `headRefOid` is the validated `CRITICAL_PATH_HEAD_SHA`, and the displayed integration-tip commit is this expedited critical-path merge. The integration coordinator records the same `CRITICAL_PATH_MERGE_SHA` in the remediation coverage ledger; the PR evidence, ledger, and fetched integration commit must match exactly. If any identity differs, do not issue the downstream handoff until the actual merge SHA is identified and validated.

- [ ] **Step 4: Publish the immutable handoff contract**

Post one handoff comment containing `CRITICAL_PATH_MERGE_SHA`, selected D-01 enum/margin/policy version, protocol version 5 constants, exact audio frame shapes, `VivaAudioSendResult`, controller method signatures, and the full Task 9 command results. The D-01 decision document becomes immutable coordinator input; a downstream plan may consume it but cannot silently amend it. Transfer every temporary/conditional path explicitly:

- **Plan 04 — scheduling behavior/contracts:** `agent/crates/agent-domain/src/tool_executor.rs`, the selected `review_schedule.rs` or `review_history.rs`, `packages/core/src/scheduling.ts`, `packages/core/src/scheduling.test.ts`, `packages/core/src/review-scheduling-conformance-v1.json`, and `packages/core/src/review-scheduling-conformance.test.ts`. Plan 04 preserves historical v1 meaning and may expand grading/recap behavior. It does not allocate, renumber, or own migrations.
- **Plan 05 — voice wire contract and canonical fixtures:** `packages/core/src/agent-contract.ts`, `packages/core/src/agent-contract.test.ts`, `agent/crates/agent-service/src/protocol.rs`, and every changed `agent/fixtures/voice-protocol/*.json`. It preserves the 64 KiB text cap, decoded chunk/turn bounds, string generation/turn identities, unconstrained-by-chunk-size monotonic sequence count, and `audio_turn_accepted` semantics.
- **Plan 06 — domain ports/exports/dependencies:** `agent/crates/agent-domain/src/ports.rs`, `agent/crates/agent-domain/src/lib.rs`, `agent/crates/agent-domain/Cargo.toml`, and `agent/crates/agent-domain/tests/review_scheduling_conformance.rs`. It consumes Plan 04's behavior types and does not recreate scheduling policy or persistence.
- **Plan 07 — adapters:** `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs` and `agent/crates/agent-adapters/src/synthetic.rs`, including their Critical tests. It may extend provider/synthetic behavior but may not restore fixed dates or create one provider turn per chunk.
- **Plan 08 — Rust service/admission:** `agent/crates/agent-service/src/ws.rs`, `agent/crates/agent-service/tests/voice_ws.rs`, and Branch B's conditional `agent/crates/agent-service/src/app.rs`. It consumes Plan 05 frames and Plan 06 ports; it may not fork either contract.
- **Plan 09 — persistence and migrations:** `agent/crates/data/src/lib.rs`, `agent/crates/data/src/memory.rs`, `agent/crates/data/src/postgres.rs`, `agent/crates/data/src/migrations.rs`, and the selected initial `agent/migrations/0015_review_schedule_decisions_v1.sql` or `agent/migrations/0015_review_history_events_v1.sql`. Plan 09 is the sole post-Critical migration-number allocator and sole migration owner; Plan 04 owns scheduling behavior/contracts, not migrations.
- **Plan 10 — browser session/audio/UI:** `apps/web/lib/viva-audio-capture.ts` and test, `apps/web/lib/viva-agent-client.ts` and test, `apps/web/lib/use-viva-agent-session.ts` and test, and `apps/web/components/session/LiveSessionPage.tsx` and test. It may add reconnect, cross-generation replay/idempotency, and anti-alias quality, but must extend—not redefine—the retained ledger, discriminated send results, stateful resampler counts, or v5 frames.
- **Plan 11 — authenticated BFF seam:** Branch B's conditional `apps/web/app/api/viva-library/[[...path]]/route.ts` and `apps/web/lib/viva-library-proxy.test.ts`. It preserves core-only read-time scheduling and must not expose raw review history to the browser.
- **Plan 12 — root scripts/manifests/locks:** `scripts/e2e-browser-audio.mjs`, `scripts/fixtures/e2e-browser-audio-entry.ts`, the two Critical audio script entries in root `package.json` (`e2e:browser:audio`, `e2e:browser:audio:negative`), `bun.lock` if the Critical changed it, and `agent/Cargo.lock`. It preserves both the oversized negative control and the production-module browser-to-real-WS 2/10/45-second proof.
- **Plan 13 — library/UI projection:** Branch B's conditional `apps/web/lib/viva-library.ts` and `apps/web/lib/viva-library.test.ts`. It consumes the authenticated projection returned through Plan 11 and never reruns FSRS in the browser.

For the unselected D-01 branch, conditional paths are recorded as `not created`; their named recipient still performs the Critical-SHA rebase and acknowledges that no file handoff exists. No temporary file remains ownerless after this comment.

- [ ] **Step 5: Require Plans 04-13 to rebase at the recorded Critical SHA and regression-test before edits**

Every Plan 04/05/06/07/08/09/10/11/12/13 owner receives the exact `CRITICAL_PATH_MERGE_SHA` from Step 4 and runs this against `review-remediation/integration`; no downstream handoff rebases or targets `main`:

```bash
: "${CRITICAL_PATH_MERGE_SHA:?set the exact SHA from the immutable Plan 03 handoff}"
git fetch origin review-remediation/integration
git cat-file -e "${CRITICAL_PATH_MERGE_SHA}^{commit}"
test "$(git merge-base "$CRITICAL_PATH_MERGE_SHA" origin/review-remediation/integration)" = "$CRITICAL_PATH_MERGE_SHA"
git rebase "$CRITICAL_PATH_MERGE_SHA"
test "$(git merge-base HEAD "$CRITICAL_PATH_MERGE_SHA")" = "$CRITICAL_PATH_MERGE_SHA"
```

Each owner records its post-rebase head and runs its minimum handoff block before modifying an owned seam:

```bash
# Plan 04 — scheduling behavior/contracts and literal shared fixture
bun test packages/core/src/review-scheduling-conformance.test.ts packages/core/src/scheduling.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-domain --test review_scheduling_conformance -- --nocapture

# Plan 05 — TS/Rust v5 contract and canonical voice fixtures
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture

# Plan 06 — domain ports, exports, dependency, and conformance integration
cargo test --manifest-path agent/Cargo.toml -p agent-domain -- --nocapture

# Plan 07 — adapter cardinality and synthetic scheduling parity
cargo test --manifest-path agent/Cargo.toml -p agent-adapters -- --nocapture

# Plan 08 — Rust WebSocket admission; Branch B also runs its library projection test
cargo test --manifest-path agent/Cargo.toml -p agent-service audio_assembler -- --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws streamed_audio_turns -- --nocapture
if rg -q '^Selected authority: `EVENTS_PLUS_READ_TIME_PROJECTION`$' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md; then
  cargo test --manifest-path agent/Cargo.toml -p agent-service library_snapshot_review_history -- --nocapture
fi

# Plan 09 — selected memory/Postgres/migration v1 seam
cargo test --manifest-path agent/Cargo.toml -p data review_ -- --nocapture

# Plan 10 — browser capture/controller/hook/mounted-page seam
bun test apps/web/lib/viva-audio-capture.test.ts apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.test.ts apps/web/components/session/LiveSessionPage.test.tsx

# Plan 11 — Branch B authenticated BFF projection only
if rg -q '^Selected authority: `EVENTS_PLUS_READ_TIME_PROJECTION`$' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md; then
  bun test apps/web/lib/viva-library-proxy.test.ts
fi

# Plan 12 — root script/manifest/lock and real browser-to-Rust proof
bun run e2e:browser:audio:negative
bun run e2e:browser:audio

# Plan 13 — Branch B library/UI projection consumer only
if rg -q '^Selected authority: `EVENTS_PLUS_READ_TIME_PROJECTION`$' docs/decisions/2026-08-23-d-01-review-scheduling-authority.md; then
  bun test apps/web/lib/viva-library.test.ts
fi
```

Expected: every recipient rebases at the recorded Critical commit, proves that commit remains an ancestor of `review-remediation/integration`, records its new exact head, and passes its block before edits. A downstream branch that cannot rebase cleanly returns the conflict to the integration coordinator; it does not recreate the old interface or bypass the recorded SHA.

---

## Definition of done

- [ ] D-01 and its exam-margin sub-decision are recorded before scheduling implementation.
- [ ] Exactly one D-01 branch exists in the merged tree.
- [ ] Protocol v5 is shared by TypeScript, Rust, and canonical fixtures.
- [ ] The text-frame cap remains exactly 64 KiB; the solution never raises it.
- [ ] Every audio chunk is at most 4,096 samples/8,192 bytes and every turn is at most 1,080,000 samples/2,160,000 bytes.
- [ ] Sequence, generation, turn identity, explicit end, cancellation, and one-provider-turn invariants are fail-closed.
- [ ] Browser backpressure returns `sent | pending | socket_closed`, retains the bounded ledger through acceptance/close, and never reorders end ahead of chunks.
- [ ] 44.1 and 48 kHz callback streams are phase-continuous and have exact 24 kHz counts for 2/10/45 seconds.
- [ ] A production-shaped browser-to-real-WebSocket test proves 2/10/45-second turns and retains oversized single-chunk rejection as a negative control.
- [ ] Both live tool execution and synthetic execution use injected time and the selected authoritative scheduling path.
- [ ] No production fixed June 2026 date or fixed status interval helper remains.
- [ ] The selected path passes one independently derived literal conformance fixture in Rust and TypeScript.
- [ ] Once the selected D-01 margin is applied, no future-exam review is displayed after that exam.
- [ ] Focused tests, mutation/negative controls, fixture replay, `bun run validate`, and existing/new browser E2E pass on one exact PR head.
- [ ] This lane merges first into `review-remediation/integration`; Plans 04/05/06/07/08/09/10/11/12/13 rebase at its recorded merge SHA, accept every explicit file handoff, and pass their regression blocks before changing overlapping files. Under the coordinator-authorized D-01 split in Task 0, PR `03-audio` is the first merge and transfers the audio seams at its recorded SHA, and PR `03-scheduling` merges before any scheduling hotspot transfers to Plans 04/06/09.
