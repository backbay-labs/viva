# Code Review: Web live-session client libs

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | apps/web/lib/viva-agent-client.ts, apps/web/lib/viva-session-projection.ts, apps/web/lib/viva-audio-capture.ts, apps/web/lib/viva-audio-playback.ts, apps/web/lib/viva-display.ts, and their .test.ts files |
| **Verdict** | sound-with-fixes |
| **Confidence** | High |

This area is the browser half of the live oral-exam loop: a WebSocket session controller and reducer (`viva-agent-client.ts`), a pure projection layer ("the Conductor", `viva-session-projection.ts`) that maps the agent event stream onto the Listening Manuscript UI, and the mic-capture/TTS-playback audio plumbing. The architecture held up under adversarial verification: the generation model, staleness gating, identity-based audio acks, and redaction posture are correct and well-tested against the shared voice-protocol fixtures. Two important findings survive — one unsanitized error ingress that also misclassifies parse failures as auth failures, and the absence of any automatic reconnect policy for unclean closes — plus eight contained minors. One first-pass important finding (structured_error treated as wrongly terminal) was substantially refuted against the Rust server and downgraded: the server never emits that frame mid-session, and every brain error is terminal server-side.

## Strengths

- Generation model for socket lifecycles is excellent: every reconnect mints a generation, all client frames carry `client_generation_id`, and `isActiveSocketGeneration` gates every socket handler so stale open/message/close/error events from prior sockets cannot corrupt state (`apps/web/lib/viva-agent-client.ts:793-883`), with real regression tests for stale-socket and refresh races (`viva-agent-client.test.ts:735-853`).
- The reducer's response-id staleness gate and cancellation handling are unusually careful: cancelling the active turn discards the whole examiner-artifact set (source, evaluation, concept status, audio, intents) with a comment explaining the folio-bleed fallback chain it prevents (`viva-agent-client.ts:703-736`), all verified against the same JSON fixtures the Rust agent tests consume (`agent/fixtures/voice-protocol/*`).
- `acknowledgeAudio` drops consumed frames by object identity rather than positional count, with an explicit comment and a dedicated test reproducing the cancellation/ack race a `slice(count)` would lose (`viva-agent-client.ts:920-932`, `viva-agent-client.test.ts:361-380`).
- Defense-in-depth redaction: `sanitizeAgentError` + `redactForVivaLog`, a close-reason allowlist, and `sanitizeRuntimeDiagnostic` in the projection, with tests asserting tokens/transcripts never serialize into state or aria text (`viva-agent-client.test.ts:587-733`, `viva-session-projection.test.ts:652, 861, 923`).
- Audio capture lifecycle is disciplined: AudioWorklet-only (ScriptProcessor is asserted unused), devicechange and processor-error paths stop tracks, close the context, and remove listeners, and tests verify each of those effects rather than mocks of mocks (`viva-audio-capture.ts:414-436`, `viva-audio-capture.test.ts:187-255`).
- The Conductor projection is pure and honest: expected terms are provably hidden until the thinking phase (anti-spoiler reveal rule), unclean closes are never dressed up as finished sessions, and every BAC-510 terminal reason maps to contract-reconciled recovery copy (`viva-session-projection.ts:158-180, 846-915`; `viva-session-projection.test.ts:944-957, 1035-1067, 669-692`).

## Findings

### Important

**1. Message-handler catch pushes raw exception text into `errors`, bypassing `sanitizeAgentError` and tripping the auth classifier**

`apps/web/lib/viva-agent-client.ts:852-861`

**What**: When `parseVivaAgentMessage` throws, the catch appends `error.message` verbatim to `state.errors`. Every other error ingress (error frames, structured_error, close reasons) goes through `sanitizeAgentError` or an allowlist; this one does not. Browser `JSON.parse` errors embed a quoted snippet of the raw payload (Chromium: `Unexpected token 'N', ..."NADH dona"... is not valid JSON`; Safari: `JSON Parse error: Unexpected identifier "NADH"`), and `projectRuntimeCopy` classifies auth failure with the regex `/auth|token|claim|unauthori[sz]ed/i` over the raw, pre-sanitization text (`viva-session-projection.ts:219-220`).

