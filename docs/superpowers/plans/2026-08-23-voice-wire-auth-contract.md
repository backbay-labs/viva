# Plan 05 — Voice v5 Wire, Authentication, and Differential Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute this plan task-by-task. Also use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before handoff. Track every step with the checkbox syntax below. Stop at the D-07 checkpoint before any auth-fixture work; D-07-independent tasks may proceed. The worker is not authorized to choose an authentication branch.

**Goal:** Publish one strict, redaction-safe protocol-v5 contract for the Rust service and TypeScript clients, including the authenticated first frame, context-only mid-session refresh, typed turn intents, explicit terminality, deterministic version negotiation, shared fake session-token vectors, and exhaustive cross-language fixtures.

**Architecture:** Plan 03 first lands the bounded v5 audio slice. This plan then becomes the exclusive owner of `agent-service/src/protocol.rs`, `packages/core/src/agent-contract.ts`, their direct tests, and all voice-protocol fixtures. Rust and TypeScript parse the same versioned JSON strings and return the same stable diagnostic codes without copying input values into errors. The initial frame binds a signed access token and client generation to the session. Token renewal always opens a new WebSocket generation; an in-socket `session_refresh` can update only non-authoritative study context. Plan 08 consumes the contract for Rust admission, Plan 10 consumes it for the browser controller, and Plan 11 consumes the token vectors and D-07 result for Node refresh.

**Tech Stack:** Rust, serde/serde_json, TypeScript, Bun test, HMAC-SHA256, canonical unpadded base64url, existing Cargo/Turbo validation.

**Spec:** `docs/superpowers/reviews/2026-08-23-web-ui.md`, `docs/superpowers/reviews/2026-08-23-web-session-client.md`, `docs/superpowers/reviews/2026-08-23-rust-agent-service.md`, `docs/superpowers/reviews/2026-08-23-packages-shared.md`, `docs/superpowers/reviews/2026-08-23-architecture-consistency.md`, `docs/superpowers/reviews/2026-08-23-security-review.md`, `docs/superpowers/reviews/2026-08-23-correctness-review.md`, `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`, and `docs/superpowers/reviews/index.md`.

---

## Global Constraints: Scope, Order, and Non-Negotiable Ownership

### Required predecessor

Plan 03 is `docs/superpowers/plans/2026-08-23-expedited-critical-path.md`. It must be complete and committed before this plan edits contract code. Its handoff is exact:

- protocol version `5`;
- JSON `audio_chunk` frames with `client_generation_id`, `turn_id`, monotonically increasing `sequence`, and base64 PCM16;
- JSON `audio_end` frames with the same generation/turn identity and `final_sequence`;
- 24,000 Hz, mono, signed 16-bit little-endian PCM;
- at most 4,096 samples / 8,192 raw bytes per chunk;
- at most 1,080,000 samples / 2,160,000 raw bytes / 45 seconds per turn;
- monotonically increasing zero-based sequence numbers, with no derived chunk-count or final-sequence ceiling beyond the per-chunk and total-turn limits;
- the existing 65,536-byte JSON text-frame cap remains;
- backpressure is consumer behavior, not a wire field.

Do not rename these fields, change the units, replace JSON chunks with binary frames, or recompute different limits. Raw binary client audio is a v4 legacy behavior and is not accepted by the v5 contract.

Tasks 1–6 depend only on Plan 03; Tasks 7–9 additionally depend on the merged Plan 06 domain event (`BrainEvent::TurnDeferred`, see Task 7 Step 0). If the coordinator needs Plan 05's contract before Plan 06 merges, submit Tasks 1–6 as a first integration PR and Tasks 7–9 as a second PR from the same lane worktree (the program's sanctioned split-node pattern), and record a program amendment request adding the solid DAG edge L06 → L05 for the second PR.

### Exclusive files after the Plan 03 handoff

This plan owns all semantic changes to:

- `agent/crates/agent-service/src/protocol.rs`
- the `protocol.rs` inline test module
- `packages/core/src/agent-contract.ts`
- `packages/core/src/agent-contract.test.ts`
- `agent/fixtures/voice-protocol/**`
- `agent/fixtures/session-token/v1/vectors.json`

`agent/crates/agent-service/src/lib.rs` receives only the mechanical removal of the dead `ReadyFrame` re-export in this plan. Plan 08 must start from that commit and must not recreate the type.

Plans 07, 08, and 10 may consume the versioned fixtures but must not edit them. Plan 11 may consume `agent/fixtures/session-token/v1/vectors.json` but must not edit it. Any missing case is returned to this plan as a fixture amendment before consumer code proceeds.

Plan 04 exclusively owns `packages/core/src/learner-loop-contract.ts`, including removal of the redundant `durability_degraded` union/validator entry and the behavioral implementation of `validateLearnerLoopContract(value: unknown)`. This plan does not edit, stage, or claim that learner-loop change.

### Requirement namespace

All acceptance cases, diagnostics, fixture ids, and handoff references use `VOICE-*`. Do not introduce BAC ids or anonymous “case 1” labels inside this contract.

---

## Contract decisions already fixed

### VOICE-VERSION-001 — Protocol v5 only

- `VIVA_VOICE_PROTOCOL_VERSION` is `5`.
- `VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS` is exactly `[5]` in both languages.
- A ready frame advertises `{ "preferred_version": 5, "supported_versions": [5] }`.
- Negotiation selects the greatest shared version. With this release that can only be v5.
- No overlap returns `VOICE_PROTOCOL_UNSUPPORTED_VERSION`.
- Legacy v4 input is rejected. It is not silently upgraded, parsed permissively, or emitted.
- Existing unversioned/root v4 fixtures remain frozen only until consumers migrate; v5 tests and Plans 07/08/10 do not import them. This plan deletes them in Task 9 Step 6 once consumer migration is confirmed.
- Web and agent v5 changes deploy as one compatibility unit. There is no mixed v4/v5 production window.

The shared advertisement is:

```ts
export type VivaVoiceProtocolAdvertisement = {
  preferred_version: typeof VIVA_VOICE_PROTOCOL_VERSION;
  supported_versions: readonly [typeof VIVA_VOICE_PROTOCOL_VERSION];
};

export function negotiateVivaVoiceProtocolVersion(
  localSupportedVersions: readonly number[],
  peerSupportedVersions: readonly number[],
): typeof VIVA_VOICE_PROTOCOL_VERSION;
```

Rust exposes the equivalent `VoiceProtocolAdvertisement` and `negotiate_voice_protocol_version(&[u32], &[u32]) -> Result<u32, VoiceProtocolDiagnostic>`.

### VOICE-SIZE-001 — Canonical constants

Rust and TypeScript export the same constants and tests assert their derived arithmetic:

```ts
export const VIVA_VOICE_PROTOCOL_VERSION = 5;
export const VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS = [5] as const;
export const VIVA_VOICE_SAMPLE_RATE_HZ = 24_000;
export const VIVA_VOICE_CHANNELS = 1;
export const VIVA_VOICE_BYTES_PER_SAMPLE = 2;
export const VIVA_VOICE_INPUT_ENCODING = "pcm_s16le";
export const VIVA_VOICE_MAX_TEXT_FRAME_BYTES = 64 * 1024;
export const VIVA_AUDIO_MAX_CHUNK_SAMPLES = 4_096;
export const VIVA_AUDIO_MAX_CHUNK_BYTES = 8_192;
export const VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS = 10_924;
export const VIVA_VOICE_MAX_TURN_SECONDS = 45;
export const VIVA_AUDIO_MAX_TURN_SAMPLES = 1_080_000;
export const VIVA_AUDIO_MAX_TURN_BYTES = 2_160_000;
```

The 8,192-byte value is a maximum, not a fixed chunk size or minimum. A production 20 ms chunk at 24 kHz mono PCM16 contains 480 samples / 960 raw bytes, so a valid 45-second turn contains 2,250 such chunks and ends at zero-based sequence 2,249. Smaller valid chunks can produce more sequence values. Enforce monotonic sequence plus per-chunk and aggregate sample/byte/time bounds; do not infer a chunk-count cap from maximum chunk size.

Delete `VIVA_VOICE_MAX_BINARY_FRAME_BYTES` from the v5 shared surface. Plan 08 rejects raw WebSocket binary input after cutover.

### VOICE-SIZE-002 — Frame-size finding split

This plan owns the frame-size contract half of the combined size/tool-authority finding:

- remove stale v4 binary-size constants/types from `agent-contract.ts` and `protocol.rs`;
- preserve Plan 03's exact `VIVA_AUDIO_MAX_CHUNK_*` / `VIVA_AUDIO_MAX_TURN_*` public names and values, add only the derived base64-character constant, and publish their associated TypeScript/Rust types;
- make JSON-string parsing reject a UTF-8 envelope above 65,536 bytes with `VOICE_PROTOCOL_FRAME_TOO_LARGE` at `$` before nested parsing;
- make strict per-frame parsing reject decoded `frame.pcm16_base64` above 8,192 raw bytes with `VOICE_PROTOCOL_FRAME_TOO_LARGE` at `$.frame.pcm16_base64`;
- `pcm16_base64` is standard RFC 4648 base64 with padding (the 8,192-byte maximum chunk encodes to exactly 10,924 characters including padding); a payload that is not canonical padded base64 returns `VOICE_PROTOCOL_INVALID_FIELD` at `$.frame.pcm16_base64`, while `VOICE_PROTOCOL_NONCANONICAL_BASE64URL` applies only to `viva1` session-token segments;
- keep Plan 03's stateful aggregate-turn enforcement at 2,160,000 raw bytes and pin its typed `VOICE_PROTOCOL_TURN_TOO_LARGE` outcome at `$.frame.pcm16_base64` in the versioned sequence fixtures; do not duplicate that state machine in a single-frame parser;
- prove the maximum 8,192-byte audio chunk's 10,924 base64 characters plus its v5 envelope remain below the 65,536-byte text-frame cap.

Plan 10 owns browser-side enforcement before `WebSocket.send` and the client tool-authority half. This plan does not edit `viva-agent-client.ts`; Plan 10 does not duplicate or modify the constants.

### VOICE-AUTH-001 — Canonical first frame

