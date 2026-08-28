<p align="center">
  <picture>
    <source media="(max-width: 500px)" srcset="docs/assets/hero-mobile.svg" />
    <img src="docs/assets/hero.svg" alt="Viva: study by talking, not rereading" width="900" />
  </picture>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-7a5ba6?style=flat-square" alt="License: Apache-2.0"></a>
  <a href="https://github.com/backbay-labs/viva/actions/workflows/validate.yml"><img src="https://img.shields.io/github/actions/workflow/status/backbay-labs/viva/validate.yml?branch=main&amp;style=flat-square&amp;label=validate" alt="Validate"></a>
  <a href="agent/crates/agent-service/src/protocol.rs"><img src="https://img.shields.io/badge/voice%20protocol-v5-7a5ba6?style=flat-square" alt="Voice protocol v5"></a>
  <img src="https://img.shields.io/badge/rust-1.94-c1864a?style=flat-square&amp;logo=rust&amp;logoColor=white" alt="Rust 1.94">
  <img src="https://img.shields.io/badge/bun-1.3-bd9a55?style=flat-square&amp;logo=bun&amp;logoColor=white" alt="Bun 1.3">
  <a href="docs/"><img src="https://img.shields.io/badge/docs-read-5d5670?style=flat-square" alt="Docs"></a>
</p>

<p align="center">
  <strong>An oral exam room for the AI era.</strong>
</p>

<p align="center">
  <a href="#what-is-viva">What</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="#the-loop">The loop</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="#quickstart">Quickstart</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="#architecture">Architecture</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="#study-mode">Mode</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="#privacy-and-trust">Privacy</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="#what-is-proven-and-where">Evidence</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="#roadmap">Roadmap</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

```sh
git clone https://github.com/backbay-labs/viva.git && cd viva && bun install && bun run dev:agent
```

The whole study loop runs on that command: no API keys, no microphone, no database.

> The machine-checked statement of everything below is
> [`docs/public-contract.json`](docs/public-contract.json), generated from the code by
> `node scripts/public-contract.mjs --write`. If this page and that file disagree, the file is
> right and the drift gate fails.

## What is Viva

Viva is a voice-first study companion that turns a student's own course material into live oral
examination. A student pastes a study guide, a chapter, or a set of notes — or uploads them as
UTF-8 text. Viva reads the material, identifies the concepts in it that can be tested, and opens a
session that asks about them out loud.

Recognition is not retrieval. An open page supplies the answer the moment a student falters, so
rereading it registers as understanding. Viva takes the page away first, which is what the exam
does later.

A session opens the way an oral exam opens:

> "Close the notes. Explain the role of NADH in oxidative phosphorylation."

The student answers out loud. Viva evaluates the spoken answer against what the uploaded material
claims, and an answer that is close but incomplete is named as such, with the place to go and fix
it:

> "Good start. You named the electron transport chain but skipped why NADH matters. Try again
> using the phrase *electron donor*. Your professor defines this on Lecture 5, slide 18."

Every correction is grounded in a passage the student supplied. Viva holds no position on the
subject matter. It holds the lecture deck, and it cites it.

What accumulates across sessions is a mastery map: the concepts a student can explain cold, the
ones that collapse under a single follow-up, and the ones never yet answered correctly. Weak
concepts return on an FSRS spaced-repetition schedule, so a concept missed on Tuesday is asked
again on Thursday.

> Most study tools help a student produce more material.<br>
> Viva makes a student retrieve, explain, and repair the material already in hand.

### What ingestion accepts today

| Input | Status |
| --- | --- |
| Pasted study text | Accepted. `POST /study-sets/paste` is the primary path. |
| UTF-8 text upload | Accepted. Invalid UTF-8 is refused rather than repaired, because a replacement character is a fabricated learner fact. |
| PDF upload | Refused, fail-closed, with `unsupported_pdf`. There is no page-aware extraction and no OCR, so a PDF cannot be turned into grounded source spans. Accepting it anyway produced "concepts" made of PDF syntax. |

## The loop

<p align="center">
  <picture>
    <source media="(max-width: 500px)" srcset="docs/assets/loop-mobile.svg" />
    <img src="docs/assets/loop.svg" alt="The Viva learner loop: upload, extract, recall, correct, master, return" width="900" />
  </picture>
</p>

Three layers on one session spine: every question, correction, and review date resolves to
recorded concept state.

### Recall

> Spoken answers go in. Graded, addressable, interruptible turns come out.

