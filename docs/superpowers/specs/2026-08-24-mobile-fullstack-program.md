# Viva Mobile Full-Stack Program

**Date:** 2026-08-24
**Status:** Draft for owner review
**Companion docs:** `docs/superpowers/specs/2026-08-24-mobile-live-loop-design.md` (Stage 0 design), `docs/superpowers/plans/2026-08-24-mobile-live-loop-plan.md` (Stage 0 implementation plan)

## 1. Goal

Turn `apps/mobile` from a synthetic-data UI prototype into a real client of the Viva stack: real questions, evaluations, corrections, recaps, examiner voice, spoken answers, and library data, served by the existing Next.js web API and the Rust `agent-service` — reusing the shipped web client architecture instead of re-inventing it.

The program is decomposed into three stages because the stack itself is mid-flight: the 2026-08-23 review-remediation program (`docs/superpowers/plans/2026-08-23-review-remediation-swarm-program.md`) owns protocol v5, credential rotation, the server-owned study projection, and the D-01 scheduling authority. Mobile becomes the **second consumer** of those contracts; it must not fork or pre-empt them.

## 2. Ground truth (verified 2026-08-24, all claims file-checked)

### What already exists and is reusable

- **The wire contract is shared and platform-neutral.** `packages/core/src/agent-contract.ts` (714 lines) defines protocol v4: 24 kHz `pcm_s16le`, JSON frames, 64 KiB text-frame cap / 256 KiB binary cap, `session_config → ready → event*` lifecycle, 12 server events, 16 terminal reasons. Zero DOM/Node dependencies. Mirrored byte-for-byte with `agent/crates/agent-service/src/protocol.rs` via `agent/fixtures/voice-protocol/*.json`, asserted from both languages.
- **The session controller is framework-free and injectable.** `apps/web/lib/viva-agent-client.ts:776` `createVivaAgentSessionController` — injectable `WebSocketImpl`, `url`, `token`; pure `vivaAgentReducer`; generation/staleness guards; bounded audio queue with identity-based `acknowledgeAudio`. Browser touchpoints are all guarded or injectable (verified line-by-line; see design doc §5).
- **The React hook is pure React.** `apps/web/lib/use-viva-agent-session.ts` — no DOM. React versions match exactly (19.2.3 in both `apps/web` and `apps/mobile`).
- **Audio is already split into pure core + platform adapter.**
  - Capture: `apps/web/lib/viva-audio-capture.ts` — pure resample/PCM16/base64/framing engine (`startVivaPcm16StreamingCapture`, 20 ms / 960-byte frames) parameterized by a `VivaAudioCaptureSource` interface; only `createBrowserVivaAudioCaptureSource` (AudioWorklet + getUserMedia) is browser-bound.
  - Playback: `apps/web/lib/viva-audio-playback.ts` — pure queue state machine + `VivaAudioPlaybackSink` parameterized by `VivaAudioContextLike` (6 Web-Audio methods). The drain-and-acknowledge integration (`drainAgentAudio`, `LiveSessionPage.tsx:977`) is pure.
