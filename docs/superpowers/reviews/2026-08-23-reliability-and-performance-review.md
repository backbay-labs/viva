# Viva reliability and performance review — 2026-08-23

**Scope:** Browser polling/capture/animation, agent process lifetime, in-memory observability, rate-limit state, shutdown, and release/monitor harness behavior.  
**Overall confidence:** High for static/control-flow findings; moderate for device performance because no CPU/energy profile was captured.

## Findings

| ID | Priority | Finding | Confidence |
| --- | --- | --- | --- |
| REL-01 | P2 | Readiness requests have no timeout/abort and can overlap every five seconds | High |
| REL-02 | P2 | Evidence and usage events are retained in unbounded process-lifetime vectors | High |
| REL-03 | P2 | Session-mint buckets are unswept process-local state | High |
| REL-04 | P2 | Streaming audio resampling is stateless across callbacks | High |
| REL-05 | P2 | Release evidence generation depends on ambient environment and runtime version | High |
| REL-06 | P2 | Two animated full-surface canvases and frosted effects lack an enforced performance budget | Moderate |
| REL-07 | P3 | Global CSS and large process modules increase parse/review/change cost | High |

## REL-01 — P2 — Hung readiness calls accumulate

`fetchVivaAgentReadinessProbe` launches `/health/brain` and `/ready` with plain fetch and no signal or timeout (`apps/web/lib/viva-agent-client.ts:278-316`). `LiveSessionPage` invokes it immediately and then with `setInterval(refreshReadiness, 5_000)` (`LiveSessionPage.tsx:300-318`).

If an intermediary accepts the connection but never completes a response, the next interval starts another pair. Cleanup sets `cancelled` to suppress state updates but does not abort outstanding network work. A six-hour session can accumulate requests under a pathological network.

**Recommendation:** Use one self-scheduling poll after the previous attempt settles, attach an `AbortController`, set a timeout below the interval, abort on cleanup, and cap/surface consecutive failures. Test a fetch that never resolves.

## REL-02 — P2 — Observability leaks process memory over time

`VoiceEvidenceRecorder` stores every event in `RwLock<Vec<VoiceEvidenceEvent>>`; `VoiceUsageRecorder` does the same for usage (`agent/crates/agent-service/src/app.rs:1005-1079`). Neither has a cap, TTL, drain, or external sink. `VoiceUsageRecorder::summary` iterates the entire vector on every `/health/brain` request (`app.rs:1081-1107,1212-1271`).

Each event is sanitized, which protects content, not capacity. A long-lived public process will grow monotonically with sessions/turns, and health latency becomes O(total historical usage events).

**Recommendation:** Export events to the configured observability backend, maintain only bounded counters/ring buffers in process, and use constant-time atomics/aggregates for health. Add a million-event bounded-memory test or property assertion on retention.

## REL-03 — P2 — Rate-limit state is neither bounded nor shared

The Next mint limiter's module map retains unique IP/identity keys forever and is reset only by tests. Horizontal instances do not share counts. See SEC-04.

**Recommendation:** Shared atomic limiter plus TTL eviction; expose sanitized saturation metrics and test clock rollover/concurrency.

## REL-04 — P2 — Audio conversion loses time continuity

Per-callback resampling rounds each block and restarts interpolation at index zero. At 44.1 kHz and typical 128-sample callbacks, output rate is about 24,117 Hz instead of 24,000 Hz and boundaries are discontinuous. See COR-08.

**Recommendation:** Stateful resampler and long-duration signal tests. This should land with the streaming-transport redesign, not as an isolated helper patch.

## REL-05 — P2 — Release tooling is not hermetic

Two reproduced issues:

1. `release-check.mjs` passed inherited signed-session settings into no-secret provider children; the synthetic child exited against in-memory storage. Clearing those variables made the same remaining release check pass.
2. The exact hosted SHA failed under Node 24 because the S3 deadline timer was unref'ed; local Node 25.5 passed.

**Recommendation:** Explicit child environment allowlists, a pinned supported Node runtime for script tests, and a hermetic test that runs release check with hostile ambient variables. Preserve failure logs in a sanitized quarantine artifact instead of deleting the only child stderr needed for diagnosis.

## REL-06 — P2 — Visual performance is designed but not budgeted

The implementation includes good controls:

- both canvases cap DPR at 2 and target about 32 fps;
- animation pauses in hidden tabs and under reduced motion;
- resize work is debounced and observers/listeners/rAF are cleaned up;
- the voice canvas uses 40–64 particles.

However, the live session mounts both `MuseGlyphCanvas` (up to 880 glyphs, 26 sparks, 9 large terms per frame) and `VoiceTraceCanvas`, while large frosted panels use gradients, shadows, and backdrop effects. `globals.css` is 95 KiB before compression. No CI budget covers long tasks, frame time, energy, memory, or low-end mobile.

**Recommendation:** Add a representative low-end mobile performance trace or scripted frame-budget check. Pause the background Muse canvas while the foreground trace is active if profiling shows contention. Respect `prefers-reduced-transparency` where available and provide an explicit low-motion/low-effects mode.

## REL-07 — P3 — Concentration raises operational change cost

Large service and stylesheet modules do not necessarily run slowly, but they increase rebuild, parsing, review, and regression surface. See ARC-05/FE-09.

## Shutdown assessment

The two-second drain grace is not automatically a defect. On signal, `begin_drain()` flips readiness, rejects new sessions, and active WebSocket loops select on the watch signal and emit a controlled drained terminal state. Axum then performs graceful shutdown. The relevant risk is whether every provider/tool task honors cancellation within platform termination limits; existing tests cover synthetic drain, not real provider cancellation under load.

**Confidence:** Moderate. Keep the two-second value only with a hosted termination test that observes active live-provider tasks and confirms process exit before platform SIGKILL.

## Recommended reliability tests

- Never-resolving readiness fetch: bounded one attempt, timeout, abort on unmount.
- 100k unique mint keys: bounded map/store memory and correct expiry.
- Million sanitized evidence/usage events: constant bounded process memory and O(1) health summary.
- 44.1/48 kHz signals over 45 seconds: duration and spectral error bounds.
- SIGTERM during STT, evaluation, TTS, persistence, and recap stages.
- Low-end mobile trace of the two-canvas session for 60 seconds.
- Release check under hostile inherited environment on the pinned CI Node version.
