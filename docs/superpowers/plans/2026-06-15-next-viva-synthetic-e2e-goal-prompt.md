Goal: execute the next Viva voice-agent slice: synthetic E2E product integration plus evidence-grade Rust lifecycle. Do not flip live Cartesia/Gemini.

Repo: /Users/connor/Medica/backbay/viva

First re-derive state. Run `git status --short`; preserve unrelated/generated/ignored files. Read the prior goal/port docs, `agent/README.md`, service protocol/ws/config/app code, data memory/migrations, observe lib, web client/VivaApp, and core agent contract.

Hard scope:
- Default provider remains synthetic.
- Do not implement/select `cartesia_gemini`.
- Default validation must not need keys, network, or Postgres.
- No PCM capture/playback. Browser dictation can stay as text fallback.
- Browser `source_context` is untrusted.
- No provider internals in React.

Tasks, in order:

1. Evidence/lifecycle spine
- Add structured events for preflight/config/session/question/answer/evaluation/source/cancel/stop/close/store-counts/terminal-reason.
- Never log/persist raw audio, transcripts, secrets, or document text.
- Wire observe/service so `/ready` and `/health/brain` report real brain/store capability instead of unconditional readiness.
- Emit terminal reason and store write counts on all exits.

2. Deterministic evidence pack
- Add a synthetic replay fixture/test capturing client frames in, server frames out, store snapshot, evidence events, and terminal close reason.
- Fixture drift must fail tests.

3. WebSocket lifecycle hardening
- Test first-frame timeout, idle timeout, close codes, keepalive, capacity release, malformed/oversized frames, disconnect -> Stop, and cancel/stale ordering.
- Use the strongest local test boundary available; do not fake away lifecycle assertions.

4. Source/persistence boundaries
- Add store capability enum plus durable/non-durable evidence flag.
- Keep raw audio/transcript persistence off by default.
- Cover fixture string IDs vs future UUID schema translation.
- Add negative tests for forged source fields, tombstoned spans, wrong user/study set, forged recap source, and browser `source_context` injection. Evaluation/correction fails closed on bad source integrity.

5. Browser thin adapter
- Add pure mappers: `StudySet -> AgentSessionConfig`; agent eval/recap -> existing UI types; source tuple -> UI citation preserving document_id/span_id/retrieval_reason/confidence.
- Add `useVivaAgentSession` around `createVivaAgentSessionController`, exposing connect/sendText/cancel/stop/status/agentState/derived UI state.
- Test client/hook with fake WebSocket.

6. Text-only synthetic VivaApp wiring
- Start connects and sends `session_config`; submit sends text; finish sends stop.
- Render agent question/transcript/evaluation/recap when connected.
- Keep browser dictation as text input only.
- Suppress `speechSynthesis` while agent-connected.
- Surface structured connection/protocol errors.

Stop and fix before completion if:
- Validation needs keys/network/Postgres.
- Rust/TS contract fixtures or evidence packs drift.
- Connected UI uses `evaluateAnswer` or `buildSessionRecap` as authoritative results.
- Browser `source_context` influences trusted source output.
- A source tuple is dropped or forged correction is accepted.
- Provider/brain internals leak into React.
- Readiness is unconditional.
- Generated artifacts enter the diff.
- Live provider runtime selection appears.

Verify:
- `bun run validate`
- `cargo test --manifest-path agent/Cargo.toml --workspace` plus targeted WS/evidence tests
- Relevant `bun test` files for contract/client/hook/UI
- `scripts/check-agent-domain-purity.sh`
- Run at least two P0/P1/P2 subagent reviews of final diff and fix all actionable findings.

Completion requires green no-secret/no-network validation, deterministic evidence pack, connected text-only synthetic UI, robust lifecycle/source tests, and a final command/result summary noting live Cartesia/Gemini remains intentionally unselected.