- **Bootstrap and auth (dev):** `bun run dev:agent` runs the agent unsigned on `127.0.0.1:4318`; the WS falls back to the trusted fixture identity (`user-1` / `biology-midterm`) and rotates a session id (`agent/crates/agent-service/src/ws.rs:3158-3167`). **A local mobile client needs no token at all.**
- **Bootstrap and auth (signed):** three HMAC token families (`viva1.` session token minted by the agent, `viva-bootstrap1.` capability and `viva-control1.` control minted by the web). `POST /api/viva-session/start` guards: same-origin (`Origin` + `sec-fetch-site`), identity allowlists, optional bootstrap capability, per-IP mint rate limit, then a server-side agent library fetch lifts `{session_id, session_token}`. The WS accepts the token as the `bearer.<base64url>` subprotocol and/or top-level `session_token` in the first `session_config` frame. Origin allowlist (`VIVA_VOICE_WS_ALLOWED_ORIGINS`) **rejects a missing Origin header when configured** (`agent/crates/agent-service/src/config.rs:729-742`).
- **Study data REST (on the agent):** `/study-sets/library` (snapshot with per-set `start`/`resume` actions carrying minted tokens), `/study-sets/paste`, `/study-sets/files` (base64 JSON, text-heuristic ingestion — **not** a real PDF parser; no Docling anywhere), `/study-sets/export`, deletes. Web reaches it via the token-scrubbing proxy `/api/viva-library`.
- **Store:** in-memory fixture by default; Postgres (14 migrations) when `DATABASE_URL`/`VIVA_AGENT_DATABASE_URL` is set. Signed-session mode refuses to boot on a non-durable store.
- **Providers:** `synthetic` (default, no audio out), `fake_cartesia_gemini` (offline, provider-shaped, **emits real `audio_delta` TTS frames**), `cartesia_gemini` (live; keys + `VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1` + zero-data-retention gates).
- **Deployment:** only the hosted monitor cron is committed for Railway (`railway.json`). `agent/Dockerfile` is `$PORT`-ready; the hosted agent service is configured out-of-repo. There is no always-on hosted agent in this repo's config.
- **A working non-browser reference client exists:** `scripts/live-provider-smoke.mjs` (subprotocol at `:721-722`, `session_config` at `:642-658`, binary PCM send at `:626`).

### The five load-bearing constraints

1. **Spoken answers do not fit protocol v4.** One `audio` JSON frame = one whole turn (`ws.rs:2927-2943` → `BrainInput::Audio`; the brain batch-transcribes a single frame, `agent-adapters/src/cartesia_gemini/runner.rs:493-497`). The 64 KiB text cap limits a JSON audio turn to ~1.0 s; the binary path caps at ~5.4 s. This is review Critical `CRIT-AUDIO-01`.
2. **Protocol v5 is already designed and locked.** `docs/superpowers/plans/2026-08-23-expedited-critical-path.md` (Plan 03) specifies `audio_chunk` (≤8,192 raw bytes, contiguous sequences) / `audio_end{final_sequence}` / `audio_turn_accepted`, a 45 s turn cap, a retained client-side turn ledger with backpressure, and new controller APIs (`sendAudioChunk`, `endAudioTurn`, `cancelAudioTurn`, `retryPendingAudio`, `VivaAudioSendResult`). Legacy `type:"audio"` is **rejected** at v5. Its constants are "locked inputs, not implementation suggestions." Mobile consumes v5 verbatim and must not design a competing turn model.
3. **File ownership is lane-exclusive during remediation.** Plan 03/05 own `protocol.rs`, `agent-contract.ts`, fixtures; Plan 06 owns the web session/audio libs; Plan 11/12/14 own manifests, proxy, and `@viva/core` export surfaces; Plan 09 owns migrations. Mobile work in this program **edits only `apps/mobile/**`** (plus additive docs) until a coordinated handoff says otherwise.
4. **No auth system exists.** Identity is env allowlists + fixture ids + URL params. The remediation program (Plans 06/13) introduces a credential vault and refresh-token rotation for the browser; accounts remain unbuilt. Mobile must not invent its own account system mid-program.
5. **Scheduling authority is undecided (D-01).** FSRS runs client-side and stateless (`packages/core/src/scheduling.ts`, `ts-fsrs`); server `review_items.due_at` are hardcoded placeholder dates pending D-01. Mobile renders what the recap/library provide and reuses the shared scheduler exactly as the web does — it does not persist or invent schedule state.

## 3. Stage decomposition

### Stage 0 — Mobile Live Loop v1 (this program's first sub-project; spec + plan written)

Real full-stack loop on mobile against a LAN-local stack, **typed answers first**, examiner voice out, voice-in pipeline built but gated until v5.

