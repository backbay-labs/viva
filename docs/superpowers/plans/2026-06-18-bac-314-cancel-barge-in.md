# BAC-314 Cancellation And Barge-In Hardening Plan

> For agentic workers: implement with focused red/green tests. Preserve the existing event-sourcing contract: the agent emits cancellation meaning events; the manuscript projection owns pixel/audio unwind.

**Goal:** Make cancellation semantics consistent for response-specific and global cancellation across server forwarding and browser state, so stale provider events cannot update visible state or durable/evidence paths after cancel/barge-in.

**Scope:** Small hardening around existing cancellation infrastructure. Do not implement live provider transports, server-side VAD, or provider-doc-dependent behavior. Keep amplitude/RMS client-only.

## Task 1: Prove global cancellation suppresses stale server events

Files:
- Modify: `agent/crates/agent-service/tests/voice_ws.rs`
- Modify: `agent/crates/agent-service/src/ws.rs`

- [x] Add a failing WebSocket test using a probe brain that emits `QuestionStarted(response-1)`, global `ResponseCancelled`, then stale `AnswerEvaluated`, `SourceReference`, `RecapReady`, and `AudioDelta` for `response-1`.
- [x] Expected red: current server does not map global cancellation to the active response id, so stale events are not suppressed before authorization/forwarding.
- [x] Implement a cancellation tracker that records the active response id on `QuestionStarted`, maps `ResponseCancelled` to that active id, records `ResponseCancelledFor` directly, and suppresses any later response-bound event for cancelled ids before authorization/evidence/browser forwarding.
- [x] Verify the focused WebSocket test passes.

## Task 2: Prove global cancellation suppresses stale browser state

Files:
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/lib/viva-agent-client.ts`

- [x] Add a failing reducer test that starts an active response, receives `cancellation` with `response_id: null`, then receives stale evaluation/source/recap/audio events for the active response.
- [x] Expected red: current reducer does not add the active response id to `cancelledResponseIds` for global cancellation, so stale response events can mutate state.
- [x] Implement reducer handling that treats global cancellation as cancellation of the active response when one exists, clears active response state, filters response-bound manuscript intents/audio, and keeps future replacement turns accepted.
- [x] Verify the focused web reducer test passes.

## Task 3: Verification, review, PR

Files:
- All touched files.

- [x] Run focused Rust and TS tests:
  - `VIVA_ALLOW_LOOPBACK_TEST_SKIP=1 cargo test --manifest-path agent/Cargo.toml -p agent-service --test voice_ws websocket_global_cancellation_suppresses_active_response_events`
  - `bun test apps/web/lib/viva-agent-client.test.ts`
- [x] Run `bun run validate`.
- [x] Run `git diff --check`.
- [x] Run the privacy/stop-rule scan for raw transcript/audio, server-side VAD, and forbidden live-provider claims.
- [ ] Commit, push, open PR, request review, resolve every review thread, merge, and mark BAC-314 Done in Linear with evidence.
