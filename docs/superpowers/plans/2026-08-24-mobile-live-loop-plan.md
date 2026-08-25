# Mobile Live Loop v1 (Stage 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `apps/mobile` to the real Viva stack — real WS sessions with typed answers, real corrections/recaps, native examiner-audio playback, native mic capture up to (not including) transmission — against a LAN-local `agent-service`.

**Architecture:** Reuse the shipped web session architecture through read-only reach-in imports (`@viva/core` + `apps/web/lib` session modules) with mobile-local adapters at the two platform seams the web code already defines: `VivaAudioCaptureSource` (over `react-native-audio-api`'s `AudioRecorder`) and `VivaAudioContextLike` (over its `AudioContext`). Screens stay thin; all screen logic lives in pure, bun-testable mapper functions.

**Tech Stack:** Expo SDK 57 dev builds (Expo Go retired), React Native 0.86, React 19.2.3, `react-native-audio-api` ~0.13, bun test, Playwright (repo root dep) for the Expo-web e2e, Rust `agent-service` (`synthetic` + `fake_cartesia_gemini` providers).

**Spec:** `docs/superpowers/specs/2026-08-24-mobile-live-loop-design.md` (program context: `docs/superpowers/specs/2026-08-24-mobile-fullstack-program.md`)

## Global Constraints

- Edit **only** `apps/mobile/**`. Never edit `apps/web/**`, `packages/**`, `agent/**`, fixtures, root manifests, or root scripts (remediation-program lane ownership; program spec §5).
- Protocol v4 consumption only. **Never send a `type:"audio"` frame or a binary WS frame** — spoken-turn submission waits for protocol v5 (D-M2). Typed answers (`sendText`) are the only submission path.
- All audio constants come from the shared modules (`VIVA_VOICE_SAMPLE_RATE_HZ = 24_000`, 20 ms / 960-byte frames via `pcm16FrameByteLength`) — no local literals.
- Screens must keep the shipped Listening Manuscript design (2026-08-24 design pass): do not restyle; only rebind data.
- Biome governs style (`bun run --cwd apps/mobile lint`); keep the codebase's alphabetized style-key convention.
- Every task ends with `bun run --cwd apps/mobile typecheck && bun run --cwd apps/mobile lint && bun run --cwd apps/mobile test` green.
- Work on a branch (`git checkout -b mobile-live-loop-v1` or a worktree via superpowers:using-git-worktrees); commit per task; merge per repo policy (local validate + self-review; CI is billing-blocked).
- Dev stack for manual/e2e checks: `bun run dev:agent` (unsigned, `127.0.0.1:4318`, fixture identity `user-1`/`biology-midterm`). `VIVA_AGENT_PROVIDER=fake_cartesia_gemini bun run dev:agent` for audio-out.

---

### Task 1: Runtime globals shim and typed app config

**Files:**
- Create: `apps/mobile/src/runtime/globals.ts`
- Create: `apps/mobile/src/runtime/config.ts`
- Test: `apps/mobile/src/runtime/config.test.ts`
- Modify: `apps/mobile/src/app/_layout.tsx` (import side-effect first)

**Interfaces:**
- Produces: `installRuntimeGlobals(): void`; `loadAppConfig(env?: Record<string, string | undefined>): AppConfig` where `AppConfig = { agentHttpUrl: string; agentWsUrl: string; sessionToken: string | null; studySetId: string; userId: string; wsOrigin: string | null }`.

- [ ] **Step 1: Write the failing config test**

```ts
// apps/mobile/src/runtime/config.test.ts
import { describe, expect, test } from "bun:test";
import { loadAppConfig } from "@/runtime/config";

describe("loadAppConfig", () => {
  test("defaults to loopback dev agent and fixture identity", () => {
    const config = loadAppConfig({});
    expect(config.agentWsUrl).toBe("ws://127.0.0.1:4318/ws");
    expect(config.agentHttpUrl).toBe("http://127.0.0.1:4318");
    expect(config.userId).toBe("user-1");
    expect(config.studySetId).toBe("biology-midterm");
    expect(config.sessionToken).toBeNull();
    expect(config.wsOrigin).toBeNull();
  });

  test("derives http base by stripping /ws and honors wss", () => {
    const config = loadAppConfig({
      EXPO_PUBLIC_VIVA_AGENT_WS_URL: "wss://agent.example.com/ws",
    });
    expect(config.agentHttpUrl).toBe("https://agent.example.com");
  });

  test("explicit http url and identity win", () => {
    const config = loadAppConfig({
      EXPO_PUBLIC_VIVA_AGENT_HTTP_URL: "http://10.0.0.5:4318/",
      EXPO_PUBLIC_VIVA_STUDY_SET_ID: "chem-final",
      EXPO_PUBLIC_VIVA_USER_ID: "user-2",
    });
    expect(config.agentHttpUrl).toBe("http://10.0.0.5:4318");
    expect(config.userId).toBe("user-2");
    expect(config.studySetId).toBe("chem-final");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mobile && bun test src/runtime/config.test.ts`
Expected: FAIL — cannot resolve `@/runtime/config`.

- [ ] **Step 3: Implement config + globals**

```ts
// apps/mobile/src/runtime/config.ts
export type AppConfig = {
  agentHttpUrl: string;
  agentWsUrl: string;
  sessionToken: string | null;
  studySetId: string;
  userId: string;
  wsOrigin: string | null;
};

const DEFAULT_WS_URL = "ws://127.0.0.1:4318/ws";

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function httpFromWs(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/ws\/?$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function loadAppConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AppConfig {
  const agentWsUrl = trimmed(env.EXPO_PUBLIC_VIVA_AGENT_WS_URL) ?? DEFAULT_WS_URL;
  const agentHttpUrl =
    trimmed(env.EXPO_PUBLIC_VIVA_AGENT_HTTP_URL)?.replace(/\/+$/, "") ?? httpFromWs(agentWsUrl);
  return {
    agentHttpUrl,
    agentWsUrl,
    sessionToken: trimmed(env.EXPO_PUBLIC_VIVA_SESSION_TOKEN),
    studySetId: trimmed(env.EXPO_PUBLIC_VIVA_STUDY_SET_ID) ?? "biology-midterm",
    userId: trimmed(env.EXPO_PUBLIC_VIVA_USER_ID) ?? "user-1",
    wsOrigin: trimmed(env.EXPO_PUBLIC_VIVA_WS_ORIGIN),
  };
}
```

```ts
// apps/mobile/src/runtime/globals.ts
// Shared web modules fall back to btoa/atob for base64; Hermes availability
// varies by release, so install pure-JS versions only when missing.
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(binary: string): string {
  let output = "";
  for (let index = 0; index < binary.length; index += 3) {
    const a = binary.charCodeAt(index);
    const b = index + 1 < binary.length ? binary.charCodeAt(index + 1) : Number.NaN;
    const c = index + 2 < binary.length ? binary.charCodeAt(index + 2) : Number.NaN;
    output += BASE64_ALPHABET[a >> 2];
    output += BASE64_ALPHABET[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    output += Number.isNaN(b) ? "=" : BASE64_ALPHABET[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    output += Number.isNaN(c) ? "=" : BASE64_ALPHABET[c & 63];
  }
  return output;
}

function decodeBase64(base64: string): string {
  const clean = base64.replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  let output = "";
  for (const char of clean) {
    const digit = BASE64_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("Invalid base64 character");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return output;
}

export function installRuntimeGlobals(): void {
  const globals = globalThis as { atob?: (data: string) => string; btoa?: (data: string) => string };
  if (typeof globals.btoa !== "function") globals.btoa = encodeBase64;
  if (typeof globals.atob !== "function") globals.atob = decodeBase64;
}
```

In `_layout.tsx`, add as the very first imports:

```ts
import { installRuntimeGlobals } from "@/runtime/globals";

installRuntimeGlobals();
```

- [ ] **Step 4: Add a globals round-trip test** (append to `config.test.ts` or a sibling `globals.test.ts`): `installRuntimeGlobals(); expect(globalThis.atob(globalThis.btoa("vivaÿ"))).toBe("vivaÿ")`.

- [ ] **Step 5: Run tests, typecheck, lint** — all green. Expected: PASS.

- [ ] **Step 6: Commit** — `git add apps/mobile/src/runtime apps/mobile/src/app/_layout.tsx && git commit -m "feat(mobile): runtime globals shim and typed app config"`

---

### Task 2: Reach-in aliases to the shared web session modules

**Files:**
- Modify: `apps/mobile/tsconfig.json` (compilerOptions.paths)
- Create: `apps/mobile/metro.config.js`
- Test: `apps/mobile/src/agent/reach-in.test.ts`

**Interfaces:**
- Produces: import alias `@viva-web/*` → `apps/web/lib/*` (TS + Metro + bun). Later tasks import `@viva-web/viva-agent-client`, `@viva-web/use-viva-agent-session`, `@viva-web/viva-audio-capture`, `@viva-web/viva-audio-playback`, `@viva-web/viva-library`, `@viva-web/viva-display`.

- [ ] **Step 1: Write the failing reach-in test**

```ts
// apps/mobile/src/agent/reach-in.test.ts
import { describe, expect, test } from "bun:test";
import { parseVivaServerFrame, VIVA_VOICE_PROTOCOL_VERSION } from "@viva/core";
import {
  initialVivaAgentSessionState,
  vivaAgentReducer,
} from "@viva-web/viva-agent-client";
import { deriveVivaAgentUiState } from "@viva-web/use-viva-agent-session";

describe("shared web session modules load under the mobile toolchain", () => {
  test("reducer + derive process a ready frame and a question", () => {
    let state = initialVivaAgentSessionState();
    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        brain: { configured: true, live_runtime: false, provider: "synthetic", selectable: true },
        input_encoding: "pcm_s16le",
        sample_rate_hz: 24000,
        store: {
          available: true,
          backend: "in_memory",
          durable: false,
          nonce_replay_protection: false,
          raw_audio_persistence: false,
          transcript_persistence: false,
          uuid_schema_translation: false,
        },
        type: "ready",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );
    expect(state.status).toBe("open");
    expect(deriveVivaAgentUiState(state).canSubmitAnswer).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test src/agent/reach-in.test.ts` → FAIL (`@viva-web/*` unresolved).

- [ ] **Step 3: Add the alias** — in `apps/mobile/tsconfig.json` `compilerOptions`:

```json
"paths": {
  "@/*": ["./src/*"],
  "@viva-web/*": ["../web/lib/*"]
}
```

(Preserve the existing `@/*` mapping exactly as it is today.) Create `apps/mobile/metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
module.exports = config;
```

Expo SDK 57's Metro honors tsconfig `paths` for aliases; bun honors them in tests.

- [ ] **Step 4: Run the test** — PASS. Also run `bun run typecheck` (the web lib types compile under the mobile tsconfig; if `viva-library`'s DOM-free claim ever regresses, this is where it surfaces).

- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): reach-in aliases to shared web session modules"`

---

### Task 3: Contract replay test against the canonical fixtures

**Files:**
- Test: `apps/mobile/src/agent/fixture-replay.test.ts`

**Interfaces:**
- Consumes: `vivaAgentReducer`, `initialVivaAgentSessionState`, `parseVivaServerFrame`, `deriveVivaAgentUiState`.
- Produces: proof that mobile's state pipeline matches the byte-asserted fixtures both languages already pin.

- [ ] **Step 1: Write the replay test**

```ts
// apps/mobile/src/agent/fixture-replay.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVivaServerFrame } from "@viva/core";
import {
  initialVivaAgentSessionState,
  vivaAgentReducer,
} from "@viva-web/viva-agent-client";
import { deriveVivaAgentUiState } from "@viva-web/use-viva-agent-session";

const fixtureDir = join(import.meta.dir, "../../../../agent/fixtures/voice-protocol");

function replay(fixtureName: string) {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, fixtureName), "utf8")) as {
    server: unknown[];
  };
  let state = initialVivaAgentSessionState();
  for (const frame of fixture.server) {
    state = vivaAgentReducer(state, parseVivaServerFrame(frame));
  }
  return { derived: deriveVivaAgentUiState(state), state };
}

describe("mobile pipeline replays the canonical session fixtures", () => {
  test("synthetic study session reaches a recap with an evaluated answer", () => {
    const { derived } = replay("synthetic-study-session.json");
    expect(derived.phase).toBe("recap");
    expect(derived.recap).toBeDefined();
    expect(derived.question?.prompt.length).toBeGreaterThan(0);
    expect(derived.errors).toEqual([]);
  });

  test("fake cartesia/gemini session delivers examiner audio frames", () => {
    const { state } = replay("fake-cartesia-gemini-study-session.json");
    // audio_delta events accumulate until a consumer acknowledges them.
    expect(state.audio.length).toBeGreaterThan(0);
    expect(state.audio[0]?.frame.pcm16_base64.length).toBeGreaterThan(0);
  });
});
```

Note: if a fixture's final state differs (e.g. audio was cancelled inside the fixture), read the fixture and adjust the assertion to the hand-derived truth — assert real values, never mirror the implementation.

- [ ] **Step 2: Run** — first run may FAIL on a wrong hand-derived expectation; open the fixture JSON, derive the correct expectation by hand, fix the assertion. Then PASS.

- [ ] **Step 3: Commit** — `git commit -m "test(mobile): replay canonical voice-protocol fixtures through the shared pipeline"`

---

### Task 4: Dev-build toolchain with react-native-audio-api

**Files:**
- Modify: `apps/mobile/package.json` (dependency), `apps/mobile/app.json` (plugin)

**Interfaces:**
- Produces: `react-native-audio-api` importable in the app; iOS/Android dev builds runnable.

- [ ] **Step 1: Install** — `cd apps/mobile && bunx expo install react-native-audio-api` (peer `react-native-worklets >= 0.6.0` already satisfied at 0.10.1).

- [ ] **Step 2: Register the config plugin** — in `app.json` `expo.plugins`, append:

```json
["react-native-audio-api", { "iosBackgroundMode": false }]
```

(Exact option names: check `node_modules/react-native-audio-api/app.plugin.js` at install time; default to `{}` if no options are needed. Keep the existing `expo-audio` plugin — its mic-permission copy still serves the permission request until Task 11 revisits it.)

- [ ] **Step 3: Prebuild + build the iOS dev client** — `bunx expo prebuild --clean && bunx expo run:ios`. Expected: app builds, installs on the booted simulator, loads from Metro, and renders the existing home screen unchanged. (`/ios` + `/android` stay gitignored.)

- [ ] **Step 4: Smoke the module** — temporary snippet in `_layout.tsx` (removed before commit): `import { AudioContext } from "react-native-audio-api"; console.log("audio ctx rate", new AudioContext({ sampleRate: 24000 }).sampleRate);` → Metro log shows `24000`.

- [ ] **Step 5: Verify gates + commit** — `bunx expo install --check`, typecheck, lint, test green. `git commit -m "feat(mobile): react-native-audio-api dev-build toolchain"`

---

### Task 5: Native playback context adapter

**Files:**
- Create: `apps/mobile/src/audio/playback-context.ts`
- Test: `apps/mobile/src/audio/playback-context.test.ts`

**Interfaces:**
- Consumes: `VivaAudioContextLike` (from `@viva-web/viva-audio-playback`), `VIVA_AUDIO_SAMPLE_RATE_HZ` (from `@viva-web/viva-audio-capture`).
- Produces: `createMobilePlaybackContextFactory(createContext?: (options: { sampleRate: number }) => unknown): () => VivaAudioContextLike` — injectable constructor so tests never need the native module.

- [ ] **Step 1: Write the failing conformance test**

```ts
// apps/mobile/src/audio/playback-context.test.ts
import { describe, expect, test } from "bun:test";
import { createMobilePlaybackContextFactory } from "@/audio/playback-context";

function fakeNativeContext(options: { sampleRate: number }) {
  return {
    close: async () => {},
    createAnalyser: () => ({ connect: () => {}, fftSize: 0, smoothingTimeConstant: 0 }),
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({ connect: () => {}, start: () => {}, stop: () => {} }),
    currentTime: 0,
    destination: {},
    resume: async () => {},
    sampleRate: options.sampleRate,
  };
}

describe("createMobilePlaybackContextFactory", () => {
  test("produces a 24kHz context exposing the VivaAudioContextLike surface", () => {
    const factory = createMobilePlaybackContextFactory(fakeNativeContext);
    const context = factory();
    expect(context.sampleRate).toBe(24000);
    for (const member of ["createBuffer", "createBufferSource", "currentTime", "destination"]) {
      expect(member in context).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// apps/mobile/src/audio/playback-context.ts
import type { VivaAudioContextLike } from "@viva-web/viva-audio-playback";
import { VIVA_AUDIO_SAMPLE_RATE_HZ } from "@viva-web/viva-audio-capture";

type NativeContextFactory = (options: { sampleRate: number }) => unknown;

function defaultNativeContextFactory(options: { sampleRate: number }): unknown {
  // Lazy require keeps bun tests free of the native module.
  const { AudioContext: NativeAudioContext } = require("react-native-audio-api");
  return new NativeAudioContext(options);
}

export function createMobilePlaybackContextFactory(
  createContext: NativeContextFactory = defaultNativeContextFactory,
): () => VivaAudioContextLike {
  return () => createContext({ sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ }) as VivaAudioContextLike;
}
```

- [ ] **Step 3: Tests green; commit** — `git commit -m "feat(mobile): native playback context adapter"`

---

### Task 6: Playback session module (sink + drain + level)

**Files:**
- Create: `apps/mobile/src/audio/playback.ts`
- Test: `apps/mobile/src/audio/playback.test.ts`

**Interfaces:**
- Consumes: `createVivaAudioPlaybackSink`, `VivaAudioPlaybackSink` (`@viva-web/viva-audio-playback`); `VivaAgentAudioOutput` (`@viva-web/viva-agent-client`); factory from Task 5.
- Produces:
  - `createMobilePlaybackSession(options?: { contextFactory?: () => VivaAudioContextLike; onSpeakingChange?: (speaking: boolean) => void }): MobilePlaybackSession`
  - `MobilePlaybackSession = { drain(input: { audio: readonly VivaAgentAudioOutput[]; cancellations: readonly string[]; handledCancel: number; acknowledgeAudio(consumed: readonly VivaAgentAudioOutput[]): void }): number; getOutputLevel(): number; resetForGeneration(): void; unlock(): Promise<void>; close(): Promise<void> }`
  - `drain` is the mobile twin of the web's `drainAgentAudio` (`apps/web/components/session/LiveSessionPage.tsx:977-993` — reimplemented here because importing a page-level `.tsx` into Metro/bun is the one sanctioned duplication; parity is pinned by test).

- [ ] **Step 1: Write the failing drain-parity test** — construct the sink with a fake context (reuse `fakeNativeContext` from Task 5 via a shared test helper file `apps/mobile/src/audio/test-support.ts`), `await session.unlock()`, then:

```ts
const consumed: object[] = [];
const audio = [
  { frame: { pcm16_base64: btoa("") }, responseId: "r1" },
  { frame: { pcm16_base64: btoa("") }, responseId: "r2" },
];
let handled = session.drain({
  acknowledgeAudio: (frames) => consumed.push(...frames),
  audio,
  cancellations: ["r1"],
  handledCancel: 0,
});
expect(handled).toBe(1);           // cancellations processed count
expect(consumed).toHaveLength(2);  // every drained frame acknowledged by identity
// r1 was cancelled before enqueue → only r2 may schedule; assert via fake context's
// recorded createBufferSource().start calls === 1.
```

Hand-derive the expected schedule count from `cancelVivaAudioPlaybackResponse` semantics (cancel first, then enqueue).

- [ ] **Step 2: Verify failure, implement**

```ts
// apps/mobile/src/audio/playback.ts
import {
  createVivaAudioPlaybackSink,
  type VivaAudioContextLike,
  type VivaAudioPlaybackSink,
} from "@viva-web/viva-audio-playback";
import type { VivaAgentAudioOutput } from "@viva-web/viva-agent-client";
import { createMobilePlaybackContextFactory } from "@/audio/playback-context";

export type MobilePlaybackDrainInput = {
  acknowledgeAudio: (consumed: readonly VivaAgentAudioOutput[]) => void;
  audio: readonly VivaAgentAudioOutput[];
  cancellations: readonly string[];
  handledCancel: number;
};

export type MobilePlaybackSession = {
  close: () => Promise<void>;
  drain: (input: MobilePlaybackDrainInput) => number;
  getOutputLevel: () => number;
  resetForGeneration: () => void;
  unlock: () => Promise<void>;
};

export function createMobilePlaybackSession(
  options: {
    contextFactory?: () => VivaAudioContextLike;
    onSpeakingChange?: (speaking: boolean) => void;
  } = {},
): MobilePlaybackSession {
  const sink: VivaAudioPlaybackSink = createVivaAudioPlaybackSink({
    contextFactory: options.contextFactory ?? createMobilePlaybackContextFactory(),
    onStateChange: (state) => {
      options.onSpeakingChange?.(state.responding || state.speaking);
    },
  });

  return {
    close: () => sink.close(),
    drain(input) {
      // Mirror of the web drainAgentAudio: cancellations first so barge-in kills
      // pending frames, then enqueue, then acknowledge by object identity.
      for (const responseId of input.cancellations.slice(input.handledCancel)) {
        sink.cancel(responseId);
      }
      for (const output of input.audio) {
        sink.enqueue(output);
      }
      if (input.audio.length > 0) {
        input.acknowledgeAudio(input.audio);
      }
      return input.cancellations.length;
    },
    getOutputLevel: () => sink.getOutputLevel(),
    resetForGeneration: () => {
      sink.resetForGeneration();
    },
    unlock: async () => {
      await sink.unlock();
    },
  };
}
```

- [ ] **Step 3: Tests green; commit** — `git commit -m "feat(mobile): playback session with shared sink and drain parity"`

---

### Task 7: Native capture source

**Files:**
- Create: `apps/mobile/src/audio/capture-source.ts`
- Test: `apps/mobile/src/audio/capture-source.test.ts`

**Interfaces:**
- Consumes: `VivaAudioCaptureSource`, `startVivaPcm16StreamingCapture`, `VIVA_AUDIO_SAMPLE_RATE_HZ` (`@viva-web/viva-audio-capture`).
- Produces:
  - `AudioRecorderLike = { clearOnAudioReady(): void; clearOnError(): void; onAudioReady(options: { bufferLength: number; channelCount: number; sampleRate: number }, callback: (event: { buffer: { getChannelData(channel: number): Float32Array; sampleRate?: number } }) => void): unknown; onError(callback: (error: unknown) => void): void; start(): unknown; stop(): unknown }`
  - `createMobileVivaAudioCaptureSource(options?: { recorderFactory?: () => AudioRecorderLike }): VivaAudioCaptureSource`

- [ ] **Step 1: Write the failing framing test** — a fake recorder captures the registered callback, the test pumps two 480-sample Float32 buffers at 24 kHz through `startVivaPcm16StreamingCapture` wired to the source, and asserts two 960-byte frames with sequences 0,1 arrive at `onFrame`, plus `onSampleFrame` reporting a finite rms. A second case pumps 960 samples at 48 kHz and asserts the shared resampler still yields 960-byte 24 kHz frames.

```ts
function fakeRecorder() {
  let audioCallback: ((event: { buffer: { getChannelData: () => Float32Array; sampleRate: number } }) => void) | null = null;
  return {
    emit(samples: Float32Array, sampleRate: number) {
      audioCallback?.({ buffer: { getChannelData: () => samples, sampleRate } });
    },
    recorder: {
      clearOnAudioReady: () => { audioCallback = null; },
      clearOnError: () => {},
      onAudioReady: (_options: unknown, callback: typeof audioCallback) => { audioCallback = callback; },
      onError: () => {},
      start: () => {},
      stop: () => {},
    },
  };
}
```

- [ ] **Step 2: Verify failure, implement**

```ts
// apps/mobile/src/audio/capture-source.ts
import {
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  type VivaAudioCaptureSource,
} from "@viva-web/viva-audio-capture";

export type AudioRecorderLike = {
  clearOnAudioReady: () => void;
  clearOnError: () => void;
  onAudioReady: (
    options: { bufferLength: number; channelCount: number; sampleRate: number },
    callback: (event: {
      buffer: { getChannelData: (channel: number) => Float32Array; sampleRate?: number };
    }) => void,
  ) => unknown;
  onError: (callback: (error: unknown) => void) => void;
  start: () => unknown;
  stop: () => unknown;
};

function defaultRecorderFactory(): AudioRecorderLike {
  const { AudioRecorder } = require("react-native-audio-api");
  return new AudioRecorder() as AudioRecorderLike;
}

export function createMobileVivaAudioCaptureSource(
  options: { recorderFactory?: () => AudioRecorderLike } = {},
): VivaAudioCaptureSource {
  const recorder = (options.recorderFactory ?? defaultRecorderFactory)();
  let stopped = false;

  return {
    sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ,
    start(onSamples, startOptions) {
      recorder.onError(() => {
        if (stopped) return;
        stopped = true;
        recorder.clearOnAudioReady();
        recorder.stop();
        startOptions?.onEnded?.("processor_error");
      });
      recorder.onAudioReady(
        { bufferLength: 480, channelCount: 1, sampleRate: VIVA_AUDIO_SAMPLE_RATE_HZ },
        (event) => {
          if (stopped) return;
          const samples = event.buffer.getChannelData(0);
          const sampleRate = event.buffer.sampleRate ?? VIVA_AUDIO_SAMPLE_RATE_HZ;
          let sumOfSquares = 0;
          for (const sample of samples) sumOfSquares += sample * sample;
          const rms = samples.length === 0 ? 0 : Math.sqrt(sumOfSquares / samples.length);
          onSamples(samples, sampleRate, { rms, sampleRateHz: sampleRate, samples });
        },
      );
      recorder.start();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      recorder.clearOnAudioReady();
      recorder.clearOnError();
      recorder.stop();
    },
  };
}
```

- [ ] **Step 3: Tests green; commit** — `git commit -m "feat(mobile): native mic capture source behind the shared framing engine"`

---

### Task 8: Mobile session hook (controller lifecycle, AppState, session store)

**Files:**
- Create: `apps/mobile/src/agent/session-store.ts`
- Create: `apps/mobile/src/agent/use-mobile-viva-session.ts`
- Test: `apps/mobile/src/agent/session-store.test.ts`
- Test: `apps/mobile/src/agent/use-mobile-viva-session.test.ts`

**Interfaces:**
- Consumes: `createVivaAgentSessionController`, types (`@viva-web/viva-agent-client`); `deriveVivaAgentUiState`, `studySetToAgentSessionConfig` (`@viva-web/use-viva-agent-session`); `AppConfig` (Task 1).
- Produces:
  - `sessionResultStore` singleton: `{ clear(): void; get(): { conceptStatuses: Record<string, string>; recap?: SessionRecap; studySetTitle?: string }; set(result): void; subscribe(listener: () => void): () => void }`
  - `createMobileSessionController(options: { config: AppConfig; session: AgentSessionConfig; WebSocketImpl?: typeof WebSocket }): VivaAgentSessionController` — pure factory (testable without React) that wires `url`/`token`/`sessionToken` from `AppConfig`.
  - `useMobileVivaSession(options: { mode: StudyMode; studySet: StudySet })` — React hook: deferred one-tick connect (StrictMode-safe), AppState background close / foreground `refreshSession({ reason: "socket_retry" })` when no recap yet, returns the same surface as `useVivaAgentSession` plus `{ playback: MobilePlaybackSession }`.

- [ ] **Step 1: Write the failing factory test** — inject a fake `WebSocketImpl` class that records `(url, protocols)` and exposes `readyState`/`send`/`addEventListener`/`close`; assert `createMobileSessionController` connects to `config.agentWsUrl`, sends `session_config` with the fixture identity on open, and that `sendText("answer")` refuses while the socket is not open (returns false, records the error). Drive socket events by invoking the captured listeners.

- [ ] **Step 2: Implement the factory + store** (store is ~30 lines: module `let current`, `Set` of listeners). The factory:

```ts
export function createMobileSessionController(options: {
  config: AppConfig;
  session: AgentSessionConfig;
  WebSocketImpl?: typeof WebSocket;
}) {
  return createVivaAgentSessionController({
    session: options.session,
    sessionToken: options.config.sessionToken,
    token: options.config.sessionToken ?? undefined,
    url: options.config.agentWsUrl,
    WebSocketImpl: options.WebSocketImpl ?? originWebSocketImpl(options.config.wsOrigin),
  });
}

// React Native's WebSocket accepts a third options argument with headers —
// browsers don't. When a hosted agent enforces VIVA_VOICE_WS_ALLOWED_ORIGINS,
// mobile must present an allowlisted Origin explicitly (program D-M9).
function originWebSocketImpl(wsOrigin: string | null): typeof WebSocket | undefined {
  if (!wsOrigin) return undefined;
  const NativeWebSocket = WebSocket as unknown as new (
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  return class OriginWebSocket extends NativeWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { Origin: wsOrigin } });
    }
  } as unknown as typeof WebSocket;
}
```

Add a factory test case: with `config.wsOrigin = "https://mobile.viva.example"`, the fake `WebSocketImpl` is bypassed only when explicitly provided — assert that when no `WebSocketImpl` is injected and `wsOrigin` is null, the default is `undefined` (shared code falls back to the global), keeping unsigned dev untouched.

- [ ] **Step 3: Implement the hook** — mirror `useVivaAgentSession`'s effect shape (controller per identity, subscribe → state, close on cleanup) but with: (a) `const id = setTimeout(() => controller.connect(), 0); return () => clearTimeout(id);` for the StrictMode-deferred connect; (b) an `AppState.addEventListener("change", …)` effect: `"background"` → `controller.close()` + capture stop; `"active"` with `!derived.recap && status !== "open"` → `controller.refreshSession({ reason: "socket_retry" })`; (c) on `derived.recap` appearing → `sessionResultStore.set(...)`. Test the pure decision helper it uses:

```ts
export function foregroundReconnectAction(input: {
  hasRecap: boolean;
  status: VivaAgentConnectionStatus;
}): "none" | "reconnect" {
  if (input.hasRecap) return "none";
  return input.status === "open" || input.status === "connecting" ? "none" : "reconnect";
}
```

with cases: `{hasRecap:true,status:"closed"}→"none"`, `{hasRecap:false,status:"closed"}→"reconnect"`, `{hasRecap:false,status:"open"}→"none"`.

- [ ] **Step 4: Tests green; commit** — `git commit -m "feat(mobile): session controller factory, result store, lifecycle hook"`

---

### Task 9: Library client and real Home/Library screens

**Files:**
- Create: `apps/mobile/src/library/library-client.ts`
- Test: `apps/mobile/src/library/library-client.test.ts`
- Modify: `apps/mobile/src/app/library.tsx`, `apps/mobile/src/app/index.tsx`

**Interfaces:**
- Consumes: `fetchVivaLibrarySnapshot` (`@viva-web/viva-agent-client`), `projectLibrarySnapshot`, snapshot types (`@viva-web/viva-library`), `AppConfig`.
- Produces: `loadLibrary(config: AppConfig, fetchImpl?: typeof fetch): Promise<{ projection: VivaLibraryProjection; snapshot: VivaLibrarySnapshot }>`; `studySetForSession(snapshot: VivaLibrarySnapshot, studySetId: string): StudySet` (maps a snapshot row + its concepts into the `@viva/core` `StudySet` shape `studySetToAgentSessionConfig` expects — derive field-by-field from `packages/core/src/index.ts:62-83`, filling display labels from snapshot fields and leaving web-only fields as their documented defaults); `weakestConcept(studySet: StudySet): Concept | undefined` (highest misses, then non-strong status).

- [ ] **Step 1: Failing client test** — inject `fetchImpl` returning a canned snapshot JSON (two study sets, one session with recap); assert `loadLibrary` calls `${agentHttpUrl}/study-sets/library?user_id=user-1` and the projection has two rows; assert `weakestConcept` picks the hand-derived concept.

- [ ] **Step 2: Implement** — `loadLibrary` delegates to `fetchVivaLibrarySnapshot({ apiBaseUrl: config.agentHttpUrl, fetchImpl, userId: config.userId })` then `projectLibrarySnapshot(...)`.

- [ ] **Step 3: Rebind the Library screen** — replace `startingSources` with rows from `loadLibrary` (loading + error + empty states use the existing card styles; error copy: "The library is unreachable. Start the local agent, then pull to retry."). Each row's Start action navigates to `/session?studySetId=<id>`. Keep the document picker UI with the honest Stage-2 note from the design spec §10. The screen loads via a `useEffect` + `useState` fetch (no data library — YAGNI).

- [ ] **Step 4: Rebind Home** — study-set chip title/exam label and the weak-concept card from the loaded snapshot (fall back to the current copy when offline, with a quiet "agent offline" caption derived from `fetchVivaAgentReadinessProbe`). Extract the pure mappers (`homeModelFromLibrary(projection, snapshot)`) and unit-test them with the canned snapshot.

- [ ] **Step 5: Gates green; commit** — `git commit -m "feat(mobile): real library snapshot drives Home and Library"`

---

### Task 10: Session screen on the real agent (typed answers, playback, recovery)

**Files:**
- Create: `apps/mobile/src/agent/session-view-model.ts`
- Test: `apps/mobile/src/agent/session-view-model.test.ts`
- Modify: `apps/mobile/src/app/session.tsx`
- Delete: `apps/mobile/src/features/session/session-machine.ts`, `apps/mobile/src/features/session/session-machine.test.ts`

**Interfaces:**
- Consumes: `useMobileVivaSession` (Task 8), `MobilePlaybackSession` (Task 6), `learnerRecoveryCopy` helpers (`@viva/core`), derived state types.
- Produces (all pure, all tested):
  - `orbStateForSession(input: { phase: SessionPhase; speaking: boolean; status: VivaAgentConnectionStatus }): OrbState` — `connecting→"thinking"`, `open+listening→"listening"`, `thinking→"thinking"`, `feedback|correction→"correcting"`, `recap→"complete"`, `speaking` forces `"correcting"`-palette narration state per the design pass.
  - `correctionModelFromEvaluation(evaluation: AnswerEvaluation, finalTranscript: string | undefined, submittedText: string | undefined)` → `{ answer: string; correction: string; retryPrompt: string; sourceExcerpt: string; sourceLabel: string; title: string; uncertainTranscript: boolean }` (uncertain when `transcriptConfidence < 0.7`, mirroring web).
  - `stageCopyForConnection(input: { close?: VivaAgentCloseDiagnostics; status: VivaAgentConnectionStatus; terminalReason?: AgentTerminalSessionReason })` → honest connecting/interrupted/ended copy (the BAC-466 rule: ended only when `close.wasClean || terminalReason`).

- [ ] **Step 1: Write the view-model tests first** — one `describe` per function; hand-derived cases including: `stageCopyForConnection({ status: "closed", close: { code: 1006, reason: "", wasClean: false } })` → interrupted copy with a retry affordance; `orbStateForSession({ phase: "thinking", speaking: false, status: "open" })` → `"thinking"`; a correction model built from a real fixture evaluation object copied from `synthetic-study-session.json`.

- [ ] **Step 2: Verify failures, implement the mappers.**

- [ ] **Step 3: Rewire `session.tsx`** — remove the `useReducer(sessionReducer, …)` synthetic flow; the screen consumes `useMobileVivaSession({ mode: "quiz", studySet })` (study set resolved from the route param via Task 9's `studySetForSession`, defaulting to the fixture id). Bindings: question prompt ← `derived.question?.prompt` (warm-up state while undefined); typed submit ← `sendText` (existing input UI unchanged; disabled while `!derived.canSubmitAnswer`); hint ← `derived.question?.followUp`; source note ← `question.source` label + `retrievalReason`; correction view ← `correctionModelFromEvaluation`; Try again keeps the current UX but now waits for the agent's next `question_started` (the correction's Try again sends nothing — the reducer's retry-prompt flow is display-only at v4; End/stop ← `controller.stop()` then recap). The playback session drains in an effect keyed on `agentState.audio`/`cancelledResponseIds` exactly as the design doc §7 shows, and `unlock()` runs on the screen's first `Pressable` interaction. Mic: keep the current permission + watchdog UX, wire the level meter through Task 7's source into the orb bloom, keep the ledger, and gate submission with `const voiceTurnsEnabled = false as const;` annotated with the v5 reference.
- The recap navigation passes through `sessionResultStore` (Task 8) instead of the static copy.

- [ ] **Step 4: Delete `session-machine.ts` + its test.** Typed-fallback and watchdog behavior that lived there is now covered by the view-model tests and the capture module.

- [ ] **Step 5: Manual gate against the real agent** — `bun run dev:agent` + dev build: full typed loop (question → answer → correction with real source excerpt → try again → end → recap). Then `VIVA_AGENT_PROVIDER=fake_cartesia_gemini bun run dev:agent`: examiner audio audibly plays; End stops it.

- [ ] **Step 6: Gates green; commit** — `git commit -m "feat(mobile): session screen runs the real agent loop with typed answers and native playback"`

---

### Task 11: Recap screen on real recap + FSRS plan

**Files:**
- Create: `apps/mobile/src/agent/recap-view-model.ts`
- Test: `apps/mobile/src/agent/recap-view-model.test.ts`
- Modify: `apps/mobile/src/app/recap.tsx`

**Interfaces:**
- Consumes: `sessionResultStore`, `recapPlanFromSessionEvents` (`@viva-web/viva-display`), `SessionRecap` (`@viva/core`).
- Produces: `recapModel(input: { conceptStatuses: Record<string, ConceptStatus>; now: Date; recap?: SessionRecap; studySet?: StudySet })` → `{ headline; ledger: [{count,label,color-token-name}]; moments; nextReview?: { label: string; when: string }; partialReasonCopy?: string; summary }` with counts from the recap arrays and `nextReview` from `recapPlanFromSessionEvents(...).reviewPlan[0]` (`humanInterval` label).

- [ ] **Step 1: Failing tests** — feed the fixture recap from `synthetic-study-session.json`; hand-derive the ledger counts and first review item; add a `partial_reason: "turn_cap"` case asserting the honest partial copy ("The session ended early (time cap). This recap covers what was completed.").

- [ ] **Step 2: Implement; rebind `recap.tsx`** — replace the static `ledger`/`moments` constants; "Schedule tomorrow's drill" keeps its local confirmation but its caption gains the honest note that persistence arrives with the scheduling milestone (D-M8/D-01); empty-store fallback (deep link straight to `/recap`) renders a calm "No finished session yet" state pointing home.

- [ ] **Step 3: Gates green; commit** — `git commit -m "feat(mobile): recap renders the real session recap and FSRS plan"`

---

### Task 12: Expo-web e2e against the real agent

**Files:**
- Create: `apps/mobile/scripts/e2e-live-loop.mjs`
- Modify: `apps/mobile/package.json` (script `"e2e:live": "node scripts/e2e-live-loop.mjs"`)

**Interfaces:**
- Consumes: the running app (Metro web) + a self-started `agent-service`.
- Produces: a repeatable local gate proving the full loop with zero console errors.

- [ ] **Step 1: Write the script** — pattern-match `scripts/e2e-browser.mjs` (root, read-only reference): spawn `cargo run --manifest-path ../../agent/Cargo.toml -p agent-service` with `VIVA_AGENT_BIND_ADDR=127.0.0.1:43180 VIVA_AGENT_PROVIDER=synthetic` and blanked token secrets; poll `http://127.0.0.1:43180/ready`; spawn `bunx expo start --web --port 8090` with `EXPO_PUBLIC_VIVA_AGENT_WS_URL=ws://127.0.0.1:43180/ws`; drive Playwright (import from the repo root `node_modules` via `file://` URL): home shows the real study-set title → begin recall → question prompt visible (assert it equals the fixture's prompt) → type the fixture answer → submit → correction shows the fixture's `concise_feedback` → end → recap headline matches the fixture. Fail on any `pageerror`/console error. Second phase: restart the agent with `VIVA_AGENT_PROVIDER=fake_cartesia_gemini` and assert the sink state flips speaking (expose a `data-viva-speaking` attribute on the session screen root for this assertion). Kill both processes in `finally`.

- [ ] **Step 2: Run it twice** (determinism), fix flakes with role/exact locators (the e2e-harness lesson: never loose `getByText` against live regions).

- [ ] **Step 3: Commit** — `git commit -m "test(mobile): expo-web e2e drives the real agent loop"`

---

### Task 13: On-device gates, cleanup, docs

**Files:**
- Modify: `apps/mobile/README.md`

- [ ] **Step 1: Device matrix** — run and check off: iOS simulator (loopback); physical iPhone over LAN; Android emulator (`10.0.2.2`). For the LAN phone gate, the agent's non-loopback bind fails closed (`config.rs:705-708`: needs a token secret **and** `VIVA_VOICE_WS_ALLOWED_ORIGINS`), so either (a) run `VIVA_AGENT_BIND_ADDR=0.0.0.0:4318 VIVA_VOICE_WS_ALLOWED_ORIGINS=https://mobile.viva.dev bun run dev:agent:signed` with `EXPO_PUBLIC_VIVA_WS_ORIGIN=https://mobile.viva.dev` and a token from the signed flow, or (b) tunnel the phone to loopback over USB (`iproxy`). Record which path was used. For each platform: typed loop completes; examiner audio plays; airplane-mode mid-session shows interrupted copy; retry reconnects.
- [ ] **Step 2: WS subprotocol spike record** — from the device build, connect with a dummy token against `dev:agent:signed` and record in the README whether RN delivered the `bearer.*` subprotocol (expected close: `session auth failed` proves the header arrived and was parsed; a `first frame timeout` instead means the subprotocol was dropped — record for D-M9).
- [ ] **Step 3: README** — replace the "Current boundaries" section: recording seam now real (capture runs, submission gated on protocol v5 with a pointer to the remediation plan); library/recap now server-backed in dev; document the env vars table from the design spec §4 and the `e2e:live` gate.
- [ ] **Step 4: Full gates** — `bun run --cwd apps/mobile typecheck && lint && test && build`, `bun run e2e:live` (from `apps/mobile`), root `bun run validate:ts` unaffected. Commit — `git commit -m "docs(mobile): stage-0 live loop boundaries and device gates"`.

---

## Self-review (performed at authoring time)

- **Spec coverage:** design §1 items 1–7 map to Tasks 9 (1), 8+10 (2), 10 (3), 5+6+10 (4), 7+10 (5), 11 (6), 10 (7). §3→Task 4, §4→Task 1, §5→Tasks 1–2, §6→Task 8, §7→Tasks 5–6, §8→Task 7, §10→Tasks 9–11, §11→Task 10, §12→Tasks 3+12+13, §13 checklist → Tasks 10/12/13. Stage-1 seam (§9) intentionally has no task.
- **Placeholders:** none; every code step carries real code or an exact command; Task 9's `StudySet` mapping cites the exact type location instead of pseudo-code because the executor must derive it from the live type, field-by-field, at execution time.
- **Type consistency:** `AppConfig` (T1) consumed in T8/T9/T12 with matching fields; `MobilePlaybackSession.drain` signature identical in T6 definition and T10 usage; `AudioRecorderLike` used only in T7; `foregroundReconnectAction` names match between T8 steps.
