# Viva Mobile — The Atmosphere Layer

**Date:** 2026-08-25
**Status:** Ground and aliveness locked by owner. Component system pending (separate design).
**Scope:** `apps/mobile` — a cross-cutting living surface beneath every screen.
**Prototype of record:** `.superpowers/brainstorm/50528-1787697798/content/aliveness.html` (WebGL; ports to SKSL)

## 1. Goal

`apps/mobile` v1 draws everything above the ground well — the orb is a genuinely beautiful object, the
Cormorant/Hanken hierarchy is right, the gold hairlines and sparks are lovely. But the ground is
`colors.canvas` (`#F7F0E7`), a flat fill. Nothing rests on anything and nothing casts. The app is a
beautiful drawing on dead paper.

The reference is `luca.food`'s hero, which the owner described as feeling "like a real marble
countertop in soft European daylight… beauty you can't describe." This spec names that mechanism
precisely and translates it — not ports it — into Viva's own material and Viva's own relationship
to light.

## 2. What the reference is actually doing (analysis)

`luca/apps/web/public/luca-marble-hero.png` is not a marble texture. It is **a photograph of
leaf-shadow falling across marble.** Three things stack, and all three are load-bearing:

1. **The surface is photographed, not drawn.** Marble veining is irregular at every scale. Human
   vision has a fast, old classifier for "real material," and multi-scale irregularity is what trips
   it. A gradient stack never does.
2. **The light originates off-screen.** Dapple implies a window, a tree, an hour, weather. The design
   is asserting an entire room it never shows. That inference is the "European daylight."
3. **It moves slower than you can watch.** Luca counter-drifts a soft-light field and a multiply field
   at 38 s / 40 s / 52 s — non-harmonic, so the composite never lands back in phase. You cannot
   perceive it while looking; you only register on return that it is different.

Every one of these signals is preverbal, which is why the beauty resists description: it addresses
the faculty that reads rooms, not the faculty that reads interfaces.

**Realness and aliveness are distinct properties.** The three mechanisms above buy realness. They do
not buy aliveness, and the naive fix — speeding the drift until it is visible — destroys realness
without buying aliveness. Light you can watch move stops being light. Section 5 addresses aliveness
separately.

## 3. Verified platform constraints (file-checked 2026-08-25)

- **`react-native-svg` cannot do procedural noise on native.** `FeTurbulence` and `FeDisplacementMap`
  render `null` and call `warnUnimplementedFilter()`
  (`node_modules/react-native-svg/src/elements/filters/FeTurbulence.tsx`). The native filter set is
  FeBlend / FeColorMatrix / FeComposite / FeFlood / FeGaussianBlur / FeMerge / FeOffset / FeDropShadow
  only. Luca's animated `feTurbulence` caustic does not port.
- **`FeBlend` supports only** `normal | multiply | screen | darken | lighten`. No `soft-light`.
- **RN 0.86 core does provide** `mixBlendMode` (all 16 CSS modes), `filter` (blur, brightness, …),
  `boxShadow`, `isolation`, and `experimental_backgroundImage` with multi-stop `linear-gradient` and
  `radial-gradient` (`Libraries/StyleSheet/StyleSheetTypes.d.ts:324-530`). New Architecture only.
- **`@shopify/react-native-skia@2.11.1` peers are all satisfied:** react ≥19 (have 19.2.3),
  react-native ≥0.78 (have 0.86.2), reanimated ≥4 (have 4.5.1), worklets ≥0.7 (have 0.10.1).
- **Known trap:** `expo-linear-gradient` ignores `borderRadius` on the New Architecture — this is why
  the orb is SVG. Do not reintroduce it. `experimental_backgroundImage` is a different code path and
  untested here.

## 4. The ground — LOCKED

Viva's material is not marble. The mobile design brief already names it: *"the pocket folio — a living
academic manuscript rendered on warm vellum."* Luca is a kitchen counter at noon; Viva is **a leaf of
vellum on a study desk, window to the left, late afternoon.**

### 4.1 Owner-selected parameters

Dialled by the owner against the live prototype. These are the spec.

| Uniform | Value | Meaning |
| --- | --- | --- |
| `material` | **1.65** | Follicle mottle, tooth, directional fiber, gold flecks |
| `drama` | **0.40** | 0 = near-flat high key, 1 = hard contrast. Luca's photo measures ≈0.30 |
| `warmth` | **0.82** | Sun toward gold, shadow toward warm grey |
| `leafScale` | **1.90** | Size of the light masses |
| `grain` | **0.024** | Static tooth amplitude |

