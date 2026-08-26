# Viva Mobile — The Atmosphere Layer

**Date:** 2026-08-25
**Status:** Ground and aliveness locked by owner. Build-readiness pass completed 2026-08-25 (§11–§18).
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

## 11. Contrast under a moving light

A drifting light means **the background luminance under text is a range, not a value.** Every contrast
check must therefore be run at the light's *darkest* excursion, never against a screenshot.

Composited vellum under content, derived from §4's locked parameters:

| | sRGB |
| --- | --- |
| brightest (light tint + readability well) | `#FFF5DD` |
| darkest (shadow tint × multiply field × occlusion inside a well) | `#C2B7AC` |

Measured against the shipped palette (`apps/mobile/src/theme/tokens.ts`, `packages/tokens`):

| token | @brightest | @darkest | AA 4.5:1 | AA-large 3:1 |
| --- | --- | --- | --- | --- |
| `inkStrong` #271A30 | 15.16 | 8.35 | **pass** | pass |
| `inkMuted` #766B7E | 4.64 | 2.55 | **fail** | fail |
| `plumVivid` #6E429B | 6.64 | 3.66 | fail | pass |
| `sageDeep` #667C61 | 4.19 | 2.31 | fail | fail |
| `ochre` #B77831 | 3.37 | 1.86 | fail | fail |
| `gold` #BD9A55 | 2.44 | 1.35 | fail | fail |
| `copper` #B06A3B | 3.89 | 2.15 | fail | fail |
| `prussian` #3C5A78 | 6.62 | 3.64 | fail | pass |

**Only `inkStrong` is safe.** `inkMuted` — which `VivaText tone="muted"` uses for every caption and
every piece of museum-label metadata — fails at *both* ends of the range, so this is not a
consequence of the drift; it was already failing on the flat `#F7F0E7` ground.

### 11.1 Resolution

**Move 1 — text tokens darken.** Scaled toward black until they clear 4.5:1 at the darkest excursion:

| role | ornament value (unchanged) | text-safe value |
| --- | --- | --- |
| muted ink | — | `inkMuted` → **#4E4753** |
| sage | `#667C61` | `sageInk` **#3F4D3C** |
| ochre | `#B77831` | `ochreInk` **#65421B** |
| gold | `#BD9A55` | `goldInk` **#574727** |
| copper | `#B06A3B` | `copperInk` **#6A4023** |
| prussian | `#3C5A78` | `prussianInk` **#324C65** |
| plum | `#6E429B` | `plumInk` **#5C3782** |

**Move 2 — accents may not carry body-size text.** Ornament values stay exactly as they are for
hairlines, keylines, sparks, gauge fills and rules; purely decorative marks are outside WCAG 1.4.11,
and meaningful UI graphics need 3:1, which the ornament values meet at the brightest but not the
darkest — so any accent mark that *conveys state* (the gauge fill, the selected keyline) uses the
`*Ink` value too.

### 11.2 This invalidates part of a locked decision

The grouping lock (component spec §5) specifies `folio acc` with `accent copper`, and folios render at
caption size — **2.15:1 at the darkest, the worst value in the table.** The design is kept; the token
is not. Copper folios must use `copperInk #6A4023`. Same for the `ghead` group label.

### 11.3 Guard, not a clamp

Do **not** clamp the shader's output to protect contrast — that would flatten the light to defend a
palette. Instead the contrast table is a **unit test**: recompute the composite from the uniform
constants and assert every text token against the darkest excursion. Any future change to `drama`,
`warmth`, `ao` or a token then fails CI rather than silently shipping unreadable metadata.

## 12. Accessibility beyond contrast

- **The canvas is decorative.** `accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"`.
- **Depth is invisible to assistive tech.** This is the cost of §4's state language: a screen reader
  gets nothing from a well. Every depth-encoded state must *also* be declared —
  `accessibilityState={{ selected, disabled, expanded, busy }}` — and this is a hard review gate, not a
  nicety, because depth is the *only* other carrier.
- **Depth-not-colour is a genuine win.** The segmented control's selection, the switch, and the
  correction's proud repair survive every form of colour vision deficiency, because none of them
  encode state in hue. Worth protecting: never "fix" a depth state by adding colour.
- **Dynamic Type forces re-measurement.** Surfaces are measured rects; a font-scale change resizes
  them. Subscribe to `PixelRatio.getFontScale()` changes and re-measure (see component spec §10).
- **Reduce Motion** — already handled for the orb (`voice-orb.tsx`). Extend to: atmosphere → one static
  frame chosen for the hour; press-deepen → instant, no spring; skeleton shimmer → static; tilt → off.
- **Reduce Transparency** — nothing to do, because nothing is transparent. A real dividend of choosing
  impression over glass: the iOS setting that guts frosted UI has no effect here.
- **Touch targets** stay at `layout.minTouch` 48 dp. A well may be visually inset from its hit area;
  the impression is not the target.

## 13. Appearance and dark mode

`app.json` already sets `userInterfaceStyle: "light"` — the app declines OS dark mode. That is
coherent with this design rather than an oversight: **the clock-bound sun (§6) is the night
appearance.** At 23:00 the page falls to lamp-warm with plum corners and the orb becomes the brightest
thing on screen — a lower-luminance, warmer state arrived at by the room rather than by a toggle, and
better suited to a student in a dark room than an inverted palette.

