# BAC-344 ManuscriptIntent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the bounded, validated `ManuscriptIntent` grammar from Rust/TypeScript protocol through pure web scene reduction and Canvas/marginalia rendering.

**Architecture:** Add one `manuscript_intent` server event to the existing voice protocol. Store validated intents in the web agent reducer, fold them with a pure `vivaSceneReducer`, and render the resulting scene state through existing Canvas 2D and marginalia components. The agent emits semantic intent only; all visual choices remain in the client.

**Tech Stack:** Bun, TypeScript, React/Next.js, Rust, serde, existing Turbo validation.

---

### Task 1: TypeScript Protocol Grammar

**Files:**
- Modify: `packages/core/src/agent-contract.ts`
- Modify: `packages/core/src/agent-contract.test.ts`
- Create: `agent/fixtures/voice-protocol/server-event-manuscript-intent.json`

- [ ] **Step 1: Write the failing parser tests**

Add tests that import the new fixture and assert:

```ts
const frame = parseVivaServerFrame(manuscriptIntentFixture);
if (frame.type !== "event") throw new Error("Expected event frame");
expect(frame.event.type).toBe("manuscript_intent");
if (frame.event.type !== "manuscript_intent") throw new Error("Expected intent event");
expect(frame.event.intent.type).toBe("scene_intent");
expect(frame.event.intent.register).toBe("examining");
expect(frame.event.intent.emphasis).toBe("measured");
```

Add rejection tests:

```ts
for (const key of ["color", "coordinates", "x", "y", "css", "markup", "html", "draw"]) {
  expect(() =>
    parseVivaServerFrame({
      type: "event",
      version: 1,
      event: {
        type: "manuscript_intent",
        response_id: "response-1",
        intent: { type: "scene_intent", register: "examining", emphasis: "quiet", [key]: "bad" },
      },
    }),
  ).toThrow("Invalid manuscript intent");
}
```

Also reject an invalid register, invalid emphasis, empty anchor id, markup-like id (`"<b>nadh</b>"`), and an id longer than the configured limit.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test packages/core/src/agent-contract.test.ts
```

Expected: FAIL because `server-event-manuscript-intent.json` and `manuscript_intent` parsing do not exist.

- [ ] **Step 3: Implement minimal TypeScript grammar and parser**

Add exported types:

```ts
export type ManuscriptRegister = "examining" | "reflecting" | "correcting" | "sourcing" | "recapping";
export type ManuscriptEmphasis = "quiet" | "measured" | "marked";
export type ManuscriptEntityKind = "concept" | "source" | "marginal_note";
export type ManuscriptIntent =
  | { type: "scene_intent"; register: ManuscriptRegister; emphasis: ManuscriptEmphasis }
  | { type: "entity_intent"; entity_id: string; entity_kind: ManuscriptEntityKind; register: ManuscriptRegister; emphasis: ManuscriptEmphasis }
  | { type: "marginalia_intent"; marginalia_id: string; anchor_entity_id: string; register: ManuscriptRegister; emphasis: ManuscriptEmphasis };
```

Extend `VivaServerEvent`:

```ts
| { type: "manuscript_intent"; response_id: string; intent: ManuscriptIntent }
```

Implement strict parsing helpers that allow only the known keys for each intent and reject banned render-instruction keys.

- [ ] **Step 4: Add the shared fixture**

Create `agent/fixtures/voice-protocol/server-event-manuscript-intent.json`:

```json
{
  "type": "event",
  "version": 1,
  "event": {
    "type": "manuscript_intent",
    "response_id": "response-1",
    "intent": {
      "type": "scene_intent",
      "register": "examining",
      "emphasis": "measured"
    }
  }
}
```

- [ ] **Step 5: Run focused test and verify GREEN**

Run:

```bash
bun test packages/core/src/agent-contract.test.ts
```

Expected: PASS.

### Task 2: Web Reducer And Client State

**Files:**
- Create: `apps/web/lib/viva-scene-reducer.ts`
- Create: `apps/web/lib/viva-scene-reducer.test.ts`
- Modify: `apps/web/lib/viva-agent-client.ts`
- Modify: `apps/web/lib/viva-agent-client.test.ts`
- Modify: `apps/web/lib/use-viva-agent-session.ts`

- [ ] **Step 1: Write failing reducer tests**

Cover deterministic reduction, scene register/emphasis mapping, known-entity filtering, dropped unknown marginalia anchors, and malicious extra keys passed through `unknown` input.

```ts
expect(vivaSceneReducer(intentStream, context)).toEqual(vivaSceneReducer(intentStream, context));
expect(scene.emphasisWeight).toBe(0.55);
expect(scene.entities.map((entity) => entity.id)).toEqual(["nadh"]);
```

- [ ] **Step 2: Write failing client-state tests**

Add `manuscript_intent` frames to `viva-agent-client.test.ts` and assert `vivaAgentReducer` appends valid intents, suppresses stale response ids, and suppresses cancelled response ids.

- [ ] **Step 3: Verify RED**

Run:

```bash
bun test apps/web/lib/viva-scene-reducer.test.ts apps/web/lib/viva-agent-client.test.ts
```

Expected: FAIL because the reducer and state field do not exist.

- [ ] **Step 4: Implement reducer and client state**

Add `manuscriptIntents: Array<{ responseId: string; intent: ManuscriptIntent }>` to `VivaAgentSessionState`, initialize it to `[]`, append on `manuscript_intent`, and expose it on `VivaAgentDerivedState`.

Implement `vivaSceneReducer` with no mutation and no browser globals.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun test apps/web/lib/viva-scene-reducer.test.ts apps/web/lib/viva-agent-client.test.ts apps/web/lib/use-viva-agent-session.test.ts
```

