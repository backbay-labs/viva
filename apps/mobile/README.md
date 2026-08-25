# Viva mobile

Viva mobile is the Expo/React Native client for the Stage-0 Listening Manuscript. It uses the
server-owned study-set library, the shared protocol-v4 reducer and projections, a native playback
adapter, and the real recap returned by `agent-service`.

Stage 0 is deliberately typed-only. A tap on **Start listening** exercises native microphone
permission, audio-session setup, 24 kHz PCM16 framing, the bounded local ledger, and teardown, but
protocol v4 never transmits those frames. The UI always moves to the typed answer before it sends a
learner turn. Spoken-answer transmission remains gated on the protocol-v5 remediation milestone.

## Prerequisites

- Bun and the repository workspace dependencies
- Rust/Cargo for `agent-service`
- Xcode plus an installed iOS runtime for iOS development
- An Android SDK, API 36 ARM64 system image, and `adb` for Android development; Android Studio is
  optional when the command-line tools are installed

`react-native-audio-api` contains native code, so Expo Go is not a supported runtime. Use a
development build.

## Local development

From the repository root, start the loopback agent:

```sh
bun run dev:agent
```

In another terminal, build or launch the mobile development client:

```sh
bun run --cwd apps/mobile ios
# or, with a configured Android SDK/emulator:
bun run --cwd apps/mobile android
```

After the native app has been built once, Metro can be started independently:

```sh
bun run dev:mobile
```

The unauthenticated loopback library reports its `start` action as unavailable because it cannot
mint a session capability without signed-session configuration. Mobile admits only the exact
`user-1` / `biology-midterm` fixture when both configured endpoints are loopback, the server row is
server-owned and fully ready, its active sources are ready, and the server returns the exact
`session_token_unavailable` reason. **Begin recall** then enters the real session from Home without
minting a client token. Every other unsigned route fails closed. A protected deployment instead
uses the server-issued signed capability returned by the selected library row.

## Runtime configuration

All values are read at bundle time. `EXPO_PUBLIC_VIVA_AGENT_HTTP_URL` is optional; when omitted, it
is derived from the WebSocket URL by changing `ws`/`wss` to `http`/`https` and removing `/ws`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_VIVA_AGENT_WS_URL` | `ws://127.0.0.1:4318/ws` | Agent protocol-v4 WebSocket endpoint |
| `EXPO_PUBLIC_VIVA_AGENT_HTTP_URL` | derived | Agent readiness and library API base URL |
| `EXPO_PUBLIC_VIVA_REST_BEARER_TOKEN` | unset | Static bearer for library and readiness HTTP requests only |
| `EXPO_PUBLIC_VIVA_WS_BEARER_TOKEN` | unset | Static bearer encoded in the WebSocket upgrade subprotocol only |
| `EXPO_PUBLIC_VIVA_USER_ID` | `user-1` | Library and session user identity |
| `EXPO_PUBLIC_VIVA_STUDY_SET_ID` | `biology-midterm` | Default fixture study set |
| `EXPO_PUBLIC_VIVA_SESSION_TOKEN` | unset | Fallback first-frame session capability; a library-issued capability takes precedence |
| `EXPO_PUBLIC_VIVA_WS_ORIGIN` | unset | Explicit Origin header for an allowlisted non-loopback agent |

Changing an `EXPO_PUBLIC_*` variable requires a Metro restart or a fresh export.

## Validation

Run the deterministic mobile gates from the repository root:

```sh
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test
bun run --cwd apps/mobile build
bun run --cwd apps/mobile e2e:live
bun run validate:ts
```

`e2e:live` allocates free ports, starts the real Rust service, and runs the Expo-web UI against both
the `synthetic` and `fake_cartesia_gemini` providers. It asserts the canonical question,
evaluation, retry submission, recap, permitted outbound frame types, absence of audio input, and
receipt of the fake examiner-audio delta. This is browser integration evidence. The fake provider
emits only two PCM16 samples before its recap; the gate proves the browser sink transitions from
idle to speaking and back to idle/teardown, and the session defers recap navigation until queued
playback is idle. A two-minute fail-safe covers a stuck native completion callback. This does not
prove native playback, native capture, or human audibility.

## Stage-0 boundaries

- The mobile controller surface omits `sendAudio`; its always-used WebSocket wrapper rejects binary,
  malformed, unknown, and `audio` outbound frames. Permitted outbound types are `session_config`,
  `text`, `cancel`, and `stop`.
- Native capture starts only after an explicit learner tap, requests recording permission, configures
  `playAndRecord` with the default speaker, retains at most 45 seconds locally, and clears on stop,
  cancellation, backgrounding, generation reset, or teardown.
- Examiner PCM output uses `react-native-audio-api` through an explicit Web Audio compatibility
  adapter. Cancellation is applied before new frames are scheduled.
- Library and recap data are server-backed. The current library endpoint is metadata-only, so the
  client leaves concepts, mastery, exam date, excerpts, and recall plans unavailable rather than
  inventing them.