**Why it matters**: A truncated or malformed server frame — realistic during exactly the provider failures this codebase works hardest to handle — produces two failures. On Chromium the word "token" in the V8 message triggers the auth-failed branch, so a protocol/parse failure renders "Auth failed / Refresh session" and drives the token-refresh recovery flow. On Safari/Firefox, where the parse message lacks auth keywords, the raw payload fragment flows into `marginaliaText` via the session-rejected branch (`viva-session-projection.ts:322-334`) — `sanitizeRuntimeDiagnostic` only filters specific keywords, so arbitrary transcript/answer fragments quoted by the JSON parser can render. This is the one gap in a redaction invariant the rest of the repo enforces with tests; no test covers the malformed-frame path.

**Fix**: In the message-handler catch, push a fixed sanitized string (e.g. "malformed server frame") or route the message through `sanitizeAgentError`. Separately, base the `authFailed` classification in `projectRuntimeCopy` on structured causes (the normalized close-reason allowlist / `legacyAgentAuthReasons`) instead of a keyword regex over free-form diagnostics. Add a test feeding truncated JSON through the socket that asserts no raw payload text serializes into state.

**2. No automatic reconnection or backoff anywhere in the client for unclean closes**

`apps/web/lib/viva-agent-client.ts:885-906`; `apps/web/components/session/LiveSessionPage.tsx:538-546`

**What**: The controller exposes `connect`/`refreshSession` with generation reasons including `"socket_retry"`, but nothing ever schedules a retry: an unclean close (1006, network blip, agent restart) lands in status "closed" and waits for the student to click "Retry agent". Automatic reconnects exist only for browser-lifecycle events (pageshow/popstate, `LiveSessionPage.tsx:271-289`). `openSocket` also resets the entire session state on every connect (`viva-agent-client.ts:844`), so even the manual retry discards transcript/conceptStatuses context and relies on the server to re-drive.

**Why it matters**: For a voice-first product, a transient Wi-Fi hiccup mid-answer terminates the flow into recovery copy; a single automatic, bounded retry would make most such blips invisible. The machinery (generations, the `socket_retry` reason, the refresh flow) is all present — only the policy is missing, and nothing in docs/ records manual-only as a decision. One server-side constraint verified during review: agent-service holds a one-active-session-per-user/study-set lease with a 250ms reconnect grace (`agent/crates/agent-service/src/ws.rs:49-51`; see the 2026-08-23 rust-agent-service review), so an instant retry can be denied with a `session_cap` terminal close — the retry policy needs jittered backoff that outlives lease release, which is more reason to design it deliberately rather than leave it to the student's click timing.