Every v5 client frame has a required, non-empty `client_generation_id`. The first application frame must be `session_config`, and `session_token` is required at the top level. A nested token is forbidden. The Rust type must implement a custom redacted `Debug`; it must never derive a `Debug` representation that prints the token.

```ts
export type VivaSessionConfigClientFrame = {
  type: "session_config";
  version: 5;
  client_generation_id: string;
  session_token: string;
  session: AgentSessionConfig;
};
```

Canonical fixture shape, using only fake credentials:

```json
{
  "type": "session_config",
  "version": 5,
  "client_generation_id": "viva-session-bootstrap-1-fixture",
  "session_token": "viva1.eyJ1c2VyX2lkIjoiZml4dHVyZS11c2VyIiwic3R1ZHlfc2V0X2lkIjoiZml4dHVyZS1zdHVkeS1zZXQiLCJzZXNzaW9uX2lkIjoiZml4dHVyZS1zZXNzaW9uIiwiaXNzdWVkX2F0IjoxODAwMDAwMDAwLCJub3RfYmVmb3JlIjoxODAwMDAwMDAwLCJleHBpcmVzX2F0IjoxODAwMDAwOTAwLCJub25jZSI6ImZpeHR1cmUtbm9uY2UtMDAxIn0.JcnhtQUxeV1XJm0RYGo7LuL5yph5SeRaFch8-Iz8_rA",
  "session": {
    "session_id": "fixture-session",
    "user_id": "fixture-user",
    "study_set_id": "fixture-study-set",
    "mode": "quiz",
    "initial_goal": "Review the fixture source.",
    "source_context": [],
    "active_concepts": []
  }
}
```

The raw token may appear only in the outbound serialized frame and the clearly fake fixture. It must not appear in parser errors, `Debug`, close reasons, evidence, snapshots, or server frames.

The changed Rust enum fields are exact: `ClientFrame::SessionConfig { version: u32, client_generation_id: String, session_token: String, session: SessionConfig }` (the existing `agent_domain::brain::SessionConfig`), `ClientFrame::SessionRefresh { version: u32, client_generation_id: String, context: SessionRefreshContext }` where the new Rust struct `SessionRefreshContext { mode: Option<StudyMode>, initial_goal: Option<String> }` mirrors TS `AgentSessionRefreshContext`, and `ClientFrame::TurnIntent { version: u32, client_generation_id: String, turn_id: String, intent: ClientTurnIntent }` mirroring TS `VivaClientTurnIntent`. Custom validation rejects a refresh context with both fields absent. Delete the v4 `ClientFrame::Text` and `ClientFrame::ToolResult` variants; strict parsing maps `type: "tool_result"` to `VOICE_PROTOCOL_FORBIDDEN_AUTHORITY` at `$.type` and `type: "text"` to `VOICE_PROTOCOL_UNKNOWN_FRAME`. The existing Plan 03 audio/cancel/stop variants keep their Plan 03 field names and value semantics unchanged, except that `client_generation_id` becomes required and non-empty on every v5 client variant (including cancel and stop) per Task 5 Step 3. `ClientFrame` uses a manual `Debug` implementation that writes `session_token: "[REDACTED]"`; no derived/nested formatter may observe the string.

### VOICE-REFRESH-001 — Mid-session refresh is context-only

Token renewal never occurs inside an open socket. A new access token requires a new WebSocket and a new `client_generation_id`. The old generation becomes stale immediately.

The only in-socket refresh frame is:

```ts
export type AgentSessionRefreshContext = {
  mode?: AgentStudyMode;
  initial_goal?: string;
};

export type VivaSessionRefreshClientFrame = {
  type: "session_refresh";
  version: 5;
  client_generation_id: string;
  context: AgentSessionRefreshContext;
};
```

At least one context key is required. `initial_goal`, when present, is trimmed, non-empty, and at most 512 Unicode code points. The exact allowed keys are `mode` and `initial_goal`. `session_token`, `user_id`, `study_set_id`, `session_id`, `source_context`, and `active_concepts` are unknown/forbidden fields and return `VOICE_PROTOCOL_FORBIDDEN_AUTHORITY`. This replaces the overloaded mid-session `session_config` path that currently discards a token.

The canonical branch-neutral refresh fixture is:

```json
{
  "type": "session_refresh",
  "version": 5,
  "client_generation_id": "viva-session-bootstrap-1-fixture",
  "context": {
    "mode": "quiz",
    "initial_goal": "Review the fixture source."
  }
}
```

This wire schema is deliberately neutral on Plan 04's D-03 decision. Parsing a well-formed `session_refresh` does not authorize or apply it. Plan 08 owns the policy step and must implement the already-selected Plan 04 branch exactly:

- **D-03A:** accept a parsed refresh only when its requested mode/goal values are claim-bound and exactly authorized for the active session. A value outside those exact authorized claims makes no state change and emits the recoverable structured policy error below.
- **D-03B:** reject every parsed `session_refresh` context change, make no state change, and emit the same recoverable structured policy error. Do not remove the branch-neutral frame from the v5 parser and do not reinterpret it as token renewal.

```json
{
  "type": "event",
  "version": 5,
  "event": {
    "type": "structured_error",
    "source": "agent-service",
    "code": "VOICE_SESSION_REFRESH_POLICY_DENIED",
    "message": "Session refresh is not authorized.",
    "terminality": "recoverable"
  }
}
```

The policy error does not close the socket or alter the active context. In both D-03 branches, token or identity renewal always replaces the socket and uses a new `client_generation_id`. This plan does not select or modify D-03.

### VOICE-AUTHORITY-001 — Browser-authorized client union

`VivaBrowserClientFrame` is the sole exported browser-sendable v5 union. It contains only `session_config`, `session_refresh`, `audio_chunk`, `audio_end`, `turn_intent`, `cancel`, and `stop`. `VivaClientFrame` is a temporary type alias to `VivaBrowserClientFrame` for migration, not a wider union.

Cancellation/stop retain Plan 03's meaning while becoming generation-bound:

```ts
export type VivaCancelClientFrame = {
  type: "cancel";
  version: 5;
  client_generation_id: string;
  turn_id?: string;
};

export type VivaStopClientFrame = {
  type: "stop";
  version: 5;
  client_generation_id: string;
};
```

When `turn_id` is present, cancel is scoped to that active audio/provider turn. When absent, it preserves Plan 03's current-generation provider-response cancellation. It can never cancel a different generation, and unknown cancellation keys reject.

Remove the dead browser-facing `AgentToolProposal` and `AgentToolResult` exports from `agent-contract.ts`. A `tool_result` object is never a `VivaBrowserClientFrame`; strict parsing rejects it with `VOICE_PROTOCOL_FORBIDDEN_AUTHORITY` at `$.type`. Plan 10 types its send boundary as `sendFrame(frame: VivaBrowserClientFrame)` and proves no controller API or captured outgoing frame can contain `type: "tool_result"`.

### VOICE-TURN-001 — Typed text and citation intent

There is no v5 plain `text` frame and no magic `"(challenge citation)"` payload. Text answers and citation challenges share a strict turn-intent envelope:

```ts
export type VivaClientTurnIntent =
  | { kind: "answer_text"; text: string }
  | { kind: "citation_challenge"; response_id: string; source_id: string };

export type VivaTurnIntentClientFrame = {
  type: "turn_intent";
  version: 5;
  client_generation_id: string;
  turn_id: string;
  intent: VivaClientTurnIntent;
};
```

`citation_challenge` is not an answer, cannot emit `answer_evaluated`, and cannot write mastery/review state. Plans 07 and 08 route it to the correction/challenge path. The ids are non-empty, at most 128 characters, and match `^[A-Za-z0-9][A-Za-z0-9._:-]*$`.

`question_started` adds required `turn_id`. The two-turn fixtures use `turn-1` / `response-1` and `turn-2` / `response-2`; reuse across turns is invalid.

### VOICE-TURN-002 — Deferred turns

An answer that cannot be evaluated emits no fabricated grade. Only a durably persisted Plan 04 `TurnResolution::Deferred` may produce this event. Plan 06 publishes the exact domain `BrainEvent::TurnDeferred { response_id, question_id, reason, can_retry_same_question }`. This plan owns the protocol mapping and adds the active wire `turn_id` through an explicit protocol constructor while copying every domain field losslessly:

```ts
export type VivaTurnDeferredEvent = {
  type: "turn_deferred";
  turn_id: string;
  response_id: string;
  question_id: string;
  reason:
    | "empty_answer"
    | "transcript_uncertain"
    | "evaluator_unavailable"
    | "invalid_evaluator_output"
    | "insufficient_semantic_evidence"
    | "contradictory_evidence";
  can_retry_same_question: boolean;
};
```

Canonical nonterminal fixture event:

```json
{
  "type": "event",
  "version": 5,
  "event": {
    "type": "turn_deferred",
    "turn_id": "turn-2",
    "response_id": "response-2",
    "question_id": "question-2",
    "reason": "evaluator_unavailable",
    "can_retry_same_question": true
  }
}
```

The six strings are the complete snake_case wire mirror of Plan 04 `EvaluationDeferralReason`; do not add adapter/provider reasons. `response_id`, `question_id`, `reason`, and `can_retry_same_question` must exactly match the persisted Deferred outcome. `turn_id` must match the active v5 turn binding. The event carries no provider message, feedback, confidence, concept status, schedule, mastery, `retryable`, or `terminal_reason` field.

Rust exposes `ServerFrame::turn_deferred(turn_id: &str, event: &BrainEvent) -> Result<ServerFrame, VoiceProtocolDiagnostic>`. It accepts only `BrainEvent::TurnDeferred`, validates the active turn id, and constructs the exact v5 event. Plan 08 calls this owner-provided constructor while updating WebSocket turn accounting; it does not edit or redeclare the mapping in `protocol.rs`.

For the same turn this event is mutually exclusive with `answer_evaluated`, `concept_status`, review writes, and a normal graded recap. A deferred event is not intrinsically terminal and does not close the socket or synthesize a terminal session phase. Any later terminal event must arise independently from its own durable/provider/session condition. The client uses `can_retry_same_question` as the authoritative retry affordance; it must not derive retryability from the reason string.

### VOICE-TERMINAL-001 — Partial recap terminality

