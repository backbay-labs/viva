# Mobile Live Loop v1 — Stage 0 Design

**Date:** 2026-08-24
**Status:** Draft for owner review
**Program:** `docs/superpowers/specs/2026-08-24-mobile-fullstack-program.md`
**Implementation plan:** `docs/superpowers/plans/2026-08-24-mobile-live-loop-plan.md`

## 1. What Stage 0 delivers

`apps/mobile` runs the real learner loop against a LAN-local stack:

1. Home and Library render the **real library snapshot** from the agent's `/study-sets/library`.
2. "Begin recall" opens a **real WebSocket session** (`session_config → ready → question_started`), with the trusted fixture identity in unsigned dev mode.
3. The learner answers **by typing**; the agent evaluates; the correction screen renders the real `answer_evaluated` (label, concise feedback, retry prompt, source excerpt + confidence) and `source_reference` events.
4. The **examiner speaks**: `audio_delta` frames from `fake_cartesia_gemini` play through a native audio sink, gapless, with barge-in-capable cancellation and an output level that drives the orb bloom.
5. The mic pipeline runs end-to-end **up to (not including) submission**: native capture → 24 kHz PCM16 20 ms frames → turn ledger + live input level. Spoken-turn submission stays behind a disabled feature seam until protocol v5 lands (program constraint #2).
6. `recap_ready` drives the real recap screen; the FSRS review plan derives exactly as the web derives it.
7. Failures are honest: connection status, the 16 terminal reasons, and the allowlisted close reasons map to the manuscript recovery copy in `@viva/core`.

Non-goals for Stage 0: spoken-turn submission (v5), signed sessions, hosted agents, ingestion, accounts, store persistence changes.

## 2. Architecture

```
apps/mobile/src/
  runtime/
    globals.ts            # base64 atob/btoa install (only if missing), env access
    config.ts             # EXPO_PUBLIC_* → typed AppConfig (ws url, http url, identity)
  agent/
    web-lib.d.ts + aliases  # tsconfig paths + metro config → apps/web/lib (read-only reach-in)
    session-store.ts      # tiny module store handing recap/session results across screens
    use-mobile-viva-session.ts  # thin wrapper over useVivaAgentSession: config injection,
                          #   AppState reconnect, StrictMode-safe deferred connect
  audio/
    playback-context.ts   # VivaAudioContextLike factory over react-native-audio-api
    playback.ts           # sink construction + drainAgentAudio wiring + output level
    capture-source.ts     # VivaAudioCaptureSource over AudioRecorder (Float32 frames + rms)
    capture.ts            # startVivaPcm16StreamingCapture wiring, turn ledger, level meter
  library/
    library-client.ts     # fetchVivaLibrarySnapshot with explicit apiBaseUrl + projection
  app/ (existing routes)  # index/session/recap/library rewired to real state
```

Data flow (session):

```
AudioRecorder ──Float32──▶ capture-source ──▶ startVivaPcm16StreamingCapture
                                   │ (pure, shared)        │ 20ms pcm16 frames
                                   ▼                        ▼
                             level → orb bloom        turn ledger (Stage 1: v5 chunks)
text input ─────────────────────────────▶ controller.sendText
                                            │
                createVivaAgentSessionController (shared) ── WS ──▶ agent-service
                                            │ state
                     useVivaAgentSession → deriveVivaAgentUiState (shared)
                                            │ derived
                     session screen (existing manuscript UI, real states)
                                            │ audio[] + cancellations
                     drainAgentAudio (shared) ──▶ VivaAudioPlaybackSink
                                                      │ contextFactory
                                     react-native-audio-api AudioContext → speaker
```

## 3. Toolchain: development builds

`react-native-audio-api` is a native module, so Expo Go is retired for this app.

- Add `react-native-audio-api` via `bunx expo install`; register its config plugin (`app.plugin.js` ships in the package) in `app.json` with iOS microphone/background-audio settings left at defaults (mic permission copy already exists in the `expo-audio` plugin block; both plugins coexist — `expo-audio` stays until the old recorder path is deleted, then is removed).
- `bunx expo prebuild` output stays gitignored (`/ios`, `/android` already in `apps/mobile/.gitignore`); builds run with `bunx expo run:ios` / `run:android`. Add `dev:mobile:build:ios` root script only in Stage 1 if wanted (root manifests are lane-owned now — program §5).
- The Metro config gains monorepo `watchFolders` for `apps/web/lib` + `packages` (bun workspaces already hoist; Expo SDK 57 handles workspace resolution, but the reach-in needs the explicit folder).

## 4. Environment and configuration

`runtime/config.ts` reads only `EXPO_PUBLIC_*` (Expo inlines these at bundle time):

| Var | Default | Meaning |
| --- | --- | --- |
| `EXPO_PUBLIC_VIVA_AGENT_WS_URL` | `ws://127.0.0.1:4318/ws` | iOS simulator shares host loopback; devices/Android need the LAN IP / `10.0.2.2` |
| `EXPO_PUBLIC_VIVA_AGENT_HTTP_URL` | derived by stripping `/ws` (same rule as `vivaAgentHttpBaseUrl`) | REST base for library/readiness |
| `EXPO_PUBLIC_VIVA_USER_ID` | `user-1` | fixture identity |
| `EXPO_PUBLIC_VIVA_STUDY_SET_ID` | `biology-midterm` | fixture study set |
| `EXPO_PUBLIC_VIVA_SESSION_TOKEN` | unset | reserved for Stage 1 signed flows |
| `EXPO_PUBLIC_VIVA_WS_ORIGIN` | unset | reserved: explicit `Origin` header literal for allowlisted hosted agents (D-M9) |

The shared client's `NEXT_PUBLIC_*` reads are irrelevant on mobile: every entry point (`connectVivaAgent`, `fetchVivaLibrarySnapshot`, controller options) takes explicit `url`/`apiBaseUrl` options, and mobile always passes them.

## 5. Shared-code consumption (reach-in list, RN-compat audit)

Stage 0 imports these modules read-only through `apps/mobile`-local tsconfig paths + metro aliases (e.g. `@viva-web/viva-agent-client` → `../web/lib/viva-agent-client`). Verified RN-compatible:

| Module | RN notes |
| --- | --- |
| `@viva/core` (root export) | Pure TS + `ts-fsrs`. No platform APIs. Used for contract, domain types, scheduling, recovery copy. |
| `apps/web/lib/viva-agent-client.ts` | No React/DOM. `WebSocketImpl` injectable; `crypto.randomUUID` guarded with fallback; `process.env` guarded; `window.location` guarded (mobile passes `apiBaseUrl` explicitly). `base64Url()` uses `TextEncoder` + `btoa` — covered by the runtime shim (§5a). RN's WebSocket accepts `(url, protocols)`; a Stage 0 spike test asserts the `viva-voice` + `bearer.*` subprotocols reach the local agent from RN (D-M9 fallback: token in `session_config` only, which unsigned dev doesn't need anyway). |
| `apps/web/lib/use-viva-agent-session.ts` | Pure React (19.2.3 both sides). `"use client"` banner is inert under Metro. |
| `apps/web/lib/viva-audio-capture.ts` | Pure functions + `VivaAudioCaptureSource` seam; the browser source is simply not imported. `btoa`/`atob` fall back paths covered by the shim. |
| `apps/web/lib/viva-audio-playback.ts` | Pure queue + `VivaAudioContextLike` seam. |
| `apps/web/components/session/LiveSessionPage.tsx` → **only** the exported pure helpers `drainAgentAudio`, `pcm16ChunksToBase64` | If importing from a `.tsx` page proves noisy under Metro, these two ~20-line functions are re-implemented in `apps/mobile` with unit parity tests — the one sanctioned duplication, flagged for the Stage 1 extraction. |
| `apps/web/lib/viva-display.ts` | `recapPlanFromSessionEvents` for FSRS parity on the recap screen. Pure. |
| `apps/web/lib/viva-library.ts` | Snapshot types + `projectLibrarySnapshot`. Pure. |
| `apps/web/lib/viva-redaction.ts`, `viva-voice-level.ts` | Pure (transitively required). |

