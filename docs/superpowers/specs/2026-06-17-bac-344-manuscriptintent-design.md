# BAC-344 ManuscriptIntent Design

Linear: BAC-344
Status: approved execution brief from Linear issue
Date: 2026-06-17

## Goal

Define Act 2's bounded `ManuscriptIntent` render-grammar so the Conductor can emit expressive meaning while the Listening Manuscript still owns every pixel. The grammar extends the existing event-sourcing protocol; it is not a markup or render-instruction escape hatch.

## Constraints

- Agent emits meaning only: register, emphasis, and anchored entity ids.
- Client projection and Canvas 2D renderer own all pixels, colours, coordinates, animation, and layout.
- No new core runtime rendering dependency: no three.js, Pixi, Rive, or equivalent.
- Amplitude and reduced-motion handling remain client-only renderer concerns.
- Unknown ids, oversized ids, out-of-enum values, raw markup, colours, coordinates, or render instructions are rejected or dropped without crashing.

## Approaches Considered

### Recommended: protocol event plus pure scene reducer

Add a `manuscript_intent` server event with a small discriminated union in `@viva/core` and matching Rust protocol/domain types. The web reducer stores validated intents, then `vivaSceneReducer` folds them into deterministic scene state with a known-entity context. `LiveSessionPage` threads scene state into `VoiceTraceCanvas` and `MarginaliaPanel`; those render it using existing Canvas/CSS primitives.

This satisfies BAC-344 because the agent emits bounded intent, the client validates and reduces it, and rendering authority remains in the manuscript.

### Rejected: derive all scene state only from v1 events

The client could infer mood from `session_phase`, `concept_status`, and `source_reference`. That would be safe, but it would not satisfy the ticket's central requirement that Act 2 gives the agent a bounded intent grammar.

### Rejected: broad visual command schema

A schema with coordinates, colours, CSS classes, drawing commands, or text markup would be easier to make visually dramatic, but it violates the hard law. It would make the agent a renderer.

## Grammar

`ManuscriptIntent` is a discriminated union:

- `scene_intent`: sets the whole-page register and emphasis.
- `entity_intent`: introduces or updates a known entity by stable id and kind.
- `marginalia_intent`: anchors a margin note state to a known entity id.

Bounded enums:

- register: `examining`, `reflecting`, `correcting`, `sourcing`, `recapping`
- emphasis: `quiet`, `measured`, `marked`
- entity kind: `concept`, `source`, `marginal_note`

The protocol event shape is:

```ts
{
  type: "manuscript_intent",
  response_id: string,
  intent: ManuscriptIntent
}
```

The runtime parser rejects unknown keys on intent payloads, banned render keys, oversized ids, invalid enums, empty anchors, and markup-like ids. TypeScript types prevent normal in-repo callers from constructing colours, coordinates, markup, or draw instructions.

## Reducer

`apps/web/lib/viva-scene-reducer.ts` owns pure scene reduction:

- `vivaSceneReducer(intents, context)` returns a deterministic `VivaSceneState`.
- Context supplies known entity ids from the current study set, source references, and stable marginalia anchors.
- Unknown entity anchors are dropped, not invented.
- Entity emphasis and scene emphasis use numeric renderer weights derived client-side from bounded enum values.
- Same input stream plus same context always yields the same scene state.

## Rendering

`LiveSessionPage` computes scene context from the trusted study set and agent-derived sources, then reduces `agent.derived.manuscriptIntents`. `LiveSessionShell` passes the result into:

- `VoiceTraceCanvas`, where scene state can choose focal concept/source/marginal anchors and client-owned ink weight.
- `MarginaliaPanel`, where data attributes let CSS tune marginalia emphasis without adding explanatory text.

The renderer continues to honour `prefers-reduced-motion` internally; the grammar contains no motion preference or animation instructions.

## Testing

Required coverage:

- `@viva/core` parses valid `manuscript_intent` frames.
- `@viva/core` rejects invalid registers/emphasis, render keys, colours, coordinates, markup, and oversized ids.
- `vivaAgentReducer` stores valid intent events and suppresses stale/cancelled intent events.
- `vivaSceneReducer` is deterministic, drops unknown anchors, clamps/rejects invalid input, and produces renderer-owned emphasis weights.
- React component tests prove scene state is passed into the existing Canvas 2D manuscript and marginalia without a new render dependency.
- Rust domain/protocol tests prove the agent can emit the same validated grammar and the browser frame serializes to the shared contract.

## Self-Review

- Placeholder scan: no TBD/TODO placeholders.
- Scope check: one protocol event, one pure reducer, and renderer wiring; no provider, dashboard, LMS, payment, or visual rewrite scope.
- Ambiguity check: "known entity ids" is enforced by the scene reducer context because the raw protocol parser cannot know a session's live entity registry.