Two consequences to accept explicitly rather than discover:

1. A user who forces dark mode system-wide still gets vellum. If that turns out to be wrong, the fix
   is a **night-intensity preference**, not a second palette — a second palette would double every
   token and every contrast check.
2. **§11's table is computed for the daylight range only.** The night state has its own, lower
   luminance range and its own contrast obligations. Recorded as O-11.

## 14. Performance budget

| state | target | note |
| --- | --- | --- |
| `ready` / idle | 10–12 fps | slow light does not need frames |
| tilt active | 30 fps | falls back to 12 after 1.5 s of stillness |
| session events | 30 fps | correction rake, listening bloom |
| reduce-motion | 0 fps | one committed frame |

One draw call in every state. Acceptance criteria before Act 2 ships:

- **Frame time ≤ 4 ms** on the oldest supported device at 30 fps with a live session streaming PCM.
- **No added dropped frames** on the session screen versus the pre-atmosphere baseline, measured with
  the same harness.
- **Battery delta ≤ 5%** over a 15-minute session versus baseline.

**Fallback tier.** If Skia fails to initialise, or the device fails the frame-time gate, render a
pre-baked vellum image plus the vignette and grain — Act 1 without Act 2. This must be a runtime
decision, not a build flag, and it is also the web path (§16).

## 15. Testing strategy

The architecture was chosen partly for this: **JS owns the light's state and the shader is a pure
function of its uniforms**, so most of it is testable without rendering.

- **Unit (pure, fast):** the breath envelope's shape and asymmetry; the OU walk staying bounded; tilt
  damping reaching target within τ; touch attack/release asymmetry; clock → sun position; session
  state → uniform mapping; the §11.3 contrast table.
- **Golden frames:** render the shader at fixed uniform values and hash the output. Catches the two
  bugs this design already produced once each — a length that was viewport-relative, and grain that
  re-seeded per frame.
- **On-device harness:** frame time and battery against §14, scripted through the existing
  `apps/mobile/scripts/e2e-live-loop.mjs` pattern.
- Existing gates unchanged: `bun run --cwd apps/mobile typecheck | lint | test | build`.

## 16. Web parity — resolves O-3

`expo start --web` is load-bearing for this team's loop, because the iOS 26 simulator's audio stack
freezes the JS thread. Skia's web build is CanvasKit (WASM, multi-megabyte) and the dev loop needs the
*layout*, not the atmosphere.

**Decision: web gets the fallback tier (§14).** A pre-baked vellum frame plus vignette and grain, no
shader, no tilt. Same code path as the low-end device fallback, so it is exercised constantly rather
than rotting.

## 17. The orb and the atmosphere

§6's session-reactive light requires the orb to bloom into the vellum, which appears to demand that
both live in one canvas. It does not. **They share state, not a canvas:** the orb stays
`react-native-svg` (proven; the 2026-08-24 design pass explicitly forbids regressing it — `expo-linear-gradient` ignores `borderRadius` on the New Architecture), and the
*atmosphere shader* draws the bloom at the orb's measured centre, driven by the same Reanimated shared
values that drive the orb's own breathing.

Recorded as O-12: whether the orb eventually moves into Skia for a single lighting model is a real
question, but it is not on the critical path and the SVG orb is the app's most finished object.

## 18. Splash continuity

`expo-splash-screen` is already configured with `backgroundColor: "#F7F0E7"`, which is the vellum's
base value — so the handoff can be seamless. **Requirement:** hold the splash until the first
atmosphere frame is committed, not merely until fonts load (`_layout.tsx` currently hides on
`fontsLoaded`). Otherwise the app flashes flat canvas before the light arrives, which is precisely the
"dead paper" impression this work exists to remove.

## 19. Open questions

- **O-1 — Material at scale.** `material 1.65` was dialled at ~328 px preview width. On a 402 pt phone
  at true size, texture behind the Cormorant headline may fight the type. Mitigation is to let the
  readability well eat more material directly under copy; needs a device check before it is settled.
- **O-2 — Which screens.** Recommend all four (home, session, recap, library) with per-screen
  intensity, so the app is one place. Not yet confirmed.
- ~~**O-3 — Web parity.**~~ **Resolved in §16:** web gets the fallback tier.
- **O-4 — Battery.** Unmeasured on a real device during a live voice session. §7's frame budget is a
  design intent, not a measurement.
- **O-5 — Palimpsest source text.** Whether the ghost hand is authored artwork or rendered from the
  user's actual study set. The FSRS coupling in §6 implies at least partly the latter.
- **O-11 — Night-state contrast.** §11's table covers the daylight range only. The clock-bound night
  state has its own luminance range and must be measured before it ships.
- **O-12 — Orb rendering.** SVG orb with shader-drawn bloom (§17) is the decision for now; whether the
  orb eventually moves into Skia for one lighting model is deferred.

## 20. Provenance

Ground and aliveness parameters were dialled by the owner against a live WebGL prototype rather than
chosen from description. The prototype's JS state machine is the intended shape of the RN
implementation, not a throwaway mock.