**Not consumed:** `viva-session-projection.ts` (the web manuscript Conductor — mobile's simpler screens map `deriveVivaAgentUiState` directly; adopting the full projection is a Stage 1 option), `viva-session-entry.ts` (URL/hash handling is web-shaped), anything from `@viva/ui-web`.

### 5a. Runtime shim (`runtime/globals.ts`)

Installed once from the root layout before any shared import executes: pure-JS `atob`/`btoa` assigned to `globalThis` **only if absent** (Hermes availability varies by RN release; the shim makes it a non-question). Hot audio paths do not depend on it: playback decodes base64 natively (`decodePCMInBase64`) and capture encoding of 960-byte frames is trivial.

## 6. Session bootstrap and connection

Stage 0 runs unsigned against `bun run dev:agent` (loopback/LAN):

1. `use-mobile-viva-session` builds `AgentSessionConfig` via the shared `studySetToAgentSessionConfig` from the selected library row (or fixture defaults), with `source_context: []`/`active_concepts: []` — the server discards and re-derives them anyway (`sanitize_client_session_config`).
2. Controller options: `url` from config; no `token`; `sessionToken` null. First frame must arrive within the agent's 10 s window — the controller sends `session_config` on socket open, so this is automatic.
3. **StrictMode-safe connect** (spike-1 lesson, same as `LiveSessionPage.tsx:192-201`): connect deferred one tick from an effect whose cleanup cancels it, so dev double-mount opens exactly one socket.
4. **AppState lifecycle:** on background, close the socket (iOS suspends it anyway) and stop capture; on foreground with an unfinished session, `controller.refreshSession({ reason: "socket_retry" })` opens a fresh generation (existing reason value; no contract edit). If a recap already arrived, do nothing.
5. Readiness: the session screen surfaces `ready.brain`/`ready.store` (the `VivaReadyFrame`) the way the web does — provider name and non-durable-store honesty live in a quiet diagnostic row, not user-facing alarm copy.

## 7. Native playback sink

`audio/playback-context.ts` adapts `react-native-audio-api`:

```ts
import { AudioContext } from "react-native-audio-api";
export function createMobilePlaybackContextFactory() {
  return () => new AudioContext({ sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ }) as VivaAudioContextLike;
}
```

- The library implements the Web Audio surface `VivaAudioPlaybackSink` needs (`currentTime`, `sampleRate`, `destination`, `createBuffer`, `createBufferSource`, `createAnalyser`, `resume`, `close`). A conformance unit test asserts each member exists at runtime so a library upgrade that changes shape fails loudly.
- `audio/playback.ts` owns one sink per session screen: `unlock()` is called on the session's first pointer interaction for parity with web semantics (mobile has no autoplay gate, so unlock always succeeds); `drainAgentAudio` runs in the same effect shape as `LiveSessionPage.tsx:322-337` (cancellations first, then enqueue, then identity-based `acknowledgeAudio`); `getOutputLevel()` polls into the orb bloom at 80 ms except under reduced motion.
- iOS audio session: configured for playback + recording via the library's session options (`playAndRecord`, default speaker) at capture start; plain playback category before that.

## 8. Native capture source

`audio/capture-source.ts` implements the existing seam:

```ts
export function createMobileVivaAudioCaptureSource(options): VivaAudioCaptureSource
```

- Backed by `AudioRecorder` with `onAudioReady({ sampleRate: 24_000, bufferLength: 480, channelCount: 1 }, cb)` — the callback's Float32 buffer and its **actual** sample rate feed `onSamples(samples, sampleRateHz, { rms })`; the shared engine already resamples when the device refuses 24 kHz.
- Permission flow keeps the shipped UX: request on "Start listening" only; denial/failure feeds the existing typed-answer fallback with the existing honest copy (the 8 s watchdog stays).
- `stop()` tears down recorder + subscription; recorder errors surface through `onEnded("processor_error")`, mapping to the same mic-state copy as web.
- `audio/capture.ts` wires `startVivaPcm16StreamingCapture` exactly like the web: `onSampleFrame` → level meter → orb bloom; `onFrame` → **turn ledger** (`capturedTurnPcm16` array). Stage 0 stops here: `submitSpokenTurn` exists but is compiled behind `voiceTurnsEnabled(ready)` which is hard-false until the v5 controller APIs exist (Stage 1 flips it to consume `sendAudioChunk`/`endAudioTurn`). No v4 audio frame is ever sent (D-M2).

## 9. Voice-turn seam for Stage 1 (design-ahead, no implementation)

When Plan 03 publishes v5: the ledger already holds 20 ms/960-byte frames — exactly v5's production chunk size. Stage 1 replaces the ledger flush with streaming `sendAudioChunk` during capture + `endAudioTurn` on submit, honoring `VivaAudioSendResult` backpressure and `audio_turn_accepted` retention, all through the controller APIs Plan 03 adds. Barge-in: user speech during examiner audio → `controller.cancel()` + sink cancellation (both already exist). Native bootstrap admission (D-M10 proposal, for the web-api owner): `/api/viva-session/start` accepts requests without browser fetch-metadata **iff** they carry a valid `viva-bootstrap1.` capability token whose claims pin a `client: "mobile"` purpose — reusing the existing capability-token machinery rather than adding an auth system.

## 10. Screen integration

| Screen | Replaces | With |
| --- | --- | --- |
| Home (`index.tsx`) | hardcoded chip/weak-concept | snapshot study set title, exam label, weakest concept (from `study_sets[].concepts` misses/status); orb state reflects agent readiness probe (`fetchVivaAgentReadinessProbe`) |
| Session (`session.tsx`) | `session-machine.ts` synthetic reducer | shared controller + `deriveVivaAgentUiState`; phase→orb mapping (`connecting/thinking` → thinking palette, `listening`, `feedback/correction` → correcting, `recap` → complete); real question prompt; typed submit → `sendText`; correction view fed by `evaluation` (label→`correctionKind`, `conciseFeedback`, `retryPrompt`, source excerpt + confidence tint); hint = `question.followUp`; "Why this source" = `question.source.retrievalReason`; transcript echo = `finalTranscript` (+ low-confidence ochre note when `transcriptConfidence < 0.7`, matching web) |
| Recap (`recap.tsx`) | static ledger/moments | real `recap` via `session-store.ts`; counts from concept arrays; moments from `source_moments`; next-recall from `recapPlanFromSessionEvents(...).reviewPlan[0]`; terminal/partial reasons render the honest partial-recap copy |
| Library (`library.tsx`) | static rows + local picker append | `projectLibrarySnapshot` rows (title, status label, document summary, mastery counts, next review); Start action → session for that row; document picker stays but adds an honest "ingestion upload arrives with the library milestone" note instead of pretending to persist (D-M7) |

The `session-machine.ts` reducer and its tests are deleted with the rewiring (its phases are subsumed by the contract's); the mic-watchdog behavior migrates into the capture module's tests.

## 11. Failure and recovery model

- Connection: `status` (`connecting/open/closed/error`) renders the same three-way stage copy as web (`connecting` warm-up, clean close vs. interrupted based on `close.wasClean || terminalReason` — the BAC-466 lesson).
- Terminal reasons: the 16-value union maps through `@viva/core` `learner-recovery-copy` — every reason has copy; unknown close reasons display as the allowlisted set does on web (redacted otherwise).
- The agent's 45 s pre-answer idle timeout ends the session with `turn_cap` recap — the recap screen handles a recap-with-partial_reason identically to a completed one, labeled honestly.
- Socket errors mid-typed-submission clear `pendingSubmission` (controller already does) and re-enable the input.

## 12. Verification strategy

1. **Unit (bun test, `apps/mobile`):** capture-source framing math (device-rate → 24 kHz frames), playback-context conformance, drain parity (if helpers were duplicated), config parsing, session-store.
2. **Contract replay:** feed `agent/fixtures/voice-protocol/synthetic-study-session.json` and `fake-cartesia-gemini-study-session.json` server frames through reducer + derive + screen view-model mappers; assert the question/evaluation/recap view-models byte-match hand-derived expectations. This pins mobile to the same fixtures both languages already assert.
3. **E2E against the real agent:** extend the existing pattern (`scripts/e2e-browser.mjs` runs web+agent) with a mobile variant driving the **Expo web export** of `apps/mobile` via Playwright against a self-started `agent-service` — first `synthetic` (deterministic transcript → evaluation → recap), then `fake_cartesia_gemini` asserting `audio_delta` frames reach the sink state (`speaking` flips true). Script lives in `apps/mobile/scripts/` to respect root-script ownership.
4. **On-device gates (manual, checklisted in the plan):** iOS simulator dev build; physical-device run over LAN (agent bound to LAN with dev origin rules verified); Android emulator via `10.0.2.2`; examiner audio audible; mic level animates the bloom; airplane-mode mid-session shows honest interruption copy and recovers on retry.
5. Existing gates stay green: `bun run --cwd apps/mobile typecheck|lint|test|build`; root `bun run validate:ts` already runs the mobile workspace through turbo and must stay green throughout.

## 13. Acceptance criteria (Stage 0 done means)

- [ ] Dev build (not Expo Go) on iOS simulator + one physical platform completes: open app → real library → begin recall → real question → typed answer → real correction with source excerpt → try again → end → real recap with FSRS plan.
- [ ] Examiner voice from `fake_cartesia_gemini` audibly plays; cancellation stops it cleanly.
- [ ] Mic capture produces a valid 24 kHz PCM16 20 ms-frame ledger (asserted in tests) and live level; **no** audio frame is transmitted.
- [ ] Kill the agent mid-session → honest interruption copy → retry reconnects a fresh generation.
- [ ] All unit/contract/e2e suites green; typecheck/lint/build green; no edits outside `apps/mobile/**` + the three program docs.