**Interpretation, and a correction to an earlier analysis.** I diagnosed the first vellum draft as too
"smoky" and predicted the owner would want *smaller, crisper* leaf shapes, closer to Luca's photo. The
owner moved leaf scale the other way, from 1.0 to 1.9, while raising warmth to 0.82 and drama to 0.40.
The target is therefore **not** leaf-shadow. It is **large soft masses of gold light** — late afternoon
through a wide window rather than through a tree. This is more generous and less fussy than the
reference, and it has a practical consequence: large soft masses can travel much further than small
leaf shapes before the motion reads as visually noisy. Section 5's amplitudes depend on this.

### 4.2 The light model, and why soft-light was wrong

The first implementation copied Luca's CSS approach — soft-light and multiply blending over a
near-white base — and it barely registered. **Soft-light has almost no headroom on a 0.96 base.** Luca
gets away with it because its base is a photograph containing real dark values.

The light is therefore **albedo modulation with a tint pair**, which is how light on a surface
physically works:

```glsl
vec3 col = base * mix(shadowTint, lightTint, lightAmount);
col += pow(lightAmount, bloomK) * bloomTint;      // specular pop on the brightest masses
```

with the material's albedo deliberately held near **0.936, 0.914, 0.884** — below white — so the light
has room to swing roughly 0.80 → 0.99. Shadow tint is **warm** grey, never blue; this was the second
error in the first draft and it is the difference between "afternoon" and "overcast."

### 4.3 Layer order

material (static) → raking light → counter-drifting multiply shadow → specular bloom →
readability well → vignette → static grain.

The **readability well** is a broad ~13% lift toward `#FFFDFA` centred at `(0.50, 0.44·aspect)`, so
copy always sits in a rise of light rather than fighting the surface.

## 5. Aliveness — LOCKED

All four mechanisms below were demoed independently and accepted by the owner. They compose with the
already-committed session-reactive light, clock-bound sun, and palimpsest (§6).

**Governing principle: aliveness is a property of the relationship, not of the motion.** A thing feels
alive when it responds to you and persists without you. Motion alone is a screensaver.

### 5.1 Tilt

The gravity vector from `expo-sensors` drives **the light**, not the layer. The sun's angle and
position shift ≈**7°** across the full tilt range, low-passed at **τ ≈ 350 ms** (`λ = 2.85`).

Small range and heavy damping are the whole design. A one-to-one mapping reads as a toy; this reads as
a property of the material. This is the single largest contributor to perceived aliveness and it
operates during the ~90% of the time nothing else is happening.

### 5.2 Breath

The envelope drives the drift's **rate**, not its brightness — a ~3 s brightness pulse across a full
screen would be nauseating. The light **creeps and rests** on an **11 s** cycle:

- 30% inhale (ease-out cubic), 12% hold, 58% exhale (ease-in quadratic)
- **±5% period jitter per cycle**, so it is never metronomic
- rate maps to `0.55 + 0.90 · env`

Asymmetry is the point, and it matches what `src/components/voice-orb.tsx` already does per state
(`ready: {inhale: 2600, exhale: 2300}`). The orb reads as alive today and the background does not for
exactly this reason.

### 5.3 Aperiodic drift

An Ornstein–Uhlenbeck walk on the drift (`ẋ = −0.30x + noise`, scaled `0.06`), plus a **per-install
seed**, so the light never mathematically repeats and no two installs get the same sheet of vellum.
Insurance rather than a feature; nobody will notice it and that is correct.

### 5.4 Touch

Press lifts the light **4%** over **180 ms**, settling back over **700 ms** (asymmetric damping:
`λ_attack = 9.0`, `λ_release = 2.6`).

**Standing reservation, accepted with the mechanism:** the orb is already the responsive object, and
two responders can compete. Recommended scope is **vellum only** — presses on the orb and on the
primary CTA should not also lift the ground.

### 5.5 Base drift

Two counter-rotating fields at **38 s** and **47 s** (non-harmonic), amplitudes `(0.075, 0.055)` and
`(0.060, 0.085)`, with the walk and tilt summed in before reaching the shader.

## 6. Committed from the tier selection, not yet demoed

The owner selected the full tier ("all the way — the room remembers"). These remain to be designed in
detail:

- **Clock-bound sun.** The shader clock is seeded from wall-clock time, not app launch. Two
  consequences; the second matters more. The obvious one is that the light matches the user's window.
  The subtle one is that **the app is never in frame 0** — you never start it, you walk in on it.
- **Session-reactive light.** *Ready:* daylight leads, orb absorbs. *Listening:* the room hushes —
  daylight dims a few percent and a lavender bloom pushes out of the orb. *Thinking:* near-stillness.
  *Correction:* one slow gold rake, left to right, once, then settle. *Complete:* daylight returns and
  warms.
  **Rule: the room gets quieter under examination, not livelier.** Aliveness that withdraws under
  pressure reads as attention; aliveness that ramps up reads as a slot machine. Viva is a focus app.
