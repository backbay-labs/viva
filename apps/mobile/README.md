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
- Android Studio, an Android SDK, and `adb` for Android development

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

The unauthenticated loopback library currently reports its `start` action as unavailable because it
cannot mint a session capability without signed-session configuration. Home therefore shows the
real server study set but correctly disables **Begin recall**. For a trusted local fixture session,
open the route directly while the loopback agent is running:

```sh
xcrun simctl openurl booted 'viva://session?studySetId=biology-midterm'
```

This direct route is a development-only trusted-loopback seam. It must not be presented as a signed
bootstrap flow.

## Runtime configuration

All values are read at bundle time. `EXPO_PUBLIC_VIVA_AGENT_HTTP_URL` is optional; when omitted, it
is derived from the WebSocket URL by changing `ws`/`wss` to `http`/`https` and removing `/ws`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_VIVA_AGENT_WS_URL` | `ws://127.0.0.1:4318/ws` | Agent protocol-v4 WebSocket endpoint |
| `EXPO_PUBLIC_VIVA_AGENT_HTTP_URL` | derived | Agent readiness and library API base URL |
| `EXPO_PUBLIC_VIVA_USER_ID` | `user-1` | Library and session user identity |
| `EXPO_PUBLIC_VIVA_STUDY_SET_ID` | `biology-midterm` | Default fixture study set |
| `EXPO_PUBLIC_VIVA_SESSION_TOKEN` | unset | Signed session capability and WebSocket bearer subprotocol |
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
finishes and navigates to Recap in the same turn, so React may tear down the session before a
`speaking=true` DOM state is observable. The gate does not claim native playback, native capture,
or human audibility evidence.

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

## Device acceptance record — 2026-08-24 EDT

Source branch: `mobile-live-loop-v1`. The tested iOS app was a debug development build for bundle
`com.backbay.viva`, connected to a loopback `synthetic` agent at `127.0.0.1:4318`.

| Gate | Environment | Result | Evidence / limitation |
| --- | --- | --- | --- |
| Native build and link | iPhone 17 simulator, iOS 26.5 | PASS | CocoaPods installed `RNAudioAPI 0.13.3`; Xcode reported `BUILD SUCCEEDED`; the app installed and launched. |
| Library projection | Same simulator, loopback HTTP | PASS | Home rendered server title `Biology Midterm` and course `Biology 201`; start remained disabled because the server returned `session_token_unavailable`. |
| Typed live loop | Same simulator, direct trusted-loopback route | PASS | Canonical question appeared; first typed answer produced the grounded partial correction; **Try again** accepted a second, distinct typed answer and produced a second correction; **Complete session** rendered recap counts `2 strong / 1 shaky / 1 tomorrow` and the fixture source moment. |
| Local capture lifecycle | Same simulator | PARTIAL | The native permission prompt appeared and Allow led to `Listening locally`; Finish returned to typed fallback and reported `0 local frames`. Permission/session/teardown ran, but this simulator supplied no microphone samples. No audio was sent. |
| Interruption and recovery | Same simulator | PASS | A forced agent-process loss produced `PROVIDER DISCONNECTED` and disabled answer controls; after service restart, **Retry connection** returned to the canonical question. A separate graceful drain produced an honest terminal-only recap. |
| Examiner audio on native | Same simulator | NOT PROVEN | The synthetic provider emits no audio. The fake provider fixture contains only four PCM bytes, which is sufficient for deterministic queue tests but not human audibility confirmation. |
| Physical iPhone | Host inventory | BLOCKED | `xcrun xctrace list devices` reported only the Mac and simulators; no physical iPhone was attached. `iproxy` was also unavailable, so the required USB-loopback topology could not be established. |
| Android emulator/device | Host inventory | BLOCKED | No Android SDK directory or `adb` executable was present. `gradlew assembleDebug` could not resolve an SDK/`ANDROID_HOME`. |
| RN bearer-subprotocol acceptance | Physical-device signed flow | BLOCKED | No physical device was present. The proposed public signed-session setup also requires a durable nonce-protected store, and authenticated library REST calls need a separate bearer path not exposed by the current mobile config. A dummy first-frame token would not independently prove subprotocol delivery. |

The failed rows are acceptance failures, not waived checks. Stage 0 cannot be called fully
device-accepted until at least one physical platform supplies audibility/cancellation confirmation,
actual capture sample-rate/frame-count evidence, agent-side proof of zero audio input, and a valid
static-bearer or signed-session subprotocol test. For a physical phone, prefer USB loopback tunneling.
The public-LAN alternative must first add durable signed-session storage and separate REST/WS bearer
configuration; binding `agent-service` publicly without those controls fails closed by design.

The source design brief and generated explorations live in
`docs/design-reference/mobile-design-brief.md` and `docs/design-reference/generated-mobile/`.