Scope highlights (full design in the Stage 0 spec):
- Expo dev-build toolchain (`expo prebuild` / `expo run:ios|android`) with `react-native-audio-api` (v0.13.x: Web-Audio-spec `AudioContext` + native `AudioRecorder`, ships an Expo config plugin; worklets peer-dep already satisfied by the app). Expo Go is retired for this app.
- Consume `@viva/core` directly; consume the web session-client modules read-only via mobile-local path aliases (no contested file edited); RN environment shims (base64, env, WS options) live in `apps/mobile`.
- Session screen driven by `createVivaAgentSessionController` + the shared derive layer instead of the local synthetic `session-machine`; real question → typed answer → real evaluation/correction with real source excerpts → real `recap_ready` recap; connection status, terminal reasons, and close reasons mapped to the manuscript recovery copy in `@viva/core`.
- Native playback sink implementing `VivaAudioContextLike` over `react-native-audio-api` → the examiner actually speaks on device against `fake_cartesia_gemini`.
- Native capture source implementing `VivaAudioCaptureSource` over `AudioRecorder` → live level metering drives the orb bloom; the 20 ms frame ledger is produced and tested, submission disabled until v5.
- Library and Home screens on the real library snapshot (direct agent REST on LAN).
- Verification: bun unit tests, protocol-fixture replay tests, Expo-web + Playwright e2e against a real local `agent-service` (both `synthetic` and `fake_cartesia_gemini`), then on-device gates.

Exit criteria: a physical-device (or simulator) dev build completes a full session with typed answers against the local agent, examiner audio audibly plays, the recap and library render server data, all local gates green.

### Stage 1 — Spoken turns, signed sessions, hosted target (spec to be written when Stage 0 nears completion, per the brainstorming skill's one-sub-project-at-a-time rule)

Hard dependency: remediation Plan 03 merged (protocol v5 + controller turn-ledger APIs published).