- **Palimpsest.** An erased hand pressed into the vellum, legible only where the light rakes. It is
  the only mechanism that changes *content* rather than appearance. Tied to FSRS state — due concepts
  surface, mastered concepts sink — the page becomes a picture of the user's memory, different
  tomorrow. This is the idea that could not be copied from Luca, because Luca has no memory to draw.

## 7. Architecture

**JS owns the light's state; the shader only renders it.**

```
Reanimated shared values / worklet
  ├── drift phase (breath-warped)
  ├── OU walk
  ├── tilt (damped gravity vector)
  ├── touch lift
  ├── clock → sun position + palette
  └── session state → dim / bloom / rake
        ↓ eight uniforms
  Skia RuntimeEffect (SKSL) — one Canvas at the root, behind the Stack
```

Consequences: all behaviour lives in testable JS rather than GLSL; the shader stays a pure function of
its uniforms; and state changes cost a uniform write rather than a React re-render.

**Frame budget.** 10–12 fps in `ready`, 30 fps during events. Slow light does not need frames, and a
live session is already streaming PCM over a WebSocket. One draw call either way.

## 8. Chrome — the glass question

In Luca every pill and card is glass (`backdrop-filter: blur(18px) saturate(1.15)` plus a 1px inset
white highlight), so the chrome samples the surface beneath and catches the same sun. In `apps/mobile`
today the cards are flat translucent white sitting on top.

Demoed with a live ON/OFF toggle. The owner's stated direction is "maybe we lean into that glass
aesthetic," alongside a request to see many alternatives first — so **glass is a leading candidate,
not a locked decision.** The underlying claim is what matters and it is separable from the treatment:
**the chrome must acknowledge the light somehow.** The light can be perfect, but if nothing in the UI
responds to it the surface reads as wallpaper behind the app rather than something the app rests on.
Glass is one answer; letterpress, tinted paper, cut-paper shadow, and inked stamp are others.

**Resolved 2026-08-25 — glass was not chosen.** See
`docs/superpowers/specs/2026-08-25-mobile-component-system-design.md`. The chrome does acknowledge the
light, but by being *cut into* the page rather than frosted over it: surfaces are signed-distance
fields in the vellum's height map, lit by the page's own sun. This also retires the `expo-blur` /
Skia-backdrop-blur question — there is no blur pass to pay for.

## 9. Craft rules

1. **Nothing ambient is watchable.** If it can be tracked while reading a sentence, it is too fast.
   Event punctuation is the sole exception — that is meant to be seen, once.
2. **One rate class per layer.** Layered slow motion becomes soup.
3. **Every state reachable from every other without a jump.** Sessions get interrupted; light never snaps.
4. **Reduce-motion means one beautiful static frame chosen for the hour** — never "no background."
5. **Grain never animates.** It is material, not effect. Size it in physical pixels (~1.25 CSS px
   cells), not device pixels — the first draft keyed it to `gl_FragCoord` with a per-frame reseed and
   read as TV static.
6. **Frame budget is a design constraint,** not an optimisation afterthought.

## 10. Staging

- **Act 1 — the surface.** Vellum, vignette, grain, readability well, on every screen. Largest visible
  change for the least risk.
- **Act 2 — the light.** Skia, drift, breath, walk, tilt, touch, clock-bound sun.
- **Act 3 — participation.** Session-reactive light, then palimpsest.

Each act ships independently and looks better than the last.

## 11. Open questions

- **O-1 — Material at scale.** `material 1.65` was dialled at ~328 px preview width. On a 402 pt phone
  at true size, texture behind the Cormorant headline may fight the type. Mitigation is to let the
  readability well eat more material directly under copy; needs a device check before it is settled.
- **O-2 — Which screens.** Recommend all four (home, session, recap, library) with per-screen
  intensity, so the app is one place. Not yet confirmed.
- **O-3 — Web parity.** `expo start --web` is load-bearing for this team's test loop (the iOS 26
  simulator's audio stack freezes the JS thread). Skia's web build is CanvasKit/WASM and heavy;
  need a decision on whether the atmosphere degrades to a static frame on web.
- **O-4 — Battery.** Unmeasured on a real device during a live voice session. §7's frame budget is a
  design intent, not a measurement.
- **O-5 — Palimpsest source text.** Whether the ghost hand is authored artwork or rendered from the
  user's actual study set. The FSRS coupling in §6 implies at least partly the latter.

## 12. Provenance

Ground and aliveness parameters were dialled by the owner against a live WebGL prototype rather than
chosen from description. The prototype's JS state machine is the intended shape of the RN
implementation, not a throwaway mock.
