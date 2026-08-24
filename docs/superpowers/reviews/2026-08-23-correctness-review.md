# Viva correctness review — 2026-08-23

**Scope:** Browser capture through WebSocket, study ingestion, question/evaluation/recap tools, scheduling, session projection, and persistence semantics.  
**Overall confidence:** High.

## Findings

| ID | Priority | Finding | Confidence |
| --- | --- | --- | --- |
| COR-01 | P0 | Live microphone answers longer than about 1.022 s exceed the server text-frame cap | High |
| COR-02 | P1 | Persisted review dates are fixed June 2026 timestamps | High |
| COR-03 | P1 | Postgres initialization reseeds and undeletes fixture data on every boot | High |
| COR-04 | P1 | PDF ingestion treats binary PDF bytes as lossy UTF-8 text | High |
| COR-05 | P1 | Session and recap projection remain bound to the biology seed fixture | High |
| COR-06 | P1 | The authoritative evaluator and recap builder ignore semantics/session mastery | High |
| COR-07 | P1 | Successful recap renders a connection-failure state and recovery action | High |
| COR-08 | P2 | Streaming resampling resets phase for every source callback | High |
| COR-09 | P2 | Landing intent and non-quiz modes are visible but do not reach the live session | High |
| COR-10 | P2 | “Next question” selects the store's active question without progression policy | High |

## COR-01 — P0 — The primary live voice path rejects normal answers

The browser capture produces 20 ms PCM16 chunks, but `LiveSessionPage` does not stream them. `onFrame` appends each chunk to `capturedTurnPcm16Ref`; `submitSpokenTurn` merges the complete turn with `pcm16ChunksToBase64` and calls `sendAudio` once (`apps/web/components/session/LiveSessionPage.tsx:416-425,484-500,1113-1123`).

`sendAudio` serializes that base64 as one JSON WebSocket **text** message (`apps/web/lib/viva-agent-client.ts:806-818,917-919`; `packages/core/src/agent-contract.ts:247-256`). The protocol caps text frames at 64 KiB in both TypeScript and Rust, and the server checks the cap before deserialization (`packages/core/src/agent-contract.ts:4`; `agent/crates/agent-service/src/protocol.rs:12`; `agent/crates/agent-service/src/ws.rs:2902-2912`).

At 24,000 samples/s, mono PCM16 is 48,000 raw bytes/s. Base64 expands by about 4/3, before JSON/generation metadata:

| Spoken duration | Raw PCM | Serialized text frame | Server result |
| ---: | ---: | ---: | --- |
| 1.00 s | 48,000 B | 64,103 B | Fits narrowly |
| 1.02 s | 48,960 B | 65,383 B | Fits narrowly |
| 2.00 s | 96,000 B | 128,103 B | Rejected |
| 10.00 s | 480,000 B | 640,103 B | Rejected |
| 45.00 s | 2,160,000 B | 2,880,103 B | Rejected |

A binary search using the actual protocol shape found a maximum of 24,537 samples, or **1.022375 seconds**, for a representative generation ID. The server's targeted real-WebSocket test passed and confirmed oversized text closes with a size code and `oversized_text_frame` terminal evidence.

The existing client test asserts a four-byte payload, and browser E2E uses synthetic/written input. No test joins the real capture buffer to the server cap.

**Impact:** Ordinary spoken answers disconnect the primary live-provider workflow. This is release-blocking.

**Remediation:** Define a real streaming input lifecycle: bounded PCM frames (prefer binary), generation/turn identity on every frame, explicit end-of-turn, backpressure, cancellation, and a total-turn cap independent of frame size. Do not merely raise the frame cap to 2.9 MB. Add browser-to-server tests at 2, 10, and 45 seconds and test slow-consumer behavior.

## COR-02 — P1 — Scheduling writes dates in the past