Expected: PASS.

### Task 3: Canvas And Marginalia Wiring

**Files:**
- Modify: `apps/web/components/session/LiveSessionPage.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.tsx`
- Modify: `apps/web/components/session/VoiceTraceCanvas.tsx`
- Modify: `apps/web/components/session/MarginaliaPanel.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/components/viva/VivaApp.test.tsx` or add the nearest focused component test if the current test surface is insufficient

- [ ] **Step 1: Write failing component/wiring tests**

Assert the shell passes a scene state into the Canvas and marginalia by rendering stable `data-scene-register` and `data-scene-emphasis` attributes. Assert reduced motion remains owned by `VoiceTraceCanvas`, not the grammar.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test apps/web/components/**/*.test.tsx apps/web/lib/*.test.ts
```

Expected: FAIL because scene props and data attributes do not exist.

- [ ] **Step 3: Implement wiring**

In `LiveSessionPage`, reduce `agent.derived.manuscriptIntents` with a scene context containing current concept ids, source ids, and stable marginal anchors. Pass `scene` to `LiveSessionShell`.

In `VoiceTraceCanvas`, use `scene` only to choose renderer-owned emphasis/focal weights; do not accept colour, coordinates, markup, or animation instructions.

In `MarginaliaPanel`, add data attributes for `scene.register` and `scene.emphasis`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
bun test apps/web/components/**/*.test.tsx apps/web/lib/*.test.ts
```

Expected: PASS.

### Task 4: Rust Domain And Protocol Emission

**Files:**
- Modify: `agent/crates/agent-domain/src/brain.rs`
- Modify: `agent/crates/agent-service/src/protocol.rs`
- Modify: `agent/crates/agent-adapters/src/synthetic.rs`
- Modify: `agent/fixtures/voice-protocol/synthetic-study-session.json`
- Modify: `agent/fixtures/voice-protocol/fake-cartesia-gemini-study-session.json` only if fake provider emits intents too

- [ ] **Step 1: Write failing Rust protocol tests**

Add a test that serializes `BrainEvent::ManuscriptIntent` to the shared fixture and assert synthetic runtime output includes bounded `manuscript_intent` events.

- [ ] **Step 2: Verify RED**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol -- --nocapture
```

Expected: FAIL because the Rust event/type does not exist.

- [ ] **Step 3: Implement Rust types and mapping**

Add serde enums/structs mirroring the TypeScript grammar, add `BrainEvent::ManuscriptIntent { response_id, intent }`, map it into `VivaServerEvent::ManuscriptIntent`, and allow it through `ServerFrame::browser_event`.

- [ ] **Step 4: Emit synthetic intents**

Emit a `scene_intent` after `QuestionStarted`, an `entity_intent` after `ConceptStatus`, and a `marginalia_intent` after `SourceReference`. Keep payloads to stable ids and bounded enum values only.

- [ ] **Step 5: Update fixtures intentionally**

Regenerate or edit the exact protocol fixtures so the exact-match tests reflect the new events.

- [ ] **Step 6: Run focused Rust tests and verify GREEN**

Run:

```bash
cargo test --manifest-path agent/Cargo.toml -p agent-service protocol -- --nocapture
```

Expected: PASS.

### Task 5: Full Verification And PR

**Files:**
- No additional files expected.

- [ ] **Step 1: Run TypeScript validation**

Run:

```bash
bun run validate:ts
```

Expected: typecheck, biome, tests, and Next build all pass.

- [ ] **Step 2: Run agent validation**

Run:

```bash
bun run validate:agent
```

Expected: Rust fmt, clippy, tests, build, and purity all pass.

- [ ] **Step 3: Run release hygiene**

Run:

```bash
bun run release:hygiene
```

Expected: PASS with no forbidden payload markers.

- [ ] **Step 4: Verify observable synthetic session**

Run the synthetic agent with `VIVA_AGENT_PROVIDER=synthetic` and no session-token secret, start the web preview, and open `/session`. Verify the manuscript renders, the Canvas is nonblank, and scene attributes change after the synthetic answer event stream.

- [ ] **Step 5: Request code review and fix findings**

Use `superpowers:requesting-code-review`, then `superpowers:receiving-code-review` for each finding. Re-run the gates after fixes.

- [ ] **Step 6: Open PR**

Push branch `connor/bac-344-act-2-define-the-bounded-validated-manuscriptintent-render` and open a PR with the Generated-with footer. Do not mark BAC-344 Done until PR review comments are resolved, gates are green, observable behavior is verified, and the PR is merged.

## Self-Review

- Spec coverage: all BAC-344 acceptance criteria map to Tasks 1-5.
- Placeholder scan: no TBD/TODO or "implement later" placeholders.
- Type consistency: `ManuscriptIntent`, `VivaSceneState`, and `manuscript_intent` names are consistent across tasks.