- The document picker is local preview only; choosing a file does not claim durable ingestion.
- Review-plan confirmation on Recap is local and nonpersistent until the scheduling milestone.

## Device acceptance record — 2026-08-25 EDT

Source branch: `mobile-live-loop-v1`. The tested native app was the debug development build for
bundle/application ID `com.backbay.viva`, connected through loopback to the real Rust
`agent-service`. Tests covered unsigned synthetic, protected signed-session, and abrupt-loss paths.

| Gate | Environment | Result | Evidence / limitation |
| --- | --- | --- | --- |
| Native build and link | iPhone 17 simulator, iOS 26.5 | PASS | CocoaPods installed `RNAudioAPI 0.13.3`; Xcode reported `BUILD SUCCEEDED`; the app installed and launched. |
| Android native build and link | `viva-api36`, Android 16/API 36 Google APIs ARM64 emulator | PASS | CLI SDK 36, Build Tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1, and emulator 37.1.11 were provisioned. Gradle completed 365 tasks in 9m47s, built the ARM64 native audio module, installed the APK, and launched it. |
| Library projection and entry | iOS and Android simulators, unsigned and protected loopback HTTP | PASS | Home rendered the server-owned `Biology Midterm` / `Biology 201` row. Unsigned exact-fixture admission and protected signed action both enabled **Begin recall**. Protected health/readiness calls and library calls used only the REST bearer. |
| Typed live loop | Android API 36 emulator, Home entry, real synthetic agent | PASS | Home → **Begin recall** produced the canonical grounded question. The first typed answer produced `Partially correct`; **Try again** accepted a distinct answer and produced `Mostly correct`; the source rendered `Lecture 5 · Slide 18`; **End** opened the real recap. The same correction/retry/recap loop was also exercised on the iOS simulator. |
| Local capture lifecycle | iOS 26.5 and Android API 36 simulators | PARTIAL | Both native permission paths reached `Listening locally` and returned to the typed fallback. Both reported exactly `0 local frames`; permission/session/teardown are proven, but nonzero samples are not. No audio was sent. |
| Interruption and recovery | Android API 36 and iOS simulators | PASS | Hard agent-process loss produced `PROVIDER DISCONNECTED`, disabled answer controls, exposed **Retry connection**, and returned to the grounded question after restart. Graceful drain produced an honest terminal-only recap instead of offering a false retry. |
| Examiner audio on native | Both simulators | NOT PROVEN | The synthetic provider emits no audio. The fake provider contains only four PCM bytes/two samples: enough to prove queue and speaking-state transitions, not human-audible examiner speech or audible cancellation. |
| Physical iPhone | Host inventory | BLOCKED | `xcrun xctrace list devices` reported only the Mac and simulators; no physical iPhone was attached. `iproxy` was also unavailable, so the required USB-loopback topology could not be established. |
| RN bearer-subprotocol acceptance | iOS 26.5 and Android API 36 simulators | PASS | On iOS, the native socket offered `viva-voice` plus a redacted bearer protocol, negotiated `viva-voice`, received `ready`, then correctly rejected an invalid first-frame token. On Android, protected Home loaded, the library minted a signed capability, the static WebSocket bearer passed upgrade, and the separate signed first-frame capability reached `Question ready`. No credential values were logged in the record. |
| Authoritative recap scheduling | Real server library row | BLOCKED | The library contract returns metadata counts but no concepts or server `next_review` evidence. Mobile deliberately maps `concepts: []`, so a real recap cannot prove the required FSRS next-review time without inventing data. |
| Clean-checkout dependency install | CI Bun 1.3.3, committed root lock | BLOCKED (P0) | The committed root `bun.lock` omits the `apps/mobile` workspace and its Expo/React Native/native-audio graph. Root `bun install --frozen-lockfile --dry-run` fails. The root lock owner must regenerate and commit the workspace lock; there is no reproducible app-local Bun lock workaround. |
| Deterministic live E2E | Expo web plus real Rust agent | PASS ×2 | Two final-state runs each passed synthetic (`4` typed client / `30` server frames) and fake-provider (`2` typed client / `15` server frames) phases; fake playback speaking was observable. |

The failed rows are acceptance failures, not waived checks. Stage 0 cannot be called fully
device-accepted until a physical platform proves the typed loop, human-audible playback and
cancellation, nonzero native capture alongside agent-side zero-audio receipt, and authoritative
next-review scheduling. Repository reproducibility also remains P0-blocked until the root lockfile
is regenerated by its owner. For a physical phone, prefer USB loopback tunneling. A public-LAN
alternative requires durable signed-session storage, explicit REST/WS credentials, and an origin
allowlist; `agent-service` otherwise fails closed by design.

The source design brief and generated explorations live in
`docs/design-reference/mobile-design-brief.md` and `docs/design-reference/generated-mobile/`.