| Primitive | What it does |
| --- | --- |
| **A realtime voice loop** | 24 kHz `pcm_s16le` in, streamed speech out, over a single WebSocket at `/ws` on protocol v5. Partial transcripts arrive while the student is still speaking. |
| **Bounded frames, bounded turns** | One `audio_chunk` carries at most 4,096 samples / 8,192 bytes; one turn carries at most 1,080,000 samples / 2,160,000 bytes and resolves within 45 seconds. The caps are shared constants, enforced on both sides of the wire. |
| **Barge-in as a protocol frame** | Interrupting sends `cancel`, a first-class client frame that collapses the in-flight turn on the server, rather than a client-side mute over a request already in motion. |
| **One turn, one identity** | Every turn carries a single `response_id`, so the interface always knows what is being asked, answered, evaluated, or discarded. |
| **One mode, one loop** | The wire vocabulary is exactly `quiz`. The `teach`, `mock`, and `cram` labels named engines that were never built, and the server now rejects them rather than parsing a mode it cannot honour. |

### Grounding

> Citation is part of the correction, not an attachment to it.

| Primitive | What it does |
| --- | --- |
| **Source-cited corrections** | `retrieve_source_reference` pulls the passage that settles the point. Corrections name a document, page, or slide. |
| **Intent, not guesswork** | The brain emits `manuscript_intent`, so what surfaces in the margin is a decision the agent made rather than one the client invented. |
| **A contestable correction** | `challenge_correction` lets a student dispute a correction out loud and forces the agent to ground it again. |
| **The server is authoritative** | Browser-supplied identity, study set, retrieval context, and tool results are rejected or stripped before the brain or the store sees them. |

### Mastery

> Concept state and the next review date are written by the session itself, not reconstructed after it.

| Primitive | What it does |
| --- | --- |
| **Per-concept status** | A graded turn persists one of `strong`, `shaky`, `missed`, or `review` for the concept. Mastery moves only inside a persisted turn outcome, never as a model-selected tool argument. |
| **FSRS scheduling, server-persisted** | The recorded authority is `server_persisted_fsrs`: [`agent/crates/agent-domain/src/review_schedule.rs`](agent/crates/agent-domain/src/review_schedule.rs) computes and persists the review decision under policy `viva.fsrs6-default.1`, and the browser only formats what the authenticated projection hands it. [`packages/core/src/scheduling.ts`](packages/core/src/scheduling.ts) is a semantic mirror pinned to the same fixture; it is a reader, not the writer. |
| **A recap that closes the session** | `build_session_recap` reports what held, what did not, and what the next session covers. |
| **Learner-safe failure** | A submitted answer resolves to exactly one learner-safe state within 45 seconds. Learner copy and operator diagnostics are separate fields, enforced by [contract](packages/core/src/learner-loop-contract.json). |

## Quickstart

### 1. Clone and install

```sh
git clone https://github.com/backbay-labs/viva.git && cd viva
bun install
```

Bun 1.3.3 and Rust 1.94.1. Both toolchains are pinned; nothing else is required.

### 2. Start the agent

```sh
bun run dev:agent
```

This binds `127.0.0.1:4318` with `VIVA_AGENT_PROVIDER=synthetic`, a deterministic study brain that
runs the entire loop against fixtures. It asks questions, evaluates answers, cites sources, records
concept state, schedules reviews, and writes a recap, with no provider keys, no network calls, no
microphone hardware, and no Postgres.

### 3. Start the web app

```sh
bun run dev:web
```

Open <http://localhost:3000> and go to `/session`.

### 4. Exercise the real provider shape, still without keys

```sh
VIVA_AGENT_PROVIDER=fake_cartesia_gemini bun run dev:agent
```

This drives the Cartesia/Gemini-shaped runtime through the real WebSocket service boundary: the
same frames, the same turn model, and the same failure paths, with no credentials and no network.

### 5. Run the gate

```sh
bun run validate
```

Typecheck, lint, test, and build across TypeScript, plus `cargo fmt`, `clippy -D warnings`, `test`,
`build`, `bun run agent:purity`, and `bun run agent:residue` across Rust, then artifact hygiene, the
module-concentration ratchet, and the dependency audits. **No default gate in this repository
requires a provider key, a paid network call, or a local Postgres.** That is a rule rather than an
accident of the current setup; see [CONTRIBUTING.md](CONTRIBUTING.md).

<sub>Live voice through real Cartesia and Gemini credentials is off by default and gated behind
<code>VIVA_CARTESIA_GEMINI_LIVE_RUNTIME=1</code> plus both zero-data-retention approvals. See
<a href="agent/README.md">agent/README.md</a> and <a href="docs/data-governance.md">docs/data-governance.md</a>.</sub>

## Architecture

A Next.js client, one WebSocket, and a Rust agent whose study brain is a pure function of the
session state. The service is the only component that speaks to the network, and the domain crate
is written to hold no I/O at all.