**Fix**: On unclean close (`isUnexpectedClose` semantics) schedule 1-3 auto-reconnects with jittered exponential backoff (first delay comfortably past the server's lease-release window) using reason `"socket_retry"`, stopping when a terminal reason or recap is present; keep the manual retry as the fallback. Document the choice if manual-only is intentional.

### Minor

**1. `sendText`/`sendAudio` collapse two different failures into one boolean, and the caller drops recorded turn audio on false**

`apps/web/lib/viva-agent-client.ts:821-832`; `apps/web/components/session/LiveSessionPage.tsx:496-501`

**What**: `sendSubmissionFrame` returns false both for "duplicate submit while pending" (benign, no state change) and "socket not open" (error state pushed). Callers cannot distinguish them. In `submitSpokenTurn` the captured PCM buffer is cleared (line 497) before `sendAudio` (line 499) and the return value is ignored, so if the socket died between the status check and the send — the reducer's `status` lags the socket's real `readyState`, which `sendFrame` checks — the student's entire spoken answer is silently discarded.

**Why it matters**: The one copy of the student's audio for the turn is destroyed on a failure path where it could have been retained for resubmission after reconnect; the student must re-record from scratch and gets no explanation beyond generic recovery copy.

**Fix**: Return a discriminated result (`"sent" | "pending" | "socket_closed"`) from `sendText`/`sendAudio`, and in the caller only clear `capturedTurnPcm16Ref` after a successful send (or stash the payload for one retry after reconnect).

**2. Mic stream and AudioContext leak if node construction throws after getUserMedia**

`apps/web/lib/viva-audio-capture.ts:380-393`

**What**: The cleanup try/catch ends at line 373. `context.createMediaStreamSource` (line 380) and `new AudioWorkletNodeCtor(...)` (line 389) run outside it; only the specific undefined-constructor case (384-388) stops tracks and closes the context. If either call throws (e.g. the worklet-node constructor throwing InvalidStateError/NotSupportedError in an odd browser), the error propagates with the mic tracks still live and the context open.

**Why it matters**: The browser's recording indicator stays lit with no capture actually running — a trust-breaking failure for a privacy-sensitive voice app — and the AudioContext leaks (browsers cap concurrent contexts). LiveSessionPage catches the error but has no handle to the tracks to stop them.

**Fix**: Extend the try to cover `createMediaStreamSource` and worklet-node construction (or wrap lines 380-393 in a second try/catch that stops tracks and closes the context before rethrowing). Incidentally, `moduleUrlCleanup` is invoked twice on the error path (catch at 367 and finally at 372) — harmless but worth tidying while there.

**3. Close-reason allowlist has drifted from the agent's actual close reasons**

`apps/web/lib/viva-agent-client.ts:993-1005`

**What**: agent-service closes with reason "study store unavailable" and "session token nonce store unavailable" (`agent/crates/agent-service/src/ws.rs`, the `study_store_unavailable`/`nonce_store_unavailable` `ClientFrameError` constructors around lines 3362-3379), neither of which is in `safeAgentCloseReasons`, so `safeCloseReasonForDisplay` renders them as "[redacted close reason]".

**Why it matters**: These are exactly the operational diagnostics the runtime copy wants to show ("Reason: ..." in the unexpected-close marginalia, and the Close readiness note). The user sees redaction noise for a safe, server-authored string. Impact is softened because the server also sends an error frame with the same message (verified: `send_json(&mut sender, &ServerFrame::error(error.message))` precedes the close), but the Close note still shows the redacted placeholder. Nothing ties the two lists together, so future server reasons will silently drift too.

**Fix**: Add the two missing reasons to `safeAgentCloseReasons`, and pin the list to the server via a shared fixture (like the voice-protocol fixtures) so a test fails when agent-service adds a close reason the web client would redact.

**4. `recap_ready` `partial_reason` is validated by the contract but dropped by the reducer**

`apps/web/lib/viva-agent-client.ts:696-697`

**What**: The v4 contract carries `partial_reason` on recap_ready (`packages/core/src/agent-contract.ts:236, 358-361`) and the server sets it on provider-failure partial recaps (`agent/crates/agent-service/src/ws.rs:1680`), but the reducer's recap_ready case stores only `event.recap`. The client learns the session was degraded solely from the separate trailing `session_phase(terminal_reason)` frame.

**Why it matters**: The server sends recap_ready first and the terminal session_phase immediately before closing; if the close races the last frame, the client holds a partial recap with no `terminalReason` and presents it as a normal completed session ("Closing fold ready", recapStats over empty concept arrays). The only hint is the server-authored headline text. Structured partial-ness is available in the event and thrown away.

**Fix**: Store `partial_reason` (e.g. `state.recapPartialReason`, also usable as a `terminalReason` fallback) and let `projectSessionQuestion`/`projectRuntimeCopy` render the degraded-recap state without depending on the trailing session_phase arriving.

**5. The `structured_error` reducer case encodes a semantic the server never exercises, and conflates app-level errors with transport status**

`apps/web/lib/viva-agent-client.ts:737-743`

**What** (downgraded from important — see verification notes): The reducer maps `structured_error` events to `status: "error"`, with a fresh ready frame the only path back to "open". Verification against agent-service shows the current server never sends this frame mid-session: `forward_brain_event` converts every `BrainEvent::Error` into a terminal outcome — `ProviderFailure` (partial recap + terminal session_phase + close) or `DurabilityDegraded` (terminal close, frame suppressed) — before the browser-event forwarding at `ws.rs:2027` is reached; the only place a `structured_error` frame is serialized is a protocol fixture test (`agent-service/src/protocol.rs:445`, fixture message "telemetry event suppressed"). So the client's fatal treatment happens to match today's server, where brain errors are always terminal.

**Why it matters**: The contract (`packages/core/src/agent-contract.ts:240`) still carries the frame with no terminality semantics, and the fixture's "telemetry event suppressed" message suggests an informational intent. If a future server version starts emitting structured_error non-terminally, one frame would flip `canSubmitAnswer` off and render session-rejected recovery copy on a live socket. The hazard is latent, not live — but the coupling of app-frame handling to transport status is the fragile part.

**Fix**: Either record structured_error in a separate app-error field (keeping `status` socket-owned, letting the projection decide severity) or pin the terminal-only semantics in the shared contract/fixtures so a server change fails a test instead of silently diverging from the client's assumption.

**6. Per-response cancel leaves stale `#nextStartTime` when other responses remain scheduled, creating dead-air gaps**

`apps/web/lib/viva-audio-playback.ts:316-320`

**What**: `#resetNextStartTime` only rewinds to `currentTime` when `#scheduled` is empty. A `cancel(responseId)` that removes mid-schedule frames while another response's frames remain keeps `#nextStartTime` at the end of the original (pre-cancel) schedule, so surviving frames play at their old late offsets and new frames are appended after the phantom gap.

**Why it matters**: In the interleaved case (next response's audio already scheduled when the previous response is cancelled) the user hears seconds of silence exactly at the barge-in moment the cancel was meant to tighten. Today the reducer's staleness gate makes cross-response interleaving rare, so this is latent — but it is the sink's contract to handle it, and nothing tests it.

**Fix**: On cancel, recompute `#nextStartTime` from the actually-scheduled surviving nodes (track each frame's startTime+duration in `ScheduledPlaybackFrame` and take the max), or reschedule survivors from `max(currentTime, earliest surviving start)`.

**7. Fallback resampler decimates without an anti-alias filter**

`apps/web/lib/viva-audio-capture.ts:104-133`

**What**: `resampleFloat32ToSampleRate` does linear interpolation only. Downsampling (e.g. 48kHz→24kHz when the browser ignores the requested AudioContext sampleRate) folds energy above 12kHz back into the band; the module's own test demonstrates the effect (a 12kHz tone aliasing to DC, `viva-audio-capture.test.ts:93-102`).

**Why it matters**: The primary path constructs the context at 24kHz so the browser resamples with proper filtering, making this a fallback-only concern (older Safari, exotic devices) — but on that path it degrades the STT signal feeding transcript confidence and grading.

**Fix**: Apply a cheap low-pass (or average adjacent input samples when ratio ≥ 2) before decimation in the downsampling case, or document that the fallback path is knowingly lo-fi.

**8. Dead branch in the session_phase reducer case and an always-empty `remainingQueue` in the playback scheduler**

`apps/web/lib/viva-agent-client.ts:637-644`; `apps/web/lib/viva-audio-playback.ts:280, 309`

**What**: The special case `if (event.terminal_reason && event.phase === "recap" && !state.recap)` returns an object identical-by-effect to the general return at 645-650 (which already computes `terminalReason: event.terminal_reason ?? state.terminalReason`), so the branch is unreachable-by-effect. Similarly, `#scheduleQueuedFrames` declares `remainingQueue` that nothing ever pushes to — every frame is scheduled or skipped — so `queue: remainingQueue` is always `[]`.

**Why it matters**: Both read as if they encode behavior they do not (a distinct terminal-recap path; partial scheduling), which will mislead the next editor of these carefully-commented state machines.

**Fix**: Delete the redundant session_phase branch; in the scheduler, set `queue: []` directly with a comment that scheduling always drains the queue (or actually retain cancelled-skip semantics if partial scheduling is ever intended).

## Verification notes

- **F2 (structured_error permanently flips status while the session continues) — downgraded from important to minor.** The claimed server behavior does not exist: `forward_brain_event` (`ws.rs:1961-1985`) early-returns `ProviderFailure` or `DurabilityDegraded` for every `BrainEvent::Error` before the `send_json`-then-`Continue` path at ~2027, both handled terminally by every caller (partial recap + terminal session_phase + close; the durability-degraded test even asserts `sender.sent.is_empty()`). The synthetic brain's `emit_store_error` call sites also `return` rather than keep examining, and grep confirms no non-test code path serializes a structured_error frame. The client's fatal mapping therefore matches current server semantics; the surviving issue is latent contract hygiene, recorded as Minor 5.
- **F1 confirmed, with a browser split**: Chromium parse messages contain "token" and hit the auth misclassification; Safari/Firefox messages skip the auth branch but deliver raw payload snippets to the session-rejected marginalia. Both harms verified in code; neither path is tested.
- **F3 confirmed** — no auto-retry exists anywhere (only pageshow/popstate lifecycle reconnects and the manual retry button), nothing in docs/ records manual-only as a decision, and the server's single-session lease + 250ms grace adds a real design constraint for the fix.
- **F9's dead branch verified** by comparing both return objects field-by-field; `remainingQueue` verified never-written.
- Minors F4, F5, F6, F7, F8, F10 all spot-checked against source (buffer cleared before unchecked send; both missing close reasons present in ws.rs constructors; `partial_reason: Some(...)` at ws.rs:1680 vs reducer storing only `event.recap`; capture try-block boundary at line 373; `#resetNextStartTime` guard; linear-interp resampler with its own aliasing test) — all confirmed as filed.
- No findings were fully refuted-and-dropped; one was downgraded.

## Recommendations

- Route every error string that can reach `state.errors` through `sanitizeAgentError` — the message-parse catch is the one unguarded ingress (Important 1); add a test that feeds truncated JSON through the socket and asserts no raw payload text serializes into state.
- Replace keyword-regex auth classification in `projectRuntimeCopy` with structured causes derived from the normalized close reason / legacy auth sets the client already maintains.
- Add a bounded, jittered auto-reconnect policy for unclean closes using the existing generation machinery (respecting the server's session lease grace), and preserve the captured turn payload across one reconnect so a spoken answer survives a blip.
- Pin the close-reason allowlist, the recap `partial_reason` handling, and structured_error terminality semantics to agent-service via shared fixtures (the voice-protocol fixture pattern already used) so contract drift fails a test instead of shipping as redaction noise or a latent client assumption.
- Extend the browser capture-source cleanup to cover node construction after getUserMedia so the mic indicator can never stay lit after a failed start.
- Consider a small integration test for the playback sink covering per-response cancel with a second response already scheduled (the `#nextStartTime` gap, Minor 6).

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first pass, though one of its three important findings was downgraded on server-side evidence). This is a carefully engineered client layer — the generation model, response-id staleness gating, identity-based audio acks, and reveal-timing rules are correct, well-commented, and tested against the same fixtures the Rust agent uses, and the redaction posture is enforced by tests almost everywhere. The two surviving important findings are real but local: one unsanitized error ingress that doubles as an auth misclassifier, and a missing reconnect policy whose machinery already exists; the minors are contained lifecycle and contract-drift edges with straightforward fixes.