- Voice turns via v5 `audio_chunk`/`audio_end` from the native capture ledger; `audio_turn_accepted` acknowledgement; retry of pending turns; barge-in (`cancel` + sink cancellation is already wired in the shared drain model).
- Signed sessions from mobile: `dev:agent:signed` locally, then hosted. Requires the **native bootstrap accommodation** — `POST /api/viva-session/start` currently requires browser same-origin headers; a deliberate, coordinated change (owned by the web-api lane or post-remediation) must admit native clients (proposal in the Stage 0 design doc §9, D-M9/D-M10). Mobile sends an explicit allowlisted `Origin` header on the WS (React Native's WebSocket supports headers and subprotocols; verified as a Stage 0 task).
- Hosted agent target (Railway agent service; ops-owned env: origin allowlist entry, session secret, Postgres) + on-device `cartesia_gemini` live smoke behind the existing ZDR gates.
- Shared-package extraction: promote `viva-agent-client` / `use-viva-agent-session` / audio cores / `viva-session-projection` / `viva-library` into a real `@viva/session-client` package, replacing Stage 0's reach-in aliases. Scheduled **after** Plans 03/06/14 land to avoid lane conflicts; coordinated with the program's export-parity rules.
- App-lifecycle hardening: iOS/Android audio session categories, backgrounding/foreground reconnect generations, interruption (phone call) recovery.

### Stage 2 — Identity, ingestion, and the scheduled loop (spec later)

- Accounts/identity: adopt whatever identity model the platform chooses (none exists today; the remediation credential vault is the nearest primitive). Until then mobile stays fixture/allowlist identity like the web.
- Library ingestion UX on mobile: paste-first (endpoint exists), text files via `/study-sets/files`; **real PDF/slide parsing is a separate server-side program** (no Docling or parser exists; binary PDFs currently fail ingestion by design of the text heuristic) and is explicitly out of mobile scope.
- Post-D-01 scheduling: consume the authoritative review plan (server-persisted or shared-core, whichever D-01 selects); "Schedule tomorrow's drill" becomes a real mutation only when a server mutation surface exists (`archive`-style actions are currently `server_mutation_unavailable`).
- Durability expectations: mobile against a Postgres-backed hosted agent; recap history in Library from `sessions[]`.
- Candidates, only if the owner wants them: push notifications for due reviews, offline recap cache.

## 4. Decision register (defaults chosen; flag any you want changed)

| # | Decision | Default | Alternatives considered |
| --- | --- | --- | --- |
| D-M1 | Native audio dependency | `react-native-audio-api` (one lib for capture + Web-Audio-parity playback, `AudioRecorder` + `decodePCMInBase64`, Expo plugin, worklets dep already present) | `@siteed/audio-studio` (capture-only; would still need a playback lib); `expo-audio` (no PCM streaming; also froze the JS thread on the iOS 26 simulator) |
| D-M2 | Voice turn model | Consume locked protocol v5; **no interim v4 audio shim**; typed answers carry Stage 0; capture pipeline built and tested behind the v5 seam | v4 single-frame audio (≤1 s JSON / ≤5.4 s binary — dead end that v5 explicitly rejects) |
| D-M3 | Code sharing mechanism | Stage 0: read-only reach-in imports of `apps/web/lib` session modules via `apps/mobile`-local metro/tsconfig aliases; Stage 1: real `@viva/session-client` extraction after lanes land | Copying the controller (drift); extracting now (edits lane-owned files) |
| D-M4 | Stage 0 identity | Unsigned loopback/LAN dev with the agent's trusted fixture identity; signed flow deferred to Stage 1 | Spoofing the web API's `sec-fetch-site` guard from RN (works, but hides the real design gap) |
| D-M5 | Stage 0 providers | `synthetic` for determinism + `fake_cartesia_gemini` for audio-out; live provider only in Stage 1 on-device smoke | — |
| D-M6 | Program sequencing | Remediation Plan 03 (critical path) is a hard dependency for spoken turns; recommend running it first/in parallel; Stage 0 touches no contested file and can start now | Blocking all mobile work on the full remediation program (unnecessary) |
| D-M7 | Mobile ingestion scope | Paste + text files against existing endpoints (Stage 2); real document parsing is a separate server program | Building a mobile-driven upload pipeline now (no server to receive it) |
| D-M8 | Scheduling on mobile | Reuse `@viva/core` FSRS + the web's `recapPlanFromSessionEvents` derivation as-is; adopt D-01 outcome when it lands | Persisting schedule state from mobile (violates server-authority principle) |
| D-M9 | Native WS origin | Mobile sends an explicit `Origin` header (RN supports WS headers) with an agreed literal added to `VIVA_VOICE_WS_ALLOWED_ORIGINS`; verified as a Stage 0 spike task with the session-token-in-first-frame path as fallback | Relaxing the agent's origin check for tokened clients (edits a lane-owned surface; revisit in Stage 1 coordination) |
| D-M10 | Native session bootstrap | Stage 1 coordinated change: `/api/viva-session/start` gains a native-client admission path (bootstrap capability token instead of browser fetch-metadata) — proposal sketched in Stage 0 design §9, implemented with/after the web-api lane | Mobile calling agent REST with the server-only bearer (secret would ship in the app — rejected) |
| D-M11 | Committing these docs | Left uncommitted alongside the owner's other untracked work; owner commits/PRs per repo policy | Auto-commit (would entangle the dirty tree) |

## 5. Coordination contract with the 2026-08-23 remediation program

- Mobile Stage 0 edits **only** `apps/mobile/**` and these three docs. It reads, but never edits, `apps/web/lib/**`, `packages/**`, `agent/**`, root manifests, fixtures.
- Anything mobile needs from a contested surface becomes a **named handoff request**, not an edit: (a) protocol v5 + controller turn APIs → Plan 03; (b) `@viva/core` export-surface stability for RN consumption → Plan 14 (mobile uses only root exports that already exist); (c) native bootstrap admission → web-api owner post-Plan-11; (d) shared-package extraction → post-Plans 03/06/14.
- If remediation lanes rename the reach-in modules, the Stage 0 aliases are a single-file fix in `apps/mobile`; the reach-in list is enumerated in the design doc §5 for exactly this audit.
- Mobile adds no migrations, no fixtures, no new root scripts during Stage 0.

## 6. Stage 0 execution outcome (recorded 2026-08-25)

Executed on branch `mobile-live-loop-v1` (tip `d7a7320`); full evidence table in `apps/mobile/README.md` ("Device acceptance record — 2026-08-25"). Independently re-verified: 74 tests / 366 expectations green, typecheck/lint/export clean, `e2e:live` pass ×2, lane clean.

**Software-provable scope is done**: typed live loop against the real agent on Android API 36 and the iOS simulator (question → evaluation → distinct retry → source `Lecture 5 · Slide 18` → real recap), server-backed Home/Library, honest interruption/recovery copy, playback queue + speaking-state transitions, bearer-subprotocol auth accepted from RN on both platforms (**D-M9 spike PASS** — the Origin-header wrapper is now needed only for hosted origin-allowlist scenarios).

**Open gates, with owners:**

| # | Item | Owner / route |
| --- | --- | --- |
| G-1 | Physical-device typed loop + nonzero native capture (both simulators produced 0 mic frames; the shipped wiring matches the library API, and this iOS 26 simulator's input stack is known-broken — a real phone decides whether any code bug exists) | Owner hardware session; USB loopback (`iproxy`) preferred |
| G-2 | **RESOLVED 2026-08-25 (`9f6a350`)** — root manifests, hoisted-linker bunfig, and the regenerated `bun.lock` covering the mobile workspace are committed; frozen dry-run passes | — |
| H-1 | **RESOLVED 2026-08-25 (`26d6209`)** — the fake Sonic transport now synthesizes a deterministic 600 ms examiner tone (integer-exact; byte-exact fixture + all Rust/TS gates green; `e2e:live` observed it through the real pipeline). Remaining: a human listen on device/simulator (G-1 checklist) | — |
| H-2 | Mobile side **landed 2026-08-25 (`f351339`)**: a pre-question `session_cap` renders as a retryable "previous session is still closing" hold instead of an early-ended recap. Agent side still open: lease frees only via the 45 s idle reaper (`MAX_ACTIVE_SESSIONS_PER_USER_STUDY_SET = 1`, `RECONNECT_LEASE_GRACE = 250 ms`, no server ping) — fix space is same-identity takeover or server heartbeat + pong timeout | Handoff → agent-service lane |
| H-3 | Library snapshot exposes no concepts / authoritative `next_review`; mobile correctly renders unavailability rather than inventing data | Already planned: `AuthenticatedStudyProjectionV1` (Plans 04/08) + D-01 |
| H-4 | **Found 2026-08-25 while greening CI:** the `voice_ws` integration suite is timing-fragile on constrained runners — rotating failures on every 2-CPU run, reproduced against unmodified `main` in a 2-CPU container (122/127). At least one failure is a genuine runtime gap: the session loop's biased select polls the queued provider admission above client messages, so a cancel that becomes ready in the same poll as a freed slot loses, and the cancelled turn is forwarded to the provider (`ws.rs` arm order at ~631 vs ~736; a naive arm swap regresses turn-cap/slow-client behavior — needs a designed fix). Suite quarantined **on CI's validate step only** via `VIVA_ALLOW_CONSTRAINED_RUNNER_VOICE_WS_SKIP` (loopback-skip pattern); full suite still runs locally and in ≥4-CPU environments; CI's dedicated replay gate still exercises the real WebSocket path | Handoff → runtime lane (Plans 03/05/08 rewrite this suite for protocol v5); remove the quarantine when hardened |

Acceptance stance: §13's "human-audible examiner speech" is reclassified as satisfiable only after H-1 or against the live provider (Stage 1) — the queue/speaking-state proof stands in until then. Everything else in §13 holds pending G-1/G-2.

## 7. Out of scope for the whole program

- A general accounts/auth system (platform decision, not mobile's).
- Real PDF/slide/document parsing (server program; mobile consumes whatever ingestion the server offers).
- Web feature changes of any kind.
- App Store / Play Store release engineering (EAS builds, signing, review) — worth its own doc when Stage 1 is real on hosted infra.
