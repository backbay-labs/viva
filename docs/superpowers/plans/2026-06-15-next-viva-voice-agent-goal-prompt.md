# Next Viva Voice Agent Goal Prompt

```text
In /Users/connor/Medica/backbay/viva, execute the next Viva voice-agent slice: browser-facing product contract + deterministic synthetic study session. Do not wire live Cartesia/Gemini yet, do not make default tests require keys/network/Postgres, and do not let generic provider events leak into React.

Start by re-reading docs/superpowers/plans/2026-06-15-rust-cartesia-gemini-voice-agent-port.md, agent/README.md, packages/core/src/agent-contract.ts, agent/crates/agent-service/src/{protocol.rs,ws.rs}, agent/crates/agent-adapters/src/synthetic.rs, agent/crates/agent-domain/src/{brain.rs,tools.rs,ports.rs}, and apps/web/lib/viva-agent-client.ts. Run git status --short and preserve unrelated/ignored generated files.

Implement in this order:
1. Lock the Viva product WebSocket contract. Add explicit TS + Rust wire events and shared fixtures for a complete text study session: session phase, question started, transcript delta/final, answer evaluated, source reference, concept status, recap ready, audio delta, cancellation, and structured errors. Keep current audio frame support, but the browser-facing API must be Viva product events, not raw BrainEvent/provider mechanics.
2. Build a deterministic synthetic study-session orchestrator. It must consume the initial SessionConfig, select a fixture-backed question, accept text/audio/cancel/stop, emit product events in order, cite server-owned source metadata, and exercise stale/cancel behavior. Client-provided source_context is allowed only for local fixture bootstrap; do not treat browser-supplied excerpts as trusted source truth.
3. Complete the source-grounded tool surface. Add challenge_correction and schedule_review_item, tighten existing tools around study_set_id and voice_session_id, and require source-backed corrections to carry source_id, document_id, span, excerpt, confidence, and retrieval_reason.
4. Add no-Postgres in-memory stores behind existing domain ports for study sets, documents, source spans, voice sessions, answer attempts, concept statuses, review items, and recap state. Do not add default DB integration; Postgres can remain schema-only or explicit integration-gated.
5. Turn apps/web/lib/viva-agent-client.ts into a session controller/reducer layer: connect, send initial session_config, send text/audio/stop/cancel, parse product frames, track active response_id, suppress stale text/audio, and expose reconnect/error states. Avoid heavy React rewrites until the controller is tested.
6. Harden /ws tests: bearer 401, origin 403, capacity behavior, first-frame session_config, invalid protocol versions, oversized text/binary, binary PCM routing, cancel/stale suppression, and fixture-driven synthetic session flow. Use no-secret/fake tests only.

Stop immediately if TS/Rust fixtures diverge, bun run validate fails, default gates need provider keys/network/Postgres, Luca/cooking domain residue appears, a source-backed correction can bypass deterministic source retrieval, generated artifacts enter the diff, or UI code must branch on generic provider events.

Do not select VIVA_AGENT_PROVIDER=cartesia_gemini or run live smoke. Preserve synthetic as default. Leave live provider work for a later phase after product contract, source tools, browser lifecycle, and fake E2E are hard.

Verification required: bun run validate, scripts/check-agent-domain-purity.sh, targeted TS/Rust fixture tests, and two fresh P0/P1/P2 review passes using subagents. Fix every P0/P1/P2 or reclassify with evidence. Completion requires green no-secret gates, shared full-session fixtures, deterministic source-grounded synthetic session, tested controller, documented skipped live-smoke status, and a final summary with exact commands/results.
```
