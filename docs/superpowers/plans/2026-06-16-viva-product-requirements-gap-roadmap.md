# Viva Product Requirements Gap Roadmap

Date: 2026-06-16
Status: planning document for next Linear project setup
Confidence: high on current local state, high on repo-derived gaps, moderate on live Cartesia/Gemini implementation details until official provider docs are rechecked immediately before live transport work.

## Purpose

This document converts the current Viva prototype state into a product-execution roadmap. It is intended to be translated into a Linear project, milestones, and issues in the next session.

The strongest conclusion is simple: the app did not "barely work" because the keys failed. It barely worked because the product is currently split across three different modes:

1. Local demo UI with browser Web Speech dictation.
2. Connected fake/synthetic Rust agent paths that can exercise the WebSocket contract without live providers.
3. A configured but intentionally gated `cartesia_gemini` live provider that is not selectable and does not yet contain live network clients.

The screenshot showing `Agent unavailable` is consistent with current code and current runtime health. The observed "hello how are you" transcript proves browser dictation worked; it does not prove connected Cartesia STT or Gemini agent execution.

## Source Inputs

- Product target: `docs/REQUIREMENTS.md`
- Live voice-agent port plan: `docs/superpowers/plans/2026-06-15-rust-cartesia-gemini-voice-agent-port.md`
- Prior execution plans: `docs/superpowers/plans/2026-06-15-next-viva-execution-brainstorm.md`, `docs/superpowers/plans/2026-06-15-next-viva-voice-agent-goal-prompt.md`, `docs/superpowers/plans/2026-06-16-next-viva-execution-team-brainstorm-2.md`
- Current runtime health checked locally on 2026-06-16:
  - `/health/brain`: `provider=cartesia_gemini`, `configured=true`, `selectable=false`, `live_runtime=false`, `status=unavailable`
  - `/ready`: HTTP `503`

No secrets are included here. Local provider keys may be configured, but live provider selection remains blocked by design.

## Product Target From PR Doc

Viva's MVP is not "show a pretty study UI" or "connect a socket." The MVP is:

1. Student creates a study set.
2. Student uploads or pastes course materials.
3. Viva extracts concepts and source-grounded questions.
4. Student starts a voice recall drill.
5. Viva asks oral questions out loud.
6. Student answers out loud.
7. Viva evaluates the spoken answer, gives hints, asks follow-ups, and corrects misconceptions.
8. Viva cites source material.
9. Viva marks concepts strong, shaky, or missed.
10. Viva ends with a recap and recommends the next review session.

The PR doc's core acceptance phrase is: upload notes, talk, get quizzed, improve. The current prototype does pieces of that, but not as one trustworthy end-to-end product.

## Current State

### Working Or Mostly Working

- Rust `agent/` workspace exists and is integrated into root scripts.
- `synthetic` and `fake_cartesia_gemini` can run without provider keys or external network.
- The real `/ws` boundary exists with a 24 kHz PCM16-style browser contract.
- Fake provider evidence covers a connected session, tool execution, persistence writes, audio-shaped events, source events, and recap events.
- Paste ingestion exists server-side.
- Signed session tokens and fail-closed access work are partially present.
- Browser has PCM capture and audio playback primitives.
- Release gates exist for no-secret validation, direct WebSocket replay, browser E2E, release artifact checks, and optional Postgres proof.

### Not Working As Product

- Live `cartesia_gemini` is configured but intentionally unavailable: `selectable=false`, `live_runtime=false`.
- The Cartesia/Gemini adapter has request builders and parsers, but not real live network clients for Ink STT, Gemini streaming, or Sonic TTS.
- The live runner currently lacks proper store binding; bypassing the gate would not produce a complete product session.
- The screenshot's transcript came from browser `SpeechRecognition`, not connected Cartesia STT.
- The connected session UI still has local-demo leftovers: typed answer state, local answer checks, hard-coded demo content, and ambiguous copy.
- File upload validates local file metadata but does not upload bytes into server-owned ingestion. Paste is the only credible connected ingestion path today.
- Source grounding is still thin: bounded, course-specific source excerpts and confidence handling need work before the correction flow can be trusted.
- Library, history, review scheduling, and mastery tracking are not yet real connected product surfaces.

## Requirement Gaps

### P0 Gap 1: Runtime Truth And Readiness

Current UI collapses too many states into `Agent unavailable`. The product needs a readiness ladder:

- agent server offline
- provider fake/synthetic
- live provider gated
- live provider ready
- store unavailable
- ingestion pending
- ingestion failed
- WebSocket auth failed
- mic denied
- connected and listening

The app must never imply that local browser dictation is the live agent. It also must never present fake-provider success as live Cartesia/Gemini tutoring.

### P0 Gap 2: Real Live Voice Provider