`recap_ready` is a discriminated union, not an optional field whose meaning consumers guess:

```ts
export type VivaRecapReadyEvent =
  | {
      type: "recap_ready";
      response_id: string;
      recap: AgentStudySessionRecap;
      partial: false;
    }
  | {
      type: "recap_ready";
      response_id: string;
      recap: AgentStudySessionRecap;
      partial: true;
      partial_reason: AgentTerminalSessionReason;
    };
```

`partial: true` is terminal immediately. A following terminal `session_phase` must repeat the same reason, but a client remains correct if transport loss drops that trailing frame. `partial: false` must not include `partial_reason`.

### VOICE-TERMINAL-002 — Structured-error terminality

```ts
export type VivaStructuredErrorEvent =
  | {
      type: "structured_error";
      source: string;
      code: string;
      message: string;
      terminality: "recoverable";
    }
  | {
      type: "structured_error";
      source: string;
      code: string;
      message: string;
      terminality: "terminal";
      terminal_reason: AgentTerminalSessionReason;
    };
```

A recoverable structured error never changes socket status or submission availability. A terminal structured error changes terminal state immediately and must be followed, when transport permits, by the same terminal reason. `terminal_reason` is forbidden on recoverable errors and required on terminal errors. The telemetry-suppressed fixture is recoverable. Provider failures that terminate remain terminal outcomes; do not relabel them recoverable to preserve a socket.

### VOICE-READY-001 — One ready representation

Delete the standalone Rust `ReadyFrame` struct, its `new`/`Default` implementations, and its `lib.rs` re-export. `ServerFrame::Ready` and TypeScript `VivaReadyFrame` are the only representations. Ready includes the protocol advertisement:

```json
{
  "type": "ready",
  "version": 5,
  "protocol": {
    "preferred_version": 5,
    "supported_versions": [5]
  },
  "sample_rate_hz": 24000,
  "input_encoding": "pcm_s16le",
  "brain": {
    "provider": "synthetic",
    "configured": true,
    "selectable": true,
    "live_runtime": false
  },
  "store": {
    "backend": "in_memory",
    "available": true,
    "durable": false,
    "nonce_replay_protection": true,
    "raw_audio_persistence": false,
    "transcript_persistence": false,
    "uuid_schema_translation": true
  }
}
```

---

## Stable diagnostics and transport classification

### VOICE-DIAGNOSTIC-001 — Parser error API

Both languages expose a structured diagnostic containing code and path only. Never include the rejected value or raw JSON.

```ts
export const VIVA_VOICE_DIAGNOSTIC_CODES = [
  "VOICE_PROTOCOL_UNSUPPORTED_VERSION",
  "VOICE_PROTOCOL_MALFORMED_JSON",
  "VOICE_PROTOCOL_INVALID_ENVELOPE",
  "VOICE_PROTOCOL_UNKNOWN_FRAME",
  "VOICE_PROTOCOL_UNKNOWN_FIELD",
  "VOICE_PROTOCOL_MISSING_FIELD",
  "VOICE_PROTOCOL_INVALID_FIELD",
  "VOICE_PROTOCOL_NONCANONICAL_BASE64URL",
  "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",
  "VOICE_PROTOCOL_FRAME_TOO_LARGE",
  "VOICE_PROTOCOL_AUDIO_SEQUENCE",
  "VOICE_PROTOCOL_TURN_TOO_LARGE",
  "VOICE_PROTOCOL_INVARIANT",
] as const;

export class VivaVoiceProtocolError extends Error {
  readonly code: VivaVoiceDiagnosticCode;
  readonly path: string;
}

export function parseVivaServerFrame(value: unknown): VivaServerFrame;
export function parseVivaClientFrame(value: unknown): VivaBrowserClientFrame;
export function parseVivaClientFrameJson(json: string): VivaBrowserClientFrame;
export function parseVivaServerFrameJson(json: string): VivaServerFrame;
```

Rust exposes `VoiceProtocolDiagnostic { code: VoiceProtocolDiagnosticCode, path: String }` and `parse_client_frame_json` / `parse_server_frame_json`. Its custom `Debug` prints only the code/path.

All envelope/event/frame types reject unknown keys. TypeScript reconstructs every accepted object field-by-field; it does not return `value as VivaServerEvent`. Rust uses `deny_unknown_fields` wire DTOs or an equivalent explicit allowlist before conversion to domain types. Unknown fields in nested session, audio, turn intent, ready, error, source, question, evaluation, recap, manuscript intent, and terminal objects are fixture-covered.

Malformed server error frames get field-specific diagnostics. A non-string `error.message` returns `VOICE_PROTOCOL_INVALID_FIELD` at `$.error.message`; it never falls through to “unknown frame.”

### VOICE-RUNTIME-001 — Pure-ESM runtime-validation behavior

`parseVivaServerFrame(value: unknown): VivaServerFrame` in `agent-contract.ts` is this plan's complete behavioral half of the future `@viva/core/runtime-validation` surface. It must:

- be strict at every nested object boundary;
- reconstruct and return only allowed fields rather than returning the caller's cast object;
- throw only redaction-safe `VivaVoiceProtocolError` diagnostics;
- have no Node builtin imports, environment reads, filesystem access, browser-only globals (`window`, `document`, `WebSocket`), package-root import, or fixture import;
- load as pure ESM under Bun and Node 24 once exported.

Plan 14 alone creates the pure-ESM `packages/core/src/runtime-validation.ts` aggregator and package/tsconfig export wiring. That aggregator re-exports Plan 04's `validateLearnerLoopContract(value: unknown)` and this exact `parseVivaServerFrame(value: unknown)` directly; it does not wrap, fork, or reimplement either validator and never edits/stages `agent-contract.ts` or `agent-contract.test.ts`. Plan 12 consumes `@viva/core/runtime-validation` read-only for release/runtime validation.

### VOICE-ERROR-001 — Typed server errors

```ts
export const VIVA_VOICE_SERVER_ERROR_CODES = [
  "VOICE_AUTH_EXPIRED",
  "VOICE_AUTH_INVALID",
  "VOICE_AUTH_IDENTITY_MISMATCH",
  "VOICE_AUTH_REPLAYED",
  "VOICE_CLIENT_FRAME_MALFORMED",
  "VOICE_CLIENT_FRAME_TOO_LARGE",
  "VOICE_CLIENT_TURN_TOO_LARGE",
  "VOICE_CLIENT_AUTHORITY_FORBIDDEN",
  "VOICE_INTERNAL_SERIALIZATION",
] as const;

export type VivaServerError = {
  code: VivaVoiceServerErrorCode;
  message: string;
  retryable: boolean;
};

export type VivaErrorFrame = {
  type: "error";
  version: 5;
  error: VivaServerError;
};
```

The parser verifies retryability rather than trusting it:

- `VOICE_AUTH_EXPIRED`: `true`;
- `VOICE_INTERNAL_SERIALIZATION`: `true`;
- every other listed code: `false`.

The serialization fallback uses v5 and `VOICE_INTERNAL_SERIALIZATION`. This plan publishes the v5 `VOICE_SERIALIZATION_FALLBACK_FRAME` constant (Task 7 Step 4); Plan 08 replaces the hard-coded v1 string in `ws.rs` with it.

### VOICE-TERMINATION-001 — Close classification API

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

Priority is terminal reason, typed error category, clean code 1000, then transport. Every `kind: "terminal"` has `retryable: false` because the current wire session and generation are finished; it never triggers same-session automatic reconnect. A learner-facing action may start a new session based on the typed terminal reason, but that is not this classifier's retry flag. The result contains no message or close-reason text. Plan 10 must delete regex classification over browser/parser messages.

`transport-outcomes.json` uses `schema: "viva.voice-transport-outcomes.v1"`, `protocol_version: 5`, and `{ id, input, expected }` cases whose `input` keys exactly match `classifyVivaVoiceTermination`. It contains no browser `CloseEvent.reason`. Canonical malformed-frame case:

```json
{
  "id": "VOICE-TERMINATION-PROTOCOL-MALFORMED",
  "input": {
    "error": {
      "code": "VOICE_CLIENT_FRAME_MALFORMED",
      "message": "Client frame rejected.",
      "retryable": false
    },
    "closeCode": 1008,
    "wasClean": true
  },
  "expected": {
    "kind": "protocol",
    "errorCode": "VOICE_CLIENT_FRAME_MALFORMED",
    "retryable": false,
    "closeCode": 1008
  }
}
```

The file covers every typed server error code, every terminal reason, clean code 1000, abnormal transport, and priority collisions. Hostile `message` strings do not change expected classification.

---

## D-07 TOKEN_ONLY_REFRESH — hard sponsor checkpoint