`storage_due_at_for_status` exists in both the domain executor and synthetic adapter and returns literals from `2026-06-18T09:00:00Z` through `2026-06-24T09:00:00Z` (`agent/crates/agent-domain/src/tool_executor.rs:339-346`; `agent/crates/agent-adapters/src/synthetic.rs:808-814`). The executor explicitly rejects model `due_at` because `@viva/core` is supposedly authoritative, then writes those Rust literals (`tool_executor.rs:229-251`).

On the review date every new persisted review is already overdue. Meanwhile the browser computes fresh FSRS dates, so library history and recap can disagree about the same concept.

**Remediation:** Choose one persisted scheduler. Pass an injected clock into a Rust FSRS/relative scheduler or persist status-only events and compute schedule in one service. Delete duplicated calendar literals and add a test whose clock is later than the repository creation date.

## COR-03 — P1 — Agent boot can resurrect deleted fixture material

Every `DATABASE_URL` startup runs migrations and then unconditionally calls `seed_postgres_fixture` (`agent/crates/agent-service/src/config.rs:575-591`). The seed uses `ON CONFLICT DO UPDATE` across the well-known biology IDs and explicitly sets `study_documents.deleted_at = NULL` and `source_spans.deleted_at = NULL` (`agent/crates/data/src/migrations.rs:71-129`). It also overwrites concept statuses.

**Impact:** Restarting a production/durable agent can undo a user's deletion/tombstone and mutate a known study set. This contradicts privacy-delete semantics and makes startup non-idempotent with respect to user state.

**Remediation:** Never seed from normal production startup. Put fixtures behind an explicit development/test command, use a separate fixture database/tenant, and add a Postgres test proving restart cannot change or undelete existing rows.

## COR-04 — P1 — A `.pdf` label is not PDF support

The HTTP route base64-decodes uploaded bytes (`agent/crates/agent-service/src/app.rs:1821-1889`). `generate_file_study_set` classifies by filename/content type and passes the bytes to `normalize_file_bytes`; that function runs `String::from_utf8_lossy`, strips controls, and collapses whitespace (`agent/crates/data/src/memory.rs:1028-1088,1199-1212`). No PDF parser, page text extractor, or OCR path exists.

Tests hide the defect by using UTF-8 study notes prefixed with `%PDF-1.7` and named `Lecture 9.pdf` (`memory.rs:3925+`; `voice_ws.rs:743+`). A real compressed PDF will yield object-table/compressed-stream garbage or almost no usable text, yet the set can be marked `ready` and questions can be generated from artifacts.

**Remediation:** Fail closed on PDF until extraction is implemented. Parse into page-anchored text, preserve locator provenance, bound decompression/OCR, and distinguish text, scanned, encrypted, malformed, and unsupported files. Use real generated PDF fixtures, not a magic header plus plain text.

## COR-05 — P1 — Route identity is painted onto a fixture

`LiveSessionPage` starts with `seedStudySets[0]`, spreads it, and overwrites only route user/study/session/token fields. The presence of any route study-set ID also forces `serverOwned: true` and `ingestionStatus: ready` (`apps/web/components/session/LiveSessionPage.tsx:69-94`). Title, course, exam label, concepts, generated cards, and readiness facts remain Biology Midterm.

After the server sends a recap, `recapPlanFromSessionEvents` replaces its strong/shaky/missed/review arrays with labels derived from the active fixture's concepts and client-side status events (`apps/web/lib/viva-display.ts:78-108`). It then computes a browser FSRS plan.

**Impact:** A pasted/library set can ask the server's question while the UI describes biology and remaps mastery onto NADH/ATP synthase. Query-string presence is incorrectly treated as proof of ingestion readiness.

**Remediation:** Fetch one server-owned study-set/session projection before connecting. Render server recap facts unchanged; schedule only against server concept IDs. Delete optimistic `ready` inference from route identity.

## COR-06 — P1 — The “authoritative” grade is term occurrence, not understanding