The intended live flow remains:

browser PCM -> Rust `/ws` -> Cartesia Ink STT -> Gemini `streamGenerateContent` plus Viva tools -> Cartesia Sonic TTS -> browser audio/transcript/source/recap events.

Missing work:

- real Cartesia Ink WebSocket transport
- real Gemini streaming HTTP/SSE transport and function-call continuation loop
- real Cartesia Sonic WebSocket transport
- provider cancellation and barge-in across STT, LLM, TTS, and browser writer
- provider error, timeout, usage, and cost telemetry
- opt-in live smoke harness with budget limits and sanitized evidence

### P0 Gap 3: Voice-First Browser Turn Model

The browser needs one coherent tutoring turn:

1. show current oral question
2. listen through connected mic capture
3. show final transcript from agent STT
4. evaluate through agent/tool loop
5. speak feedback through assistant audio playback
6. allow interruption
7. update concept status and next action

The text answer box can remain as an accessibility fallback, but it cannot be the primary connected success path.

### P0 Gap 4: Server-Owned Ingestion And Source Grounding

The PR doc lists PDF upload and pasted notes as P0. The engineering plans deferred PDF in favor of paste-first source contracts. That is the right engineering sequence, but it must be made explicit in Linear:

- connected MVP can be paste-first only if PDF is deliberately descoped from the first internal milestone
- otherwise file upload ingestion becomes a P0 blocker

Regardless of PDF timing, source grounding must improve:

- document IDs and source IDs are server-owned
- excerpts are bounded and specific
- concepts/questions cite canonical spans
- corrections report confidence
- conflicting source material is handled honestly
- browser-provided source tuples are rejected as authority

### P0 Gap 5: Study Intelligence

Current fake paths can demonstrate events, but the product needs actual study behavior:

- generated multi-question banks per study set
- open-ended oral questions from uploaded material
- answer evaluation beyond fixture matching
- hints and follow-up questions
- concept status transitions
- session recap from real attempts
- next-session recommendation from weak concepts

### P1 Gap 6: Durable Product Surfaces

The library and session history are still mostly local UI. The product needs server-backed:

- study set library with ingestion status
- session history
- recap history
- review queue
- concept mastery state
- resume tokens
- delete/export/privacy controls

Postgres proof exists, but it needs parity evidence before becoming the normal operating mode.

### P1 Gap 7: Release, Privacy, And Ops

Before any public or beta use:

- default CI must remain no-key, no-network, no-mic, no-Postgres
- live smoke must be opt-in, cost-capped, and sanitized
- release artifacts must exclude secrets, raw audio, transcripts, answers, prompts, full notes, and unbounded source excerpts
- production binds must fail closed without bearer auth and allowed origins
- session-token nonce/replay protection needs hardening
- graceful shutdown/draining and rate limits need implementation

## Recommended Linear Milestones

### Milestone 0: Baseline Truth And Evidence

Goal: make the current state impossible to misread.

Issue candidates:

1. Create provider readiness matrix evidence for `synthetic`, `fake_cartesia_gemini`, and gated `cartesia_gemini`.
2. Update UI copy so local demo, fake connected agent, and live voice tutor are distinct states.
3. Publish sanitized browser story artifacts: pending preview, ready server-owned set, active fake connected session, recap.
4. Fix frontend test env isolation so local `.env` cannot override URL unit tests.
5. Add a short "what counts as live" doc: only live provider readiness plus real STT -> Gemini -> TTS smoke counts.

Acceptance:

- `/ready` and `/health/brain` states are represented in evidence.
- `Agent unavailable` has an actionable reason, not a generic dead end.
- No live provider is claimed unless `selectable=true` and `live_runtime=true`.

### Milestone 1: Live Cartesia/Gemini Runtime Behind Explicit Gate

Goal: implement real provider transports without making live the default.

Issue candidates:

1. Implement Cartesia Ink authenticated WebSocket STT transport.
2. Implement Gemini streaming transport using `gemini-3.5-flash` as configured, including function-call continuation and usage parsing.
3. Implement Cartesia Sonic authenticated WebSocket TTS transport.
4. Fix live runner store binding and transcript finalization semantics.
5. Implement cancellation/barge-in across Ink, Gemini, Sonic, and browser writer.
6. Add opt-in live smoke harness with budget cap, timeout cap, and sanitized evidence.
7. Make `cartesia_gemini` selectable only after explicit live transport gate passes.

Acceptance:

- One opt-in live session reaches recap through `/ws`.
- Evidence proves STT transcript, Gemini tool execution, source/evaluation write, TTS audio, clean close.
- Default validation still requires no keys and no network.

### Milestone 2: Real Connected Voice Session UX

Goal: make the browser session feel like a voice tutor rather than a textarea with a microphone.

