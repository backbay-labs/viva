# Code Review: Rust agent-adapters crate (Cartesia + Gemini providers)

| | |
|---|---|
| **Date** | 2026-08-23 |
| **Commit** | 4d5d827 (main) |
| **Scope** | agent/crates/agent-adapters/ |
| **Verdict** | sound-with-fixes |
| **Confidence** | High for source/fake-provider behavior; unknown against live Cartesia/Gemini |

This crate implements the Cartesia (Ink STT, Sonic TTS) + Gemini voice-tutor provider cascade behind a shared `CartesiaGeminiRunner` that is parameterized over fake and live transports, plus the synthetic brain and noop adapter. The transport engineering — sanitization, 429/fallback metadata, cancellation-vs-durability semantics, live gating — is genuinely strong and well tested. The problem is that the shared runner still carries fixture-era scaffolding that the live path inherits verbatim: fabricated concept statuses and review scheduling, a hardcoded biology reply, constant transcript confidence, fake-labeled error emission, and a multi-turn event contract the web client silently drops. All eleven first-pass findings survived adversarial verification against the source (one with a corrected impact claim); the verdict stands at sound-with-fixes because the live runtime is triple-gated off, the fixes are well localized, and nothing found breaks the currently shipped fake/synthetic surface.

## Strengths

- Secret/PII sanitization is engineered as a first-class invariant and verified with leak-marker tests: every provider error path collapses to fixed strings, API keys are Debug-redacted (`src/cartesia_gemini/mod.rs:61-83`, `llm.rs:64-77`), keys travel in headers not URLs (`llm.rs:538-547`, `stt.rs:84-94`), and tests assert transcripts/keys/bodies never appear in error strings (`stt.rs:457-486`, `tts.rs:583-616`, llm.rs leak tests).
- 429 metadata capture is unusually thorough and fully sanitized: Retry-After header (delta and HTTP-date), `google.rpc.RetryInfo` body delay including fractional seconds, free-text "retry in N minutes" parsing, and bounded reset-hint parsing (RFC3339/epoch/relative) with range validation, all behind a bounded 16KB error-body read (`llm.rs:556-578`, `823-1071`), with tests including real axum HTTP server round-trips (`llm.rs:1901-2005`).
- The Gemini fallback path is carefully designed: a shared stage deadline across attempts (`llm.rs:281-330`), per-attempt request rebuilds that add/remove `thinkingConfig` per model capability (`llm.rs:423-468`), `FallbackActivated` events surfaced even when the fallback then fails, and fallback promotion that persists across tool-loop continuation passes while preserving unused fallbacks (`runner.rs:1304-1313`, tests at `runner.rs:2365-2500`).
- Cancellation semantics are proven against real store state, not mocks: `BlockingAnswerStore` integration tests show a cancel mid tool-write suppresses the evaluation commit and downstream events while the pre-provider answer envelope stays durable (`tests/cartesia_gemini.rs:524-644`), and `ActiveRunnerResponse::Drop` aborts in-flight turns when the session task dies (`runner.rs:1944-1951`).
- Live-runtime admission gating is defense-in-depth and tested: the triple gate (`VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1`, non-placeholder keys, dual ZDR confirmation) is enforced at `CartesiaGeminiBrain::open` (`mod.rs:277-295`) and again at the transport layer via `authorize_open` (`runner.rs:2274-2283`), with conservative `'1'`-only env parsing (`mod.rs:121-126`, test at `mod.rs:782-807`).
- The transport abstraction (`GeminiSseClient`, `InkConnector`/`InkSocket`, `SonicConnector`/`SonicSocket`, `CartesiaGeminiTransports`) keeps every provider protocol testable without network while the live implementations stay thin, and both WebSocket sockets correctly answer Ping with Pong (`stt.rs:279-300`, `tts.rs:351-372`).

## Findings

### Important

**1. Live turn path writes fabricated concept mastery data on every turn**

`agent/crates/agent-adapters/src/cartesia_gemini/runner.rs:795-853`