`evaluate_spoken_answer` lowercases the answer and counts `normalized_answer.contains(expected_term)`. It does not tokenize, handle negation, synonyms, causal correctness, prompt-specific rubrics, or contradictions (`agent/crates/agent-domain/src/tool_executor.rs:86-132`). “NADH does not donate electrons” still matches terms. `concept_status_for_terms` converts only the count into mastery.

`build_session_recap` does not read stored answer evaluations or concept statuses. It labels the first two expected terms strong, the next two shaky/review, and no terms missed (`tool_executor.rs:165-206`). The live Cartesia/Gemini runner invokes these tools, so a sophisticated model does not remove the deterministic misgrading beneath it.

**Impact:** Viva can persist incorrect mastery and recap data with high confidence, precisely where the product promises oral-exam evaluation.

**Remediation:** Introduce a versioned rubric/evaluation boundary with structured evidence, negation/contradiction handling, explicit uncertainty, and human-challenge semantics. Build recap from persisted authoritative turn outcomes, not expected-term positions. Retain deterministic evaluation only as an explicitly labeled synthetic fixture.

## COR-07 — P1 — Completion is rendered as failure

The executed local E2E produced a successful `recap_ready` terminal fold, but the screenshot simultaneously showed:

- top capsule: “Session not connected”;
- marginalia/turn copy: “Agent ready; session not connected”;
- next action: “Retry agent.”

`projectRuntimeCopy` sees a closed socket plus green HTTP readiness and chooses `session_disconnected` because it has no recap/completion input (`apps/web/lib/viva-session-projection.ts:196-235,390-406`). The recap projection and runtime projection therefore contradict each other.

**Impact:** A completed session looks failed, and the learner is invited to retry an already-completed agent.

**Remediation:** Make successful recap/controlled terminal completion dominate transport status. Add an E2E assertion on visible terminal copy, not only `recap_success` and screenshots existing.

## COR-08 — P2 — 44.1 kHz audio drifts at callback boundaries

`resampleFloat32ToSampleRate` rounds output length independently for every source block and starts interpolation phase at zero (`apps/web/lib/viva-audio-capture.ts:104-132`). The streaming capture calls it for each AudioWorklet callback (`viva-audio-capture.ts:289-303`). For a common 128-sample callback at 44.1 kHz, each block rounds 69.66 output samples to 70, an effective 24,117.19 Hz (+0.488%), while the interpolation boundary loses cross-block phase continuity.

Tests cover only a tiny 48 kHz-to-24 kHz exact-ratio block (`viva-audio-capture.test.ts:93-101`).

**Remediation:** Use a stateful streaming resampler that carries fractional phase and the boundary sample. Test long inputs and frequency/duration error at 44.1 and 48 kHz across irregular callback sizes.

## COR-09 — P2 — Four modes and typed intent collapse to quiz

The landing command and suggestion actions navigate to the same session target without sending the entered goal. `LiveSessionPage` always calls `useVivaAgentSession({ mode: "quiz" })` (`LiveSessionPage.tsx:112-120`). Teach/mock/cram exist in types and copy but are not selectable behavior on the mounted path.

**Remediation:** Include mode and optional initial goal in the signed session-start contract, or remove inputs that imply behavior the application discards.

## COR-10 — P2 — Question selection is not progression

The domain `select_next_question` simply returns `active_question()` (`tool_executor.rs:81-84`). There is no demonstrated policy for advancing, avoiding repetition, adapting to mastery, or exhausting a set. This is acceptable for the deterministic single-question fixture but not for a general study product.

**Remediation:** Define progression state and selection invariants in the store/domain boundary; test multi-question sets, retries, completed questions, and concurrent reconnects.

## Correctness acceptance gate

Do not call the primary loop complete until one browser test captures actual multi-second audio, sends it through the same production client controller, receives a transcript/evaluation, persists it, renders an accurate recap, and proves the displayed study set and schedule came from the same server-owned identity.