An earlier draft numbered this authentication decision “D-06”; its program ID is `D-07 TOKEN_ONLY_REFRESH`. Program decision `D-06 STATIC_EXPORT` is a separate, still-live decision that gates no task in this plan (this plan's contract surface is deployment-mode-neutral). Do not create a second auth decision under either label and do not let the implementing worker infer the answer from environment configuration.

The sponsor must return exactly one of these strings:

- `retain-token-only`
- `require-service-auth`

Before changing auth fixtures, read the coordinator decision registry row for `D-07` in `docs/superpowers/plans/2026-08-23-review-remediation-finding-coverage-ledger.md` (and the coordinator decision snapshot commit). Proceed only if the coordinator has recorded exactly `retain-token-only` or `require-service-auth`. For `require-service-auth`, additionally verify the coordinator record names the trusted replacement service owner, its frozen same-origin gateway endpoint, and its request/session-auth and deployment boundary; if any is absent, treat D-07 as unrecorded.

If D-07 is unrecorded, stop this checkpoint. Do not write `auth-decision.json`, do not implement Plan 08 admission, and do not implement Plan 11 refresh. An environment variable may only mirror the recorded registry value, never substitute for it.

### Branch A — `retain-token-only`

- Public direct WSS may omit the shared service bearer.
- The signed session access token is verified during HTTP/WebSocket pre-upgrade from the bearer subprotocol before a global slot or Ready frame is allocated.
- The exact same signed access token is required in the first `session_config`; mismatch is `VOICE_AUTH_INVALID`.
- Browser refresh uses a distinct opaque refresh credential, stored only as a one-way hash server-side.
- The refresh credential is one-time, rotates atomically, and has an absolute session lifetime. Reuse, deletion, expiry, or a losing race is terminal.
- The refresh credential is never a `viva1` access token, never enters a WebSocket frame/subprotocol, and never appears in this contract fixture.
- Plan 08 implements pre-upgrade Rust verification. Plan 11 implements the rotating Node refresh record and absolute lifetime.

Write `agent/fixtures/voice-protocol/v5/auth-decision.json` as:

```json
{
  "decision": "D-07 TOKEN_ONLY_REFRESH",
  "branch": "retain-token-only",
  "direct_browser_wss": true,
  "preupgrade_auth": "signed_session_access_token",
  "first_frame_auth": "same_signed_session_access_token",
  "refresh_mode": "rotating_one_time_hashed_credential",
  "browser_refresh_absolute_lifetime_required": true,
  "in_socket_token_refresh": false
}
```

### Branch B — `require-service-auth`

- Delete token-only public mode.
- Every non-loopback WebSocket upgrade requires shared bearer/service authentication before a slot or Ready frame is allocated.
- Direct browser-to-agent WSS is disabled; a trusted same-origin service/proxy owns the shared bearer.
- The signed first-frame session token remains required for user/study-set/session binding, but it is not sufficient for pre-upgrade access.
- Browser refresh returns no reusable refresh credential. The trusted service obtains a replacement access token through its authenticated server-to-server path and the browser reconnects with a new generation.
- Plan 08 implements required Rust service-auth admission. Plan 11 removes token-only browser refresh and implements the service-authenticated replacement path.

Write `agent/fixtures/voice-protocol/v5/auth-decision.json` as:

```json
{
  "decision": "D-07 TOKEN_ONLY_REFRESH",
  "branch": "require-service-auth",
  "direct_browser_wss": false,
  "preupgrade_auth": "shared_service_bearer",
  "first_frame_auth": "signed_session_access_token",
  "refresh_mode": "service_authenticated_replacement",
  "browser_refresh_absolute_lifetime_required": false,
  "in_socket_token_refresh": false
}
```

### Invariants common to both branches

- Access-token renewal closes/replaces the socket and changes generation id.
- `session_refresh` cannot carry credentials or identity.
- A signed session token is still single-use at session admission.
- Authentication errors expose only typed coarse codes, never token/claims/signature text.
- Consumer plans read `auth-decision.json`; they do not re-decide D-07.

---

## Versioned fixture corpus

### VOICE-FIXTURE-001 — Manifest

Create these exact files:

- `agent/fixtures/voice-protocol/v5/manifest.json`
- `agent/fixtures/voice-protocol/v5/auth-decision.json`
- `agent/fixtures/voice-protocol/v5/client-session-config-signed.json`
- `agent/fixtures/voice-protocol/v5/client-session-refresh.json`
- `agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json`
- `agent/fixtures/voice-protocol/v5/turn-intents.json`
- `agent/fixtures/voice-protocol/v5/turn-outcomes.json`
- `agent/fixtures/voice-protocol/v5/server-ready.json`
- `agent/fixtures/voice-protocol/v5/terminal-sequences.json`
- `agent/fixtures/voice-protocol/v5/transport-outcomes.json`
- `agent/fixtures/voice-protocol/v5/synthetic-two-turn-session.json`
- `agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json`
- `agent/fixtures/voice-protocol/v5/client-differential-cases.json`
- `agent/fixtures/voice-protocol/v5/server-differential-cases.json`
- `agent/fixtures/session-token/v1/vectors.json`

`manifest.json` has `schema: "viva.voice-fixtures.manifest.v1"`, `protocol_version: 5`, `supported_versions: [5]`, `legacy_v4_disposition: "reject"`, and the following exact `fixtures` rows:

| id | path | kind |
|---|---|---|
| `VOICE-FIXTURE-MANIFEST` | `agent/fixtures/voice-protocol/v5/manifest.json` | `manifest` |
| `VOICE-AUTH-DECISION` | `agent/fixtures/voice-protocol/v5/auth-decision.json` | `auth_decision` |
| `VOICE-CLIENT-SESSION-CONFIG-SIGNED` | `agent/fixtures/voice-protocol/v5/client-session-config-signed.json` | `client_frame` |
| `VOICE-CLIENT-SESSION-REFRESH` | `agent/fixtures/voice-protocol/v5/client-session-refresh.json` | `client_frame` |
| `VOICE-AUDIO-TURN-LIFECYCLE` | `agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json` | `frame_sequence` |
| `VOICE-CLIENT-TURN-INTENTS` | `agent/fixtures/voice-protocol/v5/turn-intents.json` | `client_frame_cases` |
| `VOICE-SERVER-TURN-OUTCOMES` | `agent/fixtures/voice-protocol/v5/turn-outcomes.json` | `server_event_cases` |
| `VOICE-SERVER-READY` | `agent/fixtures/voice-protocol/v5/server-ready.json` | `server_frame` |
| `VOICE-TERMINAL-SEQUENCES` | `agent/fixtures/voice-protocol/v5/terminal-sequences.json` | `frame_sequence` |
| `VOICE-TRANSPORT-OUTCOMES` | `agent/fixtures/voice-protocol/v5/transport-outcomes.json` | `transport_cases` |
| `VOICE-SYNTHETIC-TWO-TURN-SESSION` | `agent/fixtures/voice-protocol/v5/synthetic-two-turn-session.json` | `session_sequence` |
| `VOICE-FAKE-CARTESIA-GEMINI-TWO-TURN-SESSION` | `agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json` | `session_sequence` |
| `VOICE-CLIENT-DIFFERENTIAL-CASES` | `agent/fixtures/voice-protocol/v5/client-differential-cases.json` | `differential_cases` |
| `VOICE-SERVER-DIFFERENTIAL-CASES` | `agent/fixtures/voice-protocol/v5/server-differential-cases.json` | `differential_cases` |
| `VOICE-TOKEN-V1-VECTORS` | `agent/fixtures/session-token/v1/vectors.json` | `token_vectors` |

No other row/id/kind is permitted without a Plan 05 fixture amendment. Tests fail on an unlisted JSON file, a missing file, a duplicate id/path, a row mismatch, a non-v5 applicable envelope, or a v4 consumer path.

### VOICE-TOKEN-001 — Shared session-token vectors

`agent/fixtures/session-token/v1/vectors.json` uses exactly:

```ts
type SessionTokenVectorFile = {
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

The fake secret is the 32 bytes `0x00` through `0x1f`, encoded as:

```json
"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
```

Canonical claim order and names are `user_id`, `study_set_id`, `session_id`, `issued_at`, `not_before`, `expires_at`, `nonce`, then optional `failure_control`. `failure_control`, when present, is an exact object ordered as `scenario`, `run_id`, `expires_at`, `nonce`, `signature`; it rejects unknown keys. `scenario` is exactly one of `provider_rate_limited`, `provider_auth_failed`, `provider_timeout`, `silent_stall`, `provider_malformed_stream`, `provider_network_disconnect`, `sonic_tts_timeout`, `recap_timeout`, `invalid_token`, `expired_token`, `replayed_token`, `malformed_token`, `slow_stale_socket_close`, `double_submit_race`, `mic_denied`, or `typed_fallback`. HMAC input is the UTF-8 bytes of `viva1.` plus the unpadded base64url claims segment. Signatures are HMAC-SHA256 encoded as unpadded base64url. Verification uses `not_before <= clock_unix_seconds < expires_at`; there is no hidden skew in the vector runner. `issued_at <= not_before < expires_at` is required. The v1 file pins the runner clock to `clock_unix_seconds: 1800000300`, inside the canonical fixture-token window `[1800000000, 1800000900)`.

The v1 file contains this exact required case-id set; adding or removing a case requires a Plan 05 vector amendment so Rust and Node cannot drift independently:

- `VOICE-TOKEN-VALID-CANONICAL`
- `VOICE-TOKEN-VALID-FAILURE-CONTROL`
- `VOICE-TOKEN-REJECT-SEGMENT-SHAPE` (a `viva1`-prefixed two-segment token; `claims: null`)
- `VOICE-TOKEN-REJECT-WRONG-PREFIX` (a `viva2.`-prefixed three-segment token; `claims: null`)
- `VOICE-TOKEN-REJECT-PADDED-CLAIMS`
- `VOICE-TOKEN-REJECT-PADDED-SIGNATURE`
- `VOICE-TOKEN-REJECT-NONCANONICAL-BASE64URL`
- `VOICE-TOKEN-REJECT-UNKNOWN-CLAIM`
- `VOICE-TOKEN-REJECT-UNKNOWN-FAILURE-CONTROL-CLAIM`
- `VOICE-TOKEN-REJECT-BAD-HMAC`
- `VOICE-TOKEN-REJECT-MALFORMED-JSON`
- `VOICE-TOKEN-REJECT-DUPLICATE-JSON-KEY`
- `VOICE-TOKEN-REJECT-NOT-BEFORE`
- `VOICE-TOKEN-REJECT-EXPIRES-AT`
- `VOICE-TOKEN-REJECT-ISSUED-ORDER`
- `VOICE-TOKEN-REJECT-USER-BINDING`
- `VOICE-TOKEN-REJECT-STUDY-SET-BINDING`
- `VOICE-TOKEN-REJECT-SESSION-BINDING`
- `VOICE-TOKEN-REJECT-EMPTY-NONCE`

Rejection strings are closed: `malformed_shape`, `noncanonical_base64url`, `unknown_claim`, `invalid_signature`, `malformed_json`, `duplicate_claim`, `not_yet_valid`, `expired`, `invalid_time_order`, `binding_mismatch`, or `missing_claim`. All binding cases verify against the canonical expected binding `fixture-user` / `fixture-study-set` / `fixture-session`.

Rust and Node use the same rejection precedence: validate the three-segment `viva1` shape (a segment-count or prefix violation is `malformed_shape`) and canonical unpadded base64url; decode the signature and compare the 32-byte HMAC in constant time; decode/parse claims while detecting duplicate keys; enforce the exact key/type/non-empty schema; enforce time ordering/current clock; then enforce user/study-set/session bindings. A case crafted to reach a later stage therefore carries a valid independent HMAC for its malformed/unauthorized claims bytes.

Plan 08 makes Rust `SessionTokenClaims` pass every vector. Plan 11 makes Node verification pass the same file. Neither side may mint its expected token with the implementation under test.

### VOICE-DIFFERENTIAL-001 — Cross-language case format

Both differential files use JSON strings so malformed JSON is testable:

```json
{
  "schema": "viva.voice-differential-cases.v1",
  "protocol_version": 5,
  "cases": [
    {
      "id": "VOICE-CLIENT-REJECT-V4",
      "wire_json": "{\"type\":\"stop\",\"version\":4,\"client_generation_id\":\"generation-1\"}",
      "valid": false,
      "diagnostic_code": "VOICE_PROTOCOL_UNSUPPORTED_VERSION",
      "path": "$.version"
    }
  ]
}
```

Every frame/event variant has at least one valid case and these per-frame invalid families: malformed JSON, non-object, unknown frame/event, v4, future version, missing required field, wrong type, empty/bad id, every unknown key position, forbidden authority, malformed error message, noncanonical token shape, a chunk over 8,192 decoded bytes, a non-canonical padded-base64 `pcm16_base64` payload, unknown deferral reason, deferred events containing `retryable`/`terminal_reason`/learner-fact fields, inconsistent partial recap reason, and inconsistent structured-error terminality. Stateful duplicate/gap/reorder/end-mismatch and aggregate-turn-over-2,160,000 cases live in `audio-turn-lifecycle.json`, not a single-frame parser file. A valid `session_refresh` case proves protocol acceptance independent of D-03 policy; `terminal-sequences.json` separately pins `VOICE_SESSION_REFRESH_POLICY_DENIED` as recoverable.

The differential corpus includes these exact authority/size cases:

| case id | expected code | expected path |
|---|---|---|
| `VOICE-CLIENT-REJECT-FORGED-TOOL-RESULT` | `VOICE_PROTOCOL_FORBIDDEN_AUTHORITY` | `$.type` |
| `VOICE-CLIENT-REJECT-TEXT-FRAME-65537` | `VOICE_PROTOCOL_FRAME_TOO_LARGE` | `$` |
| `VOICE-CLIENT-REJECT-AUDIO-CHUNK-8193` | `VOICE_PROTOCOL_FRAME_TOO_LARGE` | `$.frame.pcm16_base64` |
| `VOICE-CLIENT-REJECT-TURN-2160002` | `VOICE_PROTOCOL_TURN_TOO_LARGE` | `$.frame.pcm16_base64` |

The last row is a named sequence case in `audio-turn-lifecycle.json`; the other three are `client-differential-cases.json` rows. The aggregate fixture uses even-byte PCM and exceeds the turn limit by exactly two raw bytes.

`audio-turn-lifecycle.json` uses `schema: "viva.voice-audio-sequence-cases.v1"`, `protocol_version: 5`, and cases with `wire_sequence_json: string[]`, `valid: boolean`, `diagnostic_code: VivaVoiceDiagnosticCode | null`, and `path: string | null`. A concrete duplicate-sequence case is:

```json
{
  "id": "VOICE-CLIENT-REJECT-AUDIO-SEQUENCE-DUPLICATE",
  "wire_sequence_json": [
    "{\"type\":\"audio_chunk\",\"version\":5,\"client_generation_id\":\"generation-fixture-audio\",\"turn_id\":\"turn-fixture-audio\",\"sequence\":0,\"frame\":{\"pcm16_base64\":\"AAA=\"}}",
    "{\"type\":\"audio_chunk\",\"version\":5,\"client_generation_id\":\"generation-fixture-audio\",\"turn_id\":\"turn-fixture-audio\",\"sequence\":0,\"frame\":{\"pcm16_base64\":\"AAA=\"}}",
    "{\"type\":\"audio_end\",\"version\":5,\"client_generation_id\":\"generation-fixture-audio\",\"turn_id\":\"turn-fixture-audio\",\"final_sequence\":0}"
  ],
  "valid": false,
  "diagnostic_code": "VOICE_PROTOCOL_AUDIO_SEQUENCE",
  "path": "$.sequence"
}
```

Every sequence entry is literal canonical JSON; the fixture does not use a count-expansion mini-language or implementation helper that could differ across Rust and TypeScript.

Rust and TypeScript assert the exact `valid`, `diagnostic_code`, and `path` for every case. Neither suite filters to a handpicked subset.

The per-case `valid`/`diagnostic_code`/`path` execution requirement applies to `client-differential-cases.json` and `server-differential-cases.json` only. For `audio-turn-lifecycle.json`, Plan 05's Rust and TS tests validate the file's schema and case-id set and run every embedded `wire_sequence_json` entry through the single-frame parsers, asserting per-frame validity or the exact per-frame diagnostic (as in the oversized-chunk case); they do not replay sequences statefully. The stateful expected outcomes (duplicate/gap/reorder/end-mismatch/aggregate) are executed behaviorally by Plan 08 against Plan 03's `ws.rs` assembler per the `VOICE-AUDIO-TURN-LIFECYCLE` obligation in Task 9 Step 5, and Plan 10 consumes the same cases for browser-side pre-send expectations.

### VOICE-SESSION-001 — Multi-turn fixtures

Both two-turn session fixtures contain:

- one signed initial config with generation id;
- two distinct `question_started` events with distinct turn and response ids;
- a complete v5 audio lifecycle or typed text answer for each turn;
- no reuse of turn/response identity;
- turn-scoped evaluation/source/concept/citation/audio events;
- a typed cancellation case;
- one evaluated path with a normal recap and one durably deferred path that remains nonterminal across the corpus.

`turn-outcomes.json` includes all six deferral reasons and both boolean values of `can_retry_same_question`. Every deferred case includes `turn_id`, `response_id`, and `question_id`, and asserts the absence of `provider_message`, `feedback`, `confidence`, `status`, `schedule`, `mastery`, `retryable`, and `terminal_reason`.

`fake-cartesia-gemini-two-turn-session.json` sets `transcript_final.confidence` to explicit `null` when the fake provider has no supplied confidence. A number is valid only when provider-supplied and within `[0, 1]`; omitted confidence is rejected in strict v5. This prevents a fixture default such as `0.91` becoming product data.

---

### Task 1: Verify Plan 03 and freeze the v5 audio handoff

**Files:**
- Read: `docs/superpowers/plans/2026-08-23-expedited-critical-path.md`
- Read: `agent/crates/agent-service/src/protocol.rs`
- Read: `packages/core/src/agent-contract.ts`
- Test: `agent/crates/agent-service/src/protocol.rs`
- Test: `packages/core/src/agent-contract.test.ts`

- [ ] **Step 1: Verify the predecessor exists and is committed**

```bash
test -f docs/superpowers/plans/2026-08-23-expedited-critical-path.md
git status --short -- agent/crates/agent-service/src/protocol.rs agent/crates/agent-service/src/lib.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol agent/fixtures/session-token
git log -1 --oneline -- docs/superpowers/plans/2026-08-23-expedited-critical-path.md agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts
```

Expected: the plan exists, the Plan 03 contract changes are committed, and there are no unexplained edits in the exclusive files. If not, stop and return to Plan 03.

- [ ] **Step 2: Assert the exact handoff values**

```bash
rg -n "VIVA_VOICE_PROTOCOL_VERSION|audio_chunk|audio_end|client_generation_id|turn_id|sequence|final_sequence|4_096|8_192|1_080_000|2_160_000|45|64 \* 1024" agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts
```

Expected: v5 and every fixed field/value above are present. A discrepancy is a Plan 03 defect, not permission for this worker to invent a third audio schema.

- [ ] **Step 3: Run the inherited focused tests**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
```

Expected: PASS before this plan adds new RED cases.

### Task 2: Resolve D-07 and publish the shared token vectors

**Files:**
- Create: `agent/fixtures/voice-protocol/v5/auth-decision.json`
- Create: `agent/fixtures/session-token/v1/vectors.json`
- Modify: `packages/core/src/agent-contract.test.ts`
- Modify: `agent/crates/agent-service/src/protocol.rs` (tests only in RED step)

- [ ] **Step 1: Stop for the sponsor decision**

Apply the D-07 repository-fact gate above: read the coordinator decision registry row and, for `require-service-auth`, verify the required D-07B parameters are recorded. Do not proceed in this task while D-07 is unrecorded.

If D-07 is not yet recorded, mark Task 2 blocked and continue with Tasks 3 through 7, which are D-07-independent. Return to Task 2 before starting Task 8: `manifest.json` requires the `VOICE-AUTH-DECISION` row, so Task 8 and the final manifest cannot begin until D-07 is recorded and Task 2 is complete.

- [ ] **Step 2: Write failing decision/vector tests**

Add tests in both languages that require the exact selected `auth-decision.json` branch schema, the exact vector-file schema/case-id set, closed rejection strings, canonical fake secret, fixed clock, and expected claims/bindings. Assert every token/secret is clearly fixture-only. Manifest completeness waits until Task 8, after every listed fixture exists; do not create a partial manifest.

- [ ] **Step 3: Verify RED**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_auth_decision_and_token_vectors_are_exact -- --exact --nocapture
```

Expected: FAIL because the selected auth-decision fixture and token vectors do not exist.

- [ ] **Step 4: Create the selected decision file and complete vectors**

Use the exact schemas/cases above. Compute vector tokens independently once; check in the resulting strings. Never generate expected tokens inside the tests.

- [ ] **Step 5: Verify GREEN**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_auth_decision_and_token_vectors_are_exact -- --exact --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/fixtures/voice-protocol/v5/auth-decision.json agent/fixtures/session-token/v1/vectors.json packages/core/src/agent-contract.test.ts agent/crates/agent-service/src/protocol.rs
git commit -m "test(voice): lock v5 auth and token fixtures"
```

### Task 3: Lock version negotiation and the sole Ready type

**Files:**
- Modify: `agent/crates/agent-service/src/protocol.rs`
- Modify: `agent/crates/agent-service/src/lib.rs`
- Modify: `packages/core/src/agent-contract.ts`
- Modify: `packages/core/src/agent-contract.test.ts`
- Create: `agent/fixtures/voice-protocol/v5/server-ready.json`

- [ ] **Step 1: Write failing VOICE-VERSION-001 / VOICE-READY-001 tests**

Cover v5-only negotiation, no-overlap diagnostics, v4 rejection, strict Ready reconstruction, and absence of a second Ready representation. Assert the Plan 03 audio constants are unchanged, but leave stale-size cleanup and boundary behavior to Task 4.

- [ ] **Step 2: Verify RED**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_ready_matches_fixture -- --exact --nocapture
```

Expected: FAIL until advertisement/negotiation exists and the dead type is removed.

- [ ] **Step 3: Implement the minimal shared contract**

Add the exact advertisement/negotiation APIs. Add `protocol` to `ServerFrame::Ready`. Delete `ReadyFrame` plus its `lib.rs` re-export. Create `server-ready.json` with the exact canonical JSON above. Do not change Plan 03 audio constants or field names in this task.

- [ ] **Step 4: Verify GREEN and format**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
bunx biome check packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-service/src/protocol.rs agent/crates/agent-service/src/lib.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol/v5/server-ready.json
git commit -m "feat(voice): publish protocol v5 negotiation"
```

### Task 4: Close the frame-size contract half without forking Plan 03

**Files:**
- Modify: `agent/crates/agent-service/src/protocol.rs`
- Modify: `packages/core/src/agent-contract.ts`
- Modify: `packages/core/src/agent-contract.test.ts`

- [ ] **Step 1: Write failing VOICE-SIZE-002 boundary tests**

Assert that `VIVA_VOICE_MAX_BINARY_FRAME_BYTES` and its v4 binary-frame types are absent; the Plan 03 `VIVA_AUDIO_MAX_CHUNK_*` / `VIVA_AUDIO_MAX_TURN_*` names and values remain exact in Rust and TypeScript; the maximum raw chunk encodes to exactly 10,924 base64 characters; and its complete canonical v5 JSON frame is below 65,536 UTF-8 bytes. Add exact diagnostics for a 65,537-byte JSON envelope at `$` and an otherwise valid chunk decoding to 8,193 raw bytes at `$.frame.pcm16_base64`.

Keep count arithmetic honest with table-driven controls: accept 2,250 20 ms / 960-byte chunks ending at sequence 2,249, and accept a sequence of smaller non-empty even chunks whose final sequence exceeds 2,249 while aggregate bytes stay within 2,160,000. Reject only a duplicate/gap/reorder, per-chunk violation, or aggregate byte/sample/time violation. Do not assert a derived maximum chunk count.

- [ ] **Step 2: Verify RED**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_frame_size_contract_is_exact -- --exact --nocapture
```

Expected: FAIL while the stale binary constant/type remains and the JSON parser lacks byte-exact envelope/chunk diagnostics.

- [ ] **Step 3: Implement only the shared size surface**

Preserve Plan 03's public constant names and audio frame fields. Add the derived base64-character constant, delete only the stale v4 binary constant/types, measure JSON strings as UTF-8 before parsing, and decode `frame.pcm16_base64` only long enough to validate canonical base64 and raw byte bounds. Diagnostics contain only code/path. Do not add buffering, backpressure, reconnect, or `WebSocket.send` behavior here. Do not duplicate Plan 03's stateful Rust audio assembler; its aggregate-turn state remains the consumer of these constants.

- [ ] **Step 4: Verify GREEN and the consumer fence**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
! rg -n "VIVA_VOICE_MAX_BINARY_FRAME_BYTES|AgentBinary|BinaryFrame" agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts
! rg -n "WebSocket|bufferedAmount|sendFrame" agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts
```

Expected: both suites PASS; both scans return no stale binary surface or consumer implementation. Plan 10 imports these constants and owns pre-send enforcement plus the separate tool-authority client assertion.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts
git commit -m "feat(voice): close v5 frame size contract"
```

### Task 5: Canonicalize authenticated config, generation identity, and browser authority

**Files:**
- Modify: `agent/crates/agent-service/src/protocol.rs`
- Modify: `packages/core/src/agent-contract.ts`
- Modify: `packages/core/src/agent-contract.test.ts`
- Create: `agent/fixtures/voice-protocol/v5/client-session-config-signed.json`
- Create: `agent/fixtures/voice-protocol/v5/client-session-refresh.json`

- [ ] **Step 1: Write failing VOICE-AUTH-001 / VOICE-REFRESH-001 / VOICE-AUTHORITY-001 tests**

Require the signed canonical first frame, a generation id on every client variant, redacted Rust `Debug`, error JSON free of the fake token, protocol acceptance of a branch-neutral context-only `session_refresh`, and rejection of old mid-session `session_config` or any credential/identity field on refresh. Assert the exported browser union contains exactly the seven authorized variants; a forged `tool_result` fails with `VOICE_PROTOCOL_FORBIDDEN_AUTHORITY` at `$.type`; and `AgentToolProposal` / `AgentToolResult` are absent from the shared browser surface. Do not encode D-03A or D-03B in the parser.

- [ ] **Step 2: Verify RED**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_signed_config_and_refresh_are_strict -- --exact --nocapture
```

Expected: FAIL because Rust still lacks the canonical token field/strict refresh and cancel/stop generation parity.

- [ ] **Step 3: Implement exact wire types**

Make `client_generation_id` required for session config, audio chunk/end, turn intent, session refresh, cancel, and stop. Add the top-level token to Rust `ClientFrame::SessionConfig`; remove the need for a parallel `InitialClientFrame` in the Plan 08 consumer. Implement redacted `Debug`. Add context-only `SessionRefresh`. Export `VivaBrowserClientFrame` as the exact browser-sendable union, retain `VivaClientFrame` only as an equal alias, and remove the dead tool proposal/result exports. Create `client-session-config-signed.json` and `client-session-refresh.json` byte-for-byte from the canonical JSON examples above. Do not edit Plan 10's controller.

- [ ] **Step 4: Verify GREEN**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_signed_config_and_refresh_are_strict -- --exact --nocapture
```

Expected: PASS, including byte-exact fixture serialization.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol/v5/client-session-config-signed.json agent/fixtures/voice-protocol/v5/client-session-refresh.json
git commit -m "feat(voice): canonicalize signed browser frames"
```

### Task 6: Add strict pure-ESM parsers and exhaustive differential diagnostics

**Files:**
- Modify: `agent/crates/agent-service/src/protocol.rs`
- Modify: `packages/core/src/agent-contract.ts`
- Modify: `packages/core/src/agent-contract.test.ts`
- Create: `agent/fixtures/voice-protocol/v5/client-differential-cases.json`
- Create: `agent/fixtures/voice-protocol/v5/server-differential-cases.json`

- [ ] **Step 1: Write the complete failing VOICE-DIAGNOSTIC-001 / VOICE-RUNTIME-001 differential runners**

Each runner iterates every case with no id filters. Assert exact accept/reject, diagnostic code/path, exact valid reserialization, and absence of `viva1.`, fake claims, answer text, or raw JSON snippets from diagnostics. Directly import `parseVivaServerFrame(value: unknown)` from `./agent-contract` and prove it reconstructs nested objects, drops no allowed field, accepts no unknown field, and mutating the caller's object after parsing cannot mutate the returned frame. Add a source-purity assertion that `agent-contract.ts` imports no Node builtin, environment, filesystem, browser-only global, package root, or fixture.

- [ ] **Step 2: Verify RED**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_client_differential_cases -- --exact --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_server_differential_cases -- --exact --nocapture
```

Expected: FAIL on unknown keys, malformed-error specificity, v4 cases, and stable diagnostics.

- [ ] **Step 3: Implement strict field-by-field parsing**

Implement the exact diagnostic API. Reconstruct every TS object. Add Rust strict DTO/allowlist parsing before domain conversion. Validate canonical unpadded base64url shape without verifying HMAC in this module. Decode audio base64 only to enforce byte limits; do not store/log decoded bytes. Create both complete differential JSON files using the locked case schema/families/ids above. Keep `parseVivaServerFrame(value: unknown): VivaServerFrame` self-contained and pure ESM so Plan 14 can re-export it directly without a wrapper. `parseVivaClientFrameJson` returns `VivaBrowserClientFrame`, never a wider authority union.

- [ ] **Step 4: Mutation controls**

For every valid case, programmatically inject `"VOICE_unknown_fixture_field": true` at each object boundary and assert `VOICE_PROTOCOL_UNKNOWN_FIELD`. Mutate version to 4 and 6; delete every required key; flip scalar types; pad both token segments; and exceed the decoded single-chunk bound by two bytes. Keep stateful duplicate/gap/reorder/end/aggregate mutations in `audio-turn-lifecycle.json`.

- [ ] **Step 5: Verify GREEN**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_client_differential_cases -- --exact --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_server_differential_cases -- --exact --nocapture
```

Expected: every fixture case and mutation passes in both languages.

- [ ] **Step 6: Commit**

```bash
git add agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol/v5/client-differential-cases.json agent/fixtures/voice-protocol/v5/server-differential-cases.json
git commit -m "feat(voice): enforce strict differential parsing"
```

### Task 7: Pin turn intents, deferred outcomes, and terminality

**Files:**
- Modify: `agent/crates/agent-service/src/protocol.rs`
- Modify: `packages/core/src/agent-contract.ts`
- Modify: `packages/core/src/agent-contract.test.ts`
- Create: `agent/fixtures/voice-protocol/v5/turn-intents.json`
- Create: `agent/fixtures/voice-protocol/v5/turn-outcomes.json`
- Create: `agent/fixtures/voice-protocol/v5/terminal-sequences.json`
- Create: `agent/fixtures/voice-protocol/v5/transport-outcomes.json`

- [ ] **Step 0: Wait for the merged Plan 06 domain event**

Tasks 7 and 8 additionally require Plan 06's `brain.rs` commit containing `BrainEvent::TurnDeferred { response_id, question_id, reason, can_retry_same_question }` to be merged to `review-remediation/integration`. Wait for that merge, then run in this lane worktree before continuing:

```bash
git fetch --all --prune
git rebase review-remediation/integration
```

Waiting here is normal merge sequencing, not a defect. If the coordinator needs Tasks 1–6 sooner, use the two-PR split described under "Required predecessor".

- [ ] **Step 1: Verify the Plan 06 domain handoff without editing it**

```bash
git log -1 --oneline -- agent/crates/agent-domain/src/brain.rs
rg -n 'TurnDeferred|response_id|question_id|EvaluationDeferralReason|can_retry_same_question' agent/crates/agent-domain/src/brain.rs
```

Expected: the committed Plan 06 `BrainEvent::TurnDeferred` has exactly `response_id`, `question_id`, `reason: EvaluationDeferralReason`, and `can_retry_same_question`; it has no wire `turn_id`. Only if the variant is absent or has different fields after the Step 0 rebase is it a Plan 06 defect to return. Do not edit `brain.rs` from this plan.

- [ ] **Step 2: Write failing VOICE-TURN-* / VOICE-TERMINAL-* tests**

Cover answer text, citation challenge, question turn ids, all six exact `EvaluationDeferralReason` strings, exact persisted `response_id`/`question_id`/reason/`can_retry_same_question` mapping, deferred-event nonterminality/exclusivity, normal/partial recap invariants, recoverable/terminal structured errors, the recoverable `VOICE_SESSION_REFRESH_POLICY_DENIED` event, typed server errors, termination classification priority, and v5 serialization fallback.

- [ ] **Step 3: Verify RED**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_turn_and_terminal_sequences_match -- --exact --nocapture
```

Expected: FAIL against optional `partial_reason`, ambiguous structured errors, plain text, and message-only error frames.

- [ ] **Step 4: Implement exact unions and constructors**

Add the typed turn intent and exact durable Deferred mirror, recap discrimination, structured-error terminality, error-code mapping, and termination classification. Implement `ServerFrame::turn_deferred(turn_id: &str, event: &BrainEvent) -> Result<ServerFrame, VoiceProtocolDiagnostic>` so it accepts only Plan 06's `BrainEvent::TurnDeferred`, adds the active `turn_id`, and copies `response_id`, `question_id`, `EvaluationDeferralReason`, and `can_retry_same_question` losslessly; it accepts no provider message or learner facts. Export an owner-provided serialization fallback in `protocol.rs`, `pub const VOICE_SERIALIZATION_FALLBACK_FRAME: &str = "{\"type\":\"error\",\"version\":5,\"error\":{\"code\":\"VOICE_INTERNAL_SERIALIZATION\",\"message\":\"Server frame serialization failed.\",\"retryable\":true}}"`, pinned by a `protocol::tests` round-trip test; Plan 08 consumes it in `ws.rs`. Create the exact `turn-intents.json`, `turn-outcomes.json`, `terminal-sequences.json`, and `transport-outcomes.json` corpora. Constructors must make illegal Rust combinations unrepresentable or return `VOICE_PROTOCOL_INVARIANT`; do not expose public constructors that accept `partial=false` plus a reason.

- [ ] **Step 5: Differential negative controls**

Assert citation challenges cannot deserialize as answer text; recoverable structured errors reject terminal reasons; terminal structured errors require one; partial recaps require a reason; normal recaps reject one; malformed `error.message` reports `$.error.message`; termination classification ignores hostile message/close strings.

- [ ] **Step 6: Verify GREEN and commit**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
git add agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol/v5/turn-intents.json agent/fixtures/voice-protocol/v5/turn-outcomes.json agent/fixtures/voice-protocol/v5/terminal-sequences.json agent/fixtures/voice-protocol/v5/transport-outcomes.json
git commit -m "feat(voice): type turn and terminal outcomes"
```

### Task 8: Publish two-turn differential session fixtures

**Files:**
- Modify: `agent/crates/agent-service/src/protocol.rs` (tests)
- Modify: `packages/core/src/agent-contract.test.ts`
- Create: `agent/fixtures/voice-protocol/v5/manifest.json`
- Create: `agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json`
- Create: `agent/fixtures/voice-protocol/v5/synthetic-two-turn-session.json`
- Create: `agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json`

- [ ] **Step 1: Write failing full-session tests**

Add `VOICE-FIXTURE-001` tests in both languages that require the exact manifest rows/paths/kinds, v5-only disposition, and rejection of duplicate, missing, or unlisted JSON paths. Load every manifest fixture. Assert exact generation/turn/response/question identity, monotonic audio, distinct second `question_started`, cancellation scoping, no fabricated confidence, durable Deferred remains nonterminal and produces no evaluated/mastery/review/graded-recap fields, and exact round-trip in both languages. `audio-turn-lifecycle.json` contains valid production-size, smaller-chunk/high-final-sequence, duplicate, gap, reorder, end-mismatch, oversized-chunk, and 2,160,002-byte aggregate cases with the exact diagnostics above; per VOICE-DIFFERENTIAL-001, this plan's tests validate its schema, case-id set, and per-frame parses only, while Plan 08 executes the stateful expected outcomes behaviorally. Test partial-terminal ordering in `terminal-sequences.json` independently; do not couple it to deferral.

- [ ] **Step 2: Verify RED**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_v5_two_turn_fixtures_are_exhaustive -- --exact --nocapture
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests::voice_fixture_manifest_is_complete -- --exact --nocapture
```

Expected: FAIL because the final manifest, audio lifecycle, and v5 two-turn corpus do not exist.

- [ ] **Step 3: Create fixtures from authoritative deterministic outputs**

Use fake ids/secrets only. Do not hand-invent provider output. `transcript_final.confidence` is `null` when absent from the fake provider. Assert no raw audio, real secrets, or hidden tool/provider payloads in server frames; fake token material is limited to the signed-config, differential-token, and session-token-vector cases that explicitly test it. Create the manifest only after the other fourteen exact rows exist so manifest completeness can turn GREEN in this task.

- [ ] **Step 4: Verify GREEN and redaction**

```bash
bun test packages/core/src/agent-contract.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
rg -n "sk-|AIza|BEGIN PRIVATE KEY|Authorization:|session-secret|answer_text|raw_audio" agent/fixtures/voice-protocol/v5 agent/fixtures/session-token/v1/vectors.json
```

Expected: tests PASS. The scan has only schema-owned `answer_text` intent and `raw_audio_persistence` readiness keys plus explicitly fake secret metadata; no real credential, raw audio payload, or provider payload hit.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol/v5/manifest.json agent/fixtures/voice-protocol/v5/audio-turn-lifecycle.json agent/fixtures/voice-protocol/v5/synthetic-two-turn-session.json agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-two-turn-session.json
git commit -m "test(voice): publish v5 two-turn fixtures"
```

### Task 9: Contract-owner verification, Plan 14 handback, and consumer handoff

**Files:**
- Modify after Plan 14's fixture-extraction checkpoint: `packages/core/src/agent-contract.test.ts`
- Read/verify after that checkpoint: `packages/core/src/fixtures.ts`
- Read/verify after Plan 14 export wiring: `packages/core/src/runtime-validation.ts`
- Verify: all other files owned by this plan

- [ ] **Step 1: Run contract-owner gates**

```bash
bun test packages/core/src/agent-contract.test.ts
bun run --cwd packages/core typecheck
bun run --cwd packages/core lint
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol::tests -- --nocapture
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml -p agent-service --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 2: Enforce the Plan 14 fixture-import ownership handshake**

Plan 14 first creates and commits `packages/core/src/fixtures.ts`, moving/exporting `seedStudySets` there while preserving the root export. Plan 14 then stops before editing or staging `packages/core/src/agent-contract.test.ts` and sends Plan 05 the fixture-extraction commit SHA. If `./fixtures` does not exist or the SHA is absent, stop; do not point this test at an imaginary module.

After that checkpoint, the Plan 05 owner changes exactly this import in its owned test:

```ts
// before
import { seedStudySets } from "./index";

// after
import { seedStudySets } from "./fixtures";
```

This removes the package-root cycle from the parser test without moving parser behavior. Verify and commit only the owned test:

```bash
test -f packages/core/src/fixtures.ts
git show --quiet --oneline "${PLAN14_FIXTURES_SHA:?set Plan 14 fixture-extraction SHA}"
! git show --pretty='' --name-only "${PLAN14_FIXTURES_SHA}" | rg -q '^packages/core/src/agent-contract\.test\.ts$'
rg -n 'seedStudySets.*from "\./fixtures"' packages/core/src/agent-contract.test.ts
! rg -n 'from "\./index"' packages/core/src/agent-contract.test.ts
bun test packages/core/src/agent-contract.test.ts
git add packages/core/src/agent-contract.test.ts
git diff --cached --name-only
git commit -m "test(voice): isolate contract fixtures"
```

Expected: the staged-file list is exactly `packages/core/src/agent-contract.test.ts` and the suite passes. Plan 14 never edits/stages this test.

- [ ] **Step 3: Hand the pure-ESM behavior to Plan 14 and Plan 12**

Provide the Plan 05 parser commit SHA and exact symbol `parseVivaServerFrame(value: unknown): VivaServerFrame` from `packages/core/src/agent-contract.ts`. Plan 14 alone creates `packages/core/src/runtime-validation.ts` as a direct pure-ESM aggregator re-exporting that symbol and Plan 04's `validateLearnerLoopContract(value: unknown)`, then owns package `exports`, TypeScript build wiring, and the Node 24 package-import proof. It must not add wrappers, import the package root, fork validation behavior, or edit/stage either behavioral source/test.

After Plan 14 reports its export-wiring SHA, verify the aggregator is direct and behavioral ownership stayed clean:

```bash
rg -n 'parseVivaServerFrame|validateLearnerLoopContract' packages/core/src/runtime-validation.ts
! rg -n 'function parseVivaServerFrame|function validateLearnerLoopContract|from "\./index"' packages/core/src/runtime-validation.ts
! git show --pretty='' --name-only "${PLAN14_RUNTIME_EXPORT_SHA:?set Plan 14 export SHA}" | rg -q '^packages/core/src/(agent-contract|learner-loop-contract)(\.test)?\.ts$'
rg -n 'seedStudySets.*from "\./fixtures"' packages/core/src/agent-contract.test.ts
```

Expected: the aggregator contains direct re-exports, no wrapper/root import, Plan 14's export commit contains no Plan 04/05 behavioral source/test, and Plan 05's separately committed test import points at `./fixtures`. Plan 12 consumes `@viva/core/runtime-validation` read-only; it does not import package-internal validator paths.

- [ ] **Step 4: Prove manifest/version discipline**

```bash
diff -u <(jq -r '.fixtures[].path' agent/fixtures/voice-protocol/v5/manifest.json | sort) <({ find agent/fixtures/voice-protocol/v5 -type f -name '*.json' -print; printf '%s\n' agent/fixtures/session-token/v1/vectors.json; } | sort)
! rg -n '"version"[[:space:]]*:[[:space:]]*4' agent/fixtures/voice-protocol/v5 --glob '!client-differential-cases.json' --glob '!server-differential-cases.json'
! rg -n "fixtures/voice-protocol/" agent/crates/agent-service/src/protocol.rs packages/core/src/agent-contract.test.ts | rg -v "fixtures/voice-protocol/v5"
```

Expected: the first command matches the manifest; the two `rg` pipelines return no v4 or unversioned import. Intentional v4 strings live only inside differential `wire_json` cases and are exempted by exact case id assertions.

- [ ] **Step 5: Handoff by fixture id, not copied JSON**

Provide the Plan 05 commit SHA and these instructions:

- Plan 06: publish the exact domain `BrainEvent::TurnDeferred { response_id, question_id, reason, can_retry_same_question }`; do not define a wire `turn_id` or edit `protocol.rs`; migrate `agent/crates/agent-domain/tests/protocol_fixtures.rs` from `fixtures/voice-protocol/session-config.json` to `fixtures/voice-protocol/v5/client-session-config-signed.json`.
- Plan 07: consume `VOICE-CLIENT-TURN-INTENTS`, `VOICE-SERVER-TURN-OUTCOMES`, and both two-turn sessions read-only; emit the Plan 06 event only after Plan 04 durably persists Deferred, copying its four fields exactly; do not define wire variants or add provider/learner facts.
- Plan 08: consume signed config/refresh, audio lifecycle, turn outcomes, terminal/transport outcomes, token vectors, and `auth-decision.json`; delete private `InitialClientFrame`; call Plan 05's `ServerFrame::turn_deferred` while updating WebSocket turn accounting, and do not edit/redeclare the mapping in `protocol.rs` or make deferral terminal. Execute every `VOICE-AUDIO-TURN-LIFECYCLE` stateful case behaviorally against Plan 03's `ws.rs` assembler, asserting the fixture's exact `valid`/`diagnostic_code`/`path` outcomes. Replace the hard-coded v1 serialization-fallback string in `ws.rs` (currently line 3874) with `protocol::VOICE_SERIALIZATION_FALLBACK_FRAME`; do not keep any literal v1 error JSON. Implement D-07 without changing fixtures. Apply Plan 04's selected D-03 branch after parsing: D-03A permits only claim-bound/exact authorized mode+goal values, while D-03B rejects every context change with recoverable `VOICE_SESSION_REFRESH_POLICY_DENIED`; neither branch treats refresh as token renewal.
- Plan 09: migrate or remove the `include_str!("../../../fixtures/voice-protocol/count-truth-table.json")` reference in `agent/crates/data/src/migrations.rs` (currently line 1694); if the data assertions are still needed, request a Plan 05 fixture amendment for a v5 manifest row rather than importing an unversioned path.
- Plan 10: import `VivaBrowserClientFrame`, the exact constants, parsers, termination classifier, and all client/server differential fixtures; type its send boundary as `sendFrame(frame: VivaBrowserClientFrame)`; reject a hostile cast `tool_result` before send at `$.type`; reject a serialized UTF-8 frame above 65,536 bytes at `$`; reconnect on token renewal; store partial/structured terminal state immediately; never classify free-form messages. Plan 10 owns browser enforcement/tool-type cleanup in `viva-agent-client.ts` but does not change `agent-contract.ts` or fixture expectations.
- Plan 11: consume the token vectors and `auth-decision.json`; Branch A implements rotating one-time hashed refresh with absolute lifetime, Branch B implements service-authenticated replacement and returns no browser refresh credential.
- Plan 12: import `parseVivaServerFrame` only through `@viva/core/runtime-validation`; do not reimplement or weaken strict parsing.
- Plan 14: own `fixtures.ts`, the runtime-validation aggregator, package export/build wiring, and Node 24 loading proof; never edit/stage Plan 05's parser source or test.

- [ ] **Step 6: Retire the legacy root v4 fixtures this plan owns**

After Plans 06/07/08/09/10 confirm migration of their fixture imports to v5 paths, delete the eleven legacy root fixture files directly under `agent/fixtures/voice-protocol/` — `client-audio.json`, `count-truth-table.json`, `fake-cartesia-gemini-evidence-pack.json`, `fake-cartesia-gemini-study-session.json`, `server-event-manuscript-intent.json`, `server-event-question-started.json`, `server-event-structured-error.json`, `server-ready.json`, `session-config.json`, `synthetic-evidence-pack.json`, `synthetic-study-session.json` — and commit the deletion:

```bash
git rm agent/fixtures/voice-protocol/*.json
git commit -m "chore(voice): retire legacy root v4 fixtures"
```

The glob matches only the root-level files; `agent/fixtures/voice-protocol/v5/**` is untouched. This closes the "remain frozen only until consumers migrate" disposition in VOICE-VERSION-001 and is a precondition for the version scans in Step 7.

- [ ] **Step 7: Run the combined compatibility gate only after Plans 06/07/08/09/10/11/12/14 land**

```bash
bun run validate
cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws -- --nocapture
! rg -n "VIVA_VOICE_PROTOCOL_VERSION[[:space:]]*=[[:space:]]*4|version:[[:space:]]*4|\"version\":[[:space:]]*4" agent apps packages scripts --glob '!**/client-differential-cases.json' --glob '!**/server-differential-cases.json'
! rg -n "fixtures/voice-protocol/" agent apps packages scripts | rg -v "fixtures/voice-protocol/v5"
```

Expected: full validation and real-WebSocket tests PASS; both scans return no live v4 constant/frame/import. Do not waive this gate because the focused contract suites are green.

- [ ] **Step 8: Final contract commit if formatting/handoff metadata changed**

```bash
git status --short -- agent/crates/agent-service/src/protocol.rs agent/crates/agent-service/src/lib.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol/v5 agent/fixtures/session-token/v1/vectors.json
git diff --check -- agent/crates/agent-service/src/protocol.rs agent/crates/agent-service/src/lib.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol/v5 agent/fixtures/session-token/v1/vectors.json
```

If there are contract-owned changes, stage them explicitly and commit:

```bash
git add agent/crates/agent-service/src/protocol.rs agent/crates/agent-service/src/lib.rs packages/core/src/agent-contract.ts packages/core/src/agent-contract.test.ts agent/fixtures/voice-protocol/v5 agent/fixtures/session-token/v1/vectors.json
git commit -m "chore(voice): close protocol v5 compatibility gate"
```

---

## Acceptance checklist

- [ ] `VOICE-VERSION-001`: v5 is the only accepted/emitted version; v4 rejects with a stable diagnostic.
- [ ] `VOICE-SIZE-001`: Plan 03 chunk/turn constants match exactly in Rust, TS, and fixtures.
- [ ] `VOICE-SIZE-002`: the stale v4 binary surface is gone; envelope and decoded-chunk paths/codes are exact; 45 seconds of 20 ms chunks and smaller valid chunks prove there is no derived count/final-sequence cap; Plan 10 owns only browser pre-send enforcement.
- [ ] `VOICE-AUTH-001`: the canonical first frame is typed in Rust/TS, generation-bound, token-required, and redaction-tested.
- [ ] `VOICE-REFRESH-001`: token renewal reconnects; parsing remains D-03-neutral; in-socket refresh is context-only, rejects authority fields, and Plan 08 applies the selected D-03A/D-03B policy with typed recoverable denial.
- [ ] `VOICE-AUTHORITY-001`: `VivaBrowserClientFrame` is the only browser-sendable union, dead tool exports are absent, and forged `tool_result` rejects at `$.type` before send.
- [ ] `D-07 TOKEN_ONLY_REFRESH`: sponsor selected one branch and `auth-decision.json` records it; no worker choice occurred.
- [ ] `VOICE-TOKEN-001`: Rust and Node consume the same exhaustive canonical token vectors.
- [ ] `VOICE-DIAGNOSTIC-001`: every malformed/unknown case has the same code/path in Rust and TS with no raw input leakage.
- [ ] `VOICE-RUNTIME-001`: strict `parseVivaServerFrame(value: unknown)` is pure-ESM behavioral source; Plan 14 directly re-exports it through `@viva/core/runtime-validation`, and Plan 12 consumes that export.
- [ ] `VOICE-TURN-001`: answer text and citation challenge are typed and cannot cross-grade.
- [ ] `VOICE-TURN-002`: only durable Plan 04 Deferred outcomes emit the exact turn/response/question/reason/`can_retry_same_question` wire event; all six reasons are covered; deferral is nonterminal and carries no provider message or fabricated feedback/confidence/status/schedule/mastery/review.
- [ ] `VOICE-TERMINAL-001`: partial recap terminality survives loss of the trailing phase frame.
- [ ] `VOICE-TERMINAL-002`: structured errors explicitly distinguish recoverable from terminal.
- [ ] `VOICE-READY-001`: the dead `ReadyFrame` duplicate and re-export are gone.
- [ ] `VOICE-TERMINATION-001`: the web consumes typed termination classification with no message regex.
- [ ] `VOICE-FIXTURE-001`: the manifest lists every immutable v5 fixture and all consumers import versioned paths only.
- [ ] `VOICE-SESSION-001`: both two-turn fixtures prove repeated `question_started`, identity, cancellation, terminal ordering, and no fabricated confidence.
- [ ] Plan 04 alone owns learner-loop `durability_degraded` cleanup/validation; no Plan 05 commit edits or stages `learner-loop-contract.ts`.
- [ ] Plan 05 alone migrates `agent-contract.test.ts` from `./index` to Plan 14's committed `./fixtures`; Plan 14 never edits/stages that test.
- [ ] Focused Rust/TS gates pass before handoff; the full combined tree passes only after Plans 06/07/08/09/10/11/12/14 integrate.