**What**: `emit_deterministic_study_tool_events` runs unconditionally in `emit_turn` (`runner.rs:469-484`) for both fake and live transports — the runner is generic over `CartesiaGeminiTransports` and nothing forks this stage. It always executes `mark_concept_status(..., "strong")` for `session.active_concepts[0]` and `schedule_review_item` for `active_concepts[1]` seeded from that same status, regardless of what the learner answered or what `evaluate_spoken_answer` concluded in the Gemini tool loop. When `active_concepts` is empty it silently falls back to fixture ids `"oxidative-phosphorylation"`/`"atp-synthase"`.

**Why it matters**: In a live session (gate open, real keys), every turn durably records status `"strong"` and schedules FSRS review items from a fabricated verdict, corrupting the learner-loop data the product is built on. It also undermines the Act 3 live-proof requirement (docs/superpowers/specs/live-cartesia-gemini-definition.md requires `recap_ready` "through the real provider cascade") — live smoke evidence would show server-fabricated statuses.

**Fix**: In the live transport path, derive concept status from the `AnswerEvaluation` produced by the Gemini tool loop (or the model's own `mark_concept_status` calls) and run the deterministic stages only for `FakeCartesiaGeminiTransports`; remove the fixture concept-id fallbacks or fail loudly when `active_concepts` is empty.

**2. Hardcoded biology fixture reply is spoken in live mode when Gemini returns no text**

`agent/crates/agent-adapters/src/cartesia_gemini/runner.rs:726-731`

**What**: `run_gemini_tool_loop` returns the literal string `"Good. Now connect the proton gradient to ATP synthase."` whenever the accumulated `response_prompt` is empty. The function is shared by the live path, and its return value is sent to Cartesia Sonic and spoken to the learner (`runner.rs:861-869`).

**Why it matters**: If Gemini's final pass yields only tool calls or empty text in a live session — a realistic outcome — a learner studying any non-biology subject hears an unrelated oxidative-phosphorylation prompt presented as real feedback. Fixture content leaking into live user-facing speech is a production-readiness defect.

**Fix**: Restrict the canned fallback to `FakeCartesiaGeminiTransports`; in the live path treat an empty final response as a provider stage failure (e.g. `malformed_stream`/empty-response) or synthesize a neutral, subject-agnostic retry prompt derived from the active question.

**3. Multi-turn sessions never re-emit QuestionStarted, so the client drops all events after the first completed turn**

`agent/crates/agent-adapters/src/cartesia_gemini/runner.rs:109-224`

**What**: The session loop emits `QuestionStarted` once (response-1) and then accepts unlimited further inputs, assigning response-2, response-3… without ever emitting another `question_started`. The web client's staleness guard (`apps/web/lib/viva-agent-client.ts:616-628`) drops any event whose `response_id` differs from `activeResponseId`; `activeResponseId` is set only by `question_started` (`viva-agent-client.ts:652-655`) and cleared only by a matching `cancellation` — there is no `response_completed` handler at all. The synthetic brain re-emits `QuestionStarted` on turn > 1 for exactly this reason, with an explanatory comment (`src/synthetic.rs:467-484`).

**Why it matters**: After a turn completes normally (no barge-in cancel to clear `activeResponseId`), every event of the next turn — transcript, evaluation, audio, recap — is silently counted as stale and discarded. The runner backs both the gated live brain and the selectable `FakeCartesiaGeminiRuntime` (wired in `agent-service/src/config.rs:634-638`), so this is live code diverging from the contract its sibling brain codifies; today it is latent only because the product flow ends each session at recap after one graded answer.

**Fix**: Mirror `synthetic.rs`: emit `QuestionStarted` with the new `response_id` at the start of each turn > 1 in `emit_turn` — or make the runner explicitly single-turn and terminal after recap and delete the dead multi-turn support.

**4. Barge-in and timeouts never send Cartesia a cancel; sockets are dropped mid-generation**

`agent/crates/agent-adapters/src/cartesia_gemini/tts.rs:257-266`

**What**: `cancel_sonic_context` is compiled only under `#[cfg(test)]`, and `sonic_cancel_request`/`sonic_flush_request` have no non-test callers anywhere in the repo (verified by grep). Live cancellation is implemented solely by aborting the turn task (`runner.rs:1953-1964` and `ActiveRunnerResponse::Drop`), which drops the WebSocket mid-generation without a close frame; stage timeouts likewise drop the connect/stream future (`tts.rs:171-177`, `stt.rs:144-150`) without closing.

**Why it matters**: Cartesia continues synthesizing (and billing) the cancelled context until it notices the TCP teardown, and abrupt drops instead of protocol-level cancel/close are exactly the path most likely to behave differently against the real service than in tests. Barge-in is a committed product default per the project decision log, making this the common case, not the edge case.

**Fix**: On cancellation, send `sonic_cancel_request(context_id)` and a proper close before dropping (e.g. run synthesis under `select!` with the cancelled flag instead of relying on task abort), and wrap timeout paths so the socket is closed via `close_quietly` before the future is discarded.

**5. No connection reuse and full buffering at every stage compound per-turn latency**

`agent/crates/agent-adapters/src/cartesia_gemini/llm.rs:522-533`

**What**: `stream_gemini_http_with_attempt_events` constructs a fresh `ReqwestGeminiSseClient::default()` — a brand-new `reqwest::Client` and connection pool — per call, and each turn makes 2 Gemini calls (tool pass + continuation, `MAX_GEMINI_TOOL_LOOP_PASSES = 2`). Ink and Sonic each perform a fresh TLS+WebSocket handshake per turn (`stt.rs:251-257`, `tts.rs:330-336`). The entire Gemini SSE body is read with `response.text()` before parsing (`llm.rs:557-560`) and all Sonic frames are collected before any `AudioDelta` is emitted (`tts.rs:195-232`, `runner.rs:861-883`).

**Why it matters**: For a voice product, time-to-first-audio is the sum of full STT + full LLM (x2) + full TTS completions plus 3-4 cold TLS handshakes every turn. The batch synthetic-turn architecture is a documented spike decision, but the per-call `reqwest::Client` is pure waste even within that design — `reqwest::Client` is explicitly designed to be created once and shared.

**Fix**: Store a shared `reqwest::Client` (and ideally persistent Ink/Sonic connections keyed per session) on `LiveCartesiaGeminiTransports`; longer term, stream SSE incrementally and forward Sonic chunks as they arrive so playback can start before generation completes.

**6. Live path reuses the fake error emitter, mislabeling live failures and dropping durability classification**

`agent/crates/agent-adapters/src/cartesia_gemini/mod.rs:603-658`

**What**: `emit_turn` reports all turn errors via `emit_fake_provider_error` (`runner.rs:373, 391, 459, 483`). Non-`StageFailure` errors emit `BrainProviderError` with message `"fake provider turn failed"` / source `"agent-service"` — or source `"fake-provider-store"` / `"store adapter error"` for store-flavored messages — always with `failure: None`. A live Postgres outage during `record_answer_attempt_envelope` (surfaced as `BrainError::Protocol`, `runner.rs:362-375`) therefore reaches clients and observability labeled as a fake-provider/store event with no `failure_class`, while the same outage inside a tool stage is correctly classified `durability_degraded` (`runner.rs:1213-1225`). `parse_result_field` protocol errors in the live loop take the same mislabeled path.

**Why it matters**: docs/provider-failure-observability.md requires dashboard grouping and alerting by `failure_class`/`stage`/`terminal_reason`; the envelope-write path silently escapes that taxonomy, and "fake provider turn failed" in production logs is actively misleading during incident response.

**Fix**: Route live-path errors through a live-specific emitter that classifies non-stage errors via `provider_failure_classification`/`port_error_is_durability_degraded` into a proper `BrainProviderFailure` (reusing `tool_stage_error` semantics for the envelope write), reserving the "fake provider" wording for `FakeCartesiaGeminiTransports`.

### Minor

**1. Transcript confidence is a fabricated constant in live mode**

`agent/crates/agent-adapters/src/cartesia_gemini/runner.rs:127-160`

**What**: The session loop hardcodes confidence `Some(0.91)` for all audio inputs and `Some(1.0)` for text, and `TranscriptFinal` uses `job.confidence.or(transcript.confidence)` (`runner.rs:409-421`), so the constant always beats the provider value. The Ink adapter never parses a real confidence — `InkTranscript.confidence` is always `None` (`stt.rs:225-234`).

**Why it matters**: Clients receive an invented 0.91 in `TranscriptFinal` for every live utterance, which will silently poison any confidence-based UX or monitoring while looking like real provider data. (The stored `transcript_confidence_bucket` envelope field is not affected — the runner writes it as `None`, `runner.rs:1018` — so the corruption is client/event-facing, not yet analytics-store-facing.)

**Fix**: Parse confidence from Ink events when the API provides it; otherwise propagate `None` and let consumers treat confidence as absent instead of substituting a constant.

**2. Five declared dependencies are unused**

`agent/crates/agent-adapters/Cargo.toml:12-24`

**What**: `base64`, `thiserror`, `tokio-util`, `tracing`, and `uuid` have zero references in src/ or tests/ (verified by grep; the only "base64" hits are identifier substrings like `pcm16_base64` — `AudioFrame::from_base64` lives in agent-domain).

**Why it matters**: Dead dependencies add compile time and audit surface, and the absence of any `tracing` usage means this crate emits no spans/logs of its own — all provider observability rides on returned error values.

**Fix**: Remove the five unused entries (`cargo machete`/`cargo +nightly udeps` will confirm); decide whether stage-level tracing spans are wanted before deleting the `tracing` dependency.

**3. Dead/unreachable code in the fallback loop and tool-loop budget path**

`agent/crates/agent-adapters/src/cartesia_gemini/llm.rs:394-399`

**What**: The post-loop `Err` at `llm.rs:394-399` (and the `last_rate_limit` bookkeeping feeding it) is unreachable: `gemini_stream_attempts` always includes the primary config, and every loop iteration returns except the continue-on-429 case, which requires a next attempt. In `runner.rs:604-609` the per-event budget check inside the event loop is unreachable — the preflight batch check over the fully-materialized stream (`runner.rs:569-591`) already returns for final-pass tool calls — and if it ever ran it would attribute the failure to `self.config.gemini.model_id` instead of the promoted `active_gemini` model. `GeminiConversation::push_user_text_with_source_context` and the `trusted_source_context` declaration machinery (`llm.rs:124-147`, `1262-1284`) have no callers outside llm.rs.

**Why it matters**: Unreachable branches with subtly different behavior (wrong model attribution) are traps for future edits, and the orphaned source-context API suggests an unfinished integration for feeding retrieved course context to Gemini.

**Fix**: Replace the post-loop `Err` with `unreachable!()` or restructure the loop; delete the inner per-event budget branch (or fix it to use `active_gemini`); either wire `push_user_text_with_source_context` into the runner's conversation building or remove it.

**4. Ink websocket query string is built without URL-encoding env-controlled values**

`agent/crates/agent-adapters/src/cartesia_gemini/stt.rs:58-70`

**What**: `websocket_endpoint` `format!`-concatenates `model`, `language`, `encoding`, `min_volume`, `max_silence_duration_secs`, and `cartesia_version` directly into the query string; `min_volume` and `max_silence_duration_secs` are free-form `String`s taken verbatim from env vars (`mod.rs:162-168`) with no numeric validation.

**Why it matters**: A stray space, `&`, or `#` in an operator-provided env value silently injects or corrupts query parameters, producing confusing connect failures (the error is sanitized to "invalid Cartesia Ink WebSocket URL" or a generic connect failure). Only operators can trigger it, so impact is low.

**Fix**: Percent-encode each query value, or parse `min_volume`/`max_silence_duration_secs` as `f32` in `from_env` the way `sample_rate` is parsed.

**5. Invalid API-key header error is misclassified as a retryable network disconnect on the primary attempt**

`agent/crates/agent-adapters/src/cartesia_gemini/llm.rs:538-539`

**What**: `ReqwestGeminiSseClient` maps an unparseable key header to `Protocol("invalid Gemini API key header value")`, but for the primary attempt `sanitize_gemini_stream_error` (`llm.rs:482-495`) collapses any status-less message to `Connection("Gemini stream request failed")`, which `provider_failure_classification` then classifies as `network_disconnect` with `retry_eligible=true` — even though the original message contained "api key" and should classify as non-retryable `provider_auth_failure`. (Fallback attempts happen to classify correctly because `gemini_transport_stage_failure` sees the unsanitized message.)

**Why it matters**: A key containing non-ASCII characters would be retried/backed-off as a network issue instead of surfacing immediately as an auth misconfiguration, delaying diagnosis during live-smoke setup.

**Fix**: Return `BrainError::MissingApiKey` (or classify before sanitizing) for header-construction failures so the auth taxonomy survives sanitization on every attempt.

## Verification notes

No findings were refuted. All six important findings were confirmed directly against the cited code, including the negative-space claims (grep confirmed `sonic_cancel_request`/`sonic_flush_request` have only `#[cfg(test)]` callers; grep confirmed the five Cargo.toml dependencies have zero source references; the web client's case list confirmed there is no `response_completed` handler). Two corrections were made without changing severity:

- F7 (fabricated confidence): the claim that `transcript_confidence_bucket` receives the invented 0.91 was wrong — the runner writes that envelope field as `None` (`runner.rs:1018`) and nothing else populates it; the fabricated value reaches clients via `TranscriptFinal` only. Impact statement corrected, still minor.
- F11 (API-key header misclassification): narrowed to the primary attempt — fallback attempts route through `gemini_transport_failure_classification`, which sees the unsanitized "api key" message and classifies correctly as `provider_auth_failure`. Still minor.

F3's blast radius was additionally verified beyond the first pass: the runner also backs the selectable `FakeCartesiaGeminiRuntime` wired in `agent-service/src/config.rs:634-638`, so the multi-turn divergence is not confined to the gated live brain.

## Recommendations

1. Before opening the Act 3 live gate, sweep the shared runner for fixture-era scaffolding the live mode inherits: the fabricated "strong" concept statuses, the biology fallback reply, the constant 0.91 confidence, and the fake-labeled error emitter (Important 1, 2, 6; Minor 1) share one root cause — `emit_turn`/`emit_deterministic_study_tool_events` were written for the fake replay and never forked for live semantics.
2. Decide the multi-turn contract explicitly: either re-emit `QuestionStarted` per turn like the synthetic brain (and add a client-integration test covering a second completed turn), or make the runner single-turn and terminal after recap so the dead path cannot regress (Important 3).
3. Hold a persistent `reqwest::Client` on `LiveCartesiaGeminiTransports` now (one-line win), and file the streaming-SSE + streaming-TTS latency work as its own ticket since it changes the transport trait signatures (Important 5).
4. Implement protocol-level cancellation for Sonic (and graceful close on timeout for both Cartesia sockets) before live barge-in testing, since barge-in is a committed product default per the project decision log (Important 4).
5. Add a live-path error-emission test mirroring the fake-runtime stage-failure test but for an envelope-write store failure, asserting it carries `failure_class=durability_degraded` rather than the fake-provider label (Important 6).
6. Run `cargo machete`/`udeps` in CI for the agent workspace to keep the dependency list honest (Minor 2), and consider adding tracing spans per provider stage while the dependency is still declared.
7. Consider surfacing sanitized provider error detail (e.g. a coarse error code from Ink/Sonic `error` payloads) into failure metadata the way Gemini's `body_status` is captured — Cartesia failures currently reduce to a single generic string per stage, which will make live-smoke triage harder than it needs to be.

## Assessment

**Verdict: sound-with-fixes** (unchanged from the first-pass reviewer; verification confirmed all eleven findings, refuting none). The transport engineering is genuinely strong — systematic leak-tested sanitization, thorough 429/fallback machinery, cancellation proven against real store state, defense-in-depth live gating — and nothing found breaks the currently shipped product, because the live runtime is triple-gated off and the fake/synthetic paths are the production surface. But the shared runner still carries fixture-era behavior the live path inherits verbatim (fabricated concept mastery, a biology fixture spoken aloud, constant confidence, fake-labeled errors, and a multi-turn contract the web client silently drops), so the crate is not yet honest about what a live session would record or say. These are contained, well-localized fixes — mostly forking live behavior from fake behavior in `emit_turn` — hence sound-with-fixes rather than needs-work.