<p align="center">
  <picture>
    <source media="(max-width: 500px)" srcset="docs/assets/architecture-mobile.svg" />
    <img src="docs/assets/architecture.svg" alt="Viva architecture: Next.js web client, WebSocket edge, agent-service, a pure agent-domain core, swappable adapters, and an in-memory or Postgres store" width="960" />
  </picture>
</p>

`bun run agent:purity` is the gate that keeps that boundary honest, and it is worth being exact
about what it proves: it reads `agent-domain`'s direct normal-dependency set from `cargo metadata`
and checks it against a declared allowlist, and it scans every `agent-domain` source file for
forbidden module imports. It does not prove adapter purity, runtime I/O behavior, or live provider
behavior — those belong to runtime tests. `bun run agent:residue` is a separate, narrower check: it
asserts the removed legacy domain vocabulary is absent from `agent`, `packages`, and `apps`.

Because the brain is pure and the runtimes sit behind one port, the synthetic provider is not a
mock bolted on for tests. It is a first-class runtime exercising the same code path production
uses, which is why the default developer setup needs no keys.

### Life of a study turn

<p align="center">
  <picture>
    <source media="(max-width: 500px)" srcset="docs/assets/lifecycle-mobile.svg" />
    <img src="docs/assets/lifecycle.svg" alt="Life of a study turn: speak, stream, transcribe, evaluate, ground, correct, record, schedule" width="900" />
  </picture>
</p>

| Step | What happens |
| --- | --- |
| **1 &middot; Speak** | The student answers out loud with the notes closed. The browser captures 24 kHz `pcm_s16le`. |
| **2 &middot; Stream** | Audio crosses the socket as `audio_chunk` frames, at most 8,192 bytes each, closed by `audio_end`. `turn_intent` and `cancel` share the same channel, so interrupting is a frame rather than a disconnect. |
| **3 &middot; Transcribe** | Partial transcript events stream while the student is still speaking; the utterance closes with a confidence score. |
| **4 &middot; Evaluate** | `evaluate_spoken_answer` judges the answer against the concept, assessing whether the explanation holds rather than matching strings. |
| **5 &middot; Ground** | `retrieve_source_reference` pulls the passage from the student's own materials that settles the point. |
| **6 &middot; Correct** | `answer_evaluated` and `manuscript_intent` carry the correction, the citation, and where it belongs on screen. |
| **7 &middot; Record** | The turn outcome persists the concept's new status: `strong`, `shaky`, `missed`, or `review`. |
| **8 &middot; Schedule** | The server computes and persists the FSRS return date from that outcome; at session end `build_session_recap` emits `recap_ready`. |

Every turn resolves. A turn that fails still resolves, to exactly one learner-safe state, with the
operator diagnostics recorded separately.

### The codebase

| Path | What lives there |
| --- | --- |
| `apps/web` | The Next.js session surface: live session shell, source folio, correction marginalia, voice trace |
| `packages/core` | The shared agent/wire contract, the learner-loop contract, the authenticated study projection, learner recovery copy, and the browser-side FSRS mirror |
| `packages/ui-web` | Shared React components |
| `packages/tokens` | The design tokens the product, and every diagram above, is drawn from |
| `agent/crates/agent-service` | The axum WebSocket service: protocol, session auth, config, readiness |
| `agent/crates/agent-domain` | The study brain: questions, evaluation, the declared tools, the persisted review-schedule authority, and the ports they call through. Pure, no I/O |
| `agent/crates/agent-adapters` | Synthetic, fake-Cartesia/Gemini, and live Cartesia/Gemini runtimes behind one port |
| `agent/crates/data` | In-memory fixture store and Postgres, with migrations |
| `agent/crates/observe` | Structured operator evidence: stage, provider, latency, cost, and never learner content |

The five tools the brain can propose are `select_next_question`, `evaluate_spoken_answer`,
`retrieve_source_reference`, `challenge_correction`, and `build_session_recap`. Adding a sixth means
adding it to [`agent-domain/src/tools.rs`](agent/crates/agent-domain/src/tools.rs) and nowhere else.
Concept status and the next review date are deliberately *not* on that list: both are derived from
server state inside a persisted turn outcome, so a model cannot propose a mastery claim or a due
date at all.

## Study mode

One loop, one setting of pressure.

| Mode | For | How it behaves |
| --- | --- | --- |
| **Quiz** | Fast active recall | Short questions, quick turns, breadth over depth. The only mode the server accepts. |

## Privacy and trust

Viva handles a student's course material and their voice. Five controls govern that, each one
fail-closed:

- **The default path needs no secrets.** `VIVA_AGENT_PROVIDER=synthetic` performs no provider calls
  and no network I/O, so the whole loop can be run and read without sending a byte anywhere.