Issue candidates:

1. Build a connected session readiness ladder in UI.
2. Replace connected typed-answer primacy with mic-first turn state.
3. Show transcript only after agent STT finalization.
4. Play assistant audio from connected TTS/audio events after user gesture.
5. Clear queued audio and stale visual events on cancel/barge-in.
6. Add recoverable error actions: retry agent, check mic, return to upload, refresh ingestion.
7. Remove or clearly fence local-demo-only actions from connected sessions.

Acceptance:

- User can start a connected drill, answer aloud, see transcript, hear feedback, and reach recap.
- Local browser dictation is never mistaken for connected agent STT.
- Fake provider E2E and live opt-in smoke both use the same UI state machine.

### Milestone 3: Server-Owned Ingestion And Source-Grounded Questions

Goal: make student-provided material produce trusted study sessions.

Issue candidates:

1. Upgrade paste ingestion to produce bounded, source-specific excerpts.
2. Generate multiple concepts and questions from pasted material.
3. Ensure question selection comes from the active authorized study set.
4. Reject forged source/document/question tuples without writes.
5. Decide PDF scope: either paste-first internal MVP or real PDF upload P0.
6. If PDF stays P0, implement server-owned file ingestion states: pending, processing, ready, failed, retry.
7. Add source viewer moment for correction citations.

Acceptance:

- A non-fixture pasted study set can start a connected session and ask questions from that material.
- No hard-coded Biology fixture leaks into new study sets.
- Corrections cite bounded source spans and show low confidence when appropriate.

### Milestone 4: Learning Loop And Durable Study Product

Goal: complete the loop after a single call.

Issue candidates:

1. Persist sanitized session attempts, concept statuses, review items, recaps, and usage.
2. Prove Postgres parity with in-memory fake-provider behavior.
3. Build session history and library status from server state.
4. Implement server-owned review scheduling from misses, hints, exam proximity, and concept centrality.
5. Add recap-driven next action and next-session recommendation.
6. Add delete/export/privacy controls for study sets and sessions.

Acceptance:

- A student can finish a session, see what is strong/shaky/missed, and return for the next recommended session.
- Durable mode behaves like in-memory mode without raw audio/transcript/answer persistence.

### Milestone 5: Beta Hardening

Goal: make the product safe and operable for real testers.

Issue candidates:

1. Production fail-closed server boot for public binds without auth/origin config.
2. Session-token nonce replay protection.
3. Rate limits, session caps, max turn duration, and cost budgets.
4. Graceful shutdown and deploy draining.
5. Live provider failure matrix: provider timeout, auth failure, quota failure, cancellation, slow client.
6. Sanitized release evidence bundle in CI.
7. Deployment runbook for `https/wss`, managed Postgres, secret injection, health checks, smoke, rollback.

Acceptance:

- Public beta path cannot start unauthenticated voice sessions.
- Live failures degrade into explicit user states.
- Release evidence is reviewable without exposing sensitive content.

## Linear Translation Notes

Suggested project name: `Viva Product Requirements Completion`

Suggested milestone order:

1. Baseline Truth And Evidence
2. Live Cartesia/Gemini Runtime
3. Connected Voice Session UX
4. Server-Owned Ingestion And Source Grounding
5. Learning Loop And Durable Product
6. Beta Hardening

Suggested issue labels:

- `p0-live-runtime`
- `p0-voice-ux`
- `p0-ingestion`
- `p0-source-grounding`
- `p1-durable-product`
- `p1-release-evidence`
- `security`
- `privacy`
- `blocked-by-provider-docs`
- `no-secret-default`

## Global Stop Rules

- Do not claim live Cartesia/Gemini works until `/ready` reports selectable live provider and an opt-in live `/ws` session reaches recap.
- Do not put provider keys, raw audio, transcripts, answer text, full notes, prompts, or unrestricted source excerpts into logs, evidence, fixtures, or persistence.
- Do not require live provider keys, external network, mic hardware, Postgres, or user auth for default CI.
- Do not let browser-provided identity, source context, source tuples, or tool results authorize agent behavior.
- Do not let local demo dictation or fake-provider output masquerade as the real live tutor.
- Do not expand into dashboards, LMS integrations, payments, Google Drive, Canvas, or institutional admin work until the core oral recall loop works.

## Definition Of Done For This Roadmap

This roadmap is complete when a real tester can:

1. Upload or paste course material.
2. Wait for server-owned processing to become ready.
3. Start a connected voice recall drill.
4. Hear Viva ask a source-grounded question.
5. Answer out loud.
6. Receive spoken feedback, hint/correction, and a visible citation.
7. See concept status update.
8. Finish with a recap.
9. Return later for the recommended weak-concept review.

Until that works, Viva is still a strong prototype and not yet the PR doc's product.
