# Live Cartesia/Gemini Definition

Status: authoritative for BAC-309 and M0 baseline evidence.
Date: 2026-06-18.

## Summary

Valid provider keys do not make Viva live. A Cartesia/Gemini runtime counts as live only after the readiness API reports a selectable live provider and one opt-in WebSocket session reaches `recap_ready` through the real provider cascade.

Live is Act 3 work. The default product proof remains the no-secret synthetic brain until the live transports, store binding, budget caps, and smoke evidence are complete.

## State Ladder

`configured` means the agent process recognizes a provider and has enough configuration shape to describe it in `/health/brain` and `/ready`. This may use placeholder key material in sanitized checks. It is not live proof.

`selectable` means the provider is allowed to open sessions through the runtime gate. A provider with `configured=true` and `selectable=false` must remain unavailable to users and to default validation.

`live_runtime` means the provider path is backed by real Cartesia/Gemini transports rather than synthetic or fake adapters. This flag is necessary, but still not sufficient by itself.

`full live session proof` means both of these are true:

1. `/ready` succeeds for `cartesia_gemini` with `configured=true`, `selectable=true`, and `live_runtime=true`.
2. One opt-in `/ws` session reaches a sanitized terminal `recap_ready` event through the real provider cascade.

## Required Live Cascade

The required live cascade is:

browser PCM -> Rust `/ws` -> Cartesia Ink STT -> Gemini streaming/tool loop -> Cartesia Sonic TTS -> browser audio/source/recap Conductor events -> `apps/web/lib/viva-session-projection.ts` -> Listening Manuscript.

The session evidence must show the Conductor event stream that the manuscript consumes: transcript finalization from the provider STT path, Gemini/tool-loop evaluation and source writes, Sonic audio playback events, source folio events, concept status events, and a recap event. Evidence must be opt-in, budget-capped, timeout-capped, and sanitized.

## What Does Not Count As Live

The default synthetic brain in `agent/crates/agent-adapters/src/synthetic.rs` does not count as live. It is the no-key Act 1 proof path and is allowed to drive the Listening Manuscript without provider keys, network, mic hardware, or Postgres.

The fake Cartesia/Gemini adapter does not count as live. It is a deterministic replay path for provider-shaped tests and browser evidence.

Client-only mic amplitude, dictation, RMS, or VAD state does not count as live. Per Decision 3, amplitude/VAD are client-only; `apps/web/lib/viva-voice-level.ts` may animate the manuscript bloom, but it is not Cartesia Ink STT and it is not evidence that the live provider worked.

Browser-provided identity, source context, source tuples, local tool results, local transcripts, or local recaps do not count as live provider authority.

## No-Secret Default Rule

Default validation must remain no-key, no-network, no-mic, and no-Postgres. `bun run validate`, `bun run release:check`, and browser-story evidence may exercise `synthetic` and `fake_cartesia_gemini`; they must not require live Cartesia/Gemini keys or external provider calls.

The live smoke harness must remain opt-in. It may never record provider keys, bearer tokens, raw provider responses, raw audio, transcript text, answer text, prompts, full notes, or unrestricted source excerpts.

## Current Baseline

The 2026-06-16 baseline state for `cartesia_gemini` is:

- `/health/brain`: `configured=true`, `selectable=false`, `live_runtime=false`, status unavailable.
- `/ready`: HTTP 503.

That baseline means the live provider is configured enough to be described and gated, but it is not selectable, not a live runtime, and not proven by a full live session. This is intentional until Act 3 opens the gate.

See also `docs/superpowers/specs/provider-readiness-matrix.md`, which records the sanitized matrix evidence and the no-network gate proof.