- **Zero data retention is a precondition, not a preference.** The live runtime is unreachable
  unless `CARTESIA_ZERO_DATA_RETENTION_ENABLED=1` and `GEMINI_ZERO_DATA_RETENTION_APPROVED=1` are
  set, and those are set only after the provider-side controls in
  [docs/data-governance.md](docs/data-governance.md) are confirmed.
- **The server is authoritative.** Browser-supplied identity, study set, retrieval context, and tool
  results are rejected or stripped before the brain or the store sees them. A client cannot assert
  its way into another student's material.
- **Binds fail closed.** Non-loopback binds refuse to start without auth and
  `VIVA_VOICE_WS_ALLOWED_ORIGINS`. Signed session credentials bind user, study set, session, expiry,
  and nonce, with replay protection.
- **Deletion purges the text.** Deleting a study set runs the `hard_purge_text` policy: no
  learner-authored or learner-derived text survives, and what remains is a content-free tombstone —
  identifiers, timestamps, and fixed constants — kept only so a repeated delete stays idempotent.
- **Diagnostics carry no learner content.** The learner-loop contract permits stage, provider,
  latency, and cost evidence, and excludes raw audio, answer content, provider payloads, source
  material, and credentials. A redaction gate enforces this on every pull request.

Report vulnerabilities privately per [SECURITY.md](SECURITY.md).

## What is proven, and where

Not every claim on this page is proven the same way, so the levels are named rather than blurred:

| Level | What it covers | Where it runs |
| --- | --- | --- |
| Local, no secrets | Typecheck, lint, unit and script tests, build, Rust fmt/clippy/test/build, the boundary and residue gates, artifact hygiene, dependency audits | `bun run validate` on any machine |
| Continuous, hosted | The same gate plus the direct WebSocket replay, both browser voice matrices, the frontend accessibility and performance harnesses, sanitized release evidence, and the **Durable Postgres proof** job against a real PostgreSQL 16 service | The `Validate` workflow, aggregated by the required `Required validation` check |
| Durable | Migrations from an empty database, migration replay, restart and two-instance behavior, deletion and non-resurrection | The durable Postgres job above and the disposable-database procedure in [docs/deployment-runbook.md](docs/deployment-runbook.md) |
| External | Real Cartesia/Gemini traffic, a real deployment, a real microphone, non-Chromium browsers, and screen readers | Never inferred from the levels above. See [docs/release-readiness.md](docs/release-readiness.md) |

## Roadmap

The loop is in place. What follows extends it and is **not shipped today**: material Viva can read
without preprocessing, mastery modeled as structure rather than a list, and evidence that the method
works. The windows below are indicative.

- **Sep 2026 &middot; Real course material.** Ingestion that survives what students actually have:
  scanned PDFs, slide decks with speaker notes, annotated readings, and lecture recordings, with
  page-accurate citations that hold up when tapped. Today PDFs are refused rather than guessed at.
- **Oct 2026 &middot; The concept mastery field.** Per-concept status becomes a dependency graph,
  so a Krebs cycle that keeps collapsing is traced to the glycolysis that never landed, and the
  prerequisite is drilled first.
- **Nov 2026 &middot; More than one setting of pressure.** The retired `teach`, `mock`, and `cram`
  vocabulary comes back only when there is an engine behind it: timed, rubric-scored oral exams with
  the grading standard visible up front and a transcript a student can take to an office hour.
- **Dec 2026 &middot; Study rooms.** More than one student in a session, with Viva running the
  room: cold-calling, cross-examining, and scoring each participant separately.
- **Jan 2027 &middot; On-device.** The synthetic brain already runs with no network. A real one
  that does the same makes a study call work on a plane, with no audio leaving the device.
- **Feb 2027 &middot; Open evaluation.** A public benchmark for oral recall tutoring, scored on
  whether explanations measurably improved against held-out exam performance rather than on
  engagement.

## Choose your path

- **Run the whole loop with no keys** - the [Quickstart](#quickstart) above
- **Read the voice protocol** - [`agent-service/src/protocol.rs`](agent/crates/agent-service/src/protocol.rs)
- **Read what actually ships** - [`docs/public-contract.json`](docs/public-contract.json)
- **Change how answers are judged** - [`agent-domain/src/brain.rs`](agent/crates/agent-domain/src/brain.rs)
- **Add a provider runtime** - [`agent-adapters/`](agent/crates/agent-adapters/src)
- **Change what comes back tomorrow** - [`agent-domain/src/review_schedule.rs`](agent/crates/agent-domain/src/review_schedule.rs)
- **Restyle the product** - [`packages/tokens/src/index.ts`](packages/tokens/src/index.ts)
- **Deploy it** - [docs/deployment-runbook.md](docs/deployment-runbook.md)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and the rules
that keep the default path free of keys, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community
expectations. Before opening a pull request:

```sh
bun run validate
node scripts/public-contract.mjs --check
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
