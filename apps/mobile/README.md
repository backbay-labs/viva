# Viva mobile

The Expo/React Native client for Viva's voice-first study loop. This scaffold expresses the
Listening Manuscript as a native, one-handed flow:

1. begin recall from Today — the orb and the one full-width action both start it;
2. answer aloud or use the typed fallback;
3. inspect a source-grounded correction;
4. schedule the next review from the recap.

## Run it

From the repository root:

```sh
bun install
bun run dev:mobile
```

Then press `i` for the iOS simulator, `a` for Android, or `w` for the web preview. The app is
on Expo SDK 57. During Expo's SDK 57 transition, use a simulator or development build if the public
Expo Go store build has not yet moved beyond SDK 54.

## Validate it

```sh
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test
bun run --cwd apps/mobile build
```

## Development notes

- The floating blue gear over the app in development is Expo Go's dev-menu button, not part of
  the app. It does not appear in production builds.
- On the iOS Simulator, `expo-audio`'s recorder start can stall the JS thread for over a minute
  before recovering (an upstream simulator quirk; real devices are unaffected). The session has
  an 8s watchdog that falls back to the typed answer with honest recovery copy when the
  microphone start hangs softly.

## Current boundaries

- Microphone permission and local recording use `expo-audio`; recording begins only after an
  explicit tap.
- The evaluation delay and correction are synthetic design data. They exercise the UI state
  machine but do not claim server truth.
- The next integration step is a mobile client for Viva's existing signed session bootstrap and
  24 kHz PCM WebSocket protocol.
- Document picking is real and local; durable study-set ingestion still belongs to the
  server-authoritative library API.

The source design brief and generated explorations live in
`docs/design-reference/mobile-design-brief.md` and `docs/design-reference/generated-mobile/`.
